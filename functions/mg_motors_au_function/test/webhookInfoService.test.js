'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeWebhook } = require('../services/integrations/webhookInfoService');

const VARS = ['PUBLIC_FUNCTION_BASE_URL', 'AUTOPLAY_WEBHOOK_SECRET', 'DEALER_STUDIO_WEBHOOK_SECRET', 'FUSION_WEBHOOK_SECRET',
  'FUSION_WEBHOOK_DEALER_CODES', 'FUSION_UNSIGNED_WEBHOOK_DEALER_CODES', 'FUSION_INBOUND_V2'];

function withEnv(t, values) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  VARS.forEach((k) => { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; });
  t.after(() => VARS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
}

const BASE = 'https://mg.example.com/server/mg_motors_au_function';
const row = (crm_type, dealer_code = '654322') => ({ ROWID: '1', dealer_code, crm_type, status: 'CONNECTED' });

test('AutoPlay: dealer, CRM, webhook URL, X-Webhook-Token and AUTOPLAY_WEBHOOK_SECRET', (t) => {
  withEnv(t, { PUBLIC_FUNCTION_BASE_URL: BASE, AUTOPLAY_WEBHOOK_SECRET: 'a'.repeat(64) });
  const info = describeWebhook(row('AUTOPLAY'), { dealer_name: 'AutoplayTest Dealer' });
  assert.equal(info.dealerName, 'AutoplayTest Dealer');
  assert.equal(info.dealerCode, '654322');
  assert.equal(info.crmLabel, 'AutoPlay');
  assert.equal(info.webhookUrl, `${BASE}/webhooks/dealers/654322`);
  assert.equal(info.method, 'POST');
  assert.equal(info.header, 'X-Webhook-Token');
  assert.equal(info.secretName, 'AUTOPLAY_WEBHOOK_SECRET');
  assert.equal(info.secret, 'a'.repeat(64));
  assert.equal(info.enforced, true);
});

test('Dealer Studio: DEALER_STUDIO_WEBHOOK_SECRET via X-API-KEY', (t) => {
  withEnv(t, { PUBLIC_FUNCTION_BASE_URL: BASE, DEALER_STUDIO_WEBHOOK_SECRET: 'ds-secret' });
  const info = describeWebhook(row('DEALER_STUDIO', '302901'), { dealer_name: 'Werribee MG' });
  assert.equal(info.crmLabel, 'Dealer Studio');
  assert.equal(info.secretName, 'DEALER_STUDIO_WEBHOOK_SECRET');
  assert.equal(info.secret, 'ds-secret');
  assert.match(info.header, /X-API-KEY/);
  assert.equal(info.enforced, true);
});

test('Fusion with every dealer unsigned: the secret is shown but marked as not enforced', (t) => {
  withEnv(t, { PUBLIC_FUNCTION_BASE_URL: BASE, FUSION_WEBHOOK_SECRET: 'fusion-secret', FUSION_INBOUND_V2: 'true', FUSION_UNSIGNED_WEBHOOK_DEALER_CODES: '*' });
  const info = describeWebhook(row('FUSION_SD', '411802'), { dealer_name: 'Hillcrest' });
  assert.equal(info.secretName, 'FUSION_WEBHOOK_SECRET');
  assert.equal(info.secret, 'fusion-secret');
  assert.equal(info.enforced, false);
  assert.match(info.note, /without a secret/);
});

test('Fusion legacy token check: enforced only for dealers in FUSION_WEBHOOK_DEALER_CODES', (t) => {
  withEnv(t, { PUBLIC_FUNCTION_BASE_URL: BASE, FUSION_WEBHOOK_SECRET: 'fusion-secret', FUSION_WEBHOOK_DEALER_CODES: '568026' });
  assert.equal(describeWebhook(row('FUSION_SD', '568026'), null).enforced, true);
  assert.equal(describeWebhook(row('FUSION_SD', '411802'), null).enforced, false);
});

test('a missing secret or base URL is reported, never invented', (t) => {
  withEnv(t, {});
  const info = describeWebhook(row('AUTOPLAY'), null);
  assert.equal(info.webhookUrl, null);
  assert.equal(info.secret, null);
  assert.equal(info.enforced, false);
  assert.match(info.note, /not set/);
});
