// login-module.test.js
// Test to login and select the JobSarawak module
const { test, expect } = require('@playwright/test');
const { CONFIG, fullLoginFlow } = require('../helpers/login-helpers');

// ─── TESTS ────────────────────────────────────────────────────────────────────

test.describe('Portal Module Navigation Test', () => {
  test('Login and open EXPRT module successfully', async ({ page }) => {
    try {
      // Full login flow: login → select company → select module
      const finalUrl = await fullLoginFlow(page);

      // Verify navigation was successful
      expect(finalUrl.url()).not.toContain('login');
      console.log(`✨ Successfully reached page for module "${CONFIG.moduleName}"!`);

      // Take screenshot for validation
      await finalUrl.screenshot({ path: `test-results/module-navigation-success.png` }).catch(() => {});
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
      await page.screenshot({ path: `test-results/test-error.png` }).catch(() => {});
      throw error;
    }
  });
});
