// helpers/login-helpers.js
// Shared login helpers for all test files
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { google } = require('googleapis');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
function parseBoolean(value) {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

const CONFIG = {
  url: process.env.SSO_URL || 'https://demo.aliance.club/sso/login/',
  email: process.env.GMAIL_ADDRESS || '',
  companyName: (process.env.COMPANY_NAME || '').trim(),
  moduleName: (process.env.MODULE_NAME || 'EXPRT').trim(),
  adminEmail: (process.env.ADMIN_EMAIL || 'jsdemo.perkeso@outlook.com').trim(),
  moduleNameAdminJS: (process.env.MODULE_NAME_ADMIN || 'EXPRT').trim(),
  adminAction: (process.env.ADMIN_ACTION || 'approve').trim().toLowerCase(),
  decoyOtpEnabled: parseBoolean(process.env.DECOY_OTP),
  decoyOtpCode: (process.env.DECOY_OTP_CODE || '122222').trim(),
  jobTypeNRE: parseBoolean(process.env.JOB_TYPE_NRE),
  use2FA: parseBoolean(process.env.USE_2FA),
  pdfUploadPath: (process.env.PDF_UPLOAD_PATH || '').trim(),
  // 'new' → "New Application"  |  'renew' → "Renew Application"
  alApplicationType: (process.env.AL_APPLICATION_TYPE || 'new').trim().toLowerCase(),
  // 'ep' → "Employment Pass"    |  'pvp' → "Professional Visit Pass"
  alPassType: (process.env.AL_PASS_TYPE || 'ep').trim().toLowerCase(),
  // Expat category option to pick from "+ Add New" dropdown
  // Options: 'specialist' (Specialist / Shareholding) | 'crossposting' (Cross-Posting) | 'others' (Others)
  alExpatType: (process.env.AL_EXPAT_TYPE || 'specialist').trim().toLowerCase(),
  elementTimeout: 15000,
  // Multiplies every waitFor()/timeout budget across the suite. On a slow
  // or flaky connection, the fixed 5-10s timeouts scattered through the
  // form-fill logic can trip well before the page has actually finished
  // loading — bump this (e.g. SLOW_NETWORK=2) rather than editing timeouts
  // individually. Defaults to 1 (no change) for a normal connection.
  networkTimeoutMultiplier: Math.max(1, parseFloat(process.env.SLOW_NETWORK || '1') || 1),
};

// Scales a millisecond timeout by CONFIG.networkTimeoutMultiplier. Use this
// wherever a fixed waitFor()/timeout value risks being too tight on a slow
// connection, instead of hardcoding the number directly.
function scaledTimeout(ms) {
  return Math.round(ms * CONFIG.networkTimeoutMultiplier);
}

// Paths for Gmail credentials/token
const TOKEN_PATH = path.resolve(__dirname, '..', 'token.json');
const CREDENTIALS_PATH = path.resolve(__dirname, '..', 'credentials.json');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Retrieve the latest OTP from Gmail
 */
async function getOtpFromGmail() {
  console.log('📬 Checking Gmail for OTP...');
  if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
    throw new Error('Gmail credentials.json or token.json not found. Run "node gmail-auth.js" first.');
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  // Poll for the latest email with a timeout of 60 seconds
  const startTime = Date.now();
  const timeout = 60000;

  while (Date.now() - startTime < timeout) {
    try {
      const res = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 1,
      });

      const messages = res.data.messages || [];
      if (messages.length > 0) {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: messages[0].id,
          format: 'full',
        });

        const internalDate = parseInt(detail.data.internalDate, 10);
        // Make sure the email arrived recently (within the last 2 minutes)
        if (Date.now() - internalDate < 120000) {
          let body = '';
          function extractBody(parts) {
            for (const part of parts) {
              if (part.parts) extractBody(part.parts);
              if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
                body += Buffer.from(part.body?.data || '', 'base64').toString('utf-8');
              }
            }
          }
          const parts = detail.data.payload.parts || [detail.data.payload];
          extractBody(parts);

          const plainText = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

          // Look for 6 digit OTP code
          const match = plainText.match(/\b(\d{6})\b/);
          if (match) {
            console.log(`🔑 Retrieved OTP from Gmail: ${match[1]}`);
            return match[1];
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ Error polling Gmail:', err.message);
    }

    // Wait 5 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error('Timed out waiting for OTP from Gmail.');
}

/**
 * Robust helper to find elements in frames using a candidate array
 */
async function findElementInFrames(page, getCandidatesFn, timeoutMs = CONFIG.elementTimeout) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Check main frame and subframes
    const contexts = [page, ...page.frames().filter(f => f !== page.mainFrame())];

    for (const ctx of contexts) {
      const candidates = getCandidatesFn(ctx);
      for (const candidate of candidates) {
        try {
          const first = candidate.first();
          if (await first.isVisible({ timeout: 200 })) {
            return first;
          }
        } catch { }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

/**
 * Find email input field
 */
async function findEmailField(page) {
  const el = await findElementInFrames(page, (ctx) => [
    ctx.locator('#email'),
    ctx.getByLabel(/email/i),
    ctx.getByRole('textbox', { name: /email/i }),
    ctx.locator('input[type="email"]'),
    ctx.locator('input[name="email" i]'),
    ctx.locator('input[placeholder*="email" i]'),
  ]);
  if (el) return el;
  throw new Error(`Email input field not found`);
}

/**
 * Find and click the "Send OTP" or "Request OTP" button
 */
async function findSendOtpButton(page) {
  const el = await findElementInFrames(page, (ctx) => [
    ctx.locator('button:has-text("Request OTP")'),
    ctx.locator('button:has-text("Send OTP")'),
    ctx.locator('button:has-text("Send")'),
    ctx.locator('button:has-text("Get OTP")'),
  ]);
  if (el) return el;
  throw new Error(`Send OTP button not found`);
}

/**
 * Fill OTP code. Supports single input field or 6 individual textboxes.
 */
async function fillOtpCode(page, otp) {
  console.log(`✍️ Filling OTP code: ${otp}`);

  // Wait a moment for any DOM transitions/animations
  await page.waitForTimeout(1000);

  // Determine the correct context (main frame or iframe)
  let targetContext = page;
  let otpInputsLocator = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[inputmode="numeric"], input[type="text"]';

  // Find which context has visible textboxes
  let inputs = page.locator(otpInputsLocator);
  let isVisible = await inputs.first().isVisible({ timeout: 3000 }).catch(() => false);

  if (!isVisible) {
    // Only attempt 2FA button click if explicitly enabled via USE_2FA=true in .env
    if (CONFIG.use2FA) {
      const twoFaButton = await findElementInFrames(page, (ctx) => [
        ctx.getByRole('button', { name: /Login Via 2FA Code/i }),
        ctx.locator('button:has-text("Login Via 2FA Code")'),
      ], 5000);

      if (twoFaButton) {
        console.log('👆 Opening 2FA login fields');
        await twoFaButton.click();
        await page.waitForTimeout(2000);
        inputs = page.locator(otpInputsLocator);
        isVisible = await inputs.first().isVisible({ timeout: 3000 }).catch(() => false);
      }
    } else {
      console.log('ℹ️ USE_2FA=false — skipping 2FA button, waiting for OTP fields directly...');
      await page.waitForTimeout(2000);
      inputs = page.locator(otpInputsLocator);
      isVisible = await inputs.first().isVisible({ timeout: 5000 }).catch(() => false);
    }

    if (!isVisible) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const frameInputs = frame.locator(otpInputsLocator);
        if (await frameInputs.first().isVisible({ timeout: 500 }).catch(() => false)) {
          targetContext = frame;
          inputs = frameInputs;
          break;
        }
      }
    }
  }

  const count = await inputs.count();
  console.log(`ℹ️ Found ${count} OTP input fields in target context`);

  if (count === 1) {
    await inputs.first().focus();
    await inputs.first().pressSequentially(otp, { delay: 100 });
  } else if (count > 1) {
    // Fill digit by digit using pressSequentially to trigger front-end logic properly
    for (let i = 0; i < Math.min(count, otp.length); i++) {
      const digit = otp[i];
      await inputs.nth(i).focus();
      await inputs.nth(i).pressSequentially(digit, { delay: 50 });
    }
  } else {
    throw new Error('No OTP input fields found to fill');
  }
}

/**
 * Find and click the "Login" or "Verify" button
 */
async function findLoginButton(page) {
  const el = await findElementInFrames(page, (ctx) => [
    ctx.locator('button:has-text("Login")'),
    ctx.locator('button:has-text("Verify")'),
    ctx.locator('button:has-text("Submit")'),
    ctx.locator('button:has-text("Confirm")'),
  ]);
  if (el) return el;
  throw new Error(`Login button not found`);
}

/**
 * Login to the portal using email and OTP
 */
async function loginAndNavigate(page) {
  console.log(`\n📍 Opening: ${CONFIG.url}`);
  await page.goto(CONFIG.url, { waitUntil: 'networkidle' });

  console.log(`🔑 Logging in with email: ${CONFIG.email}`);
  const emailField = await findEmailField(page);
  await emailField.fill(CONFIG.email);
  console.log('✅ Email entered');

  const sendButton = await findSendOtpButton(page);
  await sendButton.click();
  console.log('✅ OTP request sent');

  // Get OTP either from environment decoy or Gmail API
  let otp;
  if (CONFIG.decoyOtpEnabled) {
    console.log(`ℹ️ Using Decoy OTP Code: ${CONFIG.decoyOtpCode}`);
    otp = CONFIG.decoyOtpCode;
  } else {
    otp = await getOtpFromGmail();
  }

  // Fill the OTP code
  await fillOtpCode(page, otp);
  console.log(`✅ OTP entered`);

  const loginButton = await findLoginButton(page);
  await loginButton.click();
  console.log('✅ Login submitted');

  await page.waitForLoadState('networkidle').catch(() => { });
  await page.waitForTimeout(2000);
}

/**
 * Select a company by name
 */
async function selectCompany(page, companyName) {
  console.log(`🏢 Selecting company: "${companyName}"`);
  const companyCard = page.locator(`text=${companyName}`).first();
  await companyCard.waitFor({ state: 'visible', timeout: 10000 });
  await companyCard.click();
  await page.waitForLoadState('networkidle').catch(() => { });
  await page.waitForTimeout(1000);
  console.log(`✅ Company "${companyName}" selected`);
}

/**
 * Select a module by name
 */
async function selectModule(page, moduleName) {
  console.log(`📦 Selecting module: "${moduleName}"`);

  const moduleBtn = page.locator('button, [role="button"], a')
    .filter({ hasText: moduleName })
    .first();

  await moduleBtn.waitFor({ state: 'visible', timeout: 15000 });
  await moduleBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  // Click the module button and wait for navigation
  const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => null);
  await moduleBtn.click();
  await navigationPromise;

  console.log(`✅ Module "${moduleName}" clicked`);
}

/**
 * Return the most recent open page in the current context.
 */
async function getLatestOpenPage(page, label) {
  await page.waitForTimeout(1500);
  const openPages = page.context().pages().filter(currentPage => !currentPage.isClosed());
  const latestPage = openPages[openPages.length - 1] || page;

  await latestPage.waitForLoadState('domcontentloaded').catch(() => { });
  console.log(`📍 [${label}] Open page: ${latestPage.url()}`);
  return latestPage;
}

/**
 * Full login flow: login → select company → select module
 */
async function fullLoginFlow(page) {
  await loginAndNavigate(page);

  if (CONFIG.companyName) {
    await selectCompany(page, CONFIG.companyName);
  } else {
    console.log('ℹ️ No company selected (COMPANY_NAME not configured)');
  }

  await selectModule(page, CONFIG.moduleName);

  return getLatestOpenPage(page, 'EMPLOYER');
}

/**
 * Fully isolated login flow specifically for the Admin portal
 * @param {import('@playwright/test').Page} page
 * @param {string} adminEmail
 * @param {object} [options]
 * @param {boolean} [options.selectModule=true] - Whether to auto-click the
 *   configured admin module (CONFIG.moduleNameAdminJS) after login. Pass
 *   false to stay on the initial post-login dashboard, e.g. when the
 *   caller wants to find and click a different module button itself (the
 *   SSO dashboard issues one-time redirect tokens per domain, so navigating
 *   away and back invalidates the session — module selection must happen
 *   directly off this landing page, not via a fresh page.goto()).
 */
async function adminLoginFlow(page, adminEmail, options = {}) {
  const { selectModule: shouldSelectModule = true } = options;
  if (!adminEmail) {
    throw new Error('❌ adminLoginFlow failed: No admin email was provided.');
  }

  console.log(`\n📍 [ADMIN] Opening: ${CONFIG.url}`);
  await page.goto(CONFIG.url, { waitUntil: 'networkidle' });

  // 1. Force use the Admin email passed from the test script
  console.log(`🔑 [ADMIN] Logging in with email: ${adminEmail}`);
  const emailField = await findEmailField(page);
  await emailField.fill(adminEmail);
  console.log('✅ [ADMIN] Email entered');

  const sendButton = await findSendOtpButton(page);
  await sendButton.click();
  console.log('✅ [ADMIN] OTP request sent');

  // 2. Reuse your existing decoy/Gmail OTP logic
  let otp;
  if (CONFIG.decoyOtpEnabled) {
    console.log(`ℹ️ [ADMIN] Using Decoy OTP Code: ${CONFIG.decoyOtpCode}`);
    otp = CONFIG.decoyOtpCode;
  } else {
    otp = await getOtpFromGmail(); // Or your specialized admin OTP grabber if different
  }

  // 3. Fill OTP & Submit
  await fillOtpCode(page, otp);
  console.log(`✅ [ADMIN] OTP entered`);

  const loginButton = await findLoginButton(page);
  await loginButton.click();
  console.log('✅ [ADMIN] Login submitted');

  // 4. Admin profiles typically skip company selection entirely!
  console.log('ℹ️ [ADMIN] Skipping company selection block.');

  // Give the dashboard a moment to settle down and render its module tiles
  await page.waitForTimeout(3000);

  if (!shouldSelectModule) {
    console.log('ℹ️ [ADMIN] Skipping module auto-selection — staying on the post-login dashboard.');
    return page;
  }

  // 5. Select the Module
  console.log(`📦 [ADMIN] Selecting module: "${CONFIG.moduleNameAdminJS}"`);
  await selectModule(page, CONFIG.moduleNameAdminJS);

  return getLatestOpenPage(page, 'ADMIN');
}

/**
 * Wait for a URL pattern to match, refreshing the page if it takes too long.
 * @param {import('@playwright/test').Page} page
 * @param {string|RegExp} urlPattern - URL pattern to wait for
 * @param {number} timeoutMs - Timeout per attempt in ms (default 10000)
 * @param {number} maxRetries - Max number of refresh retries (default 3)
 */
async function waitForUrlOrRefresh(page, urlPattern, timeoutMs = 10000, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`⏳ [Attempt ${attempt}/${maxRetries}] Waiting for URL: ${urlPattern}`);
      await page.waitForURL(urlPattern, { timeout: timeoutMs });
      console.log(`✅ URL matched on attempt ${attempt}: ${page.url()}`);
      return;
    } catch {
      if (attempt < maxRetries) {
        console.warn(`⚠️ [Attempt ${attempt}] Page too slow (>${timeoutMs}ms). Refreshing tab...`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
        await page.waitForTimeout(2000);
      } else {
        throw new Error(`❌ Page did not navigate to expected URL after ${maxRetries} attempts. Last URL: ${page.url()}`);
      }
    }
  }
}

/**
 * Wait for a selector/locator to be visible, refreshing the page if it takes too long.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector - CSS selector to wait for
 * @param {number} timeoutMs - Timeout per attempt in ms (default 10000)
 * @param {number} maxRetries - Max number of refresh retries (default 3)
 */
async function waitForSelectorOrRefresh(page, selector, timeoutMs = 10000, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`⏳ [Attempt ${attempt}/${maxRetries}] Waiting for selector: ${selector}`);
      await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
      console.log(`✅ Selector visible on attempt ${attempt}: ${selector}`);
      return;
    } catch {
      if (attempt < maxRetries) {
        console.warn(`⚠️ [Attempt ${attempt}] Selector not visible (>${timeoutMs}ms). Refreshing tab...`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
        await page.waitForTimeout(2000);
      } else {
        throw new Error(`❌ Selector "${selector}" not visible after ${maxRetries} attempts on ${page.url()}`);
      }
    }
  }
}

module.exports = {
  CONFIG,
  parseBoolean,
  scaledTimeout,
  getOtpFromGmail,
  findElementInFrames,
  findEmailField,
  findSendOtpButton,
  fillOtpCode,
  findLoginButton,
  loginAndNavigate,
  selectCompany,
  selectModule,
  getLatestOpenPage,
  fullLoginFlow,
  adminLoginFlow,
  waitForUrlOrRefresh,
  waitForSelectorOrRefresh,
};
