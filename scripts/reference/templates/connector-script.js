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

const PLATFORM_LOGIN = process.env.USER_LOGIN_{{PLATFORM_UPPER}} || '';
const PLATFORM_PASSWORD = process.env.USER_PASSWORD_{{PLATFORM_UPPER}} || '';

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

  // ═══ PHASE 1: Login (three-tier strategy) ═══
  // Tier 1: Check if already logged in (session from browser profile)
  // Tier 2: Try automated login if credentials available
  // Tier 3: Fall back to manual login via headed browser
  await page.setData('status', 'Checking login status...');
  await page.goto('{{PLATFORM_URL}}');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (isLoggedIn) {
    await page.setData('status', 'Session restored from browser profile');
  }

  // Tier 2: Automated login with credentials from .env
  if (!isLoggedIn && PLATFORM_LOGIN && PLATFORM_PASSWORD) {
    await page.setData('status', 'Attempting automated login...');
    await performLogin();
    await page.sleep(2000);

    isLoggedIn = await checkLoginStatus();
    if (!isLoggedIn) {
      await page.sleep(3000);
      isLoggedIn = await checkLoginStatus();
    }
    if (isLoggedIn) {
      await page.setData('status', 'Automated login successful');
    }
  }

  // Tier 3: Manual login — open headed browser and ask user
  if (!isLoggedIn) {
    await page.setData('status', 'Automated login unavailable — opening browser for manual login...');
    await page.showBrowser('{{LOGIN_URL}}');
    await page.promptUser(
      'Please log in to {{PLATFORM_NAME}}. Login will be detected automatically.',
      async () => await checkLoginStatus(),
      2000
    );
    isLoggedIn = true;
    await page.setData('status', 'Manual login successful');
  }

  // ═══ PHASE 2: Data Collection (headless) ═══
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
