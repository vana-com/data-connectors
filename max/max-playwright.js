/**
 * Max Connector (Playwright) — DOM Extraction
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session
 *   - If not logged in, shows browser for user to log in
 *
 * Phase 2 (Headless — invisible to user):
 *   - Extracts profile from settings page
 *   - Scrolls home page to load lazy-loaded content rails
 *   - Categorizes content: Continue Watching, recommendations, My List
 *   - Reports structured progress to the UI
 *
 * Note: Max's API requires a deviceInfo bootstrap sequence that cannot be
 * replicated outside the app, so this connector uses DOM extraction.
 */

const state = {
  profile: null,
  isComplete: false,
};

// ─── Helpers ────────────────────────────────────────────

const stripBidi = (s) => s.replace(/[\u2066\u2067\u2068\u2069\u202A-\u202E\u200E\u200F]/g, '').trim();

const cleanTitle = (raw) => {
  let t = stripBidi(raw);
  // Remove trailing metadata like ". 3 z 20. Nowe odcinki"
  t = t.replace(/\.\s*\d+\s+z\s+\d+\.?.*$/, '');
  // Remove trailing ". X of Y" (English)
  t = t.replace(/\.\s*\d+\s+of\s+\d+\.?.*$/, '');
  // Remove "Oglądaj " prefix (Polish "Watch ")
  t = t.replace(/^Oglądaj\s+/, '');
  // Remove season/episode suffix like ". Sezon 3, odcinek 1: Episode Title"
  const seasonMatch = t.match(/^(.+?)\.\s*Sezon\s+\d+,\s*odcinek\s+\d+:\s*(.+)$/);
  if (seasonMatch) {
    t = seasonMatch[1] + ' — ' + seasonMatch[2];
  }
  // Remove "Pozostało X minut/godzin" (time remaining)
  t = t.replace(/\.\s*Pozostało\s+.+$/, '');
  // Remove rating info like ". Klasyfikacja: 18+, Seks, Wulgaryzmy"
  t = t.replace(/\.\s*Klasyfikacja:.+$/, '');
  // Remove "Premiera w YYYY"
  t = t.replace(/\.\s*Premiera w\s+\d{4}$/, '');
  return t.trim();
};

const extractId = (href) => {
  // /video/watch/uuid1/uuid2 — use uuid1 as the content ID
  const watchMatch = href.match(/\/video\/watch\/([0-9a-f-]{36})/);
  if (watchMatch) return watchMatch[1];
  // /show/uuid, /movie/uuid, /series/uuid
  const contentMatch = href.match(/\/(movie|show|series|episode|video)\/([0-9a-f-]{36})/);
  if (contentMatch) return contentMatch[2];
  // /sport/uuid
  const sportMatch = href.match(/\/sport\/([0-9a-f-]{36})/);
  if (sportMatch) return sportMatch[1];
  return '';
};

const detectType = (href) => {
  if (href.includes('/movie/')) return 'movie';
  if (href.includes('/show/') || href.includes('/series/')) return 'series';
  if (href.includes('/episode/') || href.includes('/video/')) return 'episode';
  if (href.includes('/sport/')) return 'sport';
  return 'unknown';
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

// ─── Scroll to load lazy content ────────────────────────

const scrollToLoadContent = async () => {
  for (let i = 0; i < 10; i++) {
    await page.evaluate(`window.scrollBy(0, 800)`);
    await page.sleep(1500);
  }
  await page.evaluate(`window.scrollTo(0, 0)`);
  await page.sleep(1000);
};

// ─── Rail keywords for categorization ───────────────────

const CONTINUE_WATCHING = ['oglądaj dalej', 'continue watching', 'keep watching', 'kontynuuj'];
const FOR_YOU = ['dla ciebie', 'for you', 'because you watched', 'bo obejrzałeś', 'ponieważ'];
const MY_LIST = ['moja lista', 'my list', 'moja kolekcja', 'favorites', 'ulubione'];
const LIVE_SPORTS = ['na żywo', 'live', 'sport'];

const railMatches = (title, keywords) => {
  const lower = title.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
};

// ─── Main Export Flow ───────────────────────────────────

(async () => {
  const TOTAL_STEPS = 4;

  // ═══ STEP 1: Login ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Login' },
    message: 'Navigating to Max...',
  });

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
    await page.sleep(2000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  await page.goHeadless();

  // ═══ STEP 2: Extract profile ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Profile' },
    message: 'Extracting profile...',
  });

  await page.goto('https://play.max.com/settings');
  await page.sleep(4000);

  const profile = await page.evaluate(`
    (() => {
      const result = {};
      const text = document.body.innerText || '';

      // Extract email
      const emailMatch = text.match(/[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}/);
      if (emailMatch) result.email = emailMatch[0];

      // Subscription plan
      if (text.includes('Premium')) result.plan = 'Premium';
      else if (text.includes('Standard')) result.plan = 'Standard';
      else if (text.includes('Basic')) result.plan = 'Basic';

      // Profile name: look for labeled fields in settings
      // Common patterns: "Imię: John" or "Name" label followed by value
      const skipWords = [
        'ustawienia', 'settings', 'strona główna', 'home',
        'max', 'premium', 'standard', 'basic', 'konto', 'account',
        'profil', 'profile', 'wyloguj', 'sign out', 'pomoc', 'help',
        'subskrypcja', 'subscription', 'zmień', 'change', 'edytuj', 'edit'
      ];

      // Strategy 1: Look for setting rows with label + value pairs
      const allElements = document.querySelectorAll('div, span, p, dd, td');
      for (const el of allElements) {
        const prev = el.previousElementSibling;
        if (!prev) continue;
        const label = (prev.textContent || '').toLowerCase().trim();
        if (label.includes('imi') || label.includes('name') || label.includes('nazw') || label.includes('użytkownik')) {
          const val = (el.textContent || '').trim();
          if (val && val.length > 1 && val.length < 50) {
            const valLower = val.toLowerCase();
            if (!skipWords.some(w => valLower === w)) {
              result.name = val;
              break;
            }
          }
        }
      }

      // Strategy 2: aria-label on profile/avatar elements
      if (!result.name) {
        const profileEls = document.querySelectorAll('[data-testid*="profile"], [data-testid*="avatar"], [aria-label*="profil" i]');
        for (const el of profileEls) {
          const label = (el.getAttribute('aria-label') || '').trim();
          if (label && label.length > 1 && label.length < 40) {
            const labelLower = label.toLowerCase();
            if (!skipWords.some(w => labelLower === w || labelLower.includes(w))) {
              result.name = label;
              break;
            }
          }
        }
      }

      return result;
    })()
  `);

  state.profile = profile;
  await page.setData('status', 'Profile: ' + JSON.stringify(profile));

  // ═══ STEP 3: Extract content from home page ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Home content' },
    message: 'Loading home page content...',
    count: 0,
  });

  await page.goto('https://play.max.com/');
  await page.sleep(5000);

  await page.setData('status', 'Scrolling to load all content rails...');
  await scrollToLoadContent();

  // Extract all content organized by rail
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
          if (!href.startsWith('/')) continue;
          if (href.includes('/settings') || href.includes('/account') || href === '/') continue;

          let title = '';
          const img = link.querySelector('img');
          if (img) title = (img.getAttribute('alt') || '').trim();
          if (!title) title = (link.getAttribute('aria-label') || '').trim();
          if (!title) {
            const titleEl = link.querySelector('h3, h4, span[class*="title" i], [data-testid*="title"]');
            if (titleEl) title = (titleEl.textContent || '').trim();
          }
          if (!title) continue;

          // Progress indicator
          let progress = 0;
          const progressBar = link.querySelector('[role="progressbar"], [data-testid*="progress"]');
          if (progressBar) {
            const val = progressBar.getAttribute('aria-valuenow') || progressBar.getAttribute('value') || '';
            progress = parseInt(val) || 0;
          }
          if (!progress) {
            const bars = link.querySelectorAll('[class*="progress" i] div, [class*="Progress" i] div');
            for (const bar of bars) {
              const width = bar.style?.width;
              if (width && width.includes('%')) {
                progress = parseInt(width) || 0;
                break;
              }
            }
          }

          items.push({ title, href, hasProgress: !!progressBar || progress > 0, progress });
        }

        if (items.length > 0) {
          rails.push({ title: railTitle, items });
        }
      }

      return rails;
    })()
  `);

  await page.setData('status', 'Found ' + contentData.length + ' rails');

  // Categorize content
  const continueWatching = [];
  const recommendations = [];

  for (const rail of contentData) {
    if (railMatches(rail.title, LIVE_SPORTS)) continue; // Skip live sports

    const isContinueWatching = railMatches(rail.title, CONTINUE_WATCHING);
    const isForYou = railMatches(rail.title, FOR_YOU);

    for (const item of rail.items) {
      const title = cleanTitle(item.title);
      const id = extractId(item.href);
      const type = detectType(item.href);
      const entry = {
        title,
        type,
        id,
        url: 'https://play.max.com' + item.href,
      };

      if (isContinueWatching || item.hasProgress) {
        continueWatching.push({
          ...entry,
          progressPercent: item.progress,
          source: 'continue-watching',
        });
      } else if (isForYou) {
        if (!recommendations.find(r => r.id === id)) {
          recommendations.push({
            ...entry,
            source: 'recommended',
          });
        }
      }
    }
  }

  await page.setData('status', continueWatching.length + ' in progress, ' + recommendations.length + ' recommended');

  // ═══ STEP 4: Extract My List ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'My List' },
    message: 'Fetching My List...',
  });

  let myList = [];

  // Try dedicated My List pages
  const myListUrls = [
    'https://play.max.com/my-stuff',
    'https://play.max.com/favorites',
    'https://play.max.com/my-list',
    'https://play.max.com/watchlist',
  ];

  for (const url of myListUrls) {
    await page.goto(url);
    await page.sleep(3000);

    const currentUrl = await page.evaluate('window.location.href');
    if (currentUrl.includes('error') || currentUrl.includes('404')) continue;

    const listItems = await page.evaluate(`
      (() => {
        const items = [];
        const links = document.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (!href.startsWith('/')) continue;
          if (!href.includes('/movie/') && !href.includes('/show/') && !href.includes('/series/')) continue;

          let title = '';
          const img = link.querySelector('img');
          if (img) title = (img.getAttribute('alt') || '').trim();
          if (!title) title = (link.getAttribute('aria-label') || '').trim();
          if (!title) continue;

          items.push({ title, href });
        }
        return items;
      })()
    `);

    if (listItems.length > 0) {
      myList = listItems.map(item => ({
        title: cleanTitle(item.title),
        type: detectType(item.href),
        id: extractId(item.href),
        url: 'https://play.max.com' + item.href,
      }));
      await page.setData('status', 'Found My List: ' + myList.length + ' items');
      break;
    }
  }

  // Fallback: check home page for My List rail
  if (myList.length === 0) {
    for (const rail of contentData) {
      if (railMatches(rail.title, MY_LIST)) {
        myList = rail.items.map(item => ({
          title: cleanTitle(item.title),
          type: detectType(item.href),
          id: extractId(item.href),
          url: 'https://play.max.com' + item.href,
        }));
        await page.setData('status', 'Found My List from rail: ' + myList.length + ' items');
        break;
      }
    }
  }

  // ═══ Build Result ═══
  const allWatchItems = [...continueWatching, ...recommendations];

  const result = {
    'max.profile': state.profile,
    'max.continueWatching': {
      items: continueWatching,
      total: continueWatching.length,
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
      count: allWatchItems.length + myList.length,
      label: 'items',
      details: [
        continueWatching.length + ' in progress',
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
  await page.setData('status', 'Complete! ' + result.exportSummary.details);

  return { success: true, data: result };
})();
