/**
 * Factory.fm Vana Data Connector
 *
 * Exports a user's Factory.fm listening log data:
 * - Profile (username, bio, karma, stats)
 * - Logs (reviews with ratings, body text, release/artist details)
 * - Artists (derived from logged releases)
 *
 * Uses Factory.fm v1 JSON API endpoints that accept session cookies.
 */

const state = { isComplete: false };

// âââ Login check ââââââââââââââââââââââââââââââââââââââââââââââââââââ
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const r = await fetch('/api/auth/session', { credentials: 'include' });
          if (!r.ok) return false;
          const s = await r.json();
          return !!(s.user && s.user.id);
        } catch {
          return false;
        }
      })()
    `);
  } catch {
    return false;
  }
};

// âââ Resolve username from nav DOM ââââââââââââââââââââââââââââââââââ
const resolveUsername = async () => {
  return await page.evaluate(`
    (() => {
      const links = Array.from(document.querySelectorAll('a[href*="/u/"]'));
      for (const link of links) {
        const m = link.href.match(/\\/u\\/([^/?#]+)/);
        if (m) return m[1];
      }
      return null;
    })()
  `);
};

// âââ Main flow ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
(async () => {
  // Phase 1: Login
  await page.setData("status", "Checking login status...");
  await page.sleep(2000);

  if (!(await checkLoginStatus())) {
    await page.showBrowser("https://factory.fm/login");
    await page.setData("status", "Please log in to Factory.fm...");
    await page.promptUser(
      'Please log in to your Factory.fm account. Click "Done" when ready.',
      async () => await checkLoginStatus(),
      2000,
    );
  }

  // Phase 2: Headless data collection
  await page.goHeadless();

  // Step 1: Resolve username
  await page.setProgress({
    phase: { step: 1, total: 3, label: "Resolving profile" },
    message: "Finding your username...",
  });

  await page.goto("https://factory.fm/home");
  await page.sleep(1500);

  const username = await resolveUsername();
  if (!username) {
    await page.setData("error", "Could not determine your username.");
    return;
  }

  // Step 1 cont: Fetch profile
  await page.setProgress({
    phase: { step: 1, total: 3, label: "Resolving profile" },
    message: `Fetching profile for @${username}...`,
  });

  const profile = await page.evaluate(`
    (async () => {
      const r = await fetch('/api/v1/profiles/by/username/${username}', { credentials: 'include' });
      if (!r.ok) throw new Error('Profile fetch failed: ' + r.status);
      return r.json();
    })()
  `);

  // Step 2: Fetch all logs
  await page.setProgress({
    phase: { step: 2, total: 3, label: "Fetching logs" },
    message: `Fetching logs (${profile.logCount} total)...`,
    count: 0,
  });

  const allLogs = [];
  let currentPage = 1;
  const pageSize = 50;
  let hasMore = true;
  const profileId = profile.id;

  while (hasMore) {
    const feedResult = await page.evaluate(`
      (async () => {
        const r = await fetch('/api/v1/feed/profile?profileId=${profileId}&page=${currentPage}&limit=${pageSize}', { credentials: 'include' });
        if (!r.ok) throw new Error('Feed fetch failed: ' + r.status);
        return r.json();
      })()
    `);

    if (feedResult.data && feedResult.data.length > 0) {
      allLogs.push(...feedResult.data);
    }

    hasMore = feedResult.nextPage !== null;
    currentPage = feedResult.nextPage || currentPage + 1;

    await page.setProgress({
      phase: { step: 2, total: 3, label: "Fetching logs" },
      message: `Downloaded ${allLogs.length} of ~${profile.logCount} logs...`,
      count: allLogs.length,
    });

    await page.sleep(300); // rate limiting
  }

  // Step 3: Derive artists
  await page.setProgress({
    phase: { step: 3, total: 3, label: "Processing artists" },
    message: "Extracting unique artists from logs...",
  });

  const artistMap = {};
  for (const log of allLogs) {
    if (log.release && log.release.artists) {
      for (const artist of log.release.artists) {
        if (!artistMap[artist.id]) {
          artistMap[artist.id] = {
            id: artist.id,
            name: artist.name,
            imageUrl: artist.imageUrl || null,
          };
        }
      }
    }
  }
  const artists = Object.values(artistMap);

  // Build result
  const result = {
    "factory.profile": {
      id: profile.id,
      username: profile.username,
      bio: profile.bio || null,
      location: profile.location || null,
      imageUrl: profile.imageUrl || null,
      karma: profile.karma,
      tag: profile.tag || null,
      logCount: profile.logCount,
      followerCount: profile.followerCount,
      followingCount: profile.followingCount,
      createdAt: profile.createdAt,
    },
    "factory.logs": allLogs.map((log) => ({
      id: log.id,
      body: log.body || null,
      rating: log.rating,
      createdAt: log.createdAt,
      release: {
        id: log.release.id,
        title: log.release.title,
        artist: log.release.artist,
        coverImage: log.release.coverImage || null,
        spotifyId: log.release.spotifyId || null,
        releaseDate: log.release.releaseDate || null,
        slug: log.release.slug,
        artists: (log.release.artists || []).map((a) => ({
          id: a.id,
          name: a.name,
          imageUrl: a.imageUrl || null,
        })),
      },
    })),
    "factory.artists": artists,
    exportSummary: {
      count: allLogs.length,
      label: allLogs.length === 1 ? "log" : "logs",
      details: `${allLogs.length} logs across ${artists.length} artists`,
    },
    timestamp: new Date().toISOString(),
    version: "1.0.0-playwright",
    platform: "factory",
  };

  state.isComplete = true;
  await page.setData("result", result);
})();
