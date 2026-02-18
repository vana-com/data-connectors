/**
 * Spotify Connector (Playwright)
 *
 * Uses Spotify's internal GraphQL API (api-partner.spotify.com) instead of the
 * public api.spotify.com which rate-limits web player tokens (429).
 *
 * Phase 1 (Browser, visible if login needed):
 *   - Detects login via persistent browser session
 *   - If not logged in, shows browser for user to log in
 *   - Gets access token via /api/token with TOTP authentication
 *   - Gets client-token from clienttoken.spotify.com
 *
 * Phase 2 (Headless — invisible to user):
 *   - Extracts GraphQL persisted query hashes from web player bundle
 *   - Uses api-partner.spotify.com/pathfinder/v2/query for data
 *   - Reports structured progress to the UI
 */

const state = {
  accessToken: null,
  clientToken: null,
  clientId: null,
  queryHashes: null,
  profile: null,
  isComplete: false
};

// ─── Token Helpers ───────────────────────────────────────────

const getAccessToken = async () => {
  try {
    const result = await page.evaluate(`
      (async () => {
        try {
          // Get server time
          let serverTime = null;
          try {
            const stResp = await fetch("/api/server-time");
            const stData = await stResp.json();
            serverTime = Number(stData.serverTime);
            if (isNaN(serverTime)) serverTime = null;
          } catch(e) {}

          // TOTP secret (from web-player bundle v61, Feb 2026)
          const totpSecret = ',7/*F("rLJ2oxaKL^f+E1xvP@N';

          // XOR-decode
          const xored = totpSecret.split("").map((c, i) => c.charCodeAt(0) ^ ((i % 33) + 9));
          const joined = xored.join("");
          const encoder = new TextEncoder();
          const joinedBytes = encoder.encode(joined);
          const secretHex = Array.from(joinedBytes).map(b => b.toString(16).padStart(2, "0")).join("");

          // TOTP generation (HMAC-SHA1)
          async function genTOTP(hexSecret, timestampMs) {
            const counter = Math.floor(timestampMs / 1000 / 30);
            const buf = new ArrayBuffer(8);
            const v = new DataView(buf);
            v.setUint32(0, Math.floor(counter / 0x100000000));
            v.setUint32(4, counter & 0xFFFFFFFF);
            const kb = new Uint8Array(hexSecret.match(/.{1,2}/g).map(b => parseInt(b, 16)));
            const key = await crypto.subtle.importKey("raw", kb, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
            const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
            const o = sig[sig.length - 1] & 0x0f;
            const code = (((sig[o] & 0x7f) << 24) | ((sig[o+1] & 0xff) << 16) |
              ((sig[o+2] & 0xff) << 8) | (sig[o+3] & 0xff)) % 1000000;
            return String(code).padStart(6, "0");
          }

          const now = Date.now();
          const totp = await genTOTP(secretHex, now);
          const totpServer = serverTime ? await genTOTP(secretHex, serverTime * 1000) : "unavailable";

          const params = new URLSearchParams({
            reason: "init", productType: "web_player",
            totp: totp, totpServer: totpServer, totpVer: "61"
          });
          const tokenResp = await fetch("/api/token?" + params.toString(), { credentials: "include" });
          const tokenData = await tokenResp.json();

          if (!tokenResp.ok || !tokenData.accessToken || tokenData.isAnonymous) {
            return { success: false, error: "HTTP " + tokenResp.status, isAnon: tokenData.isAnonymous };
          }
          return { success: true, token: tokenData.accessToken, clientId: tokenData.clientId };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()
    `);
    if (result?.success) {
      state.clientId = result.clientId;
      return result.token;
    }
    await page.setData('status', 'Token error: ' + JSON.stringify(result).substring(0, 150));
    return null;
  } catch (err) {
    return null;
  }
};

const getClientToken = async () => {
  try {
    const result = await page.evaluate(`
      (async () => {
        try {
          const resp = await fetch("https://clienttoken.spotify.com/v1/clienttoken", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              client_data: {
                client_version: "1.2.56.244.g7bfe3dc8",
                client_id: ${JSON.stringify(state.clientId)},
                js_sdk_data: { device_brand: "unknown", device_model: "unknown", os: "macos", os_version: "unknown", device_type: "computer" }
              }
            })
          });
          if (!resp.ok) return { success: false, error: "HTTP " + resp.status };
          const data = await resp.json();
          if (data.granted_token && data.granted_token.token) {
            return { success: true, token: data.granted_token.token };
          }
          return { success: false, error: "no granted_token" };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()
    `);
    if (result?.success) return result.token;
    return null;
  } catch (err) {
    return null;
  }
};

// ─── GraphQL Hash Extraction ────────────────────────────────

const extractQueryHashes = async () => {
  try {
    const result = await page.evaluate(`
      (async () => {
        try {
          const needed = ['fetchLibraryTracks', 'fetchPlaylist', 'libraryV3', 'profileAttributes'];
          const hashPattern = /new\\s+\\w+\\.\\w+\\("(\\w+)","(?:query|mutation)","([a-f0-9]{64})"/g;

          const extractFromText = (text) => {
            const ops = {};
            let m;
            const re = new RegExp(hashPattern.source, 'g');
            while ((m = re.exec(text)) !== null) ops[m[1]] = m[2];
            const found = {};
            for (const name of needed) { if (ops[name]) found[name] = ops[name]; }
            return Object.keys(found).length > 0 ? found : null;
          };

          // Approach 1: SW precache (fast, works on subsequent runs)
          try {
            const names = await caches.keys();
            const pcName = names.find(n => n.includes('workbox-precache'));
            if (pcName) {
              const cache = await caches.open(pcName);
              const keys = await cache.keys();
              const jsReqs = keys.filter(r => r.url.endsWith('.js'));

              const sized = [];
              for (const req of jsReqs) {
                const resp = await cache.match(req);
                if (!resp) continue;
                sized.push({ req, size: parseInt(resp.headers.get('content-length') || '0') });
              }
              sized.sort((a, b) => b.size - a.size);

              for (const { req } of sized.slice(0, 5)) {
                const resp = await cache.match(req);
                if (!resp) continue;
                const text = await resp.text();
                const hashes = extractFromText(text);
                if (hashes && Object.keys(hashes).length >= needed.length) {
                  return { success: true, hashes, source: 'sw-cache' };
                }
              }
            }
          } catch (e) {}

          // Approach 2: Fetch JS bundles loaded by the page (works on first run
          // when SW hasn't cached yet)
          try {
            const domScripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
            const perfScripts = performance.getEntriesByType('resource')
              .filter(e => e.initiatorType === 'script' && e.name.endsWith('.js'))
              .map(e => e.name);
            const allScripts = [...new Set([...domScripts, ...perfScripts])]
              .filter(u => u.includes('spotify'));

            for (const url of allScripts) {
              try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const text = await resp.text();
                const hashes = extractFromText(text);
                if (hashes && Object.keys(hashes).length >= needed.length) {
                  return { success: true, hashes, source: 'page-scripts' };
                }
              } catch (e) { continue; }
            }
          } catch (e) {}

          return { success: false, error: 'No hashes found in SW cache or page scripts' };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()
    `);
    if (result?.success) return result.hashes;
    await page.setData('status', 'Hash extraction: ' + JSON.stringify(result).substring(0, 150));
    return null;
  } catch (err) {
    return null;
  }
};

// ─── Login Check ─────────────────────────────────────────────

// Check if user has completed login by verifying we're on open.spotify.com.
// Spotify only redirects here after full authentication (including email confirmation codes).
// This prevents premature detection when still on accounts.spotify.com or challenge.spotify.com.
const checkLoginComplete = async () => {
  try {
    const result = await page.evaluate(`
      (() => window.location.hostname === 'open.spotify.com')()
    `);
    return result;
  } catch (err) {
    return false;
  }
};

// ─── GraphQL Fetch ───────────────────────────────────────────

const gqlFetch = async (operationName, variables) => {
  const hash = state.queryHashes[operationName];
  if (!hash) {
    await page.setData('status', 'Missing hash for ' + operationName);
    return null;
  }

  const result = await page.evaluate(`
    (async () => {
      try {
        const resp = await fetch("https://api-partner.spotify.com/pathfinder/v2/query", {
          method: "POST",
          headers: {
            authorization: "Bearer " + ${JSON.stringify(state.accessToken)},
            "client-token": ${JSON.stringify(state.clientToken)},
            "content-type": "application/json",
            accept: "application/json",
            "app-platform": "WebPlayer",
            "spotify-app-version": "1.2.56.244.g7bfe3dc8"
          },
          body: JSON.stringify({
            operationName: ${JSON.stringify(operationName)},
            variables: ${JSON.stringify(variables)},
            extensions: { persistedQuery: { version: 1, sha256Hash: ${JSON.stringify(hash)} } }
          })
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          return { success: false, error: "HTTP " + resp.status, body: text.substring(0, 200) };
        }
        const data = await resp.json();
        if (data.errors) {
          return { success: false, error: JSON.stringify(data.errors).substring(0, 200) };
        }
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })()
  `);

  if (result?.success) return result.data;
  await page.setData('status', operationName + ' error: ' + (result?.error || 'unknown'));
  return null;
};

// Also keep spclient fetch for profile (always works, simpler)
const spClientFetch = async (path) => {
  const result = await page.evaluate(`
    (async () => {
      try {
        const resp = await fetch("https://spclient.wg.spotify.com" + ${JSON.stringify(path)}, {
          headers: {
            authorization: "Bearer " + ${JSON.stringify(state.accessToken)},
            "client-token": ${JSON.stringify(state.clientToken)},
            accept: "application/json",
            "app-platform": "WebPlayer"
          }
        });
        if (!resp.ok) return { success: false, error: "HTTP " + resp.status };
        const data = await resp.json();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })()
  `);
  if (result?.success) return result.data;
  return null;
};

// ─── Main Export Flow ────────────────────────────────────────

(async () => {
  // ═══ PHASE 1: Login & Token Acquisition ═══
  await page.setData('status', 'Checking login status...');
  await page.sleep(2000);

  let token = await getAccessToken();

  if (!token) {
    await page.showBrowser('https://accounts.spotify.com/en/login?continue=https%3A%2F%2Fopen.spotify.com%2F');
    await page.setData('status', 'Please log in to Spotify...');
    await page.sleep(3000);

    // Wait for full login completion:
    // - User must reach open.spotify.com (not still on accounts/challenge pages)
    // - Token must be non-anonymous (sp_dc cookie set)
    // This prevents premature detection during email confirmation code flows.
    await page.promptUser(
      'Please log in to Spotify. Click "Done" when you see the Spotify player.',
      async () => await checkLoginComplete(),
      3000
    );

    await page.setData('status', 'Login completed. Capturing session...');

    // Ensure we're on open.spotify.com before getting token
    await page.goto('https://open.spotify.com/');
    await page.sleep(3000);

    token = await getAccessToken();

    if (!token) {
      await page.setData('error', 'Could not get access token after login. Please try again.');
      return { error: 'Could not get access token' };
    }
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  state.accessToken = token;

  // Get client-token (needed for api-partner GraphQL calls)
  await page.setData('status', 'Getting client token...');
  state.clientToken = await getClientToken();
  if (!state.clientToken) {
    await page.setData('error', 'Could not get client token.');
    return { error: 'Could not get client token' };
  }

  // ═══ Switch to headless ═══
  await page.goHeadless();

  // Navigate to open.spotify.com in the headless browser.
  // After goHeadless(), the page is on about:blank. API calls need to originate
  // from the Spotify domain for CORS to allow requests to api-partner.spotify.com.
  await page.goto('https://open.spotify.com/');
  await page.sleep(3000);

  // Extract GraphQL query hashes from web player bundle.
  // Done after headless page load so scripts are available even on first run
  // (before the Service Worker has cached them).
  await page.setData('status', 'Extracting API configuration...');
  for (let attempt = 0; attempt < 3; attempt++) {
    state.queryHashes = await extractQueryHashes();
    if (state.queryHashes && Object.keys(state.queryHashes).length >= 4) break;
    if (attempt < 2) await page.sleep(3000);
  }
  if (!state.queryHashes || Object.keys(state.queryHashes).length === 0) {
    await page.setData('error', 'Could not extract GraphQL hashes. Please try again.');
    return { error: 'Could not extract query hashes' };
  }

  // ═══ PHASE 2: Data Collection ═══

  // Step 1: Profile
  await page.setProgress({
    phase: { step: 1, total: 3, label: 'Fetching profile' },
    message: 'Loading profile data...',
  });

  // Use spclient for profile (always works, returns JSON directly)
  const profileData = await spClientFetch('/user-profile-view/v3/profile/me');

  // Also get profileAttributes via GraphQL for username/uri
  const profileAttrs = await gqlFetch('profileAttributes', {});
  const pa = profileAttrs?.data?.me?.profile;

  if (!profileData && !pa) {
    await page.setData('error', 'Could not fetch profile. Token may be invalid.');
    return { error: 'Could not fetch profile' };
  }

  state.profile = {
    id: pa?.username || '',
    display_name: profileData?.name || pa?.name || '',
    uri: pa?.uri || profileData?.uri || '',
    followers: profileData?.followers_count || 0,
    following: profileData?.following_count || 0,
    images: profileData?.image_url ? [profileData.image_url] : [],
  };

  await page.setData('status', 'Logged in as ' + state.profile.display_name);

  // Step 2: Liked Songs (paginated via GraphQL)
  await page.setProgress({
    phase: { step: 2, total: 3, label: 'Fetching liked songs' },
    message: 'Loading liked songs...',
    count: 0,
  });

  const savedTracks = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await gqlFetch('fetchLibraryTracks', {
      uri: 'spotify:user:me:collection',
      offset: offset,
      limit: limit
    });

    const tracks = data?.data?.me?.library?.tracks;
    if (!tracks) break;

    const items = tracks.items || [];
    for (const item of items) {
      const t = item.track?.data;
      if (!t || !t.name) continue;
      savedTracks.push({
        added_at: item.addedAt?.isoString || '',
        name: t.name,
        artists: (t.artists?.items || []).map(a => ({ name: a.profile?.name || '' })),
        album: {
          name: t.albumOfTrack?.name || '',
          artists: (t.albumOfTrack?.artists?.items || []).map(a => ({ name: a.profile?.name || '' })),
        },
        duration_ms: t.duration?.totalMilliseconds || 0,
        uri: item.track?._uri || item.track?.uri || '',
        explicit: t.contentRating?.label === 'EXPLICIT',
      });
    }

    const total = tracks.totalCount || '?';
    await page.setProgress({
      phase: { step: 2, total: 3, label: 'Fetching liked songs' },
      message: 'Loaded ' + savedTracks.length + ' of ' + total + ' liked songs...',
      count: savedTracks.length,
    });

    if (items.length < limit || (tracks.totalCount && savedTracks.length >= tracks.totalCount)) break;
    offset += limit;
    await page.sleep(300);
  }

  // Step 3: Playlists
  await page.setProgress({
    phase: { step: 3, total: 3, label: 'Fetching playlists' },
    message: 'Loading playlists...',
    count: 0,
  });

  // Get library overview to list playlists
  const libData = await gqlFetch('libraryV3', {
    filters: [], order: null, textFilter: '',
    features: ['LIKED_SONGS', 'YOUR_EPISODES'],
    limit: 200, offset: 0, flatten: false,
    expandedFolders: [], folderUri: null,
    includeFoldersWhenFlattening: true, withCuration: false
  });

  const libItems = libData?.data?.me?.libraryV3?.items || [];
  const playlistUris = libItems
    .filter(item => item.item?.data?.__typename === 'Playlist')
    .map(item => item.item?.data?._uri || item.item?.data?.uri || '');

  const playlists = [];

  for (let i = 0; i < playlistUris.length; i++) {
    const uri = playlistUris[i];
    if (!uri) continue;

    await page.setProgress({
      phase: { step: 3, total: 3, label: 'Fetching playlists' },
      message: 'Loading playlist ' + (i + 1) + ' of ' + playlistUris.length + '...',
      count: i + 1,
    });

    // Fetch playlist details
    const allPlaylistTracks = [];
    let plOffset = 0;
    let playlistMeta = null;

    while (true) {
      const plData = await gqlFetch('fetchPlaylist', {
        uri: uri,
        offset: plOffset,
        limit: 100,
        enableWatchFeedEntrypoint: false
      });

      const pl = plData?.data?.playlistV2;
      if (!pl) break;

      if (!playlistMeta) {
        playlistMeta = {
          name: pl.name || '',
          description: pl.description || '',
          owner: pl.ownerV2?.data?.name || '',
          uri: pl.uri || uri,
          followers: pl.followers || 0,
          images: (pl.images?.items || []).slice(0, 1).map(img =>
            img.sources?.[0]?.url || ''
          ).filter(Boolean),
        };
      }

      const items = pl.content?.items || [];
      for (const item of items) {
        const t = item.itemV2?.data;
        if (!t || t.__typename !== 'Track') continue;
        allPlaylistTracks.push({
          added_at: item.addedAt?.isoString || '',
          added_by: item.addedBy?.data?.name || '',
          name: t.name || '',
          artists: (t.artists?.items || []).map(a => ({ name: a.profile?.name || '' })),
          album: t.albumOfTrack?.name || '',
          duration_ms: t.trackDuration?.totalMilliseconds || 0,
          uri: t.uri || '',
        });
      }

      const total = pl.content?.totalCount || 0;
      if (items.length < 100 || allPlaylistTracks.length >= total) break;
      plOffset += 100;
      await page.sleep(200);
    }

    if (playlistMeta) {
      playlists.push({
        ...playlistMeta,
        tracks_total: allPlaylistTracks.length,
        tracks: allPlaylistTracks,
      });
    }

    await page.sleep(200);
  }

  // ═══ Build Result ═══
  const totalPlaylistTracks = playlists.reduce((sum, p) => sum + p.tracks.length, 0);

  const result = {
    profile: state.profile,
    savedTracks,
    playlists,
    exportSummary: {
      count: savedTracks.length,
      label: savedTracks.length === 1 ? 'liked song' : 'liked songs',
      details: [
        savedTracks.length + ' liked songs',
        playlists.length + ' playlists (' + totalPlaylistTracks + ' tracks)',
      ].join(', '),
    },
    timestamp: new Date().toISOString(),
    version: "1.0.0-playwright",
    platform: "spotify"
  };

  state.isComplete = true;
  await page.setData('result', result);
  await page.setData('status',
    'Complete! ' + savedTracks.length + ' liked songs, ' +
    playlists.length + ' playlists collected for ' + state.profile.display_name
  );

  return { success: true, data: result };
})();
