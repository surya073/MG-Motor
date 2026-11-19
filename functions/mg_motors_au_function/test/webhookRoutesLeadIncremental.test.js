'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = 'route-test-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const axios = require('axios');
const catalyst = require('zcatalyst-sdk-node');
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

// Wiring test for POST /webhooks/crm-notify: a Leads notification that names
// record ids must fetch only those ids; one without ids must use the
// modified-since sweep. Neither may fall back to a full OEM lead scan.

function fakeCatalystApp() {
  return {
    zcql: () => ({ executeZCQLQuery: async () => [] }),
    datastore: () => ({
      table: () => ({
        insertRow: async (f) => ({ ROWID: 'r1', ...f }),
        updateRow: async (f) => f,
        deleteRow: async () => {},
      }),
    }),
  };
}

async function post(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/crm-notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function startServer() {
  const webhookRoutes = require('../routes/webhookRoutes');
  const app = express();
  app.use(webhookRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Leads notification with ids fetches only those ids; without ids uses the modified-since sweep', async (t) => {
  zohoAuthService._resetForTests();
  t.mock.method(catalyst, 'initialize', () => fakeCatalystApp());
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  const gets = [];
  t.mock.method(axios, 'get', async (url, config) => {
    gets.push(config);
    return { data: { data: [], info: { more_records: false } } };
  });

  const server = await startServer();
  t.after(() => server.close());

  const withIds = await post(server, { token: 'route-test-token', module: 'Leads', ids: ['111', '222'], operation: 'update' });
  assert.equal(withIds.status, 200);
  assert.equal(gets.length, 1);
  assert.equal(gets[0].params.ids, '111,222');
  assert.equal(gets[0].params.page, undefined);

  const withoutIds = await post(server, { token: 'route-test-token', module: 'Leads' });
  assert.equal(withoutIds.status, 200);
  assert.equal(gets.length, 2);
  assert.ok(gets[1].headers['If-Modified-Since'], 'falls back to the modified-since sweep, not a full fetch');
  assert.equal(gets[1].params.ids, undefined);
});

test('a webhook with a wrong token is rejected before any sync work', async (t) => {
  t.mock.method(catalyst, 'initialize', () => fakeCatalystApp());
  const gets = [];
  t.mock.method(axios, 'get', async (url, config) => { gets.push(config); return { data: { data: [] } }; });

  const server = await startServer();
  t.after(() => server.close());

  const response = await post(server, { token: 'wrong', module: 'Leads', ids: ['111'] });
  assert.equal(response.status, 401);
  assert.equal(gets.length, 0);
});

// OEM review 4.5: an authenticated notification's outcome is reported apart
// from receipt, with the failed record ids, in one structured log line that
// carries no token or customer data.
test('crm-notify reports processed / unchanged / partial / failed separately, with failed ids, in a structured log line', async (t) => {
  const leadSyncService = require('../services/leadSyncService');
  const logger = require('../utils/logger');
  t.mock.method(catalyst, 'initialize', () => fakeCatalystApp());
  const lines = [];
  t.mock.method(logger, 'info', (ctx, msg) => lines.push(String(msg)));
  t.mock.method(logger, 'error', (ctx, msg) => lines.push(String(msg)));
  const results = [
    { status: 'Success', recordsInserted: 0, recordsUpdated: 2, recordsFailed: 0, errors: [] },
    { status: 'Success', recordsInserted: 0, recordsUpdated: 0, recordsFailed: 0, recordsUnchanged: 1, errors: [] },
    { status: 'Partial', recordsInserted: 1, recordsUpdated: 0, recordsFailed: 1, errors: [{ crm_record_id: '222', error: 'x' }] },
    { status: 'Failed', recordsInserted: 0, recordsUpdated: 0, recordsFailed: 2, errors: [{ crm_record_id: '111', error: 'x' }, { crm_record_id: '222', error: 'y' }] },
  ];
  t.mock.method(leadSyncService, 'syncLeadsByIds', async () => results.shift());

  // The route captured syncLeadsByIds at require time; load a fresh copy that sees the mock.
  delete require.cache[require.resolve('../routes/webhookRoutes')];
  const server = await startServer();
  t.after(() => { server.close(); delete require.cache[require.resolve('../routes/webhookRoutes')]; });

  const send = () => post(server, { token: 'route-test-token', module: 'Leads', ids: ['111', '222'], operation: 'update', channel_id: 1795050009311 });
  const processed = await send();
  const unchanged = await send();
  const partial = await send();
  const failed = await send();

  assert.deepEqual([processed, unchanged, partial, failed].map((r) => [r.status, r.json.outcome]),
    [[200, 'processed'], [200, 'unchanged'], [200, 'partial'], [200, 'failed']]);
  assert.deepEqual(partial.json.failedIds, ['222']);
  assert.deepEqual(failed.json.failedIds, ['111', '222']);

  const structured = lines.filter((l) => l.startsWith('{"event":"crm_notify"')).map((l) => JSON.parse(l));
  assert.equal(structured.length, 4);
  assert.deepEqual(structured.map((l) => l.outcome), ['processed', 'unchanged', 'partial', 'failed']);
  for (const line of structured) {
    assert.equal(line.channelId, '1795050009311');
    assert.equal(line.module, 'Leads');
    assert.equal(line.operation, 'update');
    assert.equal(line.records, 2);
    assert.ok('cid' in line && 'project' in line && 'environment' in line);
  }
  assert.deepEqual(structured[3].failedIds, ['111', '222']);
  assert.ok(lines.every((l) => !l.includes('route-test-token')), 'the token is never logged');
});

test('crm-notify: a rejected token and an unhandled module are logged as such; a coalesced Dealers sync is deferred (202)', async (t) => {
  const dealerSyncService = require('../services/dealerSyncService');
  const logger = require('../utils/logger');
  t.mock.method(catalyst, 'initialize', () => fakeCatalystApp());
  const lines = [];
  t.mock.method(logger, 'info', (ctx, msg) => lines.push(String(msg)));
  t.mock.method(logger, 'error', (ctx, msg) => lines.push(String(msg)));
  t.mock.method(dealerSyncService, 'syncDealersCoalesced', async () => ({ skipped: true, reason: 'OPERATION_ALREADY_RUNNING', pending: true }));
  delete require.cache[require.resolve('../routes/webhookRoutes')];
  const server = await startServer();
  t.after(() => { server.close(); delete require.cache[require.resolve('../routes/webhookRoutes')]; });

  const rejected = await post(server, { token: 'wrong', module: 'Leads', channel_id: 5 });
  const ignored = await post(server, { token: 'route-test-token', module: 'Contacts' });
  const deferred = await post(server, { token: 'route-test-token', module: 'Dealers' });

  assert.equal(rejected.status, 401);
  assert.equal(ignored.status, 202);
  assert.equal(ignored.json.outcome, 'ignored');
  assert.equal(deferred.status, 202);
  assert.equal(deferred.json.outcome, 'deferred');
  const outcomes = lines.filter((l) => l.startsWith('{"event":"crm_notify"')).map((l) => JSON.parse(l).outcome);
  assert.deepEqual(outcomes, ['rejected', 'ignored', 'deferred']);
  assert.ok(lines.every((l) => !l.includes('"wrong"') && !l.includes('route-test-token')));
});
