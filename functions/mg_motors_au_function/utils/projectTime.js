'use strict';

/**
 * projectTime.js
 * -----------------------------------------------------------------------
 * The one place that knows the project's timezone (PROJECT_TIMEZONE, see
 * config/env.js; Australia/Sydney for the MG project, daylight saving included).
 *
 * Catalyst's system columns (CREATEDTIME / MODIFIEDTIME) come back as wall-clock
 * strings in the PROJECT's timezone ("2026-11-16 22:34:53:896"), with no zone
 * marker, and ZCQL compares them the same way. Code that needs the real instant,
 * or that needs to write such a string, must go through here — never a fixed
 * "+05:30" / "+11:00" offset.
 *
 * Columns the CODE writes itself (assigned_date, last_synced_at, push_from_at,
 * connected_at, ...) are different: toCatalystDateTime() writes them in UTC, so
 * they are read as UTC (parseUtcDateTime), never through the project zone.
 * The hourly cost totals (usageRollup) are the one deliberate exception: their
 * bucket_hour / flushed_at are written in project time with the helpers below.
 */

const { getProjectTimezone } = require('../config/env');

const FORMATTERS = new Map();
const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const WALL_MS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[:.](\d{1,3}))?/;
const pad = (n) => String(n).padStart(2, '0');

function formatterFor(timeZone) {
  if (!FORMATTERS.has(timeZone)) {
    FORMATTERS.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return FORMATTERS.get(timeZone);
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(ms) ? ms : NaN;
}

/** The wall-clock parts of an instant in the zone. */
function projectParts(value, timeZone = getProjectTimezone()) {
  const ms = toMs(value);
  if (Number.isNaN(ms)) return null;
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

/** The zone's offset from UTC, in ms, at the given instant (positive east of UTC). */
function zoneOffsetMs(timeZone, utcMs) {
  const p = projectParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * A project wall-clock string ("YYYY-MM-DD HH:mm:ss", with an optional ":ms" or
 * ".ms" tail that is kept) as a Date, or null if unreadable. During the hour a
 * daylight-saving change repeats, the earlier instant is returned.
 */
function parseProjectDateTime(value, timeZone = getProjectTimezone()) {
  const match = WALL_MS.exec(String(value || '').trim());
  if (!match) return null;
  const wall = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  // Two passes settle the offset across a daylight-saving change.
  let utc = wall - zoneOffsetMs(timeZone, wall);
  utc = wall - zoneOffsetMs(timeZone, utc);
  const date = new Date(utc + (match[7] ? Number(match[7].padEnd(3, '0')) : 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A UTC wall-clock string written by the code ("YYYY-MM-DD HH:mm:ss") as a Date, or null. */
function parseUtcDateTime(value) {
  const match = WALL.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** An instant as the "YYYY-MM-DD HH:mm:ss" project-time string CREATEDTIME is compared against. */
function formatProjectDateTime(value, timeZone = getProjectTimezone()) {
  const p = projectParts(value, timeZone);
  if (!p) return null;
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** The project calendar day of an instant, "YYYY-MM-DD". */
function projectDay(value, timeZone = getProjectTimezone()) {
  const p = projectParts(value, timeZone);
  if (!p) return null;
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The project hour of an instant, "YYYY-MM-DD HH" (the hourly cost bucket key). */
function projectHourLabel(value, timeZone = getProjectTimezone()) {
  const p = projectParts(value, timeZone);
  if (!p) return null;
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}`;
}

/**
 * A Date whose UTC getters read as the project's wall clock at that instant
 * (getUTCDay() is the project weekday, getUTCDate() the project date, ...).
 * For calendar arithmetic only — it is not the real instant.
 */
function projectClock(value = Date.now(), timeZone = getProjectTimezone()) {
  const p = projectParts(value, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

module.exports = {
  parseProjectDateTime,
  parseUtcDateTime,
  formatProjectDateTime,
  projectDay,
  projectHourLabel,
  projectClock,
  projectParts,
  zoneOffsetMs,
};
