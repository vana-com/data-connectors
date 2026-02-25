/**
 * X Connector (Playwright)
 *
 * Exports:
 * - Profile
 * - Recent posts from the profile timeline
 */

const state = {
  username: null,
  profile: null,
  posts: [],
  isComplete: false,
};

const X_USERNAME_REGEX = /^[A-Za-z0-9_]{1,15}$/;

const isValidXUsername = (value) =>
  typeof value === 'string' && X_USERNAME_REGEX.test(value);

const TO_INT_HELPER = `
const toInt = (raw) => {
  const text = String(raw || '').toLowerCase().replace(/,/g, '').replace(/\s+/g, '').trim();
  if (!text) return 0;

  const match = text.match(/^([0-9]+(?:[.][0-9]+)?)([kmb])?$/);
  if (match) {
    let value = parseFloat(match[1]);
    if (Number.isNaN(value)) return 0;
    if (match[2] === 'k') value *= 1_000;
    if (match[2] === 'm') value *= 1_000_000;
    if (match[2] === 'b') value *= 1_000_000_000;
    return Math.round(value);
  }

  const digits = text.replace(/[^0-9]/g, '');
  if (!digits) return 0;
  return parseInt(digits, 10);
};
`;

const isLoggedIn = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasProfileTab = !!document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
        const hasAccountSwitcher = !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        const hasHome = !!document.querySelector('a[href="/home"]');
        const hasLoginInputs = !!document.querySelector('input[autocomplete="username"], input[name="text"]');
        return (hasProfileTab || hasAccountSwitcher || hasHome) && !hasLoginInputs;
      })()
    `);
  } catch {
    return false;
  }
};

const readLoggedInUsername = async () => {
  try {
    const username = await page.evaluate(`
      (() => {
        const parseUsername = (href) => {
          if (!href) return null;
          try {
            const url = new URL(href, window.location.origin);
            const first = (url.pathname || '/').split('/').filter(Boolean)[0] || '';
            if (!first) return null;
            const blocked = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search']);
            if (blocked.has(first.toLowerCase())) return null;
            return first.replace(/^@/, '');
          } catch {
            return null;
          }
        };

        const metaUsername = document.querySelector('meta[name="session-user-screen_name"]')?.getAttribute('content') || '';
        if (metaUsername) return metaUsername;

        const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"][href]');
        const fromProfileTab = parseUsername(profileLink?.getAttribute('href'));
        if (fromProfileTab) return fromProfileTab;

        const statusLink = document.querySelector('a[href*="/status/"]');
        const fromStatus = parseUsername(statusLink?.getAttribute('href'));
        if (fromStatus) return fromStatus;

        return null;
      })()
    `);
    return isValidXUsername(username) ? username : null;
  } catch {
    return null;
  }
};

const extractProfile = async (username) => {
  if (!isValidXUsername(username)) return null;

  await page.goto(`https://x.com/${username}`);
  await page.sleep(3000);

  try {
    return await page.evaluate(`
      (() => {
        ${TO_INT_HELPER}

        const primary = document.querySelector('main [data-testid="primaryColumn"]') || document;
        const userNameNode = primary.querySelector('[data-testid="UserName"]');
        const userNameSpans = Array.from(userNameNode?.querySelectorAll('span') || []);
        const usernameText = userNameSpans.find((span) => (span.textContent || '').trim().startsWith('@'))?.textContent?.trim() || '';
        const displayName = userNameSpans.find((span) => {
          const text = (span.textContent || '').trim();
          return text && !text.startsWith('@');
        })?.textContent?.trim() || '';

        const statLinks = Array.from(primary.querySelectorAll('a[href]'));
        const findStatText = (needle) => {
          const link = statLinks.find((a) => (a.getAttribute('href') || '').includes(needle));
          return (link?.textContent || '').trim();
        };

        const bio = (primary.querySelector('[data-testid="UserDescription"]')?.textContent || '').trim();
        const location = (primary.querySelector('[data-testid="UserLocation"]')?.textContent || '').trim();
        const joinedDate = (primary.querySelector('[data-testid="UserJoinDate"]')?.textContent || '').trim();
        const website = primary.querySelector('[data-testid="UserUrl"] a[href]')?.getAttribute('href') || '';
        const avatarUrl = primary.querySelector('img[src*="profile_images"]')?.getAttribute('src') || '';
        const isVerified = !!primary.querySelector('[data-testid="icon-verified"]');

        return {
          username: usernameText.replace(/^@/, '') || ${JSON.stringify(username)},
          displayName,
          bio,
          location,
          website,
          joinedDate,
          avatarUrl,
          following: toInt(findStatText('/following')),
          followers: toInt(findStatText('/followers')),
          likes: toInt(findStatText('/likes')),
          isVerified,
          profileUrl: window.location.href.split('?')[0]
        };
      })()
    `);
  } catch {
    return null;
  }
};

const extractVisiblePosts = async () => {
  try {
    const result = await page.evaluate(`
      (() => {
        ${TO_INT_HELPER}

        const parseStatusLink = (href) => {
          if (!href) return null;
          try {
            const url = new URL(href, window.location.origin);
            const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
            if (!match) return null;
            return { username: match[1], id: match[2] };
          } catch {
            return null;
          }
        };

        const metricValue = (article, testId) => {
          const node = article.querySelector('[data-testid="' + testId + '"]');
          return toInt((node?.textContent || '').trim());
        };

        const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
        const posts = [];

        for (const article of articles) {
          const statusAnchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
          let parsed = null;
          let statusUrl = null;
          for (const anchor of statusAnchors) {
            parsed = parseStatusLink(anchor.getAttribute('href') || '');
            if (parsed) {
              statusUrl = 'https://x.com/' + parsed.username + '/status/' + parsed.id;
              break;
            }
          }
          if (!parsed || !statusUrl) continue;

          const textNode = article.querySelector('[data-testid="tweetText"]');
          const text = (textNode?.textContent || '').trim();
          const createdAt = article.querySelector('time')?.getAttribute('datetime') || null;
          const lang = textNode?.getAttribute('lang') || '';
          const socialContext = (article.querySelector('[data-testid="socialContext"]')?.textContent || '').trim();
          const isPinned = /pinned/i.test(socialContext) || /pinned/i.test(article.textContent || '');
          const isReply = /replying to/i.test(article.textContent || '');

          const mediaUrls = Array.from(article.querySelectorAll('img[src]'))
            .map((img) => img.getAttribute('src') || '')
            .filter((src) => src.includes('pbs.twimg.com/media/'))
            .filter((src, idx, arr) => src && arr.indexOf(src) === idx);

          posts.push({
            id: parsed.id,
            url: statusUrl,
            authorUsername: parsed.username,
            text,
            createdAt,
            replyCount: metricValue(article, 'reply'),
            repostCount: metricValue(article, 'retweet'),
            likeCount: metricValue(article, 'like'),
            bookmarkCount: metricValue(article, 'bookmark'),
            viewCount: metricValue(article, 'viewCount'),
            isPinned,
            isReply,
            lang,
            mediaUrls,
          });
        }

        return posts;
      })()
    `);

    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
};

const extractPosts = async (username) => {
  if (!isValidXUsername(username)) return [];

  await page.goto(`https://x.com/${username}`);
  await page.sleep(3000);

  const all = [];
  const seen = new Set();
  const maxPosts = 120;
  const maxScrolls = 12;
  let stagnantScrolls = 0;

  for (let scrollIndex = 0; scrollIndex < maxScrolls; scrollIndex++) {
    const visible = await extractVisiblePosts();
    let added = 0;

    for (const post of visible) {
      if (!post?.id || seen.has(post.id)) continue;
      seen.add(post.id);
      all.push(post);
      added += 1;
      if (all.length >= maxPosts) break;
    }

    await page.setProgress({
      phase: { step: 2, total: 2, label: 'Posts' },
      message: `Captured ${all.length} post${all.length === 1 ? '' : 's'}${all.length < maxPosts ? '...' : ''}`,
      count: all.length,
    });

    if (all.length >= maxPosts) break;

    if (added === 0) stagnantScrolls += 1;
    else stagnantScrolls = 0;

    if (stagnantScrolls >= 3) break;

    await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * 0.9))`);
    await page.sleep(1800);
  }

  return all;
};

(async () => {
  await page.setData('status', 'Checking X login status...');
  await page.goto('https://x.com/home');
  await page.sleep(2000);

  let loggedIn = await isLoggedIn();
  if (!loggedIn) {
    await page.showBrowser('https://x.com/i/flow/login');
    await page.sleep(2500);
    await page.setData('status', 'Please log in to X...');

    await page.promptUser(
      'Please log in to X. Click "Done" when your home timeline loads.',
      async () => await isLoggedIn(),
      2000
    );

    loggedIn = await isLoggedIn();
  }

  if (!loggedIn) {
    await page.setData('error', 'X login could not be confirmed.');
    return;
  }

  await page.setData('status', 'Login confirmed. Collecting data in background...');
  await page.goHeadless();

  await page.setProgress({
    phase: { step: 1, total: 2, label: 'Profile' },
    message: 'Resolving account...',
  });

  const username = await readLoggedInUsername();
  if (!isValidXUsername(username)) {
    await page.setData('error', 'Could not resolve a valid X username after login.');
    return;
  }
  state.username = username;

  await page.setProgress({
    phase: { step: 1, total: 2, label: 'Profile' },
    message: `Fetching @${username} profile...`,
  });
  state.profile = await extractProfile(username);

  await page.setProgress({
    phase: { step: 2, total: 2, label: 'Posts' },
    message: 'Fetching recent posts...',
  });
  state.posts = await extractPosts(username);

  const result = {
    'x.profile': state.profile || {
      username,
      displayName: '',
      bio: '',
      location: '',
      website: '',
      joinedDate: '',
      avatarUrl: '',
      following: 0,
      followers: 0,
      likes: 0,
      isVerified: false,
      profileUrl: `https://x.com/${username}`,
    },
    'x.posts': {
      posts: state.posts,
    },
    exportSummary: {
      count: state.posts.length,
      label: state.posts.length === 1 ? 'post' : 'posts',
      details: `${state.posts.length} recent posts`,
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'x',
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status', `Complete! Exported ${state.posts.length} posts for @${username}`);

  return { success: true, data: result };
})();
