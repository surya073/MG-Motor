'use strict';

// The OEM watch notify URL must come only from PUBLIC_FUNCTION_BASE_URL, and
// only a project with OEM_WATCH_REGISTRATION_ENABLED=true may register it.
// A hardcoded fallback once pointed the MG project's channel at the trial
// project; and the trial and MG projects share one Zoho watch subscription,
// so a second registering project takes it away from the owner.
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com.au';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com.au';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const axios = require('axios');
const zohoAuthService = require('../services/zohoAuthService');
const zohoWebhookService = require('../services/zohoWebhookService');
const { getPublicFunctionBaseUrl } = require('../config/env');
const logger = require('../utils/logger');

const AU_BASE = 'https://mg-motors-au-7007717417.development.catalystserverless.com.au/server/mg_motors_au_function';

function fakeApp() {
  const queries = [];
  const inserted = [];
  return {
    queries,
    inserted,
    zcql: () => ({ executeZCQLQuery: async (sql) => { queries.push(sql); return []; } }),
    datastore: () => ({ table: () => ({ insertRow: async (row) => { inserted.push(row); return row; } }) }),
  };
}

function withEnv(t, vars) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

function mockZoho(t) {
  zohoAuthService._resetForTests();
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const watchBodies = [];
  const post = t.mock.method(axios, 'post', async (url, body) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) { watchBodies.push(body); return { data: { watch: [{ status: 'success' }] } }; }
    throw new Error(`unexpected POST ${url}`);
  });
  const del = t.mock.method(axios, 'delete', async () => ({ data: {} }));
  return { post, del, watchBodies };
}

test('registration is refused, with no Zoho or Data Store call, unless OEM_WATCH_REGISTRATION_ENABLED=true', async (t) => {
  for (const flag of [undefined, '', 'false', 'yes', '1']) {
    withEnv(t, { OEM_WATCH_REGISTRATION_ENABLED: flag, PUBLIC_FUNCTION_BASE_URL: AU_BASE });
    const { post, del } = mockZoho(t);
    const app = fakeApp();
    await assert.rejects(zohoWebhookService.registerWatchChannels(app), { code: 'OEM_WATCH_REGISTRATION_DISABLED' });
    assert.equal(post.mock.callCount(), 0, `flag=${flag}: no token or watch call`);
    assert.equal(del.mock.callCount(), 0, `flag=${flag}: existing channel not deregistered`);
    assert.equal(app.queries.length + app.inserted.length, 0, `flag=${flag}: no Data Store access`);
    t.mock.restoreAll();
  }
});

test('a missing or malformed PUBLIC_FUNCTION_BASE_URL fails before the existing channel is deregistered', async (t) => {
  for (const base of [undefined, '', '   ', 'not a url', 'http://insecure.example/server/f',
    'https://user:pw@host.example/server/f', 'https://host.example/server/f?x=1', 'https://host.example/server/f#x']) {
    withEnv(t, { OEM_WATCH_REGISTRATION_ENABLED: 'true', PUBLIC_FUNCTION_BASE_URL: base });
    const { post, del } = mockZoho(t);
    const app = fakeApp();
    await assert.rejects(zohoWebhookService.registerWatchChannels(app), { code: 'PUBLIC_FUNCTION_BASE_URL_INVALID' });
    assert.equal(post.mock.callCount() + del.mock.callCount(), 0, `base=${base}: no Zoho call`);
    assert.equal(app.queries.length, 0, `base=${base}: channel table not read`);
    t.mock.restoreAll();
  }
});

test('the registered notify_url is exactly PUBLIC_FUNCTION_BASE_URL + /webhooks/crm-notify, and it is logged without the token', async (t) => {
  withEnv(t, { OEM_WATCH_REGISTRATION_ENABLED: 'true', PUBLIC_FUNCTION_BASE_URL: `${AU_BASE}/` });
  const { watchBodies } = mockZoho(t);
  const lines = [];
  t.mock.method(logger, 'info', (ctx, msg) => lines.push(String(msg)));
  const result = await zohoWebhookService.registerWatchChannels(fakeApp());

  const expected = `${AU_BASE}/webhooks/crm-notify`;
  assert.equal(watchBodies.length, 1);
  assert.equal(watchBodies[0].watch[0].notify_url, expected);
  assert.equal(result.notifyUrl, expected);
  const registered = lines.find((l) => l.startsWith('Registered watch channel'));
  assert.ok(registered && registered.includes(`notify_url=${expected}`), 'success log names the notify_url');
  const token = watchBodies[0].watch[0].token;
  assert.ok(token && lines.every((l) => !l.includes(token) && !l.includes(process.env.ZOHO_WEBHOOK_TOKEN)), 'token never logged');
});

test('getPublicFunctionBaseUrl normalises trailing slashes and keeps the path', (t) => {
  withEnv(t, { PUBLIC_FUNCTION_BASE_URL: `  ${AU_BASE}//  ` });
  assert.equal(getPublicFunctionBaseUrl(), AU_BASE);
});

test('the watch registration code contains no hardcoded Catalyst function host', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'zohoWebhookService.js'), 'utf8');
  assert.doesNotMatch(source, /catalystserverless\./);
  assert.doesNotMatch(source, /60069659585|7007717417/);
});
