'use strict';

/**
 * When a dealer's test drive actually happened, carried from a webhook
 * translator to MG's Test Drive Date (crmIntegrationService.leadActivityDateFields).
 *
 * The value travels in the translated record under TEST_DRIVE_AT. No field
 * mapping names that key, so it is never written to MG as a field itself.
 */
const TEST_DRIVE_AT = '__test_drive_at';

function validIso(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const at = Date.parse(value.trim());
  return Number.isNaN(at) ? null : { text: value.trim(), at };
}

/**
 * The latest valid timestamp of those given (each drive's best date), as the
 * dealer sent it, or null.
 * @param {Array<string|null|undefined>} values
 */
function latestTimestamp(values) {
  let best = null;
  for (const value of values) {
    const parsed = validIso(value);
    if (parsed && (!best || parsed.at > best.at)) best = parsed;
  }
  return best ? best.text : null;
}

module.exports = { TEST_DRIVE_AT, latestTimestamp };
