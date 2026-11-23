import { env } from "../config/env";

// Catalyst Data Store times (CREATEDTIME, MODIFIEDTIME) look like
// "2026-11-23 15:22:51:802": a wall-clock time in the project's time zone,
// with no offset. `new Date(value)` reads that as the BROWSER's local time,
// so a viewer outside the project zone sees every time shifted (from India,
// 5.5 hours into the future, which made every notification "Just now").
const CATALYST_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:[:.](\d{1,3}))?$/;

// Offset (ms) of `timeZone` from UTC at the instant `utcMs`.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map(({ type, value }) => [type, value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Parses a Catalyst project-time value into a Date (the real instant).
 * Values that already carry an offset or "Z" are parsed as they are.
 * Returns null when the value cannot be read.
 */
export function parseProjectDateTime(value, timeZone = env.projectTimezone) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  const match = CATALYST_DATE_TIME.exec(text);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, y, mo, d, h, mi, s = "0", ms = "0"] = match;
  const wallAsUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms.padEnd(3, "0"));
  // Two passes settle the offset across a daylight-saving change.
  let utc = wallAsUtc - zoneOffsetMs(wallAsUtc, timeZone);
  utc = wallAsUtc - zoneOffsetMs(utc, timeZone);
  return new Date(utc);
}
