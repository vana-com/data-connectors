/**
 * {{PLATFORM_NAME}} Connector (Playwright)
 *
 * Exports:
 * - {{platform}}.{{scope1}} — {{scope1 description}}
 * - {{platform}}.{{scope2}} — {{scope2 description}}
 *
 * Extraction method: {{API fetch / Network capture / DOM scraping}}
 */

// ─── Credentials ─────────────────────────────────────────────

let PLATFORM_LOGIN = process.env.USER_LOGIN_{{PLATFORM_UPPER}} || '';
let PLATFORM_PASSWORD = process.env.USER_PASSWORD_{{PLATFORM_UPPER}} || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        // Check for login form (means NOT logged in)
        const hasLoginForm = !!document.querySelector('{{LOGIN_FORM_SELECTOR}}');
        if (hasLoginForm) return false;

        // Check for challenge/2FA pages
        const url = window.location.href;
        if (url.includes('/challenge') || url.includes('/checkpoint')) return false;

        // Check for logged-in indicators
        const isLoggedIn = !!document.querySelector('{{LOGGED_IN_SELECTOR}}');
        return isLoggedIn;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(PLATFORM_LOGIN);
  const passwordStr = JSON.stringify(PLATFORM_PASSWORD);

  await page.goto('{{LOGIN_URL}}');
  await page.sleep(2000);

  // Fill and submit login form
  await page.evaluate(`
    (() => {
      const emailInput = document.querySelector('input[name="username"], input[name="email"], input[type="email"]');
      const passwordInput = document.querySelector('input[name="password"], input[type="password"]');

      if (emailInput) {
        emailInput.focus();
        emailInput.value = ${loginStr};
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordInput) {
        passwordInput.focus();
        passwordInput.value = ${passwordStr};
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(500);

  await page.evaluate(`
    (() => {
      const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) submitBtn.click();
    })()
  `);
  await page.sleep(3000);
};

// ─── Data Fetching Helpers ───────────────────────────────────

// For API-based connectors:
const fetchApi = async (endpoint) => {
  const endpointStr = JSON.stringify(endpoint);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const resp = await fetch(${endpointStr}, {
            credentials: 'include'
          });
          if (!resp.ok) return { _error: resp.status };
          return await resp.json();
        } catch(e) { return { _error: e.message }; }
      })()
    `);
  } catch (e) {
    return { _error: e.message || String(e) };
  }
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // ═══ PHASE 1: Automated Login ═══
  await page.setData('status', 'Checking login status...');
  await page.goto('{{PLATFORM_URL}}');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    // Try .env credentials first, fall back to requestData
    if (!PLATFORM_LOGIN || !PLATFORM_PASSWORD) {
      const result = await page.requestData({
        message: 'Enter your {{PLATFORM_NAME}} credentials',
        schema: {
          type: 'object',
          properties: {
            username: { type: 'string', title: 'Email or username' },
            password: { type: 'string', title: 'Password' }
          },
          required: ['username', 'password']
        }
      });
      if (result.status === 'skipped') {
        await page.setData('error', 'Login credentials required but not available in automated mode.');
        return;
      }
      PLATFORM_LOGIN = result.data.username;
      PLATFORM_PASSWORD = result.data.password;
    }
    await page.setData('status', 'Logging in...');
    await performLogin();
    await page.sleep(2000);

    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      await page.sleep(3000);
      isLoggedIn = await checkLoginStatus();
    }
    if (!isLoggedIn) {
      // Fall back to manual browser login
      const manualResult = await page.requestManualAction(
        'Complete login in the browser, then click "Done".',
        async () => await checkLoginStatus(),
        { url: '{{PLATFORM_URL}}' }
      );
      if (manualResult.status === 'skipped') {
        await page.setData('error', 'Login failed. Manual browser login required but not available in automated mode.');
        return;
      }
      isLoggedIn = await checkLoginStatus();
      if (!isLoggedIn) {
        await page.setData('error', 'Login failed after manual attempt.');
        return;
      }
    }
    await page.setData('status', 'Login successful');
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ PHASE 2: Data Collection ═══
  await page.goHeadless();

  // ═══ STEP 1: Fetch primary data ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching data' },
    message: 'Loading {{scope1}} data...',
  });

  // TODO: Fetch data here
  // const data = await fetchApi('/api/endpoint');
  // if (data._error) {
  //   await page.setData('error', 'Failed to fetch data: ' + data._error);
  //   return;
  // }

  // ═══ STEP 2: Process data ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Processing' },
    message: 'Processing data...',
  });

  // TODO: Transform raw data into scope-specific shapes

  // ═══ STEP 3: Build result ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const result = {
    '{{platform}}.{{scope1}}': {
      // TODO: scope1 data
    },
    '{{platform}}.{{scope2}}': {
      // TODO: scope2 data
    },
    exportSummary: {
      count: 0,  // TODO: total item count
      label: 'items',
      details: 'X scope1 items, Y scope2 items',  // TODO: breakdown
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: '{{platform}}',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);
})();
