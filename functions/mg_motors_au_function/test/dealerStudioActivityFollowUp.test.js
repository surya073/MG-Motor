'use strict';

// Activity-based Follow-up 1 / 2 for Dealer Studio (MG approval, 27 Nov 2026):
// a dealer activity moves a lead MG still has as Not Contacted to Follow-up 1, a
// second one to Follow-up 2. A status the dealer sets wins; nothing moves back.

const test = require('node:test');
const assert = require('node:assert/strict');

const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const followUp = require('../services/integrations/dealerActivityFollowUp');
const { backfillActivityFollowUps } = require('../services/integrations/activityFollowUpBackfillService');
const { FIELD_PRESET, INBOUND_STATUS_PRESET } = require('../services/integrations/adapters/dealerStudioMappings');
const { setupOutbound } = require('./helpers/outboundHarness');

const DS_LEAD_ID = '100001';

function harnessFor(t, { lead = {}, flag = true, oemRecord = {} } = {}) {
  const saved = process.env.DEALER_STUDIO_ACTIVITY_FOLLOWUP;
  if (flag) process.env.DEALER_STUDIO_ACTIVITY_FOLLOWUP = 'true'; else delete process.env.DEALER_STUDIO_ACTIVITY_FOLLOWUP;
  t.after(() => {
    if (saved === undefined) delete process.env.DEALER_STUDIO_ACTIVITY_FOLLOWUP; else process.env.DEALER_STUDIO_ACTIVITY_FOLLOWUP = saved;
  });
  const harness = setupOutbound(t, {
    integration: { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads', inbound_enabled: true, webhook_enabled: true },
    mapping: { external_crm_lead_id: DS_LEAD_ID },
    lead: { lead_status: 'Not Contacted', ...lead },
  });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET.map((row) => ({ integration_id: '1000', ...row })));
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...INBOUND_STATUS_PRESET.map(({ dealer_status, mg_status }) => ({
    integration_id: '1000', source_status: dealer_status, target_status: mg_status, direction: 'EXTERNAL_TO_ZOHO',
  })));
  harness.db.tables.notifications = [];
  harness.db.tables.lead_activities = [];
  // MG's live record, read for the activity dates (First Action Date is written once).
  t.mock.method(oemCrmService, 'fetchOemLeadsByIds', async () => [{ Lead_Status: lead.lead_status ?? 'Not Contacted', ...oemRecord }]);
  return harness;
}

const receive = (harness, payload) =>
  crmIntegrationService.processInboundWebhook(harness.db.app, harness.integration, payload, oemCrmService);

const CALL = { id: 4000002, user: { id: 5001, name: 'Sam Taylor' }, created_at: '2026-11-25T00:39:49.341Z', event_type: 'phone', updated_at: '2026-11-25T00:39:49.341Z', description: 'Called left message' };
const SMS = { id: 4000003, user: { id: 5001, name: 'Sam Taylor' }, created_at: '2026-11-26T00:39:57.036Z', event_type: 'sms', updated_at: '2026-11-26T00:39:57.036Z', description: 'Sent text' };
const AI_SMS = { id: 4000001, created_at: '2026-11-24T23:25:50.601Z', event_type: 'ai_sms', updated_at: '2026-11-24T23:25:50.601Z', description: 'AI SMS' };
const EMAIL = { id: 4000004, created_at: '2026-11-27T00:00:00.000Z', event_type: 'email', updated_at: '2026-11-27T00:00:00.000Z' };

const post = (events, extra = {}) => ({
  id: 1000001,
  provider: 'Dealer Studio',
  updated_at: '2026-11-27T01:00:00.000Z',
  leads: [{ id: DS_LEAD_ID, provider: { id: 'ENQ-1', name: 'MG Leads Exchange' } }],
  lead_events: events,
  ...extra,
});

const statusLog = (harness) => harness.logs()
  .map((row) => JSON.parse(row.field_changes || '[]').find((change) => change.field === 'lead_status'))
  .filter(Boolean).at(-1);

// ------------------------------------------------------------- rule table

test('rule table: waiting -> Follow-up 1 / 2, Follow-up 1 -> 2, everything else stays', () => {
  const cases = [
    ['Not Contacted', 1, 'Follow-up 1'], ['Not Contacted', 2, 'Follow-up 2'], ['Not Contacted', 5, 'Follow-up 2'],
    ['Update Pending', 1, 'Follow-up 1'], ['', 1, 'Follow-up 1'], ['-None-', 1, 'Follow-up 1'], [null, 2, 'Follow-up 2'],
    ['Follow-up 1', 1, null], ['Follow-up 1', 2, 'Follow-up 2'], ['Follow-up 2', 7, null],
    ['Contacted', 1, null], ['Contact in Future', 3, null], ['Lost Lead', 1, null], ['Lost', 2, null],
    ['Junk Lead', 2, null], ['Dropped', 1, null], ['Not Qualified', 1, null], ['Dealer Unavailable', 1, null],
    ['PMA Unassigned', 1, null], ['Not Contacted', 0, null],
  ];
  cases.forEach(([status, count, expected]) => assert.equal(followUp.followUpTarget(status, count), expected, `${status} x${count}`));
});

test('activities are counted once by id and ordered by when they happened', () => {
  const summary = followUp.summarizeActivities([
    { sourceEventId: 'b', eventType: 'sms', createdAt: '2026-11-26T00:00:00Z' },
    { sourceEventId: 'a', eventType: 'phone', userName: 'Sam', createdAt: '2026-11-25T00:00:00Z' },
    { sourceEventId: 'a', eventType: 'phone', createdAt: '2026-11-25T00:00:00Z' },
  ]);
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.first, { id: 'a', type: 'phone', user: 'Sam', at: '2026-11-25T00:00:00Z' });
  assert.equal(summary.second.id, 'b');
  assert.equal(followUp.summarizeActivities([]), null);
});

// ------------------------------------------------------------- end to end

test('first activity: Not Contacted -> Follow-up 1, First Action Date is the activity day, reason logged', async (t) => {
  const harness = harnessFor(t);
  const result = await receive(harness, post([CALL]));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Follow-up 1', First_Action_Date: '2026-11-25' } }]);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 1');
  const change = statusLog(harness);
  assert.equal(change.from, 'Not Contacted');
  assert.equal(change.to, 'Follow-up 1');
  assert.equal(change.trigger, 'DEALER_ACTIVITY');
  assert.equal(change.activity_count, 1);
  assert.deepEqual(change.activities, [{ id: '4000002', type: 'phone', user: 'Sam Taylor', at: CALL.created_at }]);
});

test('second activity: Follow-up 1 -> Follow-up 2, the second activity is the reason', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([CALL]));
  harness.oemWrites.length = 0;
  await receive(harness, post([CALL, SMS], { updated_at: '2026-11-27T02:00:00.000Z' }));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 2');
  assert.equal(harness.oemWrites[0].fields.Lead_Status, 'Follow-up 2');
  const change = statusLog(harness);
  assert.equal(change.from, 'Follow-up 1');
  assert.deepEqual(change.activities.map((a) => a.id), ['4000003']);
});

test('two activities in the first post go straight to Follow-up 2, both listed; any type counts', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([EMAIL, AI_SMS]));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 2');
  const change = statusLog(harness);
  assert.deepEqual(change.activities.map((a) => a.type), ['ai_sms', 'email'], 'oldest first');
  assert.equal(harness.oemWrites[0].fields.First_Action_Date, '2026-11-25', 'AI SMS day in Sydney time');
});

test('a third activity on Follow-up 2 changes nothing', async (t) => {
  const harness = harnessFor(t, { lead: { lead_status: 'Follow-up 2' } });
  await receive(harness, post([CALL, SMS, EMAIL]));
  assert.deepEqual(harness.oemWrites, []);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 2');
});

test('a progressed or closed MG status is never replaced by an activity', async (t) => {
  for (const status of ['Contacted', 'Contact in Future', 'Lost Lead', 'Junk Lead', 'Not Qualified', 'Dealer Unavailable']) {
    const harness = harnessFor(t, { lead: { lead_status: status } });
    await receive(harness, post([CALL, SMS]));
    assert.deepEqual(harness.oemWrites, [], status);
    assert.equal(harness.db.tables.leads[0].lead_status, status);
  }
});

test('a status the dealer sets in the same post wins over the activity', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([CALL], { status_type: 'working' }));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
  assert.equal(statusLog(harness).trigger, undefined);

  const lost = harnessFor(t);
  await receive(lost, post([CALL, SMS], { status_type: 'lost' }));
  assert.equal(lost.db.tables.leads[0].lead_status, 'Lost Lead');
});

test('status type "new" with activities still moves the lead to Follow-up', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([CALL], { status_type: 'new' }));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 1');
});

test('a completed test drive in the post wins (Contacted), the activity does not', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([CALL, SMS], { test_drives: [{ status: 'Completed' }] }));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
});

test('forward only: a re-posted "new" or a deleted activity never moves Follow-up back', async (t) => {
  const harness = harnessFor(t, { lead: { lead_status: 'Follow-up 1' } });
  await receive(harness, post([], { status_type: 'new', updated_at: '2026-11-27T03:00:00.000Z' }));
  assert.deepEqual(harness.oemWrites, []);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 1');

  const second = harnessFor(t, { lead: { lead_status: 'Follow-up 2' } });
  await receive(second, post([CALL], { status_type: 'new' }));
  assert.equal(second.db.tables.leads[0].lead_status, 'Follow-up 2');
});

test('First Action Date is not overwritten when MG already has one', async (t) => {
  const harness = harnessFor(t, { oemRecord: { First_Action_Date: '2026-11-01' } });
  await receive(harness, post([CALL]));
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Follow-up 1' });
});

test('flag off: activities are stored and MG is not touched', async (t) => {
  const harness = harnessFor(t, { flag: false });
  const result = await receive(harness, post([CALL, SMS]));
  assert.equal(result.reason, 'NO_STATUS_IN_WEBHOOK');
  assert.deepEqual(harness.oemWrites, []);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Not Contacted');
  assert.equal(harness.db.tables.lead_activities.length, 2);
});

// ------------------------------------------------------------- backfill

function storeActivities(harness, events) {
  events.forEach((e) => harness.db.tables.lead_activities.push({
    zoho_lead_id: 'ZL1', integration_id: '1000', dealer_code: 'AU999', crm_type: 'DEALER_STUDIO',
    source_event_id: String(e.id), event_type: e.event_type, user_name: e.user?.name ?? null,
    event_created_at: e.created_at, deleted_at: null,
  }));
}

test('backfill dry run lists the leads that would move and writes nothing', async (t) => {
  const harness = harnessFor(t);
  storeActivities(harness, [CALL, SMS]);
  const result = await backfillActivityFollowUps(harness.db.app, { dryRun: true, crmService: oemCrmService });
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.updated.map((u) => [u.zohoLeadId, u.from, u.to, u.activities]), [['ZL1', 'Not Contacted', 'Follow-up 2', 2]]);
  assert.deepEqual(harness.oemWrites, []);
});

test('backfill applies through the inbound path with the reason, and is idempotent', async (t) => {
  const harness = harnessFor(t);
  storeActivities(harness, [CALL]);
  const result = await backfillActivityFollowUps(harness.db.app, { crmService: oemCrmService });
  assert.equal(result.updated.length, 1, JSON.stringify(result));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Follow-up 1');
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Follow-up 1', First_Action_Date: '2026-11-25' });
  assert.equal(statusLog(harness).trigger, 'DEALER_ACTIVITY');

  t.mock.method(oemCrmService, 'fetchOemLeadsByIds', async () => [{ Lead_Status: 'Follow-up 1' }]);
  const again = await backfillActivityFollowUps(harness.db.app, { crmService: oemCrmService });
  assert.equal(again.candidates, 0);
});

test('backfill skips a lead whose live MG status has moved on, and refuses to write with the flag off', async (t) => {
  const harness = harnessFor(t);
  storeActivities(harness, [CALL]);
  t.mock.method(oemCrmService, 'fetchOemLeadsByIds', async () => [{ Lead_Status: 'Contacted' }]);
  const result = await backfillActivityFollowUps(harness.db.app, { crmService: oemCrmService });
  assert.deepEqual(result.skipped.map((s) => s.reason), ['LIVE_STATUS_DOES_NOT_QUALIFY']);
  assert.deepEqual(harness.oemWrites, []);

  delete process.env.DEALER_STUDIO_ACTIVITY_FOLLOWUP;
  await assert.rejects(backfillActivityFollowUps(harness.db.app, { crmService: oemCrmService }), { code: 'FEATURE_DISABLED' });
});
