'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// OEM review 19 Nov 2026, 4.3: the event store could not replay every event.
//  - edits were dropped from the stored copy, so an edit-only event replayed as NO_STORED_EVENT;
//  - replay looked only at the newest status event, among the newest 10;
//  - deferred work was acknowledged even when no recovery copy was stored;
//  - the scheduler found held events only through failed integration logs.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, withEnv } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const webhookRoutes = require('../routes/webhookRoutes');

const LEAD_ID = fixtures.FUSION_TEST_LEAD_ID;
const SECRET = generateSigningSecret();
const utc = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
// CREATEDTIME is project time; the tests run with the default project zone, so
// a fixed old stamp is enough wherever only "long ago" matters.
const LONG_AGO = '2026-10-13 09:00:00:000';
// A creation time `minutes` ago, in project time, for events the scheduler should still retry.
const recent = (minutes) => `${require('../utils/projectTime').formatProjectDateTime(Date.now() - minutes * 60000)}:000`;

function fusionStore(t, { mgStatus = 'Contacted', events = [] } = {}) {
  _resetForTests();
  withEnv(t, {
    INBOUND_EVENT_STORE: 'true',
    FUSION_INBOUND_V2: 'true',
    INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'),
  });
  const harness = setupOutbound(t, { lead: { lead_status: mgStatus } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  Object.assign(harness.db.tables.dealer_integrations[0], { inbound_enabled: true, webhook_enabled: true });
  harness.db.tables.webhook_events = events.map(({ status = 'FAILED', created = LONG_AGO, payload, lease, lead = LEAD_ID }) => ({
    integration_id: '1000', dealer_code: 'AU999', processing_status: status, CREATEDTIME: created, MODIFIEDTIME: created,
    external_lead_id: lead, lease_until: lease,
    payload_encrypted: payload === null ? null : integrationAuthService.encrypt(JSON.stringify(payload)),
  }));
  return harness;
}

async function route(t, harness) {
  t.mock.method(catalyst, 'initialize', () => harness.db.app);
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (app, id, type) =>
    (type === 'WEBHOOK_SIGNING_SECRET' ? SECRET : null));
  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  return async (payload) => {
    const signed = signStandardWebhook({ secret: SECRET, body: payload });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...signed.headers }, body: signed.body,
    });
    return { status: response.status, body: await response.json() };
  };
}

const stored = (harness, i = 0) => JSON.parse(integrationAuthService.decrypt(harness.db.tables.webhook_events[i].payload_encrypted));

// ------------------------------------------------------------ what is stored

test('the stored copy keeps the dealer\'s permitted edits at their own paths, versioned, and nothing else', async (t) => {
  const h = fusionStore(t);
  const body = Buffer.from(JSON.stringify({
    lead_id: LEAD_ID, dealer_id: '725001', pushed_at: '2026-11-19T01:00:00Z',
    contact: { firstName: 'Janet', lastName: 'Citizen', areaCode: '3001', email: 'private@example.com' },
    notes: [{ text: 'not kept' }],
  }));
  const recorded = await crmIntegrationService.checkAndRecordWebhookEvent(h.db.app, h.integration, body, 'msg_edit', { externalLeadId: LEAD_ID });
  assert.equal(recorded.replayable, true);
  const copy = stored(h);
  assert.equal(copy._store_version, 2);
  assert.equal(copy.contact.firstName, 'Janet');
  assert.equal(copy.contact.areaCode, '3001');
  assert.equal(copy.contact.email, undefined, 'a field outside FUSION_INBOUND_EDIT_FIELDS is not kept');
  assert.equal(copy.notes, undefined);
});

test('FUSION_INBOUND_EDIT_FIELDS=none: only the status fields are stored, as before', async (t) => {
  const h = fusionStore(t);
  withEnv(t, { FUSION_INBOUND_EDIT_FIELDS: 'none' });
  const body = Buffer.from(JSON.stringify({ lead_id: LEAD_ID, status: 'Lost', contact: { firstName: 'Janet' } }));
  await crmIntegrationService.checkAndRecordWebhookEvent(h.db.app, h.integration, body, 'msg_x', { externalLeadId: LEAD_ID });
  assert.deepEqual(stored(h), { lead_id: LEAD_ID, status: 'Lost', _store_version: 2 });
});

test('an event that could not be stored is reported not replayable; a dealer without the store reports null', async (t) => {
  const h = fusionStore(t);
  t.mock.method(integrationAuthService, 'encrypt', () => { throw new Error('no key'); });
  const recorded = await crmIntegrationService.checkAndRecordWebhookEvent(h.db.app, h.integration, Buffer.from('{"lead_id":"x","status":"Lost"}'), 'msg_y', { externalLeadId: 'x' });
  assert.equal(recorded.replayable, false);

  withEnv(t, { INBOUND_EVENT_STORE: 'false' });
  const plain = await crmIntegrationService.checkAndRecordWebhookEvent(h.db.app, h.integration, Buffer.from('{}'), 'msg_z');
  assert.equal(plain.replayable, null);
});

// --------------------------------------------------------- acknowledgement

test('a held event without a stored recovery copy is not acknowledged: FAILED and 503, so Fusion delivers it again', async (t) => {
  const h = fusionStore(t);
  const deliver = await route(t, h);
  t.mock.method(integrationAuthService, 'encrypt', () => { throw new Error('no key'); });
  const res = await deliver(fixtures.inboundFlatWebhookPayload({ status: 'Sold - Awaiting Finance' }));
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'EVENT_NOT_STORED');
  const event = h.db.tables.webhook_events[0];
  assert.equal(event.processing_status, 'FAILED');
  assert.match(event.error_message, /^NOT_REPLAYABLE:/);
});

test('a held event WITH its stored copy is acknowledged as before (202, PENDING)', async (t) => {
  const h = fusionStore(t);
  const deliver = await route(t, h);
  const res = await deliver(fixtures.inboundFlatWebhookPayload({ status: 'Sold - Awaiting Finance' }));
  assert.equal(res.status, 202);
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'PENDING');
});

// ------------------------------------------------------------------ replay

test('an edit-only stored event is replayed (it used to be NO_STORED_EVENT)', async (t) => {
  const h = fusionStore(t, { events: [{ payload: {
    lead_id: LEAD_ID, pushed_at: '2026-11-19T01:00:00Z', contact: { areaCode: '3999' }, _store_version: 2,
  } }] });
  const result = await crmIntegrationService.replayInboundLeadFromStoredEvent(h.db.app, h.integration, LEAD_ID);
  assert.notEqual(result.reason, 'NO_STORED_EVENT');
  assert.equal(h.db.tables.leads[0].postcode, '3999');
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'SUCCESS');
});

test('unfinished events are applied oldest first by event time; a superseded status is closed without being written', async (t) => {
  const h = fusionStore(t, { mgStatus: 'Follow-up 2', events: [
    // Listed newest-received first on purpose: event time, not receipt, decides.
    { created: '2026-11-19 01:30:00:000', payload: { lead_id: LEAD_ID, status: 'Lost', pushed_at: '2026-11-19T00:30:00Z' } },
    { created: '2026-11-19 01:10:00:000', payload: { lead_id: LEAD_ID, pushed_at: '2026-11-19T00:20:00Z', contact: { areaCode: '3888' } } },
    { created: '2026-11-19 01:00:00:000', payload: { lead_id: LEAD_ID, status: 'Prospect Lost', pushed_at: '2026-11-19T00:10:00Z' } },
  ] });
  await crmIntegrationService.replayInboundLeadFromStoredEvent(h.db.app, h.integration, LEAD_ID);
  assert.deepEqual(h.oemWrites.map((w) => w.fields.Lead_Status).filter(Boolean), ['Lost Lead'],
    'the intermediate Not Qualified is never written');
  assert.equal(h.db.tables.leads[0].postcode, '3888', 'the edit in between is applied');
  const byStatus = Object.fromEntries(h.db.tables.webhook_events.map((e) => [JSON.parse(integrationAuthService.decrypt(e.payload_encrypted)).status || 'edit', e]));
  assert.equal(byStatus['Prospect Lost'].error_message, 'TERMINAL:SUPERSEDED');
  assert.ok(h.db.tables.webhook_events.every((e) => e.processing_status === 'SUCCESS'));
});

test('with every stored event already done, the newest status event is applied, as before', async (t) => {
  const h = fusionStore(t, { mgStatus: 'Follow-up 2', events: [
    { status: 'SUCCESS', created: '2026-11-19 01:00:00:000', payload: { lead_id: LEAD_ID, status: 'Prospect Lost' } },
    { status: 'SUCCESS', created: '2026-11-19 02:00:00:000', payload: { lead_id: LEAD_ID, status: 'Lost' } },
  ] });
  await crmIntegrationService.replayInboundLeadFromStoredEvent(h.db.app, h.integration, LEAD_ID);
  assert.equal(h.oemWrites[0].fields.Lead_Status, 'Lost Lead');
});

// --------------------------------------------------------------- scheduler

test('scheduler: an unfinished stored event with no failed log row is found and replayed', async (t) => {
  const h = fusionStore(t, { events: [{ status: 'PENDING', created: recent(30), payload: { lead_id: LEAD_ID, status: 'Lost', pushed_at: '2026-11-19T00:30:00Z' } }] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(h.db.app);
  assert.equal(results.storedEvents.attempted, 1);
  assert.equal(results.storedEvents.recovered, 1);
  assert.equal(h.db.tables.leads[0].lead_status, 'Lost Lead');
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'SUCCESS');
});

test('scheduler: an event still inside its lease, one already done, and one older than the give-up window are left alone', async (t) => {
  const old = new Date(Date.now() - 8 * 24 * 3600000);
  const oldStamp = `${require('../utils/projectTime').formatProjectDateTime(old.getTime())}:000`;
  const h = fusionStore(t, { events: [
    { status: 'RECEIVED', created: recent(30), lease: utc(+2), payload: { lead_id: LEAD_ID, status: 'Lost' } },
    { status: 'SUCCESS', created: recent(30), payload: { lead_id: 'other', status: 'Lost' }, lead: 'other' },
    { status: 'FAILED', created: oldStamp, payload: { lead_id: 'gone', status: 'Lost' }, lead: 'gone' },
  ] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(h.db.app);
  assert.equal(results.storedEvents.attempted, 0);
  assert.equal(results.storedEvents.abandoned, 1);
  assert.equal(h.oemWrites.length, 0);
});

test('scheduler: an abandoned event (RECEIVED, lease expired) is replayed', async (t) => {
  const h = fusionStore(t, { events: [{ status: 'RECEIVED', created: recent(30), lease: utc(-5), payload: { lead_id: LEAD_ID, status: 'Lost' } }] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(h.db.app);
  assert.equal(results.storedEvents.recovered, 1);
});

test('scheduler: with the event store off there is no stored-event pass', async (t) => {
  const h = fusionStore(t, { events: [{ status: 'PENDING', payload: { lead_id: LEAD_ID, status: 'Lost' } }] });
  withEnv(t, { INBOUND_EVENT_STORE: 'false' });
  const results = await inboundReplayScheduler.runInboundReplaySweep(h.db.app);
  assert.equal(results.storedEvents, undefined);
  assert.equal(h.oemWrites.length, 0);
});
