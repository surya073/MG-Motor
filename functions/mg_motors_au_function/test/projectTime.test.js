'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com.au';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com.au';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getProjectTimezone } = require('../config/env');
const { parseProjectDateTime, parseUtcDateTime } = require('../utils/projectTime');
const svc = require('../services/integrations/crmIntegrationService');

function withTimezone(zone, fn) {
  const previous = process.env.PROJECT_TIMEZONE;
  if (zone === undefined) delete process.env.PROJECT_TIMEZONE; else process.env.PROJECT_TIMEZONE = zone;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.PROJECT_TIMEZONE; else process.env.PROJECT_TIMEZONE = previous;
  }
}
const iso = (date) => date && date.toISOString();

test('the project timezone defaults to Asia/Kolkata, can be set, and ignores an unknown zone', () => {
  withTimezone(undefined, () => assert.equal(getProjectTimezone(), 'Asia/Kolkata'));
  withTimezone('Australia/Sydney', () => assert.equal(getProjectTimezone(), 'Australia/Sydney'));
  withTimezone('Not/AZone', () => assert.equal(getProjectTimezone(), 'Asia/Kolkata'));
});

test('a project wall-clock string is read in the project zone, with or without :ms', () => {
  withTimezone('Asia/Kolkata', () => {
    assert.equal(iso(parseProjectDateTime('2026-11-01 14:27:46:466')), '2026-11-01T08:57:46.000Z');
  });
  withTimezone('Australia/Sydney', () => {
    assert.equal(iso(parseProjectDateTime('2026-11-16 22:34:53:896')), '2026-11-16T11:34:53.000Z'); // AEDT, +11
    assert.equal(iso(parseProjectDateTime('2026-09-23 08:57:02')), '2026-09-22T22:57:02.000Z'); // AEST, +10
  });
});

test('Sydney daylight saving is honoured on both sides of the 4 Oct 2026 change', () => {
  withTimezone('Australia/Sydney', () => {
    assert.equal(iso(parseProjectDateTime('2026-10-04 01:30:00')), '2026-10-03T15:30:00.000Z'); // still AEST (+10)
    assert.equal(iso(parseProjectDateTime('2026-10-04 03:30:00')), '2026-10-03T16:30:00.000Z'); // now AEDT (+11)
  });
});

test('unreadable values give null, and a code-written UTC string is read as UTC', () => {
  assert.equal(parseProjectDateTime(''), null);
  assert.equal(parseProjectDateTime('not a date'), null);
  assert.equal(parseUtcDateTime(undefined), null);
  assert.equal(iso(parseUtcDateTime('2026-11-01 08:57:39')), '2026-11-01T08:57:39.000Z');
});

const FUSION = { crm_type: 'FUSION_SD', push_enabled: true };

test('connected_at (UTC) wins over the row CREATEDTIME for the dealer push floor', () => {
  // The row was copied to a new project this evening; the dealer really connected on 21 Sep.
  const copied = { ...FUSION, CREATEDTIME: '2026-11-16 21:41:11:000', connected_at: '2026-09-21 09:24:40' };
  withTimezone('Australia/Sydney', () => assert.equal(iso(svc.dealerPushFloor(copied)), '2026-09-21T09:24:40.000Z'));
});

test('without connected_at the row CREATEDTIME is read in the project timezone', () => {
  const integration = { ...FUSION, CREATEDTIME: '2026-11-16 21:41:11:000' };
  withTimezone('Australia/Sydney', () => assert.equal(iso(svc.dealerPushFloor(integration)), '2026-11-16T10:41:11.000Z'));
  withTimezone('Asia/Kolkata', () => assert.equal(iso(svc.dealerPushFloor(integration)), '2026-11-16T16:11:11.000Z'));
});

test('a later "skip the queue" resume still raises the floor above connected_at', () => {
  const integration = { ...FUSION, connected_at: '2026-09-21 09:24:40', push_from_at: '2026-11-10 00:00:00' };
  assert.equal(iso(svc.dealerPushFloor(integration)), '2026-11-10T00:00:00.000Z');
});

test('new-leads-only: a lead created before the real connect time is skipped, a later one is not', () => {
  const integration = { ...FUSION, CREATEDTIME: '2026-11-16 21:41:11:000', connected_at: '2026-09-21 09:24:40' };
  withTimezone('Australia/Sydney', () => {
    // assigned_date is UTC. A lead from 10 Nov is AFTER the 21 Sep connect, although it is before the copy time.
    assert.equal(svc.newLeadSkipReason(integration, { assigned_date: '2026-11-10 05:26:58' }), null);
    assert.equal(svc.newLeadSkipReason(integration, { assigned_date: '2026-09-01 05:26:58' }), 'DEALER_STUDIO_BEFORE_CUTOFF');
  });
});

test('regression: without connected_at a copied row would wrongly block every older lead', () => {
  const copiedWithoutConnectedAt = { ...FUSION, CREATEDTIME: '2026-11-16 21:41:11:000' };
  withTimezone('Australia/Sydney', () => {
    assert.equal(svc.newLeadSkipReason(copiedWithoutConnectedAt, { assigned_date: '2026-11-10 05:26:58' }), 'DEALER_STUDIO_BEFORE_CUTOFF');
  });
});
