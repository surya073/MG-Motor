/**
 * mockBackend.js (local UI work only)
 * -----------------------------------------------------------------------
 * `REACT_APP_MOCK_API=true npm start` (see config/env.js) signs in a fake
 * Super Admin and answers the portal's API calls with dummy, in-memory data,
 * so pages can be designed on localhost without Catalyst or real dealers.
 * Nothing here is used in a production build. All data is made up.
 */
import axiosInstance from "../services/api/axiosInstance";

const SUPER_ADMIN_ROLE_ID = "818000000022006"; // constants/auth.constants.js: App Administrator

const DEALERS = [
  ["421501", "Gold Coast MG", "QLD", "DEALER_STUDIO", "ACTIVE", true],
  ["302901", "Werribee MG", "VIC", "DEALER_STUDIO", "ACTIVE", true],
  ["315602", "Ferntree Gully MG", "VIC", "DEALER_STUDIO", "ACTIVE", true],
  ["275002", "Heartland MG Penrith", "NSW", "DEALER_STUDIO", "ACTIVE", true],
  ["248601", "Victory MG", "VIC", "DEALER_STUDIO", "CONNECTED", true],
  ["253601", "Batemans Bay MG", "NSW", "DEALER_STUDIO", "CONNECTED", false],
  ["411802", "Hillcrest MG", "QLD", "FUSION_SD", "ACTIVE", true],
  ["568026", "Fusion Test Dealer", "NSW", "FUSION_SD", "ACTIVE", true],
  ["654322", "AutoplayTest Dealer", "VIC", "AUTOPLAY", "CONNECTED", true],
  ["369001", "Albury MG", "NSW", null, null, false],
  ["384402", "Shepparton MG", "VIC", null, null, false],
  ["2101012", "Northern Beaches MG", "NSW", null, null, false],
  ["455801", "Sunshine Coast MG", "QLD", null, null, false],
  ["313401", "Ringwood MG", "VIC", null, null, false],
].map(([dealer_code, dealer_name, region, crm_type, status, push]) => ({
  dealer_code, dealer_name, region, crm_type, push,
  integration_status: status, sync_status: "Synced",
  email_address: `${dealer_name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
}));

const BASES = {
  DEALER_STUDIO: "https://dashboard.dealerstudio.com.au",
  FUSION_SD: "https://qa.fusionamspro.com/api/leadapi",
  AUTOPLAY: "https://api.autoplayauto.com",
};
const LABELS = { DEALER_STUDIO: "Dealer Studio", FUSION_SD: "Fusion SD", AUTOPLAY: "AutoPlay" };

const integrations = new Map(
  DEALERS.filter((d) => d.crm_type).map((d, i) => [d.dealer_code, {
    ROWID: String(818000000300000 + i),
    dealer_code: d.dealer_code,
    integration_type: "EXTERNAL_CRM",
    crm_type: d.crm_type,
    crm_name: LABELS[d.crm_type],
    base_url: BASES[d.crm_type],
    auth_type: d.crm_type === "DEALER_STUDIO" ? "BEARER_TOKEN" : null,
    create_lead_endpoint: d.crm_type === "FUSION_SD" ? "/v1/leads" : "/api/v1/leads",
    update_lead_endpoint: d.crm_type === "FUSION_SD" ? "/v1/leads/{externalLeadId}" : "/api/v1/leads/{externalLeadId}",
    http_method: "POST",
    update_http_method: d.crm_type === "AUTOPLAY" ? "PATCH" : "PUT",
    webhook_enabled: true,
    outbound_enabled: true,
    inbound_enabled: true,
    push_enabled: d.push,
    push_from_at: "2026-11-25 13:00:00",
    status: d.integration_status,
    last_tested_at: "2026-11-26 04:58:18",
    dealership_slug: d.crm_type === "DEALER_STUDIO" ? `${d.dealer_name.toLowerCase().replace(/[^a-z]+/g, "-")}group` : null,
    dealership_location_id: d.crm_type === "DEALER_STUDIO" ? "1968" : null,
    autoplay_dealer_id: d.crm_type === "AUTOPLAY" ? "2220" : null,
    autoplay_yard_id: null,
    autoplay_source_id: d.crm_type === "AUTOPLAY" ? "2685" : null,
    autoplay_campaign_id: d.crm_type === "AUTOPLAY" ? "17188" : null,
  }])
);

const FIELD_MAPS = {
  DEALER_STUDIO: [["first_name", "first_name"], ["last_name", "last_name"], ["email_address", "email"], ["mobile_number", "mobile"],
    ["nature_of_enquiry", "category"], ["postcode", "address_attributes.postcode"], ["accept_privacy_policy", "fields.privacy_policy_accepted"],
    ["enquiry_id", "provider_id"], ["dealer_code", "dealer_code"], ["lead_status", "status"]],
  FUSION_SD: [["enquiry_id", "refID"], ["mobile_number", "contact.phone"], ["email_address", "contact.email"], ["postcode", "contact.areaCode"],
    ["nature_of_enquiry", "leadSource"], ["accept_privacy_policy", "privacy"], ["lead_status", "enquiryStatus"]],
  AUTOPLAY: [["first_name", "contact.firstName"], ["last_name", "contact.lastName"], ["email_address", "contact.email"],
    ["mobile_number", "contact.mobile"], ["postcode", "contact.postcode"], ["accept_privacy_policy", "privacyPolicyAccepted"],
    ["enquiry_id", "integrationRef"], ["nature_of_enquiry", "campaignId"], ["lead_status", "progressName"]],
};
const STATUS_MAPS = {
  DEALER_STUDIO: [["Not Contacted", "new"], ["Contacted", "working"], ["Lost Lead", "lost"], ["Not Qualified", "invalid"]],
  FUSION_SD: [["Not Contacted", "Open"], ["Not Qualified", "Prospect Lost"]],
  AUTOPLAY: [["Not Contacted", "Awaiting Action"], ["Attempted to Contact", "Email Sent"], ["Contacted", "Phone Call Made"], ["Lost Lead", "Closed - Lost"]],
};

const STATUSES = ["Not Contacted", "Update Pending", "Follow-up 1", "Follow-up 2", "Contacted", "Contact in Future", "Not Qualified",
  "Lost Lead", "Attempted to Contact", "Junk Lead", "Pre-Qualified", "Finance Intro", "Dealer Unavailable", "Unattended Alert", "PMA Unassigned"];

function logsFor(code) {
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  return [
    { ROWID: "1", created_at: at(5), direction: "ZOHO_TO_EXTERNAL_CRM", operation: "CREATE_LEAD", zoho_lead_id: "44707000062198418", external_lead_id: "4292300", status: "SUCCESS", http_status: 201, scenario: "Happy 1" },
    { ROWID: "2", created_at: at(22), direction: "EXTERNAL_CRM_TO_ZOHO", operation: "UPDATE_LEAD", zoho_lead_id: "44707000062198439", external_lead_id: "4292301", status: "SUCCESS", http_status: 200, scenario: "Happy 2" },
    { ROWID: "3", created_at: at(40), direction: "ZOHO_TO_EXTERNAL_CRM", operation: "CREATE_LEAD", zoho_lead_id: "44707000062198409", external_lead_id: null, status: "FAILED", http_status: 401, error_message: "AUTHENTICATION_FAILED: HTTP 401 - API key not authorised for this dealership", scenario: "Unhappy 1" },
    { ROWID: "4", created_at: at(65), direction: "ZOHO_TO_EXTERNAL_CRM", operation: "TEST_CONNECTION", zoho_lead_id: null, status: "SUCCESS", http_status: 200 },
    { ROWID: "5", created_at: at(90), direction: "EXTERNAL_CRM_TO_ZOHO", operation: "UPDATE_LEAD", zoho_lead_id: "44707000062211003", external_lead_id: "4292315", status: "SKIPPED", error_message: "No status change in this update", scenario: "Happy 5" },
  ].map((row) => ({ ...row, dealer_code: code }));
}

// ---- Leads (Lead Exchange list + detail view). Names, contacts and ids are made up.
const LEAD_BASE = {
  dealer_crm: "Dealer Studio", connected_crm: "Dealer Studio", lead_source: "OEM AU Website", nature_of_enquiry: "Test Drive",
  accept_privacy_policy: true, receive_marketing_updates: false, sync_status: "SYNCED", enquiry_outcome: "Outcome Pending",
  customer_message: "", dealer_remarks: null, next_followup_date: null, closed_date: null, test_drive_date: null,
};
const LEADS = [
  { ROWID: "900000000000001", crm_record_id: "44707000099000001", enquiry_id: "MGENQ90001", customer_name: "Ava Thompson",
    email_address: "ava.thompson@example.com", mobile_number: "0400000101", postcode: "3030", vehicle_model: "MG4 EV Urban",
    dealer_code: "302901", dealer_name: "Werribee MG", dealer_crm_record_id: "4300001", lead_status: "Follow-up 2",
    assigned_date: "2026-11-25 10:15:00", last_status_update: "2026-11-27 13:49:56", happy_unhappy_path_name: "Happy 2",
    happy_unhappy_path_message: "Status update (dealer → OEM)", customer_message: "Interested in a test drive this weekend." },
  { ROWID: "900000000000002", crm_record_id: "44707000099000002", enquiry_id: "MGENQ90002", customer_name: "Liam Chen",
    email_address: "liam.chen@example.com", mobile_number: "0400000102", postcode: "4217", vehicle_model: "MG ZS",
    dealer_code: "421501", dealer_name: "Gold Coast MG", dealer_crm_record_id: "4300002", lead_status: "Follow-up 1",
    assigned_date: "2026-11-26 09:05:00", last_status_update: "2026-11-27 10:12:00", happy_unhappy_path_name: "Happy 2",
    happy_unhappy_path_message: "Status update (dealer → OEM)" },
  { ROWID: "900000000000003", crm_record_id: "44707000099000003", enquiry_id: "MGENQ90003", customer_name: "Olivia Patel",
    email_address: "olivia.patel@example.com", mobile_number: "0400000103", postcode: "2750", vehicle_model: "MGS5 EV",
    dealer_code: "275002", dealer_name: "Heartland MG Penrith", dealer_crm_record_id: "4300003", lead_status: "Contacted",
    assigned_date: "2026-11-24 14:30:00", last_status_update: "2026-11-27 14:03:47", happy_unhappy_path_name: "Happy 2",
    happy_unhappy_path_message: "Status update (dealer → OEM)" },
  { ROWID: "900000000000004", crm_record_id: "44707000099000004", enquiry_id: "MGENQ90004", customer_name: "Noah Williams",
    email_address: "noah.williams@example.com", mobile_number: "0400000104", postcode: "3156", vehicle_model: "MG3",
    dealer_code: "315602", dealer_name: "Ferntree Gully MG", dealer_crm_record_id: "4300004", lead_status: "Lost Lead",
    enquiry_outcome: "Lost", closed_date: "2026-11-26", assigned_date: "2026-11-23 11:00:00", last_status_update: "2026-11-26 16:43:07",
    happy_unhappy_path_name: "Happy 2", happy_unhappy_path_message: "Status update (dealer → OEM)",
    dealer_remarks: "Unable to contact despite several attempts" },
  { ROWID: "900000000000005", crm_record_id: "44707000099000005", enquiry_id: "MGENQ90005", customer_name: "Mia Rossi",
    email_address: "mia.rossi@example.com", mobile_number: "0400000105", postcode: "2250", vehicle_model: "MG HS",
    dealer_code: "411802", dealer_name: "Hillcrest MG", dealer_crm: "Fusion SD", connected_crm: "Fusion SD",
    dealer_crm_record_id: "lead_01MOCK00000000000000000005", lead_status: "Not Contacted", sync_status: "HELD",
    assigned_date: "2026-11-23 13:31:00", last_status_update: "2026-11-23 13:31:25", happy_unhappy_path_name: "Unhappy 4",
    happy_unhappy_path_message: "Mapping failure — dealer status \"pendingLost\" is not in the approved map" },
].map((lead) => ({ ...LEAD_BASE, ...lead }));

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const act = (id, type, user, at, description) => ({
  id, event_type: type, user_name: user, created_at: at, updated_at: at, description, dealer_code: null, crm_type: "DEALER_STUDIO",
});
const ACTIVITIES = {
  "44707000099000001": [
    act("7000001", "phone", "Sam Taylor", "2026-11-25T00:39:49.341Z", "Called, left a voicemail"),
    act("7000002", "sms", "Sam Taylor", "2026-11-25T00:41:12.000Z", "Hi Ava, it's Sam from Werribee MG about your MG4 test drive."),
    act("7000003", "email", "Sam Taylor", "2026-11-26T02:10:00.000Z", "Sent brochure and test drive times"),
    act("7000004", "note", "Sam Taylor", "2026-11-26T02:12:00.000Z", "Customer prefers Saturday morning"),
  ],
  "44707000099000002": [act("7000011", "phone", "Jordan Lee", "2026-11-26T23:12:00.000Z", "First call, no answer")],
  "44707000099000003": [
    act("7000021", "ai_sms", null, "2026-11-24T03:31:00.000Z", "AI SMS sent to customer"),
    act("7000022", "phone", "Robert Brockwell", "2026-11-24T05:02:00.000Z", "Called, booked a showroom visit"),
  ],
  "44707000099000004": [act("7000031", "phone", "Alex Kim", "2026-11-25T01:00:00.000Z", "No answer"),
    act("7000032", "phone", "Alex Kim", "2026-11-26T05:30:00.000Z", "No answer, closing")],
};

const sent = (minutesAgo, scenario, message, operation = "CREATE_LEAD") => ({
  created_at: ago(minutesAgo), direction: "ZOHO_TO_EXTERNAL_CRM", operation, status: "SUCCESS",
  happy_unhappy_path_name: scenario, happy_unhappy_path_message: message,
  field_changes: JSON.stringify([{ field: "delivery_timing", sent_at: ago(minutesAgo), acknowledged_at: ago(minutesAgo), duration_ms: 812 }]),
});
const statusChange = (minutesAgo, from, to, extra = {}) => ({
  created_at: ago(minutesAgo), direction: "EXTERNAL_CRM_TO_ZOHO", operation: "UPDATE_LEAD", status: "SUCCESS",
  happy_unhappy_path_name: "Happy 2", happy_unhappy_path_message: "Status update (dealer → OEM)",
  field_changes: JSON.stringify([{ field: "lead_status", from, to, ...extra }]),
});
const viaActivity = (activities) => ({
  trigger: "DEALER_ACTIVITY", activity_count: activities.length,
  activities: activities.map((a) => ({ id: a.id, type: a.event_type, user: a.user_name, at: a.created_at })),
});
const A = ACTIVITIES;
const TIMELINES = {
  "44707000099000001": [
    sent(3200, "Happy 1", "Lead delivered to dealer"),
    { ...statusChange(120, "Not Contacted", "Follow-up 2"),
      field_changes: JSON.stringify([{ field: "lead_status", from: "Not Contacted", to: "Follow-up 2",
        ...viaActivity([A["44707000099000001"][0], A["44707000099000001"][1]]), activity_count: 4 }]) },
  ],
  "44707000099000002": [
    sent(1900, "Happy 1", "Lead delivered to dealer"),
    { ...statusChange(240, "Not Contacted", "Follow-up 1"),
      field_changes: JSON.stringify([{ field: "lead_status", from: "Not Contacted", to: "Follow-up 1", ...viaActivity(A["44707000099000002"]) }]) },
  ],
  "44707000099000003": [
    sent(4300, "Happy 1", "Lead delivered to dealer"),
    { ...statusChange(150, "Not Contacted", "Follow-up 2"),
      field_changes: JSON.stringify([{ field: "lead_status", from: "Not Contacted", to: "Follow-up 2", ...viaActivity(A["44707000099000003"]) }]) },
    statusChange(60, "Follow-up 2", "Contacted", { raw_dealer_value: "working" }),
  ],
  "44707000099000004": [
    sent(5800, "Happy 1", "Lead delivered to dealer"),
    statusChange(1500, "Not Contacted", "Lost Lead", { raw_dealer_value: "lost" }),
  ],
  "44707000099000005": [
    sent(6100, "Happy 1", "Lead delivered to dealer"),
    { created_at: ago(5900), direction: "EXTERNAL_CRM_TO_ZOHO", operation: "UPDATE_LEAD", status: "FAILED",
      happy_unhappy_path_name: "Unhappy 4", happy_unhappy_path_message: "Mapping failure — dealer status \"pendingLost\" is not in the approved map",
      error_message: "STATUS_MAPPING_NOT_FOUND: dealer sent \"pendingLost\"", field_changes: null },
  ],
};

function findLead(id) {
  const key = decodeURIComponent(id);
  return LEADS.find((l) => l.ROWID === key || l.crm_record_id === key) || null;
}

function leadRoute(method, path) {
  let m;
  if (method !== "get") return null;
  if (path === "/admin/leads") {
    const statuses = [...new Set(LEADS.map((l) => l.lead_status))];
    return json({
      leads: LEADS,
      pagination: { page: 1, pageSize: 25, total: LEADS.length, totalPages: 1, hasMore: false },
      facets: {
        total: LEADS.length, statuses,
        dealers: [...new Map(LEADS.map((l) => [l.dealer_code, { code: l.dealer_code, name: l.dealer_name }])).values()],
        scenarios: [...new Set(LEADS.map((l) => l.happy_unhappy_path_name))],
        pathCounts: { happy: LEADS.filter((l) => /^Happy/.test(l.happy_unhappy_path_name)).length,
          unhappy: LEADS.filter((l) => /^Unhappy/.test(l.happy_unhappy_path_name)).length },
      },
    });
  }
  if ((m = path.match(/^\/admin\/leads\/detail\/([^/]+)$/))) {
    const lead = findLead(m[1]);
    return lead ? json({ lead }) : json({ error: "NOT_FOUND" }, 404);
  }
  if ((m = path.match(/^\/admin\/leads\/([^/]+)\/timeline$/))) return json({ timeline: TIMELINES[decodeURIComponent(m[1])] || [] });
  if ((m = path.match(/^\/admin\/leads\/([^/]+)\/dealer-activities$/))) {
    const lead = findLead(m[1]);
    const rows = (ACTIVITIES[decodeURIComponent(m[1])] || []).map((a) => ({ ...a, dealer_code: lead?.dealer_code || null }));
    return json({ available: true, activities: rows });
  }
  if (path === "/admin/search-suggestions") return json({ leads: LEADS.slice(0, 5), dealers: [] });
  return null;
}

const json = (data, status = 200) => ({ status, data });

function route(method, url, body) {
  const path = url.replace(/^.*\/mg_motors_au_function/, "").split("?")[0];
  const leadResponse = leadRoute(method, path);
  if (leadResponse) return leadResponse;
  let m;
  if (method === "get" && path === "/admin/dealers") {
    return json({ dealers: DEALERS.map((d) => ({ ...d, integration_status: integrations.get(d.dealer_code)?.status || null })) });
  }
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration$/))) {
    const code = decodeURIComponent(m[1]);
    if (method === "get") {
      const row = integrations.get(code);
      return row ? json({ integration: row, hasCredential: true, hasWebhookSigningSecret: row.crm_type !== "AUTOPLAY" }) : json({ error: "INTEGRATION_NOT_CONFIGURED" }, 404);
    }
    if (method === "put") {
      const prev = integrations.get(code) || { ROWID: String(818000000400000 + integrations.size), dealer_code: code };
      const next = { ...prev, ...body, status: prev.status === "ACTIVE" || prev.status === "CONNECTED" ? "CONFIGURING" : "NOT_CONFIGURED" };
      Object.keys(next).filter((k) => /secret|client_id|access_key|credential|refresh_token/.test(k)).forEach((k) => delete next[k]);
      integrations.set(code, next);
      return json({ integration: next });
    }
    if (method === "delete") {
      integrations.delete(code);
      return json({ ok: true, deleted: {} });
    }
  }
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration\/test$/))) {
    const row = integrations.get(decodeURIComponent(m[1]));
    if (row) row.status = "CONNECTED";
    return json({ ok: true, httpStatus: 200, responseTimeMs: 312 });
  }
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration\/mappings$/))) {
    const row = integrations.get(decodeURIComponent(m[1]));
    if (method === "put") return json({ ok: true });
    const type = row?.crm_type;
    return json({
      fieldMappings: (FIELD_MAPS[type] || []).map(([source_field, target_field], i) => ({ ROWID: String(i + 1), source_field, target_field, data_type: /privacy|optIn/.test(target_field) ? "boolean" : "string", required: true })),
      statusMappings: (STATUS_MAPS[type] || []).map(([source_status, target_status], i) => ({ ROWID: String(100 + i), source_status, target_status, inbound_only: type !== "FUSION_SD" })),
    });
  }
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration\/logs$/))) return json({ logs: logsFor(decodeURIComponent(m[1])) });
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration\/push-queue$/))) return json({ count: 3, oldest_created_at: "2026-11-25 23:35:36", sample: [] });
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration\/push$/))) {
    const row = integrations.get(decodeURIComponent(m[1]));
    if (row) row.push_enabled = Boolean(body?.enabled);
    return json({ push_enabled: Boolean(body?.enabled), queued: 0, pushed: 0, skipped: 0, failed: 0, remaining: 0 });
  }
  if ((m = path.match(/^\/admin\/dealers\/([^/]+)\/integration\/webhook-info$/))) {
    const code = decodeURIComponent(m[1]);
    const row = integrations.get(code);
    const dealer = DEALERS.find((d) => d.dealer_code === code);
    const type = row?.crm_type;
    const names = { AUTOPLAY: "AUTOPLAY_WEBHOOK_SECRET", DEALER_STUDIO: "DEALER_STUDIO_WEBHOOK_SECRET", FUSION_SD: "FUSION_WEBHOOK_SECRET" };
    return json({
      dealerCode: code, dealerName: dealer?.dealer_name, crmType: type, crmLabel: LABELS[type] || type, status: row?.status,
      webhookUrl: `https://mg-motors-au.example.com/server/mg_motors_au_function/webhooks/dealers/${code}`, method: "POST",
      header: type === "DEALER_STUDIO" ? "X-API-KEY (or X-Authorization)" : "X-Webhook-Token",
      secretName: names[type] || null, secret: "dummy0secret0for0local0ui0only0000000000000000000000000000000000",
      enforced: type !== "FUSION_SD",
      note: type === "FUSION_SD" ? "Not enforced now: Fusion updates are accepted without a secret." : `Shared by every ${LABELS[type]} dealer (dummy value).`,
    });
  }
  if (path.startsWith("/admin/dealers/oem-crm/status-picklist")) {
    return json({ ok: true, count: STATUSES.length, values: STATUSES.map((value) => ({ value, display_label: value === "Lost Lead" ? "Lost" : value })) });
  }
  // Anything else the shell asks for (notifications, counts, ...): empty but valid.
  return json(method === "get" ? { success: true, items: [], notifications: [], data: [], count: 0, total: 0 } : { ok: true, success: true });
}

export function installMockBackend() {
  // A signed-in Super Admin, without the Catalyst Web SDK.
  const profile = {
    user_id: "818000000099999", first_name: "Local", last_name: "Admin", email_id: "local.admin@example.com",
    role_details: { role_id: SUPER_ADMIN_ROLE_ID, role_name: "App Administrator" },
  };
  window.catalyst = {
    auth: {
      isUserAuthenticated: async () => ({ content: profile }),
      generateAuthToken: async () => ({ access_token: "mock-token" }),
      signOut: () => {},
      signIn: () => {},
    },
  };

  axiosInstance.defaults.adapter = async (config) => {
    const method = (config.method || "get").toLowerCase();
    let body = config.data;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* keep as is */ }
    }
    // Feel of a real request. Set localStorage "mockDelayMs" (e.g. 4000) to slow every
    // request down and inspect loading skeletons.
    let delayMs = 250;
    try { delayMs = Number(window.localStorage.getItem("mockDelayMs")) || 250; } catch { /* default */ }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const { status, data } = route(method, config.url || "", body);
    const response = { data, status, statusText: String(status), headers: {}, config, request: {} };
    if (status >= 400) {
      const error = new Error(`Request failed with status code ${status}`);
      error.response = response;
      error.config = config;
      throw error;
    }
    return response;
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/server/")) {
      return new Response(JSON.stringify({ dealer_code: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  };

  // eslint-disable-next-line no-console
  console.info("[mockBackend] Local mock mode: fake admin and dummy data, no real API calls.");
}
