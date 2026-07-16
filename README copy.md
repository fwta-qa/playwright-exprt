# Aliance SSO Login — Automated Test Guide

This guide walks you through setting up and running the automated login test for **https://aliance.sarawak.gov.my/sso/login/**

The test automatically enters your email, fetches the OTP from your Gmail, and logs in — no manual steps needed.

---

## What You Need Before Starting

- A Windows computer
- A Gmail account that is registered on the Aliance portal
- Internet access

---

## Step 1 — Install Node.js

Node.js is required to run the test scripts.

1. Go to https://nodejs.org
2. Download the **LTS** version
3. Run the installer — keep all default settings and make sure **"Add to PATH"** is ticked
4. Once installed, **close and reopen** your terminal
5. Verify it worked by running:

```
node --version
npm --version
```

You should see version numbers for both. If you get an error, run this in PowerShell and try again:

```
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

---

## Step 2 — Create Your Project Folder

Open your terminal and run:

```
mkdir aliance-tests
cd aliance-tests
```

---

## Step 3 — Copy the Test Files

Place these files into your `aliance-tests` folder:

```
aliance-tests/
├── test-files/
│   └── login.test.js
├── gmail-auth.js
├── debug-gmail.js
└── .env.example
```

Then rename `.env.example` to `.env` and open it with Notepad. You will update it in Step 5.

---

## Step 4 — Set Up Gmail API (One-Time)

This allows the script to read your Gmail inbox to fetch the OTP automatically.

### 4a. Create a Google Cloud Project

1. Go to https://console.cloud.google.com
2. Sign in with the Gmail account you use to log into Aliance
3. If you see a "Start Free Trial" popup — **close/ignore it**, do NOT activate it
4. Click the project dropdown at the top → **New Project**
5. Name it anything (e.g. `aliance-test`) → click **Create**

### 4b. Enable Gmail API

1. In the left menu go to **APIs & Services → Library**
2. Search for **Gmail API** → click it → click **Enable**

### 4c. Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** → click **Create**
3. Fill in:
   - App name: `Aliance OTP Test`
   - User support email: your Gmail
   - Developer contact email: your Gmail
4. Click **Save and Continue** through all the steps
5. On the **Test users** section → click **Add Users** → add your Gmail address → click **Save**

### 4d. Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Desktop app**
4. Click **Create**
5. Click **Download JSON**
6. Rename the downloaded file to exactly: `credentials.json`
7. Move it into your `aliance-tests` folder

---

## Step 5 — Configure Your Email

Open the `.env` file in Notepad and update it with your Gmail address:

```
GMAIL_ADDRESS=yourname@gmail.com
```

Save the file.

---

## Step 6 — Install Dependencies

In your terminal, make sure you are inside the `aliance-tests` folder, then run these commands one by one:

```
npm init -y
npm install -D @playwright/test
npx playwright install chromium
npm install googleapis dotenv
```

Wait for each command to finish before running the next.

---

## Step 7 — Authorize Gmail (One-Time)

This step gives the script permission to read your Gmail inbox.

1. Run:
```
node gmail-auth.js
```

2. A long URL will appear in the terminal — copy it and open it in your browser

3. Sign in with your Gmail account (the same one that receives the OTP)

4. If you see **"Google hasn't verified this app"** → click **Advanced** → click **"Go to Aliance OTP Test (unsafe)"** — this is safe, it's your own app

5. Click **Allow**

6. You will see a code on screen — copy it

7. Paste it back into the terminal and press **Enter**

8. You should see: `✅ token.json saved! You can now run your tests.`

---

## Step 8 — Verify Gmail is Working (Optional but Recommended)

Run the debug script to confirm your Gmail is being read correctly:

```
node debug-gmail.js
```

You should see your recent emails listed. If you see `🔑 OTP FOUND` next to any OTP email, everything is working.

---

## Step 9 — Run the Tests

```
npx playwright test test-files/login.test.js --headed --timeout=120000
```

A browser window will open and you will see the test run automatically:
- It opens the Aliance login page
- Enters your email
- Clicks **Request OTP**
- Fetches the OTP from your Gmail
- Types it into the OTP boxes
- Clicks **Login**
- Verifies the login was successful

---

## What the Tests Check

| Test | What it does |
|------|-------------|
| ✅ Happy path | Logs in with the real OTP from Gmail — should pass |
| ❌ Wrong OTP | Enters `111111` as OTP — expects the app to show an error |

---

## Rate-Limiting (Throttle) Tests

This project includes API-level rate-limiting and account lockout tests that replicate the behavior of the throttle test suites. 

These tests make direct API requests (no browser spawned) and are configured using environment variables in `.env` (or set in your command line).

### Configuration Options in `.env`

You can customize the following variables in your `.env` file for the throttle tests:
- `API_BASE`: The base URL of the SSO API (defaults to dev or prod based on your `SSO_URL`).
- `TOKEN`: A manually provided Bearer token. If set, the test runs in **Generic mode** (skips logging in and only tests public/secure endpoints).
- `OTP_LIMIT`: Maximum OTP request attempts per email per minute (default: `5`).
- `SECURE_LIMIT`: Maximum requests per user per minute on secure endpoints (default: `60`).
- `PUBLIC_LIMIT`: Maximum public IP requests per minute (default: `200`).
- `DECOY_OTP`: Set to `true` to run against Dev (skips Gmail API fetching and uses a mock OTP). Set to `false` to run in Prod (retrieves real OTPs via Gmail).

### Running the Throttle Tests

To run the throttle test suite, run:
```
npm run test:throttle
```

To list all tests (both login UI tests and throttle API tests) in one go:
```
npm run test:list-all
```

To run all tests in the workspace (both UI login tests and API rate-limit tests):
- Headless (default):
  ```
  npm run test:all
  ```
- Headed:
  ```
  npm run test:all:headed
  ```

> [!WARNING]
> Due to rate-limit reset windows, some tests contain a `62s` wait time to ensure the rate limit bucket refreshes. The full suite can take 5–10 minutes to run.

---

## Your Final Folder Structure

```
aliance-tests/
├── node_modules/          ← created automatically by npm
├── credentials.json       ← downloaded from Google Cloud
├── token.json             ← created after running gmail-auth.js
├── test-files/
│   └── login.test.js      ← main test file
├── gmail-auth.js          ← Gmail authorization script
├── debug-gmail.js         ← Gmail debug/verification script
├── .env                   ← your Gmail address
├── .env.example           ← template (can ignore)
├── package.json           ← created by npm
└── package-lock.json      ← created by npm
```

---

## Troubleshooting

**`npm` is not recognized**
Close and reopen your terminal after installing Node.js. If it still fails, run:
```
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**`credentials.json not found`**
Make sure the file is inside your `aliance-tests` folder and named exactly `credentials.json` (not `credentials.json.json`). Enable file extensions in File Explorer under View → File name extensions.

**OTP email not found**
Run `node debug-gmail.js` to check if Gmail is reading the right inbox. Make sure you authorized Gmail with the same account that receives the OTP.

**Login button stays disabled**
The OTP was not entered correctly into the boxes. Run with `--headed` so you can see what's happening in the browser.

**Error 403: access_denied during Gmail auth**
Go back to Google Cloud Console → APIs & Services → OAuth consent screen → Test users → add your Gmail address.

---

## Notes

- Each person needs their own `credentials.json` and `token.json` — these are tied to your Google account and cannot be shared
- The test files (`login.test.js`, `gmail-auth.js`, `debug-gmail.js`) can be shared freely
- Never share your `token.json` or `credentials.json` with anyone
#   p l a y w r i g h t - j s  
 #   p l a y w r i g h t - j s  
 