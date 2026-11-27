'use strict';

const pathPolicy = require('./pathPolicyService');

/**
 * dealerActivityFollowUp.js
 * -----------------------------------------------------------------------
 * Activity-based Follow-up 1 / Follow-up 2 for Dealer Studio (MG approval,
 * 27 Nov 2026). A dealer that calls, texts or emails the customer without
 * changing the lead's status in Dealer Studio has still worked the lead, so
 * MG's Enquiry Status moves on from Not Contacted:
 *
 *   MG status now                          activities   new MG status
 *   Not Contacted / Update Pending / blank 1            Follow-up 1
 *   Not Contacted / Update Pending / blank 2 or more    Follow-up 2 (straight there)
 *   Follow-up 1                            2 or more    Follow-up 2
 *   Follow-up 2                            any          no change
 *   anything else (Contacted, Contact in
 *   Future, Lost, Dropped, Not Qualified,
 *   Dealer Unavailable, PMA Unassigned)    any          no change
 *
 * Every activity type counts (phone, sms, ai_sms, email, note, in_person and any
 * new one), automated ones included. An activity is counted once by its Dealer
 * Studio event id. The status only moves forward: an activity the dealer later
 * deletes never moves MG back. A real status the dealer sets in the same post
 * (working, lost, invalid, a sale, a completed test drive) always wins; see
 * crmIntegrationService.attemptInboundLeadUpdateCore.
 */

// Private key on the translated inbound record that carries the activity summary.
const ACTIVITY_FOLLOW_UP = '__activity_follow_up';
const FOLLOW_UP_1 = 'Follow-up 1';
const FOLLOW_UP_2 = 'Follow-up 2';
const TRIGGER = 'DEALER_ACTIVITY';

const norm = (value) => String(value ?? '').trim().toLowerCase();
const timeOf = (value) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? Infinity : ms;
};

/** Whether MG's status still means "waiting for the dealer" (or is blank). */
function isWaitingStatus(status) {
  const value = norm(status);
  return value === '' || value === '-none-' || pathPolicy.isWaitingForDealerActionStatus(status);
}

function isActivityFollowUpStatus(status) {
  const value = norm(status);
  return value === norm(FOLLOW_UP_1) || value === norm(FOLLOW_UP_2);
}

/**
 * The dealer's activities, oldest first, once each.
 * @param {object[]} events - translated lead events ({ sourceEventId, eventType, userName, createdAt })
 *                            or stored lead_activities rows ({ id, event_type, user_name, created_at })
 */
function orderedActivities(events) {
  const seen = new Set();
  const list = [];
  (Array.isArray(events) ? events : []).forEach((event) => {
    if (!event || typeof event !== 'object') return;
    const id = String(event.sourceEventId ?? event.id ?? '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({
      id,
      type: event.eventType ?? event.event_type ?? 'unknown',
      user: event.userName ?? event.user_name ?? null,
      at: event.createdAt ?? event.created_at ?? null,
    });
  });
  return list.sort((a, b) => timeOf(a.at) - timeOf(b.at) || a.id.localeCompare(b.id));
}

/**
 * @returns {{ count: number, first: object, second: object|null }|null} null with no activity
 */
function summarizeActivities(events) {
  const list = orderedActivities(events);
  if (list.length === 0) return null;
  return { count: list.length, first: list[0], second: list[1] ?? null };
}

/**
 * The status MG moves to for this many activities, or null when it stays.
 * @param {string} currentStatus - MG's Enquiry Status now
 * @param {number} count - the dealer's activities on the lead
 */
function followUpTarget(currentStatus, count) {
  const activities = Number(count) || 0;
  if (activities < 1) return null;
  if (isWaitingStatus(currentStatus)) return activities >= 2 ? FOLLOW_UP_2 : FOLLOW_UP_1;
  if (norm(currentStatus) === norm(FOLLOW_UP_1) && activities >= 2) return FOLLOW_UP_2;
  return null;
}

/**
 * What the log keeps about the move (integration_logs.field_changes on the
 * lead_status change), so the portal can say why the status changed.
 */
function followUpTrigger(summary, fromStatus, target) {
  const straightToSecond = target === FOLLOW_UP_2 && isWaitingStatus(fromStatus);
  const activities = target === FOLLOW_UP_1
    ? [summary.first]
    : (straightToSecond ? [summary.first, summary.second] : [summary.second]);
  return {
    trigger: TRIGGER,
    activity_count: summary.count,
    activities: activities.filter(Boolean),
  };
}

module.exports = {
  ACTIVITY_FOLLOW_UP,
  FOLLOW_UP_1,
  FOLLOW_UP_2,
  TRIGGER,
  isWaitingStatus,
  isActivityFollowUpStatus,
  orderedActivities,
  summarizeActivities,
  followUpTarget,
  followUpTrigger,
};
