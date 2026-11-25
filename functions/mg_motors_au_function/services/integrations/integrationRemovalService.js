'use strict';

/**
 * integrationRemovalService.js
 * -----------------------------------------------------------------------
 * "Remove connection" on the Dealer CRM page: deletes a dealer's CRM
 * integration and its configuration, so the dealer is back to "Not Connected".
 *
 * Deleted (in this order, so a failure part-way leaves the integration row in
 * place and the removal can simply be run again):
 *   integration_field_mappings, integration_status_mappings,
 *   integration_credentials (rows of this integration_id), then the
 *   dealer_integrations row itself.
 * Kept: integration_logs and webhook_events (the audit trail).
 *
 * Refused when removing would break live data:
 *   - INTEGRATION_HAS_LEADS: leads were already sent to the dealer's CRM. Their
 *     lead_integrations mappings are how the dealer's updates find MG's leads.
 *     Turn "Push leads" off, or switch the dealer to Dealer Portal, instead.
 *   - INTEGRATION_HAS_WATCH_CHANNEL: a Zoho watch channel is registered for the
 *     dealer and would keep notifying a dealer that no longer exists here.
 */

const logger = require('../../utils/logger');

const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const WEBHOOK_CHANNELS_TABLE = 'webhook_channels';
const CHILD_TABLES = ['integration_field_mappings', 'integration_status_mappings', 'integration_credentials'];
const PAGE = 300;
const MAX_PAGES = 20; // 6000 rows per table: far beyond any real configuration

const quote = (value) => String(value).replace(/'/g, "''");

function removalError(code, extra = {}) {
  const err = new Error(code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

async function countRows(catalystApp, table, where) {
  const rows = await catalystApp.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${table} WHERE ${where}`);
  return Number(rows[0]?.[table]?.['COUNT(ROWID)'] ?? 0);
}

/** Deletes every row of `table` with this integration_id. @returns {number} rows deleted */
async function deleteIntegrationRows(catalystApp, table, integrationId) {
  const datastoreTable = catalystApp.datastore().table(table);
  let deleted = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID FROM ${table} WHERE integration_id = ${integrationId} LIMIT ${PAGE}`
    );
    const ids = rows.map((row) => row[table]?.ROWID).filter(Boolean);
    if (ids.length === 0) return deleted;
    for (const id of ids) {
      await datastoreTable.deleteRow(id);
      deleted += 1;
    }
  }
  throw removalError('REMOVAL_INCOMPLETE', { table });
}

/**
 * @param {object} integration - the dealer_integrations row to remove
 * @returns {Promise<{ dealer_code: string, integration_id: string, deleted: object }>}
 */
async function removeDealerIntegration(catalystApp, integration) {
  const integrationId = String(integration.ROWID);
  if (!/^\d+$/.test(integrationId)) throw removalError('INVALID_INTEGRATION');
  const dealerCode = integration.dealer_code;

  const leadCount = await countRows(catalystApp, LEAD_INTEGRATIONS_TABLE, `integration_id = ${integrationId}`);
  if (leadCount > 0) throw removalError('INTEGRATION_HAS_LEADS', { count: leadCount });

  const channelCount = await countRows(catalystApp, WEBHOOK_CHANNELS_TABLE, `dealer_code = '${quote(dealerCode)}'`);
  if (channelCount > 0) throw removalError('INTEGRATION_HAS_WATCH_CHANNEL', { count: channelCount });

  const deleted = {};
  for (const table of CHILD_TABLES) {
    deleted[table] = await deleteIntegrationRows(catalystApp, table, integrationId);
  }
  await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).deleteRow(integrationId);
  deleted[DEALER_INTEGRATIONS_TABLE] = 1;

  logger.info(
    'integrationRemovalService',
    `Removed ${integration.crm_type || 'CRM'} integration ${integrationId} of dealer ${dealerCode}`,
    deleted
  );
  return { dealer_code: dealerCode, integration_id: integrationId, deleted };
}

module.exports = { removeDealerIntegration, CHILD_TABLES };
