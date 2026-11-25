'use strict';

// "Remove connection" on the Dealer CRM page (integrationRemovalService).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { removeDealerIntegration } = require('../services/integrations/integrationRemovalService');

// Two integrations: 1000 (to remove) and 1001 (another dealer, must be untouched).
function seed({ leads = [], channels = [] } = {}) {
  const db = createInMemoryZcql({
    dealer_integrations: [
      { dealer_code: '3029012', crm_type: 'DEALER_STUDIO', status: 'CONNECTED' },
      { dealer_code: '302301', crm_type: 'DEALER_STUDIO', status: 'CONNECTED' },
    ],
    integration_field_mappings: [
      { integration_id: '1000', source_field: 'email_address', target_field: 'email' },
      { integration_id: '1000', source_field: 'mobile_number', target_field: 'mobile' },
      { integration_id: '1001', source_field: 'email_address', target_field: 'email' },
    ],
    integration_status_mappings: [
      { integration_id: '1000', source_status: 'working', target_status: 'Contacted' },
      { integration_id: '1001', source_status: 'working', target_status: 'Contacted' },
    ],
    integration_credentials: [
      { integration_id: '1000', credential_type: 'API_KEY', encrypted_value: 'x' },
      { integration_id: '1001', credential_type: 'API_KEY', encrypted_value: 'y' },
    ],
    lead_integrations: leads,
    webhook_channels: channels,
    integration_logs: [{ integration_id: '1000', status: 'SUCCESS' }],
  });
  const integration = { ROWID: '1000', ...db.tables.dealer_integrations[0] };
  return { db, integration };
}

const live = (rows) => rows.filter((row) => !row.__deleted);

test('removes the integration, its mappings and credentials, and nothing of other dealers', async () => {
  const { db, integration } = seed();
  const result = await removeDealerIntegration(db.app, integration);

  assert.deepEqual(result.deleted, {
    integration_field_mappings: 2,
    integration_status_mappings: 1,
    integration_credentials: 1,
    dealer_integrations: 1,
  });
  assert.deepEqual(live(db.tables.dealer_integrations).map((row) => row.dealer_code), ['302301']);
  for (const table of ['integration_field_mappings', 'integration_status_mappings', 'integration_credentials']) {
    assert.deepEqual(live(db.tables[table]).map((row) => row.integration_id), ['1001'], table);
  }
  // The audit trail stays.
  assert.equal(db.tables.integration_logs.length, 1);
});

test('refused when leads were already sent to the dealer', async () => {
  const { db, integration } = seed({ leads: [{ integration_id: '1000', zoho_lead_id: 'ZL1', external_crm_lead_id: 'X1' }] });
  await assert.rejects(() => removeDealerIntegration(db.app, integration), (err) => err.code === 'INTEGRATION_HAS_LEADS' && err.count === 1);
  assert.equal(live(db.tables.dealer_integrations).length, 2);
  assert.equal(live(db.tables.integration_field_mappings).length, 3);
});

test('leads of another dealer do not block the removal', async () => {
  const { db, integration } = seed({ leads: [{ integration_id: '1001', zoho_lead_id: 'ZL1', external_crm_lead_id: 'X1' }] });
  await removeDealerIntegration(db.app, integration);
  assert.deepEqual(live(db.tables.dealer_integrations).map((row) => row.dealer_code), ['302301']);
});

test('refused while a Zoho watch channel is registered for the dealer', async () => {
  const { db, integration } = seed({ channels: [{ channel_id: '1', dealer_code: '3029012', module_name: 'Leads' }] });
  await assert.rejects(() => removeDealerIntegration(db.app, integration), (err) => err.code === 'INTEGRATION_HAS_WATCH_CHANNEL');
  assert.equal(live(db.tables.dealer_integrations).length, 2);
});

test('an integration without any configuration rows is still removed', async () => {
  const { db, integration } = seed();
  for (const table of ['integration_field_mappings', 'integration_status_mappings', 'integration_credentials']) {
    db.tables[table] = db.tables[table].filter((row) => row.integration_id !== '1000');
  }
  const result = await removeDealerIntegration(db.app, { ...integration });
  assert.equal(result.deleted.integration_field_mappings, 0);
  assert.deepEqual(live(db.tables.dealer_integrations).map((row) => row.dealer_code), ['302301']);
});
