// admin-approve-application.test.js
//
// Second half of the AL flow: given a submitted application's ID, look up
// which government officer is assigned to approve it (via the internal QA
// Tools API), then log into the admin (SANSOLS) portal as that officer to
// review/approve the application.
//
// The application ID can come from either:
// - APPLICATION_ID env var (explicit override, e.g. for approving a
//   specific past application on demand), or
// - .test-state/last-application-id.json, written automatically by
//   al-autofill-form.test.js right after it clicks "Submit". This lives
//   outside test-results/ deliberately, since Playwright wipes that
//   directory at the start of every run (which would delete the hand-off
//   file before this test could read it).

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { adminLoginFlow, fullLoginFlow, getLatestOpenPage, waitForUrlOrRefresh } = require('../helpers/login-helpers');
const { getApprovingOfficer, promoteProforma } = require('../helpers/qa-api-helpers');

const LAST_ID_PATH = path.resolve(__dirname, '..', '.test-state', 'last-application-id.json');

// Lets admin-approve-application.test.js run standalone against a specific
// application — set both APPLICATION_ID and APPLICATION_REF_NO in .env to
// target it directly, without needing a fresh end-to-end run of
// al-autofill-form.test.js first. Leave both unset (or empty) to fall back
// to the hand-off file written by that test, as before.
function resolveApplicationIdentifiers() {
  const envApplicationId = (process.env.APPLICATION_ID || '').trim();
  const envReferenceNo = (process.env.APPLICATION_REF_NO || '').trim();

  if (envApplicationId) {
    console.log(`🆔 Using APPLICATION_ID from ENV: ${envApplicationId}`);
    if (envReferenceNo) {
      console.log(`🔖 Using APPLICATION_REF_NO from ENV: ${envReferenceNo}`);
    } else {
      console.log('⚠️ APPLICATION_ID is set but APPLICATION_REF_NO is empty — the admin-side search/lookup steps need the reference number and will be skipped without it.');
    }
    return { applicationId: envApplicationId, referenceNo: envReferenceNo || null };
  }

  if (fs.existsSync(LAST_ID_PATH)) {
    const saved = JSON.parse(fs.readFileSync(LAST_ID_PATH, 'utf-8'));
    console.log(`🆔 Using Application ID captured from last submission run: ${saved.applicationId}`);
    if (saved.referenceNo) console.log(`🔖 Application Reference No.: ${saved.referenceNo}`);
    console.log(`   (captured at ${saved.capturedAt} from URL: ${saved.url})`);
    return { applicationId: saved.applicationId, referenceNo: saved.referenceNo || null };
  }

  throw new Error(
    'No application ID available. Either set APPLICATION_ID + APPLICATION_REF_NO in .env, ' +
    'or run al-autofill-form.test.js first with SUBMIT_APPLICATION=true to generate one.'
  );
}

// Remarks are drawn from a plausible-sounding pool that matches the
// recommendation outcome — positive/professional wording when
// recommending, and a specific concern when not recommending.
const positiveRemarks = [
  'Candidate profile meets all requirements. Documentation is complete and consistent.',
  'Qualifications and job role are well aligned. No discrepancies found during review.',
  'All supporting documents verified. Application is in order for approval.',
  'Salary and pass duration are within acceptable range for the stated position.',
  'Employment history and passport details are consistent. Recommended for approval.',
];
const negativeRemarks = [
  'Supporting documents appear incomplete. Recommend requesting clarification before proceeding.',
  'Discrepancy noted between job position and stated qualification. Requires further review.',
  'Salary offered does not align with the market rate for this classification.',
  'Passport or NRIC details require verification before this application can proceed.',
  'Employment history details are insufficient to justify the requested pass duration.',
];

// ── Approval hierarchy ──────────────────────────────────────────────────────
// A single application is reviewed by a CHAIN of officers, one stage at a
// time, in this order:
//   1. jims_officer_expat     -> Recommend/Not Recommend + Remarks, then ACCEPT
//   2. jims_hq_officer_expat  -> Recommend/Not Recommend + Remarks, then ACCEPT
//   3. ilmu_officer_expat     -> Remarks ONLY (no Recommend/Not Recommend), then SUBMIT
//   4. ilmu_officer           -> reported alongside mjlpbp_review/select_jkle/
//      site_inspector_expat (not all always present — only ilmu_officer is
//      guaranteed) -> Recommend/Not Recommend + Site Inspection Required
//      checkbox (ENV-controlled) + Remarks + Application Remarks, then SUBMIT
//   5. ilmu_dir               -> "ILMU Director Review" -> Recommend/Not
//      Recommend + Remarks + DSS Review (Optional/Mandatory, ENV-controlled),
//      then REVIEW
//   6. deputy_state_secretary_expat (DSS) -> ONLY appears as a REQUIRED
//      stage when DSS_REVIEW was set to "mandatory" at the ilmu_dir stage
//      above. When DSS_REVIEW=optional, the QA API never reports this role
//      as REQUIRED, so the chain naturally skips straight to state_secretary
//      without any special-casing needed here.
//   7. state_secretary        -> final stage
// After each ACCEPT/SUBMIT/REVIEW, the QA API is queried again for the SAME
// applicationId to find out who the next officer in the chain is — the
// officer email changes every stage, so the whole login also has to repeat.
function hasRole(roleStr, target) {
  return (roleStr || '').split(',').map(r => r.trim().toLowerCase()).includes(target.toLowerCase());
}

function isIlmuExpatStage(role) {
  return hasRole(role, 'ilmu_officer_expat');
}

// Distinct from ilmu_officer_expat — this is the JKLE panel stage, which may
// also carry mjlpbp_review / select_jkle / site_inspector_expat roles, but
// only "ilmu_officer" is guaranteed to be present so that's what's matched on.
function isJkleStage(role) {
  return hasRole(role, 'ilmu_officer');
}

function isIlmuDirStage(role) {
  return hasRole(role, 'ilmu_dir');
}

// deputy_state_secretary_expat (DSS) — checked BEFORE state_secretary since
// the role string "deputy_state_secretary_expat" also contains the
// substring "state_secretary"; hasRole() does exact per-token matching so
// this wouldn't actually collide, but the two are still deliberately
// checked in this order for clarity.
function isDssStage(role) {
  return hasRole(role, 'deputy_state_secretary_expat');
}

function isStateSecretaryStage(role) {
  return hasRole(role, 'state_secretary');
}

/**
 * Logs in as the given officer, navigates to the SANSOLS admin applications
 * page, filters to EXPRT, searches by reference number, and opens the
 * application's detail view with the Employees tab active.
 */
async function loginAndOpenApplication(page, officerEmail, referenceNo) {
  console.log(`🔑 Logging into admin portal as: ${officerEmail}`);
  const adminPage = await adminLoginFlow(page, officerEmail);
  console.log(`✅ Logged in. Landed on: ${adminPage.url()}`);

  // Genesis sometimes lands on the generic "/sansols/admin/dashboard/" shell
  // (the Genesis marketing homepage) instead of the applications listing.
  // Reloading doesn't help here — that dashboard IS the real landing route
  // for this session. Since the /dashboard/ and /applications/ URLs are on
  // the same domain/app, directly swapping the path and navigating there is
  // simpler and more reliable than hunting for a sidebar icon.
  if (adminPage.url().includes('/admin/dashboard/')) {
    const correctedUrl = adminPage.url().replace('/admin/dashboard/', '/admin/applications/');
    console.log(`ℹ️ Landed on "/admin/dashboard/" instead of "/admin/applications/" — forcing navigation to: ${correctedUrl}`);
    await adminPage.goto(correctedUrl, { waitUntil: 'networkidle' }).catch((err) => {
      console.log(`⚠️ Direct navigation to corrected URL failed: ${err.message}`);
    });
    await adminPage.waitForTimeout(1000);
  }

  // Fallback for any other unexpected landing page (not dashboard, not
  // applications) — try the sidebar "Applications" icon before giving up.
  if (!adminPage.url().includes('/admin/applications/')) {
    console.log(`ℹ️ Still not on the applications page (current URL: ${adminPage.url()}) — trying sidebar navigation...`);

    const applicationsIcon = adminPage.locator('a, button, [role="button"]')
      .filter({ hasText: /application/i })
      .or(adminPage.locator('[title*="application" i], [aria-label*="application" i]'))
      .first();

    if (await applicationsIcon.isVisible().catch(() => false)) {
      await applicationsIcon.click();
      console.log('✅ Clicked sidebar "Applications" icon.');
    } else {
      const sidebarIcon = adminPage.locator('nav, aside, [class*="sidebar" i]').first()
        .locator('a, button, [role="button"]')
        .filter({ has: adminPage.locator('svg, img') });
      const sidebarIconCount = await sidebarIcon.count().catch(() => 0);
      if (sidebarIconCount >= 2) {
        await sidebarIcon.nth(1).click();
        console.log('✅ Clicked 2nd sidebar icon (assumed Applications) as fallback.');
      } else {
        console.log('⚠️ Could not identify an Applications sidebar icon to click.');
      }
    }

    await adminPage.waitForLoadState('networkidle').catch(() => { });
    await waitForUrlOrRefresh(adminPage, '**sansols/admin/applications/**', 10000, 4).catch((err) => {
      console.log(`⚠️ Still not on applications page after sidebar click: ${err.message}`);
    });
  }

  await adminPage.screenshot({ path: 'test-results/admin-sansols-landing.png', fullPage: true }).catch(() => { });
  expect(adminPage.url()).toContain('/sansols/admin/applications/');
  console.log('✅ Confirmed on SANSOLS admin applications page.');

  // Click the "EXPRT" tab to filter the queue to EXPRT applications.
  console.log('\n📂 Clicking the "EXPRT" tab...');
  const exprtTab = adminPage.locator('button').filter({ hasText: /^EXPRT/ }).first()
    .or(adminPage.locator('button:has(img[alt="EX"])').first());
  await exprtTab.waitFor({ state: 'visible', timeout: 15000 });
  await exprtTab.scrollIntoViewIfNeeded();
  await exprtTab.click();
  console.log('✅ Clicked "EXPRT" tab.');
  await adminPage.waitForLoadState('networkidle').catch(() => { });
  await adminPage.waitForTimeout(1500);

  // Search the queue by the application's reference number.
  if (referenceNo) {
    console.log(`🔎 Searching for application by Reference No.: "${referenceNo}"...`);
    const searchInput = adminPage.locator('input[placeholder="Search"]').first();
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    await searchInput.click();
    await searchInput.fill(referenceNo);
    await searchInput.press('Enter');
    console.log(`✅ Typed "${referenceNo}" into the search bar.`);
    await adminPage.waitForLoadState('networkidle').catch(() => { });
    await adminPage.waitForTimeout(1500);
  }

  // Open the filtered application's detail view.
  console.log(`\n📂 Opening application detail for Reference No. "${referenceNo}"...`);
  const appCard = adminPage.locator(`text=${referenceNo}`).first();
  await appCard.waitFor({ state: 'visible', timeout: 10000 });
  await appCard.click();
  await adminPage.waitForLoadState('networkidle').catch(() => { });
  await adminPage.waitForTimeout(1500);

  const employeesTab = adminPage.locator('button, [role="tab"], a').filter({ hasText: /^EMPLOYEES$/i }).first();
  if (await employeesTab.isVisible().catch(() => false)) {
    await employeesTab.click().catch(() => { });
    await adminPage.waitForTimeout(800);
  }

  return adminPage;
}

/**
 * Reviews every employee on the currently-open application: optionally sets
 * Recommend/Not Recommend (skipped entirely for the ILMU-EXPAT stage, which
 * only takes Remarks), fills Remarks (and, for the JKLE stage, also the
 * "Site Inspection Required" checkbox + a second "Application Remarks"
 * field), then clicks SAVE per employee.
 */
async function reviewAllEmployees(adminPage, { skipRecommendation, isJkle, isIlmuDir, isStateSecretary, stageLabel }) {
  let totalEmployees = 1;
  try {
    const totalEmployeesValue = adminPage.locator('text=Total Employees').first().locator('xpath=following::*[1]');
    const totalText = await totalEmployeesValue.innerText({ timeout: 5000 });
    const parsed = parseInt(totalText.replace(/\D/g, ''), 10);
    if (!Number.isNaN(parsed) && parsed > 0) totalEmployees = parsed;
  } catch (e) {
    console.log(`⚠️ Could not read "Total Employees" count, defaulting to 1: ${e.message}`);
  }
  console.log(`👥 Total Employees on this application: ${totalEmployees}`);

  const recommendationMode = (process.env.ADMIN_RECOMMENDATION || 'recommend').trim().toLowerCase();
  const decideRecommendation = () => {
    if (recommendationMode === 'not_recommend') return false;
    if (recommendationMode === 'random') return Math.random() < 0.5;
    return true; // default: 'recommend'
  };

  // State Secretary is the final AL approval stage — its buttons read
  // "Approve" / "Reject" instead of "Recommend" / "Not Recommend", and the
  // decision is controlled by its own dedicated ENV var since this is the
  // final, most consequential decision in the whole chain.
  const stateSecretaryMode = (process.env.STATE_SECRETARY_DECISION || 'approve').trim().toLowerCase();
  const decideStateSecretary = () => {
    if (stateSecretaryMode === 'reject') return false;
    if (stateSecretaryMode === 'random') return Math.random() < 0.5;
    return true; // default: 'approve'
  };

  // Both Recommend and Not Recommend buttons ALWAYS have a solid background
  // color — there is no transparent/unstyled state to detect. The INACTIVE
  // state for both buttons is the same neutral grey (bg-[#cececeff], i.e.
  // rgb(206, 206, 206)); the ACTIVE state is whichever button's own color
  // (green for Recommend, a different color for Not Recommend). So "active"
  // simply means "NOT that specific grey".
  const INACTIVE_GREY = 'rgb(206, 206, 206)';
  const isActive = async (locator) => {
    const bg = await locator.evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => '');
    return !!bg && bg !== INACTIVE_GREY;
  };

  const employeeReviews = [];

  for (let i = 0; i < totalEmployees; i++) {
    await test.step(`[${stageLabel}] Employee ${i + 1} of ${totalEmployees}`, async () => {
      console.log(`\n👤 Reviewing Employee ${i + 1} of ${totalEmployees}...`);

      // ── JKLE stage: Site Inspection Required checkbox ───────────────────
      // For the JKLE (ilmu_officer) stage, the Recommend/Not Recommend
      // control only RENDERS once the "Site Inspection Required" checkbox
      // is UNCHECKED — while checked, the decision UI stays hidden. So for
      // this stage the checkbox has to be handled BEFORE attempting the
      // Recommend/Not Recommend click, not after (unlike every other field
      // on this stage, which comes after the decision).
      if (isJkle) {
        // The checkbox is CHECKED by default in the UI (<input type="checkbox"
        // checked="">). Only action needed: uncheck it when
        // SITE_INSPECTION_REQUIRED=false. Leave it checked (do nothing)
        // otherwise — there's no "check" case to handle since that's
        // already the default state. NOTE: leaving it checked means the
        // Recommend/Not Recommend control stays hidden and skipRecommendation
        // effectively applies for this run, since there's nothing to click.
        const siteInspectionEnabled = (process.env.SITE_INSPECTION_REQUIRED || 'false').trim().toLowerCase() === 'true';
        const siteInspectionCheckbox = adminPage.locator('input[type="checkbox"]')
          .filter({ has: adminPage.locator('xpath=following-sibling::*[contains(., "Site Inspection")] | ancestor::label[contains(., "Site Inspection")]') })
          .first()
          .or(adminPage.getByRole('checkbox', { name: /site inspection required/i }))
          .or(adminPage.locator('label:has-text("Site Inspection Required") input[type="checkbox"]').first());

        const checkboxVisible = await siteInspectionCheckbox.isVisible().catch(() => false);
        if (checkboxVisible) {
          const isChecked = await siteInspectionCheckbox.isChecked().catch(() => true);
          if (!siteInspectionEnabled && isChecked) {
            await siteInspectionCheckbox.uncheck({ force: true });
            console.log('☐ Unchecked "Site Inspection Required" (SITE_INSPECTION_REQUIRED=false) — Recommend/Not Recommend should now be visible.');
            await adminPage.waitForTimeout(500);
          } else if (siteInspectionEnabled) {
            console.log('ℹ️ SITE_INSPECTION_REQUIRED=true — leaving "Site Inspection Required" checked (default state); Recommend/Not Recommend stays hidden.');
          } else {
            console.log('ℹ️ "Site Inspection Required" is already unchecked — leaving as-is.');
          }
        } else {
          console.log('⚠️ "Site Inspection Required" checkbox not found/visible — skipping.');
        }
      }

      // Skip the Recommend/Not Recommend control entirely when the JKLE
      // checkbox above was left CHECKED (SITE_INSPECTION_REQUIRED=true) —
      // in that state the control isn't rendered at all, so there'd be
      // nothing to click.
      const siteInspectionLeftChecked = isJkle && (process.env.SITE_INSPECTION_REQUIRED || 'false').trim().toLowerCase() === 'true';
      const shouldSkipRecommendation = skipRecommendation || siteInspectionLeftChecked;

      let shouldRecommend = true;
      if (!shouldSkipRecommendation) {
        // State Secretary uses "Approve"/"Reject" wording and its own ENV
        // var (STATE_SECRETARY_DECISION) instead of "Recommend"/"Not
        // Recommend" + ADMIN_RECOMMENDATION used by every earlier stage.
        const recommendationLabel = isStateSecretary
          ? (decideStateSecretary() ? 'Approve' : 'Reject')
          : (decideRecommendation() ? 'Recommend' : 'Not Recommend');
        shouldRecommend = recommendationLabel === 'Recommend' || recommendationLabel === 'Approve';

        if (isStateSecretary) {
          console.log(`🎯 Decision (STATE_SECRETARY_DECISION="${stateSecretaryMode}"): ${recommendationLabel}`);
        } else {
          console.log(`🎯 Decision (ADMIN_RECOMMENDATION="${recommendationMode}"): ${recommendationLabel}`);
        }

        // Only click if not already in the desired state — re-clicking an
        // already-active toggle button flips it back OFF instead of
        // leaving it selected.
        const recBtn = adminPage.locator('button, [role="button"]')
          .filter({ hasText: new RegExp(`^${recommendationLabel}$`, 'i') })
          .first();
        await recBtn.waitFor({ state: 'visible', timeout: 8000 });
        await recBtn.scrollIntoViewIfNeeded();

        const alreadySelected = await isActive(recBtn);
        if (alreadySelected) {
          console.log(`ℹ️ "${recommendationLabel}" is already selected — leaving as-is.`);
        } else {
          // A plain .click() sometimes doesn't register on this MUI button
          // (its ripple <span> overlay can intercept the click event before
          // it reaches the button's real click handler). Click normally
          // first, verify the active state actually changed, and if not,
          // dispatch a native DOM click event directly as a fallback.
          await recBtn.click();
          await adminPage.waitForTimeout(500);

          let nowActive = await isActive(recBtn);
          if (!nowActive) {
            console.log(`⚠️ "${recommendationLabel}" click did not register — retrying with dispatchEvent...`);
            await recBtn.dispatchEvent('click');
            await adminPage.waitForTimeout(500);
            nowActive = await isActive(recBtn);
          }

          if (nowActive) {
            console.log(`✅ Selected "${recommendationLabel}"`);
          } else {
            console.log(`⚠️ "${recommendationLabel}" still does not appear active after retry — continuing anyway.`);
          }
        }
      } else {
        console.log('ℹ️ No Recommend/Not Recommend control for this stage/state — Remarks only.');
      }

      // Fill Remarks — a rich-text editor (bold/italic/list toolbar), not a
      // plain <textarea>, so target the nearest contenteditable region
      // after the "Remarks" label, with a plain textarea as fallback.
      const remarkPool = shouldRecommend ? positiveRemarks : negativeRemarks;
      const chosenRemark = remarkPool[Math.floor(Math.random() * remarkPool.length)];

      const remarksField = adminPage.locator('text=Remarks').first()
        .locator('xpath=following::*[@contenteditable="true"][1]')
        .or(adminPage.locator('div[contenteditable="true"]').first())
        .or(adminPage.locator('textarea[placeholder="Remarks" i]').first());

      await remarksField.waitFor({ state: 'visible', timeout: 8000 });
      await remarksField.click();
      await adminPage.keyboard.press('Control+A').catch(() => { });
      await adminPage.keyboard.press('Backspace').catch(() => { });

      try {
        await remarksField.fill(chosenRemark);
      } catch {
        await remarksField.pressSequentially(chosenRemark, { delay: 15 });
      }

      await adminPage.waitForTimeout(300);
      let remarksText = await remarksField.innerText().catch(() => '');
      if (!remarksText || remarksText.trim() === '') {
        console.log('⚠️ Remarks field still empty after .fill() — retrying with direct keyboard typing...');
        await remarksField.click();
        await adminPage.keyboard.press('Control+A').catch(() => { });
        await adminPage.keyboard.press('Backspace').catch(() => { });
        await adminPage.keyboard.type(chosenRemark, { delay: 15 });
        await adminPage.waitForTimeout(300);
        remarksText = await remarksField.innerText().catch(() => '');
      }

      if (remarksText && remarksText.trim() !== '') {
        console.log(`📝 Remarks confirmed in field: "${remarksText.trim()}"`);
      } else {
        console.log(`⚠️ Remarks field appears empty after all attempts. Intended text was: "${chosenRemark}"`);
      }

      // ── JKLE stage extra: a second "Application Remarks" field ─────────
      // (filled with the same text as Remarks — no separate wording needed).
      let applicationRemarksText = '';
      if (isJkle) {
        // Second remarks field, filled with the same text as the first
        // "Remarks" field — no separate wording needed per instructions.
        const applicationRemarksField = adminPage.locator('text=Application Remarks').first()
          .locator('xpath=following::*[@contenteditable="true"][1]')
          .or(adminPage.locator('div[contenteditable="true"]').nth(1));

        const appRemarksVisible = await applicationRemarksField.isVisible().catch(() => false);
        if (appRemarksVisible) {
          await applicationRemarksField.click();
          await adminPage.keyboard.press('Control+A').catch(() => { });
          await adminPage.keyboard.press('Backspace').catch(() => { });
          try {
            await applicationRemarksField.fill(chosenRemark);
          } catch {
            await applicationRemarksField.pressSequentially(chosenRemark, { delay: 15 });
          }
          await adminPage.waitForTimeout(300);
          applicationRemarksText = await applicationRemarksField.innerText().catch(() => '');
          if (!applicationRemarksText || applicationRemarksText.trim() === '') {
            await applicationRemarksField.click();
            await adminPage.keyboard.press('Control+A').catch(() => { });
            await adminPage.keyboard.press('Backspace').catch(() => { });
            await adminPage.keyboard.type(chosenRemark, { delay: 15 });
            await adminPage.waitForTimeout(300);
            applicationRemarksText = await applicationRemarksField.innerText().catch(() => '');
          }
          console.log(`📝 Application Remarks confirmed in field: "${(applicationRemarksText || '').trim()}"`);
        } else {
          console.log('⚠️ "Application Remarks" field not found/visible — skipping.');
        }
      }

      // ── ILMU DIR stage extra: DSS Review (Optional / Mandatory radio) ──
      // Defaults to "Optional" for a faster approval path — only switch to
      // "Mandatory" when DSS_REVIEW=mandatory is explicitly set.
      let dssReviewChoice = null;
      if (isIlmuDir) {
        const dssMode = (process.env.DSS_REVIEW || 'optional').trim().toLowerCase();
        dssReviewChoice = dssMode === 'mandatory' ? 'Mandatory' : 'Optional';

        const dssRadio = adminPage.locator('input[type="radio"]')
          .filter({ has: adminPage.locator(`xpath=following-sibling::*[contains(., "${dssReviewChoice}")] | ancestor::label[contains(., "${dssReviewChoice}")]`) })
          .first()
          .or(adminPage.getByRole('radio', { name: new RegExp(`^${dssReviewChoice}$`, 'i') }))
          .or(adminPage.locator(`label:has-text("${dssReviewChoice}") input[type="radio"]`).first());

        const dssVisible = await dssRadio.isVisible().catch(() => false);
        if (dssVisible) {
          const alreadyChecked = await dssRadio.isChecked().catch(() => false);
          if (!alreadyChecked) {
            await dssRadio.check({ force: true });
          }
          console.log(`🔘 DSS Review: "${dssReviewChoice}" (DSS_REVIEW="${dssMode}")`);
        } else {
          console.log(`⚠️ DSS Review "${dssReviewChoice}" radio not found/visible — skipping.`);
        }
      }

      employeeReviews.push({
        index: i + 1,
        recommendation: shouldSkipRecommendation
          ? null
          : (isStateSecretary ? (shouldRecommend ? 'Approve' : 'Reject') : (shouldRecommend ? 'Recommend' : 'Not Recommend')),
        remark: remarksText?.trim() || chosenRemark,
        applicationRemark: isJkle ? (applicationRemarksText?.trim() || chosenRemark) : undefined,
        dssReview: dssReviewChoice,
      });

      await adminPage.screenshot({ path: `test-results/admin-${stageLabel}-employee-${i + 1}-before-save.png`, fullPage: true }).catch(() => { });

      // SAVE and ACCEPT clicked back-to-back (SAVE persists this employee's
      // review, ACCEPT immediately re-submits the whole form) causes the UI
      // to get stuck — the second click fires before the app has finished
      // processing the first. When ADMIN_ACCEPT_REVIEW=true, skip SAVE
      // entirely and let ACCEPT/SUBMIT (clicked once, in clickFinalAction)
      // persist everything in a single action instead. Only click SAVE
      // when we're NOT proceeding to Accept — i.e. this run is meant to
      // stop after recording the review as a draft.
      const willAccept = process.env.ADMIN_ACCEPT_REVIEW === 'true';
      if (willAccept) {
        console.log('ℹ️ ADMIN_ACCEPT_REVIEW=true — skipping "SAVE" click; the final ACCEPT/SUBMIT click will persist this review directly.');
      } else {
        const saveBtn = adminPage.getByRole('button', { name: /^SAVE$/i }).first();
        if (await saveBtn.isVisible().catch(() => false)) {
          await saveBtn.click();
          console.log('💾 Clicked "SAVE" for this employee.');
          await adminPage.waitForTimeout(1500);
        } else {
          console.log('⚠️ "SAVE" button not found/visible — skipping.');
        }
      }

      await adminPage.screenshot({ path: `test-results/admin-${stageLabel}-employee-${i + 1}-after-save.png`, fullPage: true }).catch(() => { });

      if (i < totalEmployees - 1) {
        const nextBtn = adminPage.getByRole('button', { name: /^Next$/i }).first();
        await nextBtn.waitFor({ state: 'visible', timeout: 8000 });
        await nextBtn.click();
        console.log('➡️ Clicked "Next" to move to the next employee.');
        await adminPage.waitForTimeout(1000);
      }
    });
  }

  // Surfaced for reporting purposes — the final action button itself is
  // always "SUBMIT" for State Secretary regardless of this decision (all
  // employees share the same recommendation label per stage in the
  // current flow, so the last entry represents the whole stage's outcome).
  const stateSecretaryFinalDecision = isStateSecretary && employeeReviews.length > 0
    ? employeeReviews[employeeReviews.length - 1].recommendation
    : null;

  return { employeeReviews, stateSecretaryFinalDecision };
}

/**
 * Clicks the final action button for the current stage — "ACCEPT" for the
 * JIMS stages, "SUBMIT" for the ILMU/JKLE stages, "REVIEW" for ILMU
 * Director — gated behind ADMIN_ACCEPT_REVIEW.
 *
 * `buttonLabel` may be a single label or an array of candidate labels tried
 * in order — used for the DSS/State Secretary stages, where the exact
 * button wording hasn't been confirmed against the live UI yet.
 *
 * `isJkle` (JKLE / ilmu_officer stage only): clicking SUBMIT here can pop
 * up a "No Mandatory JKLE Agency Selected" confirmation dialog when no JKLE
 * agency was assigned. JKLE_AGENCY_CONFIRM (env) decides whether to click
 * "Confirm" (proceed without assigning one) or "Cancel" if that dialog shows.
 */
async function clickFinalAction(adminPage, { buttonLabel, stageLabel, isJkle }) {
  const shouldAdvance = process.env.ADMIN_ACCEPT_REVIEW === 'true';
  const candidates = Array.isArray(buttonLabel) ? buttonLabel : [buttonLabel];

  if (!shouldAdvance) {
    console.log(`\n⏭️ ADMIN_ACCEPT_REVIEW is not "true" in ENV. Skipping final "${candidates.join('/')}" click for ${stageLabel}.`);
    return false;
  }

  for (const label of candidates) {
    try {
      const actionBtn = adminPage.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
      const visible = await actionBtn.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) continue;

      console.log(`\n🚀 ADMIN_ACCEPT_REVIEW=true — clicking final "${label}" button for ${stageLabel}...`);
      await actionBtn.click();
      console.log(`✅ Clicked "${label}" for ${stageLabel}.`);
      await adminPage.waitForTimeout(1000);

      // ── JKLE-only: "No Mandatory JKLE Agency Selected" confirmation ──────
      if (isJkle) {
        const jkleAgencyPopup = adminPage.locator('text=No Mandatory JKLE Agency Selected').first();
        const jkleAgencyPopupVisible = await jkleAgencyPopup.isVisible({ timeout: 5000 }).catch(() => false);

        if (jkleAgencyPopupVisible) {
          console.log('📋 "No Mandatory JKLE Agency Selected" popup detected.');
          await adminPage.screenshot({ path: `test-results/admin-${stageLabel}-jkle-agency-popup.png`, fullPage: true }).catch(() => { });

          const decision = (process.env.JKLE_AGENCY_CONFIRM || 'confirm').trim().toLowerCase() === 'cancel' ? 'Cancel' : 'Confirm';
          console.log(`🎯 Decision (JKLE_AGENCY_CONFIRM="${process.env.JKLE_AGENCY_CONFIRM || 'confirm'}"): ${decision}`);

          const decisionBtn = adminPage.getByRole('button', { name: new RegExp(`^${decision}$`, 'i') }).first();
          await decisionBtn.waitFor({ state: 'visible', timeout: 5000 });
          await decisionBtn.click();
          console.log(`✅ Clicked "${decision}" on the JKLE agency popup.`);
          await adminPage.waitForTimeout(1000);

          // "Cancel" backs out of the submission entirely — the stage did
          // NOT advance in that case, unlike "Confirm" which proceeds.
          if (decision === 'Cancel') {
            console.log(`⏹️ "${stageLabel}" submission cancelled via JKLE agency popup — stage did not advance.`);
            return false;
          }
        }
      }

      await adminPage.waitForTimeout(500);
      await adminPage.screenshot({ path: `test-results/admin-${stageLabel}-accepted.png`, fullPage: true }).catch(() => { });
      return true;
    } catch (e) {
      console.log(`⚠️ Could not click "${label}" for ${stageLabel}: ${e.message}`);
    }
  }

  console.log(`⚠️ None of the candidate buttons [${candidates.join(', ')}] were found for ${stageLabel}.`);
  return false;
}

test.describe('EXPRT - Admin Approval Flow', () => {

  test('Walk the application through the full officer approval chain', async ({ browser, request }) => {
    const { applicationId, referenceNo } = resolveApplicationIdentifiers();
    if (referenceNo) {
      console.log(`🔖 Application Reference No. (used on the govt admin side to locate this application): ${referenceNo}`);
    }

    const stageResults = [];
    let stage = 0;
    let previousOfficer = null;

    while (true) {
      stage++;
      let currentOfficer;

      console.log(`\n🔎 [Stage ${stage}] Looking up approving officer for application ${applicationId}...`);
      try {
        currentOfficer = await getApprovingOfficer(request, applicationId);
      } catch (e) {
        console.log(`ℹ️ No officer currently waiting on this application (or lookup failed): ${e.message}`);
        console.log('🏁 Stopping the approval chain here.');
        break;
      }

      console.log('\n📋 Approving Officer Found:');
      console.log(`   Email : ${currentOfficer.email}`);
      console.log(`   Role  : ${currentOfficer.role}`);
      console.log(`   Office: ${currentOfficer.office}`);
      console.log(`   Status: ${currentOfficer.statusCode} ${currentOfficer.statusLabel}`);
      expect(currentOfficer.email).toContain('@');

      // After ACCEPT, the application should be handed off to the NEXT
      // officer in the hierarchy. If the QA API reports the exact same
      // officer/role as the previous stage, the current officer has not
      // actually settled this application yet — this is a hard error, not
      // something to retry or work around.
      if (previousOfficer && currentOfficer.email === previousOfficer.email && currentOfficer.role === previousOfficer.role) {
        throw new Error(
          `Same officer detected again after ACCEPT: ${currentOfficer.email} (${currentOfficer.role}). ` +
          `The application was not handed off to the next officer — it must be settled by the current officer first.`
        );
      }
      previousOfficer = currentOfficer;

      const ilmuExpatStage = isIlmuExpatStage(currentOfficer.role);
      const jkleStage = !ilmuExpatStage && isJkleStage(currentOfficer.role);
      const ilmuDirStage = !ilmuExpatStage && !jkleStage && isIlmuDirStage(currentOfficer.role);
      // DSS (deputy_state_secretary_expat) only ever shows up as REQUIRED
      // here when DSS_REVIEW was set to "mandatory" at the ilmu_dir stage —
      // getApprovingOfficer() already filters to the single REQUIRED entry,
      // so when DSS_REVIEW=optional the API simply never reports this role
      // as REQUIRED and this branch is naturally skipped in favor of
      // state_secretary below. No ENV check needed here at all.
      const dssStage = !ilmuExpatStage && !jkleStage && !ilmuDirStage && isDssStage(currentOfficer.role);
      const stateSecretaryStage = !ilmuExpatStage && !jkleStage && !ilmuDirStage && !dssStage && isStateSecretaryStage(currentOfficer.role);

      const stageLabel = `stage${stage}-${
        ilmuExpatStage ? 'ilmu-expat' : jkleStage ? 'jkle' : ilmuDirStage ? 'ilmu-dir'
          : dssStage ? 'dss' : stateSecretaryStage ? 'state-secretary' : 'jims'
      }`;

      // ilmu_officer_expat, JKLE (ilmu_officer), and State Secretary all
      // click "SUBMIT"; JIMS stages click "ACCEPT"; ILMU Director clicks
      // "REVIEW". State Secretary's recommendation buttons read
      // Approve/Reject rather than Recommend/Not Recommend (handled in
      // reviewAllEmployees) — that decision is separate from the final
      // "SUBMIT" click, which is the same button regardless of which
      // decision was made. DSS's exact final-button wording hasn't been
      // confirmed against the live UI yet, so it still tries known
      // candidates in order.
      const finalButtonLabel = ilmuDirStage ? 'REVIEW'
        : (ilmuExpatStage || jkleStage || stateSecretaryStage) ? 'SUBMIT'
          : dssStage ? ['ACCEPT', 'SUBMIT', 'REVIEW']
            : 'ACCEPT';

      let stageAdvanced = false;
      let employeeReviews = [];

      // Each stage logs in as a DIFFERENT officer, so it needs its own
      // fresh browser context/session rather than reusing one `page`
      // across stages — reusing the same page would still be logged in as
      // the previous officer (session cookies persist), so the "login"
      // step for the next officer would land on an already-authenticated
      // dashboard instead of a real login form.
      const stageContext = await browser.newContext();
      const stagePage = await stageContext.newPage();

      try {
        await test.step(`Stage ${stage}: ${currentOfficer.role} (${currentOfficer.email})`, async () => {
          const adminPage = await loginAndOpenApplication(stagePage, currentOfficer.email, referenceNo);
          await adminPage.screenshot({ path: `test-results/admin-${stageLabel}-application-detail.png`, fullPage: true }).catch(() => { });

          const reviewResult = await reviewAllEmployees(adminPage, {
            // ilmu_officer_expat has no Recommend/Not Recommend control at
            // all (Remarks only). JKLE and ILMU Director both DO have it.
            // DSS is assumed to also use Recommend/Not Recommend + Remarks,
            // same as the JIMS stages, until confirmed otherwise. State
            // Secretary is the final stage and uses Approve/Reject wording
            // with its own dedicated STATE_SECRETARY_DECISION env var.
            skipRecommendation: ilmuExpatStage,
            isJkle: jkleStage,
            isIlmuDir: ilmuDirStage,
            isStateSecretary: stateSecretaryStage,
            stageLabel,
          });
          employeeReviews = reviewResult.employeeReviews;

          stageAdvanced = await clickFinalAction(adminPage, { buttonLabel: finalButtonLabel, stageLabel, isJkle: jkleStage });
        });
      } finally {
        await stageContext.close().catch(() => { });
      }

      stageResults.push({
        stage,
        role: currentOfficer.role,
        email: currentOfficer.email,
        office: currentOfficer.office,
        ilmuExpatStage,
        jkleStage,
        ilmuDirStage,
        dssStage,
        stateSecretaryStage,
        finalButtonLabel,
        employeeReviews,
        advanced: stageAdvanced,
      });

      // If ADMIN_ACCEPT_REVIEW is off (or the click failed), the application
      // hasn't moved on to the next officer — stop here rather than
      // re-fetching and re-processing the same stage again.
      if (!stageAdvanced) {
        console.log(`\n⏹️ Stage ${stage} did not advance the application (ADMIN_ACCEPT_REVIEW not enabled, or click failed). Stopping chain.`);
        break;
      }

      // state_secretary is the final known stage in the hierarchy — once
      // clicked, there's nothing further to chase.
      if (stateSecretaryStage) {
        console.log('\n🏁 State Secretary reviewed — this is the final stage in the hierarchy. Stopping chain.');

        // ── Bypass the proforma waiting period ──────────────────────────
        // Once State Secretary submits, the application normally sits in a
        // proforma waiting period for over an hour. The QA Tools API has a
        // shortcut endpoint to skip straight past that wait.
        try {
          console.log(`\n⏩ Bypassing proforma waiting period for application ${applicationId}...`);
          const promoteResult = await promoteProforma(request, applicationId);
          console.log(`✅ Proforma bypassed (HTTP ${promoteResult.status}).`);
        } catch (e) {
          console.log(`⚠️ Could not bypass proforma waiting period: ${e.message}`);
        }

        // ── Log in as the employer, search for the application, and pay ──
        // Confirms the application is now approved/ready on the employer
        // side (using the reference number to locate it), then completes
        // the final payment step.
        if (referenceNo) {
          const employerContext = await browser.newContext();
          const employerPage = await employerContext.newPage();
          try {
            await test.step('Employer: search for application and complete payment', async () => {
              console.log(`\n🔑 Logging back in as the employer to search for Reference No. "${referenceNo}"...`);
              const exprtPage = await fullLoginFlow(employerPage);

              const searchInput = exprtPage.locator('input[placeholder="Search" i]').first();
              await searchInput.waitFor({ state: 'visible', timeout: 10000 });
              await searchInput.click();
              await searchInput.fill(referenceNo);
              await searchInput.press('Enter');
              console.log(`✅ Searched for "${referenceNo}" on the employer side.`);

              await exprtPage.waitForLoadState('networkidle').catch(() => { });
              await exprtPage.waitForTimeout(1500);
              await exprtPage.screenshot({ path: 'test-results/admin-employer-search-result.png', fullPage: true }).catch(() => { });

              // ── Click "PAY" on the approved application's card ──────────
              const payBtn = exprtPage.getByRole('button', { name: /^Pay$/i }).first();
              const payVisible = await payBtn.isVisible({ timeout: 8000 }).catch(() => false);

              if (!payVisible) {
                console.log('⚠️ "Pay" button not visible — application may not be approved yet, or proforma bypass did not complete in time.');
                return;
              }

              await payBtn.scrollIntoViewIfNeeded();
              await payBtn.click();
              console.log('✅ Clicked "Pay" button.');
              await exprtPage.waitForLoadState('networkidle').catch(() => { });
              await exprtPage.waitForTimeout(1500);
              await exprtPage.screenshot({ path: 'test-results/employer-payment-process.png', fullPage: true }).catch(() => { });

              // ── Check Credit Balance to decide which payment path applies ──
              // With a balance > 0: the page offers an "Apply eWallet
              // Credits" choice (ENV-controlled). With RM 0.00 balance:
              // there's no such option — it goes straight to "Proceed
              // Payment".
              let creditBalance = 0;
              try {
                const balanceText = await exprtPage.locator('text=Credit Balance').first()
                  .locator('xpath=following::*[1]').innerText({ timeout: 5000 });
                creditBalance = parseFloat(balanceText.replace(/[^\d.]/g, '')) || 0;
              } catch (e) {
                console.log(`⚠️ Could not read Credit Balance, assuming 0.00: ${e.message}`);
              }
              console.log(`💰 Credit Balance detected: RM ${creditBalance.toFixed(2)}`);

              if (creditBalance > 0) {
                // USE_EWALLET_CREDITS controls whether to apply available
                // eWallet credit toward this payment.
                const useEwalletCredits = (process.env.USE_EWALLET_CREDITS || 'false').trim().toLowerCase() === 'true';
                console.log(`🎯 Decision (USE_EWALLET_CREDITS="${useEwalletCredits}"): ${useEwalletCredits ? 'Apply eWallet Credits' : 'Skip eWallet Credits'}`);

                const applyCreditsBtn = exprtPage.getByRole('button', { name: /apply\s*ewallet\s*credits?/i }).first();
                const applyCreditsVisible = await applyCreditsBtn.isVisible({ timeout: 5000 }).catch(() => false);

                if (useEwalletCredits && applyCreditsVisible) {
                  await applyCreditsBtn.click();
                  console.log('✅ Clicked "Apply eWallet Credits".');
                  await exprtPage.waitForTimeout(1000);
                } else if (useEwalletCredits && !applyCreditsVisible) {
                  console.log('⚠️ USE_EWALLET_CREDITS=true but "Apply eWallet Credits" button not found — continuing without it.');
                } else {
                  console.log('⏭️ Skipping eWallet Credits application per ENV setting.');
                }
              } else {
                console.log('ℹ️ No Credit Balance available — proceeding directly to payment.');
              }

              // ── Click "Proceed Payment" ──────────────────────────────────
              const proceedBtn = exprtPage.getByRole('button', { name: /proceed\s*payment/i }).first();
              const proceedVisible = await proceedBtn.isVisible({ timeout: 8000 }).catch(() => false);

              if (!proceedVisible) {
                console.log('⚠️ "Proceed Payment" button not found/visible — could not complete payment.');
                return;
              }

              // "Proceed Payment" may open the FWTA Payment Portal in a new
              // tab rather than navigating the current page — watch for a
              // popup, and fall back to the current page if none opens.
              const popupPromise = exprtPage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
              await proceedBtn.scrollIntoViewIfNeeded();
              await proceedBtn.click();
              console.log('✅ Clicked "Proceed Payment".');

              const popup = await popupPromise;
              const paymentPage = popup || exprtPage;
              await paymentPage.waitForLoadState('networkidle').catch(() => { });
              await paymentPage.waitForTimeout(1500);
              console.log(`📍 Payment portal page: ${paymentPage.url()}`);
              await paymentPage.screenshot({ path: 'test-results/employer-fwta-payment-portal.png', fullPage: true }).catch(() => { });

              // ── Step 1: Switch transaction type from Business to Personal ──
              const personalTab = paymentPage.locator('button, [role="tab"], a, div')
                .filter({ hasText: /^Personal$/i })
                .first();
              const personalVisible = await personalTab.isVisible({ timeout: 8000 }).catch(() => false);
              if (personalVisible) {
                await personalTab.click();
                console.log('✅ Switched transaction type to "Personal".');
                await paymentPage.waitForTimeout(800);
              } else {
                console.log('⚠️ "Personal" transaction tab not found/visible — skipping.');
              }

              // ── Step 2: Ensure "Full Payment" checkbox is checked ───────────
              const fullPaymentCheckbox = paymentPage.getByRole('checkbox', { name: /full\s*payment/i }).first()
                .or(paymentPage.locator('label:has-text("Full Payment") input[type="checkbox"]').first());
              const fullPaymentVisible = await fullPaymentCheckbox.isVisible({ timeout: 5000 }).catch(() => false);
              if (fullPaymentVisible) {
                const alreadyChecked = await fullPaymentCheckbox.isChecked().catch(() => false);
                if (!alreadyChecked) {
                  await fullPaymentCheckbox.check({ force: true });
                  console.log('☑️ Checked "Full Payment".');
                } else {
                  console.log('ℹ️ "Full Payment" is already checked — leaving as-is.');
                }
              } else {
                console.log('⚠️ "Full Payment" checkbox not found/visible — skipping.');
              }

              // ── Step 3: Select a Bank -> FPX Simulator ──────────────────────
              // This is a native <select id="bank"> element, not a custom
              // MUI/combobox dropdown — use selectOption() directly rather
              // than click-then-pick-an-option.
              const bankSelect = paymentPage.locator('select#bank').first()
                .or(paymentPage.getByRole('combobox').filter({ has: paymentPage.locator('option:has-text("FPX Simulator")') }).first());

              const bankSelectVisible = await bankSelect.isVisible({ timeout: 8000 }).catch(() => false);
              if (bankSelectVisible) {
                await bankSelect.selectOption({ label: 'FPX Simulator' }).catch(async () => {
                  // Fallback to matching by value in case the label text changes.
                  await bankSelect.selectOption('BP-FKR01');
                });
                console.log('✅ Selected "FPX Simulator" from the bank <select>.');
                await paymentPage.waitForTimeout(500);
              } else {
                console.log('⚠️ Bank <select id="bank"> not found/visible — skipping.');
              }

              await paymentPage.screenshot({ path: 'test-results/employer-fwta-payment-form-filled.png', fullPage: true }).catch(() => { });

              // ── Step 4: Click "Pay Now" ──────────────────────────────────────
              const payNowBtn = paymentPage.getByRole('button', { name: /^Pay Now$/i }).first();
              const payNowVisible = await payNowBtn.isVisible({ timeout: 8000 }).catch(() => false);
              if (!payNowVisible) {
                console.log('⚠️ "Pay Now" button not found/visible — could not proceed with payment.');
                return;
              }
              await payNowBtn.click();
              console.log('✅ Clicked "Pay Now".');
              await paymentPage.waitForTimeout(1500);

              // ── "Confirm Payment Details" popup -> click "PROCEED" ──────────
              const confirmPopup = paymentPage.locator('text=Confirm Payment Details').first();
              const confirmPopupVisible = await confirmPopup.isVisible({ timeout: 8000 }).catch(() => false);
              if (confirmPopupVisible) {
                console.log('📋 "Confirm Payment Details" popup detected.');
                await paymentPage.screenshot({ path: 'test-results/employer-confirm-payment-popup.png', fullPage: true }).catch(() => { });

                const proceedPopupBtn = paymentPage.getByRole('button', { name: /^PROCEED$/i }).first();
                await proceedPopupBtn.waitFor({ state: 'visible', timeout: 5000 });
                await proceedPopupBtn.click();
                console.log('✅ Clicked "PROCEED" on the Confirm Payment Details popup.');
              } else {
                console.log('ℹ️ "Confirm Payment Details" popup not shown — continuing.');
              }

              await paymentPage.waitForLoadState('networkidle').catch(() => { });
              await paymentPage.waitForTimeout(2000);
              await paymentPage.screenshot({ path: 'test-results/employer-fpx-simulator.png', fullPage: true }).catch(() => { });

              // ── Step 5: Click "Payment Successful" (FPX simulator page) ────
              // This is an <a href="/simulator/.../success"> link, not a
              // <button> — getByRole('button', ...) never matched it.
              const paymentSuccessfulBtn = paymentPage.getByRole('link', { name: /payment\s*successful/i }).first()
                .or(paymentPage.locator('a:has-text("Payment Successful")').first());
              const paymentSuccessfulVisible = await paymentSuccessfulBtn.isVisible({ timeout: 10000 }).catch(() => false);
              if (paymentSuccessfulVisible) {
                await paymentSuccessfulBtn.click();
                console.log('✅ Clicked "Payment Successful".');
                await paymentPage.waitForLoadState('networkidle').catch(() => { });
                await paymentPage.waitForTimeout(2000);
                await paymentPage.screenshot({ path: 'test-results/employer-payment-successful.png', fullPage: true }).catch(() => { });
              } else {
                console.log('⚠️ "Payment Successful" link not found/visible — could not confirm payment.');
                return;
              }

              // ── Step 6: Click "Return to Application Page" ──────────────────
              // Also an <a href="https://.../redirect"> link, not a <button>.
              const returnBtn = paymentPage.getByRole('link', { name: /return\s*to\s*application\s*page/i }).first()
                .or(paymentPage.locator('a:has-text("Return to Application Page")').first());
              const returnVisible = await returnBtn.isVisible({ timeout: 10000 }).catch(() => false);
              if (returnVisible) {
                await returnBtn.click();
                console.log('✅ Clicked "Return to Application Page".');
                await paymentPage.waitForLoadState('networkidle').catch(() => { });
                await paymentPage.waitForTimeout(2000);
              } else {
                console.log('⚠️ "Return to Application Page" link not found/visible.');
                return;
              }

              // ── Step 7: Confirm redirect back to the EXPRT page ──────────────
              const finalPage = await getLatestOpenPage(paymentPage, 'EMPLOYER-FINAL');
              await finalPage.screenshot({ path: 'test-results/employer-final-exprt-page.png', fullPage: true }).catch(() => { });
              console.log(`🏁 Final page after payment flow: ${finalPage.url()}`);

              if (finalPage.url().toLowerCase().includes('expat')) {
                console.log('🎉 Confirmed redirect back to the EXPRT page — payment flow complete!');
              } else {
                console.log(`⚠️ Final page URL does not appear to contain "expat": ${finalPage.url()}`);
              }
            });
          } finally {
            await employerContext.close().catch(() => { });
          }
        } else {
          console.log('⚠️ No reference number available — skipping employer-side search/payment.');
        }

        break;
      }
    }

    // Attach the full multi-stage review history to the report for this run.
    await test.info().attach('approval-chain.json', {
      body: JSON.stringify({ applicationId, referenceNo, stages: stageResults }, null, 2),
      contentType: 'application/json',
    });

    console.log('\n📊 Approval Chain Summary:');
    console.log(JSON.stringify(stageResults.map(s => ({
      stage: s.stage, role: s.role, email: s.email, advanced: s.advanced,
    })), null, 2));
  });

});
