'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../services/integrations/crmIntegrationService');

const NOW = new Date('2026-11-06T14:30:00Z'); // 7 Nov 01:30 AEDT
const crm = (record) => ({ fetchOemLeadsByIds: async () => (record === undefined ? [] : [record]) });

test('Connected CRM names the dealer CRM provider', () => {
  assert.deepEqual(svc.deliveryAcknowledgementFields({ crm_type: 'FUSION_SD' }), { Lead_Status: 'Not Contacted', Lead_Exchanged: true, Connected_CRM: 'Fusion SD' });
  assert.equal(svc.deliveryAcknowledgementFields({ crm_type: 'DEALER_STUDIO' }).Connected_CRM, 'Dealer Studio');
  assert.equal(svc.deliveryAcknowledgementFields({ crm_type: 'ZOHO_CRM' }).Connected_CRM, 'Zoho CRM');
  assert.equal(svc.deliveryAcknowledgementFields({ crm_type: 'GENERIC_REST', crm_name: 'Acme CRM' }).Connected_CRM, 'Acme CRM');
});

test('First Action Date is stamped once, in Australian time, on the first real dealer update', async () => {
  assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', { lead_status: 'Contacted' }, NOW), { First_Action_Date: '2026-11-07' });
  assert.deepEqual(await svc.leadActivityDateFields(crm({ First_Action_Date: '2026-11-05' }), 'L1', { lead_status: 'Contacted' }, NOW), {});
});

test('a move back to Not Contacted is not an action', async () => {
  assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', { lead_status: 'Not Contacted' }, NOW), {});
});

test('a plain field edit is not a first action (MG: fixing a name is not an action)', async () => {
  for (const update of [
    { customer_name: 'Melanie Smith' },
    { mobile_number: '0412345678', email_address: 'a@b.com' },
    { vehicle_model: 'MG4' },
  ]) {
    assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', update, NOW), {}, JSON.stringify(update));
  }
});

test('a field edit that comes with a status move still counts, from the status', async () => {
  assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', { customer_name: 'Melanie', lead_status: 'Follow-up 1' }, NOW), { First_Action_Date: '2026-11-07' });
});

test('statuses that still mean waiting for the dealer, and open outcomes, are not actions', async () => {
  for (const update of [
    { lead_status: 'Update Pending' },
    { lead_status: 'Not Contacted', customer_name: 'Melanie' },
    { lead_status: '-None-' },
    { lead_status: 'Unattended Alert' },
    { enquiry_outcome: 'Outcome Pending' },
    { enquiry_outcome: '(required)' },
    { enquiry_outcome: '' },
  ]) {
    assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', update, NOW), {}, JSON.stringify(update));
  }
});

test('a Lost status from the dealer is an action', async () => {
  assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', { lead_status: 'Lost Lead' }, NOW), { First_Action_Date: '2026-11-07', Sold_Date: '2026-11-07' });
});

test('Test Drive Date is stamped once when the outcome becomes Test Drive', async () => {
  assert.deepEqual(await svc.leadActivityDateFields(crm({}), 'L1', { enquiry_outcome: 'Test Drive' }, NOW), { First_Action_Date: '2026-11-07', Test_Drive_Date: '2026-11-07' });
  assert.deepEqual(await svc.leadActivityDateFields(crm({ First_Action_Date: '2026-11-01', Test_Drive_Date: '2026-11-02' }), 'L1', { enquiry_outcome: 'Test Drive' }, NOW), {});
  assert.deepEqual(await svc.leadActivityDateFields(crm({ First_Action_Date: '2026-11-01' }), 'L1', { enquiry_outcome: 'Purchase' }, NOW), { Sold_Date: '2026-11-07' });
});

test('nothing is stamped when the MG record cannot be read; the dealer update is not blocked', async () => {
  assert.deepEqual(await svc.leadActivityDateFields(crm(undefined), 'L1', { lead_status: 'Contacted' }, NOW), {});
  assert.deepEqual(await svc.leadActivityDateFields({ fetchOemLeadsByIds: async () => { throw new Error('down'); } }, 'L1', { lead_status: 'Contacted' }, NOW), {});
});

test('Closed Date is stamped once when the outcome closes the lead (Dealer Studio delivered = Purchase)', async () => {
  const done = { First_Action_Date: '2026-11-01' };
  assert.deepEqual(await svc.leadActivityDateFields(crm(done), 'L1', { enquiry_outcome: 'Purchase' }, NOW), { Sold_Date: '2026-11-07' });
  for (const o of ['Fleet Order', 'On-Sold', 'Lost', 'Outcome Not Required']) {
    assert.deepEqual(await svc.leadActivityDateFields(crm(done), 'L1', { enquiry_outcome: o }, NOW), { Sold_Date: '2026-11-07' }, o);
  }
  assert.deepEqual(await svc.leadActivityDateFields(crm(done), 'L1', { lead_status: 'Lost Lead' }, NOW), { Sold_Date: '2026-11-07' });
  assert.deepEqual(await svc.leadActivityDateFields(crm({ ...done, Sold_Date: '2026-11-03' }), 'L1', { enquiry_outcome: 'Purchase' }, NOW), {}, 'never overwritten');
  assert.deepEqual(await svc.leadActivityDateFields(crm(done), 'L1', { enquiry_outcome: 'Test Drive' }, NOW), { Test_Drive_Date: '2026-11-07' }, 'a test drive does not close');
});
