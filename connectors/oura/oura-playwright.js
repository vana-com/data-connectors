/**
 * Oura Ring Connector
 *
 * Ported from Context Gateway's production oura.js (the proven-working
 * version) with CG-only API calls converted to the canonical page API:
 *   getInput({title, schema, uiSchema, submitLabel})
 *     → requestInput({message, schema})
 *   promptUser → guarded with showBrowser().headed check
 *
 * Uses email + OTP code authentication (the only option for Oura
 * accounts created without a password).
 *
 * Data is fetched via Oura's internal cloud API using session cookies.
 * 90-day lookback window, chunked into 30-day batches.
 */

const state = {
  isComplete: false,
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
      if (/target.*closed|context.*closed|browser.*closed/i.test(message)) {
        return false;
      }
      if (attempt < attempts) {
        try {
          await page.sleep(betweenMs);
        } catch {
          return false;
        }
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

const fetchDailyDataChunked = async (startDate, endDate, chunkDays) => {
  const allData = {};
  const start = new Date(startDate);
  const end = new Date(endDate);

  let chunkStart = new Date(start);
  let chunkIndex = 0;
  const totalChunks = Math.ceil(90 / chunkDays);

  while (chunkStart < end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const startStr = chunkStart.toISOString().split('T')[0];
    const endStr = chunkEnd.toISOString().split('T')[0];

    chunkIndex++;
    await page.setData('status', `Downloading data: ${startStr} to ${endStr} (chunk ${chunkIndex}/${totalChunks})...`);

    const result = await fetchCloudApi(`/api/account/daily-data?start=${startStr}&end=${endStr}`);

    if (result?.success && result.data) {
      for (const key of Object.keys(result.data)) {
        if (Array.isArray(result.data[key])) {
          if (!allData[key]) allData[key] = [];
          allData[key].push(...result.data[key]);
        }
      }
    }

    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);

    await page.sleep(300);
  }

  return allData;
};

// ── Login Flow ───────────────────────────────────────────────────────

await page.setData('status', 'Checking Oura login status...');
const dashboardReachable = await safeGoto('https://cloud.ouraring.com/');
if (!dashboardReachable) {
  return {
    success: false,
    error: 'Could not reach Oura dashboard after multiple attempts.',
  };
}
await page.sleep(3000);

let isLoggedIn = await checkLoginStatus();

if (!isLoggedIn) {
  await page.sleep(2000);
  isLoggedIn = await checkLoginStatus();
}

if (!isLoggedIn) {
  if (typeof page.requestInput === 'function') {
    // Oura uses email + OTP code auth: enter email → send code → enter 6-digit code
    const signInReachable = await safeGoto('https://cloud.ouraring.com/user/sign-in');
    if (!signInReachable) {
      return {
        success: false,
        error: 'Could not reach Oura sign-in page after multiple attempts.',
      };
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

    // Fill the email field and click Continue
    try {
      const emailSelector = 'input#username, input[type="email"]';
      await page.waitForSelector(emailSelector, { timeout: 10000 });
      await page.fill(emailSelector, emailInput.email);
      await page.sleep(500);
      await page.click('button#submit-button, button[type="submit"]', { timeout: 5000 });
    } catch (e) {
      return { success: false, error: `Could not fill email form: ${e.message || String(e)}` };
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
      return { success: false, error: `Could not submit verification code: ${e.message || String(e)}` };
    }

    await page.sleep(5000);

    // Check if we landed on the dashboard
    isLoggedIn = await checkLoginStatus();

    if (!isLoggedIn) {
      // May still be on moi.ouraring.com, navigate to cloud
      await safeGoto('https://cloud.ouraring.com/');
      await page.sleep(3000);
      isLoggedIn = await checkLoginStatus();
    }

    // Also check by trying the API directly
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
      return {
        success: false,
        error: 'Login requires a headed browser or requestInput support.',
      };
    }
  }
}

if (!isLoggedIn) {
  return { success: false, error: 'Oura login could not be confirmed.' };
}

await page.setData('status', 'Login confirmed. Verifying API access...');

// ── Verify API Access ────────────────────────────────────────────────

const meResult = await fetchCloudApi('/api/me');
if (!meResult?.success) {
  return {
    success: false,
    error: 'Could not access Oura cloud API. Try disconnecting and reconnecting to refresh your session.'
  };
}

// ── Data Collection ──────────────────────────────────────────────────

await page.setData('status', 'Fetching health data...');

const endDate = new Date().toISOString().split('T')[0];
const startDateObj = new Date();
startDateObj.setDate(startDateObj.getDate() - 90);
const startDate = startDateObj.toISOString().split('T')[0];

const rawData = await fetchDailyDataChunked(startDate, endDate, 30);

const sleepPeriods = rawData.sleeps || [];
const dailySleep = rawData.daily_sleeps || [];
const readiness = rawData.daily_readinesses || [];
const activity = rawData.daily_activities || [];

// ── Build Result ─────────────────────────────────────────────────────

const result = {
  'oura.readiness': {
    days: readiness.map(d => ({
      id: d.id,
      day: d.day,
      score: d.score,
      timestamp: d.timestamp,
      temperatureDeviation: d.temperature_deviation,
      temperatureTrendDeviation: d.temperature_trend_deviation,
      contributors: d.contributors || {},
    })),
  },

  'oura.sleep': {
    dailyScores: dailySleep.map(d => ({
      id: d.id,
      day: d.day,
      score: d.score,
      timestamp: d.timestamp,
      contributors: d.contributors || {},
    })),
    sleepPeriods: sleepPeriods.map(d => ({
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
  },

  'oura.activity': {
    days: activity.map(d => ({
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
    })),
  },

  exportSummary: {
    count: readiness.length + sleepPeriods.length + activity.length,
    label: 'days of Oura data',
    details: [
      readiness.length + ' readiness scores',
      dailySleep.length + ' sleep scores',
      sleepPeriods.length + ' sleep periods',
      activity.length + ' activity days',
    ].join(', '),
  },
  timestamp: new Date().toISOString(),
  version: '1.0.0',
  platform: 'oura',
};

state.isComplete = true;
await page.setData('result', result);
await page.setData('status',
  `Complete! ${readiness.length} readiness, ${sleepPeriods.length} sleep periods, ${activity.length} activity days collected.`
);

return { success: true, data: result };
