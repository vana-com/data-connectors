/**
 * LinkedIn Connections Connector (Playwright) — Voyager API Extraction
 *
 * Exports LinkedIn connections with headlines and date connected metadata.
 * Two-phase API approach:
 *   1. Fetch connection records (URNs + createdAt dates) via connections endpoint
 *   2. Batch-resolve member profiles via identity endpoint
 */

// ─── Credentials ─────────────────────────────────────────────

const LINKEDIN_LOGIN = process.env.USER_LOGIN_LINKEDIN || '';
const LINKEDIN_PASSWORD = process.env.USER_PASSWORD_LINKEDIN || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLoginForm = !!document.querySelector('input[name="session_key"]') ||
                            !!document.querySelector('#username');
        if (hasLoginForm) return false;

        const url = window.location.href;
        const isChallenge = url.includes('/checkpoint/') ||
                           url.includes('/challenge/') ||
                           url.includes('/uas/') ||
                           url.includes('security-verification');
        if (isChallenge) return false;

        const hasFeedIndicators = !!document.querySelector('.scaffold-layout') ||
                                 !!document.querySelector('.global-nav__me-photo') ||
                                 url.includes('/feed') ||
                                 !!document.querySelector('img.global-nav__me-photo') ||
                                 !!document.querySelector('.global-nav');
        return hasFeedIndicators;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(LINKEDIN_LOGIN);
  const passwordStr = JSON.stringify(LINKEDIN_PASSWORD);

  await page.goto('https://www.linkedin.com/login');
  await page.sleep(3000);

  const hasForm = await page.evaluate(`!!document.querySelector('input[name="session_key"]')`);
  if (!hasForm) return;

  await page.evaluate(`
    (() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;

      const emailInput = document.querySelector('input[name="session_key"]');
      const passwordInput = document.querySelector('input[name="session_password"]');

      if (emailInput) {
        emailInput.focus();
        nativeInputValueSetter.call(emailInput, ${loginStr});
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passwordInput) {
        passwordInput.focus();
        nativeInputValueSetter.call(passwordInput, ${passwordStr});
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(500);

  await page.evaluate(`
    (() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) btn.click();
    })()
  `);
  await page.sleep(5000);
};

// ─── API Helpers ─────────────────────────────────────────────

const fetchApi = async (endpoint) => {
  const endpointStr = JSON.stringify(endpoint);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const csrfToken = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
          const resp = await fetch(${endpointStr}, {
            headers: { 'csrf-token': csrfToken },
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

const checkApiAuth = async () => {
  const result = await fetchApi('/voyager/api/me');
  return !result._error;
};

// Batch-resolve profile URNs via identity endpoint
const resolveProfiles = async (urns) => {
  // Build a recipe-style batch request using entityUrn list
  const urnListStr = urns.map(u => encodeURIComponent(u)).join(',');
  const endpoint = '/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity='
    + urnListStr
    + '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebMiniProfile-1';

  return await fetchApi(endpoint);
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // ═══ PHASE 1: Login ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  let isAuthenticated = await checkApiAuth();

  if (!isAuthenticated) {
    await page.setData('status', 'Attempting session restore...');
    try {
      await page.goto('https://www.linkedin.com/feed/');
      await page.sleep(4000);
    } catch (e) {
      await page.sleep(2000);
    }
    isAuthenticated = await checkApiAuth();
  }

  if (!isAuthenticated && LINKEDIN_LOGIN && LINKEDIN_PASSWORD) {
    await page.setData('status', 'Logging in with credentials...');
    await performLogin();

    const postLoginUrl = await page.evaluate(`window.location.href`);
    const hitChallenge = postLoginUrl &&
      (postLoginUrl.includes('/checkpoint') || postLoginUrl.includes('/challenge'));

    if (!hitChallenge) {
      isAuthenticated = await checkApiAuth();
    }
  }

  if (!isAuthenticated) {
    await page.showBrowser('https://www.linkedin.com/login');
    await page.setData('status', 'Please log in to LinkedIn...');
    await page.sleep(2000);

    await page.promptUser(
      'Please log in to LinkedIn. Click "Done" when you see your feed.',
      async () => {
        return await checkLoginStatus();
      },
      2000
    );

    await page.setData('status', 'Login completed');
    await page.sleep(2000);

    isAuthenticated = await checkApiAuth();
    if (!isAuthenticated) {
      try {
        await page.goto('https://www.linkedin.com/feed/');
        await page.sleep(3000);
      } catch (e) {
        await page.sleep(2000);
      }
      isAuthenticated = await checkApiAuth();
    }

    if (!isAuthenticated) {
      await page.setData('error', 'Login failed. Could not authenticate with LinkedIn API.');
      return;
    }
  }

  await page.setData('status', 'Authenticated — starting data collection');

  // ═══ PHASE 2: Data Collection (headless) ═══
  await page.goHeadless();

  // Navigate to LinkedIn for proper cookie context
  try {
    await page.goto('https://www.linkedin.com/feed/');
    await page.sleep(3000);
  } catch (e) {
    await page.sleep(2000);
  }

  // ═══ STEP 1: Fetch all connection records (URNs + dates) ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching connections' },
    message: 'Fetching connection records...',
  });

  const connectionRecords = [];
  let start = 0;
  const count = 40;
  const maxConnections = 2000;
  let totalAvailable = 0;

  while (start < maxConnections) {
    const endpoint = '/voyager/api/relationships/dash/connections'
      + '?count=' + count
      + '&q=search'
      + '&sortType=RECENTLY_ADDED'
      + '&start=' + start;

    const data = await fetchApi(endpoint);
    if (data._error) {
      if (start === 0) {
        await page.setData('error', 'Failed to fetch connections: ' + data._error);
        return;
      }
      break;
    }

    totalAvailable = data.paging?.total || totalAvailable;
    const elements = data.elements || [];
    if (elements.length === 0) break;

    for (const el of elements) {
      connectionRecords.push({
        memberUrn: typeof el.connectedMember === 'string' ? el.connectedMember : '',
        createdAt: el.createdAt || 0,
      });
    }

    await page.setProgress({
      phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching connections' },
      message: 'Fetched ' + connectionRecords.length + (totalAvailable ? ' of ' + totalAvailable : '') + ' connections...',
      count: connectionRecords.length,
    });

    if (elements.length < count) break;
    start += count;
    await page.sleep(300);
  }

  if (connectionRecords.length === 0) {
    await page.setData('error', 'No connections found.');
    return;
  }

  // ═══ STEP 2: Resolve member profiles ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Resolving profiles' },
    message: 'Resolving member profiles...',
  });

  const profileMap = {};
  const memberUrns = connectionRecords.map(r => r.memberUrn).filter(Boolean);

  // Resolve profiles in batches using individual lookups
  const batchSize = 5;
  let resolved = 0;
  let failedBatches = 0;

  for (let i = 0; i < memberUrns.length; i += batchSize) {
    const batch = memberUrns.slice(i, i + batchSize);

    // Resolve each URN individually
    for (const urn of batch) {
      // Extract the profile ID from URN: urn:li:fsd_profile:ABC123
      const profileId = urn.split(':').pop();
      if (!profileId) continue;

      // Try the identity endpoint with the profile URN
      const profileData = await fetchApi(
        '/voyager/api/identity/dash/profiles?ids=List(' + encodeURIComponent(urn) + ')'
      );

      if (!profileData._error && profileData.results) {
        // Results keyed by URN
        const result = profileData.results[urn] || Object.values(profileData.results)[0];
        if (result && (result.firstName || result.publicIdentifier)) {
          profileMap[urn] = result;
          resolved++;
        }
      } else if (!profileData._error && profileData.elements && profileData.elements.length > 0) {
        const profile = profileData.elements[0];
        if (profile.firstName || profile.publicIdentifier) {
          profileMap[urn] = profile;
          resolved++;
        }
      }
    }

    // If first few batches all fail, stop trying individual resolution
    if (i >= batchSize * 3 && resolved === 0) {
      failedBatches++;
      if (failedBatches >= 3) {
        await page.setData('status', '[DEBUG] Profile resolution not working, using dates only');
        break;
      }
    }

    await page.setProgress({
      phase: { step: 2, total: TOTAL_STEPS, label: 'Resolving profiles' },
      message: 'Resolved ' + resolved + ' of ' + memberUrns.length + ' profiles...',
      count: resolved,
    });

    await page.sleep(500);
  }

  await page.setData('status', '[DEBUG] Resolved ' + resolved + ' of ' + memberUrns.length + ' profiles');

  // ═══ STEP 3: Build result ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const connections = connectionRecords.map((record) => {
    const profile = profileMap[record.memberUrn] || {};

    const firstName = profile.firstName || '';
    const lastName = profile.lastName || '';
    const fullName = (firstName + ' ' + lastName).trim();

    const headline = profile.headline || profile.occupation || '';

    const publicId = profile.publicIdentifier || '';
    const profileUrl = publicId ? 'https://www.linkedin.com/in/' + publicId + '/' : '';

    const dateConnected = record.createdAt > 0
      ? new Date(record.createdAt).toISOString().split('T')[0]
      : '';

    return {
      fullName,
      headline,
      profileUrl,
      dateConnected,
    };
  });

  const resolvedCount = connections.filter(c => c.fullName).length;

  const result = {
    'linkedin.connections': {
      connections,
    },
    exportSummary: {
      count: connections.length,
      label: 'connections',
      details: connections.length + ' connections exported (' + resolvedCount + ' with full profiles)',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'linkedin',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + connections.length + ' connections (' + resolvedCount + ' with full profiles)');
})();
