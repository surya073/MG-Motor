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
];

const FIELD_PRESET = FIELD_PRESET_ROWS.map(([source_field, target_field, data_type, required, note]) => ({
  source_field, target_field, data_type, required, note,
}));

module.exports = { FIELD_PRESET };
