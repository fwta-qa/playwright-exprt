// helpers/qa-api-helpers.js
//
// Helper for querying the internal QA "Tools" dashboard API to find out
// which reviewing officer is assigned to approve a given AL application.
//
// Flow (confirmed working against https://api-demo.e-vdr.com):
// 1. GET  /tools/login?redirect=<target>   -> scrape the CSRF "_token" from
//    the login form (Laravel-style app), using a fresh session cookie jar.
// 2. POST /tools/login                      -> submit _token/redirect/
//    username/password with the SAME cookie jar; on success this sets a
//    session cookie and 302-redirects to /qa/dashboard.
// 3. GET  /qa/approval/waiting/{id}          -> with the session cookie,
//    returns a JSON array with a single string describing the officer,
//    e.g. ["200 REQUIRED jimskch.demo+1@gmail.com jims_officer_expat | JIMS-KCH : JIMS Kuching"]
//
// Credentials are read from QA_TOOLS_USERNAME / QA_TOOLS_PASSWORD in .env —
// never hardcode them in test files.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const QA_TOOLS_BASE_URL = process.env.QA_TOOLS_BASE_URL || 'https://api-demo.e-vdr.com';

/**
 * Logs into the QA Tools dashboard and returns an authenticated
 * Playwright APIRequestContext that can be reused for subsequent calls
 * (it carries the session cookie automatically).
 *
 * @param {import('@playwright/test').APIRequestContext} requestContextFactory
 *   - Either Playwright's `request` fixture (an APIRequestContext) or the
 *   `request` module/APIRequest object exposing `.newContext()`. Both are
 *   supported since callers may pass either depending on context.
 * @returns {Promise<import('@playwright/test').APIRequestContext>}
 */
async function loginToQaTools(requestContextFactory) {
  const username = process.env.QA_TOOLS_USERNAME;
  const password = process.env.QA_TOOLS_PASSWORD;

  if (!username || !password) {
    throw new Error('QA_TOOLS_USERNAME / QA_TOOLS_PASSWORD are not set in .env — cannot log into the QA Tools dashboard.');
  }

  // The `request` test fixture is already an APIRequestContext (no
  // baseURL override needed — we use absolute paths below). The standalone
  // `request` module exported by @playwright/test instead exposes
  // `.newContext()`. Support both.
  const context = typeof requestContextFactory.newContext === 'function'
    ? await requestContextFactory.newContext({ baseURL: QA_TOOLS_BASE_URL })
    : requestContextFactory;

  const loginPageUrl = `${QA_TOOLS_BASE_URL}/tools/login?redirect=${encodeURIComponent(`${QA_TOOLS_BASE_URL}/qa/dashboard`)}`;
  const loginPageRes = await context.get(loginPageUrl);
  const loginPageHtml = await loginPageRes.text();

  const tokenMatch = loginPageHtml.match(/name="_token" value="([^"]+)"/);
  if (!tokenMatch) {
    throw new Error('Could not find CSRF _token on the QA Tools login page — page structure may have changed.');
  }
  const csrfToken = tokenMatch[1];

  const loginRes = await context.post(`${QA_TOOLS_BASE_URL}/tools/login`, {
    form: {
      _token: csrfToken,
      redirect: `${QA_TOOLS_BASE_URL}/qa/dashboard`,
      username,
      password,
    },
    maxRedirects: 0, // we just need the Set-Cookie from the redirect response
  });

  // A successful login responds with a 302 redirect to /qa/dashboard.
  // Anything else (419 CSRF mismatch, 200 re-rendering the login form with
  // an error, etc.) means the login did not succeed.
  if (loginRes.status() !== 302) {
    throw new Error(`QA Tools login failed (HTTP ${loginRes.status()}). Check QA_TOOLS_USERNAME/QA_TOOLS_PASSWORD.`);
  }

  return context;
}

/**
 * Parses one raw line from /qa/approval/waiting/{id} into a structured
 * officer record.
 *
 * Example raw string:
 * "200 REQUIRED jimskch.demo+1@gmail.com jims_officer_expat | JIMS-KCH : JIMS Kuching"
 */
function parseOfficerLine(raw) {
  const parts = raw.split(' ');
  const statusCode = parts[0] || '';
  const statusLabel = parts[1] || '';
  const email = parts.find(p => p.includes('@')) || '';
  const afterEmail = raw.slice(raw.indexOf(email) + email.length).trim();
  const [role, office] = afterEmail.split('|').map(s => s.trim());

  return { raw, statusCode, statusLabel, email, role: role || '', office: office || '' };
}

/**
 * Fetches the reviewing officer assigned to approve a given application ID,
 * via the internal QA endpoint /qa/approval/waiting/{id}.
 *
 * The endpoint can return MANY lines at once — most of them status
 * "OPTIONAL" (reviewers who could act on this application but don't have to
 * right now) plus exactly one "REQUIRED" line (the officer who must act
 * next). Only the REQUIRED entry represents someone actually blocking the
 * application right now, so that's what this always filters down to.
 *
 * @param {import('@playwright/test').APIRequest} apiRequest
 * @param {string} applicationId - the application's UUID (from its URL's
 *   ?id=... query param).
 * @param {object} [options]
 * @param {string} [options.role] - When provided, also require the REQUIRED
 *   officer's role to include this string (case-insensitive). Useful when
 *   the caller already knows which role should be acting next (e.g.
 *   'ilmu_dir'), to fail fast with a clear error if the API disagrees.
 * @returns {Promise<{ raw: string, statusCode: string, statusLabel: string, email: string, role: string, office: string }>}
 */
async function getApprovingOfficer(requestContextFactory, applicationId, options = {}) {
  if (!applicationId) {
    throw new Error('getApprovingOfficer: applicationId is required.');
  }

  // Only dispose contexts we created ourselves (via .newContext()) — not
  // the shared `request` fixture, which Playwright manages/tears down
  // automatically at the end of the test.
  const createdOwnContext = typeof requestContextFactory.newContext === 'function';
  const context = await loginToQaTools(requestContextFactory);

  try {
    const res = await context.get(`${QA_TOOLS_BASE_URL}/qa/approval/waiting/${applicationId}`);
    if (!res.ok()) {
      throw new Error(`QA approval lookup failed (HTTP ${res.status()}) for application ${applicationId}.`);
    }

    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) {
      throw new Error(`Unexpected response shape from /qa/approval/waiting/${applicationId}: ${JSON.stringify(body)}`);
    }

    const officers = body.map(parseOfficerLine);

    // Only a REQUIRED entry actually blocks the application right now —
    // OPTIONAL entries are reviewers who merely CAN act, not who must.
    let requiredOfficers = officers.filter(o => o.statusLabel.toUpperCase() === 'REQUIRED');

    if (options.role) {
      const targetRole = options.role.toLowerCase();
      requiredOfficers = requiredOfficers.filter(o => o.role.toLowerCase().includes(targetRole));
    }

    if (requiredOfficers.length === 0) {
      const roleNote = options.role ? ` with role matching "${options.role}"` : '';
      throw new Error(
        `No officer with status REQUIRED${roleNote} found for application ${applicationId}. ` +
        `Raw response: ${JSON.stringify(body)}`
      );
    }

    return requiredOfficers[0];
  } finally {
    if (createdOwnContext) {
      await context.dispose();
    }
  }
}

/**
 * Bypasses the AL application's proforma waiting period (normally >1 hour)
 * via the internal QA shortcut endpoint. Called once the application has
 * cleared State Secretary — the final human approval stage.
 *
 * @param {import('@playwright/test').APIRequest} requestContextFactory
 * @param {string} applicationId - the application's UUID.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function promoteProforma(requestContextFactory, applicationId) {
  if (!applicationId) {
    throw new Error('promoteProforma: applicationId is required.');
  }

  const createdOwnContext = typeof requestContextFactory.newContext === 'function';
  const context = await loginToQaTools(requestContextFactory);

  try {
    const res = await context.get(`${QA_TOOLS_BASE_URL}/qa/approval/promote_proforma/expat/${applicationId}`);
    const status = res.status();
    let body;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => '');
    }

    if (!res.ok()) {
      throw new Error(`promote_proforma failed (HTTP ${status}) for application ${applicationId}. Response: ${JSON.stringify(body)}`);
    }

    return { status, body };
  } finally {
    if (createdOwnContext) {
      await context.dispose();
    }
  }
}

module.exports = {
  loginToQaTools,
  getApprovingOfficer,
  promoteProforma,
};
