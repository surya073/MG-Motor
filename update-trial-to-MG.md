# Trial → MG (AU) move: what changed, what is deployed (18 Nov 2026)

What was changed in the MG Motor AU Lead Exchange middleware to move it from the trial Catalyst project to the
MG (AU) project, and the current deploy state. Code facts below were checked against `main`.

**Repo:** `https://github.com/surya073/MG-Motor.git` · `main` at `c389310` (all work committed and pushed)
**Backend:** `functions/mg_motors_au_function` · **Portal:** `mg-motor-web`

## Deploy status

| Item | State |
|---|---|
| Code on `main` (GitHub `origin`) | Committed and pushed, up to `c389310` |
| Tests | Backend 1,335 of 1,335 passing (`node --test test/`; the `npm test` glob does not expand on Windows) |
| MG project function (818000000022001, Development) | Runs the **pre-timezone** code. The latest `main` is **not deployed yet** |
| Blocker | The Catalyst CLI is logged in to the trial account; it needs `catalyst login --dc au --force` with the MG account |
| MG data | Migrated: transactional data from 1 Nov 2026 00:00 AEDT onwards, config tables in full |
| MG env | `PROJECT_TIMEZONE=Australia/Sydney` set; a 46-variable snapshot is kept for re-applying after deploy |
| MG crons | Set up; the 15-minute `happy4_fast_recover` is paused |
| OEM notifications | MG channel registered, but the trial still receives and processes them until its channel and scheduler are stopped |

Deploying the timezone code to the MG project needs the user's confirmation (given: "deploy it"; waiting on the CLI login).

## Changes in `main`

| # | Change | Area |
|---|---|---|
| 1 | One project timezone, `PROJECT_TIMEZONE`, replaces every hard-coded IST offset | All time handling |
| 2 | Dealer CRM ID and Middleware ID written to the OEM CRM on delivery, plus a backfill route | Outbound (MG → dealer) |
| 3 | Dealer connect time read in the project timezone (`connected_at` preferred) | New-leads-only and push floor |
| 4 | Project, role and URL alignment to the MG project | Configuration |

### 1. Project timezone

- `config/env.js` `getProjectTimezone()` reads `PROJECT_TIMEZONE` (default `Asia/Kolkata`; an unknown zone falls back to the default).
- `utils/projectTime.js` is the one place that converts: `parseProjectDateTime`, `parseUtcDateTime`, `formatProjectDateTime`, `projectDay`, `projectHourLabel`, `projectClock`.
- System columns (CREATEDTIME / MODIFIEDTIME) are wall-clock strings in the project zone. Code-written datetime columns (assigned_date, connected_at, push_from_at, ...) are UTC. The hourly cost totals (`bucket_hour`, `flushed_at`) are the one deliberate exception and are written in project time.
- Replaced in: dashboards (`dashboardStatsService`, `adminDashboardService`), cost reports (`costKpiService`, `internalCostService`, `usageRollup`, `scripts/usageReport.js`), AI tools (`aiAssistantToolService`), alerts (`integrationAlertService`), reconcile and replay (`dealerReconciliationService`, `inboundReplayScheduler`), `pathPolicyService` and `webhookEventRetention`.
- Daylight saving: Sydney ends 5 Apr 2026 (25-hour day) and starts 4 Oct 2026 (23-hour day). A repeated hour resolves to the later (standard-time) instant; a skipped hour resolves forward.
- Tests: `test/projectTimezone.test.js` covers AEST/AEDT, DST gap and repeat, 23h/25h days, a round trip of every half hour of 2026, independence from the runtime TZ, and a guard against IST offsets.
- Zoho CRM company timezone: to be confirmed separately by the user. It does not affect stored data, because the OEM CRM sends dates with offsets and the middleware stores them as UTC.

### 2. Dealer CRM ID and Middleware ID on the OEM lead

- On delivery, the same acknowledgement write that sets Lead Status, Lead Exchanged and Connected CRM now also sets `Dealer_CRM_ID` (the dealer's own lead id) and `Middleware_ID` (the row id in the middleware `leads` table). Blank values are never written.
- Code: `services/integrations/oemReferenceFields.js`, `crmIntegrationService.js` (`deliveryAcknowledgementFields`).
- Backfill: `POST /cron/backfill-oem-references` (`oemReferenceBackfillService.js`). Idempotent, writes only these two fields, supports `dealerCodes`, `afterRowId`, `limit`, `dryRun`, with a 20-second deadline. All Fusion leads delivered at the time were backfilled; Dealer Studio, QA and AU008 leads can be backfilled on request.

### 3. Dealer connect time

- `dealerPushFloor` and the new-leads-only rule use `connected_at` (UTC) when present, otherwise `CREATEDTIME` read in the project zone. This stops a row copied into the MG project from blocking older leads.

### 4. Project, role and URL alignment

- `.catalystrc` points at project 818000000022001 (domain `mg-motors-au-7007717417.development`).
- Role IDs updated in the backend (`constants/roles.constants.js`, `middleware/requireAdminRole.js`, `requireAdminOrViewRole.js`, `adminUserService.js`, `dealerInviteService.js`) and the portal (`auth.constants.js`, `adminUserService.js`): App Administrator 818000000022006, Admin 818000000018018, Dealer 818000000018020, View user 818000000018014, App User 818000000022007.
- Fallback URLs in `zohoWebhookService.js` and `emailTemplates.js` use the MG domain.

## Not in `main`

An earlier version of this document listed three Fusion changes as "deployed (trial)". They are **not in this repository** (the commits it cited do not exist here, and the code does not contain them), so they would be lost by a deploy from `main`:

- Fusion webhook waiting out a busy lead lock. In `main` only Dealer Studio waits (`DEALER_STUDIO_CLAIM_RETRY_DELAYS_MS`, 700 / 1200 / 1500 ms).
- Fusion **Lost** also setting Enquiry Outcome = Lost.
- Fusion **Won / Delivered** also setting the status to Contacted. In `main` a Fusion Won / Delivered sets the Enquiry Outcome (Purchase) only and leaves the status alone.

If these are wanted in MG, they need to be re-implemented and committed.

## Function settings

| Setting | Effect |
|---|---|
| `ESCALATION_TRANSIENT_ONLY` | Only a dealer-side outage on a lead the dealer has not received yet can escalate to "Dealer Unavailable" (Unhappy 3) |
| `INBOUND_EVENT_STORE` | Each Fusion webhook is stored, encrypted, before processing so a blocked or failed event can be replayed |
| `PROJECT_TIMEZONE` | `Australia/Sydney` for the MG project |

Both code switches exist in `config/env.js`; their live values in the MG project come from the env snapshot.

## Deploy runbook (MG project)

1. `catalyst login --dc au --force` with the MG account.
2. Snapshot the live env (46 variables).
3. `catalyst deploy --only functions` from the repo root. A deploy resets 13 env vars (including `PUBLIC_FUNCTION_BASE_URL`, `LEAD_EXCHANGE_APP_URL`, `COST_DASHBOARD_KEY`, the role IDs and the timers), because it applies the git-ignored `catalyst-config.json` over the live values.
4. Re-apply the snapshot, then confirm `PROJECT_TIMEZONE=Australia/Sydney`.
5. Correct the `cost_usage_hourly` rows written by the old code (they used the old local time).
6. Resume the paused cron only when agreed.
7. Dealers (Fusion, Dealer Studio, Zoho CRM) must be given the new MG webhook URLs; the trial's channel and scheduler must be stopped so notifications reach MG.
