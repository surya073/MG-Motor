'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const { sendTestLead } = require('../services/integrations/testLeadService');
const { FIELD_PRESET } = require('../services/integrations/adapters/dealerStudioMappings');
const { setupOutbound } = require('./helpers/outboundHarness');

function dealerStudioHarness(t) {
  const harness = setupOutbound(t, {
    integration: { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads' },
    mapping: null,
  });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET.map((row) => ({ integration_id: '1000', ...row })));
  return harness;
}

test('sends one FI Digital test lead through the dealer adapter and writes nothing but a TEST_LEAD log', async (t) => {
  const harness = dealerStudioHarness(t);
  const sent = [];
  const adapter = crmAdapterFactory.getAdapter('DEALER_STUDIO');
  t.mock.method(adapter, 'createLead', async (_app, integration, payload) => {
    sent.push({ integration, payload });
    return { externalLeadId: '555', httpStatus: 201 };
  });
  const leadsBefore = harness.db.tables.leads.length;

  const result = await sendTestLead(harness.db.app, 'AU999');

  assert.equal(result.ok, true);
  assert.equal(result.externalLeadId, '555');
  assert.match(result.reference, /^FIDTEST-AU999-\d+$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.first_name, 'FI Digital');
  assert.match(sent[0].payload.message, /FI DIGITAL TEST LEAD ONLY/);
  assert.equal(sent[0].payload.category, 'Test Drive Booking');
  assert.equal(sent[0].payload.provider_id, result.reference);
  assert.equal(harness.db.tables.leads.length, leadsBefore);
  assert.equal(harness.db.tables.lead_integrations.length, 0);
  assert.deepEqual(harness.oemWrites, []);
  const log = harness.db.tables.integration_logs.find((row) => row.operation === 'TEST_LEAD');
  assert.equal(log.status, 'SUCCESS');
  assert.equal(log.external_lead_id, '555');
});

test('a rejected test lead is reported with the dealer CRM error and logged as FAILED', async (t) => {
  const harness = dealerStudioHarness(t);
  const adapter = crmAdapterFactory.getAdapter('DEALER_STUDIO');
  t.mock.method(adapter, 'createLead', async () => {
    const err = new Error('Dealer Studio rejected the lead create request (HTTP 401: API key not authorised for this dealership)');
    err.code = 'AUTHENTICATION_FAILED';
    err.response = { status: 401 };
    throw err;
  });
  const result = await sendTestLead(harness.db.app, 'AU999');
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 401);
  assert.match(result.error, /not authorised/);
  assert.equal(harness.db.tables.integration_logs.find((row) => row.operation === 'TEST_LEAD').status, 'FAILED');
});

test('a dealer with no field mappings is refused without calling the CRM', async (t) => {
  const harness = dealerStudioHarness(t);
  harness.db.tables.integration_field_mappings.splice(0, Infinity);
  const adapter = crmAdapterFactory.getAdapter('DEALER_STUDIO');
  const create = t.mock.method(adapter, 'createLead', async () => ({}));
  const result = await sendTestLead(harness.db.app, 'AU999');
  assert.equal(result.error, 'NO_FIELD_MAPPINGS');
  assert.equal(create.mock.calls.length, 0);
});

test('each test lead has its own email and mobile, and the name can be set', async (t) => {
  const harness = dealerStudioHarness(t);
  const sent = [];
  const adapter = crmAdapterFactory.getAdapter('DEALER_STUDIO');
  t.mock.method(adapter, 'createLead', async (_app, _integration, payload) => {
    sent.push(payload);
    return { externalLeadId: String(sent.length), httpStatus: 201 };
  });
  await sendTestLead(harness.db.app, 'AU999', { lastName: 'Test Lead 3' });
  await new Promise((r) => setTimeout(r, 5));
  await sendTestLead(harness.db.app, 'AU999');
  assert.equal(sent[0].first_name, 'FI Digital');
  assert.equal(sent[0].last_name, 'Test Lead 3');
  assert.equal(sent[1].last_name, 'Test Lead');
  assert.notEqual(sent[0].email, sent[1].email);
  assert.notEqual(sent[0].mobile, sent[1].mobile);
  assert.match(sent[0].email, /^fidigital\.testlead\+\d{8}@example\.com$/);
  assert.match(sent[0].mobile, /^04\d{8}$/);
});

