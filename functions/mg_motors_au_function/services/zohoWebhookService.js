'use strict';

const axios = require('axios');
const {
  getZohoConfig, getPublicFunctionBaseUrl, getOemWatchLifetimeConfig,
} = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const usageContext = require('./usageContext');
const integrationAuthService = require('./integrations/integrationAuthService');
const { deriveZohoWatchToken } = require('./integrations/webhookVerificationService');
const { guardSweep } = require('./integrations/sweepOverlapGuard');
const { assertZohoEndpoint } = require('./integrations/adapters/zohoEndpointPolicy');
const { assertSafeUrl, safeRequestOptions } = require('./integrations/adapters/safeHttp');
const operationClaims = require('./integrations/integrationOperationClaimService');
const pathPolicy = require('./integrations/pathPolicyService');

const ZOHO_REQUEST_TIMEOUT_MS = 10000;

function toZohoDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+00:00`;
}

// No hardcoded fallback: getPublicFunctionBaseUrl() throws when
// PUBLIC_FUNCTION_BASE_URL is missing or malformed (see config/env.js).
function buildNotifyUrl() {
  return `${getPublicFunctionBaseUrl()}/webhooks/crm-notify`;
}

const OEM_WATCH_EVENTS = ['Dealers.all', 'Leads.all'];
const OEM_MODULE_NAME = 'Dealers,Leads';
const DEALER_WATCH_EVENTS = ['Leads.edit'];
// Requested lifetime. Zoho v8 allows up to one week, but a value beyond the
// limit silently becomes ONE HOUR (and older docs say one day), so it stays
// under a day; renewal is driven by remaining lifetime (OEM review 4.6).
const CHANNEL_LIFETIME_MS = 23 * 60 * 60 * 1000;

function authHeaders(accessToken) {
  return { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' };
}

async function watchRequest(apiLabel, watchUrl, accessToken, { method, data, params }) {
  return usageContext.trackApiCall(apiLabel, () => axios.request({
    method,
    url: watchUrl.toString(),
    ...safeRequestOptions(watchUrl),
    headers: authHeaders(accessToken),
    ...(data ? { data } : {}),
    ...(params ? { params } : {}),
    timeout: ZOHO_REQUEST_TIMEOUT_MS,
  }));
}

/**
 * Zoho lists one entry per watched module; one channel spans several. Returns
 * one object per channel: { channelId, notifyUrl, events, expiresAt }.
 */
function groupWatchEntries(entries) {
  const channels = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const channelId = String(entry?.channel_id || '').trim();
    if (!channelId) continue;
    const channel = channels.get(channelId) || { channelId, notifyUrl: null, events: [], expiresAt: null };
    if (entry.notify_url) channel.notifyUrl = String(entry.notify_url);
    for (const event of Array.isArray(entry.events) ? entry.events : []) {
      if (!channel.events.includes(event)) channel.events.push(event);
    }
    const expiry = entry.channel_expiry ? new Date(entry.channel_expiry) : null;
    if (expiry && !Number.isNaN(expiry.getTime()) && (!channel.expiresAt || expiry < channel.expiresAt)) {
      channel.expiresAt = expiry;
    }
    channels.set(channelId, channel);
  }
  return [...channels.values()];
}

async function listChannels(apiLabel, watchUrl, accessToken, params) {
  const response = await watchRequest(apiLabel, watchUrl, accessToken, { method: 'GET', params });
  return groupWatchEntries(response?.data?.watch);
}

/** Zoho reports `Leads.all` back as Leads.create / Leads.edit / Leads.delete. */
function coversEvents(actual, wanted) {
  const have = new Set(actual);
  return wanted.every((event) => {
    const [module, operation] = event.split('.');
    if (operation !== 'all') return have.has(event) || have.has(`${module}.all`);
    return have.has(event) || ['create', 'edit', 'delete'].every((op) => have.has(`${module}.${op}`));
  });
}

function succeeded(response) {
  const result = response?.data?.watch?.[0];
  return result?.status === 'success' || result?.code === 'SUCCESS';
}

function rejectionCode(response) {
  return String(response?.data?.watch?.[0]?.code || 'INVALID_RESPONSE').replace(/[^A-Z0-9_]/g, '').slice(0, 80);
}

/** The OEM org id the token belongs to, for the channel's ownership record; null when unreadable. */
async function zohoOrgId(apiLabel, apiOrigin, accessToken) {
  try {
    const orgUrl = await assertSafeUrl(`${apiOrigin}/crm/v8/org`);
    const response = await usageContext.trackApiCall(apiLabel, () => axios.request({
      method: 'GET',
      url: orgUrl.toString(),
      ...safeRequestOptions(orgUrl),
      headers: authHeaders(accessToken),
      timeout: ZOHO_REQUEST_TIMEOUT_MS,
    }));
    const id = response?.data?.org?.[0]?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * Records the channel as Zoho reports it. The extended columns (notify_url,
 * events, owner_project_id, owner_environment, zoho_org_id) are optional: a
 * table without them gets the base row. A failed write is logged, not thrown:
 * the channel is live, and the next renewal finds it in Zoho's own list.
 */
async function persistChannel(catalystApp, baseRow, extendedRow) {
  const table = catalystApp.datastore().table('webhook_channels');
  try {
    await table.insertRow({ ...baseRow, ...extendedRow });
    return true;
  } catch {
    try {
      await table.insertRow(baseRow);
      return true;
    } catch (err) {
      logger.error('zohoWebhookService', `Channel ${baseRow.channel_id} is live but could not be recorded locally`, err);
      return false;
    }
  }
}

/**
 * Renews the channel that delivers to `notifyUrl` in place, or creates one when
 * none exists (OEM review 4.1). Zoho's own channel list is the source of truth,
 * not the newest local row. Nothing is deleted before a working channel is
 * confirmed, and only channels of this notify URL are touched, so another
 * project's channel is left alone.
 */
async function renewOrCreateChannel({ scopeLabel, apiLabel, watchUrl, accessToken, notifyUrl, events, watchExtras }) {
  const expiryDate = new Date(Date.now() + CHANNEL_LIFETIME_MS);
  const channelExpiry = toZohoDateTime(expiryDate);
  const body = (channelId) => ({
    watch: [{ channel_id: channelId, events, notify_url: notifyUrl, channel_expiry: channelExpiry, ...watchExtras }],
  });

  let ours = [];
  try {
    ours = (await listChannels(apiLabel, watchUrl, accessToken)).filter((channel) => channel.notifyUrl === notifyUrl);
  } catch (err) {
    // An unreadable list must not block renewal: create one, and the next
    // renewal (which can read the list) removes any duplicate.
    logger.error('zohoWebhookService', `Could not list watch channels for ${scopeLabel}; a new channel will be created`, `HTTP ${err.response?.status || 'network error'}`);
  }
  ours.sort((a, b) => (b.expiresAt?.getTime() || 0) - (a.expiresAt?.getTime() || 0));

  let channelId = null;
  let mode = null;
  if (ours.length > 0) {
    const candidate = ours[0].channelId;
    try {
      const response = await watchRequest(apiLabel, watchUrl, accessToken, {
        method: 'PATCH',
        data: body(/^\d+$/.test(candidate) ? Number(candidate) : candidate),
      });
      if (succeeded(response)) {
        channelId = candidate;
        mode = 'renewed';
      } else {
        logger.error('zohoWebhookService', `Zoho did not renew channel ${candidate} for ${scopeLabel} (${rejectionCode(response)}); creating a new one`);
      }
    } catch (err) {
      logger.error('zohoWebhookService', `Renewing channel ${candidate} for ${scopeLabel} failed; creating a new one`, `HTTP ${err.response?.status || 'network error'}`);
    }
  }

  if (!channelId) {
    const newId = Date.now();
    let response;
    try {
      logger.info('zohoWebhookService', `Calling watch API (create) for ${scopeLabel} notify_url=${notifyUrl}`);
      response = await watchRequest(apiLabel, watchUrl, accessToken, { method: 'POST', data: body(newId) });
    } catch (err) {
      const zohoError = `HTTP ${err.response?.status || 'network error'}`;
      logger.error('zohoWebhookService', `Failed to register watch channel for ${scopeLabel}`, zohoError);
      throw new Error(`Watch channel registration failed: ${JSON.stringify(zohoError)}`);
    }
    if (!succeeded(response)) {
      throw new Error(`Zoho rejected watch registration for ${scopeLabel}: ${rejectionCode(response)}`);
    }
    channelId = String(newId);
    mode = 'created';
  }

  // Read the channel back: what Zoho holds is what gets recorded.
  let readBack = null;
  try {
    readBack = (await listChannels(apiLabel, watchUrl, accessToken, { channel_id: channelId }))
      .find((channel) => channel.channelId === String(channelId)) || null;
  } catch (err) {
    logger.error('zohoWebhookService', `Could not read back channel ${channelId} for ${scopeLabel}`, `HTTP ${err.response?.status || 'network error'}`);
  }
  const verified = Boolean(readBack && readBack.notifyUrl === notifyUrl && coversEvents(readBack.events, events));
  if (readBack && !verified) {
    logger.error('zohoWebhookService', `Channel ${channelId} for ${scopeLabel} read back with notify_url=${readBack.notifyUrl} events=${readBack.events.join(',')}; expected ${notifyUrl} ${events.join(',')}`);
  }

  // Only now, with a working channel confirmed, remove the other channels of
  // this same notify URL (duplicates left by earlier renewals).
  const duplicates = ours.map((channel) => channel.channelId).filter((id) => id !== String(channelId));
  if (duplicates.length > 0) {
    try {
      await watchRequest(apiLabel, watchUrl, accessToken, { method: 'DELETE', params: { channel_ids: duplicates.join(',') } });
      logger.info('zohoWebhookService', `Removed duplicate channel(s) ${duplicates.join(',')} for ${scopeLabel}`);
    } catch (err) {
      logger.error('zohoWebhookService', `Could not remove duplicate channel(s) ${duplicates.join(',')} for ${scopeLabel}`, `HTTP ${err.response?.status || 'network error'}`);
    }
  }

  return {
    channelId: String(channelId),
    mode,
    verified,
    expiresAt: readBack?.expiresAt || expiryDate,
    readBack,
    removedDuplicates: duplicates,
  };
}

function ownershipColumns(readBack, notifyUrl, orgId) {
  const project = usageContext.current()?.catalystProject;
  return {
    notify_url: String(readBack?.notifyUrl || notifyUrl).slice(0, 255),
    events: (readBack?.events || []).join(',').slice(0, 255),
    owner_project_id: project?.projectId || null,
    owner_environment: project?.environment || null,
    zoho_org_id: orgId,
  };
}

async function registerWatchChannelsInternal(catalystApp) {
  // Built before any Zoho call, so a missing URL changes nothing in Zoho.
  const notifyUrl = buildNotifyUrl();
  const { apiDomain, webhookToken } = getZohoConfig();
  const watchUrl = await validatedWatchUrl(apiDomain);

  // One renewal at a time across every instance of this project: a durable
  // lease (guardSweep below covers only one warm instance).
  return operationClaims.withOperationClaim(catalystApp, 'oem-watch-renewal', async () => {
    const accessToken = await getAccessToken();
    const result = await renewOrCreateChannel({
      scopeLabel: 'OEM',
      apiLabel: 'mg',
      watchUrl,
      accessToken,
      notifyUrl,
      events: OEM_WATCH_EVENTS,
      watchExtras: { token: deriveZohoWatchToken(webhookToken) },
    });
    const orgId = await zohoOrgId('mg', watchUrl.origin, accessToken);
    await persistChannel(catalystApp, {
      channel_id: result.channelId,
      module_name: OEM_MODULE_NAME,
      registered_at: toCatalystDateTime(new Date()),
      expires_at: toCatalystDateTime(result.expiresAt),
    }, ownershipColumns(result.readBack, notifyUrl, orgId));
    const expiresAt = toZohoDateTime(result.expiresAt);
    logger.info('zohoWebhookService', `${result.mode === 'renewed' ? 'Renewed' : 'Registered'} watch channel ${result.channelId} (OEM) notify_url=${notifyUrl} events=${OEM_WATCH_EVENTS.join(',')}, expires ${expiresAt}, verified=${result.verified}`);
    return { channelId: result.channelId, expiresAt, notifyUrl, mode: result.mode, verified: result.verified };
  });
}

// guardSweep cheaply stops one instance overlapping itself; the durable
// operation claim inside covers every instance. Exported name unchanged.
const registerWatchChannels = guardSweep('oemWebhookRenewal', registerWatchChannelsInternal);

/** The latest recorded OEM channel row, or null. */
async function latestOemChannelRow(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM webhook_channels WHERE module_name = '${OEM_MODULE_NAME}' ORDER BY CREATEDTIME DESC LIMIT 1`
  );
  return rows[0]?.webhook_channels || null;
}

/**
 * For the frequent fast-recover run (OEM review 4.6): renews the OEM channel
 * once less than OEM_WATCH_RENEW_BEFORE_MINUTES of its life remains, and calls
 * `alert` when it is about to lapse (or has) and could not be renewed, or when
 * Zoho reads it back wrong. Costs one Data Store read when renewal is not due.
 */
async function ensureOemWatchChannelFresh(catalystApp, { now = new Date(), alert } = {}) {
  const { renewBeforeMinutes, alertBelowMinutes } = getOemWatchLifetimeConfig();
  const row = await latestOemChannelRow(catalystApp);
  const expiresAt = pathPolicy.parseTimestamp(row?.expires_at);
  const remainingMinutes = expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / 60000) : null;
  if (remainingMinutes !== null && remainingMinutes >= renewBeforeMinutes) {
    return { renewed: false, remainingMinutes };
  }

  let result = null;
  let error = null;
  try {
    result = await registerWatchChannels(catalystApp);
  } catch (err) {
    error = err;
    logger.error('zohoWebhookService', 'OEM watch channel renewal failed', err);
  }
  const renewed = Boolean(result && !result.skipped && result.channelId);
  if (alert && !renewed && (remainingMinutes === null || remainingMinutes < alertBelowMinutes)) {
    await alert({ remainingMinutes, reason: error ? error.message : (result?.reason || 'renewal did not run') });
  }
  if (alert && renewed && result.verified === false) {
    await alert({ remainingMinutes, reason: `channel ${result.channelId} was read back with a different notify URL or events, or could not be read back` });
  }
  return { renewed, remainingMinutes, ...(result ? { result } : {}), ...(error ? { error: error.message } : {}) };
}

const { getAccessTokenForDealerZoho } = require('./integrations/adapters/zohoCrmOAuthHelper');

function buildDealerNotifyUrl(dealerCode) {
  return `${getPublicFunctionBaseUrl()}/webhooks/dealers/${encodeURIComponent(dealerCode)}`;
}

/**
 * Registers or renews the Zoho CRM watch channel on a DEALER's own Zoho org
 * (not our OEM one), so their Leads edits notify OUR per-dealer webhook route.
 * Same in-place renewal as the OEM channel (OEM review 4.1).
 */
async function registerDealerWatchChannelInternal(catalystApp, integration) {
  if (!isDealerWatchEligible(integration)) {
    throw Object.assign(new Error('Watch registration requires an active Zoho integration with inbound updates enabled'), {
      code: 'INVALID_CRM_CONFIGURATION',
    });
  }
  // Validate the whole destination before looking up either OAuth credentials
  // or the callback authentication token.
  const watchUrl = await validatedWatchUrl(integration.base_url);
  assertZohoEndpoint(integration.oauth_accounts_domain || 'https://accounts.zoho.in', 'accounts');
  // Built before any credential read, so a missing PUBLIC_FUNCTION_BASE_URL
  // leaves the dealer's existing channel untouched.
  const notifyUrl = buildDealerNotifyUrl(integration.dealer_code);
  const accessToken = await getAccessTokenForDealerZoho(catalystApp, integration);
  const webhookSecret = await integrationAuthService.getDecryptedCredential(
    catalystApp, integration.ROWID, 'WEBHOOK_SECRET'
  );
  if (!webhookSecret) {
    throw Object.assign(new Error('Generate a webhook secret before registering the dealer watch channel'), {
      code: 'WEBHOOK_AUTH_NOT_CONFIGURED',
    });
  }

  const result = await renewOrCreateChannel({
    scopeLabel: integration.dealer_code,
    apiLabel: integration.dealer_code,
    watchUrl,
    accessToken,
    notifyUrl,
    // Only edits can update an already-linked dealer lead. Listening to
    // create/delete generated false Unhappy 7/4 events because those
    // records cannot be resolved through lead_integrations.
    events: DEALER_WATCH_EVENTS,
    watchExtras: {
      token: deriveZohoWatchToken(webhookSecret),
      return_affected_field_values: true,
      notify_on_related_action: false,
    },
  });

  await persistChannel(catalystApp, {
    channel_id: result.channelId,
    dealer_code: integration.dealer_code,
    integration_id: integration.ROWID,
    module_name: 'Leads',
    registered_at: toCatalystDateTime(new Date()),
    expires_at: toCatalystDateTime(result.expiresAt),
  }, ownershipColumns(result.readBack, notifyUrl, null));

  const expiresAt = toZohoDateTime(result.expiresAt);
  logger.info('zohoWebhookService', `${result.mode === 'renewed' ? 'Renewed' : 'Registered'} dealer watch channel ${result.channelId} for ${integration.dealer_code} notify_url=${notifyUrl}, expires ${expiresAt}, verified=${result.verified}`);
  return { dealerCode: integration.dealer_code, channelId: result.channelId, expiresAt, mode: result.mode, verified: result.verified };
}

/**
 * Guarded per dealer against two overlapping renewals of the SAME dealer
 * (guardSweep keyed per dealer, so different dealers stay concurrent).
 * Exported name/signature unchanged for cronRoutes.js.
 */
async function registerDealerWatchChannel(catalystApp, integration) {
  return guardSweep(`dealerWebhookRenewal:${integration.dealer_code}`, registerDealerWatchChannelInternal)(catalystApp, integration);
}

function isDealerWatchEligible(integration) {
  return integration?.integration_type === 'EXTERNAL_CRM' && integration.crm_type === 'ZOHO_CRM' &&
    ['ACTIVE', 'CONNECTED'].includes(String(integration.status || '').toUpperCase()) &&
    [true, 1, 'true', '1'].includes(integration.inbound_enabled);
}

async function validatedWatchUrl(baseUrl) {
  const api = assertZohoEndpoint(baseUrl, 'api');
  return assertSafeUrl(`${api.origin}/crm/v8/actions/watch`);
}

module.exports = {
  registerWatchChannels,
  registerDealerWatchChannel,
  isDealerWatchEligible,
  ensureOemWatchChannelFresh,
  _test: { groupWatchEntries, coversEvents, CHANNEL_LIFETIME_MS },
};
