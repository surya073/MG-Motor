'use strict';

process.env.PUBLIC_FUNCTION_BASE_URL = 'https://functions.test.example/server/mg_motors_au_function';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Regression (24 Nov 2026): new channel ids were Date.now(), so dealers
// registered in the same millisecond (the cron renews six at a time) got the
// same id. webhook_channels.channel_id is UNIQUE, so only the first dealer's
// channel was recorded. Ids are now unique per process and skip any id
// already recorded locally.

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const { baseIntegration, mockCredentialSnapshot } = require('./helpers/dealerZohoFixture');
const { installZohoWatchFake, buildWatchCatalystApp } = require('./helpers/zohoWatchFake');
const zohoAuthService = require('../services/zohoAuthService');
const zohoWebhookService = require('../services/zohoWebhookService');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');

const FROZEN = 1795491872132;
const OEM_URL = 'https://functions.test.example/server/mg_motors_au_function/webhooks/crm-notify';
const dealerRow = (n) => ({
  ...baseIntegration, ROWID: String(n), dealer_code: `AU${n}`,
  integration_type: 'EXTERNAL_CRM', status: 'ACTIVE', inbound_enabled: true,
});
const dealer = dealerRow;
// getRow answers for every dealer ROWID a test uses.
const appFor = (options = {}) => buildWatchCatalystApp({
  ...options,
  integrations: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i), dealerRow(i)])),
});

test.beforeEach((t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockCredentialSnapshot(t);
  resetSweepGuard();
  zohoAuthService._resetForTests();
  zohoWebhookService._test.resetChannelIdsForTests();
});

test('ten dealers registering concurrently in the same millisecond each get their own channel id and row', async (t) => {
  t.mock.method(Date, 'now', () => FROZEN);
  const fake = installZohoWatchFake(t, { delayMs: 5 });
  const app = appFor();
  const dealers = Array.from({ length: 10 }, (_, i) => dealer(800 + i));

  const results = await Promise.all(dealers.map((d) => zohoWebhookService.registerDealerWatchChannel(app, d)));

  const ids = results.map((r) => r.channelId);
  assert.equal(new Set(ids).size, 10, `duplicate channel ids: ${ids.join(',')}`);
  results.forEach((r) => { assert.equal(r.mode, 'created'); assert.equal(r.verified, true); });

  const rows = app.channelRows();
  assert.equal(rows.length, 10, 'every dealer channel is persisted');
  for (const [i, d] of dealers.entries()) {
    const row = rows.find((r) => r.dealer_code === d.dealer_code);
    assert.ok(row, `row for ${d.dealer_code}`);
    assert.equal(row.channel_id, results[i].channelId);
    assert.equal(row.integration_id, d.ROWID);
    assert.equal(row.module_name, 'Leads');
    assert.equal(row.notify_url, `https://functions.test.example/server/mg_motors_au_function/webhooks/dealers/${d.dealer_code}`);
  }
  // The id recorded is exactly the id Zoho holds for that dealer's notify URL.
  for (const row of rows) {
    const zoho = fake.channels.find((c) => String(c.channel_id) === row.channel_id);
    assert.equal(zoho.notify_url, row.notify_url);
  }
});

test('OEM and dealers registering concurrently stay isolated: distinct ids, OEM row has no dealer fields', async (t) => {
  t.mock.method(Date, 'now', () => FROZEN);
  installZohoWatchFake(t, { delayMs: 5 });
  const app = appFor();
  const dealers = [dealer(901), dealer(902), dealer(903)];

  const [oem, ...dealerResults] = await Promise.all([
    zohoWebhookService.registerWatchChannels(app),
    ...dealers.map((d) => zohoWebhookService.registerDealerWatchChannel(app, d)),
  ]);

  const ids = [oem.channelId, ...dealerResults.map((r) => r.channelId)];
  assert.equal(new Set(ids).size, 4);
  const rows = app.channelRows();
  assert.equal(rows.length, 4);
  const oemRow = rows.find((r) => r.channel_id === oem.channelId);
  assert.equal(oemRow.module_name, 'Dealers,Leads');
  assert.equal(oemRow.dealer_code, undefined);
  assert.equal(oemRow.notify_url, OEM_URL);
  dealers.forEach((d, i) => {
    const row = rows.find((r) => r.channel_id === dealerResults[i].channelId);
    assert.equal(row.dealer_code, d.dealer_code);
  });
});

test('an id already recorded locally (e.g. by another instance) is skipped', async (t) => {
  t.mock.method(Date, 'now', () => FROZEN);
  installZohoWatchFake(t);
  const app = appFor({ existingRows: [
    { channel_id: String(FROZEN), module_name: 'Leads', dealer_code: 'AU999', expires_at: '2026-11-25 00:00:00' },
    { channel_id: String(FROZEN + 1), module_name: 'Leads', dealer_code: 'AU998', expires_at: '2026-11-25 00:00:00' },
  ] });

  const result = await zohoWebhookService.registerDealerWatchChannel(app, dealer(810));
  assert.equal(result.channelId, String(FROZEN + 2));
  const rows = app.channelRows();
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.dealer_code === 'AU999').expires_at, '2026-11-25 00:00:00', 'other dealer row untouched');
});

test('renewal keeps the channel id Zoho already holds; no new id is generated', async (t) => {
  const dealerUrl = 'https://functions.test.example/server/mg_motors_au_function/webhooks/dealers/AU820';
  const fake = installZohoWatchFake(t, { channels: [{
    origin: 'https://www.zohoapis.in', channel_id: '1700000000000', notify_url: dealerUrl, events: ['Leads.edit'], channel_expiry: new Date(Date.now() + 3600000).toISOString(),
  }] });
  const app = appFor();
  const result = await zohoWebhookService.registerDealerWatchChannel(app, dealer(820));
  assert.equal(result.mode, 'renewed');
  assert.equal(result.channelId, '1700000000000');
  assert.deepEqual(fake.writes().map((c) => c.method), ['PATCH']);
  assert.equal(app.channelRows()[0].channel_id, '1700000000000');
});

test('allocation: ids are strictly increasing within a process even with a frozen or backward clock', async () => {
  const { nextChannelId, allocateChannelId } = zohoWebhookService._test;
  assert.equal(nextChannelId(1000), 1000);
  assert.equal(nextChannelId(1000), 1001);
  assert.equal(nextChannelId(900), 1002, 'a clock step backwards never reissues an id');
  assert.equal(nextChannelId(5000), 5000);
  const parallel = await Promise.all(Array.from({ length: 50 }, () => allocateChannelId(async () => false)));
  assert.equal(new Set(parallel).size, 50);
});

test('allocation: an unreadable local table does not block registration; persistent conflicts give up', async () => {
  const { allocateChannelId } = zohoWebhookService._test;
  const id = await allocateChannelId(async () => { throw new Error('ZCQL down'); });
  assert.ok(Number.isSafeInteger(id));
  await assert.rejects(() => allocateChannelId(async () => true), /Could not allocate an unused channel id/);
});
