'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com.au';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com.au';

const test = require('node:test');
const assert = require('node:assert/strict');
const oemCrmService = require('../services/zohoCrmService');
const { backfillDealerStudioLostOutcome } = require('../services/integrations/lostOutcomeBackfillService');

const MIRROR = [
  { ROWID: '1', crm_record_id: 'Z1', dealer_code: '654321', lead_status: 'Lost', enquiry_outcome: '(required)' },
  { ROWID: '2', crm_record_id: 'Z2', dealer_code: '315602', lead_status: 'Lost', enquiry_outcome: '' },
  { ROWID: '3', crm_record_id: 'Z3', dealer_code: '654321', lead_status: 'Lost', enquiry_outcome: 'Retail Order' },
  { ROWID: '4', crm_record_id: 'Z4', dealer_code: '302901', lead_status: 'Lost Lead', enquiry_outcome: 'Outcome Pending' },
  { ROWID: '5', crm_record_id: 'Z5', dealer_code: '302901', lead_status: 'Lost', enquiry_outcome: '' },
];
const LIVE = {
  Z1: { id: 'Z1', Lead_Status: 'Lost', Enquiry_Outcome: '(required)' },
  Z2: { id: 'Z2', Lead_Status: 'Lost', Enquiry_Outcome: null },
  Z4: { id: 'Z4', Lead_Status: 'Lost Lead', Enquiry_Outcome: 'Outcome Pending' },
  Z5: { id: 'Z5', Lead_Status: 'Contacted', Enquiry_Outcome: null }, // reopened by MG since the mirror
};

function setup(t) {
  const queries = [];
  const mirrorWrites = [];
  const oemWrites = [];
  const app = {
    zcql: () => ({
      executeZCQLQuery: async (query) => {
        queries.push(query);
        if (query.includes('dealer_integrations')) {
          return ['654321', '315602', '302901'].map((dealer_code) => ({ dealer_integrations: { dealer_code } }));
        }
        return MIRROR.map((leads) => ({ leads }));
      },
    }),
    datastore: () => ({ table: () => ({ updateRow: async (row) => { mirrorWrites.push(row); return row; } }) }),
  };
  const originals = { fetch: oemCrmService.fetchOemLeadsByIds, update: oemCrmService.updateOemLead };
  oemCrmService.fetchOemLeadsByIds = async (ids) => ids.map((id) => LIVE[id]).filter(Boolean);
  oemCrmService.updateOemLead = async (id, fields) => { oemWrites.push({ id, fields }); return { success: true }; };
  t.after(() => { oemCrmService.fetchOemLeadsByIds = originals.fetch; oemCrmService.updateOemLead = originals.update; });
  return { app, queries, mirrorWrites, oemWrites };
}

test('Lost Dealer Studio leads with an open outcome get Enquiry_Outcome = Lost; order outcomes and reopened leads are left alone', async (t) => {
  const h = setup(t);
  const result = await backfillDealerStudioLostOutcome(h.app);
  assert.deepEqual(h.oemWrites, [
    { id: 'Z1', fields: { Enquiry_Outcome: 'Lost' } },
    { id: 'Z2', fields: { Enquiry_Outcome: 'Lost' } },
    { id: 'Z4', fields: { Enquiry_Outcome: 'Lost' } },
  ]);
  assert.deepEqual(h.mirrorWrites, ['1', '2', '4'].map((ROWID) => ({ ROWID, enquiry_outcome: 'Lost' })));
  assert.equal(result.candidates, 4, 'Retail Order is not a candidate');
  assert.deepEqual(result.skipped.map((s) => [s.crmRecordId, s.reason]), [['Z5', 'NOT_LOST_IN_OEM_CRM']]);
  assert.ok(h.queries.some((q) => q.includes("crm_type = 'DEALER_STUDIO'")));
});

test('a dry run reports the same leads and writes nothing', async (t) => {
  const h = setup(t);
  const result = await backfillDealerStudioLostOutcome(h.app, { dryRun: true });
  assert.deepEqual(result.updated.map((u) => u.crmRecordId), ['Z1', 'Z2', 'Z4']);
  assert.deepEqual(h.oemWrites, []);
  assert.deepEqual(h.mirrorWrites, []);
});
