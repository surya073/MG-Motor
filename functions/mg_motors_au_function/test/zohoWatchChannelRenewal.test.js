'use strict';

process.env.PUBLIC_FUNCTION_BASE_URL = 'https://functions.test.example/server/mg_motors_au_function';
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// OEM review 19 Nov 2026, 4.1 and 4.6: a watch channel is renewed in place
// (PATCH), never deleted before a working channel is confirmed; only channels
// of this middleware's notify URL are touched; what Zoho reads back is what is
// recorded, with ownership; renewal is driven by remaining lifetime under a
// durable lease; only the owning project writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const { baseIntegration, mockCredentialSnapshot } = require('./helpers/dealerZohoFixture');
const { installZohoWatchFake, buildWatchCatalystApp } = require('./helpers/zohoWatchFake');
const zohoAuthService = require('../services/zohoAuthService');
const zohoWebhookService = require('../services/zohoWebhookService');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const usageContext = require('../services/usageContext');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');

const OEM_ORIGIN = 'https://www.zohoapis.in';
const OEM_URL = 'https://functions.test.example/server/mg_motors_au_function/webhooks/crm-notify';
const TRIAL_URL = 'https://trial.example/server/fn/webhooks/crm-notify';
const later = (hours) => new Date(Date.now() + hours * 3600000).toISOString();

test.beforeEach((t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mockCredentialSnapshot(t);
  resetSweepGuard();
  zohoAuthService._resetForTests();
});

const oemChannel = (id, url = OEM_URL, hours = 5) => ({
  origin: OEM_ORIGIN, channel_id: id, notify_url: url, events: ['Dealers.all', 'Leads.all'], channel_expiry: later(hours),
});

// ------------------------------------------------------------- OEM renewal

test('no existing channel: one is created, read back and recorded with ownership; nothing is deleted', async (t) => {
  const fake = installZohoWatchFake(t);
  const app = buildWatchCatalystApp();
  const result = await usageContext.runWithContext(
    { catalystProject: { projectId: '818000000022001', environment: 'Development' } },
    () => zohoWebhookService.registerWatchChannels(app)
  );

  assert.equal(result.mode, 'created');
  assert.equal(result.verified, true);
  assert.deepEqual(fake.writes().map((c) => c.method), ['POST']);
  assert.equal(fake.channels.length, 1);
  const [row] = app.channelRows();
  assert.equal(row.channel_id, result.channelId);
  assert.equal(row.module_name, 'Dealers,Leads');
  assert.equal(row.notify_url, OEM_URL);
  assert.match(row.events, /Leads\.edit/);
  assert.equal(row.owner_project_id, '818000000022001');
  assert.equal(row.owner_environment, 'Development');
  assert.equal(row.zoho_org_id, '44707000000000001');
});

test('an existing channel of this notify URL is renewed in place: PATCH, same id, no create, no delete', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('1795050009311')] });
  const before = fake.channels[0].channel_expiry;
  const result = await zohoWebhookService.registerWatchChannels(buildWatchCatalystApp());

  assert.equal(result.mode, 'renewed');
  assert.equal(result.channelId, '1795050009311');
  assert.deepEqual(fake.writes().map((c) => c.method), ['PATCH']);
  assert.equal(fake.channels.length, 1);
  assert.notEqual(fake.channels[0].channel_expiry, before);
  const patch = fake.writes()[0].data.watch[0];
  assert.equal(patch.channel_id, 1795050009311);
  assert.deepEqual(patch.events, ['Dealers.all', 'Leads.all']);
  assert.equal(patch.notify_url, OEM_URL);
  assert.ok(patch.token && patch.token !== process.env.ZOHO_WEBHOOK_TOKEN, 'the derived token is sent, never the raw secret');
});

test('when the in-place renewal fails, a new channel is created FIRST and only then is the old one removed', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('111')], fail: { patch: true } });
  const result = await zohoWebhookService.registerWatchChannels(buildWatchCatalystApp());

  assert.equal(result.mode, 'created');
  assert.deepEqual(fake.writes().map((c) => c.method), ['PATCH', 'POST', 'DELETE']);
  assert.equal(fake.writes()[2].params.channel_ids, '111');
  assert.deepEqual(fake.channels.map((c) => c.channel_id), [result.channelId]);
});

test('if creating the replacement also fails, the existing channel is left in place (no gap) and the run fails', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('111')], reject: { patch: true }, fail: { post: true } });
  await assert.rejects(() => zohoWebhookService.registerWatchChannels(buildWatchCatalystApp()), /registration failed/);
  assert.equal(fake.calls.some((c) => c.method === 'DELETE'), false);
  assert.deepEqual(fake.channels.map((c) => c.channel_id), ['111']);
});

test('another project\'s channel (different notify URL) is never renewed or deleted', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('999', TRIAL_URL)] });
  const result = await zohoWebhookService.registerWatchChannels(buildWatchCatalystApp());

  assert.equal(result.mode, 'created');
  assert.deepEqual(fake.writes().map((c) => c.method), ['POST']);
  assert.ok(fake.channels.some((c) => c.channel_id === '999' && c.notify_url === TRIAL_URL));
});

test('duplicate channels of this notify URL are removed after the renewal, keeping the longest-lived one', async (t) => {
  const fake = installZohoWatchFake(t, { channels: [oemChannel('1', OEM_URL, 2), oemChannel('2', OEM_URL, 9), oemChannel('3', OEM_URL, 4)] });
  const result = await zohoWebhookService.registerWatchChannels(buildWatchCatalystApp());

  assert.equal(result.channelId, '2');
  assert.deepEqual(fake.writes().map((c) => c.method), ['PATCH', 'DELETE']);
  assert.deepEqual(fake.writes()[1].params.channel_ids.split(',').sort(), ['1', '3']);
  assert.deepEqual(fake.channels.map((c) => c.channel_id), ['2']);
});

test('an unreadable channel list does not block renewal: a channel is still created', async (t) => {
  const fake = installZohoWatchFake(t, { fail: { list: true } });
  const result = await zohoWebhookService.registerWatchChannels(buildWatchCatalystApp());
  assert.equal(result.mode, 'created');
  assert.equal(fake.channels.length, 1);
});

test('a read-back that differs from the request (events or URL) is reported unverified and recorded as Zoho holds it', async (t) => {
  installZohoWatchFake(t, { channels: [oemChannel('5')], readBackOverride: { events: ['Leads.edit'] } });
  const app = buildWatchCatalystApp();
  const result = await zohoWebhookService.registerWatchChannels(app);
  assert.equal(result.verified, false);
  assert.equal(app.channelRows()[0].events, 'Leads.edit');

  resetSweepGuard();
  installZohoWatchFake(t, { channels: [oemChannel('6')], readBackOverride: { notify_url: TRIAL_URL } });
  const wrongUrl = await zohoWebhookService.registerWatchChannels(buildWatchCatalystApp());
  assert.equal(wrongUrl.verified, false);
});

test('a channel that cannot be read back is unverified; the requested expiry is recorded', async (t) => {
  installZohoWatchFake(t, { fail: { readBack: true } });
  const app = buildWatchCatalystApp();
  const result = await zohoWebhookService.registerWatchChannels(app);
  assert.equal(result.mode, 'created');
  assert.equal(result.verified, false);
  assert.ok(app.channelRows()[0].expires_at);
});

test('the channel stays live when local recording fails: extended columns missing falls back, total failure is logged only', async (t) => {
  installZohoWatchFake(t);
  const partial = buildWatchCatalystApp({ failExtendedInsert: true });
  const result = await zohoWebhookService.registerWatchChannels(partial);
  assert.equal(result.mode, 'created');
  const [row] = partial.channelRows();
  assert.equal(row.channel_id, result.channelId);
  assert.equal('owner_project_id' in row, false);

  resetSweepGuard();
  const none = buildWatchCatalystApp({ failInsert: true });
  const again = await zohoWebhookService.registerWatchChannels(none);
  assert.equal(again.mode, 'renewed', 'the next renewal finds the live channel in Zoho, not a duplicate');
  assert.deepEqual(none.channelRows(), []);
});

test('a renewal already holding the durable lease elsewhere is skipped without any Zoho call', async (t) => {
  const fake = installZohoWatchFake(t);
  const app = buildWatchCatalystApp();
  app.claims.set('operation:oem-watch-renewal', { ROWID: '77', claim_key: 'operation:oem-watch-renewal', claimed_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  const result = await zohoWebhookService.registerWatchChannels(app);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'OPERATION_ALREADY_RUNNING');
  assert.equal(fake.calls.length, 0);
});

// ---------------------------------------------------------- dealer channel

test('dealer channel: renewed in place on the dealer\'s own org; the OEM channel is not touched', async (t) => {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  const integration = { ...baseIntegration, ROWID: '601', dealer_code: 'AU601', integration_type: 'EXTERNAL_CRM', status: 'ACTIVE', inbound_enabled: true };
  const dealerOrigin = new URL(integration.base_url).origin;
  const dealerUrl = 'https://functions.test.example/server/mg_motors_au_function/webhooks/dealers/AU601';
  const fake = installZohoWatchFake(t, { channels: [
    oemChannel('1'),
    { origin: dealerOrigin, channel_id: '50', notify_url: dealerUrl, events: ['Leads.edit'], channel_expiry: later(3) },
  ] });
  const app = buildWatchCatalystApp({ integration });
  const result = await zohoWebhookService.registerDealerWatchChannel(app, integration);

  assert.equal(result.mode, 'renewed');
  assert.equal(result.channelId, '50');
  assert.deepEqual(fake.writes().map((c) => [c.method, c.origin]), [['PATCH', dealerOrigin]]);
  const patch = fake.writes()[0].data.watch[0];
  assert.deepEqual(patch.events, ['Leads.edit']);
  assert.equal(patch.return_affected_field_values, true);
  assert.equal(patch.notify_on_related_action, false);
  const [row] = app.channelRows();
  assert.equal(row.dealer_code, 'AU601');
  assert.equal(row.module_name, 'Leads');
});

// ---------------------------------------------------- lifetime-based renewal

test('fast-recover check: plenty of life left costs one read and no Zoho call', async (t) => {
  const fake = installZohoWatchFake(t);
  const app = buildWatchCatalystApp({ existingRows: [{ channel_id: '1', module_name: 'Dealers,Leads', expires_at: later(20).slice(0, 19).replace('T', ' ') }] });
  const out = await zohoWebhookService.ensureOemWatchChannelFresh(app);
  assert.equal(out.renewed, false);
  assert.ok(out.remainingMinutes > 1000);
  assert.equal(fake.calls.length, 0);
});

test('fast-recover check: a channel running low (or never recorded) is renewed; no alert', async (t) => {
  installZohoWatchFake(t, { channels: [oemChannel('1')] });
  const alerts = [];
  const low = buildWatchCatalystApp({ existingRows: [{ channel_id: '1', module_name: 'Dealers,Leads', expires_at: later(2).slice(0, 19).replace('T', ' ') }] });
  const out = await zohoWebhookService.ensureOemWatchChannelFresh(low, { alert: async (a) => alerts.push(a) });
  assert.equal(out.renewed, true);
  assert.equal(out.result.mode, 'renewed');

  resetSweepGuard();
  const none = await zohoWebhookService.ensureOemWatchChannelFresh(buildWatchCatalystApp(), { alert: async (a) => alerts.push(a) });
  assert.equal(none.renewed, true);
  assert.deepEqual(alerts, []);
});

test('fast-recover check: a failed renewal close to expiry raises an alert; with time left it does not', async (t) => {
  installZohoWatchFake(t, { fail: { post: true, list: true } });
  const alerts = [];
  const nearly = buildWatchCatalystApp({ existingRows: [{ channel_id: '1', module_name: 'Dealers,Leads', expires_at: later(1).slice(0, 19).replace('T', ' ') }] });
  const out = await zohoWebhookService.ensureOemWatchChannelFresh(nearly, { alert: async (a) => alerts.push(a) });
  assert.equal(out.renewed, false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reason, /registration failed/);

  resetSweepGuard();
  const roomy = buildWatchCatalystApp({ existingRows: [{ channel_id: '1', module_name: 'Dealers,Leads', expires_at: later(4).slice(0, 19).replace('T', ' ') }] });
  await zohoWebhookService.ensureOemWatchChannelFresh(roomy, { alert: async (a) => alerts.push(a) });
  assert.equal(alerts.length, 1, 'no alert while more than OEM_WATCH_EXPIRY_ALERT_MINUTES remain');
});

// ------------------------------------------------------------------ helpers

test('read-back grouping merges per-module entries and keeps the earliest expiry', () => {
  const { groupWatchEntries, coversEvents } = zohoWebhookService._test;
  const [channel] = groupWatchEntries([
    { channel_id: '9', notify_url: OEM_URL, events: ['Leads.create', 'Leads.edit', 'Leads.delete'], channel_expiry: '2026-11-20T12:00:09+11:00' },
    { channel_id: '9', notify_url: OEM_URL, events: ['Dealers.create', 'Dealers.edit', 'Dealers.delete'], channel_expiry: '2026-11-20T11:00:00+11:00' },
  ]);
  assert.equal(channel.channelId, '9');
  assert.equal(channel.expiresAt.toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(coversEvents(channel.events, ['Dealers.all', 'Leads.all']), true);
  assert.equal(coversEvents(['Leads.edit'], ['Leads.all']), false);
  assert.equal(coversEvents(['Leads.edit'], ['Leads.edit']), true);
});
