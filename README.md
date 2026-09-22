# EXPRT AL Application — Automated Test Suite

Playwright automation for the **EXPRT AL (Approval Letter) application flow** on the SANSOLS/Genesis platform, end to end:

1. **Employer side** — logs in, fills out a full AL application (Corporate Details, Expatriate Workers, Local Understudy Candidates, Supporting Documents, Employer's Declaration + e-signature), and submits it.
2. **Admin side** — resolves the assigned government officer via an internal QA API, then walks the application through the full approval hierarchy (JIMS → ILMU → JKLE → ILMU Director → State Secretary), bypasses the proforma waiting period, and completes the final payment on the employer side via the FWTA Payment Portal.

Both flows use Gmail-based OTP retrieval (or a fixed "decoy" OTP for demo/dev environments), and produce QA-friendly HTML/PDF reports after every run.

---

## What You Need Before Starting

- A Windows computer
- A Gmail account registered on the SSO portal (only needed if `DECOY_OTP=false`)
- Internet access

---

## Step 1 — Install Node.js

1. Go to https://nodejs.org and download the **LTS** version
2. Run the installer — keep all default settings, make sure **"Add to PATH"** is ticked
3. Close and reopen your terminal
4. Verify:
   ```
   node --version
   npm --version
   ```
   If PowerShell blocks script execution, run:
   ```
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

---

## Step 2 — Install Dependencies

From the project root:

```
npm install
npx playwright install chromium
```

---

## Step 3 — Configure `.env`

Copy `env.example` to `.env` (if you don't already have one) and fill in your values. The `.env` file is organized into these sections — see the file itself for the full list of options with inline comments:

| Section | Purpose |
|---|---|
| Gmail / OTP | `GMAIL_ADDRESS`, `DECOY_OTP`, `DECOY_OTP_CODE`, `USE_2FA` |
| SSO / Company / Module | `SSO_URL`, `COMPANY_NAME`, `MODULE_NAME`, `ADMIN_EMAIL`, `MODULE_NAME_ADMIN` |
| AL application shape | `AL_APPLICATION_TYPE`, `AL_PASS_TYPE`, `AL_EXPAT_TYPE`, `EXPAT_COUNT` |
| Uploads / candidates | `PDF_UPLOAD_PATH`, `ADD_LOCAL_CANDIDATES`, `CANDIDATE_COUNT` |
| Final submit gate | `SUBMIT_APPLICATION` |
| Admin test targeting | `APPLICATION_ID`, `APPLICATION_REF_NO` |
| QA Tools API | `QA_TOOLS_BASE_URL`, `QA_TOOLS_USERNAME`, `QA_TOOLS_PASSWORD` |
| Admin approval decisions | `ADMIN_RECOMMENDATION`, `ADMIN_ACCEPT_REVIEW`, `SITE_INSPECTION_REQUIRED`, `DSS_REVIEW`, `STATE_SECRETARY_DECISION`, `JKLE_AGENCY_CONFIRM` |
| Payment | `USE_EWALLET_CREDITS` |

A few of these are worth calling out specifically:

- **`DECOY_OTP=true`** — skips real Gmail polling and always types `DECOY_OTP_CODE` (`122222` by default). This is what you want for demo/dev environments where OTP is fixed. Set to `false` only if you need to fetch a real OTP from Gmail (see Step 4).
- **`SUBMIT_APPLICATION`** — gates the final "Submit" button on the Employer's Declaration page. The declaration is legally binding, so this is intentionally explicit rather than defaulted to always-on.
- **`ADMIN_ACCEPT_REVIEW`** — gates every "ACCEPT"/"SUBMIT"/"REVIEW" click across the whole admin approval chain. Leave `false` to just exercise the review UI (fill fields, click Save) without actually advancing any application through the real workflow.
- **`APPLICATION_ID` / `APPLICATION_REF_NO`** — set both to run `admin-approve-application.test.js` against a *specific* existing application, without needing a fresh employer-side run first. Leave both empty to fall back to whatever `al-autofill-form.test.js` last submitted (see [How the two tests hand off](#how-the-two-tests-hand-off) below).

---

## Step 4 — Gmail API Setup (Only If `DECOY_OTP=false`)

Skip this entirely if you're running against a demo/dev environment with `DECOY_OTP=true`.

### 4a. Create a Google Cloud Project

1. Go to https://console.cloud.google.com and sign in with the Gmail account used to log into the SSO portal
2. Close/ignore any "Start Free Trial" popup
3. Project dropdown → **New Project** → name it anything → **Create**

### 4b. Enable the Gmail API

**APIs & Services → Library** → search **Gmail API** → **Enable**

### 4c. Configure the OAuth Consent Screen

1. **APIs & Services → OAuth consent screen** → **External** → **Create**
2. Fill in app name / support email / developer email → **Save and Continue** through all steps
3. **Test users** → **Add Users** → add your Gmail address → **Save**

### 4d. Create OAuth Credentials

1. **APIs & Services → Credentials** → **+ Create Credentials → OAuth 2.0 Client ID**
2. Application type: **Desktop app** → **Create** → **Download JSON**
3. Rename the downloaded file to exactly `credentials.json` and place it in the project root

### 4e. Authorize (One-Time)

```
node gmail-auth.js
```

Open the printed URL, sign in, click through any "unverified app" warning (it's your own app), **Allow**, then paste the code back into the terminal. You should see `✅ token.json saved!`.

Verify it works:
```
node debug-gmail.js
```

---

## Running the Tests

The suite is split into two Playwright **projects** so each half can run standalone or chained:

| Command | What it runs |
|---|---|
| `npm test` | Employer autofill **then** admin approval, in that order, end to end |
| `npm run test:headed` | Same as above, with a visible browser |
| `npm run test:autofill-al` | **Only** the employer-side AL application flow |
| `npm run test:autofill-al:headed` | Same, headed |
| `npm run test:admin-approve` | **Only** the admin approval chain (see [hand-off](#how-the-two-tests-hand-off) below) |
| `npm run test:admin-approve:headed` | Same, headed |
| `npm run test:list` | List all discovered tests without running them |
| `npm run test:ui` | Open Playwright's interactive UI runner |
| `npm run report` | Open the last HTML report |

`test:admin-approve` never triggers the employer test, and vice versa — they're isolated Playwright projects (`playwright.config.js`), not linked via `dependencies`. Sequencing for the combined `npm test` run is done by chaining the two project-scoped commands in `package.json`, not by Playwright's project-dependency feature.

### How the two tests hand off

`al-autofill-form.test.js` captures the new application's reference number and UUID **immediately after creation** (not just at final Submit, so a mid-form failure still leaves usable data) and writes them to `.test-state/last-application-id.json`. That file lives outside `test-results/` deliberately, since Playwright wipes its `outputDir` at the start of every run.

`admin-approve-application.test.js` reads that file automatically — unless you set `APPLICATION_ID` + `APPLICATION_REF_NO` in `.env`, in which case those take priority. This lets you re-run the admin approval chain against a specific application repeatedly without regenerating a new one every time.

---

## What Each Test Covers

### `al-autofill-form.test.js` — Employer side

- Login + OTP, company/module selection
- Corporate Details (Pages 1 & 2)
- Expatriate Workers — count controlled by `EXPAT_COUNT`; worker #1 uses `AL_EXPAT_TYPE`, while `AL_EXPAT_TYPE_ADDITIONAL` can assign a category to every later worker (blank keeps the Cross-Posting/Others randomization)
  - HOR vs MASCO job-position randomization (falls back to MASCO if no HOR listing exists)
  - Malaysian-nationality conditional fields (State + NRIC, with Date of Birth auto-derived from NRIC)
  - Nationality-linked realistic names and home addresses (Indonesia/India/Philippines/etc.)
  - Employment history, place-of-employment photo uploads (5 required views), qualification/marital-status/gender randomization
- Local Understudy Candidates — only registered for the **first** expatriate worker regardless of `EXPAT_COUNT`, gated by `ADD_LOCAL_CANDIDATES` / `CANDIDATE_COUNT`
- Additional Attachments (incl. Employee Transfer Letter for Cross-Posting expats)
- Employer's Declaration + drawn e-signature
- Final Submit — gated by `SUBMIT_APPLICATION`
- Captures Application No. + ID right after creation, and again at Submit confirmation

### `admin-approve-application.test.js` — Admin side

For each stage, the QA Tools API (`/qa/approval/waiting/{id}`) is re-queried to find the officer currently `REQUIRED` to act, and the test logs in as that officer to complete the review. Stages walked, in order:

1. **JIMS (`jims_officer_expat`)** — Recommend/Not Recommend + Remarks → Accept
2. **JIMS HQ (`jims_hq_officer_expat`)** — same as above → Accept
3. **ILMU Expat (`ilmu_officer_expat`)** — Remarks only (no Recommend control) → Submit
4. **JKLE (`ilmu_officer`)** — Site Inspection Required checkbox (`SITE_INSPECTION_REQUIRED`) *must* be unchecked before Recommend/Not Recommend even renders; Remarks + Application Remarks → Submit (handles the "No Mandatory JKLE Agency Selected" popup via `JKLE_AGENCY_CONFIRM`)
5. **ILMU Director (`ilmu_dir`)** — Recommend/Not Recommend + Remarks + DSS Review radio (`DSS_REVIEW`) → Review
6. **DSS (`deputy_state_secretary_expat`)** — only appears as a stage at all when `DSS_REVIEW=mandatory` was set at stage 5; skipped automatically otherwise
7. **State Secretary (`state_secretary`)** — Approve/Reject (`STATE_SECRETARY_DECISION`, separate from `ADMIN_RECOMMENDATION`) + Remarks → Submit (final stage)

After State Secretary submits, the test:
- Bypasses the (normally >1 hour) proforma waiting period via the QA API's `/qa/approval/promote_proforma/expat/{id}` shortcut
- Logs back in as the **employer**, searches for the application by reference number, and clicks **Pay**
- Handles the eWallet-credits choice if a balance is available (`USE_EWALLET_CREDITS`), or skips straight to payment if the balance is zero
- Completes the **FWTA Payment Portal**: switches Business → Personal, ensures Full Payment is checked, selects the **FPX Simulator** bank, clicks Pay Now, confirms the payment details popup, and clicks through to **Payment Successful** → **Return to Application Page**

Every stage runs in its own fresh browser context (each officer's login is independent — reusing one session across stages would leave you logged in as the previous officer).

`ADMIN_ACCEPT_REVIEW=false` stops each stage after Save, without clicking Accept/Submit/Review — useful for verifying the review UI without actually advancing a real application through the workflow.

---

## Reports

Every run produces, in `test-results/`:

- `list` output in the terminal as it runs
- an HTML report (`playwright-report/`, opened automatically only on failure — run `npm run report` any time to view it manually)
- `results.json` — machine-readable results
- **`QA-Report.pdf`** — a plain-language summary generated by the custom `reporters/pdf-summary-reporter.js`, intended for non-technical stakeholders (pass/fail status, env config used, per-phase breakdown)

---

## Project Structure

```
playwright-exprt/
├── test-files/
│   ├── al-autofill-form.test.js         ← employer-side AL application flow
│   └── admin-approve-application.test.js ← admin approval chain + payment
├── helpers/
│   ├── login-helpers.js                  ← SSO login/OTP, module selection, admin login flow
│   └── qa-api-helpers.js                 ← QA Tools API: officer lookup, proforma bypass
├── reporters/
│   └── pdf-summary-reporter.js           ← QA-Report.pdf generator
├── .test-state/
│   └── last-application-id.json          ← hand-off between the two tests (git-ignored)
├── test-results/                         ← screenshots, traces, videos, reports (wiped every run)
├── playwright.config.js                  ← projects, reporters, timeouts
├── .env                                  ← your local config (git-ignored)
├── env.example                           ← template
├── gmail-auth.js                         ← one-time Gmail OAuth authorization
├── debug-gmail.js                        ← Gmail inbox debug/verification script
├── package.json
└── package-lock.json
```

---

## Troubleshooting

**`npm` is not recognized**
Close and reopen your terminal after installing Node.js. If it still fails:
```
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**`credentials.json not found`**
Only relevant if `DECOY_OTP=false`. Make sure the file is in the project root, named exactly `credentials.json`.

**OTP email not found**
Run `node debug-gmail.js` to confirm Gmail is being read correctly, and that you authorized it with the account that actually receives the OTP. Or just set `DECOY_OTP=true` if you're on a demo/dev environment.

**Admin test fails with "No officer with status REQUIRED found"**
Either the application hasn't been submitted yet, has already cleared every stage, or the `APPLICATION_ID`/`.test-state` reference points at a stale application. Run the employer test again to generate a fresh one, or double check `APPLICATION_ID` / `APPLICATION_REF_NO` in `.env`.

**Admin test throws "Same officer detected again after ACCEPT"**
This is intentional — it means the current officer's action did not actually hand the application off to the next stage (the QA API still reports the same officer/role as REQUIRED). The current officer needs to settle the application properly before it can progress.

**Landed on `/sansols/admin/dashboard/` instead of `/sansols/admin/applications/`**
Handled automatically — the test detects this specific URL and force-navigates to the corrected `/admin/applications/` path.

**Error 403: access_denied during Gmail auth**
Google Cloud Console → APIs & Services → OAuth consent screen → Test users → add your Gmail address.

---

## Notes

- `.env`, `credentials.json`, and `token.json` are all git-ignored — never commit them.
- `.test-state/` is also git-ignored — it's local run state, not something to share or version.
- Destructive/consequential actions (`SUBMIT_APPLICATION`, `ADMIN_ACCEPT_REVIEW`) default to safe values and require explicit opt-in.
