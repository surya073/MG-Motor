'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// OEM review 19 Nov 2026, 4.4: with LEAD_EXCHANGE_OWNER_PROJECT_ID set, only
// that Catalyst project writes to the OEM CRM, dealer CRMs and watch channels.
// The trial and MG AU can run the same code; their locks do not coordinate.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { withEnv, setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const writeOwnership = require('../services/writeOwnership');
const usageContext = require('../services/usageContext');
const zohoCrmService = require('../services/zohoCrmService');
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { getWriteOwnerProjectId } = require('../config/env');

const MG = '818000000022001';
const TRIAL = '37148000000359003';
const inProject = (projectId, fn) => usageContext.runWithContext({ catalystProject: { projectId, environment: 'Development' } }, fn);

test('LEAD_EXCHANGE_OWNER_PROJECT_ID: digits only; anything else counts as unset', (t) => {
  for (const [raw, expected] of [[undefined, null], ['', null], ['  ', null], [' 818000000022001 ', MG], ['abc', null], ['81800-1', null]]) {
    withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: raw });
    assert.equal(getWriteOwnerProjectId(), expected, String(raw));
  }
});

test('unset: every project (or none known) may write, as before', (t) => {
  withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: undefined });
  assert.equal(writeOwnership.isWriteOwner(), true);
  assert.equal(inProject(TRIAL, () => writeOwnership.isWriteOwner()), true);
  assert.doesNotThrow(() => writeOwnership.assertWriteOwner('x'));
});

test('set: only the owner project writes; another or an unknown project is refused', (t) => {
  withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: MG });
  assert.equal(inProject(MG, () => writeOwnership.isWriteOwner()), true);
  assert.equal(inProject(TRIAL, () => writeOwnership.isWriteOwner()), false);
  assert.equal(writeOwnership.isWriteOwner(), false, 'no request context: project unknown');
  assert.throws(() => inProject(TRIAL, () => writeOwnership.assertWriteOwner('the OEM CRM')),
    (err) => err.code === 'WRITE_OWNERSHIP_DENIED' && /37148000000359003/.test(err.message));
});

test('usageContext.initialize records the project and environment Catalyst passes on the request', () => {
  const ctx = { ds: {}, api: {} };
  const catalyst = { initialize: () => ({ config: { projectId: 818000000022001, environment: 'Development' } }) };
  usageContext.runWithContext({}, () => {
    usageContext.initialize(catalyst, { usageContext: ctx });
  });
  assert.deepEqual(ctx.catalystProject, { projectId: MG, environment: 'Development' });
});

test('OEM CRM: a non-owner project sends no update request at all', async (t) => {
  withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: MG });
  zohoAuthService._resetForTests();
  const posts = t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  const puts = t.mock.method(axios, 'put', async () => ({ data: { data: [{ code: 'SUCCESS', status: 'success' }] } }));

  await assert.rejects(inProject(TRIAL, () => zohoCrmService.updateOemLead('ZL1', { Lead_Status: 'Contacted' })),
    (err) => err.code === 'WRITE_OWNERSHIP_DENIED');
  assert.equal(posts.mock.callCount() + puts.mock.callCount(), 0, 'not even a token request');

  await inProject(MG, () => zohoCrmService.updateOemLead('ZL1', { Lead_Status: 'Contacted' }));
  assert.equal(puts.mock.callCount(), 1);
});

test('dealer CRM: a non-owner project skips the push quietly (no claim, adapter call, log or retry)', async (t) => {
  withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: MG });
  const harness = setupOutbound(t, { mapping: null });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: 'X1' }) });

  const result = await inProject(TRIAL, () => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()));
  assert.deepEqual(result, { skipped: true, reason: 'WRITE_OWNERSHIP_DENIED' });
  assert.equal(calls.create.length, 0);
  assert.deepEqual(harness.db.tables.lead_integrations, []);
  assert.deepEqual(harness.db.tables.outbound_sync_claims, []);
  assert.deepEqual(harness.logs(), []);
});

test('dealer CRM: the owner project pushes as before', async (t) => {
  withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: MG });
  const harness = setupOutbound(t, { mapping: null });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: 'X1' }) });
  await inProject(MG, () => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()));
  assert.equal(calls.create.length, 1);
});

test('dealer CRM: the guard also stands at the adapter call itself, for any path that reaches it', async (t) => {
  withEnv(t, { LEAD_EXCHANGE_OWNER_PROJECT_ID: MG });
  const harness = setupOutbound(t, { mapping: null });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: 'X1' }) });
  // Ownership flips between the entry check and the send (e.g. a later caller).
  let checks = 0;
  t.mock.method(writeOwnership, 'isWriteOwner', () => { checks += 1; return true; });
  const outcome = await inProject(TRIAL, () => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()))
    .catch((err) => err);
  assert.ok(checks >= 1);
  assert.equal(calls.create.length, 0, 'the adapter is never called from a non-owner project');
  assert.ok(outcome instanceof Error ? outcome.code === 'WRITE_OWNERSHIP_DENIED' : outcome, 'the send is refused');
});
