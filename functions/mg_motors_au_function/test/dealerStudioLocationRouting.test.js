'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// One Dealer Studio account (Heartland) posts both its locations to one MG
// dealer's URL; the cluster must reach the MG dealer it belongs to, and never a
// dealer of another account.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const routing = require('../services/integrations/dealerStudioLocationRouting');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const integrationAuthService = require('../services/integrations/integrationAuthService');

const BASE = { crm_type: 'DEALER_STUDIO', integration_type: 'EXTERNAL_CRM', status: 'CONNECTED', inbound_enabled: true };
const CASTLE_HILL = { ...BASE, ROWID: '801', dealer_code: '215402', dealership_slug: 'heartland-motors', dealership_location_id: '6033' };
const PENRITH = { ...BASE, ROWID: '802', dealer_code: '275002', dealership_slug: 'heartland-motors', dealership_location_id: '1095' };
const GOLD_COAST = { ...BASE, ROWID: '803', dealer_code: '421501', dealership_slug: 'south-coast-automotive-group', dealership_location_id: '1231' };

/** A Catalyst app whose ZCQL answers the two queries the resolver makes. */
function fakeApp({ integrations = [CASTLE_HILL, PENRITH, GOLD_COAST], mappings = [], fail = false } = {}) {
  const queries = [];
  return {
    queries,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        if (fail) throw new Error('datastore down');
        if (sql.includes('FROM dealer_integrations')) {
          const slug = /dealership_slug = '([^']*)'/.exec(sql)[1];
          return integrations.filter((row) => row.dealership_slug === slug).map((row) => ({ dealer_integrations: row }));
        }
        if (sql.includes('FROM lead_integrations')) {
          const leadIds = [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
          const ids = /integration_id IN \(([^)]*)\)/.exec(sql)[1].split(',').map((s) => s.trim());
          return mappings
            .filter((m) => leadIds.includes(m.external_crm_lead_id) && ids.includes(m.integration_id))
            .map((m) => ({ lead_integrations: { integration_id: m.integration_id } }));
        }
        throw new Error(`unexpected query ${sql}`);
      },
    }),
  };
}

function activeDealers(t, removed = []) {
  t.mock.method(crmIntegrationService, 'findDealerByCode', async (_app, code) => (
    removed.includes(code) ? { dealer_code: code, sync_status: 'Removed' } : { dealer_code: code, sync_status: 'Synced' }
  ));
}

const resolve = (app, integration, payload) => routing.resolveTargetIntegration(app, integration, payload);

// ------------------------------------------------------------ location id

test('a Penrith cluster on Castle Hill\'s URL goes to Penrith by its location id', async (t) => {
  activeDealers(t);
  const out = await resolve(fakeApp(), CASTLE_HILL, { id: 1, location: { id: 1095, name: 'Penrith' }, leads: [{ id: 9 }] });
  assert.equal(out.integration.dealer_code, '275002');
  assert.equal(out.routedBy, 'location');
});

test('a Castle Hill cluster stays with Castle Hill', async (t) => {
  activeDealers(t);
  const out = await resolve(fakeApp(), CASTLE_HILL, { id: 1, location: { id: '6033' }, leads: [{ id: 9 }] });
  assert.equal(out.integration, CASTLE_HILL);
  assert.equal(out.routedBy, null);
});

test('the location is also read as location_id, and from the cluster\'s leads', async (t) => {
  activeDealers(t);
  assert.equal((await resolve(fakeApp(), CASTLE_HILL, { id: 1, location_id: 1095 })).integration.dealer_code, '275002');
  assert.equal((await resolve(fakeApp(), CASTLE_HILL, { id: 1, leads: [{ id: 9, location: { id: 1095 } }] })).integration.dealer_code, '275002');
  assert.equal((await resolve(fakeApp(), CASTLE_HILL, { id: 1, leads: [{ id: 9, location_id: '1095' }] })).integration.dealer_code, '275002');
});

test('a location of another Dealer Studio account is never followed', async (t) => {
  activeDealers(t);
  const out = await resolve(fakeApp(), CASTLE_HILL, { id: 1, location: { id: 1231 }, leads: [{ id: 9 }] });
  assert.equal(out.integration, CASTLE_HILL);
});

test('two different locations in one post are ambiguous: no location routing', async (t) => {
  activeDealers(t);
  const out = await resolve(fakeApp(), CASTLE_HILL, { id: 1, location: { id: 1095 }, leads: [{ id: 9, location_id: 6033 }] });
  assert.equal(out.integration, CASTLE_HILL);
});

test('a sibling that is switched off, not connected or removed is not a target', async (t) => {
  activeDealers(t);
  const payload = { id: 1, location: { id: 1095 } };
  for (const penrith of [{ ...PENRITH, inbound_enabled: false }, { ...PENRITH, status: 'DISABLED' }, { ...PENRITH, integration_type: 'PORTAL' }]) {
    const out = await resolve(fakeApp({ integrations: [CASTLE_HILL, penrith] }), CASTLE_HILL, payload);
    assert.equal(out.integration, CASTLE_HILL);
  }
  t.mock.restoreAll();
  activeDealers(t, ['275002']);
  assert.equal((await resolve(fakeApp(), CASTLE_HILL, payload)).integration, CASTLE_HILL);
});

// --------------------------------------------------------------- lead ids

test('with no location, the cluster goes to the account dealer that holds its leads', async (t) => {
  activeDealers(t);
  const app = fakeApp({ mappings: [{ external_crm_lead_id: '4100001', integration_id: '802' }] });
  const out = await resolve(app, CASTLE_HILL, { id: 1, leads: [{ id: 4100001 }] });
  assert.equal(out.integration.dealer_code, '275002');
  assert.equal(out.routedBy, 'lead');
});

test('a lead the URL dealer holds keeps the cluster there', async (t) => {
  activeDealers(t);
  const app = fakeApp({ mappings: [
    { external_crm_lead_id: '4100001', integration_id: '801' },
    { external_crm_lead_id: '4100002', integration_id: '802' },
  ] });
  const out = await resolve(app, CASTLE_HILL, { id: 1, leads: [{ id: 4100001 }, { id: 4100002 }] });
  assert.equal(out.integration, CASTLE_HILL);
});

test('a lead held only by another account\'s dealer is not followed (only the account\'s dealers are searched)', async (t) => {
  activeDealers(t);
  const app = fakeApp({ mappings: [{ external_crm_lead_id: '4100001', integration_id: '803' }] });
  const out = await resolve(app, CASTLE_HILL, { id: 1, leads: [{ id: 4100001 }] });
  assert.equal(out.integration, CASTLE_HILL);
  const leadQuery = app.queries.find((sql) => sql.includes('FROM lead_integrations'));
  assert.match(leadQuery, /integration_id IN \(801, 802\)/);
});

// ------------------------------------------------------- unchanged paths

test('a dealer alone in its account, or with no slug, costs at most one read and stays put', async (t) => {
  activeDealers(t);
  const app = fakeApp();
  assert.equal((await resolve(app, GOLD_COAST, { id: 1, location: { id: 1095 } })).integration, GOLD_COAST);
  assert.equal(app.queries.length, 1);
  const noSlug = { ...CASTLE_HILL, dealership_slug: '' };
  assert.equal((await resolve(app, noSlug, { id: 1, location: { id: 1095 } })).integration, noSlug);
  assert.equal(app.queries.length, 1);
});

test('a non-Dealer-Studio integration is never touched', async (t) => {
  activeDealers(t);
  const app = fakeApp();
  const fusion = { ...CASTLE_HILL, crm_type: 'FUSION_SD' };
  assert.equal((await resolve(app, fusion, { location: { id: 1095 } })).integration, fusion);
  assert.equal(app.queries.length, 0);
});

test('a read failure keeps the URL dealer', async (t) => {
  activeDealers(t);
  const out = await resolve(fakeApp({ fail: true }), CASTLE_HILL, { id: 1, location: { id: 1095 } });
  assert.equal(out.integration, CASTLE_HILL);
});

// ------------------------------------------------------------------ route

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const webhookRoutes = require('../routes/webhookRoutes');

const SECRET = 'heartland-signing-secret';
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('base64');

async function routeSetup(t) {
  t.mock.method(catalyst, 'initialize', () => fakeApp());
  activeDealers(t);
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async (_app, code) => (
    [CASTLE_HILL, PENRITH, GOLD_COAST].find((row) => row.dealer_code === code) || null
  ));
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, type) => (type === 'WEBHOOK_SIGNING_SECRET' ? SECRET : null));
  const recorded = [];
  t.mock.method(crmIntegrationService, 'checkAndRecordWebhookEvent', async (_app, integration) => {
    recorded.push(integration.dealer_code);
    return { isDuplicate: false, eventRowId: 'ev1' };
  });
  t.mock.method(crmIntegrationService, 'markWebhookEventStatus', async () => {});
  const processed = [];
  t.mock.method(crmIntegrationService, 'processInboundWebhook', async (_app, integration) => {
    processed.push(integration.dealer_code);
    return { ok: true };
  });
  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolveListen) => { const l = server.listen(0, '127.0.0.1', () => resolveListen(l)); });
  t.after(() => listener.close());
  const post = async (code, body, signature) => {
    const raw = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/${code}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature || sign(raw) }, body: raw,
    });
    return { status: response.status, body: await response.json() };
  };
  return { post, processed, recorded };
}

test('route: Heartland posts both sites to Castle Hill\'s URL and each lands on its own dealer', async (t) => {
  const { post, processed, recorded } = await routeSetup(t);
  const penrith = await post('215402', { id: 1, status_type: 'working', location: { id: 1095 }, leads: [{ id: 9 }] });
  const castleHill = await post('215402', { id: 2, status_type: 'working', location: { id: 6033 }, leads: [{ id: 8 }] });
  assert.equal(penrith.status, 200);
  assert.equal(castleHill.status, 200);
  assert.deepEqual(processed, ['275002', '215402']);
  assert.deepEqual(recorded, ['275002', '215402']);
});

test('route: a bad signature is still refused before any routing', async (t) => {
  const { post, processed, recorded } = await routeSetup(t);
  const res = await post('215402', { id: 1, status_type: 'working', location: { id: 1095 } }, 'bm9wZQ==');
  assert.equal(res.status, 401);
  assert.deepEqual(processed, []);
  assert.deepEqual(recorded, []);
});
