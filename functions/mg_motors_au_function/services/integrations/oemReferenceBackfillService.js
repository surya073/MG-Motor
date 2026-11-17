'use strict';

/**
 * oemReferenceBackfillService.js
 * -----------------------------------------------------------------------
 * One-off, idempotent backfill of Dealer_CRM_ID and Middleware_ID onto the
 * OEM CRM lead for leads that were delivered to a dealer before those fields
 * existed (see oemReferenceFields.js).
 *
 * It only ever WRITES the two reference fields. It never pushes anything to a
 * dealer, never changes a lead status, and never touches the local sync
 * state, so a lead that is already delivered cannot be re-sent by it. Running
 * it twice just writes the same values again.
 *
 * Paged by ROWID so a run stays inside one function invocation: call it
 * repeatedly, passing back `nextAfterRowId`, until `done` is true.
 */

const oemCrmService = require('../zohoCrmService');
const logger = require('../../utils/logger');
const { oemReferenceFields } = require('./oemReferenceFields');

const LEADS_TABLE = 'leads';
const MAX_LIMIT = 50;

function quote(value) {
  return String(value).replace(/'/g, "''");
}

function toRowId(value) {
  const text = String(value ?? '0').trim();
  return /^\d+$/.test(text) ? text : '0';
}

/** The delivered leads after `afterRowId`, oldest first. */
async function listDeliveredLeads(catalystApp, { afterRowId, limit, dealerCodes }) {
  const where = [
    `ROWID > ${afterRowId}`,
    'dealer_crm_record_id IS NOT NULL',
    "dealer_crm_record_id != ''",
  ];
  if (dealerCodes.length > 0) {
    where.push(`dealer_code IN (${dealerCodes.map((code) => `'${quote(code)}'`).join(',')})`);
  }
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID, crm_record_id, dealer_code, dealer_crm_record_id FROM ${LEADS_TABLE} `
    + `WHERE ${where.join(' AND ')} ORDER BY ROWID ASC LIMIT 0, ${limit}`
  );
  return (rows || []).map((row) => row[LEADS_TABLE] || row);
}

/**
 * @param {object} catalystApp
 * @param {object} [options]
 * @param {string|number} [options.afterRowId='0']  resume after this leads ROWID
 * @param {number} [options.limit=20]               leads per call (max 50)
 * @param {string[]} [options.dealerCodes=[]]       limit to these dealers; empty = all
 * @param {boolean} [options.dryRun=false]          report what would be written, write nothing
 * @param {number} [options.deadline]               epoch ms; stop starting new writes after it
 * @returns {Promise<{scanned:number, updated:number, failed:number, dryRun:boolean,
 *   nextAfterRowId:string, done:boolean, failures:Array}>}
 */
async function backfillOemReferences(catalystApp, options = {}) {
  const afterRowId = toRowId(options.afterRowId);
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), MAX_LIMIT);
  const dealerCodes = (Array.isArray(options.dealerCodes) ? options.dealerCodes : [])
    .map((code) => String(code).trim()).filter(Boolean);
  const dryRun = Boolean(options.dryRun);
  const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;

  const leads = await listDeliveredLeads(catalystApp, { afterRowId, limit, dealerCodes });
  const result = { scanned: 0, updated: 0, failed: 0, dryRun, nextAfterRowId: afterRowId, done: false, failures: [] };

  for (const lead of leads) {
    if (Date.now() > deadline) break; // resume from nextAfterRowId on the next call
    result.scanned += 1;
    result.nextAfterRowId = String(lead.ROWID);
    const fields = oemReferenceFields({ dealerCrmId: lead.dealer_crm_record_id, middlewareId: lead.ROWID });
    if (!lead.crm_record_id || !fields.Dealer_CRM_ID || !fields.Middleware_ID) {
      result.failed += 1;
      result.failures.push({ rowId: String(lead.ROWID), error: 'MISSING_REFERENCE' });
      continue;
    }
    if (dryRun) { result.updated += 1; continue; }
    try {
      await oemCrmService.updateOemLead(lead.crm_record_id, fields);
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      result.failures.push({ rowId: String(lead.ROWID), crmRecordId: lead.crm_record_id, error: String(err.message || err).slice(0, 200) });
      logger.error('oemReferenceBackfillService', `Could not write OEM references for lead ${lead.crm_record_id}`, err);
    }
  }

  // Finished when this call saw fewer leads than asked for and none were left unprocessed.
  result.done = leads.length < limit && result.scanned === leads.length;
  return result;
}

module.exports = { backfillOemReferences, MAX_LIMIT };
