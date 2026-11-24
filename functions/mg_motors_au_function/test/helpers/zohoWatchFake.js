'use strict';

/**
 * An in-memory Zoho watch API for tests of zohoWebhookService.js. It answers
 * the axios.request calls the service makes to {api}/crm/v8/actions/watch
 * (GET list, GET ?channel_id, POST create, PATCH update, DELETE ?channel_ids)
 * and {api}/crm/v8/org, and the OAuth token POST through axios.post. Channels
 * are stored per API origin, so OEM and dealer orgs stay separate.
 *
 * Zoho lists a channel as one entry per module, with `Module.all` expanded to
 * create/edit/delete, the way the live API does.
 */

const axios = require('axios');

function expand(events) {
  const out = [];
  for (const event of events) {
    const [module, operation] = event.split('.');
    if (operation === 'all') out.push(`${module}.create`, `${module}.edit`, `${module}.delete`);
    else out.push(event);
  }
  return out;
}

function entriesFor(channel) {
  const byModule = new Map();
  for (const event of expand(channel.events)) {
    const module = event.split('.')[0];
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(event);
  }
  return [...byModule.entries()].map(([module, events]) => ({
    channel_id: String(channel.channel_id),
    notify_url: channel.notify_url,
    resource_name: module,
    events,
    channel_expiry: channel.channel_expiry,
    token: channel.token,
  }));
}

/**
 * @param t node:test context
 * @param {object} [options]
 * @param {Array} [options.channels]  pre-existing channels: { origin, channel_id, notify_url, events, channel_expiry }
 * @param {object} [options.fail]     { list, patch, post, delete, readBack, org }: true makes that call throw HTTP 500
 * @param {object} [options.reject]   { patch, post }: true makes Zoho answer { status: 'error' }
 * @param {number} [options.delayMs]  delay on create/update (for overlap tests)
 */
function installZohoWatchFake(t, options = {}) {
  const channels = (options.channels || []).map((c) => ({ ...c }));
  const calls = [];
  const fail = options.fail || {};
  const reject = options.reject || {};
  const httpError = () => Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { secret: 'vendor-body' } } });

  t.mock.method(axios, 'post', async (url) => {
    if (String(url).includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });

  t.mock.method(axios, 'request', async (config) => {
    const url = new URL(config.url);
    const origin = url.origin;
    const method = String(config.method || 'GET').toUpperCase();
    calls.push({ method, url: config.url, origin, params: config.params, data: config.data, config });

    if (url.pathname.endsWith('/crm/v8/org')) {
      if (fail.org) throw httpError();
      return { data: { org: [{ id: '44707000000000001' }] } };
    }
    if (!url.pathname.endsWith('/crm/v8/actions/watch')) throw new Error(`Unexpected axios.request URL: ${config.url}`);

    const mine = () => channels.filter((c) => c.origin === origin);
    if (method === 'GET') {
      const wanted = config.params?.channel_id;
      if (wanted ? fail.readBack : fail.list) throw httpError();
      let list = wanted ? mine().filter((c) => String(c.channel_id) === String(wanted)) : mine();
      if (wanted && options.readBackOverride) list = list.map((c) => ({ ...c, ...options.readBackOverride }));
      return { data: { watch: list.flatMap(entriesFor) } };
    }
    if (method === 'POST' || method === 'PATCH') {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const key = method === 'POST' ? 'post' : 'patch';
      if (fail[key]) throw httpError();
      if (reject[key]) return { data: { watch: [{ status: 'error', code: 'INVALID_DATA' }] } };
      const item = config.data.watch[0];
      if (method === 'PATCH') {
        const existing = mine().find((c) => String(c.channel_id) === String(item.channel_id));
        if (!existing) return { data: { watch: [{ status: 'error', code: 'RESOURCE_NOT_FOUND' }] } };
        Object.assign(existing, { notify_url: item.notify_url, events: item.events, channel_expiry: item.channel_expiry, token: item.token });
      } else {
        channels.push({ origin, channel_id: String(item.channel_id), notify_url: item.notify_url, events: item.events, channel_expiry: item.channel_expiry, token: item.token });
      }
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    if (method === 'DELETE') {
      if (fail.delete) throw httpError();
      const ids = String(config.params?.channel_ids || '').split(',');
      for (let i = channels.length - 1; i >= 0; i -= 1) {
        if (channels[i].origin === origin && ids.includes(String(channels[i].channel_id))) channels.splice(i, 1);
      }
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected method ${method}`);
  });

  return {
    channels,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    methods: () => calls.map((c) => c.method),
  };
}

/**
 * A fake catalystApp: webhook_channels rows (UNIQUE channel_id, as in the live
 * table; ZCQL by channel_id, module_name or dealer_code, ordered by
 * CREATEDTIME or MODIFIEDTIME), the outbound_sync_claims table (UNIQUE
 * claim_key) used by the durable renewal lease, and any other table as a
 * recorder.
 *
 * @param {object} [options]
 * @param {Array}   [options.existingRows]       webhook_channels rows present before the test
 * @param {boolean} [options.failInsert]         every webhook_channels write (insert or update) throws
 * @param {boolean} [options.failExtendedInsert] a webhook_channels write carrying owner_project_id throws (missing column)
 * @param {boolean} [options.failLookup]         the ZCQL lookup by channel_id throws
 * @param {Function} [options.beforeChannelInsert] awaited before each webhook_channels insert (for race tests)
 * @param {object}  [options.integration]   the row getRow returns
 * @param {object}  [options.integrations]  rows by ROWID for getRow (several dealers)
 */
function buildWatchCatalystApp({
  existingRows = [], failInsert = false, failExtendedInsert = false, failLookup = false, beforeChannelInsert, integration, integrations,
} = {}) {
  const inserted = [];
  const claims = new Map();
  let nextId = 1;
  let clock = 0;
  const writes = { insert: 0, update: 0 };
  // Seeded rows get ROWIDs and creation/modification order in the order given.
  const seeded = existingRows.map((r) => {
    clock += 1;
    return { ROWID: String(nextId += 1), __table: 'webhook_channels', __created: clock, __modified: clock, ...r };
  });
  const channelRows = () => [...seeded, ...inserted.filter((r) => r.__table === 'webhook_channels')];
  const publicRow = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('__')));
  const order = (sql, rows) => {
    const key = /ORDER BY MODIFIEDTIME/i.test(sql) ? '__modified' : '__created';
    return [...rows].sort((a, b) => b[key] - a[key]);
  };
  return {
    config: { projectId: '818000000022001', environment: 'Development' },
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM webhook_channels')) {
          const rows = channelRows();
          const byId = /channel_id = '([^']*)'/.exec(sql);
          if (byId) {
            if (failLookup) throw new Error('ZCQL lookup failed');
            return rows.filter((r) => String(r.channel_id) === byId[1]).slice(0, 1).map((r) => ({ webhook_channels: publicRow(r) }));
          }
          if (sql.includes("module_name = 'Dealers,Leads'")) {
            return order(sql, rows.filter((r) => r.module_name === 'Dealers,Leads')).map((r) => ({ webhook_channels: publicRow(r) }));
          }
          const dealer = /dealer_code = '([^']*)'/.exec(sql);
          if (dealer) return order(sql, rows.filter((r) => r.dealer_code === dealer[1])).map((r) => ({ webhook_channels: publicRow(r) }));
          return [];
        }
        if (sql.includes('FROM outbound_sync_claims')) {
          const key = /claim_key = '([^']*)'/.exec(sql)?.[1];
          const row = key && claims.get(key);
          return row ? [{ outbound_sync_claims: row }] : [];
        }
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: (name) => ({
        getRow: async (rowId) => (integrations && integrations[String(rowId)]) || integration,
        insertRow: async (fields) => {
          if (name === 'outbound_sync_claims') {
            if (claims.has(fields.claim_key)) throw new Error('Duplicate value for claim_key');
            const row = { ROWID: String(nextId += 1), ...fields };
            claims.set(fields.claim_key, row);
            return row;
          }
          if (name === 'webhook_channels') {
            if (beforeChannelInsert) await beforeChannelInsert(fields);
            if (failInsert) throw new Error('insert failed');
            if (failExtendedInsert && 'owner_project_id' in fields) throw new Error('Invalid column owner_project_id');
            if (channelRows().some((r) => String(r.channel_id) === String(fields.channel_id))) {
              throw new Error('Duplicate value for channel_id. Please give a different value');
            }
            writes.insert += 1;
          }
          clock += 1;
          const row = { ROWID: String(nextId += 1), __table: name, __created: clock, __modified: clock, ...fields };
          inserted.push(row);
          return publicRow(row);
        },
        updateRow: async (fields) => {
          if (name !== 'webhook_channels') return fields;
          if (failInsert) throw new Error('update failed');
          if (failExtendedInsert && 'owner_project_id' in fields) throw new Error('Invalid column owner_project_id');
          const row = channelRows().find((r) => String(r.ROWID) === String(fields.ROWID));
          if (!row) throw new Error(`No row with ROWID ${fields.ROWID}`);
          if (channelRows().some((r) => r !== row && String(r.channel_id) === String(fields.channel_id ?? row.channel_id))) {
            throw new Error('Duplicate value for channel_id. Please give a different value');
          }
          clock += 1;
          Object.assign(row, fields, { __modified: clock });
          writes.update += 1;
          return publicRow(row);
        },
        deleteRow: async (rowId) => {
          for (const [key, row] of claims) if (String(row.ROWID) === String(rowId)) claims.delete(key);
        },
      }),
    }),
    inserted,
    /** Every webhook_channels row (seeded and written), without internal fields, oldest first. */
    channelRows: () => channelRows().map(publicRow),
    /** Rows written by the test run (inserted), without internal fields. */
    insertedChannelRows: () => inserted.filter((r) => r.__table === 'webhook_channels').map(publicRow),
    channelWrites: writes,
    claims,
  };
}

module.exports = { installZohoWatchFake, buildWatchCatalystApp };
