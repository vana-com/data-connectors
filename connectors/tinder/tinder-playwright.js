/**
 * Tinder Connector (Playwright) — API Extraction via httpFetch
 *
 * Strategy: Browser login (manual, since Tinder uses phone OTP) →
 *   extract X-Auth-Token from IndexedDB → closeBrowser → httpFetch to api.gotinder.com
 *
 * Data scopes:
 *   - tinder.profile — name, bio, photos, age, preferences
 *   - tinder.matches — match list with profiles
 *   - tinder.messages — conversation history per match
 *
 * API host: https://api.gotinder.com
 * Auth: X-Auth-Token header
 */

// ─── Credentials ─────────────────────────────────────────────

let PLATFORM_LOGIN = process.env.USER_LOGIN_TINDER || '';
let PLATFORM_PASSWORD = process.env.USER_PASSWORD_TINDER || '';
let PLATFORM_TOKEN = process.env.USER_TOKEN_TINDER || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const url = window.location.href;

        // Still on landing/login/auth pages
        if (url.includes('/landing') || url.includes('accounts.google') ||
            url.includes('facebook.com') || url.includes('/sms-verification')) return false;

        // On the app = logged in
        if (url.includes('/app/') || url.includes('/app')) return true;

        // Check for app shell elements
        const hasApp = !!document.querySelector('[data-testid="profileCard"]') ||
                       !!document.querySelector('nav[role="tablist"]') ||
                       !!document.querySelector('a[href="/app/recs"]') ||
                       !!document.querySelector('a[href="/app/profile"]');
        return hasApp;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Token Extraction ────────────────────────────────────────

const extractAuthToken = async () => {
  // Tinder stores the auth token in IndexedDB (keyval-store → keyval → persist::mfa)
  // Also check localStorage and cookies as fallbacks
  try {
    return await page.evaluate(`
      (async () => {
        // Method 1: IndexedDB (keyval-store)
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('keyval-store');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const tx = db.transaction('keyval', 'readonly');
          const store = tx.objectStore('keyval');
          const data = await new Promise((resolve, reject) => {
            const req = store.get('persist::mfa');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          db.close();
          if (data && data.authToken) return data.authToken;
          if (typeof data === 'string') {
            try {
              const parsed = JSON.parse(data);
              if (parsed.authToken) return parsed.authToken;
            } catch {}
          }
        } catch {}

        // Method 2: Try other IndexedDB keys
        try {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('keyval-store');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const tx = db.transaction('keyval', 'readonly');
          const store = tx.objectStore('keyval');
          const allKeys = await new Promise((resolve, reject) => {
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          for (const key of allKeys) {
            const val = await new Promise((resolve, reject) => {
              const req = store.get(key);
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
            if (val && typeof val === 'object' && val.authToken) {
              db.close();
              return val.authToken;
            }
            if (typeof val === 'string' && val.length > 30 && val.length < 200) {
              try {
                const p = JSON.parse(val);
                if (p.authToken) { db.close(); return p.authToken; }
              } catch {}
            }
          }
          db.close();
        } catch {}

        // Method 3: localStorage
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            if (key.includes('token') || key.includes('auth')) {
              try {
                const parsed = JSON.parse(val);
                if (parsed.authToken) return parsed.authToken;
                if (typeof parsed === 'string' && parsed.length > 30) return parsed;
              } catch {
                if (val && val.length > 30 && val.length < 200) return val;
              }
            }
          }
        } catch {}

        return null;
      })()
    `);
  } catch (e) {
    return null;
  }
};

// ─── API Helper ──────────────────────────────────────────────

let authToken = '';

const tinderFetch = async (endpoint) => {
  const url = 'https://api.gotinder.com' + endpoint;
  try {
    const resp = await page.httpFetch(url, {
      headers: {
        'X-Auth-Token': authToken,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    if (!resp.ok) return { _error: resp.status };
    return resp.json || {};
  } catch (e) {
    return { _error: e.message || String(e) };
  }
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 4;

  // ═══ PHASE 1: Login ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    // If we have a pre-existing auth token, try using it directly
    if (PLATFORM_TOKEN) {
      authToken = PLATFORM_TOKEN;
    }

    await page.showBrowser('https://tinder.com');
    await page.setData('status', 'Please log in to Tinder...');
    await page.sleep(2000);

    // Pre-fill phone number if provided via env (Tinder uses OTP, so manual step still needed)
    if (PLATFORM_LOGIN) {
      const phoneStr = JSON.stringify(PLATFORM_LOGIN);
      await page.evaluate(`
        (() => {
          const phoneInput = document.querySelector('input[name="phone_number"], input[type="tel"]');
          if (phoneInput) {
            phoneInput.focus();
            phoneInput.value = ${phoneStr};
            phoneInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()
      `);
    }

    await page.promptUser(
      'Please log in to Tinder (phone number, Google, or Facebook). Click "Done" when you see your matches or profile.',
      async () => {
        return await checkLoginStatus();
      },
      2000
    );

    await page.setData('status', 'Login completed');
    await page.sleep(2000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ Extract auth token from browser before going headless ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Getting profile' },
    message: 'Extracting auth token...',
  });

  // Strategy 1: Extract token from IndexedDB/localStorage
  authToken = await extractAuthToken();

  // Strategy 2: Extract token by intercepting the Tinder web app's own API calls
  if (!authToken) {
    // Set up network capture before navigating to trigger API requests
    await page.captureNetwork({
      urlPattern: 'api.gotinder.com',
      key: 'tinder_api',
    });

    // Navigate to profile page to trigger authenticated API calls
    await page.goto('https://tinder.com/app/profile');
    await page.sleep(4000);

    // Try extracting the token from the web app's JavaScript context
    authToken = await page.evaluate(`
      (async () => {
        try {
          // Check all IndexedDB databases
          const dbs = await indexedDB.databases();
          for (const dbInfo of dbs) {
            try {
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open(dbInfo.name);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              const storeNames = Array.from(db.objectStoreNames);
              for (const storeName of storeNames) {
                try {
                  const tx = db.transaction(storeName, 'readonly');
                  const store = tx.objectStore(storeName);
                  const allValues = await new Promise((resolve, reject) => {
                    const req = store.getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                  });
                  for (const val of allValues) {
                    if (val && typeof val === 'object') {
                      // Check nested objects for authToken
                      const str = JSON.stringify(val);
                      const match = str.match(/"authToken"\\s*:\\s*"([^"]+)"/);
                      if (match) { db.close(); return match[1]; }
                      const match2 = str.match(/"api_token"\\s*:\\s*"([^"]+)"/);
                      if (match2) { db.close(); return match2[1]; }
                    }
                  }
                } catch {}
              }
              db.close();
            } catch {}
          }

          // Check sessionStorage
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            const val = sessionStorage.getItem(key);
            try {
              const match = val.match(/"authToken"\\s*:\\s*"([^"]+)"/);
              if (match) return match[1];
            } catch {}
          }

          // Check localStorage more broadly
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key);
            try {
              const match = val.match(/"authToken"\\s*:\\s*"([^"]+)"/);
              if (match) return match[1];
              const match2 = val.match(/"api_token"\\s*:\\s*"([^"]+)"/);
              if (match2) return match2[1];
            } catch {}
          }

          return null;
        } catch { return null; }
      })()
    `);
  }

  // Strategy 3: Try making API call directly from browser (same session)
  if (!authToken) {
    const browserApiResult = await page.evaluate(`
      (async () => {
        try {
          // The web app makes fetch calls with the token — try to call the API from within the page
          const resp = await fetch('https://api.gotinder.com/v2/profile?include=user', {
            credentials: 'include'
          });
          if (resp.ok) {
            const data = await resp.json();
            return { success: true, data: data };
          }
          return { success: false, status: resp.status };
        } catch(e) { return { success: false, error: e.message }; }
      })()
    `);

    if (browserApiResult && browserApiResult.success) {
      // We can extract data directly from the browser! Skip httpFetch entirely.
      await page.goHeadless();
      // Store the profile data for later use
      await page.setData('_browserProfile', browserApiResult.data);
    }
  }

  // ═══ Switch to headless + httpFetch mode ═══
  await page.goHeadless();
  await page.closeBrowser();

  // If we still don't have a token, try cookie-based auth
  if (!authToken) {
    const testResp = await tinderFetch('/v2/profile?include=user');
    if (!testResp._error) {
      // Cookie auth works without explicit token
      authToken = '_cookie_auth_';
    } else {
      await page.setData('error',
        'Could not extract auth token. Tinder may have changed their auth mechanism. Error: ' + testResp._error +
        '. Try setting USER_TOKEN_TINDER env var with your X-Auth-Token from browser DevTools.');
      return;
    }
  }

  // ═══ STEP 1: Fetch profile ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Getting profile' },
    message: 'Fetching your profile...',
  });

  const profileData = await tinderFetch('/v2/profile?include=user');
  if (profileData._error) {
    await page.setData('error', 'Failed to fetch profile: ' + profileData._error);
    return;
  }

  const user = profileData.data?.user || profileData.user || profileData;
  const profileResult = {
    name: user.name || '',
    bio: user.bio || '',
    birthDate: user.birth_date || '',
    gender: user.gender === 0 ? 'Male' : user.gender === 1 ? 'Female' : (user.gender_filter?.gender || ''),
    photos: (user.photos || []).map(p => ({
      id: p.id || '',
      url: p.url || (p.processedFiles?.[0]?.url) || '',
    })),
    city: user.city?.name || user.pos_info?.city?.name || '',
    jobTitle: user.jobs?.[0]?.title?.name || '',
    company: user.jobs?.[0]?.company?.name || '',
    school: user.schools?.[0]?.name || '',
    ageFilterMin: user.age_filter_min || '',
    ageFilterMax: user.age_filter_max || '',
    distanceFilter: user.distance_filter || '',
    createDate: user.create_date || '',
  };

  // ═══ STEP 2: Fetch matches ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching matches' },
    message: 'Fetching your matches...',
  });

  const allMatches = [];
  let matchPageToken = '';
  let matchPage = 0;
  const MAX_MATCH_PAGES = 50;

  while (matchPage < MAX_MATCH_PAGES) {
    const endpoint = '/v2/matches?count=60' +
      (matchPageToken ? '&page_token=' + matchPageToken : '');
    const matchData = await tinderFetch(endpoint);
    if (matchData._error) break;

    const matches = matchData.data?.matches || [];
    if (matches.length === 0) break;

    for (const m of matches) {
      allMatches.push({
        id: m._id || m.id || '',
        person: {
          name: m.person?.name || '',
          bio: m.person?.bio || '',
          birthDate: m.person?.birth_date || '',
          photos: (m.person?.photos || []).slice(0, 1).map(p => p.url || (p.processedFiles?.[0]?.url) || ''),
        },
        createdDate: m.created_date || '',
        lastActivityDate: m.last_activity_date || '',
        messageCount: m.message_count || 0,
        isSuperLike: m.is_super_like || false,
      });
    }

    await page.setProgress({
      phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching matches' },
      message: 'Fetched ' + allMatches.length + ' matches...',
      count: allMatches.length,
    });

    matchPageToken = matchData.data?.next_page_token || '';
    if (!matchPageToken) break;
    matchPage++;
    await page.sleep(500);
  }

  // ═══ STEP 3: Fetch messages for matches that have them ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching messages' },
    message: 'Fetching conversations...',
  });

  const matchesWithMessages = allMatches.filter(m => m.messageCount > 0);
  const allConversations = [];
  let msgIdx = 0;

  for (const match of matchesWithMessages.slice(0, 100)) { // cap at 100 conversations
    const msgEndpoint = '/v2/matches/' + match.id + '/messages?count=100';
    const msgData = await tinderFetch(msgEndpoint);

    if (!msgData._error) {
      const messages = (msgData.data?.messages || []).map(msg => ({
        from: msg.from === user._id ? 'me' : match.person?.name || 'match',
        message: msg.message || '',
        sentDate: msg.sent_date || '',
        type: msg.type || 'text',
      }));

      if (messages.length > 0) {
        allConversations.push({
          matchId: match.id,
          personName: match.person?.name || '',
          matchDate: match.createdDate,
          messageCount: messages.length,
          messages: messages,
        });
      }
    }

    msgIdx++;
    if (msgIdx % 5 === 0) {
      await page.setProgress({
        phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching messages' },
        message: 'Fetched messages from ' + msgIdx + ' of ' + matchesWithMessages.length + ' conversations...',
        count: msgIdx,
      });
      await page.sleep(300);
    }
  }

  // ═══ STEP 4: Build result ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const totalMessages = allConversations.reduce((sum, c) => sum + c.messageCount, 0);

  const result = {
    'tinder.profile': profileResult,
    'tinder.matches': {
      matches: allMatches.map(m => ({
        personName: m.person.name,
        personBio: m.person.bio,
        matchDate: m.createdDate,
        lastActivity: m.lastActivityDate,
        messageCount: m.messageCount,
        isSuperLike: m.isSuperLike,
      })),
    },
    'tinder.messages': {
      conversations: allConversations,
    },
    exportSummary: {
      count: 1 + allMatches.length + totalMessages,
      label: 'items',
      details: '1 profile, ' + allMatches.length + ' matches, ' + totalMessages + ' messages',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'tinder',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details + ' for ' + (profileResult.name || 'your profile'));
})();
