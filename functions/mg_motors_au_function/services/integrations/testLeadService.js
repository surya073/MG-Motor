'use strict';

/**
 * testLeadService.js
 * -----------------------------------------------------------------------
 * Sends ONE clearly marked FI Digital test lead to a connected dealer's CRM
 * through its real adapter, field mapping and credentials, to prove the
 * connection end to end (e.g. that Dealer Studio has authorised our API key
 * for the dealership) before real leads flow.
 *
 * The lead exists only in the request: nothing is written to the leads or
 * lead_integrations tables and nothing is written to MG's CRM. One
 * integration_logs row (operation TEST_LEAD) records the outcome so it shows
 * on the dealer's Logs tab. Test leads carry the FI Digital label in the name
 * and message and an FIDTEST- reference so the dealer can delete them.
 */

const crypto = require('crypto');
const crmAdapterFactory = require('./crmAdapterFactory');
const crmIntegrationService = require('./crmIntegrationService');
const logger = require('../../utils/logger');

const MESSAGE = 'FI DIGITAL TEST LEAD ONLY - please ignore and delete. Sent by FI Digital to check the MG Lead Exchange connection.';

// Each test lead gets its own email and mobile (from its reference), so a CRM that
// joins a new lead onto the same customer's open lead (AutoPlay does) still
// creates a new one. The name can be set per send ("FI Digital" + lastName).
function cleanName(value, fallback) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9 .'-]/g, '').trim().slice(0, 40);
  return text || fallback;
}

function testLeadFor(dealerCode, reference, { firstName, lastName } = {}) {
  const first = cleanName(firstName, 'FI Digital');
  const last = cleanName(lastName, 'Test Lead');
  const digits = reference.replace(/\D/g, '').slice(-8).padStart(8, '0');
  return {
    crm_record_id: reference,
    enquiry_id: reference,
    customer_name: `${first} ${last}`,
    first_name: first,
    last_name: last,
    email_address: `fidigital.testlead+${digits}@example.com`,
    mobile_number: `04${digits}`,
    postcode: '3000',
    vehicle_model: 'MG ZS',
    enquiry_model: 'MG ZS',
    nature_of_enquiry: 'Test Drive',
    lead_department: 'Sales',
    lead_source: 'OEM AU Website',
    customer_message: MESSAGE,
    dealer_code: dealerCode,
    accept_privacy_policy: true,
    receive_marketing_updates: false,
    lead_status: 'Not Contacted',
  };
}

async function writeTestLog(catalystApp, integration, fields) {
  try {
    await catalystApp.datastore().table('integration_logs').insertRow({
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation: 'TEST_LEAD',
      ...fields,
    });
  } catch (err) {
    logger.error('testLeadService', `Could not log the test lead for dealer ${integration.dealer_code}`, err);
  }
}

/**
 * @returns {Promise<{dealerCode, ok, reference, externalLeadId?, httpStatus?, error?}>}
 */
async function sendTestLead(catalystApp, dealerCode, names = {}) {
  const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
  if (!integration || integration.integration_type !== 'EXTERNAL_CRM') {
    return { dealerCode, ok: false, error: 'INTEGRATION_NOT_CONFIGURED' };
  }
  const reference = `FIDTEST-${dealerCode}-${Date.now()}`;
  const [fieldMappings, statusMappings] = await Promise.all([
    crmIntegrationService.getFieldMappings(catalystApp, integration.ROWID),
    crmIntegrationService.getStatusMappings(catalystApp, integration.ROWID),
  ]);
  if (fieldMappings.length === 0) {
    return { dealerCode, ok: false, reference, error: 'NO_FIELD_MAPPINGS' };
  }

  try {
    const payload = crmIntegrationService.buildOutboundPayload(testLeadFor(dealerCode, reference, names), fieldMappings, statusMappings, {
      crmType: integration.crm_type,
      operation: 'CREATE_LEAD',
    });
    const adapter = crmAdapterFactory.getAdapter(integration.crm_type);
    const result = await adapter.createLead(catalystApp, integration, payload, { idempotencyKey: crypto.randomUUID() });
    await writeTestLog(catalystApp, integration, {
      status: 'SUCCESS',
      external_lead_id: result.externalLeadId ? String(result.externalLeadId) : null,
      request_reference: reference,
    });
    logger.info('testLeadService', `FI Digital test lead ${reference} created for dealer ${dealerCode} (${integration.crm_type} lead ${result.externalLeadId || 'id not returned'})`);
    return { dealerCode, ok: true, reference, externalLeadId: result.externalLeadId || null, httpStatus: result.httpStatus };
  } catch (err) {
    const error = String(err.message || err.code || 'TEST_LEAD_FAILED').slice(0, 300);
    await writeTestLog(catalystApp, integration, { status: 'FAILED', error_message: error, request_reference: reference });
    logger.error('testLeadService', `FI Digital test lead ${reference} failed for dealer ${dealerCode}: ${error}`);
    return { dealerCode, ok: false, reference, httpStatus: err.response?.status || null, error };
  }
}

module.exports = { sendTestLead, MESSAGE, _test: { testLeadFor } };
