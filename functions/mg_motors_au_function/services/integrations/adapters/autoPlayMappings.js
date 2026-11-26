'use strict';

/**
 * autoPlayMappings.js
 * -----------------------------------------------------------------------
 * The default field mapping for AutoPlay (AutoPlay.Api 1.0.0
 * CreateLeadRequest / NestedContactRequest), in the stored shape of
 * integration_field_mappings rows. The admin UI's "Load AutoPlay default map"
 * button (DealerCRMConfig.jsx AUTOPLAY_DEFAULT_FIELD_MAPPINGS) mirrors it by
 * hand: the two deployables share no code.
 *
 * Dotted targets ("contact.email") become nested objects when the request is
 * built (autoPlayAdapter via nestDottedKeys). Fixed and per-dealer values
 * (uniqueIdentifier, origin, dealerId, yardId, sourceId, campaignId) are set
 * by autoPlayPayload.js and autoPlayAdapter.js, not here.
 */

// [MG source field, AutoPlay target, data_type, required, note]
const FIELD_PRESET_ROWS = [
  ['first_name', 'contact.firstName', 'string', false, 'First Name'],
  ['last_name', 'contact.lastName', 'string', false, 'Last Name'],
  ['email_address', 'contact.email', 'string', true, 'Email'],
  ['mobile_number', 'contact.mobile', 'string', true, 'Mobile'],
  ['postcode', 'contact.postcode', 'string', true, 'Postcode'],
  ['receive_marketing_updates', 'contact.optIn', 'boolean', false, 'Marketing opt-in, always sent as true or false'],
  ['accept_privacy_policy', 'privacyPolicyAccepted', 'boolean', true, 'Privacy Policy Accepted'],
  ['customer_message', 'comments', 'string', false, 'Customer Message'],
  ['enquiry_model', 'vehicle.model', 'string', false, 'Model of interest (make is sent as MG)'],
  ['enquiry_id', 'integrationRef', 'string', true, 'MG Enquiry ID, kept by AutoPlay against our credential'],
  ['nature_of_enquiry', 'campaignId', 'string', true, "Nature of Enquiry; decides the campaign (Test Drive -> the dealer's Test Drive campaign id)"],
  // Inbound only: AutoPlay's progress stage is read through this row. MG never
  // sends a status (AutoPlay owns lead progress).
  ['lead_status', 'progressName', 'string', true, 'Lead progress; comes back from AutoPlay only'],
];

const FIELD_PRESET = FIELD_PRESET_ROWS.map(([source_field, target_field, data_type, required, note]) => ({
  source_field, target_field, data_type, required, note,
}));

// AutoPlay progress stage -> MG Lead_Status (inbound only; MG never sends a status).
// The 13 stages read live for AutoPlay dealer 2220 (GET /api/v1/lookups/
// contact-item-progress, 26 Nov 2026), mapped as in
// data/autoplayDocs/MG_X_AutoPlay_Field_Status_Mapping.xlsx, sheet 3 (FI Digital
// proposal, awaiting MG confirmation; Attempted to Contact and Finance Intro are not
// MG statuses in use, so Email Sent and Finance map to Contacted, 26 Nov 2026). The
// Enquiry Outcome part of that sheet (Test
// Drive, Sold/Delivered/Closed - Won -> Retail Order, Closed - Lost -> Lost) is
// applied by the AutoPlay return-update translator, not by these rows.
const INBOUND_STATUS_PRESET = Object.freeze([
  { dealer_status: 'Awaiting Action', mg_status: 'Not Contacted' },
  { dealer_status: 'Email Sent', mg_status: 'Contacted' },
  { dealer_status: 'Phone Call Made', mg_status: 'Contacted' },
  { dealer_status: 'Meet & Qualify', mg_status: 'Contacted' },
  { dealer_status: 'Test Drive', mg_status: 'Contacted' },
  { dealer_status: 'Trade In Valuation/Appraisal', mg_status: 'Contacted' },
  { dealer_status: 'Present Deal', mg_status: 'Contacted' },
  { dealer_status: 'Finance', mg_status: 'Contacted' },
  { dealer_status: 'Sold', mg_status: 'Contacted' },
  { dealer_status: 'Delivered', mg_status: 'Contacted' },
  { dealer_status: 'Follow Up/Referral', mg_status: 'Follow-up 1' },
  { dealer_status: 'Closed - Won', mg_status: 'Contacted' },
  { dealer_status: 'Closed - Lost', mg_status: 'Lost Lead' },
]);

module.exports = { FIELD_PRESET, INBOUND_STATUS_PRESET };
