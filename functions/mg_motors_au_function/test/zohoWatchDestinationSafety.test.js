'use strict';

// No built-in notify URL any more; OEM registration is opt-in (config/env.js).
process.env.PUBLIC_FUNCTION_BASE_URL = process.env.PUBLIC_FUNCTION_BASE_URL || 'https://functions.test.example/server/mg_motors_au_function';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const dns = require('dns').promises;
const auth = require('../services/integrations/integrationAuthService');
const oauth = require('../services/integrations/adapters/zohoCrmOAuthHelper');
const watch = require('../services/zohoWebhookService');
const logger = require('../utils/logger');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { mockCredentialSnapshot } = require('./helpers/dealerZohoFixture');
const integration = {
  ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'ZOHO_CRM',
  status: 'ACTIVE', inbound_enabled: true, base_url: 'https://www.zohoapis.in',
  oauth_accounts_domain: 'https://accounts.zoho.in',
};
function fixture(t) {
  oauth._resetForTests();
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mockCredentialSnapshot(t);
  const secrets = t.mock.method(auth, 'getDecryptedCredential', async () => 'synthetic-sensitive-value');
  const db = createInMemoryZcql({
    dealer_integrations: [{ ...integration }],
    webhook_channels: [{ ROWID: '2000', dealer_code: 'AU999', channel_id: 'old', CREATEDTIME: '2026-01-01' }],
  });
  return { db, secrets };
}

test('dealer watch refuses unsafe or unsupported API hosts before any credential access or HTTP call', async (t) => {
  const { db, secrets } = fixture(t);
  const post = t.mock.method(axios, 'post', async () => { throw new Error('must not call'); });
  for (const base_url of ['https://outside.example', 'https://www.zohoapis.in.attacker.example',
    'http://www.zohoapis.in', 'https://user:pass@www.zohoapis.in', 'https://www.zohoapis.in:8443']) {
    await assert.rejects(watch.registerDealerWatchChannel(db.app, { ...integration, base_url }), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  assert.equal(secrets.mock.callCount(), 0);
  assert.equal(post.mock.callCount(), 0);
});

test('dealer watch refuses private DNS and ineligible integrations before secrets', async (t) => {
  const { db, secrets } = fixture(t);
  for (const changes of [{ status: 'DISABLED' }, { inbound_enabled: false }, { crm_type: 'FUSION_SD' }, { integration_type: 'PORTAL' }]) {
    await assert.rejects(watch.registerDealerWatchChannel(db.app, { ...integration, ...changes }), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(watch.registerDealerWatchChannel(db.app, integration), { code: 'INVALID_CRM_CONFIGURATION' });
  assert.equal(secrets.mock.callCount(), 0);
});

test('every watch call (list, renew, create, read back, delete) pins a validated destination and refuses redirects/proxies', async (t) => {
  const { db } = fixture(t);
  const notifyUrl = `${process.env.PUBLIC_FUNCTION_BASE_URL}/webhooks/dealers/AU999`;
  const requests = [];
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/')) return { data: { access_token: 'synthetic-access-token', expires_in: 3600 } };
    throw new Error(`unexpected POST ${url}`);
  });
  t.mock.method(axios, 'request', async (config) => {
    requests.push(config);
    if (config.method === 'GET') {
      return { data: { watch: [{ channel_id: config.params?.channel_id || 'old', notify_url: notifyUrl, events: ['Leads.edit'], channel_expiry: '2030-01-01T00:00:00+00:00' }] } };
    }
    if (config.method === 'PATCH') throw Object.assign(new Error('gone'), { response: { status: 404 } });
    if (config.method === 'POST') assert.equal(typeof config.data.watch[0].token, 'string');
    return { data: { watch: [{ code: 'SUCCESS' }] } };
  });
  await watch.registerDealerWatchChannel(db.app, integration);
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'PATCH', 'POST', 'GET', 'DELETE']);
  for (const config of requests) {
    assert.equal(config.url, 'https://www.zohoapis.in/crm/v8/actions/watch');
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.proxy, false);
    assert.equal(config.adapter, 'http');
    assert.equal(typeof config.lookup, 'function');
    assert.equal(config.headers.Authorization, 'Zoho-oauthtoken synthetic-access-token');
  }
});

test('watch API failures never expose the vendor body, request headers or callback token', async (t) => {
  const { db } = fixture(t);
  const logs = [];
  t.mock.method(logger, 'error', (...args) => logs.push(args));
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/')) return { data: { access_token: 'synthetic-sensitive-value', expires_in: 3600 } };
    throw new Error(`unexpected POST ${url}`);
  });
  t.mock.method(axios, 'request', async () => {
    throw Object.assign(new Error('synthetic-sensitive-value'), { response: { status: 302, data: 'synthetic-sensitive-value' }, config: { headers: { Authorization: 'synthetic-sensitive-value' } } });
  });
  await assert.rejects(watch.registerDealerWatchChannel(db.app, integration), (err) => {
    assert.match(err.message, /HTTP 302/);
    assert.ok(!err.message.includes('synthetic-sensitive-value'));
    return true;
  });
  assert.ok(!JSON.stringify(logs).includes('synthetic-sensitive-value'));
});
