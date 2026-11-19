'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { getZohoConfig, isFusionInboundV2Enabled } = require('../config/env');
const { syncDealersCoalesced } = require('../services/dealerSyncService');
const { syncLeadsByIds, syncModifiedLeads } = require('../services/leadSyncService');
const zohoCrmService = require('../services/zohoCrmService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const webhookVerificationService = require('../services/integrations/webhookVerificationService');
const fusionReturnChannelProof = require('../services/integrations/fusionReturnChannelProof');
const dealerStudioLocationRouting = require('../services/integrations/dealerStudioLocationRouting');
const writeOwnership = require('../services/writeOwnership');
const logger = require('../utils/logger');
const usageContext = require('../services/usageContext');

const router = express.Router();

function isFusionV2(integration) {
  return integration?.crm_type === 'FUSION_SD' && isFusionInboundV2Enabled();
}

function isEnabled(value) {
  return !(
    value === false || value === 0 ||
    String(value).toLowerCase() === 'false' || String(value) === '0'
  );
}

// A proof write is ancillary to an already completed webhook. Keep a
// failed proof store from changing its successful HTTP acknowledgement.
async function recordReturnChannelProof(catalystApp, integration, authResult, duplicate) {
  if (!isFusionV2(integration) || authResult.method !== 'STANDARD_WEBHOOKS') return;
  try {
    if (duplicate) {
      await fusionReturnChannelProof.recordVerifiedDuplicate(
        catalystApp, integration, authResult, duplicate.eventId, duplicate.rawBody
      );
    } else {
      await fusionReturnChannelProof.recordVerifiedSuccess(catalystApp, integration, authResult);
    }
  } catch {
    logger.error('webhookRoutes', `Could not preserve signed return-channel proof for integration ${integration.ROWID}`);
  }
}

// What a Leads notification did, for its usage line: counts and labels only.
function crmNotifyUsage(body, ids, result) {
  const counts = {
    fetched: result?.totalRecordsFetched ?? 0,
    inserted: result?.recordsInserted ?? 0,
    updated: result?.recordsUpdated ?? 0,
    unchanged: result?.recordsUnchanged ?? 0,
    failed: result?.recordsFailed ?? 0,
    removed: result?.recordsRemoved ?? 0,
  };
  let outcome = 'unchanged';
  if (counts.failed > 0) outcome = counts.inserted + counts.updated + counts.removed > 0 ? 'partial' : 'failed';
  else if (counts.inserted + counts.updated + counts.removed > 0) outcome = 'changed';
  return {
    trigger: 'Zoho CRM',
    module: 'Leads',
    operation: String(body?.operation || '') || null,
    ids: ids.length,
    outcome,
    result: counts,
  };
}

/**
 * What a sync run did, as one outcome (OEM review 4.5): HTTP 200 alone said
 * only that the request was handled, even when records failed.
 *   processed  something changed and nothing failed
 *   unchanged  nothing to change
 *   partial    some records applied, some failed
 *   failed     records failed and none applied (or the run itself failed)
 *   deferred   accepted and queued (a coalesced Dealers sync runs later)
 * The failed OEM record ids are returned and logged. They need no separate
 * store: a webhook run never advances the incremental sweep's checkpoint, so
 * the next /cron/sync-modified-leads run re-reads them.
 */
function syncOutcome(result) {
  if (result?.skipped || result?.pending) return { outcome: 'deferred', failedIds: [] };
  const failed = Number(result?.recordsFailed || 0);
  const applied = Number(result?.recordsInserted || 0) + Number(result?.recordsUpdated || 0) + Number(result?.recordsRemoved || 0);
  const failedIds = [...new Set((Array.isArray(result?.errors) ? result.errors : [])
    .map((e) => e?.crm_record_id).filter((id) => id && id !== 'UNKNOWN').map(String))];
  if (result?.status === 'Failed' && failed === 0 && applied === 0) return { outcome: 'failed', failedIds };
  if (failed > 0) return { outcome: applied > 0 ? 'partial' : 'failed', failedIds };
  return { outcome: applied > 0 ? 'processed' : 'unchanged', failedIds };
}

// One structured line per notification: who handled it, for which channel and
// module, and how it ended. No token and no customer data.
function logNotification(fields) {
  const { projectId, environment } = writeOwnership.currentProject();
  const line = {
    event: 'crm_notify',
    project: projectId,
    environment,
    cid: usageContext.currentCid(),
    ...fields,
  };
  const log = ['failed', 'partial', 'rejected', 'error'].includes(fields.outcome) ? logger.error : logger.info;
  log('webhookRoutes', JSON.stringify(line));
}

router.post('/webhooks/crm-notify', express.json(), async (req, res) => {
  const channelId = req.body?.channel_id === undefined || req.body?.channel_id === null
    ? null : String(req.body.channel_id).slice(0, 40);
  const moduleName = typeof req.body?.module === 'string' ? req.body.module.slice(0, 40) : null;
  const operation = typeof req.body?.operation === 'string' ? req.body.operation.slice(0, 20) : null;
  try {
    const { webhookToken } = getZohoConfig();
    const incomingToken = req.body?.token;

    if (!webhookVerificationService.verifyZohoWatchToken(incomingToken, webhookToken)) {
      logger.error('webhookRoutes', 'Rejected webhook call with invalid/missing token');
      logNotification({ outcome: 'rejected', channelId, module: moduleName, operation });
      return res.status(401).json({ error: 'Invalid token' });
    }

    usageContext.annotate({ trigger: 'Zoho CRM', module: moduleName || null });
    const catalystApp = usageContext.initialize(catalyst, req);

    if (moduleName === 'Dealers') {
      const result = await syncDealersCoalesced(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
      const { outcome, failedIds } = syncOutcome(result);
      logNotification({ outcome, channelId, module: moduleName, operation, records: null, failed: failedIds.length });
      return res.status(outcome === 'deferred' ? 202 : 200).json({ received: true, outcome, failedIds, result });
    } else if (moduleName === 'Leads') {
      // Zoho's notification names the affected records, so only those are
      // re-read — never the whole OEM lead history. A notification without
      // ids falls back to the modified-since sweep rather than a full sync.
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
      const result = ids.length > 0
        ? await syncLeadsByIds(catalystApp, ids, { operation: req.body?.operation, trigger: 'Webhook', triggeredBy: 'Zoho CRM' })
        : await syncModifiedLeads(catalystApp, { triggeredBy: 'Zoho CRM' });
      usageContext.annotate(crmNotifyUsage(req.body, ids, result));
      const { outcome, failedIds } = syncOutcome(result);
      logNotification({
        outcome, channelId, module: moduleName, operation, records: ids.length || null,
        failed: failedIds.length, ...(failedIds.length ? { failedIds: failedIds.slice(0, 20) } : {}),
      });
      return res.status(200).json({ received: true, outcome, failedIds, result });
    }

    logger.info('webhookRoutes', `Notification for unhandled module: ${moduleName}`);
    logNotification({ outcome: 'ignored', channelId, module: moduleName, operation });
    return res.status(202).json({ received: true, outcome: 'ignored', ignored: true });
  } catch (err) {
    logger.error('webhookRoutes', 'Webhook processing failed', err);
    logNotification({ outcome: 'error', channelId, module: moduleName, operation, error: String(err?.code || 'SYNC_FAILED').slice(0, 60) });
    if (!res.headersSent) return res.status(502).json({ received: false, outcome: 'error', error: 'SYNC_FAILED' });
  }
});

router.post('/webhooks/dealers/:dealerCode', express.raw({ type: 'application/json' }), async (req, res) => {
  const catalystApp = usageContext.initialize(catalyst, req);
  const { dealerCode } = req.params;
  const rawBody = req.body; // Buffer
  usageContext.annotate({ dealerCode });

  try {
    const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
    if (!dealer || dealer.sync_status === 'Removed') return res.status(404).json({ error: 'DEALER_NOT_FOUND' });

    let integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration || integration.integration_type !== 'EXTERNAL_CRM'
      || ['DISABLED', 'NOT_CONFIGURED', 'CONFIGURING'].includes(integration.status)
      || !isEnabled(integration.inbound_enabled)) {
      return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    }

    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const authResult = await webhookVerificationService.verifyWebhook(catalystApp, integration, rawBody, headers);
    if (!authResult.ok) {
      logger.error('webhookRoutes', `Webhook auth failed for ${dealerCode}: ${authResult.reason}`);
      return res.status(401).json({ error: 'WEBHOOK_AUTH_FAILED' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'INVALID_CRM_CONFIGURATION' });
    }

    // One Dealer Studio account posts all its locations to one MG dealer's URL
    // (Heartland: Castle Hill and Penrith). Verified with that dealer's secret
    // above; the cluster then goes to the MG dealer of the same account it names.
    if (integration.crm_type === 'DEALER_STUDIO') {
      const routed = await dealerStudioLocationRouting.resolveTargetIntegration(catalystApp, integration, payload);
      if (routed.integration !== integration) {
        logger.info('webhookRoutes', `Dealer Studio post on ${dealerCode}'s URL routed to ${routed.integration.dealer_code} by ${routed.routedBy}`);
        usageContext.annotate({ dealerCode: routed.integration.dealer_code, routedFrom: dealerCode });
        integration = routed.integration;
      }
    }

    // Fusion's dealer_id is MG's dealer code only if MG gave Fusion one, and
    // Fusion's own id otherwise (Q18). The signing secret already proves the
    // dealer, so a mismatch is only logged, unless it names another MG dealer.
    if (isFusionV2(integration) && payload && typeof payload.dealer_id === 'string' && payload.dealer_id.trim()) {
      const claimed = payload.dealer_id.trim();
      if (claimed.toLowerCase() !== String(dealerCode).toLowerCase()) {
        const otherDealer =
          (await crmIntegrationService.findDealerByCode(catalystApp, claimed)) ||
          (claimed !== claimed.toUpperCase() ? await crmIntegrationService.findDealerByCode(catalystApp, claimed.toUpperCase()) : null);
        if (otherDealer) {
          logger.error('webhookRoutes', `Fusion webhook on ${dealerCode}'s URL names another MG dealer (${claimed}); refused`);
          return res.status(401).json({ error: 'WEBHOOK_DEALER_MISMATCH' });
        }
        logger.info('webhookRoutes', `Fusion webhook for ${dealerCode} carries dealer_id "${claimed}" (Fusion's own id); accepted`);
      }
    }

    if (integration.crm_type === 'ZOHO_CRM' && payload.module !== 'Leads') {
      return res.status(422).json({ error: 'UNSUPPORTED_WEBHOOK_MODULE' });
    }

    // payload.id / payload.leadId identify the dealer RECORD, not this
    // webhook delivery. Using either as the dedupe key drops every later
    // status change for that lead. Prefer a real event id; when none exists,
    // process the delivery and let canonical state/no-change checks provide
    // idempotence (Zoho envelopes for two real changes can be byte-identical).
    const eventId =
      payload.event_id ||
      payload.eventId ||
      headers['x-event-id'] ||
      headers['x-webhook-id'] ||
      // Fusion SD's Standard Webhooks id: unique per event, repeated on a
      // retry (Batch 5, FUSION_INBOUND_V2 only).
      (isFusionV2(integration) ? headers['webhook-id'] : null) ||
      null;
    // The dealer lead the event is about, kept with a stored event so it can
    // be replayed (Batch 6, INBOUND_EVENT_STORE, Fusion SD only).
    // Trimmed, as the translator and the replay sweep read it.
    const rawLeadId = (payload && typeof payload === 'object')
      ? (payload.lead_id || payload.id || payload.leadId)
      : null;
    const externalLeadId = rawLeadId === undefined || rawLeadId === null ? null : (String(rawLeadId).trim() || null);
    const { isDuplicate, inProgress, eventRowId, replayable } = await crmIntegrationService.checkAndRecordWebhookEvent(
      catalystApp, integration, rawBody, eventId, { externalLeadId }
    );

    if (inProgress) {
      return res.status(202).json({ ok: true, status: 'IN_PROGRESS' });
    }
    if (isDuplicate) {
      await recordReturnChannelProof(catalystApp, integration, authResult, { eventId, rawBody });
      return res.status(200).json({ ok: true, status: 'DUPLICATE' });
    }

    try {
      const result = await crmIntegrationService.processInboundWebhook(catalystApp, integration, payload, zohoCrmService);
      const pending = result?.held && !result?.terminal;
      // Deferred work is acknowledged only once its recovery copy is stored
      // (OEM review 4.3). Without one the event is marked FAILED and the
      // sender is asked to deliver it again (503), which reprocesses it.
      if (pending && replayable === false) {
        await crmIntegrationService.markWebhookEventStatus(catalystApp, eventRowId, 'FAILED', `NOT_REPLAYABLE:${result.reason || 'HELD'}`);
        logger.error('webhookRoutes', `Held event for ${integration.dealer_code} could not be stored for replay; asking the sender to retry`);
        return res.status(503).json({ error: 'RETRY_LATER', reason: 'EVENT_NOT_STORED' });
      }
      await crmIntegrationService.markWebhookEventStatus(
        catalystApp,
        eventRowId,
        pending ? 'PENDING' : 'SUCCESS',
        result?.terminal ? `TERMINAL:${result.reason}` : (pending ? result.reason : undefined)
      );
      if (!pending && !result?.terminal) await recordReturnChannelProof(catalystApp, integration, authResult);
      res.status(pending ? 202 : 200).json({ ok: true, result });
    } catch (err) {
      const deferred = err.code === 'LEAD_MAPPING_NOT_FOUND';
      // A deferred event with no stored recovery copy is not acknowledged:
      // FAILED, and 503 so the sender delivers it again (OEM review 4.3).
      const recoverable = deferred && replayable !== false;
      await crmIntegrationService.markWebhookEventStatus(
        catalystApp,
        eventRowId,
        recoverable ? 'PENDING' : 'FAILED',
        err.message
      );
      if (deferred && !recoverable) return res.status(503).json({ error: 'RETRY_LATER', reason: 'EVENT_NOT_STORED' });
      const status = recoverable
        ? 202
        : ([
            'FIELD_MAPPING_INVALID',
            'STATUS_MAPPING_NOT_FOUND',
            'STATUS_MAPPING_INVALID_TARGET',
            'STATUS_MAPPING_AMBIGUOUS',
          ].includes(err.code) ? 422 : 500);
      res.status(status).json({ error: err.code || 'INTERNAL_ERROR' });
    }
  } catch (err) {
    logger.error('webhookRoutes', `Dealer webhook failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
