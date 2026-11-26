'use strict';

// The dealer's CRM provider as MG names it: MG's Connected_CRM field (Leads
// Exchange Activity) and the CRM badge on the portal's lead cards.
const CONNECTED_CRM_LABELS = Object.freeze({
  FUSION_SD: 'Fusion SD',
  DEALER_STUDIO: 'Dealer Studio',
  AUTOPLAY: 'AutoPlay',
  ZOHO_CRM: 'Zoho CRM',
});

function connectedCrmLabel(integration) {
  return CONNECTED_CRM_LABELS[integration?.crm_type] || String(integration?.crm_name || integration?.crm_type || '').trim();
}

module.exports = { CONNECTED_CRM_LABELS, connectedCrmLabel };
