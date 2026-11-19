'use strict';

/**
 * dealerStudioLocationRouting.js
 * -----------------------------------------------------------------------
 * One Dealer Studio dealership account can hold several MG dealers as its
 * locations: Heartland (`heartland-motors`) has Castle Hill (215402, location
 * 6033) and Penrith (275002, location 1095). Dealer Studio sets ONE webhook per
 * account, so every cluster of that account arrives on one MG dealer's URL
 * (Dealer Studio, 19 Nov 2026). Every later lookup is scoped to one dealer's
 * integration, so a Penrith cluster on Castle Hill's URL would find no lead.
 *
 * The route verifies the post with the URL dealer's secret first, then asks
 * this module which MG dealer the cluster belongs to:
 *   1. its location id, matched to a dealer's dealership_location_id;
 *   2. otherwise its lead ids, matched to the leads MG sent to one dealer.
 * Only dealers with the URL dealer's dealership_slug are candidates, so one
 * account can never reach another account's leads. Anything unclear (no
 * sibling, no match, two locations in one post, a read failure) stays with the
 * URL dealer, which is exactly the behaviour before this module.
 */

const logger = require('../../utils/logger');
const crmIntegrationService = require('./crmIntegrationService');

const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const UNUSABLE_STATUSES = new Set(['DISABLED', 'NOT_CONFIGURED', 'CONFIGURING']);

function quote(value) {
  return String(value).replace(/'/g, "''");
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isEnabled(value) {
  return !(value === false || value === 0 || String(value).toLowerCase() === 'false' || String(value) === '0');
}

function objects(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

/** A location id as Dealer Studio may send it: an object's id, or a bare id. */
function locationIdOf(container) {
  if (!container || typeof container !== 'object') return '';
  const location = container.location;
  if (location && typeof location === 'object') {
    const id = text(location.id);
    if (id) return id;
  }
  return text(container.location_id) || text(container.dealership_location_id);
}

/**
 * The one location id the cluster names, or null when it names none or more
 * than one (the cluster root, then each of its leads).
 */
function payloadLocationId(payload) {
  const ids = new Set();
  const root = locationIdOf(payload);
  if (root) ids.add(root);
  for (const lead of objects(payload?.leads)) {
    const id = locationIdOf(lead);
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function payloadLeadIds(payload) {
  return [...new Set(objects(payload?.leads).map((lead) => text(lead.id)).filter(Boolean))];
}

function isUsable(integration) {
  return integration
    && integration.crm_type === 'DEALER_STUDIO'
    && integration.integration_type === 'EXTERNAL_CRM'
    && !UNUSABLE_STATUSES.has(String(integration.status || '').toUpperCase())
    && isEnabled(integration.inbound_enabled);
}

async function sameAccountIntegrations(catalystApp, slug) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE crm_type = 'DEALER_STUDIO' AND dealership_slug = '${quote(slug)}' LIMIT 50`
  );
  return rows.map((row) => row[DEALER_INTEGRATIONS_TABLE]).filter(Boolean);
}

async function dealerIsActive(catalystApp, dealerCode) {
  const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
  return Boolean(dealer && dealer.sync_status !== 'Removed');
}

/** The integration ids that hold any of these Dealer Studio lead ids. */
async function integrationsHoldingLeads(catalystApp, leadIds, integrationIds) {
  const ids = integrationIds.filter((id) => /^\d+$/.test(id));
  if (leadIds.length === 0 || ids.length === 0) return new Set();
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT integration_id FROM ${LEAD_INTEGRATIONS_TABLE} WHERE external_crm_lead_id IN (${leadIds.map((id) => `'${quote(id)}'`).join(', ')}) ` +
    `AND integration_id IN (${ids.join(', ')}) LIMIT 50`
  );
  return new Set(rows.map((row) => text(row[LEAD_INTEGRATIONS_TABLE]?.integration_id)).filter(Boolean));
}

/**
 * @returns {Promise<{ integration: object, routedBy: 'location'|'lead'|null }>}
 *   the integration the cluster belongs to; the URL dealer's own, unchanged,
 *   unless a sibling of the same Dealer Studio account is clearly named.
 */
async function resolveTargetIntegration(catalystApp, urlIntegration, payload) {
  const stay = { integration: urlIntegration, routedBy: null };
  const slug = text(urlIntegration?.dealership_slug);
  if (urlIntegration?.crm_type !== 'DEALER_STUDIO' || !slug) return stay;

  try {
    const account = await sameAccountIntegrations(catalystApp, slug);
    const siblings = account.filter((row) => String(row.ROWID) !== String(urlIntegration.ROWID) && isUsable(row));
    if (siblings.length === 0) return stay;

    const locationId = payloadLocationId(payload);
    if (locationId) {
      if (text(urlIntegration.dealership_location_id) === locationId) return stay;
      const byLocation = siblings.filter((row) => text(row.dealership_location_id) === locationId);
      if (byLocation.length === 1 && await dealerIsActive(catalystApp, byLocation[0].dealer_code)) {
        return { integration: byLocation[0], routedBy: 'location' };
      }
    }

    const leadIds = payloadLeadIds(payload);
    const holders = await integrationsHoldingLeads(
      catalystApp, leadIds, [urlIntegration, ...siblings].map((row) => String(row.ROWID))
    );
    if (holders.size === 0 || holders.has(String(urlIntegration.ROWID))) return stay;
    const byLead = siblings.filter((row) => holders.has(String(row.ROWID)));
    if (byLead.length === 1 && await dealerIsActive(catalystApp, byLead[0].dealer_code)) {
      return { integration: byLead[0], routedBy: 'lead' };
    }
    return stay;
  } catch (err) {
    logger.error(
      'dealerStudioLocationRouting',
      `Could not resolve the dealer for a Dealer Studio post on ${urlIntegration.dealer_code}'s URL; kept with ${urlIntegration.dealer_code}`,
      err
    );
    return stay;
  }
}

module.exports = { resolveTargetIntegration, _test: { payloadLocationId, payloadLeadIds } };
