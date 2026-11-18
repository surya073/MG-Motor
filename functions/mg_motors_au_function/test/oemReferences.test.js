'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com.au';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com.au';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const oemCrmService = require('../services/zohoCrmService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { oemReferenceFields } = require('../services/integrations/oemReferenceFields');
const { backfillOemReferences } = require('../services/integrations/oemReferenceBackfillService');
const { fingerprintKeys } = require('../services/integrations/leadFingerprintService');

test('oemReferenceFields uses the OEM API names and never writes a blank reference', () => {
  assert.deepEqual(oemReferenceFields({ dealerCrmId: ' lead_1 ', middlewareId: 4821 }), { Dealer_CRM_ID: 'lead_1', Middleware_ID: '4821' });
  assert.deepEqual(oemReferenceFields({ dealerCrmId: 'lead_1' }), { Dealer_CRM_ID: 'lead_1' });
  assert.deepEqual(oemReferenceFields({ dealerCrmId: '', middlewareId: null }), {});
  assert.deepEqual(oemReferenceFields(), {});
});

test('the delivery acknowledgement does not carry the references: they are written in a separate best-effort call', () => {
  const integration = { crm_type: 'FUSION_SD' };
  assert.deepEqual(
    crmIntegrationService.deliveryAcknowledgementFields(integration, { dealerCrmId: 'D-9', middlewareId: '77' }),
    { Lead_Status: 'Not Contacted', Lead_Exchanged: true, Connected_CRM: 'Fusion SD' }
  );
});

test('the references are not business state: they never enter the lead fingerprint', () => {
  // Fingerprint keys come only from the integration's mapped fields (+ lead_status), so
  // writing the references to OEM cannot look like a lead change and cannot restart the echo loop.
  const keys = fingerprintKeys([{ source_field: 'customer_name' }, { source_field: 'email_address' }]);
  assert.equal(keys.includes('Dealer_CRM_ID'), false);
  assert.equal(keys.includes('Middleware_ID'), false);
});

function fakeApp(rowsFor) {
  const queries = [];
  return {
    queries,
    zcql: () => ({
      executeZCQLQuery: async (query) => { queries.push(query); return rowsFor(query).map((leads) => ({ leads })); },
    }),
  };
}

function stubOemWrites(t, impl) {
  const original = oemCrmService.updateOemLead;
  const writes = [];
  oemCrmService.updateOemLead = async (id, fields) => { writes.push({ id, fields }); return impl ? impl(id, fields) : { success: true }; };
  t.after(() => { oemCrmService.updateOemLead = original; });
  return writes;
}

const LEADS = [
  { ROWID: '101', crm_record_id: 'Z1', dealer_code: '406802', dealer_crm_record_id: 'D-1' },
  { ROWID: '102', crm_record_id: 'Z2', dealer_code: '406802', dealer_crm_record_id: 'D-2' },
  { ROWID: '103', crm_record_id: 'Z3', dealer_code: '223201', dealer_crm_record_id: 'D-3' },
];

test('backfill writes ONLY the two reference fields, for delivered leads', async (t) => {
  const writes = stubOemWrites(t);
  const app = fakeApp(() => LEADS);
  const result = await backfillOemReferences(app, { dealerCodes: ['406802', '223201'], limit: 20 });

  assert.deepEqual(writes.map((w) => w.id), ['Z1', 'Z2', 'Z3']);
  assert.deepEqual(writes[0].fields, { Dealer_CRM_ID: 'D-1', Middleware_ID: '101' });
  for (const w of writes) assert.deepEqual(Object.keys(w.fields).sort(), ['Dealer_CRM_ID', 'Middleware_ID']); // never a status
  assert.equal(result.updated, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.done, true);
  assert.match(app.queries[0], /dealer_crm_record_id IS NOT NULL/);
  assert.match(app.queries[0], /dealer_code IN \('406802','223201'\)/);
});

test('backfill dry run writes nothing', async (t) => {
  const writes = stubOemWrites(t);
  const result = await backfillOemReferences(fakeApp(() => LEADS), { dryRun: true });
  assert.equal(writes.length, 0);
  assert.equal(result.updated, 3);
  assert.equal(result.dryRun, true);
});

test('backfill pages by ROWID and reports when more remain', async (t) => {
  stubOemWrites(t);
  const app = fakeApp(() => LEADS.slice(0, 2));
  const first = await backfillOemReferences(app, { limit: 2 });
  assert.equal(first.nextAfterRowId, '102');
  assert.equal(first.done, false); // a full page: there may be more
  await backfillOemReferences(app, { limit: 2, afterRowId: first.nextAfterRowId });
  assert.match(app.queries[1], /ROWID > 102/);
});

test('backfill records a failed write and keeps going', async (t) => {
  const writes = stubOemWrites(t, async (id) => { if (id === 'Z2') throw new Error('Zoho CRM update failed: INVALID_DATA'); });
  const result = await backfillOemReferences(fakeApp(() => LEADS), {});
  assert.equal(writes.length, 3);
  assert.equal(result.updated, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].crmRecordId, 'Z2');
  assert.match(result.failures[0].error, /INVALID_DATA/);
});

test('backfill ignores a malformed cursor and caps the page size', async (t) => {
  stubOemWrites(t);
  const app = fakeApp(() => []);
  const result = await backfillOemReferences(app, { afterRowId: "0; DROP TABLE leads", limit: 5000 });
  assert.match(app.queries[0], /ROWID > 0 AND/);
  assert.match(app.queries[0], /LIMIT 0, 50$/);
  assert.equal(result.done, true);
});
