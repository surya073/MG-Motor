'use strict';

const leadMappingService = require('../leadMappingService');

/**
 * autoPlayPayload.js
 * -----------------------------------------------------------------------
 * Outbound shaping for AutoPlay (crm_type = AUTOPLAY), applied by
 * crmIntegrationService.buildOutboundPayload after the generic field mapping.
 * Field NAMES stay in the dealer's field mappings (autoPlayMappings.js holds
 * the default set); this module owns what a mapping cannot express. The
 * AutoPlay ids that belong to the dealer's AutoPlay account (dealerId, yardId,
 * sourceId, campaignId) are added by autoPlayAdapter from the integration row.
 *
 * Agreed with AutoPlay (onboarding email, Nov 2026; AutoPlay.Api 1.0.0
 * CreateLeadRequest):
 *   - uniqueIdentifier = MG's lead id (crm_record_id). Sending it again
 *     returns the lead AutoPlay already created, so a retry never duplicates.
 *   - contact.optIn always sent as true or false (a contact created without
 *     it is opted out). MG's unreadable marketing consent is sent as false.
 *   - origin = "Api" (the only required field).
 *   - Campaigns by id, not name. Only Book a Test Drive has a campaign so far,
 *     so only Test Drive enquiries are sent (campaignFor / MG decision,
 *     26 Nov 2026); every other enquiry type waits for its own campaign.
 *   - AutoPlay owns lead progress, so no MG status is ever sent.
 * The result is still flat; autoPlayAdapter nests dotted keys ("contact.email").
 */

const ORIGIN = 'Api';
const OPT_IN_TARGET = 'contact.optIn';
const PRIVACY_TARGET = 'privacyPolicyAccepted';
const CAMPAIGN_KINDS = Object.freeze({ TEST_DRIVE: 'TEST_DRIVE' });
// Keys a dealer mapping might produce that AutoPlay must never receive from MG.
const KEYS_NEVER_SENT = Object.freeze(['status', 'progressId', 'progressName', 'source', 'campaign', 'dealerRef', 'yard']);
// PATCH /api/v1/leads/{id} takes only these of the create fields (PatchLeadRequest).
const UPDATE_KEYS = Object.freeze(['contact', 'comments', 'privacyPolicyAccepted']);

function norm(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Which AutoPlay campaign an MG lead belongs to, or null when AutoPlay has no
 * campaign for it yet (the lead is then not sent).
 */
function campaignFor(leadRow) {
  return norm(leadRow?.nature_of_enquiry) === 'test drive' ? CAMPAIGN_KINDS.TEST_DRIVE : null;
}

/**
 * @param {object} payload - flat output of mapZohoLeadToExternal
 * @param {object} leadRow - the MG lead (internal field names)
 * @param {object[]} fieldMappings - the dealer's integration_field_mappings rows
 * @returns {object} a new flat payload; the input is not modified
 */
function applyAutoPlayPayloadRules(payload, leadRow, fieldMappings = []) {
  const out = { ...payload };
  const targetOf = (sourceField) => fieldMappings.find((m) => m.source_field === sourceField)?.target_field;

  KEYS_NEVER_SENT.forEach((key) => { delete out[key]; });
  // The campaign comes from the dealer's AutoPlay settings (adapter), chosen by
  // Nature of Enquiry; the raw enquiry text is not an AutoPlay field.
  const natureTarget = targetOf('nature_of_enquiry');
  if (natureTarget) delete out[natureTarget];
  delete out.campaignId;
  delete out.sourceId;
  delete out.dealerId;
  delete out.yardId;

  const uniqueIdentifier = String(leadRow?.crm_record_id ?? '').trim();
  if (uniqueIdentifier) out.uniqueIdentifier = uniqueIdentifier.slice(0, 50);
  out.origin = ORIGIN;

  // Consent: explicit booleans. Marketing opt-in unreadable -> false (AutoPlay
  // treats a missing value as opted out anyway); privacy left out if unreadable.
  const optInSource = Object.hasOwn(out, OPT_IN_TARGET) ? out[OPT_IN_TARGET] : leadRow?.receive_marketing_updates;
  out[OPT_IN_TARGET] = leadMappingService.parseTriState(optInSource) === true;
  const booleanTargets = new Set([PRIVACY_TARGET, ...fieldMappings.filter((m) => m.data_type === 'boolean').map((m) => m.target_field)]);
  booleanTargets.forEach((target) => {
    if (target === OPT_IN_TARGET || !Object.hasOwn(out, target)) return;
    const value = leadMappingService.parseTriState(out[target]);
    if (value === undefined) delete out[target];
    else out[target] = value;
  });

  // A model without a make: AutoPlay matches the vehicle on both, and every MG
  // lead is an MG.
  if (!isBlank(out['vehicle.model']) && isBlank(out['vehicle.make'])) out['vehicle.make'] = 'MG';

  Object.keys(out).forEach((key) => {
    if (isBlank(out[key])) delete out[key];
    else if (typeof out[key] === 'string') out[key] = out[key].trim();
  });
  return out;
}

/** The part of a (nested) create body that PATCH /api/v1/leads/{id} accepts. */
function toUpdateBody(body) {
  const update = {};
  UPDATE_KEYS.forEach((key) => {
    if (body && Object.hasOwn(body, key)) update[key] = body[key];
  });
  return update;
}

module.exports = {
  ORIGIN,
  CAMPAIGN_KINDS,
  campaignFor,
  applyAutoPlayPayloadRules,
  toUpdateBody,
};
