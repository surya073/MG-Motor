'use strict';

// AUTOPLAY_WEBHOOK_SECRET: one shared token for AutoPlay dealers' return updates
// (X-Webhook-Token or HMAC X-Signature), alongside the dealer's own WEBHOOK_SECRET.

const test = require('node:test');
const assert = require('node:assert/strict');

const integrationAuthService = require('../services/integrations/integrationAuthService');
const { verifyWebhook, computeHmac } = require('../services/integrations/webhookVerificationService');

const AUTOPLAY_SECRET = 'a'.repeat(64);
const OWN = 'own-secret-of-the-dealer-0123456789abcdef';
const body = Buffer.from(JSON.stringify({ uniqueIdentifier: 'ZL1', leadId: 1, progressName: 'Phone Call Made' }));
const integration = (crm_type) => ({ ROWID: '1', dealer_code: '654322', crm_type, webhook_enabled: true });

function setup(t, { own = null, secret = AUTOPLAY_SECRET } = {}) {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => own);
  const saved = process.env.AUTOPLAY_WEBHOOK_SECRET;
  if (secret) process.env.AUTOPLAY_WEBHOOK_SECRET = secret; else delete process.env.AUTOPLAY_WEBHOOK_SECRET;
  t.after(() => {
    if (saved === undefined) delete process.env.AUTOPLAY_WEBHOOK_SECRET; else process.env.AUTOPLAY_WEBHOOK_SECRET = saved;
  });
}
const token = (s) => ({ 'x-webhook-token': s });
const signed = (s) => ({ 'x-signature': computeHmac(s, body) });

test('an AutoPlay dealer accepts AUTOPLAY_WEBHOOK_SECRET as X-Webhook-Token or as the HMAC key', async (t) => {
  setup(t);
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, token(AUTOPLAY_SECRET))).ok, true);
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, signed(AUTOPLAY_SECRET))).ok, true);
});

test('the dealer\'s own secret keeps working alongside it', async (t) => {
  setup(t, { own: OWN });
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, token(OWN))).ok, true);
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, token(AUTOPLAY_SECRET))).ok, true);
});

test('a wrong token or signature is rejected', async (t) => {
  setup(t);
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, token('nope'))).ok, false);
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, signed('nope'))).ok, false);
  assert.equal((await verifyWebhook({}, integration('AUTOPLAY'), body, {})).ok, false);
});

test('AUTOPLAY_WEBHOOK_SECRET is never accepted for another CRM type', async (t) => {
  setup(t);
  const result = await verifyWebhook({}, integration('GENERIC_REST'), body, token(AUTOPLAY_SECRET));
  assert.equal(result.ok, false);
});

test('with the env var unset and no dealer secret, AutoPlay webhooks are refused as not configured', async (t) => {
  setup(t, { secret: null });
  const result = await verifyWebhook({}, integration('AUTOPLAY'), body, token(AUTOPLAY_SECRET));
  assert.deepEqual(result, { ok: false, reason: 'WEBHOOK_AUTH_NOT_CONFIGURED' });
});
