/**
 * YouTube Connector (Playwright)
 *
 * Uses Playwright for real browser control to extract YouTube user data.
 * Requires the playwright-runner sidecar.
 *
 * Collects:
 *   - youtube.profile      (email, channel URL, handle, joinedDate, stats)
 *   - youtube.subscriptions
 *   - youtube.playlists
 *   - youtube.playlistItems
 *   - youtube.likes        (Liked Videos playlist: list=LL)
 *   - youtube.watchLater   (Watch Later playlist:  list=WL)
 *   - youtube.history.1m   (last ~30 days, with watchedAtText from date headers)
 */

// ─── State ────────────────────────────────────────────────────
const state = {
  email: null,
  profile: null,
  subscriptions: [],
  playlists: [],
  playlistItems: {},
  likes: [],
  watchLater: [],
  history: [],
  isLoggedIn: false,
  isComplete: false
};

// ─── Constants ────────────────────────────────────────────────
const MAX_SUBS = 20;
const MAX_SCROLLS_PLAYLISTS = 5;
const MAX_SCROLLS_PLAYLIST_ITEMS = 20;
const MAX_SCROLLS_HISTORY = 4;
const MAX_HISTORY_ITEMS = 20;
const MAX_PLAYLISTS = 50;

// ─── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => page.sleep(ms);

// ─── Login Detection ─────────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        const avatarBtn = document.querySelector(
          'button#avatar-btn, ytd-topbar-menu-button-renderer button#avatar-btn'
        );
        return !!avatarBtn;
      })()
    `);
    return !!result;
  } catch (err) {
    return false;
  }
};

// ─── Email Extraction ────────────────────────────────────────

const extractEmail = async () => {
  try {
    // Open avatar dropdown
    await page.evaluate(`
      (() => {
        const avatarBtn = document.querySelector('button#avatar-btn');
        if (avatarBtn) avatarBtn.click();
      })()
    `);
    await sleep(1500);

    const scanForEmail = `
      (() => {
        const emailRegex = /[^\\s@<>"']+@[^\\s@<>"'.]+\\.[^\\s@<>"']+/;
        const containers = document.querySelectorAll(
          'ytd-multi-page-menu-renderer, tp-yt-paper-dialog, ' +
          'paper-dialog, [id*="account-name"], [id*="email"]'
        );
        for (const container of containers) {
          const leaves = container.querySelectorAll('*');
          for (const el of leaves) {
            if (el.children.length > 0) continue;
            const text = (el.textContent || '').trim();
            const match = text.match(emailRegex);
            if (match) return match[0];
          }
        }
        const allEls = document.querySelectorAll('p, span, div');
        for (const el of allEls) {
          if (el.children.length > 0) continue;
          const text = (el.textContent || '').trim();
          if (text.length < 5 || text.length > 120) continue;
          const match = text.match(emailRegex);
          if (match) return match[0];
        }
        return null;
      })()
    `;

    let emailText = await page.evaluate(scanForEmail);

    // Fallback: click "Switch account" if visible and search there
    if (!emailText) {
      const switched = await page.evaluate(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button, a, yt-button-shape, ytd-button-renderer'));
          for (const btn of btns) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'switch account' || text === 'add account') {
              btn.click();
              return true;
            }
          }
          return false;
        })()
      `);
      if (switched) {
        await sleep(1000);
        emailText = await page.evaluate(scanForEmail);
      }
    }

    // Close menu
    await page.evaluate(`(() => { document.body.click(); })()`);
    await sleep(500);

    return emailText || null;
  } catch (err) {
    return null;
  }
};

// ─── Channel URL (from avatar menu) ──────────────────────────

const getChannelUrlFromMenu = async () => {
  // Open avatar menu
  await page.evaluate(`
    (() => {
      const btn = document.querySelector('button#avatar-btn');
      if (btn) btn.click();
    })()
  `);
  await sleep(1500);

  const channelUrl = await page.evaluate(`
    (() => {
      // Primary: read handle directly from the active-account header element
      const handleEl = document.querySelector(
        'yt-formatted-string#channel-handle, ' +
        'ytd-active-account-header-renderer yt-formatted-string#channel-handle'
      );
      if (handleEl) {
        const handle = (handleEl.textContent || '').trim();
        if (handle.startsWith('@')) {
          return 'https://www.youtube.com/' + handle;
        }
      }

      // Fallback: look for a channel link in the dropdown, skip utility pages
      const links = document.querySelectorAll('a[href*="/@"], a[href*="/channel/"]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (
          (href.includes('/@') || href.includes('/channel/')) &&
          !href.includes('/edit') &&
          !href.includes('/create') &&
          !href.includes('/monetization')
        ) {
          return href.startsWith('http')
            ? href
            : 'https://www.youtube.com' + href;
        }
      }
      return null;
    })()
  `);

  // Close menu
  await page.evaluate(`(() => { document.body.click(); })()`);
  await sleep(300);

  return channelUrl;
};

// ─── Profile Extraction ───────────────────────────────────────

const extractChannelProfile = async (channelUrl) => {
  await page.goto(channelUrl);
  await sleep(2000);

  const baseData = await page.evaluate(`
    (() => {
      const url = window.location.href;
      const handleMatch = url.match(/\\/@([^/?#]+)/);
      const channelIdMatch = url.match(/\\/channel\\/([^/?#]+)/);

      const titleEl = document.querySelector(
        'ytd-channel-name yt-formatted-string, ' +
        '#channel-name yt-formatted-string, ' +
        'h1'
      );
      const avatarImg = document.querySelector(
        'yt-img-shadow#avatar img, #avatar img'
      );

      return {
        channelUrl: url,
        handle: handleMatch ? '@' + handleMatch[1] : null,
        channelId: channelIdMatch ? channelIdMatch[1] : null,
        channelTitle: titleEl ? titleEl.textContent.trim() : null,
        avatarUrl: avatarImg ? avatarImg.src : null
      };
    })()
  `);

  // Navigate to About tab for joined date, stats, description
  const aboutData = {
    joinedDate: null,
    description: null,
    subscriberCount: null,
    viewCount: null,
    videoCount: null,
    country: null
  };

  try {
    // Try clicking About tab
    const clicked = await page.evaluate(`
      (() => {
        const tabs = document.querySelectorAll(
          'tp-yt-paper-tab, ytd-tab-renderer, yt-tab-shape'
        );
        for (const tab of tabs) {
          const text = (tab.textContent || '').trim().toLowerCase();
          if (text === 'about') {
            tab.click();
            return true;
          }
        }
        return false;
      })()
    `);

    if (!clicked) {
      const aboutUrl = channelUrl.replace(/\/$/, '') + '/about';
      await page.goto(aboutUrl);
    }

    await sleep(2000);

    const aboutExtracted = await page.evaluate(`
      (() => {
        let joinedDate = null;
        let subscriberCount = null;
        let viewCount = null;
        let videoCount = null;
        let country = null;
        let description = null;

        // Collect all visible leaf text nodes
        const texts = [];
        document.querySelectorAll('yt-formatted-string, span, td, dd').forEach(el => {
          if (el.children.length === 0) {
            const t = (el.textContent || '').trim();
            if (t.length > 0) texts.push(t);
          }
        });

        for (const t of texts) {
          if (!joinedDate && /^joined/i.test(t)) {
            joinedDate = t.replace(/^joined\\s*/i, '').trim();
          }
          if (!subscriberCount && /subscriber/i.test(t)) {
            const raw = t.replace(/[^0-9.KMB]/gi, '');
            const num = parseFloat(raw) *
              (/K/i.test(raw) ? 1e3 : /M/i.test(raw) ? 1e6 : /B/i.test(raw) ? 1e9 : 1);
            if (!isNaN(num) && num > 0) subscriberCount = Math.round(num);
          }
          if (!viewCount && /view/i.test(t) && /\\d/.test(t)) {
            const raw = t.replace(/[^0-9.KMB]/gi, '');
            const num = parseFloat(raw) *
              (/K/i.test(raw) ? 1e3 : /M/i.test(raw) ? 1e6 : /B/i.test(raw) ? 1e9 : 1);
            if (!isNaN(num) && num > 0) viewCount = Math.round(num);
          }
          if (!videoCount && /video/i.test(t) && /\\d/.test(t)) {
            const num = parseInt(t.replace(/[^0-9]/g, ''));
            if (!isNaN(num) && num > 0) videoCount = num;
          }
        }

        // Description
        const descEl = document.querySelector(
          '#description-container yt-formatted-string, ' +
          '#description yt-formatted-string, ' +
          'ytd-channel-about-metadata-renderer #description yt-formatted-string'
        );
        if (descEl) description = descEl.textContent.trim() || null;

        // Country: look for location field in about metadata
        const locationEl = document.querySelector(
          '#details-container ytd-channel-about-metadata-renderer span,' +
          'ytd-channel-about-metadata-renderer [id*="country"],' +
          'ytd-channel-about-metadata-renderer yt-formatted-string'
        );
        if (locationEl) {
          const t = (locationEl.textContent || '').trim();
          if (
            t.length > 0 && t.length < 60 &&
            !/\\d/.test(t) &&
            !/subscriber|view|video|join/i.test(t)
          ) {
            country = t;
          }
        }

        return { joinedDate, subscriberCount, viewCount, videoCount, country, description };
      })()
    `);

    Object.assign(aboutData, aboutExtracted);
  } catch (err) {
    // Silently continue with null stats
  }

  return { ...baseData, ...aboutData };
};

// ─── Subscriptions ────────────────────────────────────────────

// Parse a human-readable subscriber string like "5.3m subscribers" into a number
const parseSubscriberCount = (text) => {
  if (!text) return null;
  const t = text.replace(/,/g, '');
  const match = t.match(/([\d.]+)\s*([KkMmBb]?)/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  return isNaN(num) ? null : Math.round(num * mult);
};

const scrapeSubscriptions = async () => {
  await page.goto('https://www.youtube.com/feed/channels');
  await sleep(2000);

  // Scroll just enough to ensure the first MAX_SUBS items are rendered
  for (let i = 0; i < 3; i++) {
    await page.evaluate(`window.scrollBy(0, window.innerHeight * 2)`);
    await sleep(800);
  }

  const raw = await page.evaluate(`
    (() => {
      const results = [];
      const channels = document.querySelectorAll('ytd-channel-renderer');

      for (const channel of channels) {
        if (results.length >= ${MAX_SUBS}) break;

        // Channel title
        const titleEl = channel.querySelector(
          'ytd-channel-name#channel-title yt-formatted-string#text, ' +
          'ytd-channel-name yt-formatted-string#text'
        );

        // Link element (for URL + handle/channelId)
        const linkEl = channel.querySelector(
          '#main-link, a[href*="/@"], a[href*="/channel/"]'
        );

        if (!titleEl || !linkEl) continue;

        const href = linkEl.getAttribute('href') || '';
        const channelUrl = href.startsWith('http')
          ? href
          : 'https://www.youtube.com' + href;

        const handleMatch = href.match(/\\/@([^/?#]+)/);
        const channelIdMatch = href.match(/\\/channel\\/([^/?#]+)/);

        // Handle text: #metadata yt-formatted-string#subscribers holds "@handle"
        const handleEl = channel.querySelector('#metadata yt-formatted-string#subscribers');
        const handle = handleEl
          ? (handleEl.textContent || '').trim() || null
          : (handleMatch ? '@' + handleMatch[1] : null);

        // Subscriber count: #metadata span#video-count holds "5.3m subscribers"
        const subEl = channel.querySelector('#metadata span#video-count');
        const subscriberCountText = subEl ? (subEl.textContent || '').trim() || null : null;

        // Description
        const descEl = channel.querySelector('yt-formatted-string#description');
        const description = descEl ? (descEl.textContent || '').trim() || null : null;

        // isVerified: presence of any badge-shape inside the channel name area
        const badgeEl = channel.querySelector(
          'ytd-channel-name badge-shape, ' +
          'ytd-channel-name .badge-shape, ' +
          'ytd-badge-supported-renderer badge-shape'
        );
        const isVerified = !!badgeEl;

        // isBellNotification: active bell button has aria-label containing "All"
        // or the notification button is not in the "none" state
        const bellBtn = channel.querySelector(
          'ytd-subscription-notification-toggle-button-renderer-next button, ' +
          '[aria-label*="All notifications"], ' +
          'yt-button-shape[aria-label*="notification"] button'
        );
        let isBellNotification = false;
        if (bellBtn) {
          const label = (bellBtn.getAttribute('aria-label') || '').toLowerCase();
          isBellNotification = label.includes('all') && !label.includes('none');
        }

        // Avatar
        const avatarImg = channel.querySelector('yt-img-shadow img, img#img');

        results.push({
          channelTitle: (titleEl.textContent || '').trim(),
          channelUrl,
          handle,
          channelId: channelIdMatch ? channelIdMatch[1] : null,
          avatarUrl: avatarImg ? avatarImg.src : null,
          subscriberCountText,
          description,
          isVerified,
          isBellNotification
        });
      }
      return results;
    })()
  `);

  // Attach parsed numeric subscriberCount in Node (avoids duplicating parse logic in evaluate)
  return (raw || []).map(item => ({
    ...item,
    subscriberCount: parseSubscriberCount(item.subscriberCountText)
  }));
};

// ─── Playlists (from Library) ─────────────────────────────────

const scrapePlaylists = async () => {
  await page.goto('https://www.youtube.com/feed/playlists');
  await sleep(2000);

  // Scroll to ensure at least MAX_PLAYLISTS cards are rendered
  for (let i = 0; i < MAX_SCROLLS_PLAYLISTS; i++) {
    await page.evaluate(`window.scrollBy(0, window.innerHeight * 2)`);
    await sleep(1000);
  }

  // Step 1: collect up to MAX_PLAYLISTS playlist URLs from the list page
  const links = await page.evaluate(`
    (() => {
      const seen = new Set();
      const results = [];

      const tryAdd = (href) => {
        if (!href) return;
        const m = href.match(/[?&]list=([^&#]+)/);
        if (!m) return;
        const playlistId = m[1];
        if (playlistId === 'LL' || playlistId === 'WL' || seen.has(playlistId)) return;
        seen.add(playlistId);
        const url = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
        results.push({ playlistId, url });
      };

      // Primary: grid / list renderers
      document.querySelectorAll(
        'ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-compact-playlist-renderer'
      ).forEach(pl => {
        const a = pl.querySelector('a[href*="list="]');
        if (a) tryAdd(a.getAttribute('href'));
      });

      // Fallback: any anchor with list= in href
      if (results.length === 0) {
        document.querySelectorAll('a[href*="playlist?list="]').forEach(a => {
          tryAdd(a.getAttribute('href'));
        });
      }

      return results;
    })()
  `);

  const playlistLinks = (links || []).slice(0, MAX_PLAYLISTS);

  // Step 2: visit each playlist page to read its header metadata
  const allPlaylists = [];
  for (const { playlistId, url } of playlistLinks) {
    try {
      await page.goto(url);
      await sleep(1500);

      const meta = await page.evaluate(`
        (() => {
          // Title — new page-header model
          const titleEl = document.querySelector(
            'yt-dynamic-text-view-model h1 span, ' +
            '.yt-page-header-view-model__page-header-title h1 span, ' +
            'h1#title, h1 yt-formatted-string'
          );
          const title = titleEl ? (titleEl.textContent || '').trim() || null : null;

          // Owner — avatar stack link, e.g. "by Ateet Tiwari"
          const ownerLinkEl = document.querySelector('yt-avatar-stack-view-model a');
          let owner = null;
          let ownerUrl = null;
          if (ownerLinkEl) {
            owner = (ownerLinkEl.textContent || '').trim().replace(/^by\\s+/i, '') || null;
            const h = ownerLinkEl.getAttribute('href') || '';
            ownerUrl = h ? (h.startsWith('http') ? h : 'https://www.youtube.com' + h) : null;
          }

          // Metadata text spans: "Playlist", "Public"/"Private"/"Unlisted",
          // "9 videos", "No views" / "2.3K views"
          const metaTexts = Array.from(
            document.querySelectorAll('.yt-content-metadata-view-model__metadata-text')
          ).map(el => (el.textContent || '').trim()).filter(Boolean);

          let privacy = null;
          let videoCount = null;
          let views = null;

          for (const t of metaTexts) {
            if (!privacy && /^(public|private|unlisted)$/i.test(t)) {
              privacy = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
            } else if (videoCount === null && /\\d/.test(t) && /video/i.test(t)) {
              const n = parseInt(t.replace(/[^0-9]/g, ''), 10);
              if (!isNaN(n)) videoCount = n;
            } else if (views === null && /view/i.test(t)) {
              if (/no views/i.test(t)) {
                views = 0;
              } else {
                const raw = t.replace(/[^0-9.KkMmBb]/g, '');
                const num = parseFloat(raw) *
                  (/[Kk]/.test(raw) ? 1e3 : /[Mm]/.test(raw) ? 1e6 : /[Bb]/.test(raw) ? 1e9 : 1);
                if (!isNaN(num)) views = Math.round(num);
              }
            }
          }

          return { title, owner, ownerUrl, privacy, videoCount, views };
        })()
      `);

      allPlaylists.push({
        playlistId,
        url,
        title: meta.title,
        owner: meta.owner,
        ownerUrl: meta.ownerUrl,
        privacy: meta.privacy,
        videoCount: meta.videoCount,
        views: meta.views
      });
    } catch (_) {
      allPlaylists.push({
        playlistId, url,
        title: null, owner: null, ownerUrl: null,
        privacy: null, videoCount: null, views: null
      });
    }
  }

  return allPlaylists;
};

// ─── Generic Playlist Page Scraper ────────────────────────────
// Used for: user playlists, Liked Videos (LL), Watch Later (WL)

const scrapePlaylistPage = async (playlistUrl, maxScrolls) => {
  await page.goto(playlistUrl);
  await sleep(2000);

  const seen = new Set();
  const allItems = [];
  let noChangeRounds = 0;

  for (let scroll = 0; scroll < maxScrolls; scroll++) {
    const batch = await page.evaluate(`
      (() => {
        const results = [];
        const videos = document.querySelectorAll(
          'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer'
        );
        for (const video of videos) {
          const titleEl = video.querySelector(
            '#video-title, a#video-title span, span#video-title, ' +
            'a#video-title yt-formatted-string'
          );
          const linkEl = video.querySelector(
            'a[href*="/watch"], a[href*="/shorts/"]'
          );
          const channelEl = video.querySelector(
            'ytd-channel-name a, #channel-name a, .ytd-channel-name a'
          );
          const thumbImg = video.querySelector('ytd-thumbnail img, img#img');
          const durationEl = video.querySelector(
            'ytd-thumbnail-overlay-time-status-renderer span, ' +
            'span.ytd-thumbnail-overlay-time-status-renderer'
          );

          if (!titleEl || !linkEl) continue;

          const href = linkEl.getAttribute('href') || '';
          const url = href.startsWith('http')
            ? href
            : 'https://www.youtube.com' + href;

          const videoIdMatch =
            url.match(/[?&]v=([^&#]+)/) || url.match(/\\/shorts\\/([^?&#]+)/);
          const videoId = videoIdMatch ? videoIdMatch[1] : null;

          const channelHref = channelEl ? channelEl.getAttribute('href') || '' : '';
          const channelUrl = channelHref
            ? channelHref.startsWith('http')
              ? channelHref
              : 'https://www.youtube.com' + channelHref
            : null;

          results.push({
            videoId,
            videoUrl: url,
            videoTitle: (titleEl.textContent || '').trim(),
            channelTitle: channelEl ? (channelEl.textContent || '').trim() : null,
            channelUrl,
            durationText: durationEl ? (durationEl.textContent || '').trim() : null,
            thumbnailUrl: thumbImg ? thumbImg.src : null
          });
        }
        return results;
      })()
    `);

    let newItemsCount = 0;
    for (const item of (batch || [])) {
      const key = item.videoId || item.videoUrl;
      if (key && !seen.has(key)) {
        seen.add(key);
        allItems.push(item);
        newItemsCount++;
      }
    }

    if (newItemsCount === 0) {
      noChangeRounds++;
      if (noChangeRounds >= 2) break;
    } else {
      noChangeRounds = 0;
    }

    await page.evaluate(`window.scrollBy(0, window.innerHeight * 2)`);
    await sleep(1500);
  }

  return allItems;
};

// ─── Watch History Scraper ────────────────────────────────────

const scrapeHistory = async () => {
  await page.goto('https://www.youtube.com/feed/history');
  await sleep(2000);

  // Scroll a few times to render enough items
  for (let i = 0; i < MAX_SCROLLS_HISTORY; i++) {
    await page.evaluate(`window.scrollBy(0, window.innerHeight * 2)`);
    await sleep(800);
  }

  const items = await page.evaluate(`
    (() => {
      const results = [];
      const now = new Date().toISOString();
      const seen = new Set();

      const sections = document.querySelectorAll('ytd-item-section-renderer');

      for (const section of sections) {
        if (results.length >= ${MAX_HISTORY_ITEMS}) break;

        // Section date header: "Today", "Yesterday", "Jan 23, 2026", etc.
        // New DOM: ytd-item-section-header-renderer > #header > #title (a plain div)
        const headerTitleEl = section.querySelector(
          'ytd-item-section-header-renderer #header #title, ' +
          '#header #title'
        );
        const watchedAtText = headerTitleEl
          ? (headerTitleEl.textContent || '').trim() || null
          : null;

        // History page now uses yt-lockup-view-model (new renderer)
        // Each lockup has class "content-id-{videoId}" for easy extraction
        const lockups = section.querySelectorAll('yt-lockup-view-model');

        for (const lockup of lockups) {
          if (results.length >= ${MAX_HISTORY_ITEMS}) break;

          // videoId from the content-id-* class
          const contentIdClass = Array.from(lockup.classList)
            .find(c => c.startsWith('content-id-'));
          const videoId = contentIdClass
            ? contentIdClass.replace('content-id-', '')
            : null;

          // Video URL — thumbnail anchor or title anchor
          const linkEl = lockup.querySelector(
            'a.yt-lockup-view-model__content-image, ' +
            'a.yt-lockup-metadata-view-model__title'
          );
          if (!linkEl) continue;

          const href = linkEl.getAttribute('href') || '';
          const videoUrl = href.startsWith('http')
            ? href
            : 'https://www.youtube.com' + href;

          // De-dup across scroll re-evaluations
          const key = videoId || videoUrl;
          if (seen.has(key)) continue;
          seen.add(key);

          // Title: prefer h3[title] attribute (full, untruncated)
          const titleEl = lockup.querySelector(
            'h3.yt-lockup-metadata-view-model__heading-reset'
          );
          const videoTitle = titleEl
            ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim() || null
            : null;

          // Channel name: from avatar aria-label ("Go to channel X")
          const avatarEl = lockup.querySelector('[aria-label^="Go to channel"]');
          const channelTitle = avatarEl
            ? (avatarEl.getAttribute('aria-label') || '')
                .replace(/^Go to channel\\s+/i, '').trim() || null
            : null;

          // Views: last .metadata-text span inside the first padded row
          const firstRow = lockup.querySelector(
            '.yt-content-metadata-view-model__metadata-row--metadata-row-padding'
          );
          let views = null;
          if (firstRow) {
            const metaSpans = firstRow.querySelectorAll(
              '.yt-content-metadata-view-model__metadata-text'
            );
            const lastSpan = metaSpans[metaSpans.length - 1];
            if (lastSpan) views = (lastSpan.textContent || '').trim() || null;
          }

          // Description: multi-line text snippet
          const descEl = lockup.querySelector(
            '.yt-content-metadata-view-model__metadata-text-max-lines-2'
          );
          const description = descEl
            ? (descEl.textContent || '').trim() || null
            : null;

          if (!videoTitle && !videoId) continue;

          results.push({
            watchedAtText,
            videoId,
            videoUrl,
            videoTitle,
            channelTitle,
            views,
            description,
            extractedAt: now
          });
        }
      }

      return results;
    })()
  `);

  return (items || []).slice(0, MAX_HISTORY_ITEMS);
};

// ─── Main Connector Flow ──────────────────────────────────────

(async () => {
  try {
    const TOTAL_PHASES = 8;

    // ═══ Login Phase ═══
    await page.setData('status', 'Checking login status...');
    await page.goto('https://www.youtube.com/');
    await sleep(2000);

    state.isLoggedIn = await checkLoginStatus();

    if (!state.isLoggedIn) {
      await page.showBrowser('https://www.youtube.com/');
      await sleep(1000);

      await page.promptUser(
        'Please log in to YouTube (Google account). Click "Done" once you are logged in.',
        async () => checkLoginStatus(),
        2000
      );

      state.isLoggedIn = await checkLoginStatus();
      await page.setData('status', 'Login completed');
      await page.goHeadless();
    } else {
      await page.setData('status', 'Session restored from previous login');
    }

    if (!state.isLoggedIn) {
      await page.setData('error', 'Login failed or timed out');
      return { error: 'Login failed or timed out' };
    }

    // ═══ Phase 1: Extract Email ═══
    await page.setProgress({
      phase: { step: 1, total: TOTAL_PHASES, label: 'Extracting account info' },
      message: 'Fetching account email...',
    });

    state.email = await extractEmail();
    await page.setData('status', `Logged in as ${state.email || 'unknown'}`);

    await page.setProgress({
      phase: { step: 1, total: TOTAL_PHASES, label: 'Extracting account info' },
      message: state.email ? `Email: ${state.email}` : 'Email not found',
    });

    // ═══ Phase 2: Profile ═══
    await page.setProgress({
      phase: { step: 2, total: TOTAL_PHASES, label: 'Fetching channel profile' },
      message: 'Navigating to your channel...',
    });

    try {
      const channelUrl = await getChannelUrlFromMenu();

      if (channelUrl) {
        const channelData = await extractChannelProfile(channelUrl);
        state.profile = {
          email: state.email,
          channelUrl: channelData.channelUrl,
          handle: channelData.handle,
          channelTitle: channelData.channelTitle,
          channelId: channelData.channelId,
          avatarUrl: channelData.avatarUrl,
          joinedDate: channelData.joinedDate,
          description: channelData.description,
          subscriberCount: channelData.subscriberCount,
          viewCount: channelData.viewCount,
          videoCount: channelData.videoCount,
          country: channelData.country
        };
      } else {
        state.profile = { email: state.email };
      }
    } catch (err) {
      state.profile = { email: state.email };
    }

    await page.setData('profile', state.profile);
    await page.setProgress({
      phase: { step: 2, total: TOTAL_PHASES, label: 'Fetching channel profile' },
      message: `Profile: ${state.profile.handle || state.profile.channelTitle || 'collected'}`,
    });

    // ═══ Phase 3: Subscriptions ═══
    await page.setProgress({
      phase: { step: 3, total: TOTAL_PHASES, label: 'Fetching subscriptions' },
      message: 'Loading subscriptions...',
    });

    try {
      state.subscriptions = await scrapeSubscriptions();
    } catch (err) {
      state.subscriptions = [];
    }

    await page.setData('subscriptions', { count: state.subscriptions.length });
    await page.setProgress({
      phase: { step: 3, total: TOTAL_PHASES, label: 'Fetching subscriptions' },
      message: `Found ${state.subscriptions.length} subscriptions`,
      count: state.subscriptions.length,
    });

    // ═══ Phase 4: Playlists ═══
    await page.setProgress({
      phase: { step: 4, total: TOTAL_PHASES, label: 'Fetching playlists' },
      message: 'Loading playlists from library...',
    });

    try {
      state.playlists = await scrapePlaylists();
    } catch (err) {
      state.playlists = [];
    }

    await page.setData('playlists', { count: state.playlists.length });
    await page.setProgress({
      phase: { step: 4, total: TOTAL_PHASES, label: 'Fetching playlists' },
      message: `Found ${state.playlists.length} playlists`,
      count: state.playlists.length,
    });

    // ═══ Phase 5: Playlist Items ═══
    await page.setProgress({
      phase: { step: 5, total: TOTAL_PHASES, label: 'Fetching playlist items' },
      message: 'Collecting videos from playlists...',
    });

    const playlistsToProcess = state.playlists.slice(0, MAX_PLAYLISTS);
    for (let i = 0; i < playlistsToProcess.length; i++) {
      const playlist = playlistsToProcess[i];
      if (!playlist.url || !playlist.playlistId) continue;

      await page.setProgress({
        phase: { step: 5, total: TOTAL_PHASES, label: 'Fetching playlist items' },
        message: `Playlist ${i + 1}/${playlistsToProcess.length}: "${playlist.title}"`,
        count: i + 1,
      });

      try {
        const items = await scrapePlaylistPage(playlist.url, MAX_SCROLLS_PLAYLIST_ITEMS);
        state.playlistItems[playlist.playlistId] = {
          playlistId: playlist.playlistId,
          playlistTitle: playlist.title,
          playlistUrl: playlist.url,
          items
        };
      } catch (err) {
        // Skip this playlist on error
      }
    }

    // ═══ Phase 6: Liked Videos (playlist LL) ═══
    await page.setProgress({
      phase: { step: 6, total: TOTAL_PHASES, label: 'Fetching liked videos' },
      message: 'Loading liked videos...',
    });

    try {
      state.likes = await scrapePlaylistPage(
        'https://www.youtube.com/playlist?list=LL',
        MAX_SCROLLS_PLAYLIST_ITEMS
      );
    } catch (err) {
      state.likes = [];
      await page.setData('warning', 'Could not access liked videos (may be private)');
    }

    await page.setData('likes', { count: state.likes.length });
    await page.setProgress({
      phase: { step: 6, total: TOTAL_PHASES, label: 'Fetching liked videos' },
      message: `Found ${state.likes.length} liked videos`,
      count: state.likes.length,
    });

    // ═══ Phase 7: Watch Later (playlist WL) ═══
    await page.setProgress({
      phase: { step: 7, total: TOTAL_PHASES, label: 'Fetching watch later' },
      message: 'Loading watch later list...',
    });

    try {
      state.watchLater = await scrapePlaylistPage(
        'https://www.youtube.com/playlist?list=WL',
        MAX_SCROLLS_PLAYLIST_ITEMS
      );
    } catch (err) {
      state.watchLater = [];
      await page.setData('warning', 'Could not access watch later (may be empty or private)');
    }

    await page.setData('watchLater', { count: state.watchLater.length });
    await page.setProgress({
      phase: { step: 7, total: TOTAL_PHASES, label: 'Fetching watch later' },
      message: `Found ${state.watchLater.length} watch later items`,
      count: state.watchLater.length,
    });

    // ═══ Phase 8: Watch History (last ~30 days) ═══
    await page.setProgress({
      phase: { step: 8, total: TOTAL_PHASES, label: 'Fetching watch history' },
      message: 'Loading watch history (last 30 days)...',
    });

    try {
      state.history = await scrapeHistory();
    } catch (err) {
      state.history = [];
      await page.setData('warning', 'Could not access watch history');
    }

    await page.setData('history', { count: state.history.length });
    await page.setProgress({
      phase: { step: 8, total: TOTAL_PHASES, label: 'Fetching watch history' },
      message: `Found ${state.history.length} history items`,
      count: state.history.length,
    });

    // ═══ Transform to Final Schema Output ═══
    const transformDataForSchema = () => {
      const playlistsOutput = Object.values(state.playlistItems);
      const totalPlaylistItems = playlistsOutput.reduce(
        (acc, p) => acc + (p.items?.length || 0), 0
      );

      return {
        'youtube.profile': state.profile || {},
        'youtube.subscriptions': {
          subscriptions: state.subscriptions
        },
        'youtube.playlists': {
          playlists: state.playlists
        },
        'youtube.playlistItems': {
          playlists: playlistsOutput
        },
        'youtube.likes': {
          likedVideos: state.likes
        },
        'youtube.watchLater': {
          watchLater: state.watchLater
        },
        'youtube.history': {
          timeWindow: 'last 20',
          history: state.history
        },
        exportSummary: {
          profile: state.profile ? 'collected' : 'not_available',
          subscriptions: state.subscriptions.length,
          playlists: state.playlists.length,
          playlistItems: totalPlaylistItems,
          likes: state.likes.length,
          watchLater: state.watchLater.length,
          history: state.history.length,
          label: 'YouTube data export'
        },
        timestamp: new Date().toISOString(),
        version: '1.0.0-playwright',
        platform: 'youtube'
      };
    };

    state.isComplete = true;
    const result = transformDataForSchema();

    await page.setData('result', result);
    await page.setData(
      'status',
      `Complete! ${state.subscriptions.length} subscriptions, ` +
      `${state.playlists.length} playlists, ` +
      `${state.likes.length} likes, ` +
      `${state.watchLater.length} watch later, ` +
      `${state.history.length} history items`
    );

    return { success: true, data: result };

  } catch (error) {
    await page.setData('error', error.message);
    return { success: false, error: error.message };
  }
})();
