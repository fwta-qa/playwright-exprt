// playwright.config.js
// Central Playwright configuration. Adds a QA-friendly reporting setup:
// - "list": readable progress in the terminal while the test runs
// - "html": a browsable report (screenshots, steps, traces) generated after
//   every run, whether it passes or fails
// - "json": machine-readable results, useful for CI dashboards or scripts
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test-files',
  // Base timeout for a single-worker run. al-autofill-form.test.js
  // overrides this with test.setTimeout() scaled to EXPAT_COUNT, since each
  // additional expatriate worker adds a full 5-page modal fill to the flow.
  timeout: 600000,
  // Named projects let package.json target each test file individually via
  // --project=<name> (e.g. "npm run test:autofill-al" / "test:admin-approve"
  // run in total isolation — no other project's tests execute alongside).
  //
  // NOTE: deliberately NOT using Playwright's `dependencies` here. A
  // dependency project always runs automatically whenever the dependent
  // project runs (even if you target it directly with --project), which is
  // exactly the "admin-approve runs autofill too" behavior we don't want.
  // Sequencing "run autofill THEN admin" for the combined "npm test" case is
  // instead handled in package.json by chaining two separate
  // `playwright test --project=...` commands with `&&`.
  projects: [
    {
      name: 'employer-al-autofill',
      testMatch: 'al-autofill-form.test.js',
    },
    {
      name: 'admin-approval',
      testMatch: 'admin-approve-application.test.js',
    },
  ],
  reporter: [
    ['list'],
    // Opens the HTML report automatically only when a test fails, so a
    // clean run doesn't block the terminal with a local report server.
    // Run "npm run report" any time to open it manually.
    ['html', { outputFolder: 'playwright-report', open: 'on-failure' }],
    ['json', { outputFile: 'test-results/results.json' }],
    // Custom reporter that turns the qa-summary.json attachment into a
    // plain-language PDF report for non-technical stakeholders.
    // Output: test-results/QA-Report.pdf
    ['./reporters/pdf-summary-reporter.js'],
  ],
  use: {
    // Keep a trace + screenshot for every test so failures (and the happy
    // path) can be inspected step-by-step in the HTML report.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
