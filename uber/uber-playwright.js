/**
 * Uber Connector (Playwright)
 *
 * Exports:
 * - uber.trips — Trip history with pickup/dropoff locations, dates, fares
 * - uber.receipts — Detailed receipt/fare breakdowns per trip
 *
 * Extraction method: Network capture of GraphQL (riders.uber.com/graphql)
 * triggered by clicking Activity tab on m.uber.com, plus DOM scraping.
 */

// ─── Credentials ─────────────────────────────────────────────

const UBER_LOGIN = process.env.USER_LOGIN_UBER || '';
const UBER_PASSWORD = process.env.USER_PASSWORD_UBER || '';

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const url = window.location.href;
        if (url.includes('auth.uber.com')) return false;
        if (url.includes('m.uber.com')) return true;
        if (url.includes('riders.uber.com')) return true;
        return false;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Automated Login ─────────────────────────────────────────

const performLogin = async () => {
  const loginStr = JSON.stringify(UBER_LOGIN);
  const passwordStr = JSON.stringify(UBER_PASSWORD);

  await page.goto('https://auth.uber.com/v2/');
  await page.sleep(3000);

  await page.evaluate(`
    (() => {
      const emailInput = document.querySelector('input[name="email"]') ||
                         document.querySelector('input[name="username"]') ||
                         document.querySelector('input[id="useridInput"]') ||
                         document.querySelector('input[type="email"]') ||
                         document.querySelector('input[type="text"]');
      if (emailInput) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(emailInput, ${loginStr});
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(1000);

  await page.evaluate(`
    (() => {
      const btn = document.querySelector('button[type="submit"]') ||
                  document.querySelector('button[id="forward-button"]');
      if (btn) btn.click();
    })()
  `);
  await page.sleep(3000);

  await page.evaluate(`
    (() => {
      const passwordInput = document.querySelector('input[name="password"]') ||
                            document.querySelector('input[type="password"]');
      if (passwordInput) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(passwordInput, ${passwordStr});
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  await page.sleep(1000);

  await page.evaluate(`
    (() => {
      const btn = document.querySelector('button[type="submit"]') ||
                  document.querySelector('button[id="forward-button"]');
      if (btn) btn.click();
    })()
  `);
  await page.sleep(5000);
};

// ─── Trip Extraction from GraphQL Response ───────────────────

const extractTripsFromActivities = (resp) => {
  if (!resp) return [];
  const trips = [];

  // Navigate to data.data.activities.past.activities[]
  const data = resp.data || resp;
  const activities = data?.data?.activities?.past?.activities ||
                     data?.activities?.past?.activities ||
                     [];

  for (const activity of activities) {
    // Extract UUID from the Details button URL
    let uuid = activity.uuid || '';
    if (!uuid && activity.buttons) {
      for (const btn of activity.buttons) {
        const urlMatch = (btn.url || '').match(/\/trips\/([a-f0-9-]+)/i);
        if (urlMatch) {
          uuid = urlMatch[1];
          break;
        }
      }
    }
    if (!uuid && activity.jobUUID) uuid = activity.jobUUID;
    if (!uuid) continue;

    trips.push({
      uuid: uuid,
      title: activity.title || '',
      subtitle: activity.subtitle || '',
      fare: activity.fare || activity.formattedTotal || '',
      status: activity.status || 'COMPLETED',
      dateTime: activity.dateTime || activity.requestTime || '',
      imageURL: activity.imageURL || '',
    });
  }

  return trips;
};

// ─── DOM Scraping for Trip Details ───────────────────────────

const scrapeTripDetailsFromPage = async () => {
  return await page.evaluate(`
    (() => {
      const text = document.body?.innerText || '';
      const lines = text.split('\\n').map(l => l.trim()).filter(l => l);
      const trips = [];

      // Parse trip cards: pattern is Address, DateTime, Price, [Help/Details]
      let i = 0;
      const dateTimeRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d/i;
      const priceRe = /^[A-Z]*\\$\\d+\\.\\d{2}$/;
      const dateRangeRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d+\\s*-/i;

      while (i < lines.length) {
        // Skip section headers like "Oct 16 - Oct 24"
        if (dateRangeRe.test(lines[i])) { i++; continue; }
        // Skip nav items
        if (['Uber','Ride','Rental Cars','Courier','Eat','Activity','Upcoming','Past','Personal','All Trips','You have no upcoming trips','Reserve ride','Help','Details','More'].includes(lines[i])) { i++; continue; }

        // Look for: address line, then datetime, then price
        if (i + 2 < lines.length && !dateTimeRe.test(lines[i]) && dateTimeRe.test(lines[i+1])) {
          const address = lines[i];
          const dateTime = lines[i+1];
          const fare = priceRe.test(lines[i+2]) ? lines[i+2] : '';
          trips.push({ address, dateTime, fare });
          i += fare ? 3 : 2;
          // Skip Help/Details buttons
          while (i < lines.length && (lines[i] === 'Help' || lines[i] === 'Details')) i++;
        } else {
          i++;
        }
      }

      return trips;
    })()
  `);
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 3;

  // ═══ PHASE 1: Login (three-tier strategy) ═══
  await page.setData('status', 'Checking login status...');
  await page.goto('https://m.uber.com');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (isLoggedIn) {
    await page.setData('status', 'Session restored from browser profile');
  }

  // Tier 2: Automated login with credentials from .env
  if (!isLoggedIn && UBER_LOGIN && UBER_PASSWORD) {
    await page.setData('status', 'Attempting automated login...');
    await performLogin();
    await page.goto('https://m.uber.com');
    await page.sleep(3000);
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
    await page.setData('status', 'Opening browser for manual login...');
    await page.showBrowser('https://auth.uber.com/v2/');
    await page.promptUser(
      'Please log in to Uber. Login will be detected automatically when you reach the Uber home page.',
      async () => await checkLoginStatus(),
      3000
    );
    isLoggedIn = true;
    await page.setData('status', 'Manual login successful');
  }

  // ═══ PHASE 2: Data Collection (headless) ═══
  await page.goHeadless();

  // ═══ STEP 1: Navigate to Activity and capture trips ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching trip history' },
    message: 'Loading trip history...',
  });

  // Register network capture for Activities GraphQL response
  await page.captureNetwork({
    urlPattern: 'graphql',
    bodyPattern: 'Activities',
    key: 'activities'
  });

  // Click the Activity button in the SPA navigation
  const clicked = await page.evaluate(`
    (() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim() === 'Activity') {
          let el = walker.currentNode.parentElement;
          for (let i = 0; i < 5 && el; i++) {
            if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'button') {
              el.click();
              return true;
            }
            el = el.parentElement;
          }
          walker.currentNode.parentElement?.click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (!clicked) {
    // Fallback: try direct URL navigation
    await page.goto('https://riders.uber.com/trips');
  }
  await page.sleep(5000);

  // Get trips from captured GraphQL Activities response
  const activitiesResp = await page.getCapturedResponse('activities');
  let apiTrips = extractTripsFromActivities(activitiesResp);

  // Also scrape visible trip info from the page
  const pageTrips = await scrapeTripDetailsFromPage();

  await page.setData('status', 'Found ' + apiTrips.length + ' trips from API, ' + pageTrips.length + ' from page');

  // Try to load more trips by clicking "More" button
  let loadMoreAttempts = 0;
  const MAX_LOAD_MORE = 10;

  while (loadMoreAttempts < MAX_LOAD_MORE) {
    // Clear capture for next batch
    await page.clearNetworkCaptures();
    await page.captureNetwork({
      urlPattern: 'graphql',
      bodyPattern: 'Activities',
      key: 'more_activities'
    });

    const hasMore = await page.evaluate(`
      (() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'more' || text === 'load more' || text === 'show more') {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);

    if (!hasMore) break;

    await page.sleep(3000);
    loadMoreAttempts++;

    // Get more activities from the new GraphQL response
    const moreResp = await page.getCapturedResponse('more_activities');
    const moreTrips = extractTripsFromActivities(moreResp);

    if (moreTrips.length === 0) break;
    apiTrips.push(...moreTrips);

    // Also get new DOM trips
    const morePageTrips = await scrapeTripDetailsFromPage();
    // Replace page trips with the fuller list
    if (morePageTrips.length > pageTrips.length) {
      pageTrips.length = 0;
      pageTrips.push(...morePageTrips);
    }

    await page.setProgress({
      phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching trip history' },
      message: `Loaded ${apiTrips.length} trips...`,
      count: apiTrips.length,
    });
  }

  // Deduplicate API trips by UUID
  const seenUuids = new Set();
  apiTrips = apiTrips.filter(t => {
    if (seenUuids.has(t.uuid)) return false;
    seenUuids.add(t.uuid);
    return true;
  });

  // ═══ STEP 2: Merge API and DOM data, fetch receipt details ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching receipts' },
    message: 'Fetching trip receipt details...',
  });

  const allTrips = [];
  const allReceipts = [];

  // Merge: use API trips for UUIDs, supplement with DOM scraping data
  for (let i = 0; i < apiTrips.length; i++) {
    const apiTrip = apiTrips[i];
    const pageTripInfo = i < pageTrips.length ? pageTrips[i] : null;

    allTrips.push({
      id: apiTrip.uuid,
      status: apiTrip.status || 'COMPLETED',
      requestTime: pageTripInfo?.dateTime || apiTrip.dateTime || '',
      dropoffTime: '',
      pickupAddress: pageTripInfo?.address || '',
      dropoffAddress: '',
      fare: pageTripInfo?.fare || apiTrip.fare || '',
      currencyCode: '',
      vehicleType: '',
      city: '',
      isSurge: false,
    });
  }

  // Visit individual trip detail pages for receipt info
  const MAX_DETAIL_FETCHES = Math.min(allTrips.length, 50);
  for (let i = 0; i < MAX_DETAIL_FETCHES; i++) {
    const trip = allTrips[i];
    const detailUrl = 'https://riders.uber.com/trips/' + trip.id;

    await page.goto(detailUrl);
    await page.sleep(2000);

    const detail = await page.evaluate(`
      (() => {
        try {
          const text = document.body?.innerText || '';
          const lines = text.split('\\n').map(l => l.trim()).filter(l => l);

          let fare = '';
          let pickupAddr = '';
          let dropoffAddr = '';
          let vehicleType = '';
          let distance = '';
          let duration = '';
          let dateTime = '';

          for (const line of lines) {
            if (!fare && /^[A-Z]*\\$\\d+[.,]\\d{2}/.test(line)) fare = line;
            if (!dateTime && /\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/i.test(line) && /\\d/.test(line)) dateTime = line;
            if (!distance && /\\d+\\.?\\d*\\s*(km|mi|miles|kilometers)/i.test(line)) distance = line;
            if (!duration && /\\d+\\s*(min|minutes|hour|hours|hr)/i.test(line)) duration = line;
          }

          // Vehicle type
          for (const line of lines) {
            if (/^uber\\s*(x|xl|black|comfort|green|pool|select|premier|connect|share)/i.test(line) ||
                /^(uberx|uber xl|uber black|uber comfort)/i.test(line)) {
              vehicleType = line;
              break;
            }
          }

          // Pickup and dropoff
          let foundPickup = false;
          let foundDropoff = false;
          for (let j = 0; j < lines.length; j++) {
            const lower = lines[j].toLowerCase();
            if (!foundPickup && (lower === 'pick-up' || lower === 'pickup' || lower === 'picked up')) {
              for (let k = j + 1; k < Math.min(j + 3, lines.length); k++) {
                if (lines[k].length > 5 && !/drop|time|fare/i.test(lines[k])) {
                  pickupAddr = lines[k];
                  foundPickup = true;
                  break;
                }
              }
            }
            if (!foundDropoff && (lower === 'drop-off' || lower === 'dropoff' || lower === 'dropped off')) {
              for (let k = j + 1; k < Math.min(j + 3, lines.length); k++) {
                if (lines[k].length > 5) {
                  dropoffAddr = lines[k];
                  foundDropoff = true;
                  break;
                }
              }
            }
          }

          return { fare, pickupAddr, dropoffAddr, vehicleType, distance, duration, dateTime };
        } catch(e) { return {}; }
      })()
    `);

    // Update trip with detailed info
    if (detail.pickupAddr) trip.pickupAddress = detail.pickupAddr;
    if (detail.dropoffAddress) trip.dropoffAddress = detail.dropoffAddr;
    if (detail.fare) trip.fare = detail.fare;
    if (detail.vehicleType) trip.vehicleType = detail.vehicleType;
    if (detail.dateTime && !trip.requestTime) trip.requestTime = detail.dateTime;

    allReceipts.push({
      tripId: trip.id,
      fare: detail.fare || trip.fare || '',
      currencyCode: '',
      distance: detail.distance || '',
      distanceLabel: '',
      duration: detail.duration || '',
      durationLabel: '',
      vehicleType: detail.vehicleType || '',
      surgeMultiplier: '',
      fareBreakdown: '',
    });

    if ((i + 1) % 5 === 0) {
      await page.setProgress({
        phase: { step: 2, total: TOTAL_STEPS, label: 'Fetching receipts' },
        message: `Fetched ${i + 1} of ${MAX_DETAIL_FETCHES} receipts...`,
        count: i + 1,
      });
    }

    await page.sleep(500);
  }

  if (allTrips.length === 0) {
    await page.setData('error', 'No trips found in your Uber account');
    return;
  }

  // ═══ STEP 3: Build result ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const result = {
    'uber.trips': {
      trips: allTrips,
    },
    'uber.receipts': {
      receipts: allReceipts.length > 0 ? allReceipts : allTrips.map(t => ({
        tripId: t.id, fare: t.fare || '', currencyCode: '', distance: '',
        distanceLabel: '', duration: '', durationLabel: '',
        vehicleType: t.vehicleType || '', surgeMultiplier: '', fareBreakdown: '',
      })),
    },
    exportSummary: {
      count: allTrips.length,
      label: 'trips',
      details: `${allTrips.length} trips, ${allReceipts.length || allTrips.length} receipts`,
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'uber',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);
})();
