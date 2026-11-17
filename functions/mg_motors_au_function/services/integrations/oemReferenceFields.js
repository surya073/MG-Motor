'use strict';

/**
 * oemReferenceFields.js
 * -----------------------------------------------------------------------
 * The two reference fields MG's OEM Zoho CRM (Leads module) carries for a
 * lead that has been delivered to a dealer:
 *
 *   Dealer_CRM_ID  - the dealer CRM's own record ID for the lead (what the
 *                    dealer's adapter returned from createLead; the same value
 *                    as lead_integrations.external_crm_lead_id and
 *                    leads.dealer_crm_record_id).
 *   Middleware_ID  - this middleware's own identifier for the lead: the
 *                    Catalyst Data Store ROWID of the leads row.
 *
 * Both are written in a separate, best-effort OEM update after the delivery
 * acknowledgement (see crmIntegrationService.stampOemDealerIds), so a rejected
 * write never affects delivery, and by the one-off backfill
 * (oemReferenceBackfillService) for leads delivered before they existed.
 *
 * They are deliberately NOT part of any integration field mapping, so they
 * never enter leadFingerprintService's business state: writing them cannot
 * look like a lead change and cannot restart the OEM <-> dealer echo loop.
 */

const OEM_DEALER_CRM_ID_FIELD = 'Dealer_CRM_ID';
const OEM_MIDDLEWARE_ID_FIELD = 'Middleware_ID';

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * The OEM fields for a delivered lead. A reference that is not known is left
 * out rather than written blank, so a partial call can never erase a value.
 */
function oemReferenceFields({ dealerCrmId, middlewareId } = {}) {
  return {
    ...(hasValue(dealerCrmId) ? { [OEM_DEALER_CRM_ID_FIELD]: String(dealerCrmId).trim() } : {}),
    ...(hasValue(middlewareId) ? { [OEM_MIDDLEWARE_ID_FIELD]: String(middlewareId).trim() } : {}),
  };
}

module.exports = {
  OEM_DEALER_CRM_ID_FIELD,
  OEM_MIDDLEWARE_ID_FIELD,
  oemReferenceFields,
};
