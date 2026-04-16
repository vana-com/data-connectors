/**
 * Google My Activity Connector (API-first, Playwright)
 *
 * Exports:
 * - google.myactivity — cross-product activity feed (Search, Maps, YouTube,
 *   Play, Assistant, apps…) with timestamps, titles, URLs, and device info.
 *
 * Extraction strategy: pure in-page fetch replay against the
 * footprintsmyactivityui batchexecute endpoint. SSR initializer globals
 * (SNlM0e auth token, FdrFJe session id, boq build label, rpc-id map) are
 * scraped from the landing HTML and used to POST paginated batchexecute
 * calls. No DOM scraping for data.
 *
 * Login: interactive challenge loop driven by URL classification.
 *   Text-input challenges (email / password / TOTP / SMS / backup code) are
 *   prompted via page.requestInput and filled via the React-safe value
 *   setter + Google's stable primary-submit button jsname="LgbsSe".
 *   Non-input challenges (passkey, phone prompt, captcha, interstitials)
 *   fall back to a headed browser + page.promptUser.
 */

const MYACTIVITY_URL = 'https://myactivity.google.com/myactivity';
const IDENTIFIER_URL =
  'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&flowEntry=AddSession';

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_LOGIN_STEPS = 24;
const URL_CHANGE_TIMEOUT_MS = 30000;
const URL_POLL_INTERVAL_MS = 500;
const INTER_REQUEST_DELAY_MS = 250;

// Positional indices into the raw y3VFHd entry tuple (29-slot array).
const IDX_PRODUCT_IDS = 3;
const IDX_TIMESTAMP_MICROS = 4;
const IDX_ENTRY_ID = 5;
const IDX_PRODUCT_INFO = 7;
const IDX_CORE = 9;
const IDX_APP_INFO = 18;
const IDX_DEVICE_BLOCK = 19;

// Credentials are NOT cached across loop iterations. Google's /challenge/pwd
// page stays on the same URL after a wrong-password submit (the error is
// rendered inline), and /signin/identifier does the same for a wrong email,
// so any time runInteractiveLogin re-enters an input step it means the last
// attempt was rejected — we must re-prompt the user with a fresh dialog.

// ─── Generic helpers ─────────────────────────────────────────

const safeGoto = (url) => page.goto(url, { waitUntil: 'domcontentloaded' });

const currentUrl = async () => {
  try {
    const u = await page.evaluate('location.href');
    return typeof u === 'string' ? u : '';
  } catch (e) {
    return '';
  }
};

const getOuterHtml = async () => {
  try {
    return await page.evaluate('document.documentElement.outerHTML');
  } catch (e) {
    return '';
  }
};

// ─── SSR globals scrape ──────────────────────────────────────

const parseDsRpcIds = (html) => {
  // The SSR initializer block looks like:
  //   'ds:3' : {id:'y3VFHd',request:[[[]],null,100,null,[]]}
  // one entry per data slot. Scrape rather than hardcoding so Google-side
  // rpc id rotations are picked up automatically.
  const map = {};
  const re = /'(ds:\d+)'\s*:\s*\{\s*id\s*:\s*'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    map[m[1]] = m[2];
  }
  return map;
};

const extractMyActivityGlobals = (html) => {
  const snlM0e = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1];
  if (!snlM0e) {
    return { ok: false, reason: 'no SNlM0e in HTML (not logged in)' };
  }
  const fSid = (html.match(/"FdrFJe":"?(-?\d+)"?/) || [])[1];
  const bl = (html.match(/(boq_footprintsmyactivityuiserver_\d+\.\d+_p\d+)/) || [])[1];
  if (!fSid || !bl) {
    return {
      ok: false,
      reason: 'missing globals (FdrFJe=' + !!fSid + ' bl=' + !!bl + ')',
    };
  }
  const dsRpcIds = parseDsRpcIds(html);
  if (!dsRpcIds['ds:3']) {
    return { ok: false, reason: 'missing ds:3 rpc id' };
  }
  return { ok: true, globals: { snlM0e, fSid, bl, dsRpcIds } };
};

const loadMyActivityGlobals = async () => {
  await safeGoto(MYACTIVITY_URL);
  await page.sleep(1200);
  const html = await getOuterHtml();
  const parsed = extractMyActivityGlobals(html);
  if (!parsed.ok) {
    throw new Error('Failed to load My Activity globals: ' + parsed.reason);
  }
  return parsed.globals;
};

const MYACTIVITY_RE = /^https?:\/\/myactivity\.google\.com\/myactivity(?:[/?#]|$)/;
// Any google.com subdomain besides accounts.google.com — if we're here and
// not signing in, Google has already authenticated us.
const LOGGED_IN_GOOGLE_RE = /^https?:\/\/(?!accounts\.google\.com\/)(?:[a-z0-9-]+\.)*google\.com(?:[/?#]|$)/;

// Login check. On /myactivity we validate the SSR globals directly. On any
// other authenticated google.com domain (myaccount, mail, drive, etc.) we
// bounce once through MYACTIVITY_URL and re-check — this handles the common
// case where Google drops the user on myaccount.google.com after sign-in
// instead of continuing to the original URL. We never navigate while on
// accounts.google.com, so the login loop can keep its mid-flow state.
const checkLoginStatus = async () => {
  try {
    const url = await currentUrl();
    if (MYACTIVITY_RE.test(url)) {
      const html = await getOuterHtml();
      return extractMyActivityGlobals(html).ok;
    }
    if (LOGGED_IN_GOOGLE_RE.test(url)) {
      await safeGoto(MYACTIVITY_URL);
      await page.sleep(1200);
      const landed = await currentUrl();
      if (!MYACTIVITY_RE.test(landed)) return false;
      const html = await getOuterHtml();
      return extractMyActivityGlobals(html).ok;
    }
    return false;
  } catch (e) {
    return false;
  }
};

// ─── batchexecute ────────────────────────────────────────────

const callBatchExecute = async (globals, rpcId, rpcArg) => {
  const params = {
    rpcids: rpcId,
    'source-path': '/myactivity',
    'f.sid': globals.fSid,
    bl: globals.bl,
    hl: 'en',
    'soc-app': '712',
    'soc-platform': '1',
    'soc-device': '1',
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: 'c',
  };
  const qs = Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  const url =
    'https://myactivity.google.com/_/FootprintsMyactivityUi/data/batchexecute?' + qs;
  const body =
    'f.req=' +
    encodeURIComponent(JSON.stringify([[[rpcId, rpcArg, null, 'generic']]])) +
    '&at=' +
    encodeURIComponent(globals.snlM0e);
  const specStr = JSON.stringify({ url, body });
  const raw = await page.evaluate(`
    (async () => {
      try {
        const spec = ${specStr};
        const r = await fetch(spec.url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: spec.body,
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
      } catch (e) {
        return { _error: 'fetch error: ' + (e && e.message ? e.message : String(e)) };
      }
    })()
  `);
  if (raw && raw._error) {
    throw new Error('callBatchExecute: ' + raw._error);
  }
  if (!raw || !raw.ok) {
    throw new Error(
      'batchexecute ' + rpcId + ' failed: ' + (raw ? 'status ' + raw.status : 'no response'),
    );
  }
  return raw.text;
};

// ─── batchexecute wire format parser ─────────────────────────

const fallbackExtract = (stripped, rpcId) => {
  const escaped = rpcId.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(
    '\\[\\[\\s*"wrb\\.fr"\\s*,\\s*"' + escaped + '"\\s*,\\s*"',
    'g',
  );
  const match = re.exec(stripped);
  if (!match) {
    throw new Error('no wrb.fr frame for rpcId=' + rpcId);
  }
  let i = match.index + match[0].length;
  const start = i;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      const jsonLiteral = stripped.slice(start, i);
      const decoded = JSON.parse('"' + jsonLiteral + '"');
      return JSON.parse(decoded);
    }
    i++;
  }
  throw new Error('unterminated wrb.fr payload for rpcId=' + rpcId);
};

const parseBatchExecuteResponse = (text, rpcId) => {
  // Wire format: ")]}'\n\n<len>\n<frame json>\n<len>\n<frame json>..."
  // Declared lengths are advisory and occasionally off by a few bytes, so we
  // use the numeric-header-between-newlines pattern as a reliable delimiter.
  const stripped = text.replace(/^\)\]\}'\s*/, '');
  const leading = /^(\d+)\n/.exec(stripped);
  if (!leading) return fallbackExtract(stripped, rpcId);

  const bodyStarts = [leading[0].length];
  const sep = /\n(\d+)\n/g;
  sep.lastIndex = leading[0].length;
  const prevEnds = [];
  let m;
  while ((m = sep.exec(stripped)) !== null) {
    prevEnds.push(m.index);
    bodyStarts.push(m.index + m[0].length);
  }
  const bodyEnds = prevEnds.concat([stripped.length]);

  for (let i = 0; i < bodyStarts.length; i++) {
    const frame = stripped.slice(bodyStarts[i], bodyEnds[i]).replace(/\s+$/, '');
    let parsed;
    try {
      parsed = JSON.parse(frame);
    } catch (e) {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const row of parsed) {
      if (
        Array.isArray(row) &&
        row[0] === 'wrb.fr' &&
        row[1] === rpcId &&
        typeof row[2] === 'string'
      ) {
        return JSON.parse(row[2]);
      }
    }
  }
  return fallbackExtract(stripped, rpcId);
};

// ─── Entry normalizer ────────────────────────────────────────

const arrayOrEmpty = (v) => (Array.isArray(v) ? v : []);
const pickString = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

const extractDevice = (block) => {
  const inner = arrayOrEmpty(block[0]);
  return typeof inner[0] === 'string' ? inner[0] : null;
};

const normalizeEntry = (rec) => {
  const id = pickString(rec[IDX_ENTRY_ID]);
  if (!id) return null;
  const tsRaw = rec[IDX_TIMESTAMP_MICROS];
  if (typeof tsRaw !== 'number') return null;

  const productIds = Array.isArray(rec[IDX_PRODUCT_IDS])
    ? rec[IDX_PRODUCT_IDS].filter((x) => typeof x === 'number')
    : [];

  const productInfo = arrayOrEmpty(rec[IDX_PRODUCT_INFO]);
  const core = arrayOrEmpty(rec[IDX_CORE]);
  const appInfo = arrayOrEmpty(rec[IDX_APP_INFO]);
  const deviceBlock = arrayOrEmpty(rec[IDX_DEVICE_BLOCK]);

  return {
    id: id,
    productIds: productIds,
    productName: pickString(productInfo[0]),
    productIcon: pickString(productInfo[2]),
    timestampMicros: tsRaw,
    timestampIso: new Date(Math.trunc(tsRaw / 1000)).toISOString(),
    title: pickString(core[0]),
    subtitle: pickString(core[1]),
    action: pickString(core[2]),
    url: pickString(core[3]),
    appName: pickString(appInfo[0]),
    appUrl: pickString(appInfo[1]),
    device: extractDevice(deviceBlock),
  };
};

// ─── Feed collector ──────────────────────────────────────────

const collectFeed = async (globals, onProgress) => {
  const rpcId = globals.dsRpcIds['ds:3'];
  const entries = [];
  let cursor = null;
  for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
    const rpcArg = JSON.stringify([[[]], cursor, PAGE_SIZE]);
    const rawText = await callBatchExecute(globals, rpcId, rpcArg);
    const parsed = parseBatchExecuteResponse(rawText, rpcId);
    if (!Array.isArray(parsed)) {
      throw new Error('rpc ' + rpcId + ' returned non-array');
    }
    const rawEntries = Array.isArray(parsed[0]) ? parsed[0] : [];
    const nextCursor = typeof parsed[1] === 'string' ? parsed[1] : null;

    for (const rec of rawEntries) {
      const entry = normalizeEntry(rec);
      if (entry) entries.push(entry);
    }

    if (onProgress) await onProgress(entries.length, pageIdx + 1);

    if (!nextCursor || rawEntries.length === 0) break;
    cursor = nextCursor;
    await page.sleep(INTER_REQUEST_DELAY_MS);
  }
  return entries;
};

// ─── Login: challenge classifier ─────────────────────────────

const classifyChallenge = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { type: 'unknown' };
  }
  if (parsed.hostname !== 'accounts.google.com') {
    return { type: 'interstitial', hint: parsed.hostname };
  }
  const p = parsed.pathname;
  if (p.includes('accountchooser')) return { type: 'account-chooser' };
  if (p.includes('/signin/identifier')) return { type: 'email' };
  if (p.includes('/challenge/pwd')) return { type: 'password' };
  if (p.includes('/challenge/totp')) return { type: 'totp' };
  if (p.includes('/challenge/iap')) return { type: 'sms' };
  if (p.includes('/challenge/ootp')) return { type: 'sms' };
  if (p.includes('/challenge/ipp')) return { type: 'prompt-on-device' };
  if (p.includes('/challenge/dp')) return { type: 'prompt-on-device' };
  if (p.includes('/challenge/bc')) return { type: 'backup-code' };
  if (p.includes('/challenge/sk')) return { type: 'passkey' };
  if (p.includes('/challenge/u2f')) return { type: 'passkey' };
  if (p.includes('/challenge/recaptcha')) return { type: 'captcha' };
  if (p.includes('/signin/rejected')) {
    return { type: 'rejected', reason: parsed.searchParams.get('rhlk') || '' };
  }
  if (p.includes('/signin/v2/challenge/selection')) {
    return { type: 'interstitial', hint: 'select challenge method' };
  }
  return { type: 'interstitial', hint: p };
};

// ─── Login: real-keystroke fill + submit ────────────────────

// Google's sign-in form validates against untrusted events — a synthetic
// button click (element.click() via page.evaluate) is ignored. The only path
// that reliably advances the flow is real CDP-dispatched keystrokes, which
// `page.type` + `page.press` provide (playwright routes these through
// Input.dispatchKeyEvent on the underlying Chrome target).
const fillAndSubmit = async (selector, value) => {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
  } catch (e) {
    return { ok: false, reason: 'selector not visible: ' + selector };
  }
  try {
    // Clear residual text from any prior attempt before re-typing.
    await page.fill(selector, '');
  } catch (e) {
    /* field may already be empty — ignore */
  }
  try {
    await page.type(selector, value, { delay: 30 });
    await page.sleep(150);
    await page.press(selector, 'Enter');
    return { ok: true, via: 'type-enter' };
  } catch (e) {
    return {
      ok: false,
      reason: 'type+press failed: ' + (e && e.message ? e.message : String(e)),
    };
  }
};

const waitForUrlChange = async (startUrl, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.sleep(URL_POLL_INTERVAL_MS);
    const now = await currentUrl();
    if (now && now !== startUrl) return now;
    if (await checkLoginStatus()) return now;
  }
  return null;
};

// ─── Login: headed fallback ──────────────────────────────────

// In this harness the browser stream is always visible, so we never need to
// toggle modes. Crucially, we MUST NOT navigate — the fallback fires on
// challenges like prompt-on-device, passkey, and captcha where the user is
// already partway through Google's flow, and reloading to IDENTIFIER_URL
// would wipe the challenge page out from under them.
const headedFallback = async (message) => {
  await page.setData('status', message);
  await page.promptUser(message, checkLoginStatus, 2000);
};

// ─── Login: requestInput prompts ─────────────────────────────

const requestEmail = async () => {
  const res = await page.requestInput({
    message: 'Sign in to Google',
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', title: 'Google email or phone' },
      },
      required: ['email'],
    },
  });
  const email = String((res && res.email) || '').trim();
  if (!email) throw new Error('Email is required for Google login');
  return email;
};

const requestPassword = async () => {
  const res = await page.requestInput({
    message: 'Enter your Google password',
    schema: {
      type: 'object',
      properties: {
        password: { type: 'string', format: 'password', title: 'Password' },
      },
      required: ['password'],
    },
  });
  const password = String((res && res.password) || '');
  if (!password) throw new Error('Password is required for Google login');
  return password;
};

const requestCode = async (title, message) => {
  const res = await page.requestInput({
    message: message,
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', title: title },
      },
      required: ['code'],
    },
  });
  return String((res && res.code) || '').trim();
};

// Scrape the verification number Google displays on prompt-on-device. Uses
// three independent strategies (canonical samp tag, leaf-element digit scan,
// and regex patterns on body text) so we survive Google's periodic markup
// reshuffles. Emits a debug trace to the data panel so we can tell which
// path hit — or which patterns the current page tripped if extraction
// fails. Returns null when no digit is found.
const extractDeviceNumber = async () => {
  // The number element is sometimes injected a beat after the page frame
  // loads. Give it a moment before scraping.
  await page.sleep(600);
  try {
    const result = await page.evaluate(`
      (() => {
        // 1. Canonical: Google has historically rendered the number in a
        //    <samp> element on the prompt-on-device page.
        const samp = document.querySelector('samp');
        if (samp) {
          const t = (samp.textContent || '').trim();
          if (/^\\d{1,3}$/.test(t)) return { number: t, via: 'samp' };
        }
        // 2. DOM walk: find the first leaf element whose text is just a
        //    1-3 digit number. Survives tag renames.
        const tags = document.querySelectorAll('div, span, strong, b, samp, code, p');
        for (const el of tags) {
          if (el.children && el.children.length > 0) continue;
          const t = (el.textContent || '').trim();
          if (/^\\d{1,3}$/.test(t)) return { number: t, via: 'leaf-walk' };
        }
        // 3. Text regex on body.innerText. Several phrasings exist across
        //    Google locales; try them in order.
        const text = (document.body && document.body.innerText) || '';
        const patterns = [
          /tap\\s+(\\d{1,3})\\s+on your phone/i,
          /number[:\\s]+(\\d{1,3})/i,
          /tap\\s+(\\d{1,3})/i,
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m) return { number: m[1], via: 'regex' };
        }
        return { number: null, via: 'none', sample: text.slice(0, 400) };
      })()
    `);
    if (result && typeof result === 'object') {
      await page.setData('debug_device_number', result);
      if (typeof result.number === 'string' && result.number.length > 0) {
        return result.number;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
};

// Prompt the user via a requestInput dialog with the number they must tap on
// their phone. We don't capture any real input — the schema is a single
// confirmation flag — we just need a modal surface that is visible even in
// host UXs where the streamed Chrome canvas is hidden. After the user
// confirms, we poll `checkLoginStatus` for a short window so the flow
// resumes automatically once Google redirects.
const awaitDeviceTapConfirmation = async (number) => {
  const title = number
    ? 'Tap ' + number + ' on your phone, then press Submit.'
    : 'Complete the Google sign-in prompt on your phone, then press Submit.';
  // Empty properties renders the dialog with just a Submit button — the
  // title carries the full instruction and the user confirms by clicking.
  // Text inputs can't express "I tapped it" semantics, and the current
  // InputDialog component doesn't render boolean fields as checkboxes.
  await page.requestInput({
    message: title,
    schema: { type: 'object', properties: {}, required: [] },
  });

  // Give Google a moment to redirect past /challenge/dp once the user has
  // tapped. checkLoginStatus auto-navigates from myaccount → myactivity, so
  // any successful auth lands here as `true`.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await checkLoginStatus()) return true;
    await page.sleep(1000);
  }
  return false;
};

// ─── Login: interactive loop ─────────────────────────────────

const runInteractiveLogin = async () => {
  await safeGoto(IDENTIFIER_URL);
  await page.sleep(1200);

  let lastUrl = '';
  let stuckCount = 0;

  for (let step = 0; step < MAX_LOGIN_STEPS; step++) {
    if (await checkLoginStatus()) return;

    const url = await currentUrl();
    const kind = classifyChallenge(url);
    await page.setData(
      'status',
      'Google sign-in step ' + (step + 1) + ': ' + kind.type,
    );

    if (url === lastUrl) {
      stuckCount += 1;
    } else {
      stuckCount = 0;
      lastUrl = url;
    }

    if (kind.type === 'email') {
      const email = await requestEmail();
      const res = await fillAndSubmit('input[type="email"]', email);
      if (!res || !res.ok) {
        await headedFallback('Please complete Google sign-in in the browser, then click Done.');
        return;
      }
      await waitForUrlChange(url, URL_CHANGE_TIMEOUT_MS);
      continue;
    }

    if (kind.type === 'password') {
      const password = await requestPassword();
      const res = await fillAndSubmit('input[type="password"]', password);
      if (!res || !res.ok) {
        await headedFallback('Please complete Google sign-in in the browser, then click Done.');
        return;
      }
      await waitForUrlChange(url, URL_CHANGE_TIMEOUT_MS);
      continue;
    }

    if (kind.type === 'totp') {
      const code = await requestCode(
        '6-digit authenticator code',
        'Enter the code from your authenticator app',
      );
      const res = await fillAndSubmit('input[type="tel"], input[type="text"]', code);
      if (!res || !res.ok) {
        await headedFallback('Please complete verification in the browser, then click Done.');
        return;
      }
      await waitForUrlChange(url, URL_CHANGE_TIMEOUT_MS);
      continue;
    }

    if (kind.type === 'sms') {
      const code = await requestCode(
        'Verification code',
        'Enter the code sent to your phone',
      );
      const res = await fillAndSubmit('input[type="tel"], input[type="text"]', code);
      if (!res || !res.ok) {
        await headedFallback('Please complete verification in the browser, then click Done.');
        return;
      }
      await waitForUrlChange(url, URL_CHANGE_TIMEOUT_MS);
      continue;
    }

    if (kind.type === 'backup-code') {
      const code = await requestCode(
        'Backup code',
        'Enter one of your backup verification codes',
      );
      const res = await fillAndSubmit('input[type="text"], input[type="password"]', code);
      if (!res || !res.ok) {
        await headedFallback('Please complete verification in the browser, then click Done.');
        return;
      }
      await waitForUrlChange(url, URL_CHANGE_TIMEOUT_MS);
      continue;
    }

    if (kind.type === 'rejected') {
      throw new Error(
        'Google rejected the sign-in attempt' +
          (kind.reason ? ' (reason=' + kind.reason + ')' : '') +
          ". This is usually Google's anti-automation gate.",
      );
    }

    // Prompt-on-device (Google phone notification w/ numeric match). We can
    // drive this through a requestInput dialog: scrape the number Google is
    // showing and surface it to the user, who taps it on their phone.
    if (kind.type === 'prompt-on-device') {
      const number = await extractDeviceNumber();
      if (await awaitDeviceTapConfirmation(number)) return;
      continue;
    }

    // passkey, captcha, account-chooser, interstitial, unknown — no modal
    // surface works for these, so the user must interact with the streamed
    // browser directly. This path requires the canvas to be visible.
    if (
      kind.type === 'passkey' ||
      kind.type === 'captcha' ||
      kind.type === 'account-chooser' ||
      kind.type === 'interstitial' ||
      kind.type === 'unknown'
    ) {
      const hint = kind.hint ? ' (' + kind.hint + ')' : '';
      await headedFallback(
        'Complete the ' + kind.type + hint + ' step in the browser, then click Done.',
      );
      return;
    }

    // Stuck on the same screen with no progress → headed fallback.
    if (stuckCount >= 2) {
      await headedFallback('Please finish Google sign-in in the browser, then click Done.');
      return;
    }
    await page.sleep(1000);
  }

  await headedFallback(
    'Google sign-in is taking longer than expected. Finish in the browser, then click Done.',
  );
};

const ensureLoggedIn = async () => {
  await page.setData('status', 'Checking Google login status...');
  await safeGoto(MYACTIVITY_URL);
  await page.sleep(1200);
  if (await checkLoginStatus()) {
    await page.setData('status', 'Google session restored');
    return;
  }
  await page.setData('status', 'Logging in to Google...');
  await runInteractiveLogin();
  if (!(await checkLoginStatus())) {
    throw new Error('Google login did not complete');
  }
  await page.setData('status', 'Google login successful');
};

// ─── Result transform ────────────────────────────────────────

const buildResult = (entries) => {
  return {
    'google.myactivity': {
      entries: entries,
    },
    exportSummary: {
      count: entries.length,
      label: 'activities',
      details: entries.length + ' My Activity entries',
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-api-playwright',
    platform: 'google',
  };
};

// ─── Main flow ───────────────────────────────────────────────

(async () => {
  await ensureLoggedIn();

  await page.setProgress({
    phase: { step: 1, total: 1, label: 'My Activity' },
    message: 'Loading My Activity session...',
  });
  const globals = await loadMyActivityGlobals();

  const entries = await collectFeed(globals, async (n, pageIdx) => {
    await page.setProgress({
      phase: { step: 1, total: 1, label: 'My Activity' },
      message: 'Captured ' + n + ' activities (page ' + pageIdx + ')',
      count: n,
    });
  });

  const result = buildResult(entries);
  await page.setData('result', result);
  await page.setData('status', 'Complete: ' + result.exportSummary.details);
  return { success: true, data: result };
})();
