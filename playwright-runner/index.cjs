/**
 * Playwright Runner for PDP-Connect
 *
 * Runs as a sidecar process, receives commands via stdin, sends results via stdout.
 *
 * Commands:
 * - { type: "run", runId, connectorPath, url, headless, allowHeaded, requestedScopes }
 * - { type: "stop", runId }
 * - { type: "evaluate", runId, script }
 * - { type: "input-response", runId, requestId, data?, error? }
 * - { type: "screenshot", runId }
 * - { type: "quit" }
 *
 * Supports two-phase connectors:
 * - Phase 1 (Browser): Login detection + credential extraction
 * - Phase 2 (Background): Direct HTTP fetch without browser
 */

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const path = require('path');
const { execSync } = require('child_process');
const { readZipJsonEntries } = require('./zip-reader.cjs');
const { classifyConnectorResult } = require('./result-classifier.cjs');
const {
  normalizeConnectorResult,
  resolveHeadlessResumeUrl,
} = require('./runner-compat.cjs');

// System Chrome paths by platform
const CHROME_PATHS = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux: '/usr/bin/google-chrome'
};

// Get browser cache directory - checks multiple candidate paths
function getBrowserCacheDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    log(`Using PLAYWRIGHT_BROWSERS_PATH: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    path.join(home, '.pdp-connect', 'browsers'),
    path.join(home, '.pdp-connect', 'playwright-runner', 'node_modules', 'playwright-core', '.local-browsers'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      log(`Found browser cache: ${dir}`);
      return dir;
    }
  }
  return candidates[0];
}

// Check if system Chrome exists
function getSystemChromePath() {
  const chromePath = CHROME_PATHS[process.platform];
  log(`Checking system Chrome at: ${chromePath}`);
  if (chromePath && fs.existsSync(chromePath)) {
    log(`Found system Chrome: ${chromePath}`);
    return chromePath;
  }
  log(`System Chrome not found at default path`);
  // Try alternative Windows paths
  if (process.platform === 'win32') {
    const altPaths = [
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const p of altPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  // Try Edge on Windows
  if (process.platform === 'win32') {
    const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    if (fs.existsSync(edgePath)) return edgePath;
  }
  return null;
}

// Check if Playwright Chromium is already downloaded (or bundled via PLAYWRIGHT_BROWSERS_PATH)
function getDownloadedChromiumPath() {
  const cacheDir = getBrowserCacheDir();
  log(`Checking for Chromium in: ${cacheDir}`);
  if (!fs.existsSync(cacheDir)) {
    log(`Browser cache dir does not exist: ${cacheDir}`);
    return null;
  }

  // Look for chromium directory
  const entries = fs.readdirSync(cacheDir);
  const chromiumDir = entries.find(e => e.startsWith('chromium-') && !e.includes('headless'));
  if (!chromiumDir) return null;

  const chromiumPath = path.join(cacheDir, chromiumDir);

  // Platform-specific executable paths (Playwright's "Chrome for Testing" structure)
  if (process.platform === 'darwin') {
    // Try arm64 first, then x64
    const paths = [
      path.join(chromiumPath, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(chromiumPath, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      // Legacy paths
      path.join(chromiumPath, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(chromiumPath, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'win32') {
    const paths = [
      path.join(chromiumPath, 'chrome-win', 'chrome.exe'),
      path.join(chromiumPath, 'chrome-win64', 'chrome.exe'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    const paths = [
      path.join(chromiumPath, 'chrome-linux', 'chrome'),
      path.join(chromiumPath, 'chrome-linux64', 'chrome'),
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

// Default Chrome user-data directories by platform
const CHROME_PROFILE_DIRS = {
  darwin: path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome'),
  win32: path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
  linux: path.join(process.env.HOME || '', '.config', 'google-chrome'),
};

// Check whether a browser path points to system Chrome (not Playwright Chromium).
function isSystemChrome(browserPath) {
  if (!browserPath) return false;
  const lower = browserPath.toLowerCase();
  if (lower.includes('.databridge') || lower.includes('chromium') || lower.includes('chrome for testing')) {
    return false;
  }
  return true;
}

// Get the Chrome last-used profile directory path.
function getChromeProfileDir(chromeRoot) {
  const localStatePath = path.join(chromeRoot, 'Local State');
  if (fs.existsSync(localStatePath)) {
    try {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
      const lastUsed = localState?.profile?.last_used;
      if (lastUsed) {
        const profileDir = path.join(chromeRoot, lastUsed);
        if (fs.existsSync(profileDir)) {
          log(`Chrome last-used profile: "${lastUsed}"`);
          return profileDir;
        }
      }
    } catch (e) {
      log(`Warning: could not read Chrome Local State: ${e.message}`);
    }
  }

  const defaultDir = path.join(chromeRoot, 'Default');
  if (fs.existsSync(defaultDir)) return defaultDir;
  return null;
}

// Import cookies from the user's Chrome profile into a running Playwright
// browser context's Cookies database. This is done AFTER Chrome creates its
// own fresh profile, so we INSERT into Chrome's own db rather than replacing it
// (which Chrome would wipe on startup).
//
// The encrypted_value blobs use the same Keychain key (v10 format), so Chrome
// can decrypt them transparently — no Keychain popup needed since Chrome itself
// is the one reading them.
function importChromecookies(userDataDir, browserPath) {
  if (!isSystemChrome(browserPath)) return;

  // Only import once
  const markerFile = path.join(userDataDir, '.cookies-imported');
  if (fs.existsSync(markerFile)) {
    log('Skipping cookie import — already done');
    return;
  }

  const chromeRoot = CHROME_PROFILE_DIRS[process.platform];
  if (!chromeRoot || !fs.existsSync(chromeRoot)) return;

  const sourceProfileDir = getChromeProfileDir(chromeRoot);
  if (!sourceProfileDir) return;

  const sourceCookies = path.join(sourceProfileDir, 'Cookies');
  if (!fs.existsSync(sourceCookies)) return;

  // Find the target Cookies db — Chrome creates it inside "Default/" by default
  const targetCookies = path.join(userDataDir, 'Default', 'Cookies');
  if (!fs.existsSync(targetCookies)) {
    log('Skipping cookie import — target Cookies db not found yet');
    return;
  }

  try {
    // Use sqlite3 to INSERT cookies from source into the target db.
    // ATTACH the source db, then INSERT OR IGNORE to avoid duplicates.
    const sql = `
      ATTACH DATABASE '${sourceCookies.replace(/'/g, "''")}' AS src;
      INSERT OR REPLACE INTO cookies
        SELECT * FROM src.cookies;
      DETACH DATABASE src;
    `;
    execSync(`sqlite3 "${targetCookies}" "${sql}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });

    // Verify
    const count = execSync(
      `sqlite3 "${targetCookies}" "SELECT COUNT(*) FROM cookies;"`,
      { encoding: 'utf-8' }
    ).trim();
    log(`Imported cookies into profile — total cookies now: ${count}`);

    fs.writeFileSync(markerFile, new Date().toISOString());
  } catch (e) {
    log(`Warning: could not import Chrome cookies: ${e.message}`);
  }
}

// Download Chromium using Playwright
async function downloadChromium(sendStatus) {
  const cacheDir = getBrowserCacheDir();

  // Create cache directory
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  log('Downloading Chromium browser (one-time setup)...');
  if (sendStatus) {
    sendStatus('DOWNLOADING_BROWSER');
  }

  // Set environment for Playwright to use our cache dir
  process.env.PLAYWRIGHT_BROWSERS_PATH = cacheDir;

  try {
    // Use Playwright's CLI to download Chromium
    execSync('npx playwright install chromium', {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cacheDir }
    });
    log('Chromium download complete');
    return getDownloadedChromiumPath();
  } catch (error) {
    log('Failed to download Chromium:', error.message);
    throw new Error('Failed to download browser. Please install Google Chrome or try again.');
  }
}

// Active browser contexts by runId
const activeRuns = new Map();

// Send message to parent process
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function drainStdout() {
  return new Promise(resolve => {
    if (process.stdout.writableNeedDrain) {
      process.stdout.once('drain', resolve);
    } else {
      process.stdout.write('', resolve);
    }
  });
}

// Log to stderr (doesn't interfere with JSON protocol)
function log(...args) {
  console.error('[PlaywrightRunner]', ...args);
}

function isCanonicalScopeId(scope) {
  return (
    typeof scope === 'string' &&
    scope.length > 0 &&
    scope.includes('.') &&
    !scope.startsWith('.') &&
    !scope.endsWith('.')
  );
}

function normalizeRequestedScopes(requestedScopes) {
  if (!Array.isArray(requestedScopes) || requestedScopes.length === 0) {
    throw new Error('Resolved requestedScopes must be a non-empty array');
  }

  const deduped = [];
  const seen = new Set();
  for (const scope of requestedScopes) {
    if (!isCanonicalScopeId(scope)) {
      throw new Error(`Resolved requestedScopes contains a non-canonical scope id: ${String(scope)}`);
    }
    if (!seen.has(scope)) {
      seen.add(scope);
      deduped.push(scope);
    }
  }

  if (deduped.length === 0) {
    throw new Error('Resolved requestedScopes must contain at least one canonical scope id');
  }

  return deduped;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryNavigationError(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return (
    message.includes('err_name_not_resolved') ||
    message.includes('err_internet_disconnected') ||
    message.includes('err_network_changed') ||
    message.includes('err_connection_reset') ||
    message.includes('err_connection_closed') ||
    message.includes('timeout')
  );
}

async function gotoWithRetries(page, url, options = {}) {
  const {
    attempts = 3,
    delayMs = 1500,
    context = 'navigation',
    waitUntil = 'domcontentloaded',
    timeout,
  } = options;

  const gotoOptions = { waitUntil };
  if (timeout != null) {
    gotoOptions.timeout = timeout;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, gotoOptions);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetryNavigationError(error)) {
        throw error;
      }
      log(
        `${context} attempt ${attempt}/${attempts} failed for ${url}: ${error.message}. Retrying...`,
      );
      await sleep(delayMs * attempt);
    }
  }

  throw lastError;
}

function storeConnectorResult(runState, result) {
  const normalizedResult = normalizeConnectorResult(result, {
    requestedScopes: runState.requestedScopes,
  });
  const classification = classifyConnectorResult(normalizedResult, {
    expectedRequestedScopes: runState.requestedScopes,
  });

  if (classification.outcome === 'failure') {
    log(
      `Connector result classified as failure: ${classification.errorClass}` +
        (classification.debug ? ` (${classification.debug})` : ''),
    );
  }

  runState.resultEnvelope = {
    classification,
    rawResult: normalizedResult,
  };

  return runState.resultEnvelope;
}

function emitStoredConnectorResult(runId, runState) {
  if (!runState.resultEnvelope) {
    return null;
  }

  const { classification, rawResult } = runState.resultEnvelope;
  const message = {
    type: 'result',
    runId,
    classification,
  };

  if (classification.outcome === 'success' || classification.outcome === 'partial') {
    message.data = rawResult;
  }

  send(message);
  return classification;
}

// Resolve browser executable path
function resolveBrowserPath() {
  let browserPath = null;

  if (!process.env.PDP_CONNECT_SIMULATE_NO_CHROME) {
    browserPath = getSystemChromePath();
  } else {
    log('PDP_CONNECT_SIMULATE_NO_CHROME is set, skipping system Chrome detection');
  }

  if (!browserPath) {
    browserPath = getDownloadedChromiumPath();
  }

  if (!browserPath) {
    throw new Error('No browser available. The Rust backend should have downloaded Chromium before starting the connector.');
  }

  return browserPath;
}

// Launch a persistent browser context
async function launchPersistentContext(userDataDir, headless, browserPath) {
  // Ensure profile directory exists
  fs.mkdirSync(userDataDir, { recursive: true });

  const launchOptions = {
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=MediaRouter,DialMediaRouteProvider',
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };

  if (browserPath) {
    launchOptions.executablePath = browserPath;
  }

  // When using system Chrome, disable Playwright's mock keychain so Chrome
  // uses the real macOS Keychain. This lets it decrypt cookies imported from
  // the user's real Chrome profile (both use the same "Chrome Safe Storage"
  // Keychain entry). No popup — Chrome itself is already authorized.
  if (isSystemChrome(browserPath)) {
    launchOptions.ignoreDefaultArgs = ['--use-mock-keychain'];
  }

  log(`Launching ${headless ? 'headless' : 'headed'} browser with profile: ${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  log('Browser launched successfully');
  return context;
}

// Create the page API that connectors use
function createPageApi(runState, runId) {
  const networkCaptures = new Map();
  const capturedResponses = new Map();

  // Helper to get current page, throw if browser is closed
  function requirePage() {
    if (runState.browserClosed || !runState.page) {
      throw new Error('Browser is closed. Use page.httpFetch() for HTTP requests.');
    }
    return runState.page;
  }

  // Set up network interception on current page
  function setupNetworkCapture(page) {
    page.on('response', async (response) => {
      const url = response.url();

      for (const [key, config] of networkCaptures.entries()) {
        if (config.urlPattern && !url.includes(config.urlPattern)) continue;

        try {
          const request = response.request();
          const postData = request.postData() || '';

          if (config.bodyPattern) {
            const patterns = config.bodyPattern.split('|');
            if (!patterns.some(p => postData.includes(p))) continue;
          }

          const body = await response.json().catch(() => null);
          if (body) {
            capturedResponses.set(key, { url, data: body, timestamp: Date.now() });
            send({ type: 'network-captured', runId, key, url });
          }
        } catch (e) {
          // Ignore errors for non-JSON responses
        }
      }
    });
  }

  // Set up network capture on initial page
  if (runState.page) {
    setupNetworkCapture(runState.page);
  }

  return {
    // ── Canonical page API minimum surface ─────────────────────────────
    // These are thin pass-throughs to the underlying Playwright page object.
    // See types/connector.d.ts in this repo for the canonical contract.

    requestedScopes: () => {
      return [...runState.requestedScopes];
    },

    url: async () => {
      const page = requirePage();
      return page.url();
    },

    click: async (selector, options = {}) => {
      const page = requirePage();
      await page.click(selector, options);
    },

    fill: async (selector, value, options = {}) => {
      const page = requirePage();
      await page.fill(selector, value, options);
    },

    press: async (selector, key, options = {}) => {
      const page = requirePage();
      await page.press(selector, key, options);
    },

    waitForSelector: async (selector, options = {}) => {
      const page = requirePage();
      await page.waitForSelector(selector, options);
    },

    goto: async (url, options = {}) => {
      const page = requirePage();
      log(`pageApi.goto called with: ${url}`);
      send({ type: 'log', runId, message: `Navigating to: ${url}` });
      const { waitUntil = 'domcontentloaded', timeout } = options;
      const gotoOpts = { waitUntil };
      if (timeout != null) gotoOpts.timeout = timeout;
      try {
        await page.goto(url, gotoOpts);
        log('pageApi.goto completed successfully');
      } catch (err) {
        log(`pageApi.goto error: ${err.message}`);
        throw err;
      }
    },

    evaluate: async (script) => {
      const page = requirePage();
      return await page.evaluate(script);
    },

    screenshot: async () => {
      const page = requirePage();
      const buffer = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 });
      return buffer.toString('base64');
    },

    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    setData: async (key, value) => {
      if (key === 'status') {
        send({ type: 'log', runId, message: value });
        log(`[status] ${value}`);
      } else if (key === 'error') {
        log(`[error] ${value}`);
      } else if (key === 'result') {
        storeConnectorResult(runState, value);
      }
      send({ type: 'data', runId, key, value });
    },

    // Structured progress update — drives the frontend progress UI
    setProgress: async ({ phase, message, count }) => {
      send({ type: 'status', runId, status: { type: 'COLLECTING', message, phase, count } });
      if (message) log(`[progress] ${message}`);
    },

    promptUser: async (message, checkFn, interval = 2000) => {
      send({ type: 'log', runId, message });
      send({ type: 'status', runId, status: 'WAITING_FOR_USER' });

      // Poll until condition is met
      while (true) {
        await new Promise(resolve => setTimeout(resolve, interval));
        try {
          const result = await checkFn();
          if (result) {
            send({ type: 'log', runId, message: 'User action completed' });
            return;
          }
        } catch (e) {
          // Keep waiting
        }
      }
    },

    captureNetwork: async (config) => {
      networkCaptures.set(config.key, {
        urlPattern: config.urlPattern || '',
        bodyPattern: config.bodyPattern || ''
      });
      log(`Registered network capture: ${config.key}`);
    },

    getCapturedResponse: async (key) => {
      const captured = capturedResponses.get(key);
      return captured ? captured : null;
    },

    clearNetworkCaptures: async () => {
      networkCaptures.clear();
      capturedResponses.clear();
    },

    hasCapturedResponse: (key) => {
      return capturedResponses.has(key);
    },

    // Close the browser but keep the Node.js process alive for background HTTP work.
    // Cookies/session persist in the profile directory for next run.
    closeBrowser: async () => {
      if (runState.browserClosed) {
        log('Browser already closed');
        return;
      }

      log('Closing browser (connector requested closeBrowser)');

      // Extract cookies before closing so httpFetch can use them
      if (runState.context) {
        try {
          runState.cookies = await runState.context.cookies();
          log(`Extracted ${runState.cookies.length} cookies for background HTTP requests`);
        } catch (e) {
          log('Warning: could not extract cookies:', e.message);
          runState.cookies = [];
        }
      }

      runState.browserClosed = true;
      runState.browserClosedByConnector = true;

      if (runState.context) {
        try {
          await runState.context.close();
        } catch (e) {
          log('Error closing context:', e.message);
        }
        runState.context = null;
        runState.page = null;
      }

      send({ type: 'log', runId, message: 'Browser closed, continuing in background...' });
      log('Browser closed, process stays alive for background work');
    },

    // Escalate to headed mode for live human interaction (e.g., interactive CAPTCHAs).
    // Gated by allowHeaded capability — if the driver doesn't support headed mode,
    // navigates in the existing headless browser and returns { headed: false }.
    showBrowser: async (url) => {
      log('showBrowser requested');

      if (runState.browserClosed) {
        log('showBrowser called but browser is already closed');
        return { headed: false };
      }

      if (!runState.allowHeaded) {
        log('Headed mode not available — navigating headless');
        if (url && runState.page) {
          try {
            await runState.page.goto(url, { waitUntil: 'domcontentloaded' });
          } catch (e) {
            log(`showBrowser headless navigation failed: ${e.message}`);
          }
        }
        send({ type: 'log', runId, message: 'Headed interaction unavailable — staying headless' });
        return { headed: false };
      }

      // Close existing browser if open
      if (runState.context && !runState.browserClosed) {
        log('Closing existing browser before reopening headed');
        runState.browserClosedByConnector = true;
        try {
          await runState.context.close();
        } catch (e) {
          log('Error closing existing context:', e.message);
        }
        runState.context = null;
        runState.page = null;
      }

      // Launch new headed browser with persistent context
      runState.browserClosed = false;
      runState.browserClosedByConnector = false;
      runState.headless = false;
      const context = await launchPersistentContext(runState.userDataDir, false, runState.browserPath);
      const page = context.pages()[0] || await context.newPage();

      // Set up disconnect handler
      context.browser().on('disconnected', () => {
        if (!runState.connectorCompleted && !runState.browserClosedByConnector) {
          log(`Browser disconnected for run ${runId} (user closed window)`);
          runState.browserClosed = true;
          runState.context = null;
          runState.page = null;
          activeRuns.delete(runId);
          send({ type: 'status', runId, status: 'STOPPED' });
          drainStdout().then(() => process.exit(0));
        }
      });

      // Update state
      runState.context = context;
      runState.page = page;

      // Re-setup network capture on new page
      setupNetworkCapture(page);

      // Navigate to URL
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      }

      send({ type: 'log', runId, message: 'Browser opened for user interaction' });
      log('Headed browser opened');
      return { headed: true };
    },

    // Switch to headless mode — browser becomes invisible but stays running.
    // Use this after credentials are captured so the user doesn't see the browser
    // during data collection, while preserving the TLS fingerprint for Cloudflare.
    goHeadless: async (options = {}) => {
      if (runState.headless && !runState.browserClosed) {
        log('Already in headless mode');
        return;
      }

      log('Switching to headless mode');
      const currentUrl = runState.page ? runState.page.url() : null;
      const resumeUrl = resolveHeadlessResumeUrl({
        resumeUrl: options.resumeUrl,
        currentUrl,
      });

      // Close existing headed browser
      if (runState.context && !runState.browserClosed) {
        runState.browserClosedByConnector = true;
        try {
          await runState.context.close();
        } catch (e) {
          log('Error closing headed context:', e.message);
        }
        runState.context = null;
        runState.page = null;
      }

      // Reopen headless browser with persistent context
      runState.browserClosed = false;
      runState.browserClosedByConnector = false;
      runState.headless = true;
      const context = await launchPersistentContext(runState.userDataDir, true, runState.browserPath);
      const page = context.pages()[0] || await context.newPage();

      // Set up disconnect handler
      context.browser().on('disconnected', () => {
        if (!runState.connectorCompleted && !runState.browserClosedByConnector) {
          log(`Browser disconnected for run ${runId}`);
          runState.browserClosed = true;
          runState.context = null;
          runState.page = null;
          activeRuns.delete(runId);
          send({ type: 'status', runId, status: 'STOPPED' });
          drainStdout().then(() => process.exit(0));
        }
      });

      // Update state
      runState.context = context;
      runState.page = page;

      // Re-setup network capture on new page
      setupNetworkCapture(page);

      // Restore the current browser location when possible so connectors that
      // authenticate in headed mode can resume collection without re-implementing
      // their own login handoff logic.
      await gotoWithRetries(page, resumeUrl, {
        context: 'goHeadless resume navigation',
      });

      send({ type: 'log', runId, message: 'Switched to headless mode for background data collection' });
      log(`Switched to headless mode (resumeUrl: ${resumeUrl})`);
    },

    // Direct HTTP fetch from Node.js — no browser needed.
    // Works after closeBrowser() for background data collection.
    // Automatically includes cookies extracted from the browser session.
    httpFetch: async (url, options = {}) => {
      const { timeout = 30000, ...fetchOptions } = options;

      // Auto-include cookies from the closed browser session
      if (runState.cookies && runState.cookies.length > 0) {
        try {
          const urlObj = new URL(url);
          const relevantCookies = runState.cookies
            .filter(c => {
              const cookieDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
              return urlObj.hostname === cookieDomain || urlObj.hostname.endsWith('.' + cookieDomain);
            })
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
          if (relevantCookies) {
            fetchOptions.headers = { ...fetchOptions.headers, cookie: relevantCookies };
          }
        } catch (e) {
          // Ignore cookie injection errors
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (!response.ok) {
          log(`[httpFetch] ${response.status} ${response.statusText} for ${url.substring(0, 100)}`);
          log(`[httpFetch] Response body (first 200 chars): ${text.substring(0, 200)}`);
        }
        return {
          ok: response.ok,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          text,
          json,
          error: null,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        return {
          ok: false,
          status: 0,
          headers: {},
          text: '',
          json: null,
          error: err.message,
        };
      }
    },

    // Trigger a browser download by navigating to `url` and capture it to a temp
    // file. Works for both direct attachment URLs (navigation aborts, download
    // fires) and SPA-mediated downloads (the page hydrates and JS starts the
    // download). Returns { ok, ready, path, name, size }. ready:false means no
    // download fired within the timeout (e.g. an async export still preparing).
    captureDownload: async (url, options = {}) => {
      const page = requirePage();
      const timeout = options.timeout || 60000;
      const downloadPromise = page.waitForEvent('download', { timeout }).catch(() => null);
      try {
        await page.goto(url, { timeout, waitUntil: 'commit' });
      } catch (e) {
        // ERR_ABORTED is expected when the URL serves a direct attachment.
      }
      const download = await downloadPromise;
      if (!download) return { ok: false, ready: false, error: 'no download within timeout' };
      try {
        // Persist captured downloads to a durable, known location rather than a
        // temp dir, so they survive as a local archive (e.g. the raw Claude
        // export ZIP a connector keeps out of the Personal Server). Caller can
        // override with options.persistDir.
        const dir = options.persistDir || path.join(os.homedir(), '.pdp-connect', 'raw-exports');
        fs.mkdirSync(dir, { recursive: true });
        const name = download.suggestedFilename() || 'download.bin';
        const dest = path.join(dir, name);
        await download.saveAs(dest);
        const size = fs.statSync(dest).size;
        log(`[captureDownload] saved ${name} (${size} bytes) to ${dest}`);
        return { ok: true, ready: true, path: dest, name, size };
      } catch (err) {
        return { ok: false, ready: true, error: err.message };
      }
    },

    // Read JSON entries out of a ZIP on disk (e.g. a captured export archive).
    // `options.include` is an optional list of name substrings to select; when
    // omitted, all .json entries are parsed. Returns { ok, names, json }.
    extractZipEntries: async (zipPath, options = {}) => {
      try {
        const buffer = fs.readFileSync(zipPath);
        const { names, json } = readZipJsonEntries(buffer, options.include || null);
        log(`[extractZipEntries] ${names.length} entries, ${Object.keys(json).length} json parsed from ${path.basename(zipPath)}`);
        return { ok: true, names, json };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

// Run a connector
async function runConnector(runId, connectorPath, url, headless = true, allowHeaded = true, requestedScopes) {
  log(`Starting run ${runId} with connector ${connectorPath} (headless: ${headless}, allowHeaded: ${allowHeaded})`);

  // Derive connector ID for persistent browser profile
  const connectorFileName = path.basename(connectorPath, path.extname(connectorPath));
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const userDataDir = path.join(home, '.pdp-connect', 'browser-profiles', connectorFileName);

  // Mutable state shared with pageApi
  const runState = {
    context: null,
    page: null,
    browserClosed: false,
    browserClosedByConnector: false,
    connectorCompleted: false,
    headless,
    allowHeaded,
    userDataDir,
    browserPath: null,
    requestCounter: 0,
    pendingInputs: new Map(),
    requestedScopes: normalizeRequestedScopes(requestedScopes),
    resultEnvelope: null,
  };

  try {
    // Read connector script
    const connectorCode = fs.readFileSync(connectorPath, 'utf-8');

    // Resolve browser executable
    runState.browserPath = resolveBrowserPath();
    log(`Using browser: ${runState.browserPath}`);

    // On first run, we need to:
    //  1. Launch Chrome briefly so it creates its profile/Cookies db
    //  2. Close it
    //  3. INSERT cookies from the user's Chrome profile into the db
    //  4. Relaunch — now Chrome loads the imported cookies from disk
    const markerFile = path.join(userDataDir, '.cookies-imported');
    if (isSystemChrome(runState.browserPath) && !fs.existsSync(markerFile)) {
      log('First run: launching browser to initialize profile...');
      const tempCtx = await launchPersistentContext(userDataDir, true, runState.browserPath);
      await tempCtx.close();
      log('Profile initialized, importing cookies...');
      importChromecookies(userDataDir, runState.browserPath);
    }

    // Launch browser with persistent context (cookies already in db on first run)
    const context = await launchPersistentContext(userDataDir, headless, runState.browserPath);
    const page = context.pages()[0] || await context.newPage();

    runState.context = context;
    runState.page = page;

    // Handle browser disconnect (user closed browser window)
    context.browser().on('disconnected', () => {
      if (!runState.connectorCompleted && !runState.browserClosedByConnector && activeRuns.has(runId)) {
        log(`Browser disconnected for run ${runId} (user closed window)`);
        runState.browserClosed = true;
        runState.context = null;
        runState.page = null;
        activeRuns.delete(runId);
        send({ type: 'status', runId, status: 'STOPPED' });
        drainStdout().then(() => process.exit(0));
      }
    });

    // Store for cleanup
    activeRuns.set(runId, {
      runState,
      setCompleted: () => { runState.connectorCompleted = true; },
    });

    // Create page API
    const pageApi = createPageApi(runState, runId);

    // Navigate to starting URL
    log(`Navigating to initial URL: ${url}`);
    await gotoWithRetries(page, url, {
      context: 'initial navigation',
    });
    log('Initial navigation complete');
    send({ type: 'status', runId, status: 'RUNNING' });

    // Build the connector execution wrapper
    // The connector has an IIFE at the end - we need to return its Promise
    // Find the LAST IIFE and add 'return' before it (there may be inner IIFEs in helpers)
    let modifiedCode = connectorCode;

    // Match both a leading-newline IIFE and one that starts on line 1
    // (e.g. steam-playwright.js). An earlier version required `\n` as a
    // leading anchor, which silently false-succeeded any script whose only
    // top-level IIFE was on line 1 — the AsyncFunction would resolve to
    // undefined instantly while the IIFE ran fire-and-forget.
    const iifePattern = /(?:^|\n)\(async\s*\(\)\s*=>\s*\{/g;
    const matches = [...modifiedCode.matchAll(iifePattern)];

    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const matchedText = lastMatch[0];
      const leadingNewline = matchedText.startsWith('\n');
      const insertPos = lastMatch.index;
      const replacement = leadingNewline
        ? '\nreturn (async () => {'
        : 'return (async () => {';
      modifiedCode = modifiedCode.substring(0, insertPos) +
        replacement +
        modifiedCode.substring(insertPos + matchedText.length);
      log(`Added return before IIFE (match ${matches.length} of ${matches.length})`);
    } else {
      log('WARNING: Could not find IIFE pattern in connector code');
    }

    // Execute connector with page API in scope using AsyncFunction
    log('Starting connector execution...');
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const runConnectorFn = new AsyncFunction('page', modifiedCode);

    log('Calling connector function...');
    const result = await runConnectorFn.call(null, pageApi);
    log('Connector function completed with result:', result != null ? 'has result' : 'undefined');

    if (result !== undefined) {
      storeConnectorResult(runState, result);
    } else if (runState.resultEnvelope === null) {
      storeConnectorResult(runState, result);
    }
    const classification = emitStoredConnectorResult(runId, runState);

    // Mark as completed to prevent disconnect handler from sending STOPPED
    runState.connectorCompleted = true;

    // Close browser if still open
    if (!runState.browserClosed && runState.context) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        await runState.context.close();
      } catch (e) {
        // Browser may already be closed
      }
    }

    activeRuns.delete(runId);

    // Exit process after successful completion
    log(
      'Connector completed, classified outcome:',
      classification ? classification.outcome : 'unknown',
    );
    await drainStdout();
    process.exit(classification && classification.outcome === 'failure' ? 1 : 0);

  } catch (error) {
    log(`Error in run ${runId}:`, error.message);
    send({ type: 'error', runId, message: error.message });
    send({ type: 'status', runId, status: 'ERROR' });

    // Cleanup on error
    if (runState.context && !runState.browserClosed) {
      try {
        await runState.context.close();
      } catch (e) {}
    }
    activeRuns.delete(runId);

    // Exit process after error
    log('Connector failed, exiting');
    await drainStdout();
    process.exit(1);
  }
}

// Stop a run
async function stopRun(runId) {
  const run = activeRuns.get(runId);
  if (run) {
    log(`Stopping run ${runId}`);
    // Reject any pending requestInput promises so the connector doesn't hang
    for (const [, pending] of run.runState.pendingInputs) {
      pending.reject(new Error('Run stopped'));
    }
    run.runState.pendingInputs.clear();
    if (run.runState && run.runState.context && !run.runState.browserClosed) {
      await run.runState.context.close().catch(() => {});
    }
    activeRuns.delete(runId);
    send({ type: 'status', runId, status: 'STOPPED' });
  }
}

// Main loop - read commands from stdin
async function main() {
  log('Playwright runner started');
  send({ type: 'ready' });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  for await (const line of rl) {
    try {
      const cmd = JSON.parse(line);

      switch (cmd.type) {
        case 'run':
          runConnector(
            cmd.runId,
            cmd.connectorPath,
            cmd.url,
            cmd.headless !== false,
            cmd.allowHeaded !== false,
            cmd.requestedScopes,
          );
          break;

        case 'stop':
          await stopRun(cmd.runId);
          break;

        case 'quit':
          log('Quitting...');
          for (const [runId, run] of activeRuns) {
            if (run.runState && run.runState.context && !run.runState.browserClosed) {
              await run.runState.context.close().catch(() => {});
            }
          }
          process.exit(0);
          break;

        case 'test':
          // Simple test to prove Node.js is working
          const os = require('os');
          send({
            type: 'test-result',
            data: {
              nodejs: process.version,
              platform: process.platform,
              arch: process.arch,
              hostname: os.hostname(),
              cpus: os.cpus().length,
              memory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' GB',
              uptime: Math.round(os.uptime() / 60) + ' minutes'
            }
          });
          break;

        case 'evaluate': {
          const evalRun = activeRuns.get(cmd.runId);
          if (!evalRun) {
            send({ type: 'evaluate-result', runId: cmd.runId, error: `No active run: ${cmd.runId}` });
            break;
          }
          const { runState: evalState } = evalRun;
          if (evalState.browserClosed || !evalState.page) {
            send({ type: 'evaluate-result', runId: cmd.runId, error: 'Browser is closed' });
            break;
          }
          // Non-blocking: don't await so stdin loop keeps processing other commands.
          // Wrapped in try so synchronous throws (e.g. page torn down mid-call)
          // always produce an evaluate-result instead of hanging the driver.
          try {
            evalState.page.evaluate(cmd.script)
              .then(result => send({ type: 'evaluate-result', runId: cmd.runId, result }))
              .catch(e => send({ type: 'evaluate-result', runId: cmd.runId, error: e.stack || e.message }));
          } catch (e) {
            send({ type: 'evaluate-result', runId: cmd.runId, error: e.stack || e.message });
          }
          break;
        }

        case 'input-response': {
          const inputRun = activeRuns.get(cmd.runId);
          if (!inputRun) break;
          const pending = inputRun.runState.pendingInputs.get(cmd.requestId);
          if (!pending) break;
          inputRun.runState.pendingInputs.delete(cmd.requestId);
          if (cmd.error) {
            pending.reject(new Error(typeof cmd.error === 'string' ? cmd.error : JSON.stringify(cmd.error)));
          } else {
            pending.resolve(cmd.data);
          }
          break;
        }

        case 'screenshot': {
          const ssRun = activeRuns.get(cmd.runId);
          if (!ssRun) {
            send({ type: 'screenshot-result', runId: cmd.runId, error: `No active run: ${cmd.runId}` });
            break;
          }
          const { runState: ssState } = ssRun;
          if (ssState.browserClosed || !ssState.page) {
            send({ type: 'screenshot-result', runId: cmd.runId, error: 'Browser is closed' });
            break;
          }
          try {
            ssState.page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 })
              .then(buffer => send({ type: 'screenshot-result', runId: cmd.runId, data: buffer.toString('base64') }))
              .catch(e => send({ type: 'screenshot-result', runId: cmd.runId, error: e.stack || e.message }));
          } catch (e) {
            send({ type: 'screenshot-result', runId: cmd.runId, error: e.stack || e.message });
          }
          break;
        }

        default:
          log(`Unknown command: ${cmd.type}`);
      }
    } catch (error) {
      log(`Error parsing command: ${error.message}`);
    }
  }
}

main().catch(err => {
  log('Fatal error:', err);
  process.exit(1);
});
