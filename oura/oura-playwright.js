/**
 * Oura Ring Connector (Playwright) — Two-Phase Architecture
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session (headless)
 *   - If not logged in, shows browser for user to log in
 *
 * Phase 2 (Browser, headless — invisible to user):
 *   - Fetches data via Oura's internal cloud API (cloud.ouraring.com/api/...)
 *   - Authentication is automatic via httpOnly session cookies
 *   - Reports structured progress to the UI
 */

// State management
const state = {
  isComplete: false,
};

// ─── Browser-Phase Helpers ───────────────────────────────────────────

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
  } catch (err) {
    return false;
  }
};

// ─── Internal API Helpers ────────────────────────────────────────────

// Fetch from Oura's internal cloud API (same-origin, cookie auth)
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

// Fetch daily-data in date chunks (Oura cloud API may limit range)
const fetchDailyDataChunked = async (startDate, endDate, chunkDays) => {
  const allData = {};
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
    await page.setProgress({
      phase: { step: chunkIndex, total: Math.ceil(90 / chunkDays), label: 'Fetching data' },
      message: `Downloading ${startStr} to ${endStr}...`,
      count: chunkIndex,
    });

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

// ─── Main Export Flow ────────────────────────────────────────────────

(async () => {
  // ═══ PHASE 1: Browser — Login ═══

  await page.setData('status', 'Checking login status...');
  await page.goto('https://cloud.ouraring.com/');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.sleep(2000);
    isLoggedIn = await checkLoginStatus();
  }

  if (!isLoggedIn) {
    await page.goto('https://cloud.ouraring.com/user/sign-in');
    await page.sleep(2000);

    // Check if login form is present
    const hasLoginForm = await page.evaluate(`
      !!document.querySelector('input[type="email"], input[name="email"]') &&
      !!document.querySelector('input[type="password"], input[name="password"]')
    `);

    if (hasLoginForm) {
      const credResult = await page.requestData({
        message: "Log in to your Oura account",
        schema: {
          type: "object",
          properties: {
            email: { type: "string", description: "Oura account email" },
            password: { type: "string", format: "password" },
          },
          required: ["email", "password"],
        },
      });
      if (credResult.status === 'skipped') {
        await page.setData('error', 'Login credentials required but not available in automated mode.');
        return;
      }
      const { email, password } = credResult.data;

      await page.evaluate(`
        (() => {
          const emailInput = document.querySelector('input[type="email"], input[name="email"]');
          if (emailInput) {
            emailInput.value = ${JSON.stringify(email)};
            emailInput.dispatchEvent(new Event('input', {bubbles:true}));
            emailInput.dispatchEvent(new Event('change', {bubbles:true}));
          }
        })()
      `);
      await page.evaluate(`
        (() => {
          const passwordInput = document.querySelector('input[type="password"], input[name="password"]');
          if (passwordInput) {
            passwordInput.value = ${JSON.stringify(password)};
            passwordInput.dispatchEvent(new Event('input', {bubbles:true}));
            passwordInput.dispatchEvent(new Event('change', {bubbles:true}));
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

      isLoggedIn = await checkLoginStatus();
    }

    // Fallback to headed browser if programmatic login failed
    if (!isLoggedIn) {
      await page.setData('status', 'Please complete login in the browser...');
      await page.requestManualAction(
        'Complete any remaining verification, then click "Done".',
        async () => await checkLoginStatus(),
        { url: 'https://cloud.ouraring.com/user/sign-in', interval: 2000 },
      );
      isLoggedIn = await checkLoginStatus();
    }

    await page.setData('status', 'Login completed');
    await page.sleep(2000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ Verify API access ═══
  await page.setData('status', 'Verifying API access...');
  const meResult = await fetchCloudApi('/api/me');

  if (!meResult?.success) {
    await page.setData('error',
      'Could not access Oura cloud API. Try disconnecting and reconnecting to refresh your session.'
    );
    return;
  }

  await page.setData('status', 'Switching to background mode...');

  // ═══ Switch to headless ═══
  await page.goHeadless();

  // ═══ PHASE 2: Headless — Data Collection ═══

  const endDate = new Date().toISOString().split('T')[0];
  const startDateObj = new Date();
  startDateObj.setDate(startDateObj.getDate() - 90);
  const startDate = startDateObj.toISOString().split('T')[0];

  // Fetch all data via internal API in 30-day chunks
  const rawData = await fetchDailyDataChunked(startDate, endDate, 30);

  // Map internal API field names to our schema
  const sleepPeriods = rawData.sleeps || [];
  const dailySleep = rawData.daily_sleeps || [];
  const readiness = rawData.daily_readinesses || [];
  const activity = rawData.daily_activities || [];

  // ═══ Build Result ═══

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
    version: '1.0.0-playwright',
    platform: 'oura',
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status',
    `Complete! ${readiness.length} readiness, ${sleepPeriods.length} sleep periods, ${activity.length} activity days collected.`
  );

  return { success: true, data: result };
})();
