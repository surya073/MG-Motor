'use strict';

process.env.PUBLIC_FUNCTION_BASE_URL = 'https://functions.test.example/server/mg_motors_au_function';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Regression (24 Nov 2026): an in-place renewal keeps the channel_id, which is
// UNIQUE in webhook_channels. persistChannel used to insert only, so every
// renewal failed with "Duplicate value for channel_id", the stored expiry
// stayed stale, and fast-recover renewed on every run.

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const { installZohoWatchFake, buildWatchCatalystApp } = require('./helpers/zohoWatchFake');
const zohoAuthService = require('../services/zohoAuthService');
const zohoWebhookService = require('../services/zohoWebhookService');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');

const OEM_ORIGIN = 'https://www.zohoapis.in';
const OEM_URL = 'https://functions.test.example/server/mg_motors_au_function/webhooks/crm-notify';
const later = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
const catalystTime = (iso) => iso.slice(0, 19).replace('T', ' ');
const oemChannel = (id, hours = 5) => ({
  origin: OEM_ORIGIN, channel_id: id, notify_url: OEM_URL, events: ['Dealers.all', 'Leads.all'], channel_expiry: later(hours),
});
const staleOemRow = (id) => ({ channel_id: id, module_name: 'Dealers,Leads', expires_at: '2026-11-20 00:00:09', registered_at: '2026-11-19 01:00:09' });

test.beforeEach((t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  resetSweepGuard();
  zohoAuthService._resetForTests();
});

test('renewal with the same channel_id updates the existing row (no insert, no duplicate error)', async (t) => {
  installZohoWatchFake(t, { channels: [oemChannel('1795050009311')] });
  const app = buildWatchCatalystApp({ existingRows: [staleOemRow('1795050009311')] });
  const result = await zohoWebhookService.registerWatchChannels(app);

  assert.equal(result.mode, 'renewed');
  assert.deepEqual(app.channelWrites, { insert: 0, update: 1 });
  const rows = app.channelRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_id, '1795050009311');
  assert.notEqual(rows[0].expires_at, '2026-11-20 00:00:09', 'the new expiry is persisted');
  assert.equal(rows[0].notify_url, OEM_URL);
  assert.match(rows[0].events, /Leads\.edit/);
});

test('registration with a new channel_id inserts a row', async (t) => {
  installZohoWatchFake(t);
  const app = buildWatchCatalystApp({ existingRows: [staleOemRow('111')] });
  const result = await zohoWebhookService.registerWatchChannels(app);

  assert.equal(result.mode, 'created');
  assert.deepEqual(app.channelWrites, { insert: 1, update: 0 });
  assert.deepEqual(app.channelRows().map((r) => r.channel_id), ['111', result.channelId]);
});

test('repeated renewals keep one row and never hit a duplicate error', async (t) => {
  installZohoWatchFake(t, { channels: [oemChannel('42')] });
  const app = buildWatchCatalystApp();
  for (let i = 0; i < 3; i += 1) {
    resetSweepGuard();
    const r = await zohoWebhookService.registerWatchChannels(app);
    assert.equal(r.channelId, '42');
  }
  assert.deepEqual(app.channelWrites, { insert: 1, update: 2 });
  assert.equal(app.channelRows().length, 1);
});

test('the persisted expiry is what Zoho read back', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('7')] });
  const app = buildWatchCatalystApp({ existingRows: [staleOemRow('7')] });
  await zohoWebhookService.registerWatchChannels(app);
  assert.equal(app.channelRows()[0].expires_at, catalystTime(new Date(fake.channels[0].channel_expiry).toISOString()));
});

test('fast-recover: after one renewal of a stale row, the next check does not renew again', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('1795050009311')] });
  const app = buildWatchCatalystApp({ existingRows: [staleOemRow('1795050009311')] });

  const first = await zohoWebhookService.ensureOemWatchChannelFresh(app);
  assert.equal(first.renewed, true);
  const callsAfterFirst = fake.calls.length;

  resetSweepGuard();
  const second = await zohoWebhookService.ensureOemWatchChannelFresh(app);
  assert.equal(second.renewed, false, 'stored expiry is current, so no renewal');
  assert.ok(second.remainingMinutes > 1000);
  assert.equal(fake.calls.length, callsAfterFirst, 'no Zoho call on the second check');
});

test('fast-recover reads the most recently written row (MODIFIEDTIME), not the newest created', async (t) => {
  installZohoWatchFake(t, { channels: [oemChannel('A')] });
  // B was created after A but is no longer in Zoho; renewing A updates A's row.
  const app = buildWatchCatalystApp({ existingRows: [staleOemRow('A'), staleOemRow('B')] });
  await zohoWebhookService.ensureOemWatchChannelFresh(app);
  resetSweepGuard();
  const again = await zohoWebhookService.ensureOemWatchChannelFresh(app);
  assert.equal(again.renewed, false);
});

test('concurrent insert race: a duplicate on insert becomes an update of the row the other instance wrote', async () => {
  const { persistChannel } = zohoWebhookService._test;
  let app;
  app = buildWatchCatalystApp({
    beforeChannelInsert: async (fields) => {
      if (fields.__raced) return;
      // Another instance records the same channel between our lookup and insert.
      await app.datastore().table('webhook_channels').insertRow({ channel_id: '99', module_name: 'Dealers,Leads', expires_at: 'old', __raced: true });
    },
  });
  const ok = await persistChannel(app, { channel_id: '99', module_name: 'Dealers,Leads', expires_at: '2026-11-25 03:35:02' }, {});
  assert.equal(ok, true);
  const rows = app.channelRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expires_at, '2026-11-25 03:35:02');
});

test('a row of the same channel_id from another scope (dealer vs OEM) is never overwritten', async () => {
  const { persistChannel } = zohoWebhookService._test;
  const app = buildWatchCatalystApp({ existingRows: [{ channel_id: '5', module_name: 'Leads', dealer_code: 'AU601', expires_at: 'dealer' }] });
  const ok = await persistChannel(app, { channel_id: '5', module_name: 'Dealers,Leads', expires_at: 'oem' }, {});
  assert.equal(ok, false);
  assert.equal(app.channelRows()[0].expires_at, 'dealer');
  assert.deepEqual(app.channelWrites, { insert: 0, update: 0 });
});

test('extended columns missing on update fall back to the base columns', async () => {
  const { persistChannel } = zohoWebhookService._test;
  const app = buildWatchCatalystApp({ failExtendedInsert: true, existingRows: [staleOemRow('8')] });
  const ok = await persistChannel(app, { channel_id: '8', module_name: 'Dealers,Leads', expires_at: '2026-11-25 03:35:02' }, { owner_project_id: 'p' });
  assert.equal(ok, true);
  assert.equal(app.channelRows()[0].expires_at, '2026-11-25 03:35:02');
  assert.equal('owner_project_id' in app.channelRows()[0], false);
});
