'use strict';

/**
 * lostOutcomeBackfillService.js
 * -----------------------------------------------------------------------
 * One-off, idempotent backfill: a Dealer Studio lead that MG holds as Lost
 * (Lead_Status "Lost" or "Lost Lead") gets Enquiry_Outcome = "Lost", the same
 * outcome a Dealer Studio or Fusion Lost now sets going forward (20 Nov 2026).
 *
 * Candidates come from the local mirror, but each one is re-read from the OEM
 * CRM before any write: only a lead that is still Lost there, and whose outcome
 * is still open (blank, "(required)", "-None-", "Outcome Pending", "No
 * Outcome", "Test Drive"), is written. An order or closed outcome (Retail
 * Order / Purchase, Fleet, On-Sold, Lost, Outcome Not Required) is never
 * replaced. It writes ONLY Enquiry_Outcome to the OEM CRM, and mirrors it to
 * leads.enquiry_outcome; it never pushes to a dealer or changes a status.
 */

const oemCrmService = require('../zohoCrmService');
const logger = require('../../utils/logger');

const LEADS_TABLE = 'leads';
const INTEGRATIONS_TABLE = 'dealer_integrations';
const LOST_OUTCOME = 'Lost';
const LOST_STATUSES = new Set(['lost', 'lost lead']);
const OPEN_OUTCOMES = new Set(['', '-none-', '(required)', 'outcome pending', 'no outcome', 'test drive']);
const MAX_LEADS = 200;

const norm = (value) => String(value ?? '').trim().toLowerCase();
const quote = (value) => String(value).replace(/'/g, "''");

async function dealerStudioDealerCodes(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT dealer_code FROM ${INTEGRATIONS_TABLE} WHERE crm_type = 'DEALER_STUDIO'`
  );
  return [...new Set((rows || []).map((row) => (row[INTEGRATIONS_TABLE] || row).dealer_code).filter(Boolean).map(String))];
}

async function lostLeads(catalystApp, dealerCodes) {
  if (dealerCodes.length === 0) return [];
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID, crm_record_id, dealer_code, lead_status, enquiry_outcome FROM ${LEADS_TABLE} `
    + `WHERE dealer_code IN (${dealerCodes.map((code) => `'${quote(code)}'`).join(',')}) `
    + `AND lead_status IN ('Lost','Lost Lead') ORDER BY ROWID ASC LIMIT 0, ${MAX_LEADS}`
  );
  return (rows || []).map((row) => row[LEADS_TABLE] || row).filter((lead) => lead.crm_record_id);
}

/**
 * @param {object} catalystApp
 * @param {object} [options]
 * @param {string[]} [options.dealerCodes]  limit to these Dealer Studio dealers; default all
 * @param {boolean} [options.dryRun=false]  report what would be written, write nothing
 * @returns {Promise<{dryRun:boolean, candidates:number, updated:Array, skipped:Array, failed:Array}>}
 */
async function backfillDealerStudioLostOutcome(catalystApp, options = {}) {
  const dryRun = Boolean(options.dryRun);
  let dealerCodes = await dealerStudioDealerCodes(catalystApp);
  const only = (Array.isArray(options.dealerCodes) ? options.dealerCodes : []).map(String).filter(Boolean);
  if (only.length > 0) dealerCodes = dealerCodes.filter((code) => only.includes(code));

  const leads = (await lostLeads(catalystApp, dealerCodes))
    .filter((lead) => OPEN_OUTCOMES.has(norm(lead.enquiry_outcome)));
  const result = { dryRun, candidates: leads.length, updated: [], skipped: [], failed: [] };
  if (leads.length === 0) return result;

  // The OEM CRM is the truth: the mirror can lag behind an MG user's edit.
  const live = new Map(
    (await oemCrmService.fetchOemLeadsByIds(leads.map((lead) => lead.crm_record_id)))
      .map((record) => [String(record.id), record])
  );

  for (const lead of leads) {
    const ref = { crmRecordId: String(lead.crm_record_id), dealerCode: String(lead.dealer_code) };
    const record = live.get(ref.crmRecordId);
    if (!record) { result.skipped.push({ ...ref, reason: 'NOT_IN_OEM_CRM' }); continue; }
    if (!LOST_STATUSES.has(norm(record.Lead_Status))) {
      result.skipped.push({ ...ref, reason: 'NOT_LOST_IN_OEM_CRM', status: record.Lead_Status ?? null });
      continue;
    }
    if (!OPEN_OUTCOMES.has(norm(record.Enquiry_Outcome))) {
      result.skipped.push({ ...ref, reason: 'OUTCOME_ALREADY_SET', outcome: record.Enquiry_Outcome });
      continue;
    }
    const entry = { ...ref, status: record.Lead_Status, from: record.Enquiry_Outcome ?? null, to: LOST_OUTCOME };
    if (dryRun) { result.updated.push(entry); continue; }
    try {
      await oemCrmService.updateOemLead(ref.crmRecordId, { Enquiry_Outcome: LOST_OUTCOME });
      result.updated.push(entry);
    } catch (err) {
      result.failed.push({ ...ref, error: String(err.message || err).slice(0, 200) });
      logger.error('lostOutcomeBackfillService', `Could not set Enquiry_Outcome = Lost on lead ${ref.crmRecordId}`, err);
      continue;
    }
    try {
      await catalystApp.datastore().table(LEADS_TABLE).updateRow({ ROWID: lead.ROWID, enquiry_outcome: LOST_OUTCOME });
    } catch (err) {
      // The OEM CRM is written; the next lead sync refreshes the mirror.
      logger.error('lostOutcomeBackfillService', `OEM lead ${ref.crmRecordId} updated but its mirror row ${lead.ROWID} was not`, err);
    }
  }
  return result;
}

module.exports = { backfillDealerStudioLostOutcome, OPEN_OUTCOMES, LOST_OUTCOME };
