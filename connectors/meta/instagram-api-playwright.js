/**
 * Instagram Connector (API-first, Playwright)
 *
 * Exports:
 * - instagram.profile     — profile + business + viewer_relationship (rich)
 * - instagram.posts       — paginated user feed with media + engagement
 * - instagram.followers   — paginated followers list
 * - instagram.following   — paginated following list
 * - instagram.ads         — advertisers, ad_topics, ad_categories
 *
 * Extraction strategy: pure in-page fetch replay against Instagram's REST and
 * GraphQL endpoints. The only DOM interaction is for the login form, post-login
 * interstitial dismissal, and a single click path used to discover the rotating
 * ad_categories GraphQL doc_id. All scope data comes from JSON HTTP responses.
 */

const IG_APP_ID = '936619743392459';
const PLATFORM = 'instagram';
const VERSION = '2.0.0-api-playwright';
const CANONICAL_SCOPES = [
  'instagram.profile',
  'instagram.posts',
  'instagram.followers',
  'instagram.following',
  'instagram.ads',
];
const POSTS_PAGE_SIZE = 12;
const FRIENDSHIP_PAGE_SIZE = 50;
const REQUEST_DELAY_MS = 800;
const MAX_POSTS_PAGES = 50;
const MAX_FRIENDSHIP_PAGES = 2000;
const DISCOVERY_TIMEOUT_MS = 20000;
const DISCOVERY_POLL_MS = 250;
const MAX_LOGIN_ATTEMPTS = 3;

let PLATFORM_LOGIN = process.env.USER_LOGIN_INSTAGRAM || '';
let PLATFORM_PASSWORD = process.env.USER_PASSWORD_INSTAGRAM || '';

const makeConnectorError = (
  errorClass,
  reason,
  disposition,
  extras = {},
) => ({
  errorClass,
  reason,
  disposition,
  ...extras,
});

const makeFatalRunError = (errorClass, reason, phase = 'collect') => {
  const error = new Error(reason);
  error.telemetryError = makeConnectorError(errorClass, reason, 'fatal', {
    phase,
  });
  return error;
};

const inferErrorClass = (message, fallback = 'runtime_error') => {
  const text = String(message || '').toLowerCase();
  if (
    text.includes('auth') ||
    text.includes('login') ||
    text.includes('password') ||
    text.includes('credential')
  ) {
    return 'auth_failed';
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return 'timeout';
  }
  if (
    text.includes('network') ||
    text.includes('fetch') ||
    text.includes('net::') ||
    text.includes('http ')
  ) {
    return 'network_error';
  }
  if (text.includes('selector') || text.includes('not found')) {
    return 'selector_error';
  }
  return fallback;
};

const buildResult = ({ requestedScopes, scopes, errors, exportSummary }) => ({
  requestedScopes: [...requestedScopes],
  timestamp: new Date().toISOString(),
  version: VERSION,
  platform: PLATFORM,
  exportSummary,
  errors,
  ...scopes,
});

const buildEmptyResult = (requestedScopes, errors) =>
  buildResult({
    requestedScopes,
    scopes: {},
    errors,
    exportSummary: {
      count: 0,
      label: 'items',
      details: {
        posts: 0,
        followers: 0,
        following: 0,
        advertisers: 0,
        adTopics: 0,
        categories: 0,
      },
    },
  });

const resolveRequestedScopes = () => {
  const raw =
    typeof page.requestedScopes === 'function' ? page.requestedScopes() : null;
  if (raw == null) {
    return [...CANONICAL_SCOPES];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw makeFatalRunError(
      'protocol_violation',
      'Instagram connector received an empty or invalid requestedScopes array.',
      'init',
    );
  }
  const deduped = Array.from(new Set(raw));
  const invalid = deduped.filter((scope) => !CANONICAL_SCOPES.includes(scope));
  if (invalid.length > 0) {
    throw makeFatalRunError(
      'protocol_violation',
      `Instagram connector received unsupported requestedScopes: ${invalid.join(', ')}.`,
      'init',
    );
  }
  return deduped;
};

const setAuthState = async (state) => {
  try {
    await page.setData('auth_state', state);
  } catch (error) {
    // best effort — auth-state breadcrumbs must never fail the run
  }
};

// ─── In-page fetch helper ────────────────────────────────────

const fetchApi = async (url, options) => {
  const opts = options || {};
  const urlStr = JSON.stringify(url);
  const requestSpec = {
    method: opts.method || 'GET',
    headers: Object.assign({ 'x-ig-app-id': IG_APP_ID }, opts.headers || {}),
    body: opts.body !== undefined ? opts.body : null,
    asText: !!opts.asText,
  };
  const specStr = JSON.stringify(requestSpec);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const spec = ${specStr};
          const init = {
            method: spec.method,
            headers: spec.headers,
            credentials: 'include',
          };
          if (spec.body !== null && spec.body !== undefined) init.body = spec.body;
          const r = await fetch(${urlStr}, init);
          if (!r.ok) {
            return { _error: 'http ' + r.status + ' ' + r.statusText };
          }
          if (spec.asText) {
            return { _ok: true, text: await r.text() };
          }
          return { _ok: true, data: await r.json() };
        } catch (e) {
          return { _error: 'fetch error: ' + (e && e.message ? e.message : String(e)) };
        }
      })()
    `);
  } catch (e) {
    return { _error: 'evaluate error: ' + (e && e.message ? e.message : String(e)) };
  }
};

// ─── Login (API-based) ───────────────────────────────────────
// We POST credentials directly to /api/v1/web/accounts/login/ajax/ instead of
// performing a DOM form fill (no `input.value = ...` style automation). The
// password is wrapped in Instagram's v0 prefix format which is plaintext over
// HTTPS, accepted because the CSRF cookie proves a real browser context.

const LOGIN_URL = 'https://www.instagram.com/api/v1/web/accounts/login/ajax/';
const TWO_FACTOR_URL = 'https://www.instagram.com/api/v1/web/accounts/login/ajax/two_factor/';
const IG_PWD_PREFIX = '#PWD_INSTAGRAM_BROWSER:0:';

// Instagram is an SPA with long-polling XHR; the default page.goto `waitUntil: 'load'`
// regularly times out because `load` never fires. `domcontentloaded` is enough for
// connector replay (cookies + first-paint fetches) and is what opensteer uses.
const safeGoto = (url) => page.goto(url, { waitUntil: 'domcontentloaded' });

const readAuthUiSnapshot = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const textOf = (el) => (el && el.textContent ? el.textContent.trim() : '');
        const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
          .map(textOf)
          .filter(Boolean)
          .slice(0, 5);
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
          .map(textOf)
          .filter(Boolean)
          .slice(0, 6);
        const userSelector = 'input[name="username"], input[name="email"], input[aria-label*="Username"]';
        const passSelector = 'input[name="password"], input[name="pass"], input[aria-label*="Password"]';
        return {
          currentUrl: location.href,
          title: document.title || null,
          stillOnLoginForm:
            Boolean(document.querySelector(userSelector)) &&
            Boolean(document.querySelector(passSelector)),
          hasOtpInput:
            Boolean(document.querySelector('input[name="verificationCode"]')) ||
            Boolean(document.querySelector('input[name="security_code"]')) ||
            Boolean(document.querySelector('input[aria-label*="Security Code"]')) ||
            Boolean(document.querySelector('input[name="approvals_code"]')) ||
            Boolean(document.querySelector('input[autocomplete="one-time-code"]')),
          headings,
          buttons,
        };
      })()
    `);
  } catch (error) {
    return null;
  }
};

const buildAuthState = async (stage, extras = {}) => {
  const snapshot = (await readAuthUiSnapshot()) || {};
  return {
    stage,
    ...snapshot,
    ...extras,
  };
};

const readCsrfToken = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const m = document.cookie.match(/csrftoken=([^;]+)/);
        return m ? m[1] : null;
      })()
    `);
  } catch (e) {
    return null;
  }
};

const postLoginAjax = async (url, csrftoken, fields) => {
  const body = new URLSearchParams(fields).toString();
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-csrftoken': csrftoken,
    'x-requested-with': 'XMLHttpRequest',
    'x-instagram-ajax': '1',
    'x-ig-app-id': IG_APP_ID,
  };
  const reqStr = JSON.stringify({ url, body, headers });
  let raw;
  try {
    raw = await page.evaluate(`
      (async () => {
        try {
          const req = ${reqStr};
          const r = await fetch(req.url, {
            method: 'POST',
            headers: req.headers,
            credentials: 'include',
            body: req.body,
          });
          const text = await r.text();
          return { status: r.status, text: text };
        } catch (e) {
          return { _error: 'fetch error: ' + (e && e.message ? e.message : String(e)) };
        }
      })()
    `);
  } catch (e) {
    return { kind: 'error', message: 'evaluate error: ' + (e && e.message ? e.message : String(e)) };
  }
  if (raw && raw._error) return { kind: 'error', message: raw._error };
  let json;
  try {
    json = JSON.parse(raw.text || '');
  } catch (e) {
    return { kind: 'error', message: 'invalid json (status=' + raw.status + '): ' + (raw.text || '').slice(0, 200) };
  }
  if (json.authenticated === true && json.status === 'ok') {
    return { kind: 'ok', userId: String(json.userId || json.user_id || '') };
  }
  if (json.two_factor_required === true) {
    const info = json.two_factor_info || {};
    return {
      kind: 'two_factor',
      info: {
        username: String(info.username || ''),
        twoFactorIdentifier: String(info.two_factor_identifier || ''),
      },
    };
  }
  if (typeof json.checkpoint_url === 'string') {
    if (json.error_type === 'AuthPlatformLoginChallengeException') {
      return { kind: 'auth_platform', url: json.checkpoint_url };
    }
    return { kind: 'checkpoint', url: json.checkpoint_url };
  }
  return {
    kind: 'error',
    message: json.message || json.error_type || 'unknown login response (status=' + raw.status + ')',
  };
};

const fetchWebInfo = async () => {
  try {
    const result = await page.evaluate(`
      (async () => {
        try {
          const response = await fetch("https://www.instagram.com/accounts/web_info/", {
            headers: { "X-Requested-With": "XMLHttpRequest" }
          });
          if (!response.ok) return { error: 'response not ok', status: response.status };

          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const scripts = doc.querySelectorAll('script[type="application/json"][data-sjs]');

          const findPolarisData = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (Array.isArray(obj) && obj[0] === 'PolarisViewer' && obj.length >= 3) {
              return obj[2];
            }
            for (const key in obj) {
              if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const found = findPolarisData(obj[key]);
                if (found) return found;
              }
            }
            return null;
          };

          let foundData = null;
          for (const script of scripts) {
            try {
              const jsonContent = JSON.parse(script.textContent);
              foundData = findPolarisData(jsonContent);
              if (foundData) break;
            } catch (e) {}
          }

          if (foundData && foundData.data) {
            return { success: true, data: foundData.data };
          }
          return { error: 'no polaris data found', scriptsCount: scripts.length };
        } catch (err) {
          return { error: err.message };
        }
      })()
    `);
    if (result && result.success) return result.data;
    return null;
  } catch (err) {
    return null;
  }
};

const dismissInterstitials = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(`
      (() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text.includes('allow all cookies') ||
              text.includes('allow essential and optional cookies') ||
              text.includes('decline optional cookies') ||
              text.includes('accept all') ||
              text === 'not now' || text === 'skip' || text === 'this was me') {
            btn.click();
            return text;
          }
        }
        return null;
      })()
    `);
    await page.sleep(2000);
  }
};

const readDsUserId = async () => {
  return await page.evaluate(`
    (() => {
      const m = document.cookie.match(/ds_user_id=([^;]+)/);
      return m ? m[1] : null;
    })()
  `);
};

const INVALID_CREDENTIAL_PATTERNS = [
  /incorrect/i,
  /wrong password/i,
  /invalid password/i,
  /try again/i,
  /sorry, your password was incorrect/i,
];

const isInvalidCredentialMessage = (message) =>
  INVALID_CREDENTIAL_PATTERNS.some((pattern) =>
    pattern.test(String(message || '')),
  );

const getCredentialPromptMessage = (attempt, lastError) => {
  if (!lastError) {
    return 'Log in to Instagram';
  }
  return `Instagram login failed: ${lastError}. Please try again.`;
};

const promptForCredentials = async (attempt, lastError = null) => {
  const supportsRequestInput = typeof page.requestInput === 'function';
  if (attempt === 1 && PLATFORM_LOGIN && PLATFORM_PASSWORD) {
    return {
      username: PLATFORM_LOGIN,
      password: PLATFORM_PASSWORD,
      source: 'env',
    };
  }
  if (!supportsRequestInput) {
    throw makeFatalRunError(
      'auth_failed',
      lastError
        ? `Instagram login failed: ${lastError}`
        : 'Instagram credentials are required but requestInput is unavailable.',
      'auth',
    );
  }
  const creds = await page.requestInput({
    message: getCredentialPromptMessage(attempt, lastError),
    schema: {
      type: 'object',
      properties: {
        username: { type: 'string', title: 'Instagram username, email, or phone' },
        password: { type: 'string', format: 'password', title: 'Password' },
      },
      required: ['username', 'password'],
    },
  });
  return {
    username: creds.username,
    password: creds.password,
    source: 'prompt',
  };
};

const handleAuthPlatformChallenge = async (challengeUrl) => {
  await setAuthState(
    await buildAuthState('auth_platform_challenge', {
      challengeUrl,
    }),
  );
  await page.setData('status', 'Navigating Instagram auth challenge...');
  const fullUrl = challengeUrl.startsWith('http')
    ? challengeUrl
    : 'https://www.instagram.com' + challengeUrl;
  await safeGoto(fullUrl);
  await page.sleep(2000);

  const { code } = await page.requestInput({
    message: 'Enter Instagram 2FA code',
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', title: '6-digit verification code' },
      },
      required: ['code'],
    },
  });
  const trimmedCode = String(code || '').trim();
  if (!/^\d{4,8}$/.test(trimmedCode)) {
    throw new Error('Invalid challenge code supplied: "' + code + '"');
  }

  await page.setData('status', 'Submitting challenge code...');
  const submitResult = await page.evaluate(`
    (() => {
      const input = document.querySelector('input[type="text"]');
      if (!input) return { ok: false, reason: 'no text input found' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(trimmedCode)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
      const cont = buttons.find(b => (b.textContent || '').trim().toLowerCase() === 'continue');
      if (!cont) return { ok: false, reason: 'no Continue button found' };
      cont.click();
      return { ok: true };
    })()
  `);
  if (!submitResult || submitResult.ok !== true) {
    throw new Error(
      'Failed to submit challenge code: ' +
        ((submitResult && submitResult.reason) || 'unknown')
    );
  }

  await page.setData('status', 'Waiting for session cookie...');
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.sleep(1000);
    const ds = await readDsUserId();
    if (ds) {
      await setAuthState(
        await buildAuthState('authenticated', {
          challengeCleared: true,
          dsUserId: ds,
        }),
      );
      await page.setData('status', 'Challenge cleared');
      return;
    }
  }
  throw new Error(
    'Challenge code submitted but ds_user_id cookie never appeared — code may have been rejected'
  );
};

const performLogin = async () => {
  const csrftoken = await readCsrfToken();
  if (!csrftoken) {
    throw new Error('csrftoken cookie missing after visiting instagram.com — cannot submit login');
  }
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    const creds = await promptForCredentials(attempt, lastError);
    PLATFORM_LOGIN = String(creds.username || '').trim();
    PLATFORM_PASSWORD = String(creds.password || '');

    await setAuthState(
      await buildAuthState('submitting_credentials', {
        attempt,
        credentialSource: creds.source,
      }),
    );
    await page.setData('status', 'Submitting login credentials...');
    const wrappedPwd =
      IG_PWD_PREFIX + Math.floor(Date.now() / 1000) + ':' + PLATFORM_PASSWORD;
    const result = await postLoginAjax(LOGIN_URL, csrftoken, {
      username: PLATFORM_LOGIN,
      enc_password: wrappedPwd,
      queryParams: '{}',
      optIntoOneTap: 'false',
      trustedDeviceRecords: '{}',
    });

    if (result.kind === 'ok') {
      await setAuthState(
        await buildAuthState('submitted_credentials', {
          attempt,
          loginResult: 'ok',
        }),
      );
      return;
    }

    if (result.kind === 'two_factor') {
      await setAuthState(
        await buildAuthState('otp_required', {
          attempt,
          loginResult: 'two_factor',
        }),
      );
      const { code } = await page.requestInput({
        message: 'Enter your Instagram two-factor verification code',
        schema: {
          type: 'object',
          properties: { code: { type: 'string', title: '6-digit verification code' } },
          required: ['code'],
        },
      });
      const refreshedCsrf = (await readCsrfToken()) || csrftoken;
      const second = await postLoginAjax(TWO_FACTOR_URL, refreshedCsrf, {
        username: PLATFORM_LOGIN,
        verificationCode: String(code).trim(),
        identifier: result.info.twoFactorIdentifier,
        queryParams: '{}',
        trust_signal_v2: 'true',
      });
      if (second.kind !== 'ok') {
        await setAuthState(
          await buildAuthState('otp_failed', {
            attempt,
            apiMessage: second.message || second.kind,
          }),
        );
        throw new Error('Two-factor verification failed: ' + (second.message || second.kind));
      }
      await setAuthState(
        await buildAuthState('submitted_otp', {
          attempt,
        }),
      );
      return;
    }

    if (result.kind === 'auth_platform') {
      await handleAuthPlatformChallenge(result.url);
      return;
    }

    if (result.kind === 'checkpoint') {
      await setAuthState(
        await buildAuthState('checkpoint_required', {
          attempt,
          checkpointUrl: result.url,
        }),
      );
      await page.setData(
        'status',
        'Login API returned checkpoint challenge — falling back to headed login',
      );
      return;
    }

    const message = result.message || result.kind;
    if (isInvalidCredentialMessage(message)) {
      lastError = message;
      await setAuthState(
        await buildAuthState('invalid_credentials', {
          attempt,
          apiMessage: message,
        }),
      );
      if (attempt === MAX_LOGIN_ATTEMPTS) {
        break;
      }
      continue;
    }

    await setAuthState(
      await buildAuthState('login_api_error', {
        attempt,
        apiMessage: message,
      }),
    );
    throw new Error('Instagram login failed: ' + message);
  }

  throw new Error(
    `Instagram login failed after ${MAX_LOGIN_ATTEMPTS} attempts: ${lastError || 'invalid credentials'}`,
  );
};

const checkLoginStatus = async () => {
  const info = await fetchWebInfo();
  return !!(info && info.username);
};

const ensureLoggedIn = async () => {
  await setAuthState(await buildAuthState('checking_login'));
  await page.setData('status', 'Checking login status...');
  await safeGoto('https://www.instagram.com/');
  await page.sleep(2000);

  let info = await fetchWebInfo();
  if (info && info.username) {
    await setAuthState(
      await buildAuthState('authenticated', {
        restoredSession: true,
      }),
    );
    await page.setData('status', 'Session restored');
    return info;
  }

  await setAuthState(await buildAuthState('login_required'));
  await page.setData('status', 'Logging in...');
  await performLogin();

  for (let attempt = 0; attempt < 3; attempt++) {
    info = await fetchWebInfo();
    if (info && info.username) {
      await setAuthState(
        await buildAuthState('authenticated', {
          restoredSession: false,
        }),
      );
      await page.setData('status', 'Login successful');
      return info;
    }
    await page.sleep(1500);
  }

  await setAuthState(await buildAuthState('manual_verification_required'));
  const { headed } = await page.showBrowser('https://www.instagram.com/accounts/login/');
  if (!headed) {
    throw new Error('Instagram login failed and headed fallback unavailable');
  }
  await page.setData('status', 'Please complete login in the browser, then click Done...');
  await page.promptUser(
    'Complete Instagram login (including any 2FA), then click Done.',
    checkLoginStatus,
    2000
  );
  await page.goHeadless();
  await dismissInterstitials();

  info = await fetchWebInfo();
  if (!info || !info.username) {
    await setAuthState(await buildAuthState('auth_failed_after_fallback'));
    throw new Error('Instagram login failed after headed fallback');
  }
  await setAuthState(
    await buildAuthState('authenticated', {
      completedManualFallback: true,
    }),
  );
  return info;
};

// ─── Profile collector ───────────────────────────────────────

const nullOr = (v) => (v === undefined || v === null ? null : v);

const mapProfile = (u, fallbackUsername) => {
  const pk = u.pk != null ? String(u.pk) : (u.id != null ? String(u.id) : null);
  return {
    username: u.username || fallbackUsername,
    full_name: nullOr(u.full_name),
    bio: nullOr(u.biography),
    biography_with_entities: nullOr(u.biography_with_entities),
    pronouns: nullOr(u.pronouns),
    bio_links: nullOr(u.bio_links),
    external_url: nullOr(u.external_url),
    external_url_linkshimmed: nullOr(u.external_url_linkshimmed),
    fb_profile_biolink: nullOr(u.fb_profile_biolink),

    profile_pic_url: nullOr(u.profile_pic_url),
    hd_profile_pic_url: nullOr(u.profile_pic_url_hd),

    pk: pk,
    id: nullOr(u.id) || pk,
    fbid: nullOr(u.fbid),
    eimu_id: nullOr(u.eimu_id),

    follower_count: nullOr(u.edge_followed_by && u.edge_followed_by.count),
    following_count: nullOr(u.edge_follow && u.edge_follow.count),
    media_count: nullOr(u.edge_owner_to_timeline_media && u.edge_owner_to_timeline_media.count),
    highlight_reel_count: nullOr(u.highlight_reel_count),
    pinned_channels_list_count: nullOr(u.pinned_channels_list_count),

    is_private: nullOr(u.is_private),
    is_verified: nullOr(u.is_verified),
    is_verified_by_mv4b: nullOr(u.is_verified_by_mv4b),
    is_business: nullOr(u.is_business_account),
    is_professional_account: nullOr(u.is_professional_account),
    is_supervised_user: nullOr(u.is_supervised_user),
    is_supervision_enabled: nullOr(u.is_supervision_enabled),
    is_joined_recently: nullOr(u.is_joined_recently),
    is_embeds_disabled: nullOr(u.is_embeds_disabled),
    is_regulated_c18: nullOr(u.is_regulated_c18),
    hide_like_and_view_counts: nullOr(u.hide_like_and_view_counts),
    ai_agent_type: nullOr(u.ai_agent_type),

    has_clips: nullOr(u.has_clips),
    has_channel: nullOr(u.has_channel),
    has_guides: nullOr(u.has_guides),
    has_ar_effects: nullOr(u.has_ar_effects),
    has_chaining: nullOr(u.has_chaining),

    country_block: nullOr(u.country_block),
    should_show_category: nullOr(u.should_show_category),
    should_show_public_contacts: nullOr(u.should_show_public_contacts),
    show_account_transparency_details: nullOr(u.show_account_transparency_details),
    transparency_label: nullOr(u.transparency_label),
    transparency_product: nullOr(u.transparency_product),

    business: {
      is_business_account: nullOr(u.is_business_account),
      category_name: nullOr(u.category_name),
      business_category_name: nullOr(u.business_category_name),
      overall_category_name: nullOr(u.overall_category_name),
      category_enum: nullOr(u.category_enum),
      business_contact_method: nullOr(u.business_contact_method),
      business_email: nullOr(u.business_email),
      business_phone_number: nullOr(u.business_phone_number),
      business_address_json: nullOr(u.business_address_json),
    },

    viewer_relationship: {
      followed_by_viewer: nullOr(u.followed_by_viewer),
      follows_viewer: nullOr(u.follows_viewer),
      requested_by_viewer: nullOr(u.requested_by_viewer),
      has_requested_viewer: nullOr(u.has_requested_viewer),
      blocked_by_viewer: nullOr(u.blocked_by_viewer),
      has_blocked_viewer: nullOr(u.has_blocked_viewer),
      restricted_by_viewer: nullOr(u.restricted_by_viewer),
      is_guardian_of_viewer: nullOr(u.is_guardian_of_viewer),
      is_supervised_by_viewer: nullOr(u.is_supervised_by_viewer),
      mutual_followed_by_count: nullOr(u.edge_mutual_followed_by && u.edge_mutual_followed_by.count),
    },

    collected_at: new Date().toISOString(),
  };
};

const collectProfile = async (username) => {
  const url = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username);
  const res = await fetchApi(url);
  if (res._error) throw new Error('profile fetch failed: ' + res._error);
  const user = res.data && res.data.data && res.data.data.user;
  if (!user) throw new Error('profile: no user in response for ' + username);
  return mapProfile(user, username);
};

// ─── Posts collector ─────────────────────────────────────────

const mapPost = (item) => {
  const candidates = (item.image_versions2 && item.image_versions2.candidates) || [];
  const carousel = item.carousel_media || [];
  const carouselFirst = carousel[0] && carousel[0].image_versions2 && carousel[0].image_versions2.candidates;
  const videoVersions = item.video_versions || [];
  const img_url =
    (candidates[0] && candidates[0].url) ||
    (carouselFirst && carouselFirst[0] && carouselFirst[0].url) ||
    (videoVersions[0] && videoVersions[0].url) ||
    '';
  const caption = (item.caption && item.caption.text) || '';
  const num_of_likes = typeof item.like_count === 'number' ? item.like_count : 0;
  const facepile = item.facepile_top_likers || [];
  const who_liked = facepile.map((l) => ({
    pk: l.pk != null ? String(l.pk) : (l.id != null ? String(l.id) : ''),
    username: l.username || '',
    profile_pic_url: l.profile_pic_url || '',
    id: l.id != null ? String(l.id) : (l.pk != null ? String(l.pk) : ''),
  }));
  return {
    pk: item.pk != null ? String(item.pk) : null,
    id: item.id || null,
    code: item.code || null,
    media_type: item.media_type != null ? item.media_type : null,
    taken_at: item.taken_at != null ? item.taken_at : null,
    img_url,
    caption,
    num_of_likes,
    comment_count: typeof item.comment_count === 'number' ? item.comment_count : null,
    is_video: !!item.video_versions,
    video_url: (videoVersions[0] && videoVersions[0].url) || null,
    carousel_count: carousel.length || null,
    location: item.location ? {
      pk: item.location.pk != null ? String(item.location.pk) : null,
      name: item.location.name || null,
      city: item.location.city || null,
      lat: item.location.lat != null ? item.location.lat : null,
      lng: item.location.lng != null ? item.location.lng : null,
    } : null,
    who_liked,
  };
};

const postKey = (item) => String(item.id || item.pk || item.media_id || item.code || '');

const collectPosts = async (userId, onProgress) => {
  const posts = [];
  const seen = new Set();
  let maxId = null;
  let pageNum = 0;
  let issue = null;
  while (pageNum < MAX_POSTS_PAGES) {
    pageNum++;
    const params = new URLSearchParams({ count: String(POSTS_PAGE_SIZE) });
    if (maxId) params.set('max_id', maxId);
    const url = 'https://www.instagram.com/api/v1/feed/user/' + encodeURIComponent(userId) + '/?' + params.toString();
    const res = await fetchApi(url);
    if (res._error) {
      if (pageNum === 1) throw new Error('posts page 1 failed: ' + res._error);
      issue = makeConnectorError(
        'upstream_error',
        `Instagram posts pagination failed after ${posts.length} posts: ${res._error}`,
        'degraded',
        { scope: 'instagram.posts', phase: 'collect' },
      );
      break;
    }
    const data = res.data || {};
    if (data.status && data.status !== 'ok') {
      if (pageNum === 1) throw new Error('posts status=' + data.status + ' message=' + (data.message || ''));
      issue = makeConnectorError(
        'upstream_error',
        `Instagram posts pagination returned status=${data.status}: ${data.message || 'unknown error'}`,
        'degraded',
        { scope: 'instagram.posts', phase: 'collect' },
      );
      break;
    }
    const items = data.items || [];
    for (const item of items) {
      const key = postKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      posts.push(mapPost(item));
    }
    if (onProgress) await onProgress(posts.length);
    if (data.more_available === false || !data.next_max_id || items.length === 0) break;
    maxId = data.next_max_id;
    await page.sleep(REQUEST_DELAY_MS);
  }
  if (!issue && pageNum === MAX_POSTS_PAGES && maxId) {
    issue = makeConnectorError(
      'upstream_error',
      `Instagram posts pagination exceeded the connector page limit (${MAX_POSTS_PAGES}).`,
      'degraded',
      { scope: 'instagram.posts', phase: 'collect' },
    );
  }
  return { posts, error: issue };
};

// ─── Followers / Following ───────────────────────────────────

const mapFriendshipUser = (u) => ({
  pk: u.pk != null ? String(u.pk) : (u.id != null ? String(u.id) : ''),
  username: u.username || '',
  full_name: u.full_name || '',
  is_private: !!u.is_private,
  is_verified: !!u.is_verified,
  profile_pic_url: u.profile_pic_url || '',
  is_possible_scammer: u.is_possible_scammer != null ? !!u.is_possible_scammer : null,
  has_anonymous_profile_picture: u.has_anonymous_profile_picture != null ? !!u.has_anonymous_profile_picture : null,
});

const collectFriendshipList = async (userId, kind, expectedCount, onProgress) => {
  const list = [];
  const seen = new Set();
  let maxId = null;
  let pageNum = 0;
  let issue = null;
  while (pageNum < MAX_FRIENDSHIP_PAGES) {
    pageNum++;
    const params = new URLSearchParams({
      count: String(FRIENDSHIP_PAGE_SIZE),
      search_surface: 'follow_list_page',
    });
    if (maxId) params.set('max_id', maxId);
    const url = 'https://www.instagram.com/api/v1/friendships/' + encodeURIComponent(userId) + '/' + kind + '/?' + params.toString();
    const res = await fetchApi(url);
    if (res._error) {
      if (pageNum === 1) throw new Error(kind + ' page 1 failed: ' + res._error);
      issue = makeConnectorError(
        'upstream_error',
        `Instagram ${kind} pagination failed after ${list.length} records: ${res._error}`,
        'degraded',
        { scope: `instagram.${kind}`, phase: 'collect' },
      );
      break;
    }
    const data = res.data || {};
    const users = data.users || [];
    for (const u of users) {
      const key = String(u.pk || u.id || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push(mapFriendshipUser(u));
    }
    if (onProgress) await onProgress(list.length);
    if (!data.next_max_id || users.length === 0) break;
    maxId = data.next_max_id;
    await page.sleep(REQUEST_DELAY_MS);
  }
  if (
    !issue &&
    typeof expectedCount === 'number' &&
    expectedCount > 0 &&
    list.length < expectedCount &&
    maxId
  ) {
    issue = makeConnectorError(
      'upstream_error',
      `Instagram ${kind} collection stopped before the expected count (${list.length}/${expectedCount}).`,
      'degraded',
      { scope: `instagram.${kind}`, phase: 'collect' },
    );
  }
  if (!issue && pageNum === MAX_FRIENDSHIP_PAGES && maxId) {
    issue = makeConnectorError(
      'upstream_error',
      `Instagram ${kind} pagination exceeded the connector page limit (${MAX_FRIENDSHIP_PAGES}).`,
      'degraded',
      { scope: `instagram.${kind}`, phase: 'collect' },
    );
  }
  return { records: list, error: issue };
};

// ─── Ads: SSR preloader extraction (advertisers + ad_topics) ─

const extractDataSjsBlocks = (html) => {
  const blocks = [];
  const re = /<script type="application\/json"[^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const text = match[1];
    if (!text.includes('fxcal_settings')) continue;
    try {
      const parsed = JSON.parse(text);
      const bbox1 = parsed && parsed.require && parsed.require[0] && parsed.require[0][3];
      const outer = bbox1 && bbox1[0];
      const req = outer && outer.__bbox && outer.__bbox.require && outer.__bbox.require[0];
      const triple = req && req[3];
      const inner = triple && triple[1];
      const data = inner && inner.__bbox && inner.__bbox.result && inner.__bbox.result.data;
      if (data !== undefined) blocks.push({ data });
    } catch (e) {}
  }
  return blocks;
};

const findBlockByShape = (blocks, predicate) => {
  for (const b of blocks) {
    if (predicate(b.data)) return b.data;
  }
  return undefined;
};

const isApcNodeData = (d) => {
  const apc = d && d.fxcal_settings && d.fxcal_settings.apcNode;
  return !!(apc && apc.recently_interacted_ad_collection);
};

const isTopicsNodeData = (d) => {
  const ddt = d && d.fxcal_settings && d.fxcal_settings.node &&
              d.fxcal_settings.node.ad_topics_control_content &&
              d.fxcal_settings.node.ad_topics_control_content.ad_topics_control_ddt_section_content;
  return !!ddt;
};

const fetchAccountsCenterHtml = async (path) => {
  await safeGoto('https://accountscenter.instagram.com' + path);
  await page.sleep(1500);
  const html = await page.evaluate(`document.documentElement.outerHTML`);
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('accounts center HTML fetch returned empty for ' + path);
  }
  return html;
};

const collectAdvertisers = async () => {
  const html = await fetchAccountsCenterHtml('/ads/');
  const blocks = extractDataSjsBlocks(html);
  const data = findBlockByShape(blocks, isApcNodeData);
  if (!data) throw new Error('advertisers: apcNode preloader not found in /ads/ HTML');
  const apc = data.fxcal_settings.apcNode;

  const byName = new Map();
  const upsert = (name, source, patch) => {
    const existing = byName.get(name);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      for (const k in patch) {
        if (patch[k] !== undefined && existing[k] === undefined) existing[k] = patch[k];
      }
    } else {
      byName.set(name, Object.assign({ name, sources: [source] }, patch));
    }
  };

  const addCollection = (nodes, source) => {
    for (const node of nodes || []) {
      const name = node && node.advertiser && node.advertiser.advertiser_name;
      if (!name) continue;
      upsert(name, source, {
        pic: node.advertiser.advertiser_pic,
        token: node.token,
        ad_image_url: node.ad && node.ad.image_url,
        display_title: node.display_content && node.display_content.overall_title,
      });
    }
  };
  addCollection(apc.recently_interacted_ad_collection && apc.recently_interacted_ad_collection.nodes, 'recently_interacted');
  addCollection(apc.saved_ad_collection && apc.saved_ad_collection.nodes, 'saved');
  addCollection(apc.recommended_ad_collection && apc.recommended_ad_collection.nodes, 'recommended');
  for (const adv of apc.advertisers_data_v2 || []) {
    if (!adv || !adv.advertiser_name) continue;
    upsert(adv.advertiser_name, 'all_advertisers', {
      id: adv.id,
      page_id: adv.page_id,
      identity_id: adv.identity_id,
      image_url: adv.image_url,
      fb_follows_count: adv.fb_follows_count,
      is_hidden: adv.is_hidden,
    });
  }
  return Array.from(byName.values());
};

const collectAdTopics = async () => {
  const html = await fetchAccountsCenterHtml('/ads/ad_topics/');
  const blocks = extractDataSjsBlocks(html);
  const data = findBlockByShape(blocks, isTopicsNodeData);
  if (!data) throw new Error('ad_topics: ddt preloader not found in /ads/ad_topics/ HTML');
  const ddt = data.fxcal_settings.node.ad_topics_control_content.ad_topics_control_ddt_section_content;
  const rawTopics = ddt.ad_topics_control_ddt_section_topics || [];
  return rawTopics.map((raw) => ({
    id: raw && raw.id,
    name: (raw && (raw.name || raw.topic_name)) || null,
    raw,
  }));
};

// ─── Ads: ad_categories with runtime discovery ───────────────

const FB_DTSG_REGEX = /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/;
const LSD_REGEX = /\["LSD",\[\],\{"token":"([^"]+)"/;
const JAZOEST_REGEX = /jazoest=(\d+)/;

const extractMetaTokens = (html) => {
  const fb_dtsg = FB_DTSG_REGEX.exec(html);
  const lsd = LSD_REGEX.exec(html);
  const jazoest = JAZOEST_REGEX.exec(html);
  if (!fb_dtsg || !lsd || !jazoest) {
    throw new Error('extractMetaTokens: missing fb_dtsg/lsd/jazoest in HTML');
  }
  return { fb_dtsg: fb_dtsg[1], lsd: lsd[1], jazoest: jazoest[1] };
};

const installGraphqlInterceptor = async () => {
  await page.evaluate(`
    (() => {
      if (window.__igPatched__) return;
      window.__igPatched__ = true;
      window.__igAllGraphql__ = [];
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        let urlStr = '';
        try {
          if (typeof input === 'string') urlStr = input;
          else if (input && input.url) urlStr = input.url;
        } catch (e) {}
        let reqBody = '';
        try {
          if (init && init.body != null) {
            if (typeof init.body === 'string') reqBody = init.body;
            else if (init.body instanceof URLSearchParams) reqBody = init.body.toString();
            else reqBody = String(init.body);
          }
        } catch (e) {}
        const res = await origFetch.call(this, input, init);
        if (urlStr.includes('/api/graphql/')) {
          const entry = { body: reqBody, response: '' };
          window.__igAllGraphql__.push(entry);
          try {
            const clone = res.clone();
            clone.text().then(function(t) { entry.response = t; }).catch(function() {});
          } catch (e) {}
        }
        return res;
      };
    })()
  `);
};

const readCapturedGraphql = async () => {
  const raw = await page.evaluate(`JSON.stringify(window.__igAllGraphql__ || [])`);
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

const discoverAdCategoriesQuery = async () => {
  await safeGoto('https://accountscenter.instagram.com/ads/');
  await page.sleep(2500);
  await installGraphqlInterceptor();

  const clickedTab = await page.evaluate(`
    (() => {
      const tabs = document.querySelectorAll('[role="tab"]');
      for (const tab of tabs) {
        if ((tab.textContent || '').includes('Manage info')) {
          tab.click();
          return true;
        }
      }
      return false;
    })()
  `);
  if (!clickedTab) {
    throw new Error('ad_categories discovery: Manage info tab not found');
  }
  await page.sleep(1500);

  const clickedLink = await page.evaluate(`
    (() => {
      const links = document.querySelectorAll('a, [role="link"]');
      for (const link of links) {
        if ((link.textContent || '').includes('Categories used to reach you')) {
          link.click();
          return true;
        }
      }
      return false;
    })()
  `);
  if (!clickedLink) {
    throw new Error('ad_categories discovery: Categories link not found');
  }

  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.sleep(DISCOVERY_POLL_MS);
    const entries = await readCapturedGraphql();
    for (const entry of entries) {
      if (!entry || typeof entry.response !== 'string') continue;
      if (!entry.response.includes('profile_info_categories_associated_with_you_data')) continue;
      let params;
      try { params = new URLSearchParams(entry.body || ''); } catch (e) { continue; }
      const docId = params.get('doc_id');
      const friendlyName = params.get('fb_api_req_friendly_name');
      const variablesJson = params.get('variables');
      if (!docId || !/^\d+$/.test(docId)) continue;
      if (!friendlyName || !variablesJson) continue;
      let variables;
      try { variables = JSON.parse(variablesJson); } catch (e) { continue; }
      if (!variables || typeof variables !== 'object') continue;
      return { doc_id: docId, friendly_name: friendlyName, variables_template: variables };
    }
  }
  throw new Error('ad_categories discovery: timed out waiting for GraphQL response');
};

const collectAdCategories = async () => {
  const discovered = await discoverAdCategoriesQuery();

  const html = await fetchAccountsCenterHtml('/ads/');
  const tokens = extractMetaTokens(html);

  const body = new URLSearchParams({
    fb_dtsg: tokens.fb_dtsg,
    lsd: tokens.lsd,
    jazoest: tokens.jazoest,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: discovered.friendly_name,
    variables: JSON.stringify(discovered.variables_template),
    server_timestamps: 'true',
    doc_id: discovered.doc_id,
  });
  const replay = await fetchApi('https://accountscenter.instagram.com/api/graphql/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-fb-friendly-name': discovered.friendly_name,
      'x-fb-lsd': tokens.lsd,
      'x-asbd-id': '359341',
    },
    body: body.toString(),
  });
  if (replay._error) throw new Error('ad_categories replay failed: ' + replay._error);
  const responseJson = replay.data || {};
  if (responseJson.errors) {
    throw new Error('ad_categories graphql errors: ' + JSON.stringify(responseJson.errors));
  }
  const cats = responseJson.data &&
               responseJson.data.fxcal_settings &&
               responseJson.data.fxcal_settings.node &&
               responseJson.data.fxcal_settings.node.profile_info_categories_associated_with_you_data;
  return cats || [];
};

// ─── Result transform ────────────────────────────────────────

const createProgressTracker = (requestedScopes) => {
  const requested = new Set(requestedScopes);
  const steps = [];
  // Profile is always fetched to resolve the logged-in account id.
  steps.push('Profile');
  if (requested.has('instagram.posts')) steps.push('Posts');
  if (requested.has('instagram.followers')) steps.push('Followers');
  if (requested.has('instagram.following')) steps.push('Following');
  if (requested.has('instagram.ads')) steps.push('Ads');

  const total = steps.length;
  let current = 0;
  return {
    total,
    async update(label, message, count) {
      if (!steps.includes(label)) {
        return;
      }
      current = Math.max(current, steps.indexOf(label) + 1);
      await page.setProgress({
        phase: { step: current, total, label },
        message,
        ...(count !== undefined ? { count } : {}),
      });
    },
  };
};

// ─── Main flow ───────────────────────────────────────────────

(async () => {
  let requestedScopes = [...CANONICAL_SCOPES];
  let initError = null;
  try {
    requestedScopes = resolveRequestedScopes();
  } catch (error) {
    initError = error;
  }

  try {
    if (initError) {
      throw initError;
    }

    const wantsScope = (scope) => requestedScopes.includes(scope);
    const wantsProfile = wantsScope('instagram.profile');
    const wantsPosts = wantsScope('instagram.posts');
    const wantsFollowers = wantsScope('instagram.followers');
    const wantsFollowing = wantsScope('instagram.following');
    const wantsAds = wantsScope('instagram.ads');
    const progress = createProgressTracker(requestedScopes);

    const identity = await ensureLoggedIn();
    const username = identity.username;
    if (!username) {
      throw makeFatalRunError(
        'auth_failed',
        'Could not determine username after Instagram login.',
        'auth',
      );
    }
    await page.setData('status', 'Logged in as @' + username);

    await safeGoto('https://www.instagram.com/');
    await page.sleep(1500);

    const state = { identity };
    const scopes = {};
    const errors = [];

    await progress.update('Profile', 'Fetching profile for @' + username);
    state.profile = await collectProfile(username);
    const userId = state.profile.id || state.profile.pk;
    if (!userId) {
      throw makeFatalRunError(
        'runtime_error',
        'Profile fetched but no user id was present.',
      );
    }

    if (wantsProfile) {
      scopes['instagram.profile'] = state.profile;
    }

    if (wantsPosts) {
      await progress.update('Posts', 'Fetching posts...');
      try {
        const postsResult = await collectPosts(userId, async (n) => {
          await progress.update('Posts', 'Captured ' + n + ' posts', n);
        });
        state.posts = postsResult.posts;
        scopes['instagram.posts'] = { posts: state.posts };
        if (postsResult.error) {
          errors.push(postsResult.error);
        }
      } catch (error) {
        errors.push(
          makeConnectorError(
            inferErrorClass(error?.message || String(error), 'upstream_error'),
            `Instagram posts collection failed: ${error?.message || String(error)}`,
            'omitted',
            { scope: 'instagram.posts', phase: 'collect' },
          ),
        );
      }
    }

    if (wantsFollowers) {
      await progress.update('Followers', 'Fetching followers...');
      try {
        const followersResult = await collectFriendshipList(
          userId,
          'followers',
          state.profile.follower_count,
          async (n) => {
            await progress.update('Followers', 'Captured ' + n + ' followers', n);
          },
        );
        state.followers = followersResult.records;
        scopes['instagram.followers'] = { followers: state.followers };
        if (followersResult.error) {
          errors.push(followersResult.error);
        }
      } catch (error) {
        errors.push(
          makeConnectorError(
            inferErrorClass(error?.message || String(error), 'upstream_error'),
            `Instagram followers collection failed: ${error?.message || String(error)}`,
            'omitted',
            { scope: 'instagram.followers', phase: 'collect' },
          ),
        );
      }
    }

    if (wantsFollowing) {
      await progress.update('Following', 'Fetching following...');
      try {
        const followingResult = await collectFriendshipList(
          userId,
          'following',
          state.profile.following_count,
          async (n) => {
            await progress.update('Following', 'Captured ' + n + ' following', n);
          },
        );
        state.following = followingResult.records;
        scopes['instagram.following'] = {
          following: state.following,
          accounts: state.following,
          total: state.following.length,
        };
        if (followingResult.error) {
          errors.push(followingResult.error);
        }
      } catch (error) {
        errors.push(
          makeConnectorError(
            inferErrorClass(error?.message || String(error), 'upstream_error'),
            `Instagram following collection failed: ${error?.message || String(error)}`,
            'omitted',
            { scope: 'instagram.following', phase: 'collect' },
          ),
        );
      }
    }

    if (wantsAds) {
      const adsFailures = [];
      let advertisersSucceeded = false;
      let adTopicsSucceeded = false;
      let categoriesSucceeded = false;

      await progress.update('Ads', 'Fetching advertisers...');
      try {
        state.advertisers = await collectAdvertisers();
        advertisersSucceeded = true;
      } catch (error) {
        adsFailures.push(
          `advertisers: ${error?.message || String(error)}`,
        );
      }

      await progress.update('Ads', 'Fetching ad topics...');
      try {
        state.ad_topics = await collectAdTopics();
        adTopicsSucceeded = true;
      } catch (error) {
        adsFailures.push(
          `ad_topics: ${error?.message || String(error)}`,
        );
      }

      await progress.update('Ads', 'Discovering ad categories query...');
      try {
        state.categories = await collectAdCategories();
        categoriesSucceeded = true;
      } catch (error) {
        adsFailures.push(
          `categories: ${error?.message || String(error)}`,
        );
      }

      const adsProduced =
        advertisersSucceeded || adTopicsSucceeded || categoriesSucceeded;
      if (adsProduced) {
        scopes['instagram.ads'] = {
          advertisers: state.advertisers || [],
          ad_topics: state.ad_topics || [],
          categories: state.categories || [],
        };
      }

      if (adsFailures.length > 0) {
        errors.push(
          makeConnectorError(
            inferErrorClass(adsFailures[0], 'upstream_error'),
            `Instagram ads collection ${adsProduced ? 'partially failed' : 'failed'}: ${adsFailures.join('; ')}`,
            adsProduced ? 'degraded' : 'omitted',
            { scope: 'instagram.ads', phase: 'collect' },
          ),
        );
      }
    }

    const posts = scopes['instagram.posts']?.posts || [];
    const followers = scopes['instagram.followers']?.followers || [];
    const following = scopes['instagram.following']?.following || [];
    const advertisers = scopes['instagram.ads']?.advertisers || [];
    const adTopics = scopes['instagram.ads']?.ad_topics || [];
    const categories = scopes['instagram.ads']?.categories || [];
    const detailParts = [];
    if (wantsProfile && scopes['instagram.profile']) detailParts.push('1 profile');
    if (wantsPosts) detailParts.push(posts.length + ' posts');
    if (wantsFollowers) detailParts.push(followers.length + ' followers');
    if (wantsFollowing) detailParts.push(following.length + ' following');
    if (wantsAds) {
      detailParts.push(advertisers.length + ' advertisers');
      detailParts.push(adTopics.length + ' ad topics');
      detailParts.push(categories.length + ' targeting categories');
    }

    const totalCount =
      posts.length +
      followers.length +
      following.length +
      advertisers.length +
      adTopics.length +
      categories.length;

    const result = buildResult({
      requestedScopes,
      scopes,
      errors,
      exportSummary: {
        count: totalCount,
        label: totalCount === 1 ? 'item' : 'items',
        details: {
          posts: posts.length,
          followers: followers.length,
          following: following.length,
          advertisers: advertisers.length,
          adTopics: adTopics.length,
          categories: categories.length,
        },
      },
    });

    await page.setData('result', result);
    await page.setData('status', 'Complete: ' + detailParts.join(', '));
    return result;
  } catch (error) {
    const telemetryError =
      error?.telemetryError ||
      makeConnectorError(
        inferErrorClass(error?.message || String(error)),
        error?.message || String(error),
        'fatal',
        { phase: 'collect' },
      );
    const result = buildEmptyResult(requestedScopes, [telemetryError]);
    await page.setData('result', result);
    await page.setData('error', telemetryError.reason);
    return result;
  }
})();
