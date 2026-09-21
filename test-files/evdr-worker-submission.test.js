// evdr-worker-submission.test.js
//
// Third leg of the AL flow, after al-autofill-form.test.js (submit) and
// admin-approve-application.test.js (approval chain + payment):
//   1. Employer side: open eVDR, pick a worker under the AL reference no.,
//      fill Person-in-Charge details, fill the Visa Form, submit it.
//   2. Admin side: resolve the eVDR-stage officer (role jims_hq_officer_expat)
//      via the QA Tools API, log in as them, and submit the same record.
//
// ID hand-off:
// - AL application reference no.  -> APPLICATION_REF_NO / APPLICATION_ID env,
//   or .test-state/last-application-id.json (written by al-autofill-form.test.js)
// - eVDR record numeric id         -> APPLICATION_ID_EVDR env, or
//   .test-state/last-evdr-application-id.json (written by this test, once
//   the Visa Form page's URL is reached)
//
// The AL reference no. is what locates the record in the UI (both employer
// and admin side); the eVDR numeric id is only used for the QA API lookup.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { loginAndNavigate, selectCompany, selectModule, getLatestOpenPage, adminLoginFlow, waitForUrlOrRefresh, CONFIG } = require('../helpers/login-helpers');
const { getApprovingOfficer } = require('../helpers/qa-api-helpers');

const LAST_ID_PATH = path.resolve(__dirname, '..', '.test-state', 'last-application-id.json');
const LAST_EVDR_ID_PATH = path.resolve(__dirname, '..', '.test-state', 'last-evdr-application-id.json');

// ─── ID resolution ───────────────────────────────────────────────────────────

function resolveReferenceNo() {
  const envApplicationId = (process.env.APPLICATION_ID || '').trim();
  const envReferenceNo = (process.env.APPLICATION_REF_NO || '').trim();

  if (envApplicationId || envReferenceNo) {
    if (!envReferenceNo) {
      throw new Error('APPLICATION_ID is set but APPLICATION_REF_NO is empty — this test only needs the reference number.');
    }
    console.log(`🔖 Reference No. (from ENV): ${envReferenceNo}`);
    return envReferenceNo;
  }

  if (fs.existsSync(LAST_ID_PATH)) {
    const saved = JSON.parse(fs.readFileSync(LAST_ID_PATH, 'utf-8'));
    if (saved.referenceNo) {
      console.log(`🔖 Reference No. (from last al-autofill-form.test.js run): ${saved.referenceNo}`);
      return saved.referenceNo;
    }
  }

  throw new Error(
    'No reference number available. Set APPLICATION_ID + APPLICATION_REF_NO in .env, ' +
    'or run al-autofill-form.test.js with SUBMIT_APPLICATION=true first.'
  );
}

function resolveEvdrApplicationId(capturedThisRun) {
  const envEvdrId = (process.env.APPLICATION_ID_EVDR || '').trim();
  if (envEvdrId) {
    console.log(`🆔 eVDR Application ID (from ENV): ${envEvdrId}`);
    return envEvdrId;
  }
  if (capturedThisRun) {
    console.log(`🆔 eVDR Application ID (captured this run): ${capturedThisRun}`);
    return capturedThisRun;
  }
  if (fs.existsSync(LAST_EVDR_ID_PATH)) {
    const saved = JSON.parse(fs.readFileSync(LAST_EVDR_ID_PATH, 'utf-8'));
    if (saved.evdrApplicationId) {
      console.log(`🆔 eVDR Application ID (from last run): ${saved.evdrApplicationId}`);
      return saved.evdrApplicationId;
    }
  }
  return null;
}

// ─── Shared UI helpers ───────────────────────────────────────────────────────

/** The eVDR search box label varies by page ("Search by Labour Licence No." vs generic "Search"). */
function getSearchInput(page) {
  return page.locator('input[placeholder*="Labour Licence" i]').first()
    .or(page.locator('input[placeholder*="Search" i]').first());
}

/** Fills the first plain <input> that follows a given <label> text. */
async function fillFieldByLabel(page, labelText, value, { timeout = 8000 } = {}) {
  const field = page.locator('label:has-text("' + labelText + '")').locator('xpath=following::input[1]');
  const visible = await field.isVisible({ timeout }).catch(() => false);
  if (!visible) {
    console.log(`  ⚠️ "${labelText}" field not found/visible — skipping.`);
    return false;
  }
  await field.fill(value);
  console.log(`  ➕ ${labelText}: "${value}"`);
  return true;
}

/** Returns a YYYY-MM-DD string somewhere in the last `daysBack` days. */
function randomDate(daysBack = 730) {
  const d = new Date(Date.now() - Math.floor(Math.random() * daysBack) * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ─── Test ────────────────────────────────────────────────────────────────────

test.describe('EXPRT - eVDR Worker Submission', () => {

  test('Submit a worker through eVDR on both the employer and admin side', async ({ page, browser, request }) => {
    const referenceNo = resolveReferenceNo();
    let evdrApplicationId = null; // captured once the Visa Form page loads
    let evdrPage, employeeCards, chosenIndex, cardCount, isMalaysianWorker;

    await test.step('Employer: log in and open eVDR (EXPAT)', async () => {
      await loginAndNavigate(page);
      if (CONFIG.companyName) {
        await selectCompany(page, CONFIG.companyName);
      }

      const evdrModuleName = (process.env.MODULE_NAME_EVDR || 'eVDR').trim();
      await selectModule(page, evdrModuleName);
      evdrPage = await getLatestOpenPage(page, 'EVDR');

      // The module tile lands on "/evdr/evdr_application/" (the NRE menu).
      // The expat side lives at a different, fixed path — go there directly.
      const EVDR_EXPAT_URL = 'https://demo.sarawakforeignworkers.com/evdr/evdr_application_expat/';
      if (!evdrPage.url().includes('evdr_application_expat')) {
        await evdrPage.goto(EVDR_EXPAT_URL, { waitUntil: 'networkidle' });
        await evdrPage.waitForTimeout(1000);
      }
      console.log(`📍 eVDR EXPAT page: ${evdrPage.url()}`);
      await evdrPage.screenshot({ path: 'test-results/evdr-landing.png', fullPage: true }).catch(() => { });
    });

    await test.step('Employer: search by reference no. and pick a worker', async () => {
      console.log(`🔎 Searching for Reference No.: "${referenceNo}"`);
      const searchInput = getSearchInput(evdrPage);
      await searchInput.waitFor({ state: 'visible', timeout: 10000 });
      await searchInput.fill(referenceNo);
      await searchInput.press('Enter');

      await evdrPage.waitForLoadState('networkidle').catch(() => { });
      await evdrPage.waitForTimeout(1500);
      await evdrPage.screenshot({ path: 'test-results/evdr-search-result.png', fullPage: true }).catch(() => { });

      const matchFound = await evdrPage.locator(`text=${referenceNo}`).first().isVisible({ timeout: 8000 }).catch(() => false);
      expect(matchFound, `Expected "${referenceNo}" to appear on the eVDR search results page`).toBeTruthy();

      // One AL application can register several expat workers, but eVDR
      // handles them one card at a time — all sharing the same reference
      // no. Anchor on "Employee Name" and walk up to the ancestor that
      // also contains "Person-in-Charge Details" to get exactly one match
      // per real card (a plain hasText filter over-matches nested wrapper divs).
      employeeCards = evdrPage.locator('text=Employee Name')
        .locator('xpath=ancestor::*[.//text()[contains(., "Person-in-Charge Details")]][1]');
      cardCount = await employeeCards.count();
      console.log(`👥 ${cardCount} worker card(s) found under "${referenceNo}".`);
      if (cardCount === 0) {
        throw new Error(`No worker cards found for "${referenceNo}".`);
      }

      // Only cards still showing the "Please complete..." warning need PIC
      // details filled — a worker already saved on a prior run has no
      // pencil icon at all. If every card is already done, skip PIC entirely
      // and go straight to Visa Form for a randomly picked worker.
      const incompleteIndexes = [];
      for (let i = 0; i < cardCount; i++) {
        const hasWarning = await employeeCards.nth(i)
          .locator('text=Please complete the Person-in-Charge details')
          .isVisible({ timeout: 2000 }).catch(() => false);
        if (hasWarning) incompleteIndexes.push(i);
      }
      console.log(`📋 ${incompleteIndexes.length}/${cardCount} card(s) still need Person-in-Charge details.`);

      const picDetailsNeeded = incompleteIndexes.length > 0;
      chosenIndex = picDetailsNeeded
        ? incompleteIndexes[Math.floor(Math.random() * incompleteIndexes.length)]
        : Math.floor(Math.random() * cardCount);

      const chosenCard = employeeCards.nth(chosenIndex);
      const chosenEmployeeName = await chosenCard.locator('text=Employee Name').first()
        .locator('xpath=following::*[1]').innerText().catch(() => '(unknown)');
      const chosenNationality = await chosenCard.locator("text=Employee's Nationality").first()
        .locator('xpath=following::*[1]').innerText().catch(() => '');
      isMalaysianWorker = /malaysia/i.test(chosenNationality);

      console.log(`🎲 Worker ${chosenIndex + 1}/${cardCount}: "${chosenEmployeeName.trim()}" — nationality: "${chosenNationality.trim()}"${isMalaysianWorker ? ' (Malaysian, Visa Branch will be skipped)' : ''}`);

      if (picDetailsNeeded) {
        await fillPersonInChargeDetails(evdrPage, chosenCard);
      } else {
        console.log('⏭️ Person-in-Charge already complete for every worker — skipping straight to Visa Form.');
      }
    });

    await test.step('Employer: open Visa Form for the chosen worker', async () => {
      console.log(`📂 Reopening worker ${chosenIndex + 1}/${cardCount} for reference "${referenceNo}"...`);

      // Re-use the exact same card index rather than re-deriving a "first
      // match" locator — two workers can share the same reference no., so
      // grabbing .first() again risks landing on a DIFFERENT worker than
      // the one just filled above.
      let cardClicked = false;
      for (let attempt = 1; attempt <= 3 && !cardClicked; attempt++) {
        const found = await employeeCards.nth(chosenIndex).waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
        if (found) {
          await employeeCards.nth(chosenIndex).click();
          cardClicked = true;
          break;
        }
        console.warn(`⚠️ [Attempt ${attempt}/3] Card not visible — re-searching for "${referenceNo}"...`);
        const retrySearch = getSearchInput(evdrPage);
        if (await retrySearch.isVisible({ timeout: 5000 }).catch(() => false)) {
          await retrySearch.fill(referenceNo);
          await retrySearch.press('Enter');
        } else {
          await evdrPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
        }
        await evdrPage.waitForLoadState('networkidle').catch(() => { });
        await evdrPage.waitForTimeout(2000);
      }
      if (!cardClicked) {
        throw new Error(`Could not reopen worker ${chosenIndex + 1}'s card ("${referenceNo}") after 3 attempts.`);
      }

      await evdrPage.waitForLoadState('networkidle').catch(() => { });
      await evdrPage.waitForTimeout(1500);
      await evdrPage.screenshot({ path: 'test-results/evdr-employee-details-page.png', fullPage: true }).catch(() => { });

      const visaFormBtn = evdrPage.getByRole('button', { name: /visa\s*form/i }).first()
        .or(evdrPage.locator('button:has-text("Visa Form")').first());
      await visaFormBtn.waitFor({ state: 'visible', timeout: 10000 });
      await visaFormBtn.click();
      console.log('✅ Clicked "Visa Form".');

      await evdrPage.waitForLoadState('networkidle').catch(() => { });
      // The panel's dropdowns/upload buttons mount slightly after the
      // header text does — wait for both section headings before touching
      // anything, instead of a single short fixed delay.
      await evdrPage.locator('text=Visa Details').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => { });
      await evdrPage.locator('text=Personal Documents').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => { });
      await evdrPage.waitForTimeout(1000);
      await evdrPage.screenshot({ path: 'test-results/evdr-visa-form.png', fullPage: true }).catch(() => { });

      // Capture the eVDR record's own numeric id from the URL, e.g.
      // .../licence_expat/?id=1481 — needed later for the QA API lookup.
      const idMatch = evdrPage.url().match(/[?&]id=(\d+)/);
      if (idMatch) {
        evdrApplicationId = idMatch[1];
        console.log(`🆔 Captured eVDR Application ID: ${evdrApplicationId}`);
        const stateDir = path.resolve(__dirname, '..', '.test-state');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(LAST_EVDR_ID_PATH, JSON.stringify({
          evdrApplicationId, referenceNo, url: evdrPage.url(), capturedAt: new Date().toISOString(),
        }, null, 2));
      } else {
        console.log(`⚠️ Could not extract a numeric id from: ${evdrPage.url()}`);
      }
    });

    await test.step('Employer: fill Visa Form (if not already filled)', async () => {
      // If this worker's Visa Form was already filled/submitted on a prior
      // run, the fields are locked — detect that via the "Entry Point"
      // dropdown's current value ("Select One" only when genuinely empty)
      // and skip the fill entirely rather than fighting locked controls.
      const entryPointCombobox = evdrPage.locator('label').filter({ hasText: 'Entry Point' }).first()
        .locator('xpath=following::div[@role="combobox"][1]');
      const entryPointText = await entryPointCombobox.innerText({ timeout: 8000 }).catch(() => '');
      const alreadyFilled = entryPointText.trim() !== '' && !/^select one$/i.test(entryPointText.trim());

      if (alreadyFilled) {
        console.log(`⏭️ Visa Form already filled (Entry Point: "${entryPointText.trim()}") — skipping to ADD TO LIST.`);
        return;
      }

      await fillVisaForm(evdrPage, isMalaysianWorker);
      await evdrPage.screenshot({ path: 'test-results/evdr-visa-form-filled.png', fullPage: true }).catch(() => { });
      console.log('✅ Visa Form filled.');
    });

    await test.step('Employer: ADD TO LIST, SUBMIT, confirm declaration', async () => {
      // Both buttons are optional here — if the record was already
      // added/submitted on a prior run, they may simply no longer exist.
      await clickIfVisible(evdrPage, evdrPage.getByRole('button', { name: /add\s*to\s*list/i }).first(), 'ADD TO LIST');
      await evdrPage.screenshot({ path: 'test-results/evdr-visa-form-added.png', fullPage: true }).catch(() => { });

      await clickIfVisible(evdrPage, evdrPage.getByRole('button', { name: /^SUBMIT$/i }).first(), 'SUBMIT (Visa Dengan Rujukan)', 10000);
      await evdrPage.screenshot({ path: 'test-results/evdr-submit-visa-list.png', fullPage: true }).catch(() => { });

      // Popup title reads "Employer's Declaration & Undertaking" (apostrophe-s, "&").
      const declarationPopup = evdrPage.locator('text=/Employer.?s?\\s*Declaration\\s*(&|and)\\s*Undertaking/i').first();
      const declarationVisible = await declarationPopup.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);

      if (!declarationVisible) {
        console.log("⚠️ Employer's Declaration & Undertaking popup did not appear — check the screenshot.");
        return;
      }
      console.log("📋 Employer's Declaration & Undertaking popup detected.");
      await evdrPage.screenshot({ path: 'test-results/evdr-employer-declaration-popup.png', fullPage: true }).catch(() => { });

      const submitDeclarationBtn = evdrPage.getByRole('button', { name: /^SUBMIT$/i }).first();
      await submitDeclarationBtn.waitFor({ state: 'visible', timeout: 8000 });
      await submitDeclarationBtn.click();
      console.log('✅ Confirmed declaration.');

      await evdrPage.waitForLoadState('networkidle').catch(() => { });
      await evdrPage.waitForTimeout(1500);
      await evdrPage.screenshot({ path: 'test-results/evdr-submission-complete.png', fullPage: true }).catch(() => { });
      console.log('🎉 Employer-side eVDR submission complete.');
    });

    // ── Admin side: separate approval step, needed before licence generation ──
    await test.step('Admin: resolve eVDR officer and log in', async () => {
      const resolvedEvdrId = resolveEvdrApplicationId(evdrApplicationId);
      if (!resolvedEvdrId) {
        console.log('⚠️ No eVDR Application ID available — skipping admin-side submission.');
        return;
      }

      console.log(`🔎 Looking up eVDR officer (role: jims_hq_officer_expat) for eVDR id ${resolvedEvdrId}...`);
      let officer;
      try {
        officer = await getApprovingOfficer(request, resolvedEvdrId, { role: 'jims_hq_officer_expat' });
      } catch (e) {
        console.log(`ℹ️ Could not resolve an eVDR approving officer: ${e.message}`);
        return;
      }
      console.log(`📋 Officer: ${officer.email} (${officer.role}) — ${officer.office}`);
      expect(officer.email).toContain('@');

      const adminContext = await browser.newContext();
      try {
        const adminPage = await adminContext.newPage();
        const loggedInPage = await adminLoginFlow(adminPage, officer.email);
        console.log(`✅ Logged in as admin. Landed on: ${loggedInPage.url()}`);

        if (!loggedInPage.url().includes('/admin/applications/')) {
          await waitForUrlOrRefresh(loggedInPage, '**sansols/admin/applications/**', 10000, 3).catch((err) => {
            console.log(`⚠️ Still not on the admin applications page: ${err.message}`);
          });
        }
        await loggedInPage.screenshot({ path: 'test-results/evdr-admin-login.png', fullPage: true }).catch(() => { });

        await loggedInPage.goto('https://demo.sarawakforeignworkers.com/sansols/admin/applications/?module=expat', { waitUntil: 'networkidle' });
        await loggedInPage.waitForTimeout(1000);

        const evdrTab = loggedInPage.getByRole('button', { name: /^EVDR$/i }).first()
          .or(loggedInPage.locator('button:has-text("EVDR")').first());
        await evdrTab.waitFor({ state: 'visible', timeout: 15000 });
        await evdrTab.click();
        console.log('✅ Clicked "EVDR" tab.');
        await loggedInPage.waitForLoadState('networkidle').catch(() => { });
        await loggedInPage.waitForTimeout(1500);
        await loggedInPage.screenshot({ path: 'test-results/evdr-admin-tab.png', fullPage: true }).catch(() => { });

        await submitEvdrAsAdmin(loggedInPage, referenceNo);

        await test.info().attach('evdr-approving-officer.json', {
          body: JSON.stringify({ evdrApplicationId: resolvedEvdrId, referenceNo, officer }, null, 2),
          contentType: 'application/json',
        });
      } finally {
        await adminContext.close().catch(() => { });
      }
    });
  });

});

// ─── Step implementations ───────────────────────────────────────────────────

/**
 * Fills the "Company Information" slider (Person-in-Charge details) for a
 * worker card and clicks SAVE. Opened via the pencil/edit icon on the card.
 */
async function fillPersonInChargeDetails(evdrPage, chosenCard) {
  const editIcon = chosenCard.locator('[data-testid="EditIcon"]').first()
    .or(chosenCard.locator('svg[data-testid="EditIcon"]').first());
  await editIcon.waitFor({ state: 'visible', timeout: 10000 });
  await editIcon.click();
  console.log('✅ Opened Person-in-Charge Details (pencil icon).');

  await evdrPage.waitForLoadState('networkidle').catch(() => { });
  await evdrPage.waitForTimeout(1500);
  await evdrPage.screenshot({ path: 'test-results/evdr-company-information-form.png', fullPage: true }).catch(() => { });

  const companyInfoVisible = await evdrPage.locator('text=Company Information').first().isVisible({ timeout: 8000 }).catch(() => false);
  expect(companyInfoVisible, '"Company Information" slider should open').toBeTruthy();

  console.log('📝 Filling Company Information...');
  await fillFieldByLabel(evdrPage, 'Name of Person Incharge', 'Saddam Hussein');
  await fillFieldByLabel(evdrPage, 'Identity Number', '720101-13-9012');
  await fillFieldByLabel(evdrPage, 'Job Position', 'SYSTEM ADMIN');
  await fillFieldByLabel(evdrPage, 'Phone Number', '0192341234');
  await fillFieldByLabel(evdrPage, 'Email', 'qa.socoe@gmail.com');
  await fillFieldByLabel(evdrPage, 'Business start date', '2026-08-26');

  // "Visa Job Name" is a native <select> — random pick, excluding the
  // "SELECT A JOB" placeholder.
  const visaJobSelect = evdrPage.locator('select').filter({ has: evdrPage.locator('option:has-text("SELECT A JOB")') }).first();
  if (await visaJobSelect.isVisible({ timeout: 8000 }).catch(() => false)) {
    const options = await visaJobSelect.locator('option').evaluateAll(
      (opts) => opts.map((o) => ({ value: o.value, label: o.textContent?.trim() || '' }))
    );
    const realOptions = options.filter((o) => o.value && !/^select a job$/i.test(o.label));
    if (realOptions.length > 0) {
      const chosen = realOptions[Math.floor(Math.random() * realOptions.length)];
      await visaJobSelect.selectOption(chosen.value);
      console.log(`  🎲 Visa Job Name: "${chosen.label}"`);
    }
  } else {
    console.log('  ⚠️ "Visa Job Name" select not found — skipping.');
  }

  await evdrPage.screenshot({ path: 'test-results/evdr-company-information-filled.png', fullPage: true }).catch(() => { });

  const saveBtn = evdrPage.getByRole('button', { name: /^SAVE$/i }).first();
  await saveBtn.waitFor({ state: 'visible', timeout: 8000 });
  await saveBtn.click();
  console.log('💾 Saved Person-in-Charge Details.');

  await evdrPage.waitForLoadState('networkidle').catch(() => { });
  // Give the slider time to close and the list to re-render before the
  // caller clicks back into the card.
  await evdrPage.waitForTimeout(2000);
  await evdrPage.screenshot({ path: 'test-results/evdr-company-information-saved.png', fullPage: true }).catch(() => { });
}

/**
 * Fills the Visa Form: Visa Details (dropdowns + Date of Entry), document
 * uploads, BPP Reference Number, and eVDR Info (approved date + upload).
 */
async function fillVisaForm(evdrPage, isMalaysianWorker) {
  console.log('📝 Filling Visa Form...');
  const pdfDir = path.dirname(CONFIG.pdfUploadPath || '');
  const passportPath = path.join(pdfDir, 'passport.jpg');
  const certificatePath = path.join(pdfDir, 'certifcate.png');

  await selectMuiDropdownByLabel(evdrPage, 'Entry Point', { matchLabel: /LTA\s*KUCHING/i });

  // Malaysian workers aren't entering on a foreign visa, so there's no
  // relevant embassy/branch to select.
  if (isMalaysianWorker) {
    console.log('  ⏭️ Skipping "Visa Branch" — worker is Malaysian.');
  } else {
    await selectMuiDropdownByLabel(evdrPage, 'Visa Branch', { random: true });
  }

  // Date of Entry must be within the last 1 year (e.g. today 27/08/2026 ->
  // earliest allowed 27/08/2025).
  await fillFieldByLabel(evdrPage, 'Date of Entry', randomDate(365), { timeout: 5000 });

  await uploadViaLabel(evdrPage, 'Passport (Front and Back)', passportPath);
  await uploadViaLabel(evdrPage, 'Proof of Entry (Passport Copy)/ Special Pass', passportPath);

  const randomDigits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
  const bppReferenceNumber = `BPP/${randomDigits(5)}/MHAUM${randomDigits(7)}/1`;
  await fillFieldByLabel(evdrPage, 'BPP Reference Number', bppReferenceNumber, { timeout: 5000 });

  // Same 1-year limit as Date of Entry.
  await fillFieldByLabel(evdrPage, 'eVDR Approved Date', randomDate(365), { timeout: 5000 });
  await uploadViaLabel(evdrPage, 'Upload Approved eVDR', certificatePath);
}

/**
 * Entry Point / Visa Branch are MUI <div role="combobox"> selects, not
 * native <select> elements — click to open the popup listbox, then click
 * the matching or a random <li role="option">.
 */
async function selectMuiDropdownByLabel(evdrPage, labelText, { matchLabel, random } = {}) {
  const combobox = evdrPage.locator('label').filter({ hasText: labelText }).first()
    .locator('xpath=following::div[@role="combobox"][1]')
    .or(evdrPage.locator(`text=${labelText}`).first().locator('xpath=following::div[@role="combobox"][1]'));

  if (!(await combobox.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false))) {
    console.log(`  ⚠️ "${labelText}" dropdown not found/visible — skipping.`);
    return;
  }

  await combobox.click();
  await evdrPage.waitForTimeout(400);

  const options = evdrPage.locator('[role="option"], li[role="option"]').filter({ hasNotText: /^Select One$/i });
  const optionCount = await options.count();
  if (optionCount === 0) {
    console.log(`  ⚠️ No options found in the "${labelText}" dropdown.`);
    await evdrPage.keyboard.press('Escape').catch(() => { });
    return;
  }

  let chosenOption;
  if (matchLabel) {
    for (let i = 0; i < optionCount; i++) {
      const text = await options.nth(i).innerText().catch(() => '');
      if (matchLabel.test(text)) { chosenOption = options.nth(i); break; }
    }
    if (!chosenOption) {
      console.log(`  ⚠️ No option matching ${matchLabel} for "${labelText}" — closing without selecting.`);
      await evdrPage.keyboard.press('Escape').catch(() => { });
      return;
    }
  } else if (random) {
    chosenOption = options.nth(Math.floor(Math.random() * optionCount));
  }

  const chosenText = await chosenOption.innerText().catch(() => '(unknown)');
  await chosenOption.click();
  console.log(`  ${matchLabel ? '➕' : '🎲'} ${labelText}: "${chosenText.trim()}"`);
}

/**
 * Clicks an "Upload Document" trigger (a plain <div>-as-button — no real
 * <input type="file"> exists in the DOM until clicked) and feeds it the
 * given file via the resulting native file chooser event.
 */
async function uploadViaLabel(evdrPage, labelText, filePath) {
  const labelNode = evdrPage.getByText(labelText, { exact: false }).first();
  const row = labelNode.locator('xpath=ancestor::*[.//text()[normalize-space(.)="Upload Document"]][1]');
  const uploadTrigger = row.getByText('Upload Document', { exact: true }).first();

  if (!(await uploadTrigger.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false))) {
    console.log(`  ⚠️ "${labelText}" upload trigger not found/visible — skipping.`);
    return;
  }

  const chooserPromise = evdrPage.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await uploadTrigger.click();
  const chooser = await chooserPromise;

  if (chooser) {
    await chooser.setFiles(filePath);
    console.log(`  📎 ${labelText}: ${filePath}`);
    await evdrPage.waitForTimeout(800);
    return;
  }

  // Fallback: a hidden input may have been added to the row's DOM after the click.
  const fileInput = row.locator('input[type="file"]').first();
  if (await fileInput.count().then((c) => c > 0).catch(() => false)) {
    await fileInput.setInputFiles(filePath);
    console.log(`  📎 ${labelText} (via hidden input fallback): ${filePath}`);
    await evdrPage.waitForTimeout(800);
  } else {
    console.log(`  ⚠️ Could not upload "${labelText}" — no file chooser or hidden input found.`);
  }
}

/** Clicks a locator only if it's currently visible; logs either way. */
async function clickIfVisible(page, locator, label, timeout = 8000) {
  if (await locator.isVisible({ timeout }).catch(() => false)) {
    await locator.click();
    console.log(`✅ Clicked "${label}".`);
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.waitForTimeout(1500);
    return true;
  }
  console.log(`ℹ️ "${label}" not found/visible — likely already done on a previous run.`);
  return false;
}

/**
 * Admin-side: search by reference no. (NOT the eVDR numeric id — that's
 * only used for the officer lookup), pick a random matching card, and
 * submit it. Multiple workers can share the same reference no.
 */
async function submitEvdrAsAdmin(loggedInPage, referenceNo) {
  if (!referenceNo) {
    console.log('⚠️ No reference number available — cannot search the EVDR admin listing.');
    return;
  }

  console.log(`🔎 Searching for Reference No.: "${referenceNo}"`);
  const searchInput = loggedInPage.locator('input[placeholder="Search" i]').first();
  if (await searchInput.isVisible({ timeout: 10000 }).catch(() => false)) {
    await searchInput.fill(referenceNo);
    await searchInput.press('Enter');
    await loggedInPage.waitForLoadState('networkidle').catch(() => { });
    await loggedInPage.waitForTimeout(1500);
  } else {
    console.log('⚠️ Search input not found on the EVDR tab — skipping search.');
  }
  await loggedInPage.screenshot({ path: 'test-results/evdr-admin-search-result.png', fullPage: true }).catch(() => { });

  const resultCards = loggedInPage.locator('text=' + referenceNo).locator('xpath=ancestor::*[self::div or self::a][1]');
  const resultCount = await resultCards.count().catch(() => 0);
  console.log(`👥 ${resultCount} result(s) matching "${referenceNo}".`);
  if (resultCount === 0) {
    console.log('⚠️ No matching application card found — skipping submit.');
    return;
  }

  const chosenIndex = Math.floor(Math.random() * resultCount);
  console.log(`🎲 Picked result ${chosenIndex + 1}/${resultCount}.`);
  await resultCards.nth(chosenIndex).click();
  await loggedInPage.waitForLoadState('networkidle').catch(() => { });
  await loggedInPage.waitForTimeout(1500);
  await loggedInPage.screenshot({ path: 'test-results/evdr-admin-application-detail.png', fullPage: true }).catch(() => { });

  // Most fields here mirror the employer's own submission and are already
  // filled — "eVisa Info" is expected to stay empty/admin-owned at this
  // stage, so this is a diagnostic count only, not something to autofill.
  const inputs = loggedInPage.locator('input:not([type="file"]):not([type="hidden"])');
  const inputCount = await inputs.count().catch(() => 0);
  let emptyCount = 0;
  for (let i = 0; i < inputCount; i++) {
    const isVisible = await inputs.nth(i).isVisible().catch(() => false);
    const val = isVisible ? await inputs.nth(i).inputValue().catch(() => '') : '1';
    if (isVisible && val.trim() === '') emptyCount++;
  }
  console.log(`📋 ${emptyCount}/${inputCount} visible field(s) empty (eVisa Info expected to be empty here).`);

  const submitBtn = loggedInPage.getByRole('button', { name: /^Submit$/i }).first()
    .or(loggedInPage.locator('button:has-text("Submit")').first());
  await submitBtn.waitFor({ state: 'attached', timeout: 10000 });
  await submitBtn.scrollIntoViewIfNeeded();
  await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
  await submitBtn.click();
  console.log('✅ Submitted (admin side).');

  await loggedInPage.waitForLoadState('networkidle').catch(() => { });
  await loggedInPage.waitForTimeout(1500);
  await loggedInPage.screenshot({ path: 'test-results/evdr-admin-submitted.png', fullPage: true }).catch(() => { });
  console.log('🎉 Admin-side eVDR submission complete.');
}
