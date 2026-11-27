/**
 * authService.js
 * -----------------------------------------------------------------------
 * The Catalyst Web SDK isn't an npm package here â€” it's loaded via
 * <script> tags in public/index.html and attaches itself to `window.catalyst`
 * asynchronously. Every other file in the app should go through this
 * service instead of touching `window.catalyst` directly, for two reasons:
 *
 *   1. It's the one place that waits for the SDK to actually be ready,
 *      so a component mounting before the script finishes loading
 *      doesn't throw "window.catalyst is undefined".
 *   2. It's the one place that would need to change if Catalyst's SDK
 *      API shape ever changes.
 */

import { authDebug } from "../../utils/authDebug";

const SDK_READY_POLL_INTERVAL_MS = 50;
const SDK_READY_TIMEOUT_MS = 10000;

function waitForCatalystSdk() {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    (function poll() {
      if (window.catalyst && window.catalyst.auth) {
        resolve(window.catalyst);
        return;
      }
      if (Date.now() - start > SDK_READY_TIMEOUT_MS) {
        reject(
          new Error(
            "Catalyst Web SDK did not load in time. Check that the SDK <script> tags are present in public/index.html and that the app is being served through Catalyst (catalyst serve), not a bare CRA dev server."
          )
        );
        return;
      }
      setTimeout(poll, SDK_READY_POLL_INTERVAL_MS);
    })();
  });
}

/**
 * Resolves with the authenticated user's profile if a valid session
 * exists, or rejects if the user is not signed in. Mirrors the promise
 * behavior of catalyst.auth.isUserAuthenticated() directly.
 */
async function getCurrentSession() {
  const catalyst = await waitForCatalystSdk();
  const result = await catalyst.auth.isUserAuthenticated();
  authDebug('isUserAuthenticated raw result:', JSON.stringify(result));
  return result?.content ?? null;
}

/**
 * Embeds Catalyst's sign-in iframe into the DOM node with id `elementId`.
 * Does not return a promise â€” the iframe drives the actual sign-in flow
 * and Catalyst redirects the browser to `config.service_url` on success.
 */
async function renderSignIn(elementId, config) {
  const catalyst = await waitForCatalystSdk();
  catalyst.auth.signIn(elementId, config);
}

/**
 * Signs the current user out and redirects the browser to `redirectUrl`.
 * Does not return a promise (matches the underlying SDK method), and
 * Catalyst gives no signal for when the session is actually invalidated
 * server-side - see waitForSignedOut() below for why that matters.
 */
async function signOut(redirectUrl) {
  clearAuthTokenCache();
  const catalyst = await waitForCatalystSdk();
  catalyst.auth.signOut(redirectUrl);
}

/**
 * Polls isUserAuthenticated() until it reports no session, or gives up
 * after timeoutMs. Call this after signOut() before forcing any reload
 * of your own: signOut() doesn't confirm when the session is actually
 * invalidated server-side, so reloading on a fixed delay can land before
 * that happens - the fresh page's session check then sees a stale "still
 * authenticated" result and bounces straight back into the app.
 */
async function waitForSignedOut({ intervalMs = 150, timeoutMs = 5000 } = {}) {
  const catalyst = await waitForCatalystSdk();
  const start = Date.now();

  // Resolves true once the session is confirmed gone (isUserAuthenticated
  // reports nothing, or rejects as unauthenticated), false if it is still
  // valid when the timeout runs out — callers use that to retry sign-out.
  return new Promise((resolve) => {
    (function poll() {
      catalyst.auth
        .isUserAuthenticated()
        .then((result) => {
          if (!result?.content) {
            resolve(true);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            resolve(false);
            return;
          }
          setTimeout(poll, intervalMs);
        })
        .catch(() => resolve(true));
    })();
  });
}

/**
 * Resolves the logged-in user's Dealer_Code by querying the backend's
 * dealer_user_mapping table via the logged-in user's Catalyst user ID.
 * Returns null if no mapping exists (e.g. user isn't a Dealer, or the
 * mapping wasn't created yet) â€” callers must treat null as "context not
 * resolved," never fall back to showing all leads.
 */
// A page load fires several API calls at once. Without this, each one asked the
// SDK for its own token, and when the SDK's token cookie was missing or expired
// every one of them made two auth round-trips of its own (6 calls = 12 extra
// requests before any data loaded). Now concurrent callers share one in-flight
// request, and the token is reused for a few minutes (Catalyst tokens last ~1h).
const TOKEN_REUSE_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
let cachedToken = null;
let cachedTokenUntil = 0;
let tokenInFlight = null;

function clearAuthTokenCache() {
  cachedToken = null;
  cachedTokenUntil = 0;
}

async function generateAuthToken() {
  if (cachedToken && Date.now() < cachedTokenUntil) return cachedToken;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const catalyst = await waitForCatalystSdk();
    const response = await catalyst.auth.generateAuthToken();
    const token = response?.access_token ?? null;
    if (token) {
      const expiresInMs = Number(response?.expires_in) * 1000;
      const reuseMs = Number.isFinite(expiresInMs) && expiresInMs > 0
        ? Math.min(TOKEN_REUSE_MS, expiresInMs - TOKEN_EXPIRY_MARGIN_MS)
        : TOKEN_REUSE_MS;
      cachedToken = reuseMs > 0 ? token : null;
      cachedTokenUntil = reuseMs > 0 ? Date.now() + reuseMs : 0;
    }
    return token;
  })();

  try {
    return await tokenInFlight;
  } finally {
    tokenInFlight = null;
  }
}

async function getDealerContext(profile) {
  const userId = profile?.user_id ?? null;
  if (!userId) return null;

  try {
    const token = await generateAuthToken();
    const response = await fetch(`/server/mg_motors_au_function/dealer-context/${userId}`, {
      credentials: 'include',
      headers: token ? { Authorization: token } : {},
    });
    const json = await response.json();
    return json?.dealer_code ?? null;
  } catch {
    return null;
  }
}

async function sendPasswordReset(email) {
  const catalyst = await waitForCatalystSdk();
  // In Web SDK 4.6.1 forgotPassword lives on `userManagement` (not `auth`)
  // and takes ONE options object that carries the address as `email_id`.
  await catalyst.userManagement.forgotPassword({
    email_id: email,
    platform_type: "web",
  });
}

export const authService = {
  getCurrentSession,
  renderSignIn,
  signOut,
  waitForSignedOut,
  getDealerContext,
  generateAuthToken,
  clearAuthTokenCache,
  sendPasswordReset
};

