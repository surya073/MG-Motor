'use strict';

const logger = require('../../utils/logger');

/**
 * autoPlayRateBudget.js
 * -----------------------------------------------------------------------
 * AutoPlay allows 1 request per second, 10 per minute and 100 per hour per
 * credential (AutoPlay onboarding email, Nov 2026). Every AutoPlay request,
 * the token request included, takes one slot here first. Modelled on
 * fusionRateBudget.js: counts and the 429 cool-down live in Catalyst Cache so
 * every instance shares them, with the instance's own count as the fallback
 * when the cache cannot be used. Catalyst Cache has no atomic increment, so
 * the minute and hour budgets keep a little headroom (9 and 90).
 *
 * The one-per-second window is waited out in place (at most about a second).
 * A full minute or hour, or a cool-down after a 429, is never waited out: the
 * request is not sent and takeSlot() throws a temporary error carrying
 * vendor.retryAfter, so the retry paths deliver the lead later.
 */

const WINDOWS = Object.freeze([
  { name: 'second', ms: 1000, limit: 1 },
  { name: 'minute', ms: 60 * 1000, limit: 9 },
  { name: 'hour', ms: 60 * 60 * 1000, limit: 90 },
]);
const COOLDOWN_DEFAULT_SECONDS = 60;
const CACHE_EXPIRY_HOURS = 2;
const MAX_SECOND_WAITS = 2;

const localCounts = new Map();
const localCooldowns = new Map();
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function segmentOf(catalystApp) {
  try {
    return typeof catalystApp?.cache === 'function' ? catalystApp.cache().segment() : null;
  } catch {
    return null;
  }
}

const CACHE_ERROR_LOG_INTERVAL_MS = 60000;
let lastCacheErrorLoggedAt = 0;

function logCacheProblem(what, err) {
  const now = Date.now();
  if (now - lastCacheErrorLoggedAt < CACHE_ERROR_LOG_INTERVAL_MS) return;
  lastCacheErrorLoggedAt = now;
  logger.error('autoPlayRateBudget', `Catalyst Cache ${what} failed; using this instance's count (logged once a minute)`, err);
}

async function cacheGet(segment, key) {
  if (!segment) return null;
  try {
    const value = await segment.getValue(key);
    return value === undefined || value === null || value === '' ? null : String(value);
  } catch {
    return null;
  }
}

async function cachePut(segment, key, value) {
  if (!segment) return false;
  try {
    await segment.update(key, String(value), CACHE_EXPIRY_HOURS);
    return true;
  } catch {
    try {
      await segment.put(key, String(value), CACHE_EXPIRY_HOURS);
      return true;
    } catch (err) {
      logCacheProblem(`write of ${key}`, err);
      return false;
    }
  }
}

function limitError(code, retryAfterSeconds, integration, windowName) {
  const err = new Error(
    code === 'AUTOPLAY_COOLDOWN'
      ? `AutoPlay asked us to wait (HTTP 429) for integration ${integration.ROWID}; request not sent, retry in ${retryAfterSeconds}s`
      : `AutoPlay request budget for integration ${integration.ROWID} is used up this ${windowName}; request not sent, retry in ${retryAfterSeconds}s`
  );
  err.code = code;
  err.vendor = { retryAfter: retryAfterSeconds };
  return err;
}

async function usedIn(segment, key) {
  const shared = await cacheGet(segment, key);
  return Math.max(shared === null ? 0 : Number(shared) || 0, localCounts.get(key) || 0);
}

/**
 * Spends one request of this integration's budget, or throws AUTOPLAY_COOLDOWN /
 * AUTOPLAY_RATE_BUDGET_EXHAUSTED without spending it.
 */
async function takeSlot(catalystApp, integration, nowFn = Date.now) {
  const id = String(integration.ROWID);
  const segment = segmentOf(catalystApp);

  const cooldownKey = `autoplay_cooldown_${id}`;
  let now = nowFn();
  const cooldownUntil = Math.max(Number(await cacheGet(segment, cooldownKey)) || 0, localCooldowns.get(cooldownKey) || 0);
  if (cooldownUntil > now) {
    throw limitError('AUTOPLAY_COOLDOWN', Math.ceil((cooldownUntil - now) / 1000), integration);
  }

  for (let waits = 0; ; waits += 1) {
    now = nowFn();
    let blocked = null;
    for (const window of WINDOWS) {
      const slot = Math.floor(now / window.ms);
      const key = `autoplay_rate_${id}_${window.name}_${slot}`;
      if (await usedIn(segment, key) >= window.limit) {
        blocked = { window, waitMs: (slot + 1) * window.ms - now };
        break;
      }
    }
    if (!blocked) break;
    if (blocked.window.name === 'second' && waits < MAX_SECOND_WAITS) {
      await sleep(Math.max(1, blocked.waitMs) + 25);
      continue;
    }
    throw limitError('AUTOPLAY_RATE_BUDGET_EXHAUSTED', Math.max(1, Math.ceil(blocked.waitMs / 1000)), integration, blocked.window.name);
  }

  for (const window of WINDOWS) {
    const slot = Math.floor(now / window.ms);
    const key = `autoplay_rate_${id}_${window.name}_${slot}`;
    const used = await usedIn(segment, key);
    localCounts.set(key, used + 1);
    await cachePut(segment, key, used + 1);
  }
  // Drop this instance's counts for windows that are over.
  for (const key of localCounts.keys()) {
    const name = key.split('_')[3];
    const window = WINDOWS.find((w) => w.name === name);
    if (window && Number(key.slice(key.lastIndexOf('_') + 1)) < Math.floor(now / window.ms)) localCounts.delete(key);
  }
}

/** After AutoPlay answers 429: no request for this integration until Retry-After has passed. */
async function recordRateLimited(catalystApp, integration, retryAfterSeconds, now = Date.now()) {
  const seconds = Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) : COOLDOWN_DEFAULT_SECONDS;
  const until = now + seconds * 1000;
  const key = `autoplay_cooldown_${integration.ROWID}`;
  localCooldowns.set(key, Math.max(localCooldowns.get(key) || 0, until));
  await cachePut(segmentOf(catalystApp), key, until);
  logger.info('autoPlayRateBudget', `AutoPlay answered 429 for integration ${integration.ROWID}; pausing requests for ${seconds}s`);
}

function isLimitError(err) {
  return err?.code === 'AUTOPLAY_COOLDOWN' || err?.code === 'AUTOPLAY_RATE_BUDGET_EXHAUSTED';
}

function _resetForTests({ sleepFn } = {}) {
  localCounts.clear();
  localCooldowns.clear();
  lastCacheErrorLoggedAt = 0;
  sleep = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

module.exports = { takeSlot, recordRateLimited, isLimitError, WINDOWS, _resetForTests };
