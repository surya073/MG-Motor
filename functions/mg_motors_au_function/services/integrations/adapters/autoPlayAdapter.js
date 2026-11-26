'use strict';

const axios = require('axios');
const logger = require('../../../utils/logger');
const usageContext = require('../../usageContext');
const integrationAuthService = require('../integrationAuthService');
const autoPlayRateBudget = require('../autoPlayRateBudget');
const { assertSafeUrl, safeRequestOptions } = require('./safeHttp');
const { nestDottedKeys } = require('./nestDottedKeys');
const { toUpdateBody } = require('./autoPlayPayload');

/**
 * autoPlayAdapter.js
 * -----------------------------------------------------------------------
 * Dedicated adapter for dealers whose CRM is AutoPlay (crm_type = 'AUTOPLAY').
 * Same contract as every other adapter (createLead/updateLead/getLead/
 * testConnection), resolved through crmAdapterFactory.getAdapter().
 *
 * CONTRACT - AutoPlay.Api 1.0.0 (https://api.autoplayauto.com/swagger/v1/docs.json,
 * saved as data/autoplayDocs/AutoPlay_API_Documentation.pdf) and AutoPlay's
 * onboarding email (Nov 2026):
 *   - Base URL https://api.autoplayauto.com.
 *   - OAuth 2.0 client credentials: POST /connect/token, form body
 *     grant_type=client_credentials, client_id, client_secret, scope. The id and
 *     secret are the dealer's AUTOPLAY_CLIENT_ID / AUTOPLAY_CLIENT_SECRET
 *     credentials. The token is cached per integration until shortly before it
 *     expires; a 401 drops it and the request is retried once with a new one.
 *   - Create: POST /api/v1/leads (CreateLeadRequest). Answers 200 with
 *     LeadActionResponse { leadId, ... }; leadId is the external lead id.
 *     A uniqueIdentifier sent before returns the lead already created.
 *   - Update: PATCH /api/v1/leads/{id} with only the changed-field subset
 *     PatchLeadRequest takes (contact, comments, privacyPolicyAccepted).
 *   - Errors are RFC 7807 ProblemDetails { title, detail, status }.
 *   - Rate limit 1/second, 10/minute, 100/hour per credential: every request,
 *     the token request included, goes through autoPlayRateBudget first.
 *   - The dealer's AutoPlay ids come from the integration row and are added to
 *     every create: dealerId (required), yardId, sourceId and campaignId.
 *
 * Not supported yet: getLead (reconciliation and replay skip these dealers).
 * Return updates from AutoPlay are being scoped by AutoPlay against
 * data/autoplayDocs/MG_X_AutoPlay_Webhook_Guide.pdf.
 */

const DEFAULT_BASE_URL = 'https://api.autoplayauto.com';
const DEFAULT_CREATE_PATH = '/api/v1/leads';
const TOKEN_PATH = '/connect/token';
const TOKEN_SCOPE = 'lead:write';
const MAX_BODY_BYTES = 32000;
const DEFAULT_TOKEN_LIFETIME_SEC = 3600;
const MAX_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const capabilities = Object.freeze({
  createLead: true,
  updateLead: true,
  getLead: false,
  statusUpdate: false,
  webhook: false,
  duplicateSearch: false,
});

const tokenCache = new Map(); // integrationId -> { accessToken, refreshAt }
const inFlightRefreshes = new Map(); // integrationId -> Promise<string>

function configError(message) {
  const err = new Error(message);
  err.code = 'INVALID_CRM_CONFIGURATION';
  return err;
}

function baseUrlOf(integration) {
  return String(integration.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function retryAfterSeconds(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined;
}

function classifyAutoPlayError(err) {
  const status = err.response?.status;
  if (status === 401 || status === 403) return 'AUTHENTICATION_FAILED';
  if (status === 400 || status === 409 || status === 422) return 'FIELD_MAPPING_INVALID';
  if (status === 404) return 'NOT_FOUND';
  return 'EXTERNAL_CRM_ERROR'; // 5xx, 429, network/timeout: retryable
}

/**
 * Never includes the request body, the token or the client secret in a thrown
 * message: only the HTTP status and AutoPlay's short ProblemDetails title/detail
 * (validation text, no lead data).
 */
function wrapError(err, contextMessage) {
  const body = err.response?.data;
  const parts = [body?.title, body?.detail].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  let detail = parts.join(': ').slice(0, 200);
  if (!detail && body?.errors && typeof body.errors === 'object') {
    detail = Object.entries(body.errors)
      .map(([field, messages]) => `${String(field).slice(0, 40)}: ${[].concat(messages).filter((m) => typeof m === 'string').join(', ').slice(0, 60)}`)
      .join('; ')
      .slice(0, 200);
  }
  const wrapped = new Error(`${contextMessage} (HTTP ${err.response?.status || 'network error'}${detail ? `: ${detail}` : ''})`);
  wrapped.code = classifyAutoPlayError(err);
  wrapped.response = err.response ? { status: err.response.status } : undefined;
  const retryAfter = retryAfterSeconds(err.response?.headers?.['retry-after'] ?? err.response?.headers?.['Retry-After']);
  if (err.response?.status) {
    wrapped.vendor = { status: err.response.status, ...(detail ? { detail } : {}), ...(retryAfter !== undefined ? { retryAfter } : {}) };
  }
  return wrapped;
}

// ------------------------------------------------------------------ token

async function requestNewToken(catalystApp, integration) {
  const tokenUrl = await assertSafeUrl(`${baseUrlOf(integration)}${TOKEN_PATH}`);
  const [clientId, clientSecret] = await Promise.all([
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'AUTOPLAY_CLIENT_ID'),
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'AUTOPLAY_CLIENT_SECRET'),
  ]);
  if (!clientId || !clientSecret) {
    const err = new Error('AutoPlay credentials (client ID / client secret) are not fully configured');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  await autoPlayRateBudget.takeSlot(catalystApp, integration);
  let response;
  try {
    usageContext.countToken('refresh');
    response = await usageContext.trackApiCall(integration.dealer_code, () => axios.post(
      tokenUrl.toString(),
      new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: TOKEN_SCOPE }).toString(),
      {
        ...safeRequestOptions(tokenUrl),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        timeout: 10000,
      }
    ));
  } catch (err) {
    // Only the status is logged: the request body carries the client secret.
    logger.error('autoPlayAdapter', `Token request failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`);
    const status = err.response?.status;
    if (status === 429) {
      await autoPlayRateBudget.recordRateLimited(catalystApp, integration, retryAfterSeconds(err.response.headers?.['retry-after']));
    }
    const transient = !status || status === 408 || status === 429 || status >= 500;
    const wrapped = new Error(status
      ? (transient ? 'AutoPlay token endpoint is temporarily unavailable' : 'Failed to obtain AutoPlay access token')
      : 'AutoPlay token endpoint did not respond');
    wrapped.code = transient ? 'EXTERNAL_CRM_ERROR' : 'AUTHENTICATION_FAILED';
    if (err.response) wrapped.response = { status };
    throw wrapped;
  }

  const { access_token, expires_in } = response.data || {};
  if (!access_token) {
    const err = new Error('AutoPlay token response did not include an access_token');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }
  const lifetimeSec = Number(expires_in);
  const lifetimeMs = (Number.isFinite(lifetimeSec) && lifetimeSec > 0 ? lifetimeSec : DEFAULT_TOKEN_LIFETIME_SEC) * 1000;
  return { accessToken: access_token, refreshAt: Date.now() + lifetimeMs - Math.min(MAX_REFRESH_MARGIN_MS, lifetimeMs / 2) };
}

/** The cached token while it is fresh; one refresh at a time per integration. */
async function getAccessToken(catalystApp, integration, { forceRefresh = false } = {}) {
  const id = integration.ROWID;
  const cached = tokenCache.get(id);
  if (!forceRefresh && cached && cached.refreshAt > Date.now()) {
    usageContext.countToken('hit');
    return cached.accessToken;
  }
  const existing = inFlightRefreshes.get(id);
  if (existing) return existing;
  const refresh = requestNewToken(catalystApp, integration)
    .then((token) => {
      if (inFlightRefreshes.get(id) === refresh) tokenCache.set(id, token);
      return token.accessToken;
    })
    .finally(() => {
      if (inFlightRefreshes.get(id) === refresh) inFlightRefreshes.delete(id);
    });
  inFlightRefreshes.set(id, refresh);
  return refresh;
}

/** Drops the cached token: all of it after a credential save, or only `failedToken` after a 401. */
function invalidateToken(integrationId, failedToken) {
  if (failedToken !== undefined) {
    if (tokenCache.get(integrationId)?.accessToken === failedToken) tokenCache.delete(integrationId);
    return;
  }
  tokenCache.delete(integrationId);
  inFlightRefreshes.delete(integrationId);
}

// ------------------------------------------------------------------ body

function digits(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return /^\d{1,10}$/.test(text) ? Number(text) : undefined;
}

/**
 * The dealer's AutoPlay account ids, from the integration row. dealerId is
 * required on create; the others are sent when configured.
 */
function dealerIds(integration) {
  return {
    dealerId: digits(integration.autoplay_dealer_id),
    yardId: digits(integration.autoplay_yard_id),
    sourceId: digits(integration.autoplay_source_id),
    campaignId: digits(integration.autoplay_campaign_id),
  };
}

function serializeBody(body) {
  let serialized;
  try { serialized = JSON.stringify(body ?? {}); } catch {
    const err = new Error('AutoPlay payload cannot be serialized as JSON');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
    const err = new Error(`AutoPlay payload exceeds ${MAX_BODY_BYTES} bytes`);
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }
  return serialized;
}

function buildCreateBody(integration, payload) {
  const ids = dealerIds(integration);
  if (ids.dealerId === undefined) throw configError('AutoPlay dealer ID is not configured for this dealer');
  if (ids.campaignId === undefined) throw configError('AutoPlay Test Drive campaign ID is not configured for this dealer');
  const body = nestDottedKeys(payload, 'autoPlayAdapter');
  Object.entries(ids).forEach(([key, value]) => {
    if (value !== undefined) body[key] = value;
  });
  return body;
}

function createPath(integration) {
  return String(integration.create_lead_endpoint || DEFAULT_CREATE_PATH).replace(/\/+$/, '');
}

function updatePath(integration, externalLeadId) {
  return `${createPath(integration)}/${encodeURIComponent(externalLeadId)}`;
}

/** Top-level keys and the keys inside nested objects: names only, never values. */
function describeFields(body) {
  if (!body || typeof body !== 'object') return [];
  const names = [];
  Object.entries(body).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.keys(value).forEach((inner) => names.push(`${key}.${inner}`));
    else names.push(key);
  });
  return names.sort();
}

// ------------------------------------------------------------------ requests

async function send(catalystApp, integration, { method, path, body }) {
  const url = await assertSafeUrl(`${baseUrlOf(integration)}${path}`);
  const data = serializeBody(body);
  const attempt = async (token) => {
    await autoPlayRateBudget.takeSlot(catalystApp, integration);
    try {
      return await usageContext.trackApiCall(integration.dealer_code, () => axios.request({
        method,
        url: url.toString(),
        ...safeRequestOptions(url),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
        data,
        maxBodyLength: MAX_BODY_BYTES,
        timeout: 10000,
      }));
    } catch (err) {
      if (err.response?.status === 429) {
        await autoPlayRateBudget.recordRateLimited(catalystApp, integration, retryAfterSeconds(err.response.headers?.['retry-after']));
      }
      throw err;
    }
  };

  const token = await getAccessToken(catalystApp, integration);
  try {
    return await attempt(token);
  } catch (err) {
    if (err.response?.status !== 401) throw err;
  }
  // A 401 can be a stale token (rotated or saved elsewhere): retry once with a new one.
  invalidateToken(integration.ROWID, token);
  return attempt(await getAccessToken(catalystApp, integration));
}

function asLeadId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return value.trim();
  return undefined;
}

/** LeadActionResponse.leadId; nothing else is guessed at. */
function extractExternalLeadId(response) {
  let body = response?.data;
  if (typeof body === 'string' && body.trim()) {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  return body && typeof body === 'object' ? asLeadId(body.leadId) : undefined;
}

function rethrow(err, integration, operation, message) {
  if (!err.response && err.code) throw err; // config / credential / budget errors already carry a code
  logger.error('autoPlayAdapter', `${operation} failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`);
  throw wrapError(err, message);
}

async function createLead(catalystApp, integration, payload) {
  const body = buildCreateBody(integration, payload);
  logger.info('autoPlayAdapter', `Create lead for dealer ${integration.dealer_code} sends fields: ${describeFields(body).join(', ')}`);
  let response;
  try {
    response = await send(catalystApp, integration, { method: 'POST', path: createPath(integration), body });
  } catch (err) {
    rethrow(err, integration, 'createLead', 'AutoPlay rejected the lead create request');
  }
  return { externalLeadId: extractExternalLeadId(response), httpStatus: response.status, raw: response.data };
}

async function updateLead(catalystApp, integration, externalLeadId, payload) {
  if (!externalLeadId) throw configError('AutoPlay updateLead needs the AutoPlay lead id');
  const body = toUpdateBody(nestDottedKeys(payload, 'autoPlayAdapter'));
  if (Object.keys(body).length === 0) {
    return { externalLeadId, httpStatus: 204, raw: null, skipped: true };
  }
  let response;
  try {
    response = await send(catalystApp, integration, { method: 'PATCH', path: updatePath(integration, externalLeadId), body });
  } catch (err) {
    rethrow(err, integration, 'updateLead', 'AutoPlay rejected the lead update request');
  }
  return { externalLeadId, httpStatus: response.status, raw: response.data };
}

async function getLead() {
  const err = new Error('AutoPlay adapter does not support getLead yet');
  err.code = 'UNSUPPORTED_OPERATION';
  throw err;
}

/**
 * Asks AutoPlay for a new token with the saved client id and secret. A token
 * is the proof: 2xx from /connect/token means the credentials are accepted.
 * Missing credentials, an unsafe URL or our own rate budget are thrown.
 */
async function testConnection(catalystApp, integration) {
  const start = Date.now();
  try {
    await getAccessToken(catalystApp, integration, { forceRefresh: true });
    return { httpStatus: 200, responseTimeMs: Date.now() - start, ok: true };
  } catch (err) {
    if (err.code === 'INVALID_CRM_CONFIGURATION' || autoPlayRateBudget.isLimitError(err)) throw err;
    if (err.code === 'AUTHENTICATION_FAILED' && !err.response) throw err;
    return { httpStatus: err.response?.status || 0, responseTimeMs: Date.now() - start, ok: false };
  }
}

function _resetForTests() {
  tokenCache.clear();
  inFlightRefreshes.clear();
}

module.exports = {
  createLead,
  updateLead,
  getLead,
  testConnection,
  capabilities,
  invalidateToken,
  DEFAULT_BASE_URL,
  _resetForTests,
  _test: { classifyAutoPlayError, extractExternalLeadId, buildCreateBody, dealerIds, wrapError, describeFields },
};
