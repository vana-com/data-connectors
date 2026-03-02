/**
 * {{PLATFORM_NAME}} Connector (Playwright)
 *
 * Exports:
 * - {{platform}}.{{scope1}} — {{scope1 description}}
 * - {{platform}}.{{scope2}} — {{scope2 description}}
 *
 * Extraction method: {{API fetch / Network capture / DOM scraping}}
 */

// ─── Login Detection ──────────────────────────────────────

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

// ─── Data Fetching Helpers ────────────────────────────────

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

// ─── Main Export Flow ─────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // ═══ PHASE 1: Login Detection ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.showBrowser('{{LOGIN_URL}}');
    await page.setData('status', 'Please log in to {{PLATFORM_NAME}}...');
    await page.sleep(2000);

    await page.promptUser(
      'Please log in to {{PLATFORM_NAME}}. Click "Done" when ready.',
      async () => await checkLoginStatus(),
      2000
    );

    await page.setData('status', 'Login completed');
    await page.sleep(2000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ Switch to headless ═══
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
