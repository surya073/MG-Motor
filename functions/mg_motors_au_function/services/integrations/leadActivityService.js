'use strict';

/**
 * leadActivityService.js
 * -----------------------------------------------------------------------
 * Stores the activities a dealer records on a lead in their own CRM (calls,
 * SMS, emails, notes) so they can be shown on the lead in the portal. V1 source:
 * Dealer Studio's webhook `lead_events` (see adapters/dealerStudioInbound.js).
 * Nothing here is written to MG's Zoho CRM.
 *
 * Table `lead_activities` (Varchar, except `description` which is Text; times are
 * ISO 8601 UTC strings as the dealer sent them):
 *   zoho_lead_id, integration_id, dealer_code, crm_type, source_event_id,
 *   event_type, description, user_name, followup_status,
 *   event_created_at, event_updated_at, snapshot_at, deleted_at
 * One row per (zoho_lead_id, source_event_id). The feature is optional: when
 * the table does not exist, recording logs and returns, and reading returns
 * `available: false`. Webhook processing never fails because of it.
 *
 * Dealer Studio sends the whole activity list on every post, so the stored rows
 * are brought in line with it: new events are inserted, changed ones updated
 * (grouped SMS change their description), and missing ones marked deleted_at.
 * Posts can arrive out of order, so a row is only changed by a post at least as
 * new as the one that last wrote it (`snapshot_at`).
 */

const logger = require('../../utils/logger');

const LEAD_ACTIVITIES_TABLE = 'lead_activities';
const MAX_ROWS_PER_LEAD = 300; // one ZCQL page; matches the translator's cap

const quote = (value) => String(value).replace(/'/g, "''");
const toMs = (value) => (value ? Date.parse(value) : NaN);

function isNewerOrSame(snapshotMs, rowSnapshotAt) {
  const rowMs = toMs(rowSnapshotAt);
  return Number.isNaN(rowMs) || snapshotMs >= rowMs;
}

async function readRows(catalystApp, zohoLeadId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_ACTIVITIES_TABLE} WHERE zoho_lead_id = '${quote(zohoLeadId)}' LIMIT ${MAX_ROWS_PER_LEAD}`
  );
  return rows.map((row) => row[LEAD_ACTIVITIES_TABLE]).filter(Boolean);
}

function eventFields(event) {
  return {
    event_type: event.eventType,
    description: event.description,
    user_name: event.userName,
    followup_status: event.followupStatus,
    event_created_at: event.createdAt,
    event_updated_at: event.updatedAt,
  };
}

function differs(row, fields) {
  return Object.entries(fields).some(([key, value]) => (row[key] ?? null) !== (value ?? null));
}

/**
 * Brings one lead's stored activities in line with the dealer's latest list.
 * @returns {{ inserted: number, updated: number, deleted: number, skipped: number }}
 */
async function syncLeadActivities(catalystApp, { zohoLeadId, integration, events, snapshotAt, complete }) {
  const table = catalystApp.datastore().table(LEAD_ACTIVITIES_TABLE);
  const existing = await readRows(catalystApp, zohoLeadId);
  const byEventId = new Map(existing.map((row) => [String(row.source_event_id), row]));
  const snapshotMs = toMs(snapshotAt);
  const hasSnapshotTime = !Number.isNaN(snapshotMs);
  const counts = { inserted: 0, updated: 0, deleted: 0, skipped: 0 };
  const seen = new Set();

  for (const event of events) {
    if (seen.has(event.sourceEventId)) continue;
    seen.add(event.sourceEventId);
    const fields = eventFields(event);
    const row = byEventId.get(event.sourceEventId);
    if (!row) {
      await table.insertRow({
        zoho_lead_id: String(zohoLeadId),
        integration_id: String(integration.ROWID),
        dealer_code: integration.dealer_code ?? null,
        crm_type: integration.crm_type ?? null,
        source_event_id: event.sourceEventId,
        ...fields,
        snapshot_at: snapshotAt ?? null,
        deleted_at: null,
      });
      counts.inserted += 1;
      continue;
    }
    // Without a post time, fall back to the event's own updated_at.
    const newer = hasSnapshotTime
      ? isNewerOrSame(snapshotMs, row.snapshot_at)
      : toMs(event.updatedAt) > toMs(row.event_updated_at);
    if (!newer) { counts.skipped += 1; continue; }
    if (!differs(row, fields) && !row.deleted_at) continue;
    await table.updateRow({ ROWID: row.ROWID, ...fields, snapshot_at: snapshotAt ?? row.snapshot_at ?? null, deleted_at: null });
    counts.updated += 1;
  }

  // An event missing from a complete, timed list was deleted by the dealer, unless
  // a newer post has written that row since (this post is late).
  if (complete && hasSnapshotTime) {
    for (const row of existing) {
      if (seen.has(String(row.source_event_id)) || row.deleted_at) continue;
      if (!isNewerOrSame(snapshotMs, row.snapshot_at) || snapshotMs === toMs(row.snapshot_at)) continue;
      await table.updateRow({ ROWID: row.ROWID, deleted_at: snapshotAt, snapshot_at: snapshotAt });
      counts.deleted += 1;
    }
  }
  return counts;
}

/**
 * Records a dealer's activity list against each MG lead it belongs to. Never
 * throws: activities are informational and must not hold or fail the webhook.
 * @param {object} args
 * @param {string[]} args.zohoLeadIds - MG leads (crm_record_id) the post resolved to
 * @param {object} args.integration - the dealer_integrations row
 * @param {object[]} args.events - translated lead events (dealerStudioInbound.parseLeadEvents)
 * @param {string|null} args.snapshotAt - when the dealer's post was produced
 * @param {boolean} args.complete - false when the list was cut short (no deletions then)
 */
async function recordDealerActivities(catalystApp, { zohoLeadIds, integration, events, snapshotAt, complete = true }) {
  const totals = { leads: 0, inserted: 0, updated: 0, deleted: 0, skipped: 0 };
  if (!zohoLeadIds?.length) return { ...totals, recorded: false, reason: 'NO_MAPPED_LEAD' };
  try {
    for (const zohoLeadId of [...new Set(zohoLeadIds.map(String))]) {
      const counts = await syncLeadActivities(catalystApp, { zohoLeadId, integration, events: events || [], snapshotAt, complete });
      totals.leads += 1;
      Object.keys(counts).forEach((key) => { totals[key] += counts[key]; });
    }
    if (totals.inserted || totals.updated || totals.deleted) {
      // Counts only: descriptions can hold customer details.
      logger.info(
        'leadActivityService',
        `Dealer ${integration.dealer_code} activities on ${totals.leads} lead(s): ${totals.inserted} new, ${totals.updated} changed, ${totals.deleted} deleted`
      );
    }
    return { ...totals, recorded: true };
  } catch (err) {
    logger.error('leadActivityService', `Could not record dealer ${integration.dealer_code} activities (is the ${LEAD_ACTIVITIES_TABLE} table created?)`, err);
    return { ...totals, recorded: false, reason: 'STORE_FAILED' };
  }
}

/**
 * A lead's dealer activities, oldest first, without deleted ones.
 * @returns {Promise<{ available: boolean, activities: object[] }>}
 */
async function getLeadActivities(catalystApp, zohoLeadId) {
  let rows;
  try {
    rows = await readRows(catalystApp, zohoLeadId);
  } catch (err) {
    logger.error('leadActivityService', `Could not read activities for lead ${zohoLeadId}`, err);
    return { available: false, activities: [] };
  }
  const activities = rows
    .filter((row) => !row.deleted_at)
    .map((row) => ({
      id: row.source_event_id,
      event_type: row.event_type,
      description: row.description || null,
      user_name: row.user_name || null,
      followup_status: row.followup_status || null,
      created_at: row.event_created_at || null,
      updated_at: row.event_updated_at || null,
      dealer_code: row.dealer_code || null,
      crm_type: row.crm_type || null,
    }))
    .sort((a, b) => (toMs(a.created_at) || 0) - (toMs(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)));
  return { available: true, activities };
}

module.exports = { recordDealerActivities, getLeadActivities, LEAD_ACTIVITIES_TABLE };
