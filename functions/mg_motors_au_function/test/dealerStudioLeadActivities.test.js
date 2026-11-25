'use strict';

// Dealer Studio lead_events (calls, SMS, emails, notes) are stored in
// lead_activities for the portal, and never written to MG's CRM. Payload shape
// from Dealer Studio's real v3 update of 25 Nov 2026 (customer and staff details replaced).

const test = require('node:test');
const assert = require('node:assert/strict');

const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const leadActivityService = require('../services/integrations/leadActivityService');
const oemCrmService = require('../services/zohoCrmService');
const { translateDealerStudioWebhook } = require('../services/integrations/adapters/dealerStudioInbound');
const { FIELD_PRESET, INBOUND_STATUS_PRESET } = require('../services/integrations/adapters/dealerStudioMappings');
const { setupOutbound } = require('./helpers/outboundHarness');

const DS_LEAD_ID = '100001';

function harnessFor(t, { withTable = true } = {}) {
  const harness = setupOutbound(t, {
    integration: { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads', inbound_enabled: true, webhook_enabled: true },
    mapping: { external_crm_lead_id: DS_LEAD_ID },
    lead: { lead_status: 'Not Contacted' },
  });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET.map((row) => ({ integration_id: '1000', ...row })));
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...INBOUND_STATUS_PRESET.map(({ dealer_status, mg_status }) => ({
    integration_id: '1000', source_status: dealer_status, target_status: mg_status, direction: 'EXTERNAL_TO_ZOHO',
  })));
  harness.db.tables.notifications = [];
  if (withTable) harness.db.tables.lead_activities = [];
  return harness;
}

const receive = (harness, payload) =>
  crmIntegrationService.processInboundWebhook(harness.db.app, harness.integration, payload, oemCrmService);

const AI_SMS = { id: 4000001, created_at: '2026-11-24T23:25:50.601Z', event_type: 'ai_sms', updated_at: '2026-11-24T23:25:50.601Z', description: 'Mia sent an AI SMS to customer', followup_status: 'not_required' };
const CALL = { id: 4000002, user: { id: 5001, name: 'Sam Taylor' }, created_at: '2026-11-25T00:39:49.341Z', event_type: 'phone', updated_at: '2026-11-25T00:39:49.341Z', description: 'Called left message', followup_status: 'not_required' };
const SMS = { id: 4000003, user: { id: 5001, name: 'Sam Taylor' }, created_at: '2026-11-25T00:39:57.036Z', event_type: 'sms', updated_at: '2026-11-25T00:39:57.036Z', description: 'Sent text', followup_status: 'not_required' };

// An activity-only post: no status_type, so nothing for MG's CRM.
const post = (events, updatedAt = '2026-11-25T00:39:57.047Z', extra = {}) => ({
  id: 1000001,
  provider: 'Dealer Studio',
  updated_at: updatedAt,
  leads: [{ id: DS_LEAD_ID, provider: { id: 'ENQ-1', name: 'MG Leads Exchange' } }],
  lead_events: events,
  ...extra,
});

const live = (harness) => harness.db.tables.lead_activities.filter((row) => !row.__deleted && !row.deleted_at);

// ------------------------------------------------------------- translator

test('translator: lead_events are read with type, description, user and times', () => {
  const out = translateDealerStudioWebhook(post([AI_SMS, CALL, { event_type: 'note' }, null, 'x']));
  assert.equal(out.hasLeadEvents, true);
  assert.equal(out.leadEventsComplete, true);
  assert.equal(out.snapshotAt, '2026-11-25T00:39:57.047Z');
  assert.deepEqual(out.leadEvents, [
    { sourceEventId: '4000001', eventType: 'ai_sms', description: 'Mia sent an AI SMS to customer', userName: null, followupStatus: 'not_required', createdAt: AI_SMS.created_at, updatedAt: AI_SMS.updated_at },
    { sourceEventId: '4000002', eventType: 'phone', description: 'Called left message', userName: 'Sam Taylor', followupStatus: 'not_required', createdAt: CALL.created_at, updatedAt: CALL.updated_at },
  ]);
  // Activities alone are not an update for MG's CRM.
  assert.equal(out.hasUpdate, false);
});

test('translator: a post without lead_events says nothing about them', () => {
  const out = translateDealerStudioWebhook({ id: 1, status_type: 'working' });
  assert.equal(out.hasLeadEvents, false);
  assert.deepEqual(out.leadEvents, []);
});

// ------------------------------------------------------------- end to end

test('an activity-only post stores the activities and writes nothing to MG', async (t) => {
  const harness = harnessFor(t);
  const result = await receive(harness, post([AI_SMS, CALL, SMS]));
  assert.equal(result.reason, 'NO_STATUS_IN_WEBHOOK');
  assert.deepEqual(harness.oemWrites, []);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Not Contacted');
  assert.deepEqual(live(harness).map((row) => [row.zoho_lead_id, row.source_event_id, row.event_type, row.dealer_code, row.crm_type]), [
    ['ZL1', '4000001', 'ai_sms', 'AU999', 'DEALER_STUDIO'],
    ['ZL1', '4000002', 'phone', 'AU999', 'DEALER_STUDIO'],
    ['ZL1', '4000003', 'sms', 'AU999', 'DEALER_STUDIO'],
  ]);
});

test('activities are stored alongside a status change in the same post', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([CALL], undefined, { status_type: 'Working', lead_status_option: { name: 'Attempted Contact', status_type: 'working' } }));
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
  assert.deepEqual(live(harness).map((row) => row.source_event_id), ['4000002']);
});

test('the same list posted again creates no duplicates and no writes', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([AI_SMS, CALL]));
  const before = JSON.stringify(harness.db.tables.lead_activities);
  await receive(harness, post([AI_SMS, CALL], '2026-11-25T01:00:00.000Z'));
  assert.equal(JSON.stringify(harness.db.tables.lead_activities), before);
});

test('a grouped SMS that grows is updated in place', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([SMS]));
  await receive(harness, post([{ ...SMS, description: 'Sent text (2 messages)', updated_at: '2026-11-25T00:45:00.000Z' }], '2026-11-25T00:45:00.100Z'));
  assert.equal(live(harness).length, 1);
  assert.equal(live(harness)[0].description, 'Sent text (2 messages)');
  assert.equal(live(harness)[0].event_updated_at, '2026-11-25T00:45:00.000Z');
});

test('an activity missing from a newer post is marked deleted, and comes back if re-sent', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([AI_SMS, CALL]));
  await receive(harness, post([AI_SMS], '2026-11-25T02:00:00.000Z'));
  assert.deepEqual(live(harness).map((row) => row.source_event_id), ['4000001']);
  const deleted = harness.db.tables.lead_activities.find((row) => row.source_event_id === '4000002');
  assert.equal(deleted.deleted_at, '2026-11-25T02:00:00.000Z');

  await receive(harness, post([AI_SMS, CALL], '2026-11-25T03:00:00.000Z'));
  assert.deepEqual(live(harness).map((row) => row.source_event_id), ['4000001', '4000002']);
});

test('a late, older post neither deletes nor overwrites what a newer post wrote', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([AI_SMS, { ...SMS, description: 'newer text' }], '2026-11-25T05:00:00.000Z'));
  // Older snapshot: SMS had its old description and AI SMS did not exist yet.
  await receive(harness, post([SMS], '2026-11-25T04:00:00.000Z'));
  assert.deepEqual(live(harness).map((row) => [row.source_event_id, row.description]), [
    ['4000001', 'Mia sent an AI SMS to customer'],
    ['4000003', 'newer text'],
  ]);
});

test('a post without lead_events leaves stored activities alone', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([CALL]));
  await receive(harness, { id: 1000001, updated_at: '2026-11-26T00:00:00.000Z', status_type: 'working', leads: [{ id: DS_LEAD_ID }] });
  assert.deepEqual(live(harness).map((row) => row.source_event_id), ['4000002']);
});

test('activities of a lead MG does not know are not stored', async (t) => {
  const harness = harnessFor(t);
  const result = await receive(harness, post([CALL], undefined, { leads: [{ id: '999999' }] }));
  assert.equal(result.reason, 'NO_STATUS_IN_WEBHOOK');
  assert.deepEqual(harness.db.tables.lead_activities, []);
});

test('without the lead_activities table the webhook still applies the status', async (t) => {
  const harness = harnessFor(t, { withTable: false });
  const result = await receive(harness, post([CALL], undefined, { status_type: 'working' }));
  assert.equal(result.ok, true);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
});

// ------------------------------------------------------------- reading

test('getLeadActivities: oldest first, deleted ones left out', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, post([SMS, AI_SMS, CALL]));
  await receive(harness, post([SMS, AI_SMS], '2026-11-25T02:00:00.000Z'));
  const { available, activities } = await leadActivityService.getLeadActivities(harness.db.app, 'ZL1');
  assert.equal(available, true);
  assert.deepEqual(activities.map((a) => [a.id, a.event_type, a.user_name]), [
    ['4000001', 'ai_sms', null],
    ['4000003', 'sms', 'Sam Taylor'],
  ]);
});

test('getLeadActivities: no table means not available, not an error', async (t) => {
  const harness = harnessFor(t, { withTable: false });
  assert.deepEqual(await leadActivityService.getLeadActivities(harness.db.app, 'ZL1'), { available: false, activities: [] });
});
