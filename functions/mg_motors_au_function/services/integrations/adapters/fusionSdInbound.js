'use strict';

/**
 * fusionSdInbound.js
 * -----------------------------------------------------------------------
 * Translates a Fusion SD (AMS-Pro) webhook into the record the shared inbound
 * path (crmIntegrationService.processResolvedInboundLead) expects
 * (FUSION_REMEDIATION_PLAN.md, Batch 5; used only with FUSION_INBOUND_V2).
 *
 * Fusion posts the flat PushedLead body (lead-api-mg-motors-openapi 3.yaml,
 * `webhooks`): no envelope, `lead_id` always present, every other field
 * possibly narrowed away, and null meaning "no value / unknown".
 *
 * Only the status comes back to MG (Q16, 13 Oct 2026). Fusion's other fields
 * either have no MG home (names, origin, enquiry type), would overwrite what
 * MG sent with the dealer's own vocabulary (lead_source -> Nature of Enquiry,
 * model), differ only in formatting (phone, which would raise Unhappy 6), or
 * are consent, which MG owns. The status is keyed by the dealer's status
 * mapping target (enquiryStatus in the Fusion preset), so the existing status
 * map, holds and logging apply unchanged. A null or blank status is left out:
 * it is unknown, not a change.
 *
 * Fusion's reworked webhooks (28 Oct 2026) send the status as `enquiryStatus`
 * and the id as `leadId` as well as `lead_id`, not the spec's `status`; either
 * name is read, the spec's first.
 */

const { getFusionInboundEditFields } = require('../../../config/env');
const { TEST_DRIVE_AT, latestTimestamp } = require('./testDriveDate');

const DEFAULT_STATUS_TARGET = 'enquiryStatus';
const CUSTOMER_NAME_TARGET = '__customerName';

// A completed Fusion test drive is MG Enquiry Outcome "Test Drive". It travels
// under a private key with its own mapping row, never the dealer's outbound
// enquiry_outcome target (activity.subType), which means something else.
const OUTCOME_TARGET = '__fusionEnquiryOutcome';
const TEST_DRIVE_OUTCOME = 'Test Drive';
// test_drive.status is the dealer's own free text: only a word that clearly
// means the drive took place counts. Booked / scheduled ones change nothing.
const COMPLETED_TEST_DRIVE_STATUS = /\b(completed?|done|finished|returned|checked[\s_-]?in)\b/i;

/**
 * When the lead's completed test drive happened, from the webhook's test-drive
 * blocks (lead-api-mg-motors-openapi 3.yaml, PushedLead; the dealer must switch
 * the test-drive / activity blocks on):
 *   - test_drive: the newest test drive, { status, starts_at, ends_at };
 *   - activities[]: { kind: "testdrive", completed: true, starts_at, ends_at }.
 * Returns the latest completed drive's end (else start) time, or null when no
 * completed test drive is in the body. `found` says whether one is, even undated.
 */
function completedTestDrive(body) {
  const dates = [];
  let found = false;
  const drive = body.test_drive;
  if (drive && typeof drive === 'object' && !Array.isArray(drive)
    && COMPLETED_TEST_DRIVE_STATUS.test(String(drive.status ?? ''))) {
    found = true;
    dates.push(text(drive.ends_at) ?? text(drive.starts_at));
  }
  for (const activity of Array.isArray(body.activities) ? body.activities.slice(0, 50) : []) {
    if (!activity || typeof activity !== 'object') continue;
    if (String(activity.kind ?? '').toLowerCase().replace(/[\s_-]/g, '') !== 'testdrive' || activity.completed !== true) continue;
    found = true;
    dates.push(text(activity.ends_at) ?? text(activity.starts_at));
  }
  return { found, at: found ? latestTimestamp(dates) : null };
}

// Fusion's body is nested ({ contact: { firstName } }) while the mapping names the
// field with a dotted path ("contact.firstName"); a flat dotted key is read too.
function valueAtPath(body, path) {
  if (Object.prototype.hasOwnProperty.call(body, path)) return body[path];
  let current = body;
  for (const part of String(path).split('.')) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * @param {object} payload - the parsed webhook body
 * @param {object[]} fieldMappings - the dealer's integration_field_mappings rows
 * @returns {{ externalLeadId: string|null, dealerId: string|null, record: object }}
 */
function translateFusionWebhook(payload, fieldMappings = []) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const statusTarget = fieldMappings.find((m) => m.source_field === 'lead_status')?.target_field || DEFAULT_STATUS_TARGET;

  const record = {};
  // The spec's name, Fusion's current one, then the field this dealer's own
  // status mapping names, so a dealer mapped to another field is still read.
  const status = text(body.status) ?? text(body.enquiryStatus) ?? text(body[statusTarget]);
  if (status !== null) record[statusTarget] = status;
  // When Fusion sent it; shown with the status change on the lead timeline.
  const pushedAt = text(body.pushed_at);
  if (pushedAt !== null && Object.keys(record).length > 0) record.modified_at = pushedAt;

  // Field edits (contact details the dealer corrected). Only the fields allowed by
  // FUSION_INBOUND_EDIT_FIELDS, only those the dealer's own map names, and only a
  // real value: null or blank means unknown, not "clear it".
  const editable = new Set(getFusionInboundEditFields());
  const fieldTargets = [];
  const syntheticMappings = [];
  const nameParts = {};
  for (const mapping of fieldMappings) {
    if (!editable.has(mapping.source_field) || !mapping.target_field) continue;
    const value = text(valueAtPath(body, mapping.target_field));
    if (value === null) continue;
    // MG holds one name (Zoho's First_Name and Last_Name are written from customer_name),
    // so the two parts count only when both arrive in the same webhook.
    if (mapping.source_field === 'first_name' || mapping.source_field === 'last_name') {
      nameParts[mapping.source_field] = value;
      continue;
    }
    record[mapping.target_field] = value;
    fieldTargets.push(mapping.target_field);
  }
  if (nameParts.first_name && nameParts.last_name) {
    record[CUSTOMER_NAME_TARGET] = `${nameParts.first_name} ${nameParts.last_name}`;
    fieldTargets.push(CUSTOMER_NAME_TARGET);
    syntheticMappings.push({ source_field: 'customer_name', target_field: CUSTOMER_NAME_TARGET, data_type: 'string', required: false });
  }
  if (pushedAt !== null && fieldTargets.length > 0 && !('modified_at' in record)) record.modified_at = pushedAt;

  // A completed test drive: MG Enquiry Outcome "Test Drive", dated when it happened.
  const testDrive = completedTestDrive(body);
  if (testDrive.found) {
    record[OUTCOME_TARGET] = TEST_DRIVE_OUTCOME;
    syntheticMappings.push({ source_field: 'enquiry_outcome', target_field: OUTCOME_TARGET, data_type: 'string', required: false });
    if (testDrive.at !== null) record[TEST_DRIVE_AT] = testDrive.at;
    if (pushedAt !== null && !('modified_at' in record)) record.modified_at = pushedAt;
  }

  // Why it was lost (28 Oct 2026). Kept apart from the mapped record: it is
  // written to MG's lost-reason fields only when the status lands as Lost.
  const lostReason = status !== null ? text(body.lostReason) : null;
  const lostSubReason = lostReason !== null ? text(body.lostSubReason) : null;

  return {
    externalLeadId: text(body.lead_id) ?? text(body.leadId),
    dealerId: text(body.dealer_id),
    record,
    statusTarget,
    fieldTargets,
    syntheticMappings,
    hasTestDrive: testDrive.found,
    lost: lostReason !== null ? { reason: lostReason, subReason: lostSubReason, at: pushedAt } : null,
  };
}

module.exports = { translateFusionWebhook, DEFAULT_STATUS_TARGET, OUTCOME_TARGET };
