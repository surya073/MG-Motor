'use strict';

/**
 * webhookInfoService.js
 * -----------------------------------------------------------------------
 * The connection details an admin hands to a dealer CRM so it can post its
 * updates back to MG (Dealer CRM page, info icon): the dealer, its CRM, the
 * dealer's webhook URL, the header the CRM authenticates with, and the shared
 * webhook secret of that CRM type from the environment:
 *   AUTOPLAY       AUTOPLAY_WEBHOOK_SECRET       X-Webhook-Token
 *   DEALER_STUDIO  DEALER_STUDIO_WEBHOOK_SECRET  X-API-KEY (or X-Authorization)
 *   FUSION_SD      FUSION_WEBHOOK_SECRET         X-Webhook-Token
 * It says plainly when that secret is not what currently authenticates the
 * dealer (Fusion with FUSION_INBOUND_V2: unsigned dealers, or the dealer's own
 * Standard Webhooks signing secret), so nobody is told a secret is enforced
 * when it is not. Admin only; the secret is never logged.
 */

const {
  getPublicFunctionBaseUrl, getAutoPlayWebhookSecret, getDealerStudioWebhookSecret, getSharedWebhookConfig,
  getFusionUnsignedWebhookDealerCodes, isFusionInboundV2Enabled,
} = require('../../config/env');
const { connectedCrmLabel } = require('./connectedCrmLabel');

function webhookUrlFor(dealerCode) {
  try {
    return `${getPublicFunctionBaseUrl()}/webhooks/dealers/${encodeURIComponent(dealerCode)}`;
  } catch {
    return null; // PUBLIC_FUNCTION_BASE_URL missing or invalid
  }
}

function authFor(integration) {
  const code = String(integration.dealer_code || '').trim().toLowerCase();
  switch (integration.crm_type) {
    case 'AUTOPLAY': {
      const secret = getAutoPlayWebhookSecret() || null;
      return {
        secretName: 'AUTOPLAY_WEBHOOK_SECRET', secret, header: 'X-Webhook-Token', enforced: Boolean(secret),
        note: secret
          ? 'Shared by every AutoPlay dealer. AutoPlay sends it in the X-Webhook-Token header (or as the key of an HMAC-SHA256 X-Signature).'
          : 'AUTOPLAY_WEBHOOK_SECRET is not set, so AutoPlay updates are refused.',
      };
    }
    case 'DEALER_STUDIO': {
      const secret = getDealerStudioWebhookSecret() || null;
      return {
        secretName: 'DEALER_STUDIO_WEBHOOK_SECRET', secret, header: 'X-API-KEY (or X-Authorization)', enforced: Boolean(secret),
        note: secret
          ? "Shared by every Dealer Studio dealer, set as the consumer token in Dealer Studio. If Dealer Studio signs the webhook (X-Signature), the dealer's signing secret saved on this connection is also checked."
          : 'DEALER_STUDIO_WEBHOOK_SECRET is not set; only a signing secret saved on this connection can authenticate.',
      };
    }
    case 'FUSION_SD': {
      const shared = getSharedWebhookConfig();
      const secret = shared.secret || null;
      const base = { secretName: 'FUSION_WEBHOOK_SECRET', secret, header: 'X-Webhook-Token' };
      if (isFusionInboundV2Enabled()) {
        const unsigned = getFusionUnsignedWebhookDealerCodes();
        if (unsigned.has('*') || unsigned.has(code)) {
          return {
            ...base, enforced: false,
            note: 'Not enforced now: this dealer is in FUSION_UNSIGNED_WEBHOOK_DEALER_CODES, so Fusion updates are accepted without a secret or signature.',
          };
        }
        return {
          ...base, enforced: false,
          note: "Not used now: Fusion signs its webhooks with the dealer's own signing secret (whsec_...) saved on this connection.",
        };
      }
      const applies = Boolean(secret) && shared.dealerCodes.has(code);
      return {
        ...base, enforced: applies,
        note: applies
          ? 'Fusion sends it in the X-Webhook-Token header.'
          : "Not used for this dealer: it is not in FUSION_WEBHOOK_DEALER_CODES, so only the dealer's own webhook secret works.",
      };
    }
    default:
      return {
        secretName: null, secret: null, header: 'X-Webhook-Token', enforced: false,
        note: "This CRM type has no shared secret; it authenticates with the dealer's own webhook secret.",
      };
  }
}

/**
 * @param {object} integration - dealer_integrations row
 * @param {object|null} dealer - dealers row (for the name)
 */
function describeWebhook(integration, dealer) {
  return {
    dealerCode: integration.dealer_code,
    dealerName: dealer?.dealer_name || null,
    crmType: integration.crm_type,
    crmLabel: connectedCrmLabel(integration) || integration.crm_type,
    status: integration.status || null,
    webhookUrl: webhookUrlFor(integration.dealer_code),
    method: 'POST',
    ...authFor(integration),
  };
}

module.exports = { describeWebhook };
