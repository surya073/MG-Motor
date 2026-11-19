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
 * A fake catalystApp: webhook_channels rows (ZCQL by module_name or
 * dealer_code), the outbound_sync_claims table (UNIQUE claim_key) used by the
 * durable renewal lease, and any other table as a recorder.
 */
function buildWatchCatalystApp({ existingRows = [], failInsert = false, failExtendedInsert = false, integration } = {}) {
  const inserted = [];
  const claims = new Map();
  let nextId = 1;
  return {
    config: { projectId: '818000000022001', environment: 'Development' },
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM webhook_channels')) {
          const rows = [...existingRows, ...inserted.filter((r) => r.__table === 'webhook_channels')];
          if (sql.includes("module_name = 'Dealers,Leads'")) {
            return rows.filter((r) => r.module_name === 'Dealers,Leads').reverse().map((r) => ({ webhook_channels: r }));
          }
          const dealer = /dealer_code = '([^']*)'/.exec(sql);
          if (dealer) return rows.filter((r) => r.dealer_code === dealer[1]).reverse().map((r) => ({ webhook_channels: r }));
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
        getRow: async () => integration,
        insertRow: async (fields) => {
          if (name === 'outbound_sync_claims') {
            if (claims.has(fields.claim_key)) throw new Error('Duplicate value for claim_key');
            const row = { ROWID: String(nextId += 1), ...fields };
            claims.set(fields.claim_key, row);
            return row;
          }
          if (name === 'webhook_channels') {
            if (failInsert) throw new Error('insert failed');
            if (failExtendedInsert && 'owner_project_id' in fields) throw new Error('Invalid column owner_project_id');
          }
          const row = { ROWID: String(nextId += 1), __table: name, ...fields };
          inserted.push(row);
          return row;
        },
        updateRow: async (fields) => fields,
        deleteRow: async (rowId) => {
          for (const [key, row] of claims) if (String(row.ROWID) === String(rowId)) claims.delete(key);
        },
      }),
    }),
    inserted,
    channelRows: () => inserted.filter((r) => r.__table === 'webhook_channels'),
    claims,
  };
}

module.exports = { installZohoWatchFake, buildWatchCatalystApp };
