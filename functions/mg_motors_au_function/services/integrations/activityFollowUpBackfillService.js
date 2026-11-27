'use strict';

/**
 * activityFollowUpBackfillService.js
 * -----------------------------------------------------------------------
 * One-off, idempotent backfill for activity-based Follow-up 1 / 2 (Dealer Studio,
 * 27 Nov 2026; rules in dealerActivityFollowUp.js). Leads whose dealer already
 * logged activities before the rule was switched on, but which MG still holds as
 * Not Contacted (or Follow-up 1 with two or more activities), are moved on now
 * instead of waiting for the dealer's next post.
 *
 * Candidates are the Dealer Studio leads with stored activities (lead_activities,
 * deleted ones excluded). Each is re-read from the OEM CRM first: only a lead whose
 * LIVE status still qualifies is written. The write goes through the same inbound
 * path a Dealer Studio post uses (crmIntegrationService.processResolvedInboundLead),
 * so it gets the same checks (consent, routing, removed leads), the same First Action
 * Date stamping, the same mirror update and the same timeline entry with the reason.
 * Nothing is sent to the dealer.
 */

const crypto = require('crypto');
const oemCrmService = require('../zohoCrmService');
const logger = require('../../utils/logger');
const crmIntegrationService = require('./crmIntegrationService');
const dealerActivityFollowUp = require('./dealerActivityFollowUp');
const { LEAD_ACTIVITIES_TABLE } = require('./leadActivityService');
const { isDealerStudioActivityFollowUpEnabled } = require('../../config/env');

const INTEGRATIONS_TABLE = 'dealer_integrations';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const LEADS_TABLE = 'leads';
const PAGE = 300;
const MAX_PAGES = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const quote = (value) => String(value).replace(/'/g, "''");
const unwrap = (rows, table) => (rows || []).map((row) => row[table] || row);
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

async function dealerStudioIntegrations(catalystApp, onlyCodes) {
  const rows = unwrap(await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATIONS_TABLE} WHERE crm_type = 'DEALER_STUDIO'`
  ), INTEGRATIONS_TABLE);
  return onlyCodes.length > 0 ? rows.filter((row) => onlyCodes.includes(String(row.dealer_code))) : rows;
}

/** zoho_lead_id -> live activities (deleted ones left out), for one integration. */
async function activitiesByLead(catalystApp, integrationId) {
  const byLead = new Map();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = unwrap(await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, zoho_lead_id, source_event_id, event_type, user_name, event_created_at, deleted_at FROM ${LEAD_ACTIVITIES_TABLE} `
      + `WHERE integration_id = '${quote(integrationId)}' ORDER BY ROWID ASC LIMIT ${page * PAGE}, ${PAGE}`
    ), LEAD_ACTIVITIES_TABLE);
    rows.filter((row) => !row.deleted_at && row.zoho_lead_id).forEach((row) => {
      const list = byLead.get(String(row.zoho_lead_id)) || [];
      list.push({ id: row.source_event_id, event_type: row.event_type, user_name: row.user_name, created_at: row.event_created_at });
      byLead.set(String(row.zoho_lead_id), list);
    });
    if (rows.length < PAGE) break;
  }
  return byLead;
}

async function mirrorRows(catalystApp, zohoLeadIds) {
  const out = new Map();
  for (const ids of chunks(zohoLeadIds, 50)) {
    const rows = unwrap(await catalystApp.zcql().executeZCQLQuery(
      `SELECT crm_record_id, dealer_code, lead_status FROM ${LEADS_TABLE} WHERE crm_record_id IN (${ids.map((id) => `'${quote(id)}'`).join(',')})`
    ), LEADS_TABLE);
    rows.forEach((row) => out.set(String(row.crm_record_id), row));
  }
  return out;
}

async function externalLeadId(catalystApp, integration, zohoLeadId) {
  const rows = unwrap(await catalystApp.zcql().executeZCQLQuery(
    `SELECT external_crm_lead_id FROM ${LEAD_INTEGRATIONS_TABLE} WHERE integration_id = ${integration.ROWID} `
    + `AND zoho_lead_id = '${quote(zohoLeadId)}' LIMIT 1`
  ), LEAD_INTEGRATIONS_TABLE);
  return rows[0]?.external_crm_lead_id ? String(rows[0].external_crm_lead_id) : null;
}

/**
 * @param {object} catalystApp
 * @param {object} [options]
 * @param {string[]} [options.dealerCodes] limit to these Dealer Studio dealers; default all
 * @param {boolean} [options.dryRun=false] report what would change, write nothing
 * @param {number} [options.limit=50] most leads written in one call (re-run for the rest)
 * @param {object} [options.crmService] OEM CRM service (tests)
 */
async function backfillActivityFollowUps(catalystApp, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const crmService = options.crmService || oemCrmService;
  const result = { dryRun, candidates: 0, updated: [], skipped: [], failed: [], remaining: 0 };
  if (!dryRun && !isDealerStudioActivityFollowUpEnabled()) {
    const err = new Error('DEALER_STUDIO_ACTIVITY_FOLLOWUP is off: turn it on before writing');
    err.code = 'FEATURE_DISABLED';
    throw err;
  }
  const only = (Array.isArray(options.dealerCodes) ? options.dealerCodes : []).map(String).filter(Boolean);

  for (const integration of await dealerStudioIntegrations(catalystApp, only)) {
    const byLead = await activitiesByLead(catalystApp, integration.ROWID);
    if (byLead.size === 0) continue;
    const mirror = await mirrorRows(catalystApp, [...byLead.keys()]);

    // Mirror first (cheap), then the live OEM record for those that qualify.
    const planned = [];
    byLead.forEach((activities, zohoLeadId) => {
      const lead = mirror.get(zohoLeadId);
      if (!lead || String(lead.dealer_code) !== String(integration.dealer_code)) return;
      const summary = dealerActivityFollowUp.summarizeActivities(activities);
      const target = summary && dealerActivityFollowUp.followUpTarget(lead.lead_status, summary.count);
      if (target) planned.push({ zohoLeadId, summary, mirrorStatus: lead.lead_status || '' });
    });
    result.candidates += planned.length;

    let fieldMappings = null;
    let statusMappings = null;
    for (const item of planned) {
      const entry = {
        zohoLeadId: item.zohoLeadId,
        dealerCode: integration.dealer_code,
        activities: item.summary.count,
        firstActivity: item.summary.first,
      };
      if (result.updated.length + result.failed.length >= limit) { result.remaining += 1; continue; }
      try {
        const [live] = await crmService.fetchOemLeadsByIds([item.zohoLeadId]);
        const liveStatus = live?.Lead_Status ?? null;
        const target = live ? dealerActivityFollowUp.followUpTarget(liveStatus, item.summary.count) : null;
        if (!target) {
          result.skipped.push({ ...entry, from: liveStatus, reason: live ? 'LIVE_STATUS_DOES_NOT_QUALIFY' : 'NOT_IN_OEM_CRM' });
          continue;
        }
        if (String(liveStatus ?? '') !== String(item.mirrorStatus)) {
          // The inbound path decides on the mirror: a mirror that lags MG would decide wrongly.
          result.skipped.push({ ...entry, from: liveStatus, mirror: item.mirrorStatus, reason: 'MIRROR_OUT_OF_DATE' });
          continue;
        }
        if (dryRun) { result.updated.push({ ...entry, from: liveStatus || '', to: target }); continue; }

        const externalId = await externalLeadId(catalystApp, integration, item.zohoLeadId);
        if (!externalId) { result.skipped.push({ ...entry, from: liveStatus, reason: 'NO_LEAD_MAPPING' }); continue; }
        fieldMappings ??= await crmIntegrationService.getFieldMappings(catalystApp, integration.ROWID);
        statusMappings ??= await crmIntegrationService.getStatusMappings(catalystApp, integration.ROWID);
        const outcome = await crmIntegrationService.processResolvedInboundLead(
          catalystApp, integration, externalId,
          { [dealerActivityFollowUp.ACTIVITY_FOLLOW_UP]: item.summary },
          fieldMappings, statusMappings, crypto.randomUUID(), crmService
        );
        if (outcome?.skipped || outcome?.held) result.skipped.push({ ...entry, from: liveStatus, reason: outcome.reason || 'NOT_APPLIED' });
        else result.updated.push({ ...entry, from: liveStatus || '', to: target });
      } catch (err) {
        logger.error('activityFollowUpBackfillService', `Follow-up backfill failed for lead ${item.zohoLeadId}`, err);
        result.failed.push({ ...entry, error: err.code || err.message });
      }
    }
  }
  return result;
}

module.exports = { backfillActivityFollowUps };
