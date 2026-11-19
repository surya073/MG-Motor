'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// OEM review 19 Nov 2026, 4.2 (reproduced there): a newer Fusion "Prospect
// Lost" set MG to Not Qualified, then an older "Lost" changed it to Lost Lead,
// and both were written to the OEM. An event older than the last one applied
// to the lead is now quarantined. A replayed event also dates the dealer's
// action by its own time, not the processing time.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, withEnv } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const zohoCrmService = require('../services/zohoCrmService');
const webhookRoutes = require('../routes/webhookRoutes');

const SECRET = generateSigningSecret();
const EARLY = '2026-11-18T22:00:00Z';
const LATER = '2026-11-18T23:30:00Z';

async function fusionDealer(t, { mgStatus = 'Follow-up 2' } = {}) {
  withEnv(t, { FUSION_INBOUND_V2: 'true' });
  const harness = setupOutbound(t, { lead: { lead_status: mgStatus } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  harness.db.tables.webhook_events = [];
  Object.assign(harness.db.tables.dealer_integrations[0], { inbound_enabled: true, webhook_enabled: true });
  t.mock.method(catalyst, 'initialize', () => harness.db.app);
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (app, id, type) =>
    (type === 'WEBHOOK_SIGNING_SECRET' ? SECRET : null));

  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const deliver = async (payload) => {
    const signed = signStandardWebhook({ secret: SECRET, body: payload });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...signed.headers }, body: signed.body,
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...harness, deliver, mapping: () => harness.db.tables.lead_integrations[0] };
}

test('the review\'s case: a newer Prospect Lost, then an older Lost arriving late; the older one is not applied', async (t) => {
  const h = await fusionDealer(t);
  const newer = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost', pushed_at: LATER }));
  assert.equal(newer.status, 200);
  assert.deepEqual(h.oemWrites.map((w) => w.fields), [{ Lead_Status: 'Not Qualified' }]);
  assert.equal(h.mapping().last_inbound_event_at, '2026-11-18 23:30:00');

  const older = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: EARLY }));
  assert.equal(older.status, 200, 'answered, so Fusion does not keep redelivering it');
  assert.equal(older.body.result.reason, 'STALE_EVENT');
  assert.equal(h.oemWrites.length, 1, 'nothing written to the OEM for the stale event');
  assert.equal(h.db.tables.leads[0].lead_status, 'Not Qualified');
  assert.equal(h.mapping().last_inbound_event_at, '2026-11-18 23:30:00', 'the marker never moves back');
  const skipped = h.logs().find((log) => log.error_message === 'STALE_EVENT');
  assert.equal(skipped.status, 'SKIPPED');
  assert.match(skipped.field_changes, /2026-11-18T22:00:00/);
  const stored = h.db.tables.webhook_events.at(-1);
  assert.equal(stored.processing_status, 'SUCCESS');
  assert.match(stored.error_message, /TERMINAL:STALE_EVENT/);
});

test('events in order are both applied and the marker follows the newest', async (t) => {
  const h = await fusionDealer(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost', pushed_at: EARLY }));
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: LATER }));
  assert.deepEqual(h.oemWrites.map((w) => w.fields.Lead_Status), ['Not Qualified', 'Lost Lead']);
  assert.equal(h.mapping().last_inbound_event_at, '2026-11-18 23:30:00');
});

test('an event with no readable time is applied as before and leaves the marker alone', async (t) => {
  const h = await fusionDealer(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost', pushed_at: LATER }));
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: 'not a date' }));
  assert.deepEqual(h.oemWrites.map((w) => w.fields.Lead_Status), ['Not Qualified', 'Lost Lead']);
  assert.equal(h.mapping().last_inbound_event_at, '2026-11-18 23:30:00');
});

test('an event dated in the future is not trusted as an ordering key', async (t) => {
  const h = await fusionDealer(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost', pushed_at: '2099-01-01T00:00:00Z' }));
  assert.equal(h.mapping().last_inbound_event_at, undefined);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: EARLY }));
  assert.equal(h.oemWrites.length, 2, 'a bogus future time cannot lock out every later event');
});

test('INBOUND_STALE_EVENT_GUARD=false restores the previous behaviour', async (t) => {
  withEnv(t, { INBOUND_STALE_EVENT_GUARD: 'false' });
  const h = await fusionDealer(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost', pushed_at: LATER }));
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: EARLY }));
  assert.deepEqual(h.oemWrites.map((w) => w.fields.Lead_Status), ['Not Qualified', 'Lost Lead']);
});

test('a replayed event dates the dealer action by its own time, not today', async (t) => {
  const h = await fusionDealer(t, { mgStatus: 'Contacted' });
  t.mock.method(zohoCrmService, 'fetchOemLeadsByIds', async () => [{ id: 'ZL1' }]);
  // 12 Oct 10:00 UTC is 12 Oct 21:00 in Sydney.
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: '2026-10-12T10:00:00Z' }));
  const fields = h.oemWrites[0].fields;
  assert.equal(fields.Lead_Status, 'Lost Lead');
  assert.equal(fields.First_Action_Date, '2026-10-12');
  assert.equal(fields.Sold_Date, '2026-10-12');
});

test('the dealer-action clock is dated by the event but never moves backwards', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const h = await fusionDealer(t, { mgStatus: 'Contacted' });
  h.mapping().last_dealer_action_at = '2026-11-18 23:00:00';
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost', pushed_at: EARLY }));
  assert.equal(h.mapping().last_dealer_action_at, '2026-11-18 23:00:00', 'an older action leaves the clock');
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', pushed_at: LATER }));
  assert.equal(h.mapping().last_dealer_action_at, '2026-11-18 23:30:00', 'a newer one moves it, to the event time');
});
