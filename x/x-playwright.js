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
        const hasLoggedInNav = !!document.querySelector(
          '[data-testid="AppTabBar_Home_Link"], [data-testid="AppTabBar_Profile_Link"], [data-testid="SideNav_NewTweet_Button"]'
        );
        const hasProfileTab = !!document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
        const hasAccountSwitcher = !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        const hasHome = !!document.querySelector('a[href="/home"]');
        return hasLoggedInNav || hasProfileTab || hasAccountSwitcher || hasHome;
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

        const accountSwitcherText =
          document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent || '';
        const fromAccountSwitcher = (accountSwitcherText.match(/@([A-Za-z0-9_]{1,15})/) || [])[1] || '';
        if (fromAccountSwitcher) return fromAccountSwitcher;

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
        try {
          ${TO_INT_HELPER}

          const parseStatusLink = (href) => {
            if (!href) return null;
            try {
              const url = new URL(href, window.location.origin);
              const pathname = url.pathname || '';
              let match = pathname.match(/^\\/([^/]+)\\/status\\/(\\d+)/);
              if (match) return { username: match[1], id: match[2] };

              match = pathname.match(/^\\/i\\/web\\/status\\/(\\d+)/);
              if (match) return { username: null, id: match[1] };

              return null;
            } catch {
              return null;
            }
          };

          const metricValue = (article, testIds) => {
            for (const testId of testIds) {
              const node = article.querySelector('[data-testid="' + testId + '"]');
              const value = toInt((node?.textContent || '').trim());
              if (value > 0) return value;
            }
            return 0;
          };

          const containerSet = new Set();
          const pushContainer = (node) => {
            if (!node || !(node instanceof Element)) return;
            containerSet.add(node);
          };

          Array.from(
            document.querySelectorAll(
              'article[data-testid="tweet"], main article, [data-testid="primaryColumn"] article, [data-testid="cellInnerDiv"]'
            )
          ).forEach(pushContainer);

          const statusLinks = Array.from(document.querySelectorAll('a[href*="/status/"]'));
          for (const link of statusLinks) {
            let node = link;
            let depth = 0;
            while (node && depth < 10) {
              if (
                node.matches?.('article, [data-testid="cellInnerDiv"], [data-testid="tweet"]') ||
                node.querySelector?.('time')
              ) {
                pushContainer(node);
                break;
              }
              node = node.parentElement;
              depth += 1;
            }
          }

          const articles = Array.from(containerSet).filter((container) => {
            if (!container || !(container instanceof Element)) return false;
            const text = (container.textContent || '').toLowerCase();
            const hasStatus = !!container.querySelector('a[href*="/status/"]');
            const hasTweetText = !!container.querySelector('[data-testid="tweetText"]');
            const hasTime = !!container.querySelector('time');
            if (!(hasStatus || hasTweetText || hasTime)) return false;
            if (/who to follow|relevant people|trending/.test(text) && !hasTime) return false;
            return true;
          });
          const posts = [];

          for (const article of articles) {
            const statusAnchors = [];
            const timeAnchor = article.querySelector('time')?.closest('a[href]');
            if (timeAnchor) statusAnchors.push(timeAnchor);
            for (const anchor of Array.from(article.querySelectorAll('a[href*="/status/"]'))) {
              if (!statusAnchors.includes(anchor)) statusAnchors.push(anchor);
            }
            let parsed = null;
            let statusUrl = null;
            for (const anchor of statusAnchors) {
              const nextParsed = parseStatusLink(anchor.getAttribute('href') || '');
              if (!nextParsed) continue;

              const fallbackAuthor = (Array.from(article.querySelectorAll('a[href^="/"]'))
                .map((a) => (a.getAttribute('href') || '').match(/^\\/([A-Za-z0-9_]{1,15})$/))
                .find(Boolean) || [])[1] || null;

              parsed = {
                id: nextParsed.id,
                username: nextParsed.username || fallbackAuthor,
              };

              if (parsed.id && parsed.username) {
                statusUrl = 'https://x.com/' + parsed.username + '/status/' + parsed.id;
                break;
              }

              if (parsed.id) {
                statusUrl = 'https://x.com/i/web/status/' + parsed.id;
                break;
              }
            }
            if (!parsed || !statusUrl) {
              continue;
            }

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
              authorUsername: parsed.username || '',
              text,
              createdAt,
              replyCount: metricValue(article, ['reply']),
              repostCount: metricValue(article, ['retweet', 'unretweet']),
              likeCount: metricValue(article, ['like', 'unlike']),
              bookmarkCount: metricValue(article, ['bookmark', 'removeBookmark']),
              viewCount: metricValue(article, ['viewCount']),
              isPinned,
              isReply,
              lang,
              mediaUrls,
            });
          }

          return { posts, error: null };
        } catch (err) {
          return {
            posts: [],
            error: String(err && err.message ? err.message : err),
          };
        }
      })()
    `);

    if (result && typeof result === 'object') {
      return {
        posts: Array.isArray(result.posts) ? result.posts : [],
        error: result.error || null,
      };
    }

    return { posts: [], error: 'Unexpected evaluate result' };
  } catch {
    return { posts: [], error: 'extractVisiblePosts wrapper failed' };
  }
};

const extractPosts = async (username) => {
  if (!isValidXUsername(username)) return [];

  await page.goto(`https://x.com/${username}`);
  await page.sleep(3000);
  await page.evaluate(`window.scrollTo(0, 0)`);

  // X sometimes delays timeline hydration in headless/responsive layouts.
  for (let i = 0; i < 3; i++) {
    const visibleStatusLinks = await page.evaluate(`
      (() => document.querySelectorAll('main a[href*="/status/"]').length)()
    `);
    if (visibleStatusLinks > 0) break;
    await page.sleep(1500);
    await page.evaluate(`window.scrollBy(0, Math.round(window.innerHeight * 0.3))`);
  }

  const all = [];
  const seen = new Set();
  let lastVisibleError = null;
  const maxPosts = 120;
  const maxScrolls = 12;
  let stagnantScrolls = 0;

  for (let scrollIndex = 0; scrollIndex < maxScrolls; scrollIndex++) {
    const visibleResult = await extractVisiblePosts();
    const visible = visibleResult.posts || [];
    lastVisibleError = visibleResult.error || lastVisibleError;
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
    await page.sleep(2000);
  }

  if (lastVisibleError) {
    await page.setData('status', `X post extraction note: ${lastVisibleError}`);
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
    await page.sleep(3000);
    await page.setData('status', 'Please log in to X...');

    await page.promptUser(
      'Please log in to X. Click "Done" when your home timeline loads.',
      async () => await isLoggedIn(),
      2000
    );

    await page.sleep(2000);
    loggedIn = await isLoggedIn();
  }

  if (!loggedIn) {
    await page.setData('error', 'X login could not be confirmed.');
    return;
  }

  await page.setData('status', 'Login confirmed. Resolving account...');

  let username = await readLoggedInUsername();
  if (!isValidXUsername(username)) {
    await page.goto('https://x.com/home');
    await page.sleep(2000);
    username = await readLoggedInUsername();
  }

  await page.setProgress({
    phase: { step: 1, total: 2, label: 'Profile' },
    message: 'Resolving account...',
  });

  if (!isValidXUsername(username)) {
    await page.setData('error', 'Could not resolve a valid X username after login.');
    return;
  }
  state.username = username;

  await page.goHeadless();

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

  if (state.posts.length === 0) {
    await page.setData('status', 'No posts found in headless mode. Retrying with visible browser...');
    await page.showBrowser(`https://x.com/${username}`);
    await page.sleep(3000);
    state.posts = await extractPosts(username);
  }

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
    version: '1.0.6-playwright',
    platform: 'x',
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status', `Complete! Exported ${state.posts.length} posts for @${username}`);

  return { success: true, data: result };
})();
