'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com.au';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com.au';

const test = require('node:test');
const assert = require('node:assert/strict');
const oemCrmService = require('../services/zohoCrmService');
const { backfillTestDriveContacted } = require('../services/integrations/testDriveStatusBackfillService');

const MIRROR = [
  { ROWID: '1', crm_record_id: 'Z1', dealer_code: '411802', lead_status: 'Not Contacted', enquiry_outcome: 'Test Drive' },
  { ROWID: '2', crm_record_id: 'Z2', dealer_code: '421501', lead_status: 'Update Pending', enquiry_outcome: 'Test Drive' },
  { ROWID: '3', crm_record_id: 'Z3', dealer_code: '421501', lead_status: 'Follow-up 1', enquiry_outcome: 'Test Drive' },
  { ROWID: '4', crm_record_id: 'Z4', dealer_code: '411802', lead_status: 'Not Contacted', enquiry_outcome: 'Test Drive' },
  { ROWID: '5', crm_record_id: 'Z5', dealer_code: '411802', lead_status: 'Not Contacted', enquiry_outcome: 'Test Drive' },
  { ROWID: '6', crm_record_id: 'Z6', dealer_code: '411802', lead_status: 'Not Contacted', enquiry_outcome: 'Test Drive' },
];
const LIVE = {
  Z1: { id: 'Z1', Lead_Status: 'Not Contacted', Enquiry_Outcome: 'Test Drive' },
  Z2: { id: 'Z2', Lead_Status: 'Update Pending', Enquiry_Outcome: 'Test Drive' },
  Z4: { id: 'Z4', Lead_Status: 'Follow-up 1', Enquiry_Outcome: 'Test Drive' }, // progressed by MG since the mirror
  Z5: { id: 'Z5', Lead_Status: 'Not Contacted', Enquiry_Outcome: 'Purchase' }, // outcome moved on
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
          return ['411802', '421501'].map((dealer_code) => ({ dealer_integrations: { dealer_code } }));
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

test('waiting Test Drive leads become Contacted; progressed, moved-on and missing leads are left alone', async (t) => {
  const h = setup(t);
  const result = await backfillTestDriveContacted(h.app);
  assert.deepEqual(h.oemWrites, [
    { id: 'Z1', fields: { Lead_Status: 'Contacted' } },
    { id: 'Z2', fields: { Lead_Status: 'Contacted' } },
  ]);
  assert.deepEqual(h.mirrorWrites, ['1', '2'].map((ROWID) => ({ ROWID, lead_status: 'Contacted' })));
  assert.equal(result.candidates, 5, 'a Follow-up lead in the mirror is not a candidate');
  assert.deepEqual(result.skipped.map((s) => [s.crmRecordId, s.reason]), [
    ['Z4', 'STATUS_ALREADY_PROGRESSED'],
    ['Z5', 'OUTCOME_NOT_TEST_DRIVE_IN_OEM_CRM'],
    ['Z6', 'NOT_IN_OEM_CRM'],
  ]);
  assert.match(h.queries[0], /crm_type IN \('DEALER_STUDIO','FUSION_SD'\)/);
});

test('dry run reports and writes nothing', async (t) => {
  const h = setup(t);
  const result = await backfillTestDriveContacted(h.app, { dryRun: true });
  assert.equal(result.updated.length, 2);
  assert.deepEqual(h.oemWrites, []);
  assert.deepEqual(h.mirrorWrites, []);
});

test('dealerCodes limits the backfill to those dealers', async (t) => {
  const h = setup(t);
  await backfillTestDriveContacted(h.app, { dealerCodes: ['411802'] });
  assert.match(h.queries[1], /dealer_code IN \('411802'\)/);
});

test('a failed OEM write is reported and the mirror is not touched', async (t) => {
  const h = setup(t);
  oemCrmService.updateOemLead = async () => { throw new Error('INVALID_DATA'); };
  const result = await backfillTestDriveContacted(h.app);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(h.mirrorWrites, []);
});
