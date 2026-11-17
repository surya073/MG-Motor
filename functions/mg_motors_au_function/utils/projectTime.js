'use strict';

/**
 * projectTime.js
 * -----------------------------------------------------------------------
 * Catalyst's system columns (CREATEDTIME / MODIFIEDTIME) come back as
 * wall-clock strings in the PROJECT's timezone ("2026-11-16 22:34:53:896"),
 * with no zone marker. Code that needs the real instant must know that zone.
 * It used to be hard-coded as +05:30 (Asia/Kolkata); it is now PROJECT_TIMEZONE
 * (see config/env.js), so the same code is right in a Sydney project, daylight
 * saving included.
 *
 * Columns the CODE writes itself (assigned_date, last_synced_at, push_from_at,
 * connected_at, ...) are different: toCatalystDateTime() writes them in UTC, so
 * they are read as UTC, never through this module.
 */

const { getProjectTimezone } = require('../config/env');

const FORMATTERS = new Map();

function formatterFor(timeZone) {
  if (!FORMATTERS.has(timeZone)) {
    FORMATTERS.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return FORMATTERS.get(timeZone);
}

/** The zone's offset from UTC, in ms, at the given instant. */
function zoneOffsetMs(timeZone, utcMs) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * A project wall-clock string ("YYYY-MM-DD HH:mm:ss", an optional ":ms" or
 * ".ms" tail is ignored) as a Date, or null if unreadable.
 */
function parseProjectDateTime(value, timeZone = getProjectTimezone()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const wall = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  // Two passes settle the offset across a daylight-saving change.
  let utc = wall - zoneOffsetMs(timeZone, wall);
  utc = wall - zoneOffsetMs(timeZone, utc);
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A UTC wall-clock string written by the code ("YYYY-MM-DD HH:mm:ss") as a Date, or null. */
function parseUtcDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = { parseProjectDateTime, parseUtcDateTime, zoneOffsetMs };
