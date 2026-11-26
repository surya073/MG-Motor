'use strict';

// AutoPlay (crm_type AUTOPLAY): adapter, payload rules, rate budget, and the
// outbound sync end to end (AutoPlay.Api 1.0.0; AutoPlay onboarding, Nov 2026).

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const autoPlayAdapter = require('../services/integrations/adapters/autoPlayAdapter');
const autoPlayRateBudget = require('../services/integrations/autoPlayRateBudget');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const { applyAutoPlayPayloadRules, campaignFor, toUpdateBody } = require('../services/integrations/adapters/autoPlayPayload');
const { FIELD_PRESET, INBOUND_STATUS_PRESET } = require('../services/integrations/adapters/autoPlayMappings');
const fs = require('fs');
const path = require('path');
const leadMappingService = require('../services/integrations/leadMappingService');
const pathPolicy = require('../services/integrations/pathPolicyService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { classifyDealerError } = require('../services/integrations/dealerErrorClassifier');
const { setupOutbound } = require('./helpers/outboundHarness');

const app = {};

function integration(overrides = {}) {
  return {
    ROWID: '3001', dealer_code: 'AP001', crm_type: 'AUTOPLAY', base_url: 'https://8.8.8.8',
    create_lead_endpoint: '/api/v1/leads', autoplay_dealer_id: '2220', autoplay_yard_id: '10520',
    autoplay_source_id: '2685', autoplay_campaign_id: '17188', ...overrides,
  };
}

function withCredentials(t, { id = 'client-123', secret = 'secret-xyz' } = {}) {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _rowId, type) => {
    if (type === 'AUTOPLAY_CLIENT_ID') return id;
    if (type === 'AUTOPLAY_CLIENT_SECRET') return secret;
    return null;
  });
}

function httpError(status, data, headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers };
  return err;
}

/** Token endpoint + API mocks; the rate budget is tested on its own below. */
function mockHttp(t, { token = () => ({ status: 200, data: { access_token: 'tok-1', expires_in: 3600 } }), api = () => ({ status: 200, data: { leadId: 98765 } }) } = {}) {
  autoPlayAdapter._resetForTests();
  t.mock.method(autoPlayRateBudget, 'takeSlot', async () => {});
  t.mock.method(autoPlayRateBudget, 'recordRateLimited', async () => {});
  const tokenCalls = [];
  const apiCalls = [];
  t.mock.method(axios, 'post', async (url, body, config) => {
    tokenCalls.push({ url, body, config });
    return token(tokenCalls.length);
  });
  t.mock.method(axios, 'request', async (config) => {
    apiCalls.push(config);
    return api(config, apiCalls.length);
  });
  return { tokenCalls, apiCalls };
}

// ------------------------------------------------------------ factory / rules

test('factory resolves AUTOPLAY to its adapter; no read support yet', () => {
  assert.equal(crmAdapterFactory.getAdapter('AUTOPLAY'), autoPlayAdapter);
  assert.equal(crmAdapterFactory.supports('AUTOPLAY', 'createLead'), true);
  assert.equal(crmAdapterFactory.supports('AUTOPLAY', 'getLead'), false);
});

test('every MG status is MG-only for AutoPlay (AutoPlay owns lead progress)', () => {
  for (const status of ['Not Contacted', 'Contacted', 'Lost Lead']) {
    assert.equal(pathPolicy.isMgOnlyStatusFor(status, 'AUTOPLAY'), true, status);
  }
});

test('the default AutoPlay map covers every mandatory MG field', () => {
  const sources = FIELD_PRESET.map((row) => row.source_field);
  assert.deepEqual(leadMappingService.missingDeliveryMappingFields(sources, 'AUTOPLAY'), []);
});

// The 13 progress stages AutoPlay returned for dealer 2220 (lookups, 26 Nov 2026).
const AUTOPLAY_STAGES = ['Awaiting Action', 'Email Sent', 'Phone Call Made', 'Meet & Qualify', 'Test Drive',
  'Trade In Valuation/Appraisal', 'Present Deal', 'Finance', 'Sold', 'Delivered', 'Follow Up/Referral',
  'Closed - Won', 'Closed - Lost'];
const MG_LEAD_STATUSES = ['Not Contacted', 'Attempted to Contact', 'Contacted', 'Finance Intro', 'Follow-up 1', 'Lost Lead'];

test('the default status map covers every AutoPlay stage once, onto real, dealer-settable MG statuses', () => {
  assert.deepEqual(INBOUND_STATUS_PRESET.map((row) => row.dealer_status), AUTOPLAY_STAGES);
  for (const { dealer_status, mg_status } of INBOUND_STATUS_PRESET) {
    assert.ok(MG_LEAD_STATUSES.includes(mg_status), `${dealer_status} -> ${mg_status}`);
    assert.equal(pathPolicy.isOemOnlyStatus(mg_status), false, mg_status);
  }
  assert.equal(INBOUND_STATUS_PRESET.find((row) => row.dealer_status === 'Closed - Lost').mg_status, 'Lost Lead');
  assert.equal(INBOUND_STATUS_PRESET.find((row) => row.dealer_status === 'Awaiting Action').mg_status, 'Not Contacted');
});

test('the Dealer CRM page default maps mirror the backend presets (field rows and inbound-only status rows)', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../../../mg-motor-web/src/pages/Dealers/DealerCRMConfig.jsx'), 'utf8');
  const statusBlock = ui.slice(ui.indexOf('const AUTOPLAY_DEFAULT_STATUS_MAPPINGS'), ui.indexOf('const AUTOPLAY_BASE_URL'));
  const uiStatus = [...statusBlock.matchAll(/source_status: "([^"]+)", target_status: "([^"]+)", inbound_only: true/g)]
    .map(([, mg, dealer]) => ({ dealer_status: dealer, mg_status: mg }));
  assert.deepEqual(uiStatus, INBOUND_STATUS_PRESET.map(({ dealer_status, mg_status }) => ({ dealer_status, mg_status })));
  const fieldBlock = ui.slice(ui.indexOf('const AUTOPLAY_DEFAULT_FIELD_MAPPINGS'), ui.indexOf('const AUTOPLAY_DEFAULT_STATUS_MAPPINGS'));
  const uiFields = [...fieldBlock.matchAll(/source_field: "([^"]+)", target_field: "([^"]+)"/g)].map(([, s, t]) => `${s}->${t}`);
  assert.deepEqual(uiFields, FIELD_PRESET.map((row) => `${row.source_field}->${row.target_field}`));
});

test('only Test Drive enquiries have an AutoPlay campaign', () => {
  assert.equal(campaignFor({ nature_of_enquiry: 'Test Drive' }), 'TEST_DRIVE');
  assert.equal(campaignFor({ nature_of_enquiry: ' test  drive ' }), 'TEST_DRIVE');
  for (const other of ['Service Booking', 'General Enquiry', 'Get in Touch', '', null]) {
    assert.equal(campaignFor({ nature_of_enquiry: other }), null, String(other));
  }
});

test('payload rules: uniqueIdentifier is MG lead id, origin Api, explicit optIn, no status or raw enquiry text', () => {
  const mapped = {
    'contact.firstName': 'Jane', 'contact.email': 'jane@example.com', campaignId: 'Test Drive',
    'contact.optIn': 'Yes', privacyPolicyAccepted: 'true', 'vehicle.model': 'MG4', status: 'Open', comments: '  ',
  };
  const out = applyAutoPlayPayloadRules(mapped, { crm_record_id: '44707000061114729', nature_of_enquiry: 'Test Drive' }, FIELD_PRESET);
  assert.deepEqual(out, {
    'contact.firstName': 'Jane', 'contact.email': 'jane@example.com', 'contact.optIn': true,
    privacyPolicyAccepted: true, 'vehicle.model': 'MG4', 'vehicle.make': 'MG',
    uniqueIdentifier: '44707000061114729', origin: 'Api',
  });
});

test('payload rules: unreadable or missing marketing consent is sent as optIn false, never left out', () => {
  for (const value of [undefined, null, '', 'maybe', false, 'No']) {
    const out = applyAutoPlayPayloadRules({ 'contact.optIn': value }, { crm_record_id: 'Z1', receive_marketing_updates: value }, FIELD_PRESET);
    assert.equal(out['contact.optIn'], false, String(value));
  }
  const fromLead = applyAutoPlayPayloadRules({}, { crm_record_id: 'Z1', receive_marketing_updates: true }, []);
  assert.equal(fromLead['contact.optIn'], true);
});

test('update body keeps only what PATCH takes', () => {
  assert.deepEqual(
    toUpdateBody({ contact: { email: 'a@b.c' }, comments: 'x', uniqueIdentifier: 'Z1', origin: 'Api', dealerId: 1, privacyPolicyAccepted: true }),
    { contact: { email: 'a@b.c' }, comments: 'x', privacyPolicyAccepted: true }
  );
});

// ------------------------------------------------------------------- adapter

test('createLead: token by client credentials (form body), then POST /api/v1/leads with the dealer ids and nested contact', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  const result = await autoPlayAdapter.createLead(app, integration(), {
    'contact.firstName': 'Jane', 'contact.optIn': false, uniqueIdentifier: 'ZL1', origin: 'Api',
  });

  assert.equal(result.externalLeadId, '98765');
  assert.equal(http.tokenCalls.length, 1);
  assert.equal(http.tokenCalls[0].url, 'https://8.8.8.8/connect/token');
  const form = new URLSearchParams(http.tokenCalls[0].body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'client-123');
  assert.equal(form.get('client_secret'), 'secret-xyz');
  assert.equal(form.get('scope'), 'lead:write');

  const call = http.apiCalls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://8.8.8.8/api/v1/leads');
  assert.equal(call.headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(JSON.parse(call.data), {
    contact: { firstName: 'Jane', optIn: false }, uniqueIdentifier: 'ZL1', origin: 'Api',
    dealerId: 2220, yardId: 10520, sourceId: 2685, campaignId: 17188,
  });
});

test('the token is reused until it nears expiry', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  await autoPlayAdapter.createLead(app, integration(), { origin: 'Api' });
  await autoPlayAdapter.createLead(app, integration(), { origin: 'Api' });
  assert.equal(http.tokenCalls.length, 1);
  assert.equal(http.apiCalls.length, 2);
});

test('a 401 drops the token and retries once with a new one', async (t) => {
  withCredentials(t);
  const http = mockHttp(t, {
    token: (n) => ({ status: 200, data: { access_token: `tok-${n}`, expires_in: 3600 } }),
    api: (config, n) => { if (n === 1) throw httpError(401, {}); return { status: 200, data: { leadId: 5 } }; },
  });
  const result = await autoPlayAdapter.createLead(app, integration(), { origin: 'Api' });
  assert.equal(result.externalLeadId, '5');
  assert.equal(http.tokenCalls.length, 2);
  assert.equal(http.apiCalls[1].headers.Authorization, 'Bearer tok-2');
});

test('missing dealer or campaign id is a configuration error and nothing is sent', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  await assert.rejects(() => autoPlayAdapter.createLead(app, integration({ autoplay_dealer_id: '' }), {}), (err) => err.code === 'INVALID_CRM_CONFIGURATION');
  await assert.rejects(() => autoPlayAdapter.createLead(app, integration({ autoplay_campaign_id: null }), {}), (err) => err.code === 'INVALID_CRM_CONFIGURATION');
  assert.equal(http.apiCalls.length, 0);
});

test('missing credentials fail as AUTHENTICATION_FAILED without calling AutoPlay', async (t) => {
  withCredentials(t, { secret: null });
  const http = mockHttp(t);
  await assert.rejects(() => autoPlayAdapter.createLead(app, integration(), {}), (err) => err.code === 'AUTHENTICATION_FAILED');
  assert.equal(http.tokenCalls.length, 0);
});

test('a 422 ProblemDetails is a permanent mapping error carrying only the title/detail', async (t) => {
  withCredentials(t);
  mockHttp(t, { api: () => { throw httpError(422, { title: 'Validation failed', detail: 'Campaign is required for this source' }); } });
  await assert.rejects(() => autoPlayAdapter.createLead(app, integration(), { 'contact.email': 'secret@example.com' }), (err) => {
    assert.equal(err.code, 'FIELD_MAPPING_INVALID');
    assert.match(err.message, /HTTP 422: Validation failed: Campaign is required/);
    assert.doesNotMatch(err.message, /secret@example.com/);
    assert.equal(classifyDealerError(err), 'PERMANENT');
    return true;
  });
});

test('a 429 records the cool-down and stays retryable', async (t) => {
  withCredentials(t);
  mockHttp(t, { api: () => { throw httpError(429, {}, { 'retry-after': '30' }); } });
  await assert.rejects(() => autoPlayAdapter.createLead(app, integration(), {}), (err) => {
    assert.equal(classifyDealerError(err), 'TRANSIENT');
    assert.equal(err.vendor.retryAfter, 30);
    return true;
  });
  assert.equal(autoPlayRateBudget.recordRateLimited.mock.calls.length, 1);
  assert.equal(autoPlayRateBudget.recordRateLimited.mock.calls[0].arguments[2], 30);
});

test('updateLead: PATCH /api/v1/leads/{id} with only the patchable fields', async (t) => {
  withCredentials(t);
  const http = mockHttp(t, { api: () => ({ status: 200, data: { leadId: 98765 } }) });
  await autoPlayAdapter.updateLead(app, integration(), '98765', {
    'contact.email': 'new@example.com', comments: 'Call after 5', uniqueIdentifier: 'ZL1', origin: 'Api', integrationRef: 'ENQ-1',
  });
  const call = http.apiCalls[0];
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, 'https://8.8.8.8/api/v1/leads/98765');
  assert.deepEqual(JSON.parse(call.data), { contact: { email: 'new@example.com' }, comments: 'Call after 5' });
});

test('updateLead with nothing patchable sends nothing', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  const result = await autoPlayAdapter.updateLead(app, integration(), '98765', { uniqueIdentifier: 'ZL1' });
  assert.equal(result.skipped, true);
  assert.equal(http.tokenCalls.length + http.apiCalls.length, 0);
});

test('testConnection: a token from AutoPlay is a pass', async (t) => {
  withCredentials(t);
  mockHttp(t);
  assert.equal((await autoPlayAdapter.testConnection(app, integration())).ok, true);
});

test('testConnection: rejected credentials report AutoPlay\'s status', async (t) => {
  withCredentials(t);
  mockHttp(t, { token: () => { throw httpError(400, { error: 'invalid_client' }); } });
  const failed = await autoPlayAdapter.testConnection(app, integration());
  assert.deepEqual([failed.ok, failed.httpStatus], [false, 400]);
});

// --------------------------------------------------------------- rate budget

test('rate budget: 1 per second waits; 9 per minute then refuses with a retry time', async () => {
  let now = 1_800_000_000_000; // start of a minute
  const sleeps = [];
  autoPlayRateBudget._resetForTests({ sleepFn: async (ms) => { sleeps.push(ms); now += ms; } });
  const owner = { ROWID: '777' };
  for (let i = 0; i < 9; i += 1) await autoPlayRateBudget.takeSlot({}, owner, () => now);
  assert.equal(sleeps.length, 8, 'each request after the first waited for the next second');
  await assert.rejects(() => autoPlayRateBudget.takeSlot({}, owner, () => now), (err) => {
    assert.equal(err.code, 'AUTOPLAY_RATE_BUDGET_EXHAUSTED');
    assert.ok(err.vendor.retryAfter > 0 && err.vendor.retryAfter <= 60);
    assert.equal(classifyDealerError(err), 'LOCAL');
    return true;
  });
  autoPlayRateBudget._resetForTests();
});

test('rate budget: after a 429 nothing is sent until the cool-down ends', async () => {
  autoPlayRateBudget._resetForTests();
  const owner = { ROWID: '778' };
  const now = Date.now();
  await autoPlayRateBudget.recordRateLimited({}, owner, 20, now);
  await assert.rejects(() => autoPlayRateBudget.takeSlot({}, owner, () => now + 1000), (err) => err.code === 'AUTOPLAY_COOLDOWN');
  await autoPlayRateBudget.takeSlot({}, owner, () => now + 21000);
  autoPlayRateBudget._resetForTests();
});

// ------------------------------------------------------------ end to end sync

function autoPlayHarness(t, { lead = {}, integrationOverrides = {} } = {}) {
  const harness = setupOutbound(t, {
    integration: {
      crm_type: 'AUTOPLAY', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads',
      autoplay_dealer_id: '2220', autoplay_yard_id: '10520', autoplay_source_id: '2685', autoplay_campaign_id: '17188',
      ...integrationOverrides,
    },
    mapping: null,
    lead: { crm_record_id: 'ZL1', receive_marketing_updates: true, ...lead },
  });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET.map((row) => ({ integration_id: '1000', ...row })));
  harness.db.tables.integration_status_mappings.splice(0, Infinity);
  return harness;
}

test('a Test Drive lead is created in AutoPlay and its leadId stored', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  const harness = autoPlayHarness(t);
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.equal(http.apiCalls.length, 1);
  const body = JSON.parse(http.apiCalls[0].data);
  assert.equal(body.uniqueIdentifier, 'ZL1');
  assert.equal(body.origin, 'Api');
  assert.deepEqual([body.dealerId, body.yardId, body.sourceId, body.campaignId], [2220, 10520, 2685, 17188]);
  assert.equal(body.contact.optIn, true);
  assert.equal(body.contact.email, 'jane@example.com');
  assert.equal(body.privacyPolicyAccepted, true);
  assert.equal(body.integrationRef, 'ENQ-1');
  assert.equal(Object.hasOwn(body, 'status'), false);
  assert.equal(Object.hasOwn(body, 'progressName'), false, 'MG never sends a progress/status');
  assert.equal(Object.hasOwn(body, 'campaign'), false);

  const mapping = harness.db.tables.lead_integrations.find((row) => !row.__deleted);
  assert.equal(mapping.external_crm_lead_id, '98765');
});

test('a non Test Drive lead is not sent to AutoPlay (no campaign yet)', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  const harness = autoPlayHarness(t, { lead: { nature_of_enquiry: 'Service Booking' } });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.deepEqual(result, { skipped: true, reason: 'AUTOPLAY_NO_CAMPAIGN' });
  assert.equal(http.apiCalls.length + http.tokenCalls.length, 0);
});

test('a dealer with no AutoPlay dealer id is held as an incomplete configuration, nothing sent', async (t) => {
  withCredentials(t);
  const http = mockHttp(t);
  const harness = autoPlayHarness(t, { integrationOverrides: { autoplay_dealer_id: '' } });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()).catch(() => {});
  assert.equal(http.apiCalls.length, 0);
});
