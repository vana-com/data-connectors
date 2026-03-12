/**
 * Max Connector (Playwright) — Hybrid API + DOM Extraction
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session
 *   - If not logged in, shows browser for user to log in
 *   - Captures JWT token and profile via network interception
 *
 * Phase 2 (Background — browser closed):
 *   - Uses captured token with httpFetch to call Max CMS API
 *   - Extracts profile, viewing history, continue watching, My List
 *   - Falls back to DOM extraction if API capture fails
 */

const state = {
  token: null,
  profileId: null,
  profile: null,
  isComplete: false,
};

// ─── Helpers ────────────────────────────────────────────

const stripBidi = (s) => (s || '').replace(/[\u2066\u2067\u2068\u2069\u202A-\u202E\u200E\u200F]/g, '').trim();

const cleanTitle = (raw) => {
  let t = stripBidi(raw);
  t = t.replace(/\.\s*\d+\s+z\s+\d+\.?.*$/, '');
  t = t.replace(/\.\s*\d+\s+of\s+\d+\.?.*$/, '');
  t = t.replace(/^Oglądaj\s+/, '');
  const seasonMatch = t.match(/^(.+?)\.\s*Sezon\s+\d+,\s*odcinek\s+\d+:\s*(.+)$/);
  if (seasonMatch) t = seasonMatch[1] + ' — ' + seasonMatch[2];
  t = t.replace(/\.\s*Pozostało\s+.+$/, '');
  t = t.replace(/\.\s*Klasyfikacja:.+$/, '');
  t = t.replace(/\.\s*Premiera w\s+\d{4}$/, '');
  return t.trim();
};

// ─── Login Detection ────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const path = window.location.pathname;
        const host = window.location.hostname;
        if (/\\/(signin|sign-in|login|auth)/.test(path)) return false;
        if (!host.includes('max.com')) return false;
        if (!!document.querySelector('input[type="password"]')) return false;
        if (!!document.querySelector('input[type="email"]')) return false;
        if (document.querySelector('[data-testid="default-avatar"]')) return true;
        if (document.querySelector('img[alt*="profile" i]')) return true;
        if (document.querySelector('nav') && path === '/') return true;
        return false;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── API Helpers ────────────────────────────────────────

const apiHeaders = () => ({
  'Authorization': 'Bearer ' + state.token,
  'Accept': 'application/vnd.api+json',
  'x-hbo-profile-id': state.profileId || '',
});

const apiFetch = async (url) => {
  const resp = await page.httpFetch(url, { headers: apiHeaders() });
  if (!resp.ok) return null;
  return resp.json;
};

// ─── Scroll for DOM fallback ────────────────────────────

const scrollToLoadContent = async () => {
  for (let i = 0; i < 10; i++) {
    await page.evaluate(`window.scrollBy(0, 800)`);
    await page.sleep(1500);
  }
  await page.evaluate(`window.scrollTo(0, 0)`);
  await page.sleep(1000);
};

// ─── DOM Extraction (fallback) ──────────────────────────

const extractFromDOM = async () => {
  await page.setData('status', 'API capture failed, falling back to DOM extraction...');

  await page.goto('https://play.max.com/');
  await page.sleep(5000);
  await scrollToLoadContent();

  const contentData = await page.evaluate(`
    (() => {
      const rails = [];
      const allSections = document.querySelectorAll('section, [role="region"], [data-testid*="collection"]');
      for (const section of allSections) {
        const heading = section.querySelector('h2, h3, [role="heading"], [data-testid*="title"]');
        const railTitle = heading ? (heading.textContent || '').trim() : '';
        if (!railTitle) continue;
        const items = [];
        const allLinks = section.querySelectorAll('a[href]');
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          if (!href.startsWith('/') || href.includes('/settings') || href === '/') continue;
          let title = '';
          const img = link.querySelector('img');
          if (img) title = (img.getAttribute('alt') || '').trim();
          if (!title) title = (link.getAttribute('aria-label') || '').trim();
          if (!title) continue;
          let progress = 0;
          const bars = link.querySelectorAll('[class*="progress" i] div, [class*="Progress" i] div');
          for (const bar of bars) {
            const width = bar.style?.width;
            if (width && width.includes('%')) { progress = parseInt(width) || 0; break; }
          }
          items.push({ title, href, progress });
        }
        if (items.length > 0) rails.push({ title: railTitle, items });
      }
      return rails;
    })()
  `);

  const CW_KW = ['oglądaj dalej', 'continue watching', 'kontynuuj'];
  const FY_KW = ['dla ciebie', 'for you', 'because you watched'];
  const LIVE_KW = ['na żywo', 'live', 'sport'];

  const continueWatching = [];
  const recommendations = [];

  for (const rail of contentData) {
    const rl = rail.title.toLowerCase();
    if (LIVE_KW.some(kw => rl.includes(kw))) continue;
    const isCW = CW_KW.some(kw => rl.includes(kw));
    const isFY = FY_KW.some(kw => rl.includes(kw));
    for (const item of rail.items) {
      const title = cleanTitle(item.title);
      const href = item.href;
      const idMatch = href.match(/\/(?:video\/watch\/)?([0-9a-f-]{36})/);
      const entry = { title, url: 'https://play.max.com' + href, id: idMatch?.[1] || '' };
      if (isCW || item.progress > 0) continueWatching.push({ ...entry, progressPercent: item.progress });
      else if (isFY) recommendations.push(entry);
    }
  }

  return { continueWatching, recommendations, myList: [], source: 'dom' };
};

// ─── Main Export Flow ───────────────────────────────────

(async () => {
  const TOTAL_STEPS = 5;

  // ═══ STEP 1: Login + Token Capture ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Login' },
    message: 'Navigating to Max...',
  });

  await page.captureNetwork({ urlPattern: 'token', key: 'token' });
  await page.captureNetwork({ urlPattern: 'profiles', key: 'profiles' });

  await page.goto('https://play.max.com/');
  await page.sleep(4000);

  let loggedIn = await checkLoginStatus();

  if (!loggedIn) {
    await page.showBrowser('https://play.max.com/');
    await page.sleep(2000);

    await page.promptUser(
      'Please log in to Max. Click "Done" when you see the home page.',
      async () => await checkLoginStatus(),
      3000
    );
    await page.sleep(3000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // Wait a bit more for API calls to complete
  await page.sleep(4000);

  // Capture token and profiles
  const tokenResp = await page.getCapturedResponse('token');
  state.token = tokenResp?.data?.data?.attributes?.token;

  const profilesResp = await page.getCapturedResponse('profiles');
  const profiles = profilesResp?.data?.data || [];
  state.profileId = profiles[0]?.id;

  // If no token, fall back to DOM
  if (!state.token) {
    await page.goHeadless();
    const domData = await extractFromDOM();
    const result = {
      'max.profile': {},
      'max.continueWatching': { items: domData.continueWatching, total: domData.continueWatching.length },
      'max.recommendations': { items: domData.recommendations, total: domData.recommendations.length },
      'max.myList': { items: [], total: 0 },
      exportSummary: {
        count: domData.continueWatching.length + domData.recommendations.length,
        label: 'items',
        details: domData.continueWatching.length + ' in progress, ' + domData.recommendations.length + ' recommended (DOM fallback)',
      },
      timestamp: new Date().toISOString(),
      version: '1.0.0-playwright',
      platform: 'max',
    };
    state.isComplete = true;
    await page.setData('result', result);
    await page.setData('status', 'Complete (DOM fallback)');
    return { success: true, data: result };
  }

  // ═══ Close browser for API access ═══
  await page.setData('status', 'Token captured, switching to API mode...');
  await page.closeBrowser();

  // ═══ STEP 2: Fetch Profile ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Profile' },
    message: 'Fetching profile...',
  });

  const userResp = await apiFetch('https://default.beam-emea.prd.api.hbomax.com/users/me');
  const userAttrs = userResp?.data?.attributes || {};

  state.profile = {
    name: [userAttrs.firstName, userAttrs.lastName].filter(Boolean).join(' ') || undefined,
    email: userAttrs.email || undefined,
  };

  // Get profile names
  for (const p of profiles) {
    if (p.id === state.profileId && p.attributes?.name) {
      state.profile.profileName = p.attributes.name;
    }
  }

  await page.setData('status', 'Profile: ' + (state.profile.name || state.profile.email || 'unknown'));

  // ═══ STEP 3: Fetch Home Data (viewing history + continue watching) ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Watch history' },
    message: 'Fetching viewing data...',
  });

  const homeData = await apiFetch(
    'https://default.any-emea.prd.api.hbomax.com/cms/routes/home?include=default&decorators=viewingHistory,isFavorite,contentAction,badges&page[items.size]=50'
  );

  // Build a lookup of shows by ID
  const showMap = new Map();
  const viewedItems = [];
  const continueWatchingCollectionId = [];

  if (homeData?.included) {
    for (const item of homeData.included) {
      if (item.type === 'show') {
        showMap.set(item.id, {
          title: item.attributes?.name,
          isFavorite: item.attributes?.isFavorite,
        });
      }
      if (item.type === 'collection') {
        const name = item.attributes?.name || '';
        if (name.includes('continue-watching')) {
          continueWatchingCollectionId.push(item.id);
        }
      }
    }

    for (const item of homeData.included) {
      if (item.type !== 'video') continue;
      const vh = item.attributes?.viewingHistory;
      if (!vh?.viewed && !vh?.completed && !vh?.position) continue;

      const showId = item.relationships?.show?.data?.id;
      const show = showMap.get(showId);

      viewedItems.push({
        title: item.attributes?.name || item.attributes?.title,
        showTitle: show?.title,
        type: showId ? 'episode' : 'movie',
        id: item.id,
        showId,
        seasonNumber: item.attributes?.seasonNumber,
        episodeNumber: item.attributes?.numberInSeason || item.attributes?.numberInShow,
        duration: item.attributes?.duration,
        position: vh.position,
        completed: vh.completed,
        lastWatched: vh.lastReportedTimestamp,
        url: 'https://play.max.com/video/watch/' + item.id,
      });
    }
  }

  await page.setData('status', viewedItems.length + ' items with viewing history from home page');

  // ═══ STEP 4: Fetch additional collection pages for more history ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Collections' },
    message: 'Fetching personalized collections...',
  });

  // Fetch "because you watched" and "for you" collections
  const interestingCollections = [];
  if (homeData?.included) {
    for (const item of homeData.included) {
      if (item.type !== 'collection') continue;
      const name = item.attributes?.name || '';
      if (name.includes('for-you') || name.includes('because-you-watched') || name.includes('continue-watching')) {
        interestingCollections.push({ id: item.id, name });
      }
    }
  }

  const recommendations = [];
  for (const coll of interestingCollections) {
    if (coll.name.includes('continue-watching')) continue; // Already have these from viewedItems

    const collData = await apiFetch(
      'https://default.any-emea.prd.api.hbomax.com/cms/collections/' + coll.id +
      '?include=default&decorators=viewingHistory,isFavorite,contentAction,badges&page[items.size]=50'
    );

    if (collData?.included) {
      for (const item of collData.included) {
        if (item.type === 'show') {
          showMap.set(item.id, {
            title: item.attributes?.name,
            isFavorite: item.attributes?.isFavorite,
          });
        }
      }
      for (const item of collData.included) {
        if (item.type !== 'show' && item.type !== 'video') continue;
        const title = item.attributes?.name;
        if (!title) continue;
        if (recommendations.find(r => r.id === item.id)) continue;

        recommendations.push({
          title,
          type: item.type === 'show' ? 'series' : 'episode',
          id: item.id,
          url: 'https://play.max.com/' + (item.type === 'show' ? 'show' : 'video/watch') + '/' + item.id,
          source: coll.name.includes('because') ? 'because-you-watched' : 'for-you',
        });

        // Also check for viewing history on these items
        const vh = item.attributes?.viewingHistory;
        if (vh?.viewed || vh?.completed || vh?.position) {
          if (!viewedItems.find(v => v.id === item.id)) {
            const showId = item.relationships?.show?.data?.id;
            const show = showMap.get(showId);
            viewedItems.push({
              title: item.attributes?.name,
              showTitle: show?.title,
              type: showId ? 'episode' : (item.type === 'show' ? 'series' : 'movie'),
              id: item.id,
              showId,
              duration: item.attributes?.duration,
              position: vh.position,
              completed: vh.completed,
              lastWatched: vh.lastReportedTimestamp,
              url: 'https://play.max.com/video/watch/' + item.id,
            });
          }
        }
      }
    }

    await page.sleep(300);
  }

  await page.setData('status', viewedItems.length + ' viewed, ' + recommendations.length + ' recommended');

  // ═══ STEP 5: Fetch My List ═══
  await page.setProgress({
    phase: { step: 5, total: TOTAL_STEPS, label: 'My List' },
    message: 'Fetching My List...',
  });

  const myList = [];
  const myStuffData = await apiFetch(
    'https://default.any-emea.prd.api.hbomax.com/cms/routes/my-stuff?include=default&decorators=viewingHistory,isFavorite,contentAction,badges&page[items.size]=50'
  );

  if (myStuffData?.included) {
    // Build show map from my-stuff data too
    for (const item of myStuffData.included) {
      if (item.type === 'show') {
        showMap.set(item.id, {
          title: item.attributes?.name,
          isFavorite: item.attributes?.isFavorite,
        });
      }
    }

    // Find the "my-list" collection and its items
    const myListCollItems = new Set();
    for (const item of myStuffData.included) {
      if (item.type === 'collection' && (item.attributes?.name || '').includes('my-list')) {
        const itemRefs = item.relationships?.items?.data || [];
        for (const ref of itemRefs) myListCollItems.add(ref.id);
      }
    }

    // Extract shows that are in my-list collection or marked as favorite
    for (const item of myStuffData.included) {
      if (item.type !== 'show') continue;
      const title = item.attributes?.name;
      if (!title) continue;

      // Check if this show is in the my-list collection items
      // The collectionItem references the show, so check if any collectionItem for this show is in myListCollItems
      let inMyList = item.attributes?.isFavorite;
      if (!inMyList) {
        for (const ci of myStuffData.included) {
          if (ci.type === 'collectionItem' && myListCollItems.has(ci.id)) {
            const targetId = ci.relationships?.content?.data?.id;
            if (targetId === item.id) { inMyList = true; break; }
          }
        }
      }

      if (inMyList || myListCollItems.size === 0) {
        myList.push({
          title,
          type: 'series',
          id: item.id,
          url: 'https://play.max.com/show/' + item.id,
        });
      }
    }

    // Also check for viewed items in my-stuff
    for (const item of myStuffData.included) {
      if (item.type !== 'video') continue;
      const vh = item.attributes?.viewingHistory;
      if (!vh?.viewed && !vh?.completed && !vh?.position) continue;
      if (viewedItems.find(v => v.id === item.id)) continue;

      const showId = item.relationships?.show?.data?.id;
      const show = showMap.get(showId);
      viewedItems.push({
        title: item.attributes?.name,
        showTitle: show?.title,
        type: showId ? 'episode' : 'movie',
        id: item.id,
        showId,
        duration: item.attributes?.duration,
        position: vh.position,
        completed: vh.completed,
        lastWatched: vh.lastReportedTimestamp,
        url: 'https://play.max.com/video/watch/' + item.id,
      });
    }
  }

  // Sort viewed items by last watched date
  viewedItems.sort((a, b) => {
    if (!a.lastWatched) return 1;
    if (!b.lastWatched) return -1;
    return new Date(b.lastWatched) - new Date(a.lastWatched);
  });

  // ═══ Build Result ═══
  const result = {
    'max.profile': state.profile,
    'max.viewingHistory': {
      items: viewedItems,
      total: viewedItems.length,
    },
    'max.recommendations': {
      items: recommendations,
      total: recommendations.length,
    },
    'max.myList': {
      items: myList,
      total: myList.length,
    },
    exportSummary: {
      count: viewedItems.length + myList.length,
      label: 'items',
      details: [
        viewedItems.length + ' watched',
        recommendations.length + ' recommended',
        myList.length + ' in My List',
      ].join(', '),
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'max',
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status', 'Complete! ' + result.exportSummary.details + ' for ' + (state.profile.name || 'Max user'));

  return { success: true, data: result };
})();
