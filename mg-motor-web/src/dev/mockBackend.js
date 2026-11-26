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

const json = (data, status = 200) => ({ status, data });

function route(method, url, body) {
  const path = url.replace(/^.*\/mg_motors_au_function/, "").split("?")[0];
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
    await new Promise((resolve) => setTimeout(resolve, 250)); // feel of a real request
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
