/**
 * Oura Ring Connector
 *
 * Exports:
 * - Readiness scores (daily)
 * - Sleep data (daily scores + sleep periods)
 * - Activity data (daily)
 *
 * Uses email + OTP code authentication (the only option for Oura
 * accounts created without a password).
 *
 * Data is fetched via Oura's internal cloud API using session cookies.
 * 90-day lookback window, chunked into 30-day batches.
 *
 * Honest connector telemetry contract:
 * - Returns canonical flat result shape
 * - Explicit requestedScopes
 * - errors[] for unresolved output-affecting problems only
 * - omitted / degraded / fatal dispositions
 */

const PLATFORM = "oura";
const VERSION = "2.0.0";
const CANONICAL_SCOPES = [
  "oura.readiness",
  "oura.sleep",
  "oura.activity",
];

// ── Telemetry helpers ──────────────────────────────────────────────

const makeConnectorError = (errorClass, reason, disposition, extras = {}) => ({
  errorClass,
  reason,
  disposition,
  ...extras,
});

const makeFatalRunError = (errorClass, reason, phase = "collect") => {
  const error = new Error(reason);
  error.telemetryError = makeConnectorError(errorClass, reason, "fatal", { phase });
  return error;
};

const inferErrorClass = (message, fallback = "runtime_error") => {
  const text = String(message || "").toLowerCase();
  if (text.includes("auth") || text.includes("login") || text.includes("credential")) {
    return "auth_failed";
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (text.includes("network") || text.includes("fetch") || text.includes("net::")) {
    return "network_error";
  }
  if (text.includes("navigation") || text.includes("goto")) {
    return "navigation_error";
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
      label: "days of Oura data",
    },
  });

const resolveRequestedScopes = () => {
  const raw =
    typeof page.requestedScopes === "function" ? page.requestedScopes() : null;
  if (raw == null) {
    return [...CANONICAL_SCOPES];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw makeFatalRunError(
      "protocol_violation",
      "Oura connector received an empty or invalid requestedScopes array.",
      "init",
    );
  }
  const deduped = Array.from(new Set(raw));
  const invalid = deduped.filter((scope) => !CANONICAL_SCOPES.includes(scope));
  if (invalid.length > 0) {
    throw makeFatalRunError(
      "protocol_violation",
      `Oura connector received unsupported requestedScopes: ${invalid.join(", ")}.`,
      "init",
    );
  }
  return deduped;
};

// ── Resilience helpers ──────────────────────────────────────────────

const withTimeout = async (promise, ms, label) => {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const safeGoto = async (url, options = {}) => {
  const { attempts = 3, timeout = 15000, betweenMs = 2000 } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await withTimeout(
        page.goto(url, { timeout }),
        timeout + 5000,
        `goto ${url}`,
      );
      return true;
    } catch (error) {
      const message = error?.message || String(error);
      console.error(
        `[oura] Navigation attempt ${attempt}/${attempts} failed for ${url}: ${message}`,
      );
      if (attempt < attempts) {
        await page.sleep(betweenMs);
      }
    }
  }
  return false;
};

// ── Helpers ──────────────────────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const path = window.location.pathname;
        const onLogin = path.includes('/sign-in') ||
                        path.includes('/login') ||
                        path.includes('/oauth');

        if (onLogin) return false;

        const hasDashboard = !!document.querySelector('a[href*="readiness"]') ||
                             !!document.querySelector('a[href*="sleep"]') ||
                             !!document.querySelector('[class*="dashboard"]') ||
                             !!document.querySelector('[class*="Dashboard"]');
        return hasDashboard;
      })()
    `);
    return result || false;
  } catch {
    return false;
  }
};

const fetchCloudApi = async (path) => {
  const result = await page.evaluate(`
    (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const resp = await fetch(${JSON.stringify(path)}, {
          credentials: "include",
          headers: { "Accept": "application/json" },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return { success: false, status: resp.status, error: text.substring(0, 200) };
        }
        const data = await resp.json();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message || String(err) };
      }
    })()
  `);
  return result;
};

/**
 * Fetch daily data in chunks. Returns { allData, chunkResults } where
 * chunkResults tracks per-chunk success/failure for honest completeness reporting.
 */
const fetchDailyDataChunked = async (startDate, endDate, chunkDays) => {
  const allData = {};
  const chunkResults = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  let chunkStart = new Date(start);
  let chunkIndex = 0;

  while (chunkStart < end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const startStr = chunkStart.toISOString().split('T')[0];
    const endStr = chunkEnd.toISOString().split('T')[0];

    chunkIndex++;
    await page.setData('status', `Downloading data: ${startStr} to ${endStr} (chunk ${chunkIndex})...`);

    const result = await fetchCloudApi(`/api/account/daily-data?start=${startStr}&end=${endStr}`);

    if (result?.success && result.data) {
      chunkResults.push({ chunk: chunkIndex, startStr, endStr, ok: true });
      for (const key of Object.keys(result.data)) {
        if (Array.isArray(result.data[key])) {
          if (!allData[key]) allData[key] = [];
          allData[key].push(...result.data[key]);
        }
      }
    } else {
      chunkResults.push({
        chunk: chunkIndex,
        startStr,
        endStr,
        ok: false,
        error: result?.error || `HTTP ${result?.status || 'unknown'}`,
      });
    }

    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);

    await page.sleep(300);
  }

  return { allData, chunkResults };
};

// ── Login Flow ───────────────────────────────────────────────────────

const doLogin = async () => {
  await page.setData('status', 'Checking Oura login status...');
  const dashboardReachable = await safeGoto('https://cloud.ouraring.com/');
  if (!dashboardReachable) {
    throw makeFatalRunError(
      "navigation_error",
      "Could not reach Oura dashboard after multiple attempts.",
      "auth",
    );
  }
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
  }

  if (!isLoggedIn) {
    if (typeof page.requestInput === 'function') {
      const signInReachable = await safeGoto('https://cloud.ouraring.com/user/sign-in');
      if (!signInReachable) {
        throw makeFatalRunError(
          "navigation_error",
          "Could not reach Oura sign-in page after multiple attempts.",
          "auth",
        );
      }
      await page.sleep(3000);

      // Step 1: Ask for email
      const emailInput = await page.requestInput({
        message: 'Log in to Oura. A verification code will be sent to your email.',
        schema: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', description: 'Oura account email' },
          },
        },
      });

      await page.setData('status', 'Entering email...');

      try {
        const emailSelector = 'input#username, input[type="email"]';
        await page.waitForSelector(emailSelector, { timeout: 10000 });
        await page.fill(emailSelector, emailInput.email);
        await page.sleep(500);
        await page.click('button#submit-button, button[type="submit"]', { timeout: 5000 });
      } catch (e) {
        throw makeFatalRunError(
          "selector_error",
          `Could not fill email form: ${e.message || String(e)}`,
          "auth",
        );
      }

      await page.sleep(3000);

      // Step 2: Click "Send code" button
      await page.setData('status', 'Requesting verification code...');
      try {
        await page.waitForSelector('button[name="selectedId"], button#submit-button', { timeout: 10000 });
        await page.click('button[name="selectedId"], button#submit-button', { timeout: 5000 });
      } catch (e) {
        // May have skipped the send-code screen
      }

      await page.sleep(3000);
      await page.setData('status', 'Verification code sent! Check your email.');

      // Step 3: Ask user for the 6-digit OTP code
      const codeInput = await page.requestInput({
        message: 'Check your email for a 6-digit code from Oura and enter it below.',
        schema: {
          type: 'object',
          required: ['code'],
          properties: {
            code: {
              type: 'string',
              description: '6-digit verification code',
              minLength: 6,
              maxLength: 6,
            },
          },
        },
      });

      // Step 4: Submit the OTP code
      await page.setData('status', 'Submitting verification code...');
      try {
        const otpSelector = 'input#otp-code, input[name="otp"]';
        await page.waitForSelector(otpSelector, { timeout: 10000 });
        await page.fill(otpSelector, codeInput.code);
        await page.sleep(500);
        await page.click('button#submit-button, button[type="submit"]', { timeout: 5000 });
      } catch (e) {
        throw makeFatalRunError(
          "selector_error",
          `Could not submit verification code: ${e.message || String(e)}`,
          "auth",
        );
      }

      await page.sleep(5000);

      isLoggedIn = await checkLoginStatus();

      if (!isLoggedIn) {
        await safeGoto('https://cloud.ouraring.com/');
        await page.sleep(3000);
        isLoggedIn = await checkLoginStatus();
      }

      if (!isLoggedIn) {
        const meCheck = await fetchCloudApi('/api/me');
        if (meCheck?.success) {
          isLoggedIn = true;
        }
      }
    }

    // Fallback: manual login via browser takeover
    if (!isLoggedIn) {
      const { headed } = await page.showBrowser('https://cloud.ouraring.com/user/sign-in');
      if (headed) {
        await page.setData('status', 'Please complete sign-in manually in the browser below.');
        await page.promptUser(
          'Automatic sign-in did not complete. Please finish signing in manually.',
          async () => await checkLoginStatus(),
          5000
        );
        await page.goHeadless();
        isLoggedIn = await checkLoginStatus();
      } else {
        throw makeFatalRunError(
          "auth_failed",
          "Login requires a headed browser or requestInput support.",
          "auth",
        );
      }
    }
  }

  if (!isLoggedIn) {
    throw makeFatalRunError(
      "auth_failed",
      "Oura login could not be confirmed.",
      "auth",
    );
  }

  await page.setData('status', 'Login confirmed. Verifying API access...');

  const meResult = await fetchCloudApi('/api/me');
  if (!meResult?.success) {
    throw makeFatalRunError(
      "auth_failed",
      "Could not access Oura cloud API. Try disconnecting and reconnecting to refresh your session.",
      "auth",
    );
  }
};

// ── Scope extraction helpers ────────────────────────────────────────

const mapReadiness = (rawReadiness) =>
  rawReadiness.map((d) => ({
    id: d.id,
    day: d.day,
    score: d.score,
    timestamp: d.timestamp,
    temperatureDeviation: d.temperature_deviation,
    temperatureTrendDeviation: d.temperature_trend_deviation,
    contributors: d.contributors || {},
  }));

const mapSleep = (dailySleep, sleepPeriods) => ({
  dailyScores: dailySleep.map((d) => ({
    id: d.id,
    day: d.day,
    score: d.score,
    timestamp: d.timestamp,
    contributors: d.contributors || {},
  })),
  sleepPeriods: sleepPeriods.map((d) => ({
    id: d.id,
    day: d.day,
    type: d.type,
    bedtimeStart: d.bedtime_start,
    bedtimeEnd: d.bedtime_end,
    totalSleepDuration: d.total_sleep_duration,
    timeInBed: d.time_in_bed,
    deepSleepDuration: d.deep_sleep_duration,
    lightSleepDuration: d.light_sleep_duration,
    remSleepDuration: d.rem_sleep_duration,
    awakeTime: d.awake_time,
    efficiency: d.efficiency,
    latency: d.latency,
    averageHeartRate: d.average_heart_rate,
    averageHrv: d.average_hrv,
    lowestHeartRate: d.lowest_heart_rate,
    averageBreath: d.average_breath,
    restlessPeriods: d.restless_periods,
  })),
});

const mapActivity = (rawActivity) =>
  rawActivity.map((d) => ({
    id: d.id,
    day: d.day,
    score: d.score,
    timestamp: d.timestamp,
    activeCalories: d.active_calories,
    totalCalories: d.total_calories,
    steps: d.steps,
    equivalentWalkingDistance: d.equivalent_walking_distance,
    highActivityTime: d.high_activity_time,
    mediumActivityTime: d.medium_activity_time,
    lowActivityTime: d.low_activity_time,
    sedentaryTime: d.sedentary_time,
    restingTime: d.resting_time,
    inactivityAlerts: d.inactivity_alerts,
    contributors: d.contributors || {},
  }));

// ── Main Flow ───────────────────────────────────────────────────────
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
    const errors = [];
    const scopes = {};

    // ── Auth ──
    await doLogin();

    // ── Data Collection ──
    await page.setData('status', 'Fetching health data...');

    const endDate = new Date().toISOString().split('T')[0];
    const startDateObj = new Date();
    startDateObj.setDate(startDateObj.getDate() - 90);
    const startDate = startDateObj.toISOString().split('T')[0];

    const { allData, chunkResults } = await fetchDailyDataChunked(startDate, endDate, 30);

    const totalChunks = chunkResults.length;
    const failedChunks = chunkResults.filter((c) => !c.ok);

    // All chunks failed → no raw data is trustworthy for any scope
    if (totalChunks > 0 && failedChunks.length === totalChunks) {
      throw makeFatalRunError(
        "upstream_error",
        `All ${totalChunks} data chunks failed. No Oura data could be retrieved.`,
        "collect",
      );
    }

    const sleepPeriods = allData.sleeps || [];
    const dailySleep = allData.daily_sleeps || [];
    const rawReadiness = allData.daily_readinesses || [];
    const rawActivity = allData.daily_activities || [];

    // Chunk-level degradation applies to all scopes that use daily data
    const hasChunkDegradation = failedChunks.length > 0;

    // ── Per-scope collection ──

    if (wantsScope("oura.readiness")) {
      scopes["oura.readiness"] = { days: mapReadiness(rawReadiness) };
      if (hasChunkDegradation) {
        errors.push(makeConnectorError(
          "upstream_error",
          `${failedChunks.length}/${totalChunks} data chunks failed; readiness data may be incomplete.`,
          "degraded",
          { scope: "oura.readiness", phase: "collect" },
        ));
      }
    }

    if (wantsScope("oura.sleep")) {
      scopes["oura.sleep"] = mapSleep(dailySleep, sleepPeriods);
      if (hasChunkDegradation) {
        errors.push(makeConnectorError(
          "upstream_error",
          `${failedChunks.length}/${totalChunks} data chunks failed; sleep data may be incomplete.`,
          "degraded",
          { scope: "oura.sleep", phase: "collect" },
        ));
      }
    }

    if (wantsScope("oura.activity")) {
      scopes["oura.activity"] = { days: mapActivity(rawActivity) };
      if (hasChunkDegradation) {
        errors.push(makeConnectorError(
          "upstream_error",
          `${failedChunks.length}/${totalChunks} data chunks failed; activity data may be incomplete.`,
          "degraded",
          { scope: "oura.activity", phase: "collect" },
        ));
      }
    }

    // ── Build result ──
    const totalItems =
      (scopes["oura.readiness"]?.days?.length || 0) +
      (scopes["oura.sleep"]?.sleepPeriods?.length || 0) +
      (scopes["oura.activity"]?.days?.length || 0);

    const result = buildResult({
      requestedScopes,
      scopes,
      errors,
      exportSummary: {
        count: totalItems,
        label: "days of Oura data",
        details: {
          readiness: scopes["oura.readiness"]?.days?.length || 0,
          sleepScores: scopes["oura.sleep"]?.dailyScores?.length || 0,
          sleepPeriods: scopes["oura.sleep"]?.sleepPeriods?.length || 0,
          activity: scopes["oura.activity"]?.days?.length || 0,
        },
      },
    });

    await page.setData("result", result);
    await page.setData(
      "status",
      `Complete! ${scopes["oura.readiness"]?.days?.length || 0} readiness, ` +
      `${scopes["oura.sleep"]?.sleepPeriods?.length || 0} sleep periods, ` +
      `${scopes["oura.activity"]?.days?.length || 0} activity days collected.`,
    );

    return result;
  } catch (error) {
    const telemetryError =
      error?.telemetryError ||
      makeConnectorError(
        inferErrorClass(error?.message || String(error)),
        error?.message || String(error),
        "fatal",
        { phase: "collect" },
      );
    const result = buildEmptyResult(requestedScopes, [telemetryError]);
    await page.setData("result", result);
    await page.setData("error", telemetryError.reason);
    return result;
  }
})();
