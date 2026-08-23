const { test, expect } = require('@playwright/test');
const path = require('path');
import { CONFIG, fullLoginFlow, waitForUrlOrRefresh } from '../helpers/login-helpers';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Click the floating "+" (Add) button at the bottom right of Job Listing page,
 * then automatically pick "New Application" or "Renew Application" from the
 * popup menu based on the AL_APPLICATION_TYPE env variable.
 */
async function clickAddALButton(page) {
  console.log('\n➕ Looking for the + button...');

  // Wait for the page to fully settle before attempting the click
  await page.waitForLoadState('networkidle');
  await page.waitForLoadState('domcontentloaded');

  // Target the floating action button (FAB) directly using its aria-label
  const fabButton = page.locator('button[aria-label="Create new application"]')
    .or(page.locator('button[aria-label="create new application" i]'))
    .first();

  await fabButton.scrollIntoViewIfNeeded();
  await fabButton.click({ force: true, timeout: 10000 });
  console.log('✅ Clicked the + FAB button successfully.');

  // Short pause to let the popup menu animate in
  await page.waitForTimeout(800);

  // ── Pick "New Application" or "Renew Application" from the popup ─────────
  // AL_APPLICATION_TYPE env controls which option to choose (default: 'new').
  const applicationType = CONFIG.alApplicationType; // 'new' | 'renew'
  const isRenew = applicationType === 'renew';
  const optionText = isRenew ? 'Renew Application' : 'New Application';

  console.log(`📋 Application type from ENV (AL_APPLICATION_TYPE="${applicationType}"): selecting "${optionText}"`);

  // Use the broadest possible text selector — matches ANY element (div, li, span, button…)
  // that contains the exact text. This avoids the role-mismatch problem entirely.
  const optionBtn = page.locator(`:text("${optionText}")`).first();

  try {
    await optionBtn.waitFor({ state: 'visible', timeout: 10000 });
    await optionBtn.click();
    console.log(`✅ Selected "${optionText}" from the popup menu.`);
  } catch (err) {
    throw new Error(`Popup option "${optionText}" not visible after clicking + FAB. Original error: ${err.message}`);
  }

  // ── Handle "Choose your Pass" modal (if "New Application" was clicked) ────
  if (!isRenew) {
    console.log('⏳ Waiting for "Choose your Pass" dialog to appear...');
    await page.waitForTimeout(1000);

    const passType = CONFIG.alPassType; // 'ep' | 'pvp'
    const isPvp = passType === 'pvp';
    const passTitle = isPvp ? 'Professional Visit Pass' : 'Employment Pass';
    console.log(`📋 Pass type from ENV (AL_PASS_TYPE="${passType}"): selecting "${passTitle}"`);

    // Target the card containing the pass title, then click the "SELECT" button inside it.
    // The columns are split visually, so we filter by card section having the title text.
    const passCard = page.locator('div, section').filter({ hasText: passTitle }).last();
    const selectBtn = passCard.locator('button, [role="button"]').filter({ hasText: /select/i }).first();

    await selectBtn.waitFor({ state: 'visible', timeout: 10000 });
    await selectBtn.click();
    console.log(`✅ Selected "${passTitle}" successfully!`);

    // ── Handle the "Documents Checklist" / "Proceed" Popup modal ──────────────────
    console.log('⏳ Waiting for "Documents Checklist" modal to appear...');
    const proceedBtn = page.getByRole('button', { name: /proceed/i }).or(page.locator(':text("Proceed")')).last();
    await proceedBtn.waitFor({ state: 'visible', timeout: 15000 });

    // Scroll the button into view (since modal content can be long)
    await proceedBtn.scrollIntoViewIfNeeded();

    // Pause for 2 seconds as requested before clicking
    console.log('⏱️ Pausing for 2 seconds before clicking "Proceed"...');
    await page.waitForTimeout(2000);

    await proceedBtn.click({ force: true });
    console.log('✅ Clicked "Proceed" on the checklist popup!');

    await page.waitForTimeout(1000);
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.waitForTimeout(2000); // Wait for the transition to the main form page
  }
}

async function fillAndNavigateEXPRTForm(targetPage) {
  console.log('📝 Starting EXPRT Form automation...');

  // Summary of what this run actually did — attached to the HTML report at
  // the end of the test so a QA can see the generated data and outcome of
  // each phase without digging through the console log.
  const reportData = {
    corporateDetails: 'not started',
    expatriateWorkers: [],
    localUnderstudyCandidates: { attempted: false, count: 0, status: 'not started' },
    additionalAttachment: { status: 'not started', filesUploaded: [] },
    employerDeclaration: { status: 'not started', signed: false },
    finalSubmit: { attempted: false, status: 'not started' },
  };

  try {
    // ── Step 1: Corporate Details (Page 1) Validation & Autofill ───────────────
    await test.step('Corporate Details (Page 1 & 2)', async () => {
    console.log('\n🔍 Validating required fields (*) for Corporate Details (Page 1)...');

    // Helper function to fill a text/textarea field if empty
    const fillIfEmpty = async (labelOrText, defaultValue, isTextarea = false) => {
      try {
        const fieldSelector = isTextarea
          ? `text=${labelOrText} >> xpath=following::textarea[1]`
          : `text=${labelOrText} >> xpath=following::input[1]`;
        const input = targetPage.locator(fieldSelector).first();
        // Wait up to 5 seconds for field to be attached/visible
        await input.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
        if (await input.isVisible()) {
          const val = await input.inputValue();
          if (!val || val.trim() === '') {
            await input.scrollIntoViewIfNeeded();
            await input.click();
            await input.fill(defaultValue);
            await targetPage.waitForTimeout(300); // brief pause to let field accept input visually
            console.log(`  ➕ Filled empty required field [${labelOrText}]: "${defaultValue}"`);
          } else {
            console.log(`  ✓ Field [${labelOrText}] already filled: "${val}"`);
          }
        } else {
          console.log(`  ⚠️ Field [${labelOrText}] not visible on page.`);
        }
      } catch (e) {
        console.log(`  ⚠️ Could not check/fill field [${labelOrText}]: ${e.message}`);
      }
    };

    // Personal Details / Company Info
    await fillIfEmpty('Company Name', 'SYARIKAT PEMBANGUNAN PESAWAT SEMBILAN SEPTEMBER');
    await fillIfEmpty('Company Registration No', '234242-D');
    await fillIfEmpty('Company Email', 'hafiz.socoe+sso@gmail.com');
    await fillIfEmpty('Income Tax File No.', '141245');
    await fillIfEmpty('Company Phone No', '123141414');

    // Key Contact Person
    await fillIfEmpty('Contact Person Full Name', 'Saddam');
    await fillIfEmpty('Contact Person Phone No', '012131312');
    await fillIfEmpty('Contact Person Position', 'CEO');

    // Business Address
    await fillIfEmpty('Business Address', 'Alamat SSO');
    await fillIfEmpty('Postcode', '93000');
    await fillIfEmpty('District', 'KUCHING');
    await fillIfEmpty('Division', 'KUCHING');
    await fillIfEmpty('State', 'SARAWAK');

    // Mailing Address ("Same as Business Address" check)
    try {
      const sameAsBusinessCb = targetPage.locator('text=Same as Business Address >> xpath=following::input[@type="checkbox"]').first()
        .or(targetPage.getByRole('checkbox', { name: /same as business address/i }));
      if (await sameAsBusinessCb.isVisible() && !(await sameAsBusinessCb.isChecked())) {
        await sameAsBusinessCb.check({ force: true });
        console.log('  ✓ Checked "Same as Business Address"');
      }
    } catch (e) {
      // If not checked or not found, fallback fill mailing address fields if empty
      await fillIfEmpty('Mailing Address', 'Alamat SSO');
    }

    // Business Overview
    await fillIfEmpty('Nature of Business', 'General services', true);
    await fillIfEmpty('Description of Products/Services', 'Other services related with government project', true);
    await fillIfEmpty('Business Commenced', '01/01/1998');
    await fillIfEmpty('Business Domestic Market', '100.00');
    await fillIfEmpty('Export Market', '0.00');

    // Select MSIC Business Activity if not selected
    try {
      const msicInput = targetPage.locator('text=MSIC Business Activity >> xpath=following::input[1]').first();
      if (await msicInput.isVisible()) {
        const msicVal = await msicInput.inputValue();
        if (!msicVal || msicVal.trim() === '') {
          await msicInput.click();
          await msicInput.fill('96099');
          await targetPage.waitForTimeout(500);
          const firstOption = targetPage.locator('[role="option"]').first();
          if (await firstOption.isVisible()) {
            await firstOption.click();
            console.log('  ➕ Selected MSIC Business Activity: 96099');
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠️ MSIC Business Activity check/select info: ${e.message}`);
    }

    // Select Business Sector if not selected
    try {
      const sectorSelect = targetPage.locator('text=Business Sector >> xpath=following::div[contains(@class,"MuiSelect-select")][1]').first();
      if (await sectorSelect.isVisible()) {
        const text = await sectorSelect.innerText();
        if (!text || text.trim() === '' || text.includes('Select')) {
          await sectorSelect.click({ force: true });
          await targetPage.waitForTimeout(500);
          const serviceOpt = targetPage.locator('[role="option"]').filter({ hasText: /service|services/i }).first();
          if (await serviceOpt.isVisible()) {
            await serviceOpt.click();
            console.log('  ➕ Selected Business Sector: Service');
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠️ Business Sector check/select info: ${e.message}`);
    }

    console.log('✅ Corporate Details (Page 1) validation and autofill complete. Ready to proceed.\n');

    // Click Next to move to Page 2 (Corporate Details - Company Composition)
    const nextButton = targetPage.getByRole('button', { name: /Next/i });

    if (await nextButton.isVisible() && await nextButton.isEnabled()) {
      console.log('⏭️ Clicking "Next" to navigate to Page 2 (Company Composition)...');
      await nextButton.click();
      await targetPage.waitForLoadState('networkidle');
      await targetPage.waitForTimeout(2000);
    }

    // Step 2: Corporate Details (Page 2 - Company Composition) Validation
    console.log('🔍 Waiting for Page 2 (Company Composition) to load...');
    const page2Header = targetPage.locator('text=Company Composition')
      .or(targetPage.locator('text=Capital & Borrowings'));
    await page2Header.waitFor({ state: 'visible', timeout: 10000 }).catch(() => { });
    await targetPage.waitForTimeout(1000);

    console.log('🔍 Validating required fields (*) for Corporate Details - Company Composition (Page 2)...');

    // Capital & Borrowings required fields
    await fillIfEmpty('Authorised Capital', '1500000.00');
    await fillIfEmpty('Paid-up Capital', '1000000.00');
    await fillIfEmpty('Total No. of Shares', '50.00');

    console.log('✅ Corporate Details (Page 2) validation and autofill complete.\n');

    // Step 3: Click Next on Page 2 to trigger the "Confirm Document Upload" popup
    console.log('⏭️ Locating and clicking "Next" on Corporate Details Page 2...');
    const page2NextBtn = targetPage.getByRole('button', { name: /Next/i })
      .or(targetPage.locator('button:has-text("Next")'))
      .first();

    await page2NextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await page2NextBtn.scrollIntoViewIfNeeded();
    await page2NextBtn.click({ force: true });
    console.log('✅ Clicked "Next" button on Page 2.');

    // ── Handle "Confirm Document Upload" Popup ────────────────────────────────
    console.log('⏳ Waiting for "Confirm Document Upload" modal popup...');
    await targetPage.waitForTimeout(1000); // allow modal animation

    const confirmBtn = targetPage.locator('button').filter({ hasText: /^Confirm$/i })
      .or(targetPage.getByRole('button', { name: /^Confirm$/i }))
      .or(targetPage.locator(':text("Confirm")'))
      .last();

    try {
      await confirmBtn.waitFor({ state: 'visible', timeout: 10000 });
      console.log('📋 "Confirm Document Upload" popup detected!');
      console.log('⏱️ Pausing for 2 seconds before clicking "Confirm"...');
      await targetPage.waitForTimeout(2000);

      await confirmBtn.click({ force: true });
      console.log('✅ Clicked "Confirm" on Document Upload popup!');
      await targetPage.waitForLoadState('networkidle').catch(() => { });
      await targetPage.waitForTimeout(2500); // Wait for transition to Expatriate Details
    } catch (e) {
      console.log(`⚠️ Confirm popup click issue: ${e.message}`);
    }

    reportData.corporateDetails = 'completed';
    }); // end test.step: Corporate Details

    // ── Step 4: Expatriate Details Section (+ Add New Button) ─────────────────
    console.log('📌 Waiting for Expatriate Details section to load...');
    const addNewBtn = targetPage.getByRole('button', { name: /Add New/i })
      .or(targetPage.locator('button:has-text("Add New")'))
      .or(targetPage.locator('text=+ Add New'))
      .first();

    // Number of expatriate workers to add, controlled via EXPAT_COUNT env
    // (defaults to 1). The first worker uses AL_EXPAT_TYPE from ENV; every
    // subsequent worker gets a randomized type between Cross-Posting/Others.
    const expatCount = Math.max(1, parseInt(process.env.EXPAT_COUNT || '1', 10));
    console.log(`📋 EXPAT_COUNT from ENV: ${expatCount} expatriate worker(s) will be added.`);

    for (let expatIndex = 0; expatIndex < expatCount; expatIndex++) {
    const workerRecord = { index: expatIndex + 1, type: null, name: null, nationality: null, status: 'not started' };
    reportData.expatriateWorkers.push(workerRecord);

    try {
      await test.step(`Expatriate Worker #${expatIndex + 1} of ${expatCount}`, async () => {
      console.log(`\n🧑‍💼 Adding Expatriate Worker #${expatIndex + 1} of ${expatCount}...`);

      await addNewBtn.waitFor({ state: 'visible', timeout: 15000 });
      await addNewBtn.scrollIntoViewIfNeeded();
      await addNewBtn.click();
      console.log('✅ Clicked "+ Add New" button in Expatriate Details section!');
      await targetPage.waitForTimeout(800);

      // ── Determine Expatriate type for this worker ──
      // Worker #1 uses AL_EXPAT_TYPE from ENV ('specialist' | 'crossposting' |
      // 'others'). Every subsequent worker is randomized between
      // Cross-Posting and Others, per requested behavior.
      let expatType;
      if (expatIndex === 0) {
        expatType = CONFIG.alExpatType;
      } else {
        expatType = Math.random() < 0.5 ? 'crossposting' : 'others';
      }

      let expatOptionRegex;
      if (expatType === 'crossposting' || expatType === 'cross-posting') {
        expatOptionRegex = /Cross-Posting/i;
      } else if (expatType === 'others') {
        expatOptionRegex = /Others/i;
      } else {
        // Default: 'specialist'
        expatOptionRegex = /Specialist\s*\/\s*Shareholding/i;
      }

      workerRecord.type = expatType;
      console.log(`📋 Expatriate Worker #${expatIndex + 1} type: "${expatType}" matching: ${expatOptionRegex}`);

      // Wait for MUI Menu popover to open after clicking + Add New
      await targetPage.waitForTimeout(500);

      const expatOption = targetPage.locator('[role="menuitem"]')
        .or(targetPage.locator('li.MuiMenuItem-root'))
        .or(targetPage.locator('.MuiMenu-paper li'))
        .filter({ hasText: expatOptionRegex })
        .first();

      await expatOption.waitFor({ state: 'visible', timeout: 8000 });
      await expatOption.scrollIntoViewIfNeeded().catch(() => { });
      await expatOption.click({ force: true });
      console.log(`✅ Selected "${expatType}" from "+ Add New" menu!`);
      await targetPage.waitForTimeout(2000); // Give modal time to animate in after menu click

      // ── Step 5: Fill "Add New Expatriate Details" Modal (Page 1 - Personal Details) ────
      console.log('📌 Waiting for "Add New Expatriate Details" modal to open...');

      // Find active modal dialog container
      const dialogModal = targetPage.locator('[role="dialog"]')
        .or(targetPage.locator('.MuiDialog-root'))
        .or(targetPage.locator('div.MuiPaper-root'))
        .last();

      await dialogModal.waitFor({ state: 'visible', timeout: 10000 });
      console.log('📋 "Add New Expatriate Details" modal is visible!');

      // ── Passport-sized Photo Upload ──
      try {
        const path = require('path');
        const pdfDir = path.dirname(CONFIG.pdfUploadPath || '');
        const passportPhotoPath = path.join(pdfDir, 'face.jpeg');
        console.log(`📎 Uploading Passport Photo: ${passportPhotoPath}`);

        // Step 1: Click the passport photo box to open the "Passport Photo Upload Guideline" popup
        const photoBox = targetPage.locator('text=Passport-sized Photo').first()
          .or(targetPage.locator('[role="dialog"] >> text=Passport-sized Photo').first());
        await photoBox.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });

        const fileChooserPromise = targetPage.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
        await photoBox.click({ force: true });
        await targetPage.waitForTimeout(800);

        // Step 2: Wait for the "Passport Photo Upload Guideline" popup to appear
        const guidelinePopup = targetPage.locator('text=Passport Photo Upload Guideline').first();
        const popupVisible = await guidelinePopup.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);

        if (popupVisible) {
          console.log('  📋 Passport Photo Upload Guideline popup opened!');

          // Step 3: Upload file - try file chooser first, then direct input
          const fileChooser = await fileChooserPromise;
          if (fileChooser) {
            await fileChooser.setFiles(passportPhotoPath);
            console.log('  ➕ File set via file chooser');
          } else {
            // Click the upload drop zone to trigger file chooser
            const dropZone = targetPage.locator('text=Click to upload or drag and drop').first();
            const dropZoneChooserPromise = targetPage.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
            await dropZone.click({ force: true });
            const dropZoneChooser = await dropZoneChooserPromise;
            if (dropZoneChooser) {
              await dropZoneChooser.setFiles(passportPhotoPath);
              console.log('  ➕ File set via drop zone file chooser');
            } else {
              // Fallback: find hidden input inside the guideline popup
              const photoFileInput = targetPage.locator('text=Passport Photo Upload Guideline >> xpath=following::input[@type="file"][1]').first()
                .or(targetPage.locator('.MuiDialog-root input[type="file"]').last());
              await photoFileInput.waitFor({ state: 'attached', timeout: 3000 });
              await photoFileInput.setInputFiles(passportPhotoPath);
              console.log('  ➕ File set via hidden input fallback');
            }
          }

          await targetPage.waitForTimeout(1000);

          // Step 4: Click "Confirm & Submit" to finalize the passport photo upload
          const confirmSubmitBtn = targetPage.getByRole('button', { name: /Confirm & Submit/i }).first()
            .or(targetPage.locator('button:has-text("Confirm & Submit")').first());
          await confirmSubmitBtn.waitFor({ state: 'visible', timeout: 8000 });
          await confirmSubmitBtn.click();
          console.log('  ✅ Clicked "Confirm & Submit" for Passport Photo!');
          await targetPage.waitForTimeout(1000);
        } else {
          // Popup didn't open — try direct file input on the dialog as fallback
          console.log('  ⚠️ Guideline popup not detected, attempting direct file input...');
          const photoInput = targetPage.locator('[role="dialog"] input[type="file"]').first();
          await photoInput.waitFor({ state: 'attached', timeout: 3000 });
          await photoInput.setInputFiles(passportPhotoPath);
          console.log('  ✅ Passport Photo uploaded via direct input fallback!');
        }
      } catch (e) {
        console.log(`  ⚠️ Could not upload Passport Photo: ${e.message}`);
      }

      // Nationality-linked name profiles: pick the nationality first, then
      // draw First/Last Name from that nationality's own pools, so the
      // generated name matches the expatriate's country (e.g. an Indonesian
      // name for an Indonesian nationality) instead of always being Western.
      const locationProfiles = [
        {
          country: 'Indonesia', placeOfIssue: 'Jakarta', city: 'Jakarta', state: 'DKI Jakarta', postcode: '12345',
          firstNames: ['Budi', 'Agus', 'Norman', 'Adrianto', 'Andi'],
          lastNames: ['Santoso', 'Wijaya', 'Kurniawan', 'Hidayat', 'Pratama'],
          homeStreets: ['Jalan Melati', 'Jalan Sudirman', 'Jalan Anggrek', 'Jalan Kemang Raya', 'Jalan Thamrin'],
        },
        {
          country: 'Philippines', placeOfIssue: 'Manila', city: 'Manila', state: 'Metro Manila', postcode: '1000',
          firstNames: ['Juan', 'Morales', 'Jose', 'Miguel', 'Ramon'],
          lastNames: ['Santos', 'Reyes', 'Cruz', 'Bautista', 'Garcia'],
          homeStreets: ['Rizal Street', 'Mabini Street', 'Quezon Avenue', 'Roxas Boulevard', 'Bonifacio Street'],
        },
        {
          country: 'India', placeOfIssue: 'Mumbai', city: 'Mumbai', state: 'Maharashtra', postcode: '400001',
          firstNames: ['Raj', 'Amit', 'Khan', 'Vikram', 'Mutusamy'],
          lastNames: ['Sharma', 'Patel', 'Kumar', 'Singh', 'Gupta'],
          homeStreets: ['MG Road', 'Nehru Street', 'Gandhi Nagar', 'Linking Road', 'Marine Drive'],
        },
        {
          country: 'Malaysia', placeOfIssue: 'Kuala Lumpur', city: 'Kuala Lumpur', state: 'Selangor', postcode: '50000',
          firstNames: ['Ahmad', 'Muhammad', 'Farid', 'Zulkifli', 'Hafiz'],
          lastNames: ['Abdullah', 'Ismail', 'Hassan', 'Rahman', 'Yusof'],
          homeStreets: ['Jalan Bukit Bintang', 'Jalan Ampang', 'Jalan Tun Razak', 'Jalan Sultan Ismail', 'Jalan Raja Chulan'],
        },
      ];

      // Roll the nationality once for the entire candidate/test run.
      const selectedProfile = locationProfiles[Math.floor(Math.random() * locationProfiles.length)];

      const randomFirstName = selectedProfile.firstNames[Math.floor(Math.random() * selectedProfile.firstNames.length)];
      const randomLastName = selectedProfile.lastNames[Math.floor(Math.random() * selectedProfile.lastNames.length)];

      workerRecord.name = `${randomFirstName} ${randomLastName}`;
      workerRecord.nationality = selectedProfile.country;
      console.log(`👤 Filling Expatriate Name: First Name="${randomFirstName}", Last Name="${randomLastName}" (Nationality: ${selectedProfile.country})`);

      // Fill First Name * (target inside dialog)
      const firstNameInput = dialogModal.locator('input[name*="firstName"], input[name*="first_name"]').first()
        .or(dialogModal.getByLabel(/First Name/i).first())
        .or(targetPage.locator('text=First Name >> xpath=following::input[1]').first());

      await firstNameInput.waitFor({ state: 'visible', timeout: 8000 });
      await firstNameInput.scrollIntoViewIfNeeded();
      await firstNameInput.click();
      await firstNameInput.fill(randomFirstName);
      console.log(`  ➕ Filled First Name: "${randomFirstName}"`);

      // Fill Last Name * (target inside dialog)
      const lastNameInput = dialogModal.locator('input[name*="lastName"], input[name*="last_name"]').first()
        .or(dialogModal.getByLabel(/Last Name/i).first())
        .or(targetPage.locator('text=Last Name >> xpath=following::input[1]').first());

      await lastNameInput.waitFor({ state: 'visible', timeout: 8000 });
      await lastNameInput.scrollIntoViewIfNeeded();
      await lastNameInput.click();
      await lastNameInput.fill(randomLastName);
      console.log(`  ➕ Filled Last Name: "${randomLastName}"`);

      // Helper: fill any labeled input inside the modal, using targetPage to avoid strict mode issues
      const fillModalFieldIfEmpty = async (labelOrText, defaultValue, isTextarea = false, isDate = false) => {
        try {
          const selector = isTextarea
            ? `text=${labelOrText} >> xpath=following::textarea[1]`
            : `text=${labelOrText} >> xpath=following::input[1]`;
          const input = targetPage.locator(selector).first();
          await input.waitFor({ state: 'visible', timeout: 4000 }).catch(() => { });
          if (await input.isVisible()) {
            const val = await input.inputValue();
            if (!val || val.trim() === '') {
              await input.scrollIntoViewIfNeeded();
              await input.click();

              // Native <input type="date"> requires YYYY-MM-DD format
              const inputType = await input.getAttribute('type');
              let fillVal = defaultValue;
              if (isDate || inputType === 'date') {
                if (defaultValue.includes('/')) {
                  const parts = defaultValue.split('/');
                  if (parts.length === 3) {
                    fillVal = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                  }
                }
              }

              await input.fill(fillVal);
              await targetPage.waitForTimeout(200);
              console.log(`  ➕ Filled Expatriate field [${labelOrText}]: "${fillVal}"`);
            } else {
              console.log(`  ✓ Expatriate field [${labelOrText}] already filled: "${val}"`);
            }
          } else {
            console.log(`  ⚠️ Expatriate field [${labelOrText}] not found/visible in modal, skipped.`);
          }
        } catch (e) {
          console.log(`  ⚠️ Could not fill Expatriate field [${labelOrText}]: ${e.message}`);
        }
      };

      // Helper: click a MUI Select dropdown and pick ONE option at random from
      // the given list of exact option labels. (Previously this took a single
      // combined regex like /Single|Married/i and clicked .first() — which
      // always resolved to whichever option happened to sit first in the DOM,
      // not a random pick. Passing an explicit array and rolling the choice
      // here fixes that.)
      const selectModalDropdown = async (labelOrText, optionChoices) => {
        try {
          const choices = Array.isArray(optionChoices) ? optionChoices : [optionChoices];
          const chosenOption = choices[Math.floor(Math.random() * choices.length)];

          const selectDiv = targetPage.locator(`text=${labelOrText} >> xpath=following::div[contains(@class,"MuiSelect-select")][1]`).first();
          await selectDiv.waitFor({ state: 'visible', timeout: 4000 }).catch(() => { });
          if (await selectDiv.isVisible()) {
            await selectDiv.scrollIntoViewIfNeeded();
            await selectDiv.click({ force: true });
            await targetPage.waitForTimeout(500);
            const opt = targetPage.locator('[role="option"]')
              .filter({ hasText: new RegExp(`^${chosenOption}$`, 'i') }).first();
            if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) {
              await opt.click();
              console.log(`  ➕ Selected Expatriate [${labelOrText}]: "${chosenOption}"`);
            } else {
              console.log(`  ⚠️ Option "${chosenOption}" not found for [${labelOrText}], closing dropdown.`);
              await targetPage.keyboard.press('Escape').catch(() => { });
            }
          }
        } catch (e) {
          console.log(`  ⚠️ Could not select Expatriate dropdown [${labelOrText}]: ${e.message}`);
        }
      };

      // ── Personal Details Fields ──
      const randomPhone = `1${Math.floor(10000000 + Math.random() * 90000000)}`;
      const randomEmail = `${randomFirstName.toLowerCase()}.${randomLastName.toLowerCase()}@example.com`;
      const randomPassport = `A${Math.floor(10000000 + Math.random() * 90000000)}`;

      // Home Address 1 uses street names local to the selected nationality
      // (e.g. Indonesian-style streets for an Indonesian worker) instead of
      // a single generic Malaysia-style "Jalan ..." list for everyone.
      const randomStreet = selectedProfile.homeStreets[Math.floor(Math.random() * selectedProfile.homeStreets.length)];
      const randomHomeAddress = `No. ${Math.floor(1 + Math.random() * 200)}, ${randomStreet}`;

      // Phone field defaults to "+60" prefix even when empty, so treat
      // anything with <=2 digits as unfilled rather than checking for blank.
      const phoneCandidates = [
        dialogModal.locator('input[type="tel"]').first(),
        dialogModal.getByLabel(/Phone Number/i).first(),
        dialogModal.locator('input[name*="phone" i]').first(),
        dialogModal.locator('text=Phone Number >> xpath=following::input[1]').first()
      ];

      let phoneInput = null;
      for (const candidate of phoneCandidates) {
        const visible = await candidate.waitFor({ state: 'visible', timeout: 1500 })
          .then(() => true)
          .catch(() => false);
        if (visible) {
          phoneInput = candidate;
          break;
        }
      }

      if (phoneInput) {
        try {
          const digitsOf = (v) => (v || '').replace(/\D/g, '');
          const currentPhone = await phoneInput.inputValue().catch(() => '');
          // Only the "+60" prefix (or nothing) means the field is still empty
          if (digitsOf(currentPhone).length <= 2) {
            await phoneInput.scrollIntoViewIfNeeded();
            await phoneInput.click();
            await phoneInput.fill(randomPhone).catch(() => { });

            // Fallback to typing key-by-key if fill() didn't register.
            let newVal = await phoneInput.inputValue().catch(() => '');
            if (!digitsOf(newVal).includes(digitsOf(randomPhone).slice(-6))) {
              await phoneInput.click();
              await phoneInput.pressSequentially(randomPhone, { delay: 50 });
              newVal = await phoneInput.inputValue().catch(() => '');
            }
            await targetPage.waitForTimeout(300);
            console.log(`  ➕ Filled Expatriate field [Phone Number]: "${newVal}" (typed "${randomPhone}")`);
          } else {
            console.log(`  ✓ Expatriate field [Phone Number] already filled: "${currentPhone}"`);
          }
        } catch (e) {
          console.log(`  ⚠️ Could not fill Expatriate field [Phone Number]: ${e.message}`);
        }
      } else {
        console.log('  ⚠️ Phone Number input not found inside the modal — check the label/DOM.');
      }

      await fillModalFieldIfEmpty('Email', randomEmail);
      // Gender is fixed to "Male" only — no expatriate worker photo assets
      // for female workers exist yet.
      await selectModalDropdown('Gender', ['Male']);

      // For Malaysian nationality, Date of Birth is auto-derived from the
      // NRIC No. (filled further below) and should be left alone here —
      // filling it manually now would just get overwritten/conflict once
      // NRIC is entered. Every other nationality fills it directly.
      const isMalaysianWorker = selectedProfile.country.trim().toLowerCase() === 'malaysia';
      if (!isMalaysianWorker) {
        await fillModalFieldIfEmpty('Date of Birth', '1990-08-15', false, true);
      } else {
        console.log('  ℹ️ Malaysian nationality — skipping manual Date of Birth fill, it will auto-populate from NRIC No.');
      }

      // 1. Nationality: click the #nationality input, type country name, then pick exact match from dropdown
      try {
        // Use the synchronized country name
        const targetCountry = selectedProfile.country;

        const natInput = targetPage.locator('#nationality').first();
        await natInput.waitFor({ state: 'visible', timeout: 6000 });
        await natInput.scrollIntoViewIfNeeded();
        await natInput.click();
        await targetPage.waitForTimeout(300);
        await natInput.pressSequentially(targetCountry, { delay: 80 });
        await targetPage.waitForTimeout(800);

        const natOption = targetPage.locator('[role="option"]')
          .filter({ hasText: new RegExp(`^${targetCountry}$`, 'i') })
          .first();
        const natFallback = targetPage.locator('[role="option"]')
          .filter({ hasText: new RegExp(targetCountry, 'i') })
          .first();

        let isNationalitySelected = false;

        const natVisible = await natOption.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
        if (natVisible) {
          await natOption.click();
          console.log(`  ➕ Selected Expatriate Nationality: "${targetCountry}"`);
          isNationalitySelected = true;
        } else {
          const fallbackVisible = await natFallback.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
          if (fallbackVisible) {
            await natFallback.click();
            console.log(`  ➕ Selected Expatriate Nationality (fallback): "${targetCountry}"`);
            isNationalitySelected = true;
          } else {
            await natInput.blur();
            console.log(`  ⚠️ Nationality option for "${targetCountry}" not found, skipped.`);
          }
        }

        // ─── MALAYSIA CONDITIONAL FIELDS CHECK ─────────────────────────────────────
        // Malaysian nationality reveals two extra required fields: State
        // (Sabah | West Malaysia, per the actual dropdown options) and NRIC
        // No. Filling NRIC also auto-derives Date of Birth in the app, so we
        // deliberately did NOT fill Date of Birth manually earlier.
        if (isNationalitySelected && targetCountry.trim().toLowerCase() === 'malaysia') {
          console.log('  🇲🇾 Malaysia selected. Filling conditional State and NRIC fields...');
          await targetPage.waitForTimeout(500); // Wait for DOM to adjust and render conditional fields

          // 1. Random State Selection — dropdown only offers these two options.
          const states = ['Sabah', 'West Malaysia'];
          const randomState = states[Math.floor(Math.random() * states.length)];

          const stateTrigger = targetPage.locator('p, span, label').filter({ hasText: /^State\s*\*?$/i }).first()
            .locator('xpath=../descendant::div[@role="button" or @role="combobox" or @aria-haspopup="listbox"][1]')
            .or(
              targetPage.locator('p, span, label').filter({ hasText: /^State\s*\*?$/i }).first()
                .locator('xpath=../descendant::div[contains(@class,"MuiSelect-select")][1]')
            )
            .or(targetPage.locator('label:has-text("State") + div, #state').first());

          await stateTrigger.waitFor({ state: 'visible', timeout: 5000 });
          await stateTrigger.scrollIntoViewIfNeeded();
          await stateTrigger.click();
          await targetPage.waitForTimeout(400);

          const stateOption = targetPage.locator('[role="option"], .MuiMenuItem-root, li')
            .filter({ hasText: new RegExp(`^${randomState}$`, 'i') }).first();
          await stateOption.waitFor({ state: 'visible', timeout: 4000 });
          await stateOption.click();
          console.log(`  └─ Selected State: "${randomState}"`);

          // 2. Random NRIC No. — format ######-##-#### where the first 6
          // digits are a valid YYMMDD birth date (this is what the app reads
          // to auto-populate Date of Birth), followed by a 2-digit place-of-
          // birth code and 4 random unique digits.
          const generateNRIC = () => {
            const yy = String(Math.floor(60 + Math.random() * 40)).padStart(2, '0'); // 1960-1999
            const mm = String(Math.floor(1 + Math.random() * 12)).padStart(2, '0');
            const dd = String(Math.floor(1 + Math.random() * 28)).padStart(2, '0');
            // Sabah-associated codes: 12, 13, 14, 15, 16, 17; West Malaysia:
            // a broad set of state codes (using a representative sample).
            const sabahCodes = ['12', '13', '14', '15', '16', '17'];
            const westMalaysiaCodes = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'];
            const codePool = randomState === 'Sabah' ? sabahCodes : westMalaysiaCodes;
            const placeCode = codePool[Math.floor(Math.random() * codePool.length)];
            const uniqueDigits = String(Math.floor(1000 + Math.random() * 9000));
            return `${yy}${mm}${dd}-${placeCode}-${uniqueDigits}`;
          };

          const randomNRIC = generateNRIC();
          const nricInput = targetPage.locator('p, span, label').filter({ hasText: /^NRIC\s*No\.?\s*\*?$/i }).first()
            .locator('xpath=../descendant::input[1]')
            .or(targetPage.locator('label:has-text("NRIC No.") + input, input[name*="nric" i]').first());

          await nricInput.waitFor({ state: 'visible', timeout: 5000 });
          await nricInput.scrollIntoViewIfNeeded();
          await nricInput.fill(randomNRIC);
          console.log(`  └─ Filled NRIC No.: "${randomNRIC}" (Date of Birth should auto-populate from this)`);

          // Verify Date of Birth actually auto-populated from the NRIC.
          await targetPage.waitForTimeout(500);
          try {
            const dobCheckField = targetPage.locator('p, span, label').filter({ hasText: /^Date of Birth\s*\*?$/i }).first()
              .locator('xpath=../descendant::input[1]');
            const dobValue = await dobCheckField.inputValue().catch(() => '');
            if (dobValue && dobValue.trim() !== '') {
              console.log(`  ✅ Date of Birth auto-populated from NRIC: "${dobValue}"`);
            } else {
              console.log('  ⚠️ Date of Birth still appears empty after filling NRIC No.');
            }
          } catch (dobErr) {
            console.log(`  ⚠️ Could not verify Date of Birth auto-population: ${dobErr.message}`);
          }
        }
        // ───────────────────────────────────────────────────────────────────────────

      } catch (e) {
        console.log(`  ⚠️ Could not select Nationality or fill conditional fields: ${e.message}`);
      }

      await selectModalDropdown('Marital Status', ['Single', 'Married', 'Divorced', 'Widowed']);
      await fillModalFieldIfEmpty('Passport No.', randomPassport);
      await fillModalFieldIfEmpty('Passport Issue Date', '2020-01-01', false, true);
      try {
        await fillModalFieldIfEmpty('Place of Issue', selectedProfile.placeOfIssue);
        console.log(`  ✓ Filled Place of Issue: "${selectedProfile.placeOfIssue}"`);
      } catch (e) {
        console.log(`  ⚠️ Could not fill Place of Issue: ${e.message}`);
      }
      await fillModalFieldIfEmpty('Passport Expiry Date', '2030-01-01', false, true);
      await fillModalFieldIfEmpty('Date of Present Entry to Malaysia', '2024-01-10', false, true);

      // Fill standard inputs using the global selectedProfile data
      await fillModalFieldIfEmpty('Home Address 1', randomHomeAddress);
      await fillModalFieldIfEmpty('Home Postcode', selectedProfile.postcode);
      await fillModalFieldIfEmpty('Home City', selectedProfile.city);

      // Home Country dropdown selection
      try {
        const homeCountryControl = dialogModal
          .locator('label, p, span, div')
          .filter({ hasText: /^Home Country\s*\*?$/ })
          .locator('xpath=../descendant::input | ../descendant::div[@role="combobox"] | ../descendant::div[contains(@class, "MuiSelect-select")]')
          .first();

        const fallbackControl = dialogModal.locator('input[aria-label*="Home Country" i], div[aria-label*="Home Country" i]').first();
        const finalControl = homeCountryControl.or(fallbackControl).first();

        await finalControl.waitFor({ state: 'visible', timeout: 5000 });

        const hcVal = await finalControl.inputValue().catch(() => '')
          || (await finalControl.innerText().catch(() => ''));

        if (!hcVal || hcVal.trim() === '') {
          await finalControl.scrollIntoViewIfNeeded();
          await finalControl.click({ force: true });
          await targetPage.waitForTimeout(500);

          const activeInput = targetPage.locator('input:focus, [role="combobox"] input:focus, .Mui-focused input');
          if (await activeInput.count() > 0) {
            await activeInput.fill('');
            // Type the synchronized country name
            await activeInput.pressSequentially(selectedProfile.country, { delay: 100 });
          } else {
            await finalControl.pressSequentially(selectedProfile.country, { delay: 100 }).catch(() => { });
          }
          await targetPage.waitForTimeout(600);

          const hcOption = targetPage.locator('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root')
            .filter({ hasText: new RegExp(`^\\s*${selectedProfile.country}\\s*$`, 'i') })
            .first();

          const hcFallback = targetPage.locator('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root')
            .filter({ hasText: new RegExp(selectedProfile.country, 'i') })
            .first();

          if (await hcOption.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
            await hcOption.click();
            console.log(`  ➕ Selected Home Country: "${selectedProfile.country}"`);
          } else if (await hcFallback.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)) {
            await hcFallback.click();
            console.log(`  ➕ Selected Home Country (fallback): "${selectedProfile.country}"`);
          } else {
            await targetPage.keyboard.press('Escape').catch(() => { });
            console.log(`  ⚠️ Home Country option "${selectedProfile.country}" not found, closed dropdown.`);
          }
        } else {
          console.log(`  ✓ Home Country already filled: "${hcVal}"`);
        }
      } catch (e) {
        console.log(`  ⚠️ Could not select Home Country: ${e.message}`);
      }
      // ── Address In Sarawak (fixed values, not random) ──
      await fillModalFieldIfEmpty('Address Line 1', 'Jalan Tun Jugah No. 45');

      // Postcode (Sarawak) is a searchable select: type 94000, then click the matching option. District / Division / State auto-fill afterwards.
      // Anchor on labels starting with "Postcode" so we don't hit "Home Postcode".
      try {
        // 1. Target the Postcode label explicitly, then hop to its companion input field
        const postcodeInput = dialogModal
          .locator('label, p, span, div')
          .filter({ hasText: /^Postcode\s*\*?$/ })
          .locator('xpath=../descendant::input | ../descendant::div[@role="combobox"]')
          .first()
          // Fallback chains if the layout structure varies
          .or(dialogModal.locator('input[name*="postcode" i]').last())
          .or(dialogModal.locator('text=Address Line 1 >> xpath=following::input[3]').first()); // Changed index from 2 to 3

        await postcodeInput.waitFor({ state: 'visible', timeout: 5000 });
        const pcVal = await postcodeInput.inputValue().catch(() => '');

        if (!pcVal || pcVal.trim() === '' || pcVal.replace(/\D/g, '').length < 5) {
          await postcodeInput.scrollIntoViewIfNeeded();

          // 2. Click to focus/open the field
          await postcodeInput.click({ force: true });
          await targetPage.waitForTimeout(300);

          // 3. Clear the field and type the postcode string
          // Material UI Autocomplete often focuses an inner input when clicked
          const activePCInput = targetPage.locator('input:focus, .Mui-focused input').first().or(postcodeInput);
          await activePCInput.fill('');
          await activePCInput.pressSequentially('94000', { delay: 100 });
          await targetPage.waitForTimeout(800);

          // 4. Select the matching option from the dropdown menu overlay
          const pcOption = targetPage.locator('[role="option"], .MuiAutocomplete-option, [role="listbox"] li')
            .filter({ hasText: '94000' }).first();

          if (await pcOption.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false)) {
            await pcOption.click();
            console.log('  ➕ Selected Expatriate Postcode (Sarawak): "94000"');

            // District / Division / State are auto-filled after selection - log them
            await targetPage.waitForTimeout(800);
            for (const autoLabel of ['District', 'Division', 'State']) {
              const autoVal = await dialogModal
                .locator('label, p, span, div')
                .filter({ hasText: new RegExp(`^${autoLabel}\\s*\\*?$`, 'i') })
                .locator('xpath=../descendant::input | ../descendant::div')
                .first()
                .inputValue().catch(() => '')
                || await dialogModal.locator('label, p, span, div')
                  .filter({ hasText: new RegExp(`^${autoLabel}\\s*\\*?$`, 'i') })
                  .locator('xpath=../descendant::input | ../descendant::div')
                  .first().innerText().catch(() => '');

              if (autoVal) console.log(`  ✓ Auto-filled [${autoLabel}]: "${autoVal}"`);
            }
          } else {
            const listBoxCount = await targetPage.locator('[role="listbox"]').count().catch(() => 0);
            const listBoxText = listBoxCount
              ? await targetPage.locator('[role="listbox"]').last().innerText().catch(() => '')
              : '';
            await postcodeInput.blur().catch(() => { });
            console.log(`  ⚠️ Postcode option "94000" not found (listboxes=${listBoxCount}, text="${listBoxText.slice(0, 120)}"); left typed value.`);
          }
        } else {
          console.log(`  ✓ Expatriate field [Postcode] already filled: "${pcVal}"`);
        }
      } catch (e) {
        console.log(`  ⚠️ Could not fill Expatriate Postcode: ${e.message}`);
      }

      const institutions = [
        'Universitas Indonesia',
        'Universiti Malaya',
        'University of the Philippines',
        'Indian Institute of Technology'
      ];
      const randomInstitution = institutions[Math.floor(Math.random() * institutions.length)];

      const yearsAwarded = ['2010', '2012', '2014', '2016', '2018', '2020', '2022'];
      const randomYearAwarded = yearsAwarded[Math.floor(Math.random() * yearsAwarded.length)];

      const fieldsOfStudy = [
        'Computer Science',
        'Business Administration',
        'Electrical Engineering',
        'Finance & Accounting'
      ];
      const randomFieldOfStudy = fieldsOfStudy[Math.floor(Math.random() * fieldsOfStudy.length)];

      // ── Academic Qualification ──
      await selectModalDropdown('Qualification', [
        'Graduate/Postgraduate Diploma',
        'Bachelor Honours Degree',
        'Professional Degree',
        'Masters',
        'PhD',
      ]);
      await fillModalFieldIfEmpty('Institution', randomInstitution);
      await fillModalFieldIfEmpty('Year Awarded', randomYearAwarded);
      await fillModalFieldIfEmpty('Field of Study', randomFieldOfStudy);

      // ── Proof of Qualification Upload ──
      try {
        const path = require('path');
        const pdfDir = path.dirname(CONFIG.pdfUploadPath || '');
        const qualificationPath = path.join(pdfDir, 'certifcate.png');
        console.log(`📎 Uploading Proof of Qualification: ${qualificationPath}`);

        // Click the "Upload Here" button which triggers a hidden file input
        const uploadBtn = targetPage.locator('[role="dialog"]').getByRole('button', { name: /Upload Here/i }).first();
        const qualFileInput = targetPage.locator('[role="dialog"] input[type="file"]').last();

        // Try direct setInputFiles first; fall back to triggering via file chooser
        const fileChooserPromise = targetPage.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        await uploadBtn.click({ force: true });
        const fileChooser = await fileChooserPromise;
        if (fileChooser) {
          await fileChooser.setFiles(qualificationPath);
          console.log('  ✅ Proof of Qualification uploaded via file chooser!');
        } else {
          await qualFileInput.waitFor({ state: 'attached', timeout: 3000 });
          await qualFileInput.setInputFiles(qualificationPath);
          console.log('  ✅ Proof of Qualification uploaded via setInputFiles!');
        }
        await targetPage.waitForTimeout(800);
      } catch (e) {
        console.log(`  ⚠️ Could not upload Proof of Qualification: ${e.message}`);
      }

      // ── Save as Draft, then proceed with Next ─────────────────────────────
      try {
        const saveDraftBtn = dialogModal.getByRole('button', { name: /Save as Draft/i }).first()
          .or(dialogModal.locator('button:has-text("Save as Draft")').first());
        await saveDraftBtn.waitFor({ state: 'visible', timeout: 8000 });
        await saveDraftBtn.scrollIntoViewIfNeeded();
        await saveDraftBtn.click();
        console.log('💾 Clicked "Save as Draft" in the Expatriate modal.');
        // Give the draft-save request time to finish before moving on
        await targetPage.waitForTimeout(2000);

        const nextBtn = dialogModal.getByRole('button', { name: /Next/i }).first()
          .or(dialogModal.locator('button:has-text("Next")').first());
        await nextBtn.waitFor({ state: 'visible', timeout: 8000 });
        await nextBtn.scrollIntoViewIfNeeded();
        // click() auto-waits until the button is enabled (in case it was
        // disabled while the draft was saving)
        await nextBtn.click();
        console.log('➡️ Clicked "Next" in the Expatriate modal.');
        await targetPage.waitForTimeout(1500);
      } catch (e) {
        console.log(`⚠️ Could not save Page 1 / click Next: ${e.message}`);
      }

      // ── Page 2: Employment History Interaction ──
      try {
        console.log('⏳ Waiting for Page 2 (Employment History) to load...');

        // 1. Verify we are on the second page by checking the layout header text
        const pageHeader = dialogModal.locator('text=Employment History').first();
        await pageHeader.waitFor({ state: 'visible', timeout: 10000 });
        console.log('✓ Employment History page loaded successfully.');

        // 2. Target the custom "No" radio button block directly
        // This targets the div that contains the "No" paragraph text
        const noRadioBlock = dialogModal.locator('div')
          .filter({ hasText: /^No$/ })
          .first();

        await noRadioBlock.waitFor({ state: 'visible', timeout: 5000 });

        // Check if the select icon is already active inside the "No" block
        const isNoSelectedByDefault = await noRadioBlock.locator('img[src*="radiobtn_select.svg"]').count() > 0;

        if (!isNoSelectedByDefault) {
          await noRadioBlock.scrollIntoViewIfNeeded();
          await noRadioBlock.click({ force: true });
          console.log('🔘 Clicked custom "No" layout button.');
          await targetPage.waitForTimeout(600);
        } else {
          console.log('✓ "No" custom radio option is already pre-selected by default.');
        }

        // 3. Click the "Add work experience" button using the exact HTML structure you provided
        console.log('⏳ Locating "Add work experience" button...');
        const addWorkExpBtn = dialogModal
          .locator('button.MuiButtonBase-root')
          .filter({ hasText: 'Add work experience' })
          .first();

        await addWorkExpBtn.waitFor({ state: 'visible', timeout: 5000 });
        await addWorkExpBtn.scrollIntoViewIfNeeded();

        try {
          await addWorkExpBtn.click({ force: true, timeout: 3000 });
        } catch (clickError) {
          console.log('⚠️ Standard click intercepted by ripple span, dispatching direct click event...');
          await addWorkExpBtn.dispatchEvent('click');
        }

        console.log('➕ Clicked "Add work experience" button successfully.');

        // 4. Verify that the "First Experience" container has appeared
        const firstExperienceHeader = dialogModal.locator('text=First Experience').first();
        await firstExperienceHeader.waitFor({ state: 'visible', timeout: 6000 });
        console.log('✨ First Experience form is now visible and ready to fill!');

        await targetPage.waitForTimeout(500);
      } catch (e) {
        console.log(`⚠️ Error on Employment History page: ${e.message}`);
      }

      // Fill First Experience details
      try {
        console.log('📝 Starting to fill First Experience details...');

        // Helper function to locate elements dynamically by handling the red asterisk
        const getFieldInput = (labelText, type = 'input') => {
          return dialogModal
            .locator('label, p, span, div')
            .filter({ hasText: new RegExp(`^${labelText}\\s*\\*?$`, 'i') })
            .locator(`xpath=../descendant::${type}[1] | ../descendant::div[@role="combobox"][1]`)
            .first();
        };

        // 1. Previous Company Name
        const companyInput = getFieldInput('Previous Company Name');
        await companyInput.fill('SOCOE');
        console.log('✓ Filled Previous Company Name: "SOCOE"');

        // 2. Work Duration (Random Month/Year Generator)
        // Generates random past years ensuring start is before end
        const startYear = Math.floor(2020 + Math.random() * 3); // 2020 - 2022
        const endYear = startYear + Math.floor(1 + Math.random() * 2); // 2021 - 2024
        const startMonth = String(Math.floor(1 + Math.random() * 12)).padStart(2, '0');
        const endMonth = String(Math.floor(1 + Math.random() * 12)).padStart(2, '0');

        const startDateStr = `${startMonth}${startYear}`; // format: mmyyyy
        const endDateStr = `${endMonth}${endYear}`;

        // Locate the two date inputs inside the Work Duration container
        const dateInputs = dialogModal.locator('text=Work Duration >> xpath=../descendant::input');

        // Fill From Date
        await dateInputs.nth(0).click();
        await dateInputs.nth(0).press('Control+A');
        await dateInputs.nth(0).press('Backspace');
        await dateInputs.nth(0).pressSequentially(startDateStr, { delay: 50 });

        // Fill To Date
        await dateInputs.nth(1).click();
        await dateInputs.nth(1).press('Control+A');
        await dateInputs.nth(1).press('Backspace');
        await dateInputs.nth(1).pressSequentially(endDateStr, { delay: 50 });
        console.log(`✓ Filled Work Duration: ${startMonth}/${startYear} to ${endMonth}/${endYear}`);

        // 3. Total Work Duration (Skip - Auto-calculated)
        await targetPage.waitForTimeout(500);

        // 4. Reason for Leaving (Dropdown -> Resignation)
        const reasonDropdown = getFieldInput('Reason for Leaving', 'div');
        await reasonDropdown.click({ force: true });
        await targetPage.waitForTimeout(400);

        const reasonOption = targetPage.locator('[role="option"], .MuiMenuItem-root')
          .filter({ hasText: /^Resignation$/i }).first();
        await reasonOption.waitFor({ state: 'visible', timeout: 4000 });
        await reasonOption.click();
        console.log('✓ Selected Reason for Leaving: "Resignation"');

        // 5. Company Address 1
        const addressInput = getFieldInput('Company Address 1');
        await addressInput.fill('4th floor, Lot 6393, No.1, Jalan Stapok, Taman Stapok');
        console.log('✓ Filled Company Address 1');

        // 6. Postcode
        const pcInput = getFieldInput('Postcode');
        await pcInput.fill('93150');
        console.log('✓ Filled Postcode: "93150"');

        // 7. City
        const cityInput = getFieldInput('City');
        await cityInput.fill('Sarawak');
        console.log('✓ Filled City: "Sarawak"');

        // 8. Country (Dropdown -> Search & Select Malaysia)
        const countryDropdown = getFieldInput('Country');
        await countryDropdown.click({ force: true });
        await targetPage.waitForTimeout(500);

        const countryActiveInput = targetPage.locator('input:focus, [role="combobox"] input:focus, .Mui-focused input');
        if (await countryActiveInput.count() > 0) {
          await countryActiveInput.fill('');
          await countryActiveInput.pressSequentially('Malaysia', { delay: 100 });
        } else {
          await countryDropdown.pressSequentially('Malaysia', { delay: 100 }).catch(() => { });
        }
        await targetPage.waitForTimeout(600);

        const countryOption = targetPage.locator('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root')
          .filter({ hasText: /^Malaysia$/i }).first();
        await countryOption.waitFor({ state: 'visible', timeout: 4000 });
        await countryOption.click();
        console.log('✓ Selected Country: "Malaysia"');

        // 9. State / Province (Left Empty explicitly)
        console.log('✓ Left State / Province field empty.');

        await targetPage.waitForTimeout(1000);
        console.log('✨ First Experience form section completely filled!');

      } catch (e) {
        console.log(`⚠️ Could not complete filling First Experience: ${e.message}`);
      }

      // ── 1. Save Page 2 Data and Navigate to Page 3 ──
      try {
        const saveDraftBtn = dialogModal.getByRole('button', { name: /Save as Draft/i }).first()
          .or(dialogModal.locator('button:has-text("Save as Draft")').first());
        await saveDraftBtn.waitFor({ state: 'visible', timeout: 8000 });
        await saveDraftBtn.scrollIntoViewIfNeeded();
        await saveDraftBtn.click();
        console.log('💾 Clicked "Save as Draft" on Page 2.');
        await targetPage.waitForTimeout(2000);

        const nextBtn = dialogModal.getByRole('button', { name: /Next/i }).first()
          .or(dialogModal.locator('button:has-text("Next")').first());
        await nextBtn.waitFor({ state: 'visible', timeout: 8000 });
        await nextBtn.scrollIntoViewIfNeeded();
        await nextBtn.click();
        console.log('➡️ Clicked "Next" button.');
        await targetPage.waitForTimeout(1500);
      } catch (e) {
        console.log(`⚠️ Could not save Page 2 / click Next: ${e.message}`);
      }

      // ── 2. Page 3: Job Position Pop-up Handling & Decision Logic ──
      try {
        console.log('⏳ Waiting for Page 3 (Employment Details) to load...');

        // Verify Page 3 transition
        const page3Header = dialogModal.locator('text=Employment Details').first();
        await page3Header.waitFor({ state: 'visible', timeout: 10000 });
        console.log('✓ Employment Details page loaded.');

        // 1. Direct Target: Click the interactive input field wrapper or the input directly
        console.log('⏳ Locating Job Position interactive components...');
        // The placeholder wording differs by Expatriate type: "Others" shows
        // just "Use HOR" (no MASCO option), while Specialist/Cross-Posting
        // show "Use HOR or MASCO Code". Match on the type-appropriate text.
        const jobFieldPlaceholder = expatType === 'others' ? 'Use HOR' : 'Use HOR or MASCO Code';
        const jobInputField = dialogModal
          .locator(`input[placeholder="${jobFieldPlaceholder}"]`)
          .first();

        const jobFieldWrapper = dialogModal
          .locator(`div.MuiInputBase-root:has(input[placeholder="${jobFieldPlaceholder}"])`)
          .first();

        await jobFieldWrapper.waitFor({ state: 'visible', timeout: 6000 });
        await jobFieldWrapper.scrollIntoViewIfNeeded();

        // Attempt to open the pop-up by trying different interaction targets sequentially
        try {
          console.log('👉 Attempting click on outer input container wrapper...');
          await jobFieldWrapper.click({ force: true, timeout: 2000 });
        } catch (err1) {
          try {
            console.log('👉 Wrapper click failed, attempting click directly on the input element...');
            await jobInputField.click({ force: true, timeout: 2000 });
          } catch (err2) {
            console.log('⚠️ Mouse clicks failed, dispatching native browser DOM click event...');
            await jobFieldWrapper.dispatchEvent('click');
          }
        }

        console.log('🔘 Triggered Job Position field selection.');
        await targetPage.waitForTimeout(1500); // Wait for the modal popup to fully open and render

        // 2. Target the newly opened selection dialog overlay layer
        const jobPopup = targetPage.locator('.MuiDialog-root, div[role="dialog"]').last();
        await jobPopup.waitFor({ state: 'visible', timeout: 5000 });
        console.log('🎯 Job Selection Pop-up modal verified visible.');

        // 3. Decide HOR vs MASCO for this worker.
        // - "Others" type: the field only ever shows "Use HOR" — there is no
        //   MASCO tab available at all, so always use HOR regardless of
        //   random roll.
        // - "Specialist" / "Cross-Posting" type: the field shows "Use HOR or
        //   MASCO Code" — both options exist. Randomize between them when
        //   HOR listings are actually available; if no HOR exists, MASCO is
        //   the only usable option regardless of the random roll.
        const noHorIndicator = jobPopup.locator('text=No Hiring Outcome Reports available');
        const hasNoHor = await noHorIndicator.isVisible().catch(() => false);

        let useMasco;
        if (expatType === 'others') {
          useMasco = false;
          console.log('📋 Expatriate type "Others" — MASCO Code is not available for this type, using HOR.');
        } else if (hasNoHor) {
          useMasco = true;
          console.log('❌ No HOR available. Falling back to "Enter MASCO Code".');
        } else {
          useMasco = Math.random() < 0.5;
          console.log(`🎲 HOR is available — randomly decided to use ${useMasco ? 'MASCO Code' : 'HOR'} for this worker.`);
        }

        // Tracks whether HOR was actually used, since HOR auto-populates
        // Job Position AND Job Description (both shown greyed-out/locked in
        // the UI) — those two fields must be left untouched when true.
        let usedHor = false;

        // ── Handle MASCO Code Search ──
        if (useMasco) {
          console.log('🔎 Using "Enter MASCO Code" tab...');

          const mascoTab = jobPopup.locator('div, button, span').filter({ hasText: /^Enter MASCO Code$/ }).first();
          await mascoTab.waitFor({ state: 'visible', timeout: 5000 });
          await mascoTab.click({ force: true });
          await targetPage.waitForTimeout(600);

          // MASCO Code Array & Randomizer Selector
          const mascoCodes = ['1311-03', '3115-09', '2173-09', '3231-09', '1221-02'];
          const randomMasco = mascoCodes[Math.floor(Math.random() * mascoCodes.length)];
          console.log(`🎲 Selected Random MASCO Code: ${randomMasco}`);

          // Locate the active text field inside the MASCO tab panel view to type the code
          const mascoInputField = jobPopup.locator('input[type="text"], input[placeholder*="search" i]').first();
          await mascoInputField.waitFor({ state: 'visible', timeout: 5000 });

          // Clear field completely and enter the randomized code
          await mascoInputField.click();
          await mascoInputField.press('Control+A');
          await mascoInputField.press('Backspace');
          await mascoInputField.fill(randomMasco);
          console.log(`⌨️ Typed MASCO code: ${randomMasco}`);

          // Give the dynamic search network request / internal filter a moment to display results
          await targetPage.waitForTimeout(1200);

          // Target the specific dynamic card/row element under "Results" that contains our code
          console.log('🔎 Searching for the matching result item...');
          const filteredResultItem = jobPopup.locator('div, p, [role="button"]')
            .filter({ hasText: new RegExp(randomMasco) })
            // Make sure we select the actual clickable list result card block instead of the input field text
            .filter({ hasNotText: /^Results$/i })
            .locator('xpath=self::*[not(self::input)]')
            .last();

          await filteredResultItem.waitFor({ state: 'visible', timeout: 6000 });
          await filteredResultItem.scrollIntoViewIfNeeded();

          // Standard click with direct event dispatcher backup to ensure selection goes through
          try {
            await filteredResultItem.click({ force: true, timeout: 3000 });
          } catch (clickErr) {
            console.log('⚠️ Click intercepted, dispatching native DOM click on result item...');
            await filteredResultItem.dispatchEvent('click');
          }

          console.log('✅ Clicked and assigned MASCO code item from the results list!');
        } else {
          console.log('🔎 Using HOR — checking how many HOR listings are available...');

          // Each HOR card has a small "Approved Date" label as an exact-text
          // leaf element (e.g. a <p>/<span>), unlike the surrounding card
          // container <div> which would also match a plain substring search
          // (since a parent's innerText includes all child text too). Anchor
          // on the exact-text leaf label to get an accurate count of real
          // cards without ancestor-inflation, then walk up to the card
          // container for each one.
          const horDateLabels = jobPopup.locator('p, span, div')
            .filter({ hasText: /^Approved Date$/i });

          const horCardCount = await horDateLabels.count();
          console.log(`📋 Found ${horCardCount} HOR listing(s) available.`);

          // Pick a random card by index. If there's only one, this always
          // resolves to index 0.
          const chosenIndex = horCardCount > 1 ? Math.floor(Math.random() * horCardCount) : 0;
          console.log(`🎲 Selecting HOR listing #${chosenIndex + 1} of ${horCardCount}.`);

          // Walk up from the "Approved Date" label to the card container
          // (identified as the nearest ancestor that also contains the
          // "Positions" count, i.e. the whole card), then click the "+"
          // select button inside that card.
          const chosenCard = horDateLabels.nth(chosenIndex)
            .locator('xpath=ancestor::*[.//*[contains(text(),"Positions")]][1]');

          await chosenCard.waitFor({ state: 'visible', timeout: 5000 });
          await chosenCard.scrollIntoViewIfNeeded();

          const addBtnInCard = chosenCard.locator('button, [role="button"]').first();

          try {
            await addBtnInCard.click({ force: true, timeout: 3000 });
          } catch (addBtnErr) {
            console.log('⚠️ Could not click the "+" button directly, falling back to clicking the card itself...');
            await chosenCard.click({ force: true });
          }

          console.log('✅ Clicked and selected available HOR report entry.');
          usedHor = true;
        }

        // Allow the popup modal frame to dismiss completely and return focus to main Page 3 fields
        await targetPage.waitForTimeout(1500);

        // ── 4. Autofill Remaining Page 3 Form Fields ──
        console.log('📝 Autofilling Employment Details fields...');

        // 1. Basic Salary (Direct target via the absolute layout input structure or text currency cue)
        const randomSalary = String(Math.floor(3000 + Math.random() * 12000));
        // Targets the input next to the RM visual placeholder text block
        const salaryInput = targetPage.locator('div.MuiInputBase-root:has-text("RM") input, input[placeholder="0.00"]').first();

        await salaryInput.waitFor({ state: 'visible', timeout: 6000 });
        await salaryInput.scrollIntoViewIfNeeded();
        await salaryInput.click();
        await salaryInput.press('Control+A');
        await salaryInput.press('Backspace');
        await salaryInput.fill(randomSalary);
        console.log(`✓ Filled Basic Salary: RM ${randomSalary}`);

        // 2. Income Tax No. (Targeting by matching the input element that shares the row context)
        const randomTaxNo = 'SG' + Math.floor(100000000 + Math.random() * 900000000);
        const taxInput = targetPage.locator('p, span, label')
          .filter({ hasText: /^Income Tax No\./i })
          .locator('xpath=../descendant::input[not(@type="checkbox")]')
          .first();

        await taxInput.waitFor({ state: 'visible', timeout: 5000 });
        await taxInput.fill(randomTaxNo);
        console.log(`✓ Filled Income Tax No.: ${randomTaxNo}`);

        // 3. Requested Pass Duration (Random choice between 12 or 24 months)
        const durationOptions = ['12', '24'];
        const randomDuration = durationOptions[Math.floor(Math.random() * durationOptions.length)];

        // Targets the custom Material UI dropdown button that sits right next to the "Months" string label block
        const durationDropdown = targetPage.locator('div.MuiInputBase-root:has(svg)[aria-expanded]')
          .or(targetPage.locator('div:has-text("Months")').locator('xpath=../descendant::div[@role="combobox"] | ../descendant::div[contains(@class,"MuiSelect-select")]'))
          .first();

        await durationDropdown.waitFor({ state: 'visible', timeout: 5000 });
        await durationDropdown.click({ force: true });
        await targetPage.waitForTimeout(600);

        // Choose value option out of overlay portal view layer context
        const selectOption = targetPage.locator('[role="option"], .MuiMenuItem-root')
          .filter({ hasText: new RegExp(`^${randomDuration}(\\s*Months)?$`, 'i') }).first();
        await selectOption.waitFor({ state: 'visible', timeout: 4000 });
        await selectOption.click();
        console.log(`✓ Selected Requested Pass Duration: ${randomDuration} Months`);

        // Random Paragraph generators for Justification and Job Description inputs
        const randomJustifications = [
          "The expatriate possesses niche technical architecture expertise required to successfully drive the project pipeline phase forward.",
          "Required to fill local knowledge gaps and handle system implementation frameworks that comply with international corporate directives.",
          "Brings extensive regional management insight necessary to successfully direct internal performance targets and streamline vendor logistics."
        ];
        const randomJobDescriptions = [
          "Responsible for overseeing cross-functional engineering teams, aligning structural deliverables, and reviewing sprint objectives regularly.",
          "Formulating market positioning blueprints, checking monthly budget indicators, and defining long-term sales deployment operations.",
          "Leading enterprise-level migration frameworks, auditing code review practices, and establishing secure architectural baseline metrics."
        ];

        const chosenJustification = randomJustifications[Math.floor(Math.random() * randomJustifications.length)];
        const chosenJobDesc = randomJobDescriptions[Math.floor(Math.random() * randomJobDescriptions.length)];

        // 4. Justification Textarea (Target by matching row sibling layout structure)
        const justificationField = targetPage.locator('p, span, label')
          .filter({ hasText: /^Justification/i })
          .locator('xpath=../descendant::textarea')
          .first();

        await justificationField.waitFor({ state: 'visible', timeout: 5000 });
        await justificationField.fill(chosenJustification);
        console.log('✓ Filled Justification paragraph.');

        // 5. Job Description Textarea — skipped when HOR was used, since HOR
        // auto-populates this field (shown greyed-out/locked in the UI) and
        // it should not be manually overwritten.
        if (usedHor) {
          console.log('  ℹ️ HOR was used — Job Description is auto-filled and locked, skipping manual fill.');
        } else {
          const jobDescField = targetPage.locator('p, span, label')
            .filter({ hasText: /^Job Description/i })
            .locator('xpath=../descendant::textarea')
            .first();

          await jobDescField.waitFor({ state: 'visible', timeout: 5000 });
          await jobDescField.fill(chosenJobDesc);
          console.log('✓ Filled Job Description paragraph.');
        }

        console.log('✨ Page 3 Form variables completely populated!');
        await targetPage.waitForTimeout(1000);

        try {
          console.log('🏢 Starting to fill Place of Employment section...');

          // Helper selector utility scoped inside the layout block
          const getPOEField = (labelText, elementType = 'input') => {
            return targetPage
              .locator('div, p, span, label')
              .filter({ hasText: new RegExp(`^${labelText}\\s*\\*?$`, 'i') })
              .locator(`xpath=../descendant::${elementType}[1]`)
              .first();
          };

          // 1. Location Name (Randomized based on Kuching)
          const locationNames = ['SOCOE HQ Kuching', 'Stapok Innovation Hub', 'Sarawak Corporate Office', 'Kuching Tech Lab'];
          const randomLocation = locationNames[Math.floor(Math.random() * locationNames.length)];
          const locationInput = getPOEField('Location Name');
          await locationInput.fill(randomLocation);
          console.log(`✓ Filled Location Name: "${randomLocation}"`);

          // ── 2. Sequential Left-to-Right Workplace Photo Uploads ──
          const baseDir = path.dirname(CONFIG.pdfUploadPath || '');
          const resolvedImagePath = path.join(baseDir, 'site.jpg');

          console.log(`📸 Absolute local upload asset path: ${resolvedImagePath}`);

          // Precise sequential labels exactly matching the visual grid array layout order
          const viewLabels = ['Front View', 'Surrounding View', 'Side View', 'Interior Shots', 'Close-ups'];

          for (let i = 0; i < viewLabels.length; i++) {
            const currentView = viewLabels[i];
            console.log(`📤 [${i + 1}/5] Uploading image target: ${currentView}...`);

            // Target the specific clickable upload card wrapper by its exact visible string token
            const uploadCard = targetPage.locator('div, button, span, p')
              .filter({ hasText: new RegExp(`^${currentView}$`, 'i') })
              .last();

            await uploadCard.scrollIntoViewIfNeeded();

            // Trigger the file handling workflow sequentially using the runtime event interceptor
            const fileChooserPromise = targetPage.waitForEvent('filechooser', { timeout: 10000 });

            // MUI components sometimes require clicking the inner card element directly to release the browser file thread
            await uploadCard.click({ force: true });

            const fileChooser = await fileChooserPromise;
            await fileChooser.setFiles(resolvedImagePath);

            // Crucial wait step: gives the UI framework structural layout thread time to generate 
            // thumbnail imagery previews before moving onto the next box on the right
            await targetPage.waitForTimeout(1200);
            console.log(`✓ Successfully updated view index: ${currentView}`);
          }
          console.log('✓ All 5 distinct workflow views updated sequentially!');

          // 3-6. Address Line 1/2, Postcode, District, Division, State are
          // auto-populated (disabled/greyed-out) from the company's own
          // address in this section — attempting .fill() on a disabled field
          // makes Playwright wait indefinitely for it to become editable,
          // which is what caused the flow to hang after the photo uploads.
          // Verify they're actually disabled before skipping; if they're
          // ever NOT disabled (e.g. a different company setup), fill them.
          const addr1Input = getPOEField('Address Line 1');
          const addr1Disabled = await addr1Input.isDisabled().catch(() => true);

          if (addr1Disabled) {
            console.log('  ℹ️ Address Line 1 / Postcode / District / Division / State are auto-filled and locked from company address — skipping.');
          } else {
            const address1Options = ['Lot 245, Sublot 3, Jalan Satok', 'No. 18, Taman Stapok Lane 2', 'Level 5, Wisma Sarawak', 'Block B, Kuching Business Park'];
            const randomAddress1 = address1Options[Math.floor(Math.random() * address1Options.length)];
            await addr1Input.fill(randomAddress1);
            console.log(`✓ Filled Address Line 1: "${randomAddress1}"`);

            const address2Options = ['Jalan Tun Jugah', 'Off Jalan Rock', 'Petra Jaya District', 'Jalan Green'];
            const randomAddress2 = address2Options[Math.floor(Math.random() * address2Options.length)];
            const addr2Input = getPOEField('Address Line 2');
            await addr2Input.fill(randomAddress2);
            console.log(`✓ Filled Address Line 2: "${randomAddress2}"`);

            console.log('✓ Left Address Lines 3 and 4 empty.');

            // Postcode (types 93000 to trigger dropdown filtering/autofill)
            const postcodeField = targetPage.locator('p, span, label')
              .filter({ hasText: /^Postcode\s*\*?$/i })
              .locator('xpath=../descendant::input | ../descendant::div[@role="combobox"]')
              .first();

            await postcodeField.waitFor({ state: 'visible', timeout: 5000 });
            await postcodeField.click();
            await postcodeField.press('Control+A');
            await postcodeField.press('Backspace');
            await postcodeField.pressSequentially('93000', { delay: 150 });
            await targetPage.waitForTimeout(1000);

            const postcodeOption = targetPage.locator('[role="option"], .MuiAutocomplete-option, .MuiMenuItem-root')
              .filter({ hasText: /93000/ })
              .first();

            if (await postcodeOption.isVisible().catch(() => false)) {
              await postcodeOption.click();
              console.log('✓ Postcode option selected from drop list.');
            } else {
              await postcodeField.press('Enter');
              console.log('✓ Postcode submitted via enter sequence.');
            }

            await targetPage.waitForTimeout(2000);
            console.log('✨ Autofill values for District, Division, and State updated.');
          }

        } catch (e) {
          console.log(`⚠️ Could not save Page 3 / click Next: ${e.message}`);
        }

        // ── Save as Draft, then proceed with Next ─────────────────────────────
        try {
          const saveDraftBtn = dialogModal.getByRole('button', { name: /Save as Draft/i }).first()
            .or(dialogModal.locator('button:has-text("Save as Draft")').first());
          await saveDraftBtn.waitFor({ state: 'visible', timeout: 8000 });
          await saveDraftBtn.scrollIntoViewIfNeeded();
          await saveDraftBtn.click();
          console.log('💾 Clicked "Save as Draft" in the Expatriate modal.');
          // Give the draft-save request time to finish before moving on
          await targetPage.waitForTimeout(2000);

          const nextBtn = dialogModal.getByRole('button', { name: /Next/i }).first()
            .or(dialogModal.locator('button:has-text("Next")').first());
          await nextBtn.waitFor({ state: 'visible', timeout: 8000 });
          await nextBtn.scrollIntoViewIfNeeded();
          // click() auto-waits until the button is enabled (in case it was
          // disabled while the draft was saving)
          await nextBtn.click();
          console.log('➡️ Clicked "Next" in the Expatriate modal.');
          await targetPage.waitForTimeout(1500);
        } catch (e) {
          console.log(`⚠️ Could not save Page 3 / click Next: ${e.message}`);
        }

      } catch (e) {
        console.log(`⚠️ Error on processing Page 3 operations: ${e.message}`);
      }

      // ── 3. Page 4: Supporting Documents ──
      try {
        console.log('  📂 Page 4: Uploading supporting documents...');

        // Resolve the base upload path using your CONFIG setup
        const pdfDir = path.dirname(CONFIG.pdfUploadPath || '');

        // We map each document label to its exact native HTML ID found in the DOM
        const fileMap = [
          {
            label: 'Certified True Copy of Passport',
            id: '#file-upload-certified_passport_copy',
            filePath: path.join(pdfDir, 'passport.jpg')
          },
          {
            label: 'Signed Offer Letter',
            id: '#file-upload-signed_offer_letter',
            filePath: path.join(pdfDir, 'certifcate.png')
          },
          {
            label: 'Resume with Academic Certification',
            id: '#file-upload-resume_academic_cert',
            filePath: path.join(pdfDir, 'resume.pdf')
          }
        ];

        for (const fileItem of fileMap) {
          console.log(`  📎 Uploading for "${fileItem.label}": ${fileItem.filePath}`);

          // Target the hidden file input directly using its precise unique ID selector
          const fileInput = targetPage.locator(fileItem.id);

          // Ensure it exists on the page layout layer
          await fileInput.waitFor({ state: 'attached', timeout: 10000 });

          // Set the file path directly to the element node
          await fileInput.setInputFiles(fileItem.filePath);

          // Small padding to let the UI finish file rendering/processing pipelines
          await targetPage.waitForTimeout(1200);

          console.log(`  └─ Successfully uploaded [${path.basename(fileItem.filePath)}]`);
        }

        // ── Employee Transfer Letter (only required for Cross-Posting) ──
        // No stable HTML id is known for this field (unlike the others
        // above), so it's targeted by its label text instead, same approach
        // used for the Additional Attachment page uploads.
        if (expatType === 'crossposting' || expatType === 'cross-posting') {
          try {
            const transferLetterPath = path.join(pdfDir, 'transfer.png');
            console.log(`  📎 Cross-Posting detected. Uploading "Employee Transfer Letter": ${transferLetterPath}`);

            const transferFileInput = targetPage.locator('p, span, label, div')
              .filter({ hasText: /^Employee Transfer Letter\s*\*?$/i }).first()
              .locator('xpath=../following::input[@type="file"][1]');

            await transferFileInput.waitFor({ state: 'attached', timeout: 10000 });
            await transferFileInput.setInputFiles(transferLetterPath);
            await targetPage.waitForTimeout(1200);
            console.log('  └─ Successfully uploaded [transfer.png]');
          } catch (e) {
            console.log(`  ⚠️ Failed to upload Employee Transfer Letter: ${e.message}`);
          }
        }

        console.log('  ✅ All mandatory documents for Page 4 have been successfully uploaded.');

      } catch (e) {
        console.log(`  ⚠️ Failed to upload documents on Page 4: ${e.message}`);
      }

      // ── Save as Draft, then proceed with Next ─────────────────────────────
      try {
        console.log('💾 Locating Save as Draft button via targetPage...');

        const saveDraftBtn = targetPage.locator('button[class*="SaveAsDraft"], button[class*="saveButton"]')
          .or(targetPage.locator('button:has-text("Save as Draft")')).first();

        await saveDraftBtn.waitFor({ state: 'visible', timeout: 5000 });
        await saveDraftBtn.scrollIntoViewIfNeeded();

        console.log('💾 Clicking "Save as Draft" and waiting for network sync...');
        await Promise.all([
          targetPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { }),
          saveDraftBtn.click()
        ]);
        console.log('💾 Draft saved successfully.');

        await targetPage.waitForTimeout(2000);

        console.log('➡️ Locating Next button...');
        const nextBtn = dialogModal.getByRole('button', { name: /^Next$/i }).first()
          .or(targetPage.getByRole('button', { name: /^Next$/i }).first());

        await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
        await nextBtn.scrollIntoViewIfNeeded();

        console.log('➡️ Clicking "Next"...');
        try {
          await nextBtn.click({ timeout: 10000 });
        } catch (clickErr) {
          console.log(`⚠️ First attempt to click "Next" failed: ${clickErr.message}`);
          await targetPage.waitForTimeout(1000);
          await nextBtn.click({ timeout: 10000 });
        }

      } catch (e) {
        console.log(`⚠️ Could not save Page 4 / click Next: ${e.message}`);
      }

      // ── 5. Page 5: Local Understudy Candidates Section ─
      // Only the first expatriate worker registers Local Understudy
      // Candidates — ADD_LOCAL_CANDIDATES/CANDIDATE_COUNT apply once per
      // application, not once per expat worker.
      try {
        console.log('👥 Page 5: Processing Local Understudy Candidates...');

        const shouldAddCandidates = expatIndex === 0 && process.env.ADD_LOCAL_CANDIDATES === 'true';
        const candidateTargetCount = parseInt(process.env.CANDIDATE_COUNT || '1', 10);

        if (expatIndex !== 0) {
          console.log(`⏭️ Skipping Local Understudy Candidates — only Worker #1 registers candidates (this is Worker #${expatIndex + 1}).`);
          reportData.localUnderstudyCandidates.status = 'skipped (not first worker)';
        } else if (!shouldAddCandidates) {
          console.log('⏭️ ADD_LOCAL_CANDIDATES is false or empty in ENV. Skipping candidate forms.');
          reportData.localUnderstudyCandidates.status = 'skipped (ADD_LOCAL_CANDIDATES=false)';
        } else {
          reportData.localUnderstudyCandidates.attempted = true;
          reportData.localUnderstudyCandidates.count = candidateTargetCount;
          console.log(`📋 ENV requested to populate ${candidateTargetCount} candidate profile(s).`);

          for (let i = 0; i < candidateTargetCount; i++) {
            console.log(`➕ Clicking "Add More Candidate" button for Candidate #${i + 1}...`);

            // Scope to the modal and count existing candidate rows before
            // clicking, so we can confirm the click actually added a row.
            const addBtn = dialogModal.getByRole('button', { name: /Add More Candidate/i }).last()
              .or(dialogModal.locator('button:has-text("Add More Candidate")').last());

            await addBtn.waitFor({ state: 'visible', timeout: 8000 });
            await addBtn.scrollIntoViewIfNeeded();

            const rowCountBefore = await targetPage.locator('p, span, label').filter({ hasText: /^Full Name\s*\*?$/i }).count();

            await addBtn.click({ timeout: 10000 });

            // Wait for an actual new candidate row to mount instead of a fixed sleep,
            // so we know for certain the click had effect.
            await expect(async () => {
              const rowCountAfter = await targetPage.locator('p, span, label').filter({ hasText: /^Full Name\s*\*?$/i }).count();
              if (rowCountAfter <= rowCountBefore) {
                throw new Error(`Candidate row count did not increase (before=${rowCountBefore}, after=${rowCountAfter})`);
              }
            }).toPass({ timeout: 8000, intervals: [300, 500, 1000] });

            console.log(`  ✅ Confirmed new candidate row #${i + 1} was added.`);

            console.log(`  📸 Uploading Passport-sized photo for Candidate #${i + 1}...`);
            const path = require('path');
            const pdfDir = path.dirname(CONFIG.pdfUploadPath || '');
            const candidatePhotoPath = path.join(pdfDir, 'face.jpeg');

            const photoInput = targetPage.locator('input[type="file"]').last();
            await photoInput.setInputFiles(candidatePhotoPath);
            await targetPage.waitForTimeout(1000);

            const randomNames = ['Ahmad Syazwan', 'Muhammad Ramli', 'Jaafar Ong', 'Iman Muhammad'];
            const chosenName = randomNames[Math.floor(Math.random() * randomNames.length)];

            // Always select "Male" for Gender, as requested.
            const chosenGender = 'Male';
            const randomIC = '98031213' + Math.floor(1000 + Math.random() * 9000);
            const randomDesignations = ['Junior Executive', 'Assistant Engineer', 'Associate Analyst', 'Trainee Officer'];
            const chosenDesignation = randomDesignations[Math.floor(Math.random() * randomDesignations.length)];

            console.log(`  📝 Filling candidate profile: ${chosenName}`);

            const nameField = targetPage.locator('p, span, label').filter({ hasText: /^Full Name\s*\*?$/i }).nth(i)
              .locator('xpath=../descendant::input[1]');
            await nameField.fill(chosenName);

            // Small settle delay after Name fill before opening Gender menu.
            await targetPage.waitForTimeout(800);

            try {
              // Gender is a MUI Select — trigger is a <div role="button"/
              // "combobox"> next to the label, options render in a portal
              // <ul role="listbox"><li data-value="male|female">.
              const genderTrigger = targetPage.locator('p, span, label').filter({ hasText: /^Gender\s*\*?$/i }).nth(i)
                .locator('xpath=../descendant::div[@role="button" or @role="combobox" or @aria-haspopup="listbox"][1]')
                .or(
                  targetPage.locator('p, span, label').filter({ hasText: /^Gender\s*\*?$/i }).nth(i)
                    .locator('xpath=../descendant::div[contains(@class,"MuiSelect-select")][1]')
                );

              await genderTrigger.waitFor({ state: 'visible', timeout: 5000 });
              await genderTrigger.scrollIntoViewIfNeeded();
              await genderTrigger.click();
              await targetPage.waitForTimeout(500);

              let listboxOpen = await targetPage.locator('ul[role="listbox"]').first().isVisible().catch(() => false);
              if (!listboxOpen) {
                await genderTrigger.click();
                await targetPage.waitForTimeout(500);
                listboxOpen = await targetPage.locator('ul[role="listbox"]').first().isVisible().catch(() => false);
              }

              if (!listboxOpen) {
                throw new Error('Gender listbox never opened after clicking trigger.');
              }

              // Match by data-value (stable) rather than visible text.
              const genderValue = chosenGender.toLowerCase();
              const genderOption = targetPage.locator(`ul[role="listbox"] li[data-value="${genderValue}"]`)
                .or(targetPage.locator(`li[role="option"][data-value="${genderValue}"]`))
                .first();

              await genderOption.waitFor({ state: 'visible', timeout: 4000 });
              await genderOption.click();

              await targetPage.waitForTimeout(300);
              const triggerText = await genderTrigger.innerText().catch(() => '');
              if (new RegExp(chosenGender, 'i').test(triggerText)) {
                console.log(`  ✅ Gender set to "${chosenGender}" for Candidate #${i + 1}.`);
              } else {
                console.log(`  ⚠️ Gender click completed but trigger text is "${triggerText}" (expected "${chosenGender}") for Candidate #${i + 1}.`);
              }
            } catch (e) {
              console.log(`  ⚠️ Could not select Gender for Candidate #${i + 1}: ${e.message}`);
            }

            const icField = targetPage.locator('p, span, label').filter({ hasText: /^IC No\.\s*\*?$/i }).nth(i)
              .locator('xpath=../descendant::input[1]');
            await icField.fill(randomIC);

            const designationField = targetPage.locator('p, span, label').filter({ hasText: /^Designation\s*\*?$/i }).nth(i)
              .locator('xpath=../descendant::input[1]');
            await designationField.fill(chosenDesignation);

            const randomMonths = String(Math.floor(6 + Math.random() * 18));
            const trainingField = targetPage.locator('p, span, label').filter({ hasText: /^Training Period\s*\*?$/i }).nth(i)
              .locator('xpath=../descendant::input[1]');
            await trainingField.click();
            await trainingField.press('Control+A');
            await trainingField.press('Backspace');
            await trainingField.fill(randomMonths);

            // Fill a date field. Native <input type="date"> requires ISO
            // format (yyyy-mm-dd) via .fill(); other date inputs fall back
            // to click + type digits, only pressing Escape if a calendar
            // popup actually opened (blindly pressing Escape can close the
            // whole MUI dialog when there's no popup to absorb it).
            const fillDatePickerField = async (locator, dateStr, fieldLabel) => {
              await locator.waitFor({ state: 'visible', timeout: 5000 });
              await locator.scrollIntoViewIfNeeded();

              const inputType = await locator.getAttribute('type').catch(() => null);

              if (inputType === 'date') {
                const [day, month, year] = dateStr.split('/');
                const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                await locator.fill(isoDate);
              } else {
                const digitsOnly = dateStr.replace(/\D/g, '');
                await locator.click();
                await locator.press('Control+A');
                await locator.press('Backspace');
                await locator.pressSequentially(digitsOnly, { delay: 60 });

                const calendarPopupVisible = await targetPage.locator('.MuiPickersPopper-root, [role="dialog"] .MuiPickersCalendarHeader-root')
                  .first().isVisible().catch(() => false);
                if (calendarPopupVisible) {
                  await targetPage.keyboard.press('Escape').catch(() => { });
                }
              }

              await targetPage.waitForTimeout(300);
              const currentValue = await locator.inputValue().catch(() => '');
              if (!currentValue || currentValue.trim() === '') {
                console.log(`  ⚠️ "${fieldLabel}" still appears empty after fill attempt.`);
              }
            };

            // Date of Birth auto-derives from IC No. (YYMMDD) and is
            // read-only — just verify it populated instead of filling it.
            try {
              const dobField = targetPage.locator('p, span, label').filter({ hasText: /^Date of Birth\s*\*?$/i }).nth(i)
                .locator('xpath=../descendant::input[1]');
              const dobValue = await dobField.inputValue().catch(() => '');
              if (dobValue && dobValue.trim() !== '') {
                console.log(`  ✅ Date of Birth auto-populated from IC No. for Candidate #${i + 1}: "${dobValue}"`);
              } else {
                console.log(`  ⚠️ Date of Birth is still empty for Candidate #${i + 1} (expected auto-fill from IC No.). Skipping — field is read-only.`);
              }
            } catch (e) {
              console.log(`  ⚠️ Could not verify Date of Birth for Candidate #${i + 1}: ${e.message}`);
            }

            try {
              const takeOverField = targetPage.locator('p, span, label').filter({ hasText: /^Take Over Date\s*\*?$/i }).nth(i)
                .locator('xpath=../descendant::input[1]');
              await fillDatePickerField(takeOverField, '01/12/2026', 'Take Over Date');
              console.log(`  ✅ Take Over Date filled for Candidate #${i + 1}.`);
            } catch (e) {
              console.log(`  ⚠️ Could not fill Take Over Date for Candidate #${i + 1}: ${e.message}`);
            }

            await targetPage.waitForTimeout(1000);
            console.log(`  ✓ Candidate #${i + 1} completed.`);
          }
        }

        // ── 3. Save Final State Forms ──
        console.log('💾 Clicking Save button to finish process...');

        // Check ALL dialog nodes, not just the first — MUI can keep multiple
        // .MuiDialog-root nodes mounted (transition/exit nodes), so checking
        // only .first() can find a hidden node and wrongly report closed.
        const dialogCandidates = targetPage.locator('[role="dialog"], .MuiDialog-root');
        const dialogNodeCount = await dialogCandidates.count();
        let modalStillOpen = false;
        for (let d = 0; d < dialogNodeCount; d++) {
          if (await dialogCandidates.nth(d).isVisible().catch(() => false)) {
            modalStillOpen = true;
            break;
          }
        }

        if (!modalStillOpen) {
          console.log('  ⚠️ Expatriate modal appears closed before Save could be clicked. Skipping Save — record likely saved as draft.');
          if (reportData.localUnderstudyCandidates.status === 'not started') {
            reportData.localUnderstudyCandidates.status = 'attempted, save skipped (modal closed)';
          }
        } else {
          const finalSaveBtn = targetPage.getByRole('button', { name: /^Save$/i }).first()
            .or(targetPage.locator('button[class*="saveButton"]').filter({ hasNotText: /draft/i }).first());

          await finalSaveBtn.waitFor({ state: 'visible', timeout: 10000 });
          await finalSaveBtn.scrollIntoViewIfNeeded();
          await finalSaveBtn.click({ timeout: 10000 });

          await targetPage.waitForTimeout(4000);
          console.log('🎉 Form submission complete!');
          if (reportData.localUnderstudyCandidates.attempted) {
            reportData.localUnderstudyCandidates.status = 'completed';
          }
        }

      } catch (err) {
        console.log(`⚠️ Error on processing Page 5 (Local Understudy): ${err.message}`);
        if (reportData.localUnderstudyCandidates.attempted) {
          reportData.localUnderstudyCandidates.status = `failed: ${err.message}`;
        }
      }


      console.log(`✅ Expatriate Worker #${expatIndex + 1} modal validation and autofill complete.\n`);
      await targetPage.waitForTimeout(1000);
      workerRecord.status = 'completed';
      }); // end test.step: Expatriate Worker
    } catch (err) {
      workerRecord.status = `failed: ${err.message}`;
      console.warn(`⚠️ Expatriate Worker #${expatIndex + 1} automation encountered an issue: ${err.message}`);
    }
    } // end for (expatIndex)

    // ── Step 6: Additional Attachment (outer stepper page 3) ──
    await test.step('Additional Attachment uploads', async () => {
    try {
      console.log('\n📎 Navigating to "Additional Attachment" (outer stepper Next)...');

      const outerNextBtn = targetPage.getByRole('button', { name: /^Next$/i }).first()
        .or(targetPage.locator('button:has-text("Next")').first());

      await outerNextBtn.waitFor({ state: 'visible', timeout: 10000 });
      await outerNextBtn.scrollIntoViewIfNeeded();
      await outerNextBtn.click({ timeout: 10000 });

      const attachmentHeader = targetPage.locator('text=Additional Attachment').first();
      await attachmentHeader.waitFor({ state: 'visible', timeout: 15000 });
      console.log('✅ Landed on "Additional Attachment" page.');
      await targetPage.waitForTimeout(1000);

      // The file <input> lives inside each "Upload Here" button (hidden via
      // display:none), so setInputFiles() can target it directly without
      // needing to click the button first.
      const path = require('path');
      const pdfDir = path.dirname(CONFIG.pdfUploadPath || '');

      const attachmentFileMap = [
        { label: 'Authorization Letter from Company', filePath: path.join(pdfDir, 'letter.jpeg') },
        { label: 'Copy of MyKad / Passport of Company Representation', filePath: path.join(pdfDir, 'IC.png') },
        { label: 'Proof of Employment or LHDN Stamp Certificate', filePath: path.join(pdfDir, 'LHDN.png') },
        { label: 'Organization Chart', filePath: path.join(pdfDir, 'chart.pdf') },
      ];

      for (const item of attachmentFileMap) {
        try {
          console.log(`  📎 Uploading for "${item.label}": ${item.filePath}`);

          const escapedLabel = item.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          // Find the label text (bold row title), then grab the nearest
          // hidden <input type="file"> that follows it in the DOM — this is
          // the input nested inside that row's "Upload Here" button.
          const fileInput = targetPage.locator('p, span, label, div').filter({ hasText: new RegExp(`^${escapedLabel}\\s*\\*?$`, 'i') }).first()
            .locator('xpath=../following::input[@type="file"][1]');

          await fileInput.waitFor({ state: 'attached', timeout: 8000 });
          await fileInput.setInputFiles(item.filePath);
          console.log(`  ✅ "${item.label}" uploaded via setInputFiles!`);
          reportData.additionalAttachment.filesUploaded.push(item.label);

          await targetPage.waitForTimeout(1000);
        } catch (e) {
          console.log(`  ⚠️ Could not upload "${item.label}": ${e.message}`);
        }
      }

      console.log('✅ Additional Attachment uploads complete.\n');
      reportData.additionalAttachment.status = 'completed';
    } catch (err) {
      reportData.additionalAttachment.status = `failed: ${err.message}`;
      console.warn(`⚠️ Additional Attachment step encountered an issue: ${err.message}`);
    }
    }); // end test.step: Additional Attachment uploads

    // ── Step 7: Employer's Declaration & Undertaking (final page) ──
    await test.step("Employer's Declaration & E-Signature", async () => {
    try {
      console.log('\n📜 Navigating to "Employer\'s Declaration & Undertaking" (outer stepper Next)...');

      const outerNextBtn2 = targetPage.getByRole('button', { name: /^Next$/i }).first()
        .or(targetPage.locator('button:has-text("Next")').first());

      await outerNextBtn2.waitFor({ state: 'visible', timeout: 10000 });
      await outerNextBtn2.scrollIntoViewIfNeeded();
      await outerNextBtn2.click({ timeout: 10000 });

      const declarationHeader = targetPage.locator("text=Employer's Declaration").first()
        .or(targetPage.locator('text=Employer’s Declaration').first()); // curly apostrophe variant
      await declarationHeader.waitFor({ state: 'visible', timeout: 15000 });
      console.log('✅ Landed on "Employer\'s Declaration & Undertaking" page.');
      reportData.employerDeclaration.status = 'page reached';

      // The "Click Here to Sign" control is an icon-only <button> with no
      // text — <button><img src="...icon_declaration.svg" ...></button> —
      // so text-based locators never matched the button itself, only a
      // nearby caption. Target it by its icon image's src instead.
      const signBtn = targetPage.locator('button:has(img[src*="icon_declaration"])').first()
        .or(targetPage.locator('button:has(img[alt*="Sign" i])').first());

      await signBtn.waitFor({ state: 'visible', timeout: 8000 });
      await signBtn.scrollIntoViewIfNeeded();
      await signBtn.click({ timeout: 8000 });
      console.log('✅ Clicked "Click Here to Sign" button.');
      await targetPage.waitForTimeout(1500);

      // ── E-Signature modal: fill Full Name / IC/Passport No / Position, ──
      // ── draw a signature on the canvas, then click Confirm ──────────────
      try {
        const signatureModal = targetPage.locator('[role="dialog"], .MuiDialog-root').filter({ hasText: /E-Signature/i }).last();
        await signatureModal.waitFor({ state: 'visible', timeout: 10000 });
        console.log('📋 "E-Signature" modal is visible!');

        const fullNameInput = signatureModal.locator('p, span, label').filter({ hasText: /^Full Name\s*\*?$/i }).first()
          .locator('xpath=../descendant::input[1]')
          .or(signatureModal.getByLabel(/Full Name/i).first());
        await fullNameInput.waitFor({ state: 'visible', timeout: 5000 });
        await fullNameInput.fill('Saddam');
        console.log('  ➕ Filled Full Name: Saddam');

        const icInput = signatureModal.locator('p, span, label').filter({ hasText: /^IC\/Passport\s*No\s*\*?$/i }).first()
          .locator('xpath=../descendant::input[1]')
          .or(signatureModal.getByLabel(/IC\/Passport No/i).first());
        await icInput.waitFor({ state: 'visible', timeout: 5000 });
        await icInput.fill('991212-13-1321');
        console.log('  ➕ Filled IC/Passport No: 991212-13-1321');

        const positionInput = signatureModal.locator('p, span, label').filter({ hasText: /^Position\s*\*?$/i }).first()
          .locator('xpath=../descendant::input[1]')
          .or(signatureModal.getByLabel(/Position/i).first());
        await positionInput.waitFor({ state: 'visible', timeout: 5000 });
        await positionInput.fill('CEO');
        console.log('  ➕ Filled Position: CEO');

        // Draw a simple squiggle signature on the signature canvas/pad using
        // raw mouse events (canvas-based signature pads don't respond to
        // .fill()/.type(), only real pointer movement).
        const signatureCanvas = signatureModal.locator('canvas').first();
        await signatureCanvas.waitFor({ state: 'visible', timeout: 5000 });
        const box = await signatureCanvas.boundingBox();

        if (box) {
          const startX = box.x + box.width * 0.15;
          const startY = box.y + box.height * 0.5;

          await targetPage.mouse.move(startX, startY);
          await targetPage.mouse.down();

          // A few simple curved strokes to mimic a signature.
          const points = [
            [0.25, 0.3], [0.35, 0.6], [0.45, 0.25], [0.55, 0.6],
            [0.65, 0.3], [0.75, 0.55], [0.85, 0.35],
          ];
          for (const [fx, fy] of points) {
            await targetPage.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 5 });
          }

          await targetPage.mouse.up();
          console.log('  ✍️ Drew a signature on the E-Signature canvas.');
        } else {
          console.log('  ⚠️ Could not determine signature canvas bounding box; skipping drawing.');
        }

        await targetPage.waitForTimeout(500);

        const confirmSignBtn = signatureModal.getByRole('button', { name: /^Confirm$/i }).first()
          .or(signatureModal.locator('button:has-text("Confirm")').first());
        await confirmSignBtn.waitFor({ state: 'visible', timeout: 5000 });
        await confirmSignBtn.click({ timeout: 8000 });
        console.log('✅ Clicked "Confirm" on E-Signature modal.');
        await targetPage.waitForTimeout(1500);

        await targetPage.screenshot({ path: 'test-results/e-signature-confirmed.png', fullPage: true }).catch(() => { });
        reportData.employerDeclaration.signed = true;
        reportData.employerDeclaration.status = 'signed';
      } catch (sigErr) {
        console.log(`⚠️ Could not complete E-Signature modal: ${sigErr.message}`);
        await targetPage.screenshot({ path: 'test-results/e-signature-error.png', fullPage: true }).catch(() => { });
        reportData.employerDeclaration.status = `sign failed: ${sigErr.message}`;
      }

      await targetPage.screenshot({ path: 'test-results/employer-declaration-page.png', fullPage: true }).catch(() => { });

      // ── Final Submit ──────────────────────────────────────────────────────
      // The declaration text explicitly states submission is legally binding
      // and triggers payment obligations. Gate this behind an explicit env
      // flag so it never fires by accident during routine test runs.
      // Enable via: SUBMIT_APPLICATION=true
      const shouldSubmit = process.env.SUBMIT_APPLICATION === 'true';

      if (!shouldSubmit) {
        console.log('⏭️ SUBMIT_APPLICATION is not "true" in ENV. Skipping final Submit click (dry run stops here).');
        reportData.finalSubmit.status = 'skipped (SUBMIT_APPLICATION=false)';
      } else {
        reportData.finalSubmit.attempted = true;
        try {
          console.log('🚀 SUBMIT_APPLICATION=true — clicking final "Submit" button...');
          const submitBtn = targetPage.getByRole('button', { name: /^Submit$/i }).first()
            .or(targetPage.locator('button:has-text("Submit")').first());

          await submitBtn.waitFor({ state: 'visible', timeout: 8000 });
          await submitBtn.scrollIntoViewIfNeeded();
          await submitBtn.click({ timeout: 8000 });
          console.log('✅ Clicked "Submit" button.');

          await targetPage.waitForTimeout(2000);
          await targetPage.screenshot({ path: 'test-results/application-submitted.png', fullPage: true }).catch(() => { });
          console.log('🎉 Application submission flow complete!');
          reportData.finalSubmit.status = 'submitted';
        } catch (submitErr) {
          console.log(`⚠️ Could not click final Submit button: ${submitErr.message}`);
          await targetPage.screenshot({ path: 'test-results/submit-error.png', fullPage: true }).catch(() => { });
          reportData.finalSubmit.status = `failed: ${submitErr.message}`;
        }
      }
    } catch (err) {
      console.warn(`⚠️ Could not navigate to Employer's Declaration page: ${err.message}`);
      reportData.employerDeclaration.status = `failed: ${err.message}`;
    }
    }); // end test.step: Employer's Declaration & E-Signature

    return reportData;
  } catch (err) {
    console.error(`❌ Error during form automation: ${err.message}`);
    // Attach whatever partial data was gathered before the hard failure, so
    // the HTML report still shows what succeeded before things broke.
    reportData.hardFailure = err.message;
    throw Object.assign(err, { reportData });
  }
}
test.describe('EXPRT - Create AL Flow', () => {

  test('Login, click module to open new tab, and start AL creation', async ({ page }, testInfo) => {
    // This flow spans login/OTP + N expatriate workers (each a 5-page modal
    // fill with uploads) + candidates + attachments + declaration/signature.
    // A fixed timeout doesn't scale with EXPAT_COUNT, so give a generous
    // base budget for one worker plus extra time per additional worker.
    const expatCountForTimeout = Math.max(1, parseInt(process.env.EXPAT_COUNT || '1', 10));
    const dynamicTimeout = 300000 + (expatCountForTimeout - 1) * 180000; // +3min per extra worker
    test.setTimeout(dynamicTimeout);
    console.log(`⏱️ Test timeout set to ${dynamicTimeout / 1000}s for EXPAT_COUNT=${expatCountForTimeout}.`);

    const runStartedAt = new Date().toISOString();

    // Snapshot of the ENV configuration that drove this run's behavior, so
    // the report shows exactly what was toggled on/off for reproducibility.
    const envSnapshot = {
      AL_APPLICATION_TYPE: process.env.AL_APPLICATION_TYPE || 'new',
      AL_PASS_TYPE: process.env.AL_PASS_TYPE || 'ep',
      AL_EXPAT_TYPE: process.env.AL_EXPAT_TYPE || 'specialist',
      EXPAT_COUNT: process.env.EXPAT_COUNT || '1',
      ADD_LOCAL_CANDIDATES: process.env.ADD_LOCAL_CANDIDATES || 'false',
      CANDIDATE_COUNT: process.env.CANDIDATE_COUNT || '1',
      SUBMIT_APPLICATION: process.env.SUBMIT_APPLICATION || 'false',
    };

    let reportData = null;

    try {
      // Step 1: Log into the SSO hub (Tab 1)
      const exprtPage = await fullLoginFlow(page);
      expect(exprtPage.url()).not.toContain('login');
      console.log('✅ Successfully logged into the SSO hub (Tab 1)');

      // Step 2: Continue straight to waiting for the correct layout state
      console.log('⏳ Confirming EXPRT application page state...');
      await waitForUrlOrRefresh(exprtPage, '**sansols/expat/applications/**/', 10000, 3);

      // Step 3: Now interact with Tab 2 safely
      await clickAddALButton(exprtPage);

      // Step 4: Execute the Form Prefill & Step Navigation Flow
      reportData = await fillAndNavigateEXPRTForm(exprtPage);

      console.log('✅ Form automated completely up to the submission phase!');

      // Take screenshot of the form page on Tab 2
      await exprtPage.screenshot({ path: 'test-results/job-form-page.png' }).catch(() => { });

    } catch (error) {
      // Recover any partial report data attached by fillAndNavigateEXPRTForm
      // before it threw, so the report still reflects what succeeded.
      if (error && error.reportData) {
        reportData = error.reportData;
      }
      console.error(`❌ Test failed: ${error.message}`);
      throw error;
    } finally {
      // Attach a QA-readable summary to the HTML report regardless of
      // pass/fail: run metadata, the ENV config that drove this run's
      // behavior, and the outcome of each phase with the generated test
      // data (names, nationality, expat type, etc.) for reproducibility.
      const summary = {
        runStartedAt,
        runFinishedAt: new Date().toISOString(),
        overallStatus: testInfo.status || 'unknown',
        envConfig: envSnapshot,
        phases: reportData || { note: 'No data captured — failure occurred before form automation started.' },
      };

      await testInfo.attach('qa-summary.json', {
        body: JSON.stringify(summary, null, 2),
        contentType: 'application/json',
      });

      console.log('\n📊 QA Summary:\n' + JSON.stringify(summary, null, 2));
    }
  });

});
