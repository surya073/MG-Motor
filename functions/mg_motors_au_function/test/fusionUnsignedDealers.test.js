'use strict';

// FUSION_UNSIGNED_WEBHOOK_DEALER_CODES (MG, 20 Nov 2026): the listed Fusion SD
// dealers (Hillcrest 411802, Indooroopilly 406802) post without a signature.

const test = require('node:test');
const assert = require('node:assert/strict');

const integrationAuthService = require('../services/integrations/integrationAuthService');
const webhookVerificationService = require('../services/integrations/webhookVerificationService');
const proof = require('../services/integrations/fusionReturnChannelProof');

const BODY = Buffer.from(JSON.stringify({ lead_id: 'lead_01ABC', status: 'Lost' }));
const HILLCREST = { ROWID: '818000000080569', dealer_code: '411802', crm_type: 'FUSION_SD', webhook_enabled: true };
const OTHER = { ROWID: '1000', dealer_code: '725001', crm_type: 'FUSION_SD', webhook_enabled: true };

function setup(t, unsigned = '411802, 406802') {
  const before = { v2: process.env.FUSION_INBOUND_V2, list: process.env.FUSION_UNSIGNED_WEBHOOK_DEALER_CODES };
  process.env.FUSION_INBOUND_V2 = 'true';
  if (unsigned === null) delete process.env.FUSION_UNSIGNED_WEBHOOK_DEALER_CODES;
  else process.env.FUSION_UNSIGNED_WEBHOOK_DEALER_CODES = unsigned;
  t.after(() => {
    for (const [key, value] of [['FUSION_INBOUND_V2', before.v2], ['FUSION_UNSIGNED_WEBHOOK_DEALER_CODES', before.list]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'whsec_c2VjcmV0c2VjcmV0c2VjcmV0');
}

const verify = (integration, headers = {}) => webhookVerificationService.verifyWebhook({}, integration, BODY, headers);

test('a listed dealer is accepted with no signature headers', async (t) => {
  setup(t);
  assert.deepEqual(await verify(HILLCREST), {
    ok: true, method: proof.UNSIGNED_METHOD, signingSecretFingerprint: proof.UNSIGNED_FINGERPRINT,
  });
});

test('a listed dealer is accepted even when it still sends a signature that does not match', async (t) => {
  setup(t);
  const result = await verify(HILLCREST, { 'webhook-id': 'msg_1', 'webhook-timestamp': '1', 'webhook-signature': 'v1,AAAA' });
  assert.equal(result.ok, true);
});

test('every other Fusion dealer must still sign', async (t) => {
  setup(t);
  assert.deepEqual(await verify(OTHER), { ok: false, reason: 'MISSING_AUTH' });
});

test('with the setting unset, Hillcrest must sign again', async (t) => {
  setup(t, null);
  assert.deepEqual(await verify(HILLCREST), { ok: false, reason: 'MISSING_AUTH' });
});

test('a disabled webhook stays disabled for a listed dealer', async (t) => {
  setup(t);
  assert.deepEqual(await verify({ ...HILLCREST, webhook_enabled: false }), { ok: false, reason: 'WEBHOOK_DISABLED' });
});

test('an unsigned webhook that was processed proves the return channel for the SLA gate', async (t) => {
  setup(t);
  const rows = [];
  const app = {
    zcql: () => ({ executeZCQLQuery: async () => rows.map((row) => ({ outbound_sync_claims: row })) }),
    datastore: () => ({ table: () => ({ insertRow: async (row) => { rows.push({ ROWID: '1', ...row }); return row; }, updateRow: async () => ({}) }) }),
  };
  assert.equal(await proof.getReturnChannelGap(app, HILLCREST), 'NO_VERIFIED_WEBHOOK');
  const authResult = await verify(HILLCREST);
  assert.equal(await proof.recordVerifiedSuccess(app, HILLCREST, authResult), true);
  assert.equal(await proof.getReturnChannelGap(app, HILLCREST), null);
});
