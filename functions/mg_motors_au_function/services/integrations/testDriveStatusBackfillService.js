'use strict';

/**
 * testDriveStatusBackfillService.js
 * -----------------------------------------------------------------------
 * One-off, idempotent backfill: a Dealer Studio or Fusion lead whose Enquiry
 * Outcome is "Test Drive" but whose status is still waiting for the dealer
 * (Not Contacted / Update Pending / blank) becomes "Contacted", the status a
 * completed test drive now sets going forward (MG, 25 Nov 2026).
 *
 * Candidates come from the local mirror, but each one is re-read from the OEM
 * CRM before any write: only a lead that still has outcome Test Drive and a
 * waiting status there is written. A status MG has progressed (Contacted,
 * Follow-up, Lost Lead, ...) is never replaced. It writes ONLY Lead_Status to
 * the OEM CRM and mirrors it to leads.lead_status; it never pushes to a dealer
 * or changes an outcome.
 */

const oemCrmService = require('../zohoCrmService');
const pathPolicy = require('./pathPolicyService');
const logger = require('../../utils/logger');

const LEADS_TABLE = 'leads';
const INTEGRATIONS_TABLE = 'dealer_integrations';
const CRM_TYPES = ['DEALER_STUDIO', 'FUSION_SD'];
const TEST_DRIVE_OUTCOME = 'test drive';
const CONTACTED = 'Contacted';
const MAX_LEADS = 200;

const norm = (value) => String(value ?? '').trim().toLowerCase();
const quote = (value) => String(value).replace(/'/g, "''");

function isWaiting(status) {
  const value = String(status ?? '').trim();
  return value === '' || value === '-None-' || pathPolicy.isWaitingForDealerActionStatus(value);
}

async function dealerCodes(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT dealer_code FROM ${INTEGRATIONS_TABLE} WHERE crm_type IN (${CRM_TYPES.map((type) => `'${type}'`).join(',')})`
  );
  return [...new Set((rows || []).map((row) => (row[INTEGRATIONS_TABLE] || row).dealer_code).filter(Boolean).map(String))];
}

async function testDriveLeads(catalystApp, codes) {
  if (codes.length === 0) return [];
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID, crm_record_id, dealer_code, lead_status, enquiry_outcome FROM ${LEADS_TABLE} `
    + `WHERE dealer_code IN (${codes.map((code) => `'${quote(code)}'`).join(',')}) `
    + `AND enquiry_outcome = 'Test Drive' ORDER BY ROWID ASC LIMIT 0, ${MAX_LEADS}`
  );
  return (rows || []).map((row) => row[LEADS_TABLE] || row).filter((lead) => lead.crm_record_id);
}

/**
 * @param {object} catalystApp
 * @param {object} [options]
 * @param {string[]} [options.dealerCodes]  limit to these dealers; default every Dealer Studio / Fusion dealer
 * @param {boolean} [options.dryRun=false]  report what would be written, write nothing
 * @returns {Promise<{dryRun:boolean, candidates:number, updated:Array, skipped:Array, failed:Array}>}
 */
async function backfillTestDriveContacted(catalystApp, options = {}) {
  const dryRun = Boolean(options.dryRun);
  let codes = await dealerCodes(catalystApp);
  const only = (Array.isArray(options.dealerCodes) ? options.dealerCodes : []).map(String).filter(Boolean);
  if (only.length > 0) codes = codes.filter((code) => only.includes(code));

  const leads = (await testDriveLeads(catalystApp, codes))
    .filter((lead) => norm(lead.enquiry_outcome) === TEST_DRIVE_OUTCOME && isWaiting(lead.lead_status));
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
    if (norm(record.Enquiry_Outcome) !== TEST_DRIVE_OUTCOME) {
      result.skipped.push({ ...ref, reason: 'OUTCOME_NOT_TEST_DRIVE_IN_OEM_CRM', outcome: record.Enquiry_Outcome ?? null });
      continue;
    }
    if (!isWaiting(record.Lead_Status)) {
      result.skipped.push({ ...ref, reason: 'STATUS_ALREADY_PROGRESSED', status: record.Lead_Status });
      continue;
    }
    const entry = { ...ref, outcome: record.Enquiry_Outcome, from: record.Lead_Status ?? null, to: CONTACTED };
    if (dryRun) { result.updated.push(entry); continue; }
    try {
      await oemCrmService.updateOemLead(ref.crmRecordId, { Lead_Status: CONTACTED });
      result.updated.push(entry);
    } catch (err) {
      result.failed.push({ ...ref, error: String(err.message || err).slice(0, 200) });
      logger.error('testDriveStatusBackfillService', `Could not set Lead_Status = Contacted on lead ${ref.crmRecordId}`, err);
      continue;
    }
    try {
      await catalystApp.datastore().table(LEADS_TABLE).updateRow({ ROWID: lead.ROWID, lead_status: CONTACTED });
    } catch (err) {
      // The OEM CRM is written; the next lead sync refreshes the mirror.
      logger.error('testDriveStatusBackfillService', `OEM lead ${ref.crmRecordId} updated but its mirror row ${lead.ROWID} was not`, err);
    }
  }
  return result;
}

module.exports = { backfillTestDriveContacted };
