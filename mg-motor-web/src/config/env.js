/**
 * env.js
 * -----------------------------------------------------------------------
 * Single point of access for environment variables. Nothing else in the
 * app should call `process.env` directly â€” that keeps every env key
 * discoverable in one place and makes it trivial to add validation later.
 *
 * Create React App (the build tool Catalyst's React client uses) only
 * exposes env vars prefixed with REACT_APP_, read from a `.env` file at
 * the client root (see `.env.example`).
 *
 * Catalyst-specific keys are placeholders for Day 2 (auth) and the future
 * serverless API layer â€” they are read here now so nothing else needs to
 * change when those features land.
 */

export const env = {
  appName: process.env.REACT_APP_NAME || "MG Motor Lead Exchange",
  appEnv: process.env.REACT_APP_ENV || "development",

  catalyst: {
    projectId: process.env.REACT_APP_CATALYST_PROJECT_ID || "",
    projectDomain: process.env.REACT_APP_CATALYST_PROJECT_DOMAIN || "",
    environment: process.env.REACT_APP_CATALYST_ENVIRONMENT || "Development",
  },

  api: {
    baseUrl: process.env.REACT_APP_API_BASE_URL || "/server",
    timeout: Number(process.env.REACT_APP_API_TIMEOUT_MS) || 15000,
  },

  // The Catalyst project's time zone. Data Store CREATEDTIME / MODIFIEDTIME
  // values are wall-clock times in this zone, with no offset.
  projectTimezone: process.env.REACT_APP_PROJECT_TIMEZONE || "Australia/Sydney",

  // Local UI work only: `REACT_APP_MOCK_API=true npm start` signs in a fake admin
  // and answers API calls with dummy data (src/dev/mockBackend.js). Ignored in
  // production builds.
  mockApi: process.env.NODE_ENV !== "production" && process.env.REACT_APP_MOCK_API === "true",

  isProd: process.env.NODE_ENV === "production",
  isDev: process.env.NODE_ENV === "development",
};

