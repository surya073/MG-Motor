import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowRight, Barcode, Bot, CalendarCheck, CalendarDays, CarFront, Check, CircleCheck, CircleX, Clock, Clock3,
  FileText, Globe, Mail, Megaphone, MessageSquare, Phone, RefreshCw, ShieldCheck, StickyNote, TrendingUp, UserCog, UserRound, Users,
} from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { dealerCrmIntegrationService } from "../../services/api/dealerCrmIntegrationService";
import { useAuth } from "../../contexts/AuthContext";
import { useAlerts } from "../../ui/Alerts/Alerts";
import { APP_ROLES } from "../../constants/auth.constants";
import {
  ChevronLeftIcon,
  PhoneIcon,
  MailIcon,
  UserIcon,
  ClipboardIcon,
  BuildingIcon,
  MegaphoneIcon,
  ArrowRightIcon,
  NoteIcon,
  ClockIcon,
  PencilIcon,
} from "../../ui/icons";
import mgLogo from "../../assets/images/mg-logo-single.png";
import mgCarImage from "../../assets/dashboardimgs/mgcarpng1.png";
import { isValidAustralianMobile } from "../../utils/mobileValidation";
import CloseButton from "../../ui/CloseButton/CloseButton";
import Modal from "../../ui/Modal/Modal";
import PathBadge from "../../ui/PathBadge/PathBadge";
import { CompactListSkeleton } from "../../ui/Skeleton/PageSkeletons";
import "./LeadDetailView.css";
import "./MoreDetails.css";

/* ----------------------------------------------------------------
   Status -> visual tone
------------------------------------------------------------------ */
const STATUS_TONES = {
  "Update Pending": "neutral",
  "Not Contacted": "neutral",
  Contacted: "info",
  "Follow-up 1": "info",
  "Follow-up 2": "info",
  "In Progress": "warning",
  "Contact in Future": "warning",
  Converted: "success",
  Won: "success",
  Lost: "danger",
  "Lost Lead": "danger",
  Dropped: "danger",
  "Not Qualified": "danger",
  Rejected: "danger",
  "Junk Lead": "danger",
  Junk: "danger",
  Spam: "danger",
  "Dealer Unavailable": "danger",
  "Unattended Alert": "danger",
  Removed: "danger",
  "Consent Hold": "danger",
};

/* ----------------------------------------------------------------
   HAPPY PATHS
------------------------------------------------------------------ */
const HAPPY_PATHS = [
  {
    id: "Happy 1",
    type: "happy",
    title: "New enquiry routed successfully",
    trigger: "OEM CRM",
    match: ["Update Pending", "Not Contacted"],
    description:
      "Enquiry created in the OEM, mandatory fields validated, dealer resolved by postcode, and pushed to the dealer CRM successfully.",
    outcome: "Status moves Update Pending → Not Contacted once the dealer acknowledges receipt.",
  },
  {
    id: "Happy 2",
    type: "happy",
    title: "Dealer progresses enquiry (status sync)",
    trigger: "Dealer CRM",
    match: [
      "Follow-up 1",
      "Follow-up 2",
      "Contacted",
      "Contact in Future",
      "Not Qualified",
      "Dropped",
      "Lost",
      "Lost Lead",
      "Converted",
      "Won",
      "Delivered",
    ],
    description:
      "Dealer is actively working the lead in their own CRM; each status change syncs back to the OEM automatically.",
    outcome: "OEM status mirrors the dealer pipeline in real time, plus a daily reconcile.",
  },
  {
    id: "Happy 3",
    type: "happy",
    title: "Duplicate detected",
    trigger: "Middleware",
    match: ["Duplicate", "Linked", "DUPLICATE_LINKED"],
    description:
      "A new enquiry matched every configured mandatory business field for the same dealer within 15 minutes and was safely linked instead of being sent twice.",
    outcome: "No duplicate dealer record created; existing record linked with an audit note.",
  },
  {
    id: "Happy 4",
    type: "happy",
    title: "Integration recovery (replay)",
    trigger: "Scheduler",
    match: ["Replayed", "Recovered"],
    description:
      "Connectivity was restored after an outage and queued enquiries were replayed in order without creating duplicates.",
    outcome: "All valid enquiries delivered exactly once after recovery.",
  },
  {
    id: "Happy 5",
    type: "happy",
    title: "Data synchronisation (dealer → OEM)",
    trigger: "Dealer CRM",
    match: ["Synced", "Reconciled"],
    description:
      "Dealer-side field updates are mapped back to the OEM using per-field source-of-truth ownership rules.",
    outcome: "Both systems reflect the agreed source-of-truth data.",
  },
];

/* ----------------------------------------------------------------
   UNHAPPY PATHS
------------------------------------------------------------------ */
const UNHAPPY_PATHS = [
  {
    id: "Unhappy 1",
    type: "unhappy",
    title: "API / integration failure",
    trigger: "Middleware",
    match: ["Retry Pending", "Retrying", "DELIVERY_FAILED", "RETRY_EXHAUSTED"],
    description:
      "Push to the dealer failed with a timeout, 5xx, or connection error — a recoverable failure.",
    outcome:
      "Kept and retried with backoff for up to 24h; IT/FI alerted; included in the 12pm error report.",
  },
  {
    id: "Unhappy 2",
    type: "unhappy",
    title: "Invalid / missing data",
    trigger: "Middleware",
    match: ["Quarantined", "Data Error", "Validation Failed", "VALIDATION_HOLD"],
    description:
      "A mandatory field was missing or failed validation on ingest from the OEM. Not recoverable — no retry.",
    outcome: "Rejected / quarantined and logged for correction; the dealer CRM is never called.",
  },
  {
    id: "Unhappy 3",
    type: "unhappy",
    title: "Dealer unavailable",
    trigger: "Scheduler",
    match: ["Dealer Unavailable"],
    description: "The mapped dealer is inactive and the 24h retry window has been exhausted.",
    outcome:
      "Moved to a holding queue; status set to Dealer Unavailable; alert raised for admin re-route.",
  },
  {
    id: "Unhappy 4",
    type: "unhappy",
    title: "Status update failure (dealer → OEM)",
    trigger: "Middleware",
    match: ["Sync Failed"],
    description: "A dealer update was received but writing it back to the OEM failed.",
    outcome: "Retried with backoff and reconciled once successful; alert raised if it persists.",
  },
  {
    id: "Unhappy 5",
    type: "unhappy",
    title: "Wrong / rejected dealer mapping",
    trigger: "Middleware",
    match: ["Routing Exception", "ROUTING_HOLD"],
    description:
      "Postcode routing resolved to no dealer, an ambiguous dealer, or an invalid mapping.",
    outcome: "Held as a routing exception until the mapping is corrected, then reprocessed.",
  },
  {
    id: "Unhappy 6",
    type: "unhappy",
    title: "Ownership conflict",
    trigger: "Middleware",
    match: ["Ownership Conflict", "OWNERSHIP_CONFLICT"],
    description: "OEM and dealer updated the same field on the same enquiry at the same time.",
    outcome: "Resolved automatically using field-level source-of-truth and timestamp rules.",
  },
  {
    id: "Unhappy 7",
    type: "unhappy",
    title: "Out-of-order events",
    trigger: "Middleware",
    match: ["Pending Sequence", "PENDING_SEQUENCE"],
    description: "A status update arrived before its enquiry-created record existed.",
    outcome: "Held in a buffer and released once the prerequisite record exists.",
  },
  {
    id: "Unhappy 8",
    type: "unhappy",
    title: "Consent / privacy mismatch",
    trigger: "Middleware",
    match: ["Consent Hold", "CONSENT_HOLD"],
    description: "Consent or privacy data was missing or mismatched.",
    outcome:
      "Held/flagged until consent is validated; marketing-dependent data withheld until then.",
  },
  {
    id: "Unhappy 9",
    type: "unhappy",
    title: "Dealer rejects enquiry",
    trigger: "Dealer CRM",
    match: ["Junk", "Junk Lead", "Spam", "Junk Lead / Spam"],
    description: "The dealer explicitly marked the enquiry as spam or junk.",
    outcome: "MG status is set to Not Qualified; the dealer's own rejection wording is retained and shown in the activity log below, and alerts support.",
  },
  {
    id: "Unhappy 10",
    type: "unhappy",
    title: "SLA breach",
    trigger: "Scheduler",
    match: ["Unattended Alert"],
    description: "The dealer received the enquiry but took no action within 24 hours.",
    outcome: "Escalated; status set to Unattended Alert; dealer notified to action it.",
  },
  {
    id: "Unhappy 11",
    type: "unhappy",
    title: "Partial transaction",
    trigger: "Middleware",
    match: ["Reconciling", "ACK_UNRESOLVED"],
    description: "The OEM recorded the enquiry but dealer creation failed, leaving a mismatch.",
    outcome: "A reconciliation job re-attempts delivery or flags the mismatch for review.",
  },
  {
    id: "Unhappy 12",
    type: "unhappy",
    title: "Dealer CRM migration / offboarding",
    trigger: "Scheduler",
    match: ["Re-routing"],
    description: "The dealer changed CRM or left the network while the enquiry was still open.",
    outcome: "Re-routed to the next closest dealer without creating duplicates.",
  },
];

/* ----------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */

function formatFieldName(key) {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Activity dates arrive as plain yyyy-MM-dd (MG's Zoho date fields): shown as 20 Nov 2026,
// without a timezone shift. Anything else is shown as it is.
function formatActivityDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return text;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// MG stores a retail sale as "Purchase"; its picklist label is Retail Order.
function formatEnquiryOutcome(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "-None-") return "—";
  return text.toLowerCase() === "purchase" ? "Retail Order" : text;
}

function formatBoolean(value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return "—";
}

function parseFieldChanges(entry) {
  if (!entry.field_changes) return [];
  try {
    const parsed = JSON.parse(entry.field_changes);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The human-readable half of an error_message.
 *
 * The backend records "CODE: detail" — e.g.
 *   LEAD_VALIDATION_FAILED: postcode is empty — Must be a valid four-digit
 *   Australian postcode
 * The code is for logs; the operator needs the part after it, which names
 * the field, what it holds and the rule it broke. A bare code with no
 * detail is not worth surfacing, so it is dropped.
 */
function errorDetailText(entry) {
  const raw = (entry.error_message || "").trim();
  if (!raw) return null;
  const separator = raw.indexOf(": ");
  if (separator === -1) return null;
  const detail = raw.slice(separator + 2).trim();
  return detail || null;
}

// Entries describing the dealer's response rather than a field change.
const DEALER_NOTE_FIELDS = new Set(["dealer_error", "dealer_response"]);

// What the dealer CRM said about an outbound attempt, as recorded by the
// adapter: what it did with an update (e.g. Fusion parked it for a person to
// accept, or ignored unmapped fields), or its error (status, problem
// title/detail, reference id, Retry-After).
function dealerNotes(changes) {
  const notes = [];
  const response = changes.find((c) => c.field === "dealer_response");
  if (response?.update_mode === "manual") notes.push("Awaiting dealer acceptance");
  if (response?.enquiry_linked === false) notes.push("Not yet in the dealer's pipeline");
  if (response?.ignored_fields?.length) notes.push(`Dealer ignored: ${response.ignored_fields.join(", ")}`);
  const error = changes.find((c) => c.field === "dealer_error");
  if (error) {
    const said = [error.title, error.detail].filter(Boolean).join(" — ");
    const ref = error.instance ? ` (ref ${error.instance})` : "";
    notes.push(`Dealer${error.status ? ` HTTP ${error.status}` : ""}: ${said || "error"}${ref}`);
    if (error.retryAfter != null) notes.push(`retry after ${error.retryAfter} s`);
  }
  return notes;
}

function timelineDetailText(entry) {
  const changes = parseFieldChanges(entry);
  // A failure usually carries no field changes - nothing was written. The
  // reason it failed is the only useful detail, and without this the
  // timeline showed the generic scenario title and nothing else, leaving
  // "Invalid / missing data" with no indication of WHICH field.
  if (changes.length === 0) return errorDetailText(entry);

  const deliveryTiming = changes.find((c) => c.field === "delivery_timing");
  if (deliveryTiming) {
    const notes = dealerNotes(changes);
    // A FAILED attempt's timing alone never says why it failed — e.g.
    // DEALER_ACK_MISSING_ID carries a diagnostic naming the dealer
    // response's actual field names, which is far more actionable than a
    // duration number. A successful attempt (acknowledged_at set) has no
    // error detail anyway, so it keeps showing timing as before.
    if (deliveryTiming.failed_at) {
      const detail = errorDetailText(entry);
      if (detail || notes.length > 0) return [detail, ...notes].filter(Boolean).join(" · ");
    }
    const resultTime = deliveryTiming.acknowledged_at || deliveryTiming.failed_at || "—";
    return [
      `Sent ${deliveryTiming.sent_at || "—"} · result ${resultTime} · ${deliveryTiming.duration_ms ?? "—"} ms`,
      ...notes,
    ].join(" · ");
  }

  const duplicateLink = changes.find((c) => c.field === "duplicate_link");
  if (duplicateLink) {
    const gap = duplicateLink.gap_minutes == null ? "unknown" : Number(duplicateLink.gap_minutes).toFixed(1);
    return `Linked ${duplicateLink.to || "—"} to ${duplicateLink.from || "—"} · ${gap} min gap`;
  }

  const statusChange = changes.find((c) => c.field === "lead_status");
  const otherChanges = changes.filter((c) => c.field !== "lead_status" && !DEALER_NOTE_FIELDS.has(c.field));

  // A dealer edit can change the status and other fields together; show
  // every field that changed, not just the status.
  const parts = [];
  if (statusChange) {
    parts.push(`Status changed: ${statusChange.from || "—"} → ${statusChange.to || "—"}`);
    // Activity-based Follow-up 1 / 2: which dealer activity moved the status.
    const activityReason = activityFollowUpReason(statusChange);
    if (activityReason) parts.push(activityReason);
    // Unhappy 9: MG status is normalized to "Not Qualified" regardless of
    // the dealer's own wording (Junk Lead / Spam / etc.), so surface that
    // original wording here as the rejection reason — otherwise it would
    // only be visible in the entry's title, not the detail line.
    if (
      /^unhappy 9/i.test(entry.happy_unhappy_path_name || "") &&
      statusChange.raw_dealer_value &&
      statusChange.raw_dealer_value !== statusChange.to
    ) {
      parts.push(`Dealer rejection reason: "${statusChange.raw_dealer_value}"`);
    }
  }
  otherChanges.forEach((c) => {
    parts.push(`${formatFieldName(c.field)}: "${c.from || "—"}" → "${c.to || "—"}"`);
  });
  // A skipped update carries only what the dealer said (no timing).
  parts.push(...dealerNotes(changes));

  return parts.length > 0 ? parts.join(" · ") : null;
}

function scenarioFromLog(entry) {
  const name = (entry.happy_unhappy_path_name || "").trim();
  const isHappy = /^happy/i.test(name);
  const isUnhappy = /^unhappy/i.test(name);
  return {
    id: name || null,
    tone: isHappy ? "happy" : isUnhappy ? "unhappy" : "neutral",
    label: entry.happy_unhappy_path_message || name || entry.operation || "Activity",
  };
}

// Every distinct Happy/Unhappy scenario this lead has passed through,
// in the order it first happened — used to show the lead's full
// "journey" (e.g. Happy 1 → Happy 2 → Happy 5) rather than only its
// current/latest state.
function getDistinctPaths(timeline) {
  const seen = new Map();
  timeline.forEach((entry) => {
    const name = (entry.happy_unhappy_path_name || "").trim();
    if (!name || seen.has(name)) return;
    seen.set(name, {
      id: name,
      type: /^happy/i.test(name) ? "happy" : "unhappy",
      message: entry.happy_unhappy_path_message || name,
    });
  });
  return Array.from(seen.values());
}

function ActivityTimeline({ timeline, loading }) {
  if (loading) {
    return (
      <li className="lead-detail__timeline-empty" aria-busy="true" style={{ listStyle: "none", padding: 0 }}>
        <CompactListSkeleton rows={3} />
      </li>
    );
  }
  if (!timeline || timeline.length === 0) {
    return <li className="lead-detail__timeline-empty">No activity recorded yet.</li>;
  }
  return timeline.map((entry, idx) => {
    const scenario = scenarioFromLog(entry);
    const detailText = timelineDetailText(entry);
    return (
      <li
        className={`lead-detail__timeline-item lead-detail__timeline-item--${scenario.tone}`}
        key={entry.ROWID || idx}
      >
        <span className={`lead-detail__timeline-dot lead-detail__timeline-dot--${scenario.tone}`}>
          {scenario.tone === "happy" ? (
            <CheckCircleIcon />
          ) : scenario.tone === "unhappy" ? (
            <AlertCircleIcon />
          ) : (
            <DotsCircleIcon />
          )}
        </span>
        <div>
          <div className="lead-detail__timeline-title-row">
            <p className="lead-detail__timeline-title">{scenario.label}</p>
            {scenario.id && (
              <PathBadge name={scenario.id} />
            )}
          </div>
          {detailText && <p className="lead-detail__timeline-detail">{detailText}</p>}
          <p className="lead-detail__timeline-time">{entry.created_at || "—"}</p>
        </div>
      </li>
    );
  });
}

/* ----------------------------------------------------------------
   Dealer Activity: what the dealer logged in their own CRM
------------------------------------------------------------------ */
const DEALER_ACTIVITY_LABELS = {
  phone: "Phone call",
  sms: "SMS",
  ai_sms: "AI SMS",
  email: "Email",
  note: "Note",
  in_person: "In person",
};

function dealerActivityLabel(type) {
  const key = String(type || "").toLowerCase();
  if (DEALER_ACTIVITY_LABELS[key]) return DEALER_ACTIVITY_LABELS[key];
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Activity";
}

function DealerActivityIcon({ type }) {
  const key = String(type || "").toLowerCase();
  if (key === "phone") return <PhoneIcon size={13} />;
  if (key === "email") return <MailIcon size={13} />;
  if (key === "in_person") return <UserIcon size={13} />;
  return <NoteIcon size={13} />;
}

// Dealer times are UTC ISO strings; shown in Sydney time, e.g. "25 Nov 2026, 11:39 am".
function formatDealerActivityTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* Activity-based Follow-up 1 / 2 (Dealer Studio): a dealer activity moved MG's status
   from Not Contacted. The backend keeps the reason on the status change in the log's
   field_changes: { trigger: "DEALER_ACTIVITY", activity_count, activities: [{ id, type, user, at }] }. */
const ACTIVITY_TRIGGER = "DEALER_ACTIVITY";
const ORDINALS = ["First", "Second"];

function describeDealerActivity(activity) {
  const who = activity?.user ? ` by ${activity.user}` : "";
  return `${dealerActivityLabel(activity?.type)}${who}, ${formatDealerActivityTime(activity?.at)}`;
}

// "First dealer activity: Phone call by Sam Taylor, 25 Nov 2026, 11:39 am"; with two
// (straight to Follow-up 2) both are named.
function activityFollowUpReason(statusChange) {
  if (statusChange?.trigger !== ACTIVITY_TRIGGER || !Array.isArray(statusChange.activities)) return null;
  const list = statusChange.activities;
  if (list.length === 0) return null;
  if (list.length === 1) {
    const ordinal = statusChange.to === "Follow-up 2" ? "Second" : "First";
    return `${ordinal} dealer activity: ${describeDealerActivity(list[0])}`;
  }
  return list.map((activity, i) => `${ORDINALS[i] || "Next"} dealer activity: ${describeDealerActivity(activity)}`).join(" · ");
}

/**
 * From the timeline (oldest first): which dealer activity triggered which follow-up,
 * as { [activityId]: "Follow-up 1" | "Follow-up 2" }, and the activity change behind
 * the lead's current status (null when the status was not set by an activity).
 */
function activityFollowUps(timeline, currentStatus) {
  const byActivity = {};
  let current = null;
  (timeline || []).forEach((entry) => {
    const change = parseFieldChanges(entry).find((c) => c.field === "lead_status");
    if (change?.trigger !== ACTIVITY_TRIGGER || !Array.isArray(change.activities)) return;
    const twoAtOnce = change.activities.length > 1;
    change.activities.forEach((activity, i) => {
      if (!activity?.id) return;
      byActivity[activity.id] = twoAtOnce ? (i === 0 ? "Follow-up 1" : "Follow-up 2") : change.to;
    });
    current = change;
  });
  // The latest activity change counts only if it is still what MG shows.
  if (current && current.to !== currentStatus) current = null;
  return { byActivity, current };
}

// The compact list on the lead page; "View full" opens DealerActivityPanel in a modal.
function DealerActivityList({ activities, loading, followUps = {} }) {
  if (loading) {
    return (
      <li className="lead-detail__timeline-empty" aria-busy="true" style={{ listStyle: "none", padding: 0 }}>
        <CompactListSkeleton rows={2} />
      </li>
    );
  }
  if (!activities || activities.length === 0) {
    return <li className="lead-detail__timeline-empty">No calls, messages or notes from the dealer yet.</li>;
  }
  // Newest first: the latest contact attempt is what an operator looks for.
  return [...activities].reverse().map((activity) => (
    <li className="lead-detail__timeline-item lead-detail__timeline-item--neutral" key={activity.id}>
      <span className="lead-detail__timeline-dot lead-detail__timeline-dot--neutral">
        <DealerActivityIcon type={activity.event_type} />
      </span>
      <div>
        <div className="lead-detail__timeline-title-row">
          <p className="lead-detail__timeline-title">{dealerActivityLabel(activity.event_type)}</p>
          {activity.user_name && <span className="lead-detail__timeline-badge lead-detail__timeline-badge--neutral">{activity.user_name}</span>}
          {followUps[activity.id] && (
            <span className="lead-detail__timeline-badge lead-detail__timeline-badge--followup" title="This activity moved MG's Enquiry Status">
              Triggered {followUps[activity.id]}
            </span>
          )}
        </div>
        {activity.description && <p className="lead-detail__timeline-detail">{activity.description}</p>}
        <p className="lead-detail__timeline-time">{formatDealerActivityTime(activity.created_at)}</p>
      </div>
    </li>
  ));
}

/* ----------------------------------------------------------------
   Dealer Activity panel (in the "View full" modal): summary, type filter, day groups
------------------------------------------------------------------ */
const SYDNEY = "Australia/Sydney";

// Each activity kind: label, plural for counts/filters, icon and colour tone.
const ACTIVITY_KINDS = {
  phone: { label: "Call", plural: "Calls", Icon: Phone, tone: "call" },
  sms: { label: "SMS", plural: "SMS", Icon: MessageSquare, tone: "sms" },
  ai_sms: { label: "AI SMS", plural: "AI SMS", Icon: Bot, tone: "ai" },
  email: { label: "Email", plural: "Emails", Icon: Mail, tone: "email" },
  note: { label: "Note", plural: "Notes", Icon: StickyNote, tone: "note" },
  in_person: { label: "In person", plural: "In person", Icon: UserRound, tone: "person" },
};

function activityKind(type) {
  const key = String(type || "").toLowerCase();
  const label = dealerActivityLabel(key);
  return { key: key || "other", ...(ACTIVITY_KINDS[key] || { label, plural: label, Icon: Activity, tone: "other" }) };
}

const dayKey = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: SYDNEY }).format(date);
const timeOnly = (date) => date.toLocaleTimeString("en-AU", { timeZone: SYDNEY, hour: "numeric", minute: "2-digit" });

function dayLabel(date, now = new Date()) {
  const key = dayKey(date);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86400000))) return "Yesterday";
  return date.toLocaleDateString("en-AU", { timeZone: SYDNEY, weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function timeAgo(date, now = new Date()) {
  const minutes = Math.round((now - date) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const toDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const LONG_DESCRIPTION = 180;

function DealerActivityItem({ activity, followUp }) {
  const [expanded, setExpanded] = useState(false);
  const kind = activityKind(activity.event_type);
  const at = toDate(activity.created_at);
  const text = activity.description || "";
  const long = text.length > LONG_DESCRIPTION;
  return (
    <li className={`dact__item${followUp ? " dact__item--trigger" : ""}`}>
      <span className={`dact__icon dact__icon--${kind.tone}`} aria-hidden="true">
        <kind.Icon size={15} strokeWidth={2} />
      </span>
      <div className="dact__body">
        <div className="dact__row">
          <span className="dact__kind">{kind.label}</span>
          {activity.user_name ? (
            <span className="dact__who">
              <UserRound size={12} aria-hidden="true" /> {activity.user_name}
            </span>
          ) : (
            <span className="dact__who dact__who--auto" title="Logged by the dealer's system, not a person">
              <Bot size={12} aria-hidden="true" /> Automated
            </span>
          )}
          {followUp && (
            <span className="dact__followup" title="This activity moved MG's Enquiry Status">
              <TrendingUp size={12} aria-hidden="true" /> Triggered {followUp}
            </span>
          )}
          <time className="dact__time" dateTime={activity.created_at || undefined} title={formatDealerActivityTime(activity.created_at)}>
            {at ? timeOnly(at) : "—"}
          </time>
        </div>
        {text && (
          <p className={`dact__text${long && !expanded ? " dact__text--clamped" : ""}`}>{text}</p>
        )}
        {long && (
          <button type="button" className="dact__more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </li>
  );
}

function DealerActivityPanel({ activities, loading, followUps = {} }) {
  const [filter, setFilter] = useState("all");
  // Newest first: the latest contact attempt is what an operator looks for.
  const sorted = useMemo(
    () => [...(activities || [])].sort((a, b) => (toDate(b.created_at)?.getTime() || 0) - (toDate(a.created_at)?.getTime() || 0)),
    [activities]
  );
  const counts = useMemo(() => {
    const map = new Map();
    sorted.forEach((a) => {
      const kind = activityKind(a.event_type);
      const entry = map.get(kind.key) || { ...kind, count: 0 };
      entry.count += 1;
      map.set(kind.key, entry);
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [sorted]);

  if (loading) return <CompactListSkeleton rows={3} />;
  if (sorted.length === 0) {
    return (
      <div className="dact__empty">
        <Activity size={18} aria-hidden="true" />
        <p>No calls, messages or notes from the dealer yet.</p>
      </div>
    );
  }

  const visible = filter === "all" ? sorted : sorted.filter((a) => activityKind(a.event_type).key === filter);
  const groups = [];
  visible.forEach((activity) => {
    const at = toDate(activity.created_at);
    const key = at ? dayKey(at) : "unknown";
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: at ? dayLabel(at) : "Date unknown", items: [] };
      groups.push(group);
    }
    group.items.push(activity);
  });

  const first = toDate(sorted[sorted.length - 1].created_at);
  const latest = toDate(sorted[0].created_at);
  const people = new Set(sorted.map((a) => a.user_name).filter(Boolean));

  return (
    <div className="dact">
      <div className="dact__summary">
        <div className="dact__stat">
          <span className="dact__stat-label">First contact</span>
          <span className="dact__stat-value">{first ? formatDealerActivityTime(first) : "—"}</span>
        </div>
        <div className="dact__stat">
          <span className="dact__stat-label">Latest activity</span>
          <span className="dact__stat-value">
            {latest ? timeAgo(latest) : "—"}
            {latest && <span className="dact__stat-sub">{formatDealerActivityTime(latest)}</span>}
          </span>
        </div>
        <div className="dact__stat">
          <span className="dact__stat-label">Dealer staff</span>
          <span className="dact__stat-value">{people.size ? [...people].join(", ") : "Automated only"}</span>
        </div>
      </div>

      <div className="dact__filters" role="group" aria-label="Filter dealer activity by type">
        <button type="button" className={`dact__chip${filter === "all" ? " is-active" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All <span className="dact__chip-count">{sorted.length}</span>
        </button>
        {counts.map((kind) => (
          <button
            key={kind.key}
            type="button"
            className={`dact__chip dact__chip--${kind.tone}${filter === kind.key ? " is-active" : ""}`}
            aria-pressed={filter === kind.key}
            onClick={() => setFilter(filter === kind.key ? "all" : kind.key)}
          >
            <kind.Icon size={13} aria-hidden="true" /> {kind.plural} <span className="dact__chip-count">{kind.count}</span>
          </button>
        ))}
      </div>

      <div className="dact__scroll">
        {groups.length === 0 ? (
          <p className="dact__none">No activity of this type.</p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="dact__day" aria-label={group.label}>
              <h4 className="dact__day-label">
                {group.label} <span>{group.items.length}</span>
              </h4>
              <ul className="dact__list">
                {group.items.map((activity) => (
                  <DealerActivityItem key={activity.id} activity={activity} followUp={followUps[activity.id]} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function normalize(value) {
  return (value ?? "").toString().trim().toLowerCase().replace(/[-_]+/g, " ");
}

function findScenarioForStatus(status, scenarios) {
  const normalizedTarget = normalize(status);
  if (!normalizedTarget) return null;

  return (
    scenarios.find((scenario) =>
      scenario.match.some((candidate) => normalize(candidate) === normalizedTarget)
    ) || null
  );
}

function matchPathScenario(lead) {
  const all = [...UNHAPPY_PATHS, ...HAPPY_PATHS];

  return (
    findScenarioForStatus(lead.lead_status, all) || findScenarioForStatus(lead.sync_status, all)
  );
}

/**
 * The scenario implied by the lead's SYNC state alone.
 *
 * lead_status is the business status (Not Contacted, Contacted, Lost...),
 * sync_status is the integration state (VALIDATION_HOLD, CONSENT_HOLD...).
 * A lead can legitimately hold both at once: the dealer has not actioned it
 * yet AND delivery is blocked on a bad mobile number. Only the sync state
 * describes the integration path, so a held lead must be resolved from it.
 */
function matchSyncScenario(lead) {
  return findScenarioForStatus(lead.sync_status, [...UNHAPPY_PATHS, ...HAPPY_PATHS]);
}

function classifyPath(lead) {
  const match = matchPathScenario(lead);

  if (match) {
    return match;
  }

  return {
    id: "Unclassified",
    type: "neutral",
    title: "Status not yet mapped",
    trigger: "—",
    description: `Neither lead_status ("${lead.lead_status || "—"}") nor sync_status ("${
      lead.sync_status || "—"
    }") matches a known Happy/Unhappy scenario yet.`,
    outcome:
      "Update the match lists in LeadDetailView.jsx once the real backend status values are confirmed.",
  };
}

/**
 * Resolves which Integration Path scenario to display for this lead.
 *
 * FIX: previously this trusted lead.happy_unhappy_path_name unconditionally
 * whenever it was non-empty — but that field is written by a SEPARATE
 * backend call (writeLog's mirror block) from the one that sets
 * lead_status (handleConsentMismatch / recordOutboundFailureAndCheckEscalation
 * etc write lead_status directly). If the mirror write ever lags, fails
 * silently, or simply hasn't run yet for the lead's CURRENT status, the
 * stored name goes stale — e.g. lead_status correctly says "Consent Hold"
 * but happy_unhappy_path_name still holds an old "Unhappy 1" from a
 * previous failed attempt. Since a stale string is still truthy, the old
 * code would display the wrong badge even though the pill (driven by
 * lead_status directly) was correct.
 *
 * Explicit hold states take priority so a stale audit mirror cannot hide
 * an active fault. Otherwise the backend's stored scenario is authoritative;
 * this preserves outcomes such as Happy 4 recovery even when the business
 * status itself has already returned to Not Contacted.
 */
function resolveDisplayPath(lead) {
  const liveMatch = matchPathScenario(lead);
  const urgentSyncStates = new Set([
    "validation hold",
    "consent hold",
    "routing hold",
    "delivery failed",
    "failed critical",
    "sla breach",
    "reconcile mismatch",
    "held",
    "retry exhausted",
    "ack unresolved",
  ]);

  // BUG THIS FIXES: this branch used to return `liveMatch`, but
  // matchPathScenario resolves lead_status FIRST — and "Not Contacted" is
  // Happy 1's own MG status. So a lead held on VALIDATION_HOLD with
  // lead_status "Not Contacted" was displayed as Happy 1: the guard meant to
  // surface an active fault was announcing a successful delivery instead,
  // overriding the correct Unhappy 2 the backend had already recorded.
  // A held lead must be described by its SYNC state, never its business
  // status, so resolve from sync_status and fall back to the stored
  // scenario rather than to lead_status.
  if (urgentSyncStates.has(normalize(lead.sync_status))) {
    const heldMatch = matchSyncScenario(lead);
    if (heldMatch) return heldMatch;

    const storedHeld = [...HAPPY_PATHS, ...UNHAPPY_PATHS].find(
      (scenario) => scenario.id === lead.happy_unhappy_path_name
    );
    if (storedHeld) return storedHeld;
  }

  if (lead.happy_unhappy_path_name) {
    const configured = [...HAPPY_PATHS, ...UNHAPPY_PATHS].find(
      (scenario) => scenario.id === lead.happy_unhappy_path_name
    );
    if (configured) return configured;
    return {
      id: lead.happy_unhappy_path_name,
      type: /^happy/i.test(lead.happy_unhappy_path_name) ? "happy" : "unhappy",
      title: lead.happy_unhappy_path_message || lead.happy_unhappy_path_name,
      trigger: "—",
      description: lead.happy_unhappy_path_message || "",
    };
  }

  if (liveMatch) return liveMatch;

  return classifyPath(lead);
}

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

/* ----------------------------------------------------------------
   Inline Icons
------------------------------------------------------------------ */
function CopyIcon(props) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckCircleIcon(props) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function AlertCircleIcon(props) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function DotsCircleIcon(props) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="8" cy="12" r="0.6" fill="currentColor" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
      <circle cx="16" cy="12" r="0.6" fill="currentColor" />
    </svg>
  );
}

/* ----------------------------------------------------------------
   Status Pill
------------------------------------------------------------------ */
function StatusPill({ status }) {
  const tone = STATUS_TONES[status] || "neutral";

  return (
    <span className={`lead-detail__status-pill lead-detail__status-pill--${tone}`}>
      <span className="lead-detail__status-dot" />
      {status || "—"}
    </span>
  );
}

/* ----------------------------------------------------------------
   Path Chips — every distinct scenario this lead's journey has
   passed through, shown together in the hero and Integration Path
   card. The current/latest scenario is visually emphasized.
------------------------------------------------------------------ */
function PathChips({ paths, currentId }) {
  if (!paths || paths.length === 0) return null;

  return (
    <div className="lead-detail__path-chips">
      {paths.map((p) => {
        const isCurrent = p.id === currentId;
        return <PathBadge key={p.id} name={p.id} current={isCurrent} size="md" title={p.message} />;
      })}
    </div>
  );
}

/* ----------------------------------------------------------------
   Integration Path Card
------------------------------------------------------------------ */
function IntegrationPathCard({ path, journeyPaths, failureDetail }) {
  return (
    <section className={`lead-detail__group lead-detail__path-card lead-detail__path-card--${path.type}`}>
      <h3>
        <span className="lead-detail__group-icon">
          <ClipboardIcon size={15} />
        </span>
        Integration Path
      </h3>

      {journeyPaths.length > 1 && (
        <div className="lead-detail__journey">
          <span className="lead-detail__journey-label">This lead's journey:</span>
          <div className="lead-detail__journey-chips">
            {journeyPaths.map((p, idx) => (
              <span key={p.id} className="lead-detail__journey-step">
                <PathBadge name={p.id} title={p.message} />
                {idx < journeyPaths.length - 1 && (
                  <ArrowRightIcon size={12} className="lead-detail__journey-arrow" />
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="lead-detail__path-card-body">
        <PathBadge name={path.id} size="md" className="lead-detail__path-id" />

        <div className="lead-detail__path-card-text">
          <p className="lead-detail__path-card-title">{path.title}</p>

          {path.trigger && path.trigger !== "—" && (
            <p className="lead-detail__path-card-trigger">Trigger source: {path.trigger}</p>
          )}

          <p className="lead-detail__path-card-desc">{path.description}</p>

          {path.outcome && (
            <p className="lead-detail__path-card-outcome">
              <strong>Expected outcome:</strong> {path.outcome}
            </p>
          )}

          {/* The scenario description explains the PATH; this explains why
              THIS lead is on it. Without it an operator sees "Invalid /
              missing data" and still has to guess which field is at fault. */}
          {failureDetail && (
            <p className="lead-detail__path-card-reason">
              <strong>What needs fixing:</strong> {failureDetail}
            </p>
          )}

        </div>
      </div>
    </section>
  );
}

// Colour of the dealer-CRM badge in the header (Fusion SD, Dealer Studio,
// Zoho CRM, or a custom CRM's name).
function crmBadgeTone(crm) {
  const name = String(crm || "").toLowerCase();
  if (name.includes("fusion")) return "fusion";
  if (name.includes("dealer studio")) return "studio";
  if (name.includes("zoho")) return "zoho";
  return "other";
}

/* ----------------------------------------------------------------
   More Details: banner header, red-bar section titles, icon tiles
------------------------------------------------------------------ */
function DetailTile({ icon: Icon, label, value, mono = false, copy = false, rawValue, copied, onCopy, tone, highlight = false }) {
  const shown = value === undefined || value === null || value === "" ? "—" : value;
  const copyable = copy && (rawValue ?? shown) && (rawValue ?? shown) !== "—";
  return (
    <div className={`md-tile${highlight ? " md-tile--highlight" : ""}`}>
      <span className="md-tile__icon" aria-hidden="true">
        <Icon size={20} strokeWidth={2} />
      </span>
      <div className="md-tile__body">
        <span className="md-tile__label">{label}</span>
        <span className="md-tile__valuerow">
          <span className={`md-tile__value${mono ? " md-tile__value--mono" : ""}${tone ? ` md-tile__value--${tone}` : ""}`} title={typeof shown === "string" ? shown : undefined}>
            {shown}
          </span>
          {copyable && (
            <button type="button" className="md-tile__copy" onClick={() => onCopy(rawValue ?? shown)} aria-label={`Copy ${label}`}>
              {copied ? <Check size={14} /> : <CopyIcon />}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function ConsentTile({ icon: Icon, label, value }) {
  const yes = value === "Yes";
  return (
    <div className={`md-consent md-consent--${yes ? "yes" : "no"}`}>
      <span className="md-consent__icon" aria-hidden="true">
        <Icon size={24} strokeWidth={2} />
      </span>
      <div className="md-consent__body">
        <span className="md-consent__label">{label}</span>
        {yes ? (
          <span className="md-consent__pill">
            <CircleCheck size={15} strokeWidth={2.4} /> Yes
          </span>
        ) : (
          <span className="md-consent__value">{value}</span>
        )}
      </div>
      <Icon className="md-consent__watermark" size={88} strokeWidth={1.2} aria-hidden="true" />
    </div>
  );
}

function MoreDetailsCard({ val, lead, onViewHistory }) {
  // Confirms the dealer CRM actually accepted and created the record for
  // this enquiry (Happy 1). Written once the outbound push succeeds and
  // cleared if reconciliation later finds the dealer no longer has it, so
  // an operator can tell "delivered" apart from "dealer never got this".
  const dealerCrmRecordId = lead.dealer_crm_record_id;

  const [copiedKey, setCopiedKey] = useState(null);
  const copyValue = (key) => (value) => {
    if (!value) return;
    navigator.clipboard?.writeText(String(value));
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };
  const isFusion = /fusion/i.test(String(lead.connected_crm || ""));

  return (
    <section className="md-card">
      <header className="md-banner">
        <span className="md-banner__icon" aria-hidden="true">
          <FileText size={26} strokeWidth={2.2} />
        </span>
        <div className="md-banner__text">
          <h3 className="md-banner__title">More Details</h3>
          <p className="md-banner__sub">Lead and activity information</p>
        </div>
        <div className="md-banner__art" aria-hidden="true">
          <span className="md-banner__tagline">Driven by you</span>
          <img src={mgCarImage} alt="" className="md-banner__car" />
        </div>
      </header>

      <div className="md-content">
        <div className="md-section">
          <div className="md-section__head">
            <h4 className="md-section__title">Lead Exchange Activity</h4>
            {onViewHistory && (
              <button type="button" className="md-section__link" onClick={onViewHistory}>
                View Activity History <ArrowRight size={15} strokeWidth={2.2} />
              </button>
            )}
          </div>
          <div className={`md-grid md-grid--${isFusion ? 5 : 4}`}>
            <DetailTile icon={Users} label="Connected CRM" value={val("connected_crm")} />
            <DetailTile icon={CalendarCheck} label="Enquiry Outcome" value={formatEnquiryOutcome(lead.enquiry_outcome)} />
            <DetailTile icon={Clock} label="Test Drive Date" value={formatActivityDate(lead.test_drive_date)} />
            <DetailTile icon={CircleX} label="Closed Date" value={formatActivityDate(lead.closed_date)} />
            {/* Fusion cannot be read back, so this is the word Fusion last sent (Open, Won,
                Delivered, Lost, Prospect Lost). Shown only for leads connected to Fusion. */}
            {isFusion && <DetailTile icon={FileText} label="Fusion current status" value={lead.dealer_crm_status || "Not reported yet"} />}
          </div>
        </div>

        <div className="md-section">
          <div className="md-section__head">
            <h4 className="md-section__title">Record IDs</h4>
          </div>
          <div className="md-grid md-grid--3">
            <DetailTile
              icon={FileText}
              label="CRM Record ID"
              value={val("crm_record_id")}
              mono
              copy
              copied={copiedKey === "crm"}
              onCopy={copyValue("crm")}
            />
            <DetailTile
              icon={UserCog}
              label="Dealer CRM Record ID"
              value={dealerCrmRecordId || "Not yet confirmed by dealer"}
              rawValue={dealerCrmRecordId}
              mono={Boolean(dealerCrmRecordId)}
              tone={dealerCrmRecordId ? "ok" : "pending"}
              copy={Boolean(dealerCrmRecordId)}
              copied={copiedKey === "dealer"}
              onCopy={copyValue("dealer")}
              highlight
            />
            <DetailTile
              icon={FileText}
              label="Enquiry ID"
              value={val("enquiry_id")}
              mono
              copy
              copied={copiedKey === "enquiry"}
              onCopy={copyValue("enquiry")}
            />
          </div>
        </div>

        <div className="md-section">
          <div className="md-section__head">
            <h4 className="md-section__title">Lead Info</h4>
          </div>
          <div className="md-grid md-grid--5">
            <DetailTile icon={Globe} label="Lead Source" value={val("lead_source")} />
            <DetailTile icon={Barcode} label="Postcode" value={val("postcode")} />
            <DetailTile icon={CalendarDays} label="Assigned Date" value={val("assigned_date")} />
            <DetailTile icon={Clock3} label="Last Status Update" value={val("last_status_update")} />
            <DetailTile icon={ArrowRight} label="Next Follow-up" value={val("next_followup_date")} />
          </div>
        </div>

        <div className="md-section">
          <div className="md-section__head">
            <h4 className="md-section__title">Consent</h4>
          </div>
          <div className="md-grid md-grid--2">
            <ConsentTile icon={ShieldCheck} label="Privacy Policy Accepted" value={formatBoolean(lead.accept_privacy_policy)} />
            <ConsentTile icon={Megaphone} label="Marketing Opt-in" value={formatBoolean(lead.receive_marketing_updates)} />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------
   Full Timeline Offcanvas
------------------------------------------------------------------ */
function TimelineOffcanvas({ open, onClose, timeline, loading }) {
  return (
    <>
      <div
        className={`lead-detail__offcanvas-backdrop ${open ? "lead-detail__offcanvas-backdrop--open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`lead-detail__offcanvas ${open ? "lead-detail__offcanvas--open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Full activity timeline"
      >
        <div className="lead-detail__offcanvas-header">
          <h3>
            <ClockIcon size={16} />
            Full Activity Timeline
          </h3>
          <CloseButton onClick={onClose} />
        </div>
        <div className="lead-detail__offcanvas-body">
          <ul className="lead-detail__timeline">
            <ActivityTimeline timeline={timeline} loading={loading} />
          </ul>
        </div>
      </aside>
    </>
  );
}

/* ----------------------------------------------------------------
   Delivery actions (admins): a lead whose delivery stopped.
     ACK_UNRESOLVED   the dealer accepted it without returning its id, so it
                      is never sent again; link the id from the dealer's CRM.
     RETRY_EXHAUSTED  automatic retries stopped; retry the delivery now.
------------------------------------------------------------------ */
function DeliveryActions({ lead, onDone }) {
  const { user } = useAuth();
  const [externalLeadId, setExternalLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const state = String(lead.sync_status || "").toUpperCase();
  const isAdmin = [APP_ROLES.ADMIN, APP_ROLES.SUPER_ADMIN].includes(user?.appRole);
  if (!isAdmin || !["ACK_UNRESOLVED", "RETRY_EXHAUSTED"].includes(state)) return null;

  const run = async (action, done) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: "success", text: done });
      // The action itself worked; a failed reload afterwards must not read as an action error.
      Promise.resolve(onDone?.()).catch(() => {});
    } catch (err) {
      setMessage({ tone: "error", text: err?.response?.data?.error || "The action failed. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lead-detail__group lead-detail__delivery-actions">
      <h3>Delivery needs attention</h3>
      {state === "ACK_UNRESOLVED" ? (
        <>
          <p>
            The dealer accepted this lead but returned no lead id, so it is not sent again. Find the lead in
            the dealer's CRM and enter its id to link it.
          </p>
          <div className="lead-detail__delivery-form">
            <input
              type="text"
              value={externalLeadId}
              onChange={(e) => setExternalLeadId(e.target.value)}
              placeholder="Dealer lead id, e.g. lead_01…"
              aria-label="Dealer lead id"
            />
            <button
              type="button"
              className="lead-detail__action-btn lead-detail__action-btn--mail"
              disabled={busy || !externalLeadId.trim()}
              onClick={() =>
                run(
                  () => dealerCrmIntegrationService.linkLead(lead.dealer_code, lead.crm_record_id, externalLeadId.trim()),
                  "Linked to the dealer's lead."
                )
              }
            >
              Link dealer lead id
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Automatic retries for this lead have stopped. Retry the delivery once the cause is fixed.</p>
          <button
            type="button"
            className="lead-detail__action-btn lead-detail__action-btn--mail"
            disabled={busy}
            onClick={() =>
              run(() => dealerCrmIntegrationService.replayLead(lead.dealer_code, lead.crm_record_id), "Delivery retried.")
            }
          >
            Retry delivery
          </button>
        </>
      )}
      {message && (
        <p className={`lead-detail__delivery-message lead-detail__delivery-message--${message.tone}`}>{message.text}</p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------
   Lead Detail
------------------------------------------------------------------ */
export default function LeadDetailView({ lead, onBack, onLeadChanged }) {
  const [copied, setCopied] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineOffcanvasOpen, setTimelineOffcanvasOpen] = useState(false);
  const [dealerActivities, setDealerActivities] = useState({ available: true, activities: [] });
  const [dealerActivitiesLoading, setDealerActivitiesLoading] = useState(true);
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const { showAlert } = useAlerts();

  // quiet = a refresh: keep showing the current timeline instead of the skeleton.
  const loadTimeline = useCallback(async ({ quiet = false } = {}) => {
    if (!lead.crm_record_id) {
      setTimelineLoading(false);
      return;
    }
    if (!quiet) setTimelineLoading(true);
    try {
      const rows = await adminDashboardService.getLeadTimeline(lead.crm_record_id);
      setTimeline(rows || []);
    } catch (err) {
      if (!quiet) setTimeline([]);
      else throw err;
    } finally {
      setTimelineLoading(false);
    }
  }, [lead.crm_record_id]);

  useEffect(() => {
    loadTimeline().catch(() => {});
  }, [loadTimeline]);

  // Calls, SMS, emails and notes the dealer logged in their CRM (Dealer Studio today).
  const loadDealerActivities = useCallback(async ({ quiet = false } = {}) => {
    if (!lead.crm_record_id) {
      setDealerActivitiesLoading(false);
      return;
    }
    if (!quiet) setDealerActivitiesLoading(true);
    try {
      setDealerActivities(await adminDashboardService.getLeadDealerActivities(lead.crm_record_id));
    } catch (err) {
      if (!quiet) setDealerActivities({ available: false, activities: [] });
      else throw err;
    } finally {
      setDealerActivitiesLoading(false);
    }
  }, [lead.crm_record_id]);

  useEffect(() => {
    loadDealerActivities().catch(() => {});
  }, [loadDealerActivities]);

  // Reloads the lead (and the list behind it), its activity timeline and dealer activity.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([onLeadChanged?.(), loadTimeline({ quiet: true }), loadDealerActivities({ quiet: true })]);
      setUpdatedAt(new Date());
    } catch (err) {
      showAlert("error", "Couldn't refresh this lead. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  // Lock background scroll while the offcanvas is open.
  useEffect(() => {
    if (timelineOffcanvasOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [timelineOffcanvasOpen]);

  const val = (key) => {
    const value = lead[key];
    return value && String(value).trim() ? value : "—";
  };

  const isRemoved = normalize(lead.sync_status) === "removed";

  const mobile = val("mobile_number");
  const email = val("email_address");
  // UI-only flag: an invalid/non-Australian mobile number is never blocked
  // from the dealer CRM push or the normal Happy Path — it's just
  // highlighted here so an operator can follow up if needed.
  const mobileIsInvalid = mobile !== "—" && !isValidAustralianMobile(mobile);

  // FIX: was `lead.happy_unhappy_path_name ? {...} : classifyPath(lead)`,
  // which trusted a possibly-stale stored name over the lead's live
  // status. See resolveDisplayPath's comment above for why.
  const path = resolveDisplayPath(lead);

  const journeyPaths = getDistinctPaths(timeline);

  // Activity-based Follow-up 1 / 2: the reason under the status, and the activity badges.
  const activityFollowUpInfo = activityFollowUps(timeline, lead.lead_status);
  const statusReason = activityFollowUpInfo.current
    ? `Set by dealer activity: ${describeDealerActivity(activityFollowUpInfo.current.activities.at(-1))}`
    : null;

  // Only dealers whose CRM sends activities get the card, plus any lead that already has some.
  const showDealerActivity =
    dealerActivities.available &&
    (crmBadgeTone(lead.dealer_crm || lead.connected_crm) === "studio" || dealerActivities.activities.length > 0);

  // The reason behind the CURRENT path, taken from the most recent failure
  // on this lead. getLeadActivityTimeline returns oldest-first, so the last
  // failing entry is the live one. Only shown while the lead is actually on
  // an unhappy path - a recovered lead should not still display the fault
  // that has since been fixed.
  const latestFailureDetail = (() => {
    if (!path || path.type !== "unhappy") return null;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const detail = errorDetailText(timeline[i]);
      if (detail) return detail;
    }
    return null;
  })();

  const handleCopy = (key, value) => {
    if (!value || value === "—") return;
    navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className={`lead-detail${refreshing ? " lead-detail--refreshing" : ""}`}>
      <div className="lead-detail__toolbar">
        <button type="button" className="lead-detail__back" onClick={onBack}>
          <ChevronLeftIcon size={16} />
          Back to Leads
        </button>

        <div className="lead-detail__toolbar-end">
          <span className="lead-detail__updated" aria-live="polite">
            {refreshing
              ? "Refreshing..."
              : `Updated ${updatedAt.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`}
          </span>
          <button
            type="button"
            className={`lead-detail__refresh${refreshing ? " lead-detail__refresh--spinning" : ""}`}
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh this lead"
            title="Reload this lead and its activity timeline"
          >
            <RefreshCw size={15} strokeWidth={2.2} />
            Refresh
          </button>
        </div>
        <div className="lead-detail__loadbar" aria-hidden="true" />
      </div>

      {/* ========================================================== HERO ========================================================== */}
      <div className="lead-detail__hero">
        <div className="lead-detail__hero-decor" aria-hidden="true">
          <img src={mgLogo} alt="" className="lead-detail__hero-logo" />
        </div>

        <span className="lead-detail__avatar">{initials(lead.customer_name)}</span>

        <div className="lead-detail__hero-main">
          <div className="lead-detail__hero-top">
            <h1>{lead.customer_name || "Unnamed Customer"}</h1>
            {isRemoved ? <StatusPill status="Removed" /> : <StatusPill status={lead.lead_status} />}
          </div>
          {!isRemoved && statusReason && <p className="lead-detail__status-reason">{statusReason}</p>}

          {/* All distinct scenarios this lead has been through, not just the current one */}
          <PathChips paths={journeyPaths.length > 0 ? journeyPaths : [path]} currentId={path.id} />

          <div className="lead-detail__hero-meta">
            <span className="lead-detail__meta-item">
              <BuildingIcon size={15} />
              {val("dealer_name")}
            </span>
            <span className="lead-detail__meta-divider" />
            <span className="lead-detail__meta-item">
              <ArrowRightIcon size={14} />
              <span className="lead-detail__meta-label">Dealer Code</span>
              {val("dealer_code")}
            </span>
            {/* The dealer's CRM: from the lead list (dealer_crm) or MG's Connected CRM field. */}
            {(lead.dealer_crm || lead.connected_crm) && (
              <>
                <span className="lead-detail__meta-divider" />
                <span
                  className={`lead-detail__crm-badge lead-detail__crm-badge--${crmBadgeTone(lead.dealer_crm || lead.connected_crm)}`}
                  title="Dealer CRM"
                >
                  {lead.dealer_crm || lead.connected_crm}
                </span>
              </>
            )}
            {lead.lead_source && (
              <>
                <span className="lead-detail__meta-divider" />
                <span className="lead-detail__source-badge">
                  <MegaphoneIcon size={13} />
                  {lead.lead_source}
                </span>
              </>
            )}
          </div>

          {val("enquiry_id") !== "—" && (
            <div className="lead-detail__idrow">
              <span className="lead-detail__idchip">
                <span className="lead-detail__idchip-label">Enquiry ID</span>
                <span className="lead-detail__idchip-value">{val("enquiry_id")}</span>
                <button
                  type="button"
                  className="lead-detail__copy-btn"
                  onClick={() => handleCopy("enquiry", val("enquiry_id"))}
                  aria-label="Copy enquiry ID"
                >
                  <CopyIcon />
                </button>
                {copied === "enquiry" && <span className="lead-detail__copied-tag">Copied</span>}
              </span>
            </div>
          )}
        </div>

        <div className="lead-detail__vehicle-highlight">
          <span className="lead-detail__vehicle-icon">
            <CarFront size={22} strokeWidth={1.9} />
          </span>
          <div className="lead-detail__vehicle-content">
            <span className="lead-detail__vehicle-label">Vehicle</span>
            <span className="lead-detail__vehicle-model">{val("vehicle_model")}</span>
          </div>
        </div>
      </div>

      {/* ========================================================== CONTACT INFO ========================================================== */}
      <div className="lead-detail__infobar">
        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <PhoneIcon size={18} />
          </span>
          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">Mobile</span>
            <span className="lead-detail__infobar-value">
              {mobile}
              {mobile !== "—" && (
                <button type="button" className="lead-detail__copy-btn" onClick={() => handleCopy("mobile", mobile)} aria-label="Copy mobile number">
                  <CopyIcon />
                </button>
              )}
              {copied === "mobile" && <span className="lead-detail__copied-tag">Copied</span>}
              {mobileIsInvalid && (
                <span className="lead-detail__mobile-warning" title="Invalid Australian mobile number">
                  <AlertCircleIcon /> Invalid Australian Mobile
                </span>
              )}
            </span>
            {mobile !== "—" && (
              <a href={`tel:${mobile}`} className="lead-detail__action-btn lead-detail__action-btn--call">
                <PhoneIcon size={13} />
                Call Now
              </a>
            )}
          </div>
        </div>

        <span className="lead-detail__infobar-divider" />

        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <MailIcon size={18} />
          </span>
          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">Email</span>
            <span className="lead-detail__infobar-value">
              {email}
              {email !== "—" && (
                <button type="button" className="lead-detail__copy-btn" onClick={() => handleCopy("email", email)} aria-label="Copy email address">
                  <CopyIcon />
                </button>
              )}
              {copied === "email" && <span className="lead-detail__copied-tag">Copied</span>}
            </span>
            {email !== "—" && (
              <a href={`mailto:${email}`} className="lead-detail__action-btn lead-detail__action-btn--mail">
                <MailIcon size={13} />
                Send Mail
              </a>
            )}
          </div>
        </div>
      </div>

      {/* ========================================================== INTEGRATION PATH ========================================================== */}
      <IntegrationPathCard
        path={path}
        journeyPaths={journeyPaths}
        failureDetail={latestFailureDetail}
      />

      <DeliveryActions lead={lead} onDone={onLeadChanged} />

      <MoreDetailsCard val={val} lead={lead} onViewHistory={() => setTimelineOffcanvasOpen(true)} />

      {/* ========================================================== CUSTOMER MESSAGE + TIMELINE ========================================================== */}
      <div className="lead-detail__footer-groups">
        <section className="lead-detail__group lead-detail__remarks-card">
          <h3>
            <span className="lead-detail__group-icon">
              <NoteIcon size={15} />
            </span>
            Customer Message
          </h3>
          <p className="lead-detail__remarks-text">
            {val("customer_message") !== "—" ? val("customer_message") : "No message from customer yet."}
          </p>
        </section>

        <section className="lead-detail__group lead-detail__timeline-card">
          <h3>
            <span className="lead-detail__group-icon">
              <ClockIcon size={15} />
            </span>
            Activity Timeline
          </h3>

          <div className="lead-detail__timeline-scroll">
            <ul className="lead-detail__timeline">
              <ActivityTimeline timeline={timeline.slice(-6)} loading={timelineLoading} />
            </ul>
          </div>

          {timeline.length > 0 && (
            <button
              type="button"
              className="lead-detail__timeline-viewfull-btn"
              onClick={() => setTimelineOffcanvasOpen(true)}
            >
              View Full Timeline ({timeline.length})
            </button>
          )}
        </section>
      </div>

      {/* ========================================================== DEALER ACTIVITY ========================================================== */}
      {showDealerActivity && (
        <section className="lead-detail__group lead-detail__timeline-card">
          <h3>
            <span className="lead-detail__group-icon">
              <PhoneIcon size={15} />
            </span>
            Dealer Activity
            {!dealerActivitiesLoading && dealerActivities.activities.length > 0 && ` (${dealerActivities.activities.length})`}
          </h3>
          <div className="lead-detail__timeline-scroll">
            <ul className="lead-detail__timeline">
              <DealerActivityList
                activities={dealerActivities.activities}
                loading={dealerActivitiesLoading}
                followUps={activityFollowUpInfo.byActivity}
              />
            </ul>
          </div>
          {!dealerActivitiesLoading && dealerActivities.activities.length > 0 && (
            <button
              type="button"
              className="lead-detail__timeline-viewfull-btn"
              onClick={() => setActivityModalOpen(true)}
            >
              View Full Activity ({dealerActivities.activities.length})
            </button>
          )}
        </section>
      )}

      {activityModalOpen && (
        <Modal
          width={1100}
          onClose={() => setActivityModalOpen(false)}
          title={
            <span className="dact__modal-title">
              <span className="lead-detail__group-icon">
                <PhoneIcon size={15} />
              </span>
              Dealer Activity
              <span className="dact__modal-sub">
                {lead.customer_name || "Lead"} · {lead.dealer_name || lead.dealer_code || "Dealer"}
              </span>
            </span>
          }
        >
          <DealerActivityPanel
            activities={dealerActivities.activities}
            loading={dealerActivitiesLoading}
            followUps={activityFollowUpInfo.byActivity}
          />
        </Modal>
      )}

      {/* ========================================================== DEALER REMARKS ========================================================== */}
      <section className="lead-detail__group lead-detail__remarks-card">
        <h3>
          <span className="lead-detail__group-icon">
            <PencilIcon size={15} />
          </span>
          Dealer Remarks
        </h3>
        <p className="lead-detail__remarks-text">
          {val("dealer_remarks") !== "—" ? val("dealer_remarks") : "No remarks yet."}
        </p>
      </section>

      <TimelineOffcanvas
        open={timelineOffcanvasOpen}
        onClose={() => setTimelineOffcanvasOpen(false)}
        timeline={timeline}
        loading={timelineLoading}
      />
    </div>
  );
}
