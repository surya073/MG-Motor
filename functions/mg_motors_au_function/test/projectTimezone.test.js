'use strict';

// Project-timezone audit: every place that used to assume IST (+05:30) now follows PROJECT_TIMEZONE.
// The MG project runs on Australia/Sydney: AEST (+10) in winter, AEDT (+11) in summer.
// 2026 daylight saving: ends Sun 5 Apr 03:00 AEDT -> 02:00 AEST; starts Sun 4 Oct 02:00 AEST -> 03:00 AEDT.

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com.au';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com.au';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getProjectTimezone } = require('../config/env');
const pt = require('../utils/projectTime');
const pathPolicy = require('../services/integrations/pathPolicyService');
const reconciliation = require('../services/integrations/dealerReconciliationService');
const replay = require('../services/integrations/inboundReplayScheduler');
const dashboardStats = require('../services/dashboardStatsService');
const retention = require('../services/integrations/webhookEventRetention');
const aiTools = require('../services/aiAssistantToolService');
const costKpi = require('../services/costKpiService');
const internalCost = require('../services/internalCostService');
const usageRollup = require('../services/usageRollup');
const usageReport = require('../scripts/usageReport');

const SYD = 'Australia/Sydney';
const iso = (date) => date && date.toISOString();
const at = (text) => new Date(text);

function withTimezone(zone, fn) {
  const previous = process.env.PROJECT_TIMEZONE;
  if (zone === undefined) delete process.env.PROJECT_TIMEZONE; else process.env.PROJECT_TIMEZONE = zone;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.PROJECT_TIMEZONE; else process.env.PROJECT_TIMEZONE = previous;
  }
}

async function withTimezoneAsync(zone, fn) {
  const previous = process.env.PROJECT_TIMEZONE;
  if (zone === undefined) delete process.env.PROJECT_TIMEZONE; else process.env.PROJECT_TIMEZONE = zone;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.PROJECT_TIMEZONE; else process.env.PROJECT_TIMEZONE = previous;
  }
}

function freezeNow(t, text) {
  const real = Date.now;
  Date.now = () => at(text).getTime();
  t.after(() => { Date.now = real; });
}

// ------------------------------------------------------------------ AEST / AEDT

test('AEDT (summer, +11) and AEST (winter, +10) are both read correctly', () => {
  withTimezone(SYD, () => {
    assert.equal(iso(pt.parseProjectDateTime('2026-01-15 10:00:00')), '2026-01-14T23:00:00.000Z'); // AEDT
    assert.equal(iso(pt.parseProjectDateTime('2026-07-15 10:00:00')), '2026-07-15T00:00:00.000Z'); // AEST
    assert.equal(iso(pt.parseProjectDateTime('2026-11-16 22:34:53:896')), '2026-11-16T11:34:53.896Z');
    assert.equal(pt.formatProjectDateTime(at('2026-01-14T23:00:00Z')), '2026-01-15 10:00:00');
    assert.equal(pt.formatProjectDateTime(at('2026-07-15T00:00:00Z')), '2026-07-15 10:00:00');
  });
});

test('the offset is +10 before and +11 after the 4 Oct 2026 change, and reverts on 5 Apr', () => {
  const offsetHours = (utc) => pt.zoneOffsetMs(SYD, at(utc).getTime()) / 3600e3;
  assert.equal(offsetHours('2026-10-03T15:59:59Z'), 10);
  assert.equal(offsetHours('2026-10-03T16:00:00Z'), 11);
  assert.equal(offsetHours('2026-04-04T15:59:59Z'), 11);
  assert.equal(offsetHours('2026-04-04T16:00:00Z'), 10);
});

// ------------------------------------------------------------------ DST changes

test('spring forward (4 Oct 2026): the skipped 02:xx hour resolves to the instant just after the change', () => {
  withTimezone(SYD, () => {
    assert.equal(iso(pt.parseProjectDateTime('2026-10-04 01:59:59')), '2026-10-03T15:59:59.000Z'); // last AEST second
    assert.equal(iso(pt.parseProjectDateTime('2026-10-04 03:00:00')), '2026-10-03T16:00:00.000Z'); // first AEDT second
    // 02:30 never existed; it must land inside the following hour, never before the change.
    const gap = pt.parseProjectDateTime('2026-10-04 02:30:00').getTime();
    assert.ok(gap >= at('2026-10-03T16:00:00Z').getTime() && gap < at('2026-10-03T17:00:00Z').getTime());
  });
});

test('fall back (5 Apr 2026): the repeated 02:xx hour parses to one of its two real instants', () => {
  withTimezone(SYD, () => {
    assert.equal(iso(pt.parseProjectDateTime('2026-04-05 01:59:59')), '2026-04-04T14:59:59.000Z'); // AEDT
    assert.equal(iso(pt.parseProjectDateTime('2026-04-05 03:00:00')), '2026-04-04T17:00:00.000Z'); // AEST
    const repeated = pt.parseProjectDateTime('2026-04-05 02:30:00').getTime();
    assert.ok([at('2026-04-04T15:30:00Z').getTime(), at('2026-04-04T16:30:00Z').getTime()].includes(repeated));
    // Both real instants format back to the same wall-clock string.
    assert.equal(pt.formatProjectDateTime(at('2026-04-04T15:30:00Z')), '2026-04-05 02:30:00');
    assert.equal(pt.formatProjectDateTime(at('2026-04-04T16:30:00Z')), '2026-04-05 02:30:00');
  });
});

test('format -> parse returns the same instant for every half hour of 2026 (outside the repeated hour)', () => {
  withTimezone(SYD, () => {
    const repeatStart = at('2026-04-04T15:00:00Z').getTime();
    const repeatEnd = at('2026-04-04T17:00:00Z').getTime();
    let checked = 0;
    for (let ms = at('2026-01-01T00:00:00Z').getTime(); ms < at('2027-01-01T00:00:00Z').getTime(); ms += 30 * 60 * 1000) {
      if (ms >= repeatStart && ms < repeatEnd) continue; // the 02:xx hour that happens twice
      assert.equal(pt.parseProjectDateTime(pt.formatProjectDateTime(ms)).getTime(), ms, `round trip failed at ${new Date(ms).toISOString()}`);
      checked += 1;
    }
    assert.ok(checked > 17000);
  });
});

// ------------------------------------------------------------------ date boundaries

test('the project day rolls over at Sydney midnight, not at UTC midnight', () => {
  withTimezone(SYD, () => {
    assert.equal(pt.projectDay(at('2026-11-16T12:59:59Z')), '2026-11-16'); // 23:59:59 AEDT
    assert.equal(pt.projectDay(at('2026-11-16T13:00:00Z')), '2026-11-17'); // 00:00:00 AEDT
    assert.equal(pt.projectDay(at('2026-07-15T13:59:59Z')), '2026-07-15'); // 23:59:59 AEST
    assert.equal(pt.projectDay(at('2026-07-15T14:00:00Z')), '2026-07-16'); // 00:00:00 AEST
  });
});

test('a day is 23 hours on 4 Oct 2026 and 25 hours on 5 Apr 2026', () => {
  withTimezone(SYD, () => {
    const dayMs = (start, nextStart) => at(nextStart).getTime() - at(start).getTime();
    assert.equal(pt.projectDay(at('2026-10-03T14:00:00Z')), '2026-10-04');
    assert.equal(pt.projectDay(at('2026-10-04T12:59:59Z')), '2026-10-04');
    assert.equal(pt.projectDay(at('2026-10-04T13:00:00Z')), '2026-10-05');
    assert.equal(dayMs('2026-10-03T14:00:00Z', '2026-10-04T13:00:00Z') / 3600e3, 23);

    assert.equal(pt.projectDay(at('2026-04-04T13:00:00Z')), '2026-04-05');
    assert.equal(pt.projectDay(at('2026-04-05T13:59:59Z')), '2026-04-05');
    assert.equal(pt.projectDay(at('2026-04-05T14:00:00Z')), '2026-04-06');
    assert.equal(dayMs('2026-04-04T13:00:00Z', '2026-04-05T14:00:00Z') / 3600e3, 25);
  });
});

test('the project hour label (hourly cost bucket) follows the Sydney wall clock', () => {
  withTimezone(SYD, () => {
    assert.equal(pt.projectHourLabel(at('2026-11-16T12:59:59Z')), '2026-11-16 23');
    assert.equal(pt.projectHourLabel(at('2026-11-16T13:00:00Z')), '2026-11-17 00');
    assert.equal(pt.projectHourLabel(at('2026-07-15T13:59:59Z')), '2026-07-15 23');
  });
});

test('projectClock reads the project weekday and date, which differ from UTC near midnight', () => {
  withTimezone(SYD, () => {
    const clock = pt.projectClock(at('2026-11-16T13:30:00Z')); // Mon 13:30 UTC = Tue 17 Nov 00:30 AEDT
    assert.equal(clock.getUTCDate(), 17);
    assert.equal(clock.getUTCDay(), 2); // Tuesday
    assert.equal(at('2026-11-16T13:30:00Z').getUTCDay(), 1); // UTC is still Monday
  });
});

test('the same code is correct in the original IST project too', () => {
  withTimezone('Asia/Kolkata', () => {
    assert.equal(iso(pt.parseProjectDateTime('2026-11-01 14:27:46:466')), '2026-11-01T08:57:46.466Z');
    assert.equal(pt.projectDay(at('2026-11-16T18:29:59Z')), '2026-11-16'); // 23:59:59 IST
    assert.equal(pt.projectDay(at('2026-11-16T18:30:00Z')), '2026-11-17'); // 00:00:00 IST
  });
});

test('PROJECT_TIMEZONE: unset means the original Asia/Kolkata, an invalid name is ignored', () => {
  withTimezone(undefined, () => assert.equal(getProjectTimezone(), 'Asia/Kolkata'));
  withTimezone(SYD, () => assert.equal(getProjectTimezone(), SYD));
  withTimezone('Not/AZone', () => assert.equal(getProjectTimezone(), 'Asia/Kolkata'));
});

test('results do not depend on the runtime machine timezone', () => {
  const script = path.join(__dirname, '..', 'utils', 'projectTime.js');
  const code = `const t = require(${JSON.stringify(script)}); console.log([
    t.parseProjectDateTime('2026-11-16 22:34:53:896').toISOString(),
    t.formatProjectDateTime(new Date('2026-04-04T16:30:00Z')),
    t.projectDay(new Date('2026-11-16T13:00:00Z')),
    t.projectHourLabel(new Date('2026-11-16T13:00:00Z'))].join('|'))`;
  const outputs = ['UTC', 'Asia/Kolkata', 'Australia/Sydney', 'America/New_York'].map((tz) =>
    execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: tz, PROJECT_TIMEZONE: SYD } }).toString().trim());
  assert.deepEqual(outputs, Array(4).fill('2026-11-16T11:34:53.896Z|2026-04-05 02:30:00|2026-11-17|2026-11-17 00'));
});

// ------------------------------------------------------------------ the services that used to hard-code IST

test('the three system-timestamp parsers (path policy, reconciliation, replay) agree and follow the project zone', () => {
  const parsers = [pathPolicy.parseSystemTimestamp, reconciliation._test.parseSystemTimestamp, replay._test.parseSystemTimestamp];
  for (const parse of parsers) {
    withTimezone(SYD, () => {
      assert.equal(iso(parse('2026-11-16 22:34:53:896')), '2026-11-16T11:34:53.896Z'); // AEDT
      assert.equal(iso(parse('2026-07-15 10:05:48')), '2026-07-15T00:05:48.000Z'); // AEST
      assert.equal(iso(parse('2026-10-04 03:00:00')), '2026-10-03T16:00:00.000Z'); // first second after the change
    });
    withTimezone('Asia/Kolkata', () => assert.equal(iso(parse('2026-10-14 10:05:48:285')), '2026-10-14T04:35:48.285Z'));
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
    assert.equal(parse('not a date'), null);
  }
});

test('dashboard stats: the CREATEDTIME bound is the Sydney wall clock', () => {
  withTimezone(SYD, () => {
    assert.equal(dashboardStats.toProjectDateTime(at('2026-11-16T13:30:00Z')), '2026-11-17 00:30:00');
    assert.equal(dashboardStats.toProjectDateTime(at('2026-07-15T00:00:00Z')), '2026-07-15 10:00:00');
  });
});

test('dashboard date filters compare whole project days, including the 23h and 25h days', () => {
  const { dateRangeConditions } = dashboardStats._test;
  // The filter compares CREATEDTIME (project wall clock) with wall-clock strings, so it is right in
  // any zone and across daylight saving.
  for (const zone of [SYD, 'Asia/Kolkata']) {
    withTimezone(zone, () => {
      assert.deepEqual(dateRangeConditions({ fromDate: '2026-10-04', toDate: '2026-10-04' }), [
        "CREATEDTIME >= '2026-10-04 00:00:00'", "CREATEDTIME < '2026-10-05 00:00:00'",
      ]);
      assert.deepEqual(dateRangeConditions({ fromDate: '2026-04-05', toDate: '2026-04-05' }), [
        "CREATEDTIME >= '2026-04-05 00:00:00'", "CREATEDTIME < '2026-04-06 00:00:00'",
      ]);
      assert.deepEqual(dateRangeConditions({ fromDate: '2026-12-31', toDate: '2026-12-31' }), [
        "CREATEDTIME >= '2026-12-31 00:00:00'", "CREATEDTIME < '2027-01-01 00:00:00'",
      ]);
    });
  }
});

test('webhook event retention cuts off at the Sydney wall-clock time', async () => {
  const queries = [];
  const app = {
    zcql: () => ({ executeZCQLQuery: async (query) => { queries.push(query); return []; } }),
    datastore: () => ({ table: () => ({ deleteRow: async () => {} }) }),
  };
  await withTimezoneAsync(SYD, () => retention.purgeOldWebhookEvents(app, { now: at('2026-11-16T13:30:00Z').getTime(), days: 1 }));
  assert.match(queries[0], /CREATEDTIME < '2026-11-16 00:30:00'/); // 24h earlier, in AEDT
  await withTimezoneAsync(SYD, () => retention.purgeOldWebhookEvents(app, { now: at('2026-07-15T00:00:00Z').getTime(), days: 1 }));
  assert.match(queries[1], /CREATEDTIME < '2026-07-14 10:00:00'/); // winter: AEST
});

test('AI assistant "today", "yesterday" and "this week" are Sydney days', (t) => {
  withTimezone(SYD, () => {
    freezeNow(t, '2026-11-16T13:30:00Z'); // Mon 13:30 UTC = Tue 17 Nov 00:30 AEDT
    assert.deepEqual(aiTools.todayRange(), { fromDate: '2026-11-17', toDate: '2026-11-17' });
    assert.deepEqual(aiTools.yesterdayRange(), { fromDate: '2026-11-16', toDate: '2026-11-16' });
    assert.deepEqual(aiTools.thisWeekRange(), { fromDate: '2026-11-15', toDate: '2026-11-17' }); // week starts Sunday
  });
});

test('AI assistant ranges do not slip a day just before Sydney midnight', (t) => {
  withTimezone(SYD, () => {
    freezeNow(t, '2026-11-16T12:59:59Z'); // 23:59:59 AEDT Mon 16 Nov
    assert.deepEqual(aiTools.todayRange(), { fromDate: '2026-11-16', toDate: '2026-11-16' });
    assert.deepEqual(aiTools.yesterdayRange(), { fromDate: '2026-11-15', toDate: '2026-11-15' });
  });
});

test('cost reports: the usage day, the hour bucket and flushed_at are all the Sydney wall clock', () => {
  withTimezone(SYD, () => {
    const instant = at('2026-11-16T13:00:00Z'); // 00:00 Tue 17 Nov AEDT
    assert.equal(costKpi._test.projectUsageDay(instant), '2026-11-17');
    assert.equal(internalCost._test.hourKey(instant.getTime()), '2026-11-17 00');
    assert.equal(usageRollup.bucketHour(instant.getTime()), '2026-11-17 00');
    assert.equal(usageRollup._test.catalystDateTime(instant.getTime()), '2026-11-17 00:00:00');
    // The page reads buckets with the same label the roll-up writes.
    assert.equal(internalCost._test.hourKey(instant.getTime()), usageRollup.bucketHour(instant.getTime()));
  });
});

test('usageReport.js labels a log line with the project day; a line with an explicit zone is exact', () => {
  withTimezone(SYD, () => {
    assert.equal(usageReport.dayOf('2026-11-16 23:30:00 [usage] {}'), '2026-11-16'); // no zone: already project time
    assert.equal(usageReport.dayOf('2026-11-16T13:30:00Z [usage] {}'), '2026-11-17'); // UTC -> Sydney next day
    assert.equal(usageReport.dayOf('2026-11-16T10:00:00+11:00 [usage] {}'), '2026-11-16');
    assert.equal(usageReport.dayOf('no date here'), 'unknown');
  });
});

// ------------------------------------------------------------------ regression guard

test('no source file hard-codes the IST offset again', () => {
  const root = path.join(__dirname, '..');
  const skipDirs = new Set(['node_modules', 'test']);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      const rel = path.relative(root, full).replace(/\\/g, '/');
      // Allowed: the config default, the explanatory comments in projectTime.js, and the CRM example in a comment.
      const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      if (/\+05:30|330 \* 60|5 \* 60 \+ 30|IST_OFFSET|PROJECT_UTC_OFFSET/.test(code)) offenders.push(rel);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'hard-coded IST offset found; use utils/projectTime.js (PROJECT_TIMEZONE)');
});
