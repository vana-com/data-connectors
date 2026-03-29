
(async () => {
  const STEAM_API = 'https://api.steampowered.com';

  async function collectSteamCredentialsManually() {
    const promptHtml = `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Steam Credentials</title>
    <style>
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; background: #0b1220; color: #f8fafc; }
      main { max-width: 560px; margin: 48px auto; padding: 32px; background: rgba(15, 23, 42, 0.9); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 16px; }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      label { display: block; margin-top: 20px; font-weight: 600; color: #e2e8f0; }
      input { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 12px 14px; border: 1px solid #475569; border-radius: 10px; background: #020617; color: #f8fafc; }
      button { margin-top: 24px; width: 100%; padding: 12px 14px; border: 0; border-radius: 10px; background: #38bdf8; color: #082f49; font-size: 16px; font-weight: 700; cursor: pointer; }
      small { display: block; margin-top: 8px; color: #94a3b8; }
      #error { min-height: 20px; margin-top: 16px; color: #fca5a5; }
      #done { min-height: 20px; margin-top: 12px; color: #86efac; }
      code { color: #fde68a; }
      a { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main>
      <h1>Steam API credentials</h1>
      <p>Enter your Steam Web API key and Steam ID to continue.</p>
      <p>
        API key: <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">steamcommunity.com/dev/apikey</a><br />
        Steam ID: <a href="https://steamid.io" target="_blank" rel="noreferrer">steamid.io</a>
      </p>
      <form id="steam-form">
        <label for="apiKey">Steam Web API Key</label>
        <input id="apiKey" name="apiKey" type="text" autocomplete="off" />
        <label for="steamId">Steam ID</label>
        <input id="steamId" name="steamId" type="text" autocomplete="off" placeholder="76561..." />
        <button type="submit">Continue</button>
      </form>
      <div id="error"></div>
      <div id="done"></div>
      <small>After clicking Continue, return to DataConnect and click "Done".</small>
    </main>
    <script>
      window.__steamCreds = null;
      document.getElementById('steam-form').addEventListener('submit', function (event) {
        event.preventDefault();
        var apiKey = document.getElementById('apiKey').value.trim();
        var steamId = document.getElementById('steamId').value.trim();
        if (!apiKey || !steamId) {
          document.getElementById('error').textContent = 'Enter both values.';
          return;
        }
        document.getElementById('error').textContent = '';
        window.__steamCreds = { apiKey: apiKey, steamId: steamId };
        document.body.setAttribute('data-submitted', 'true');
        document.getElementById('done').textContent = 'Saved. Return to DataConnect and click "Done".';
      });
    </script>
  </body>
</html>`;

    await page.showBrowser(
      'data:text/html;charset=utf-8,' + encodeURIComponent(promptHtml),
    );
    await page.setData(
      'status',
      'Enter your Steam Web API key and Steam ID in the browser...',
    );
    await page.promptUser(
      'Enter your Steam Web API key and Steam ID in the browser, click "Continue", then return here and click "Done".',
      async () =>
        await page.evaluate(`
          (() => document.body?.getAttribute('data-submitted') === 'true')
        `),
      1000,
    );

    const creds = await page.evaluate(`
      (() => window.__steamCreds || null)
    `);
    if (!creds || !creds.apiKey || !creds.steamId) {
      await page.setData('error', 'Steam credentials were not submitted.');
      return null;
    }
    return creds;
  }

  // ─── Auth: API key + Steam ID ─────────────────────────────
  let apiKey = process.env.STEAM_API_KEY;
  let steamId = process.env.STEAM_ID;
  const supportsRequestInput = typeof page.requestInput === 'function';

  if (!apiKey || !steamId) {
    if (supportsRequestInput) {
      const creds = await page.requestInput({
        message: 'Enter your Steam Web API key and Steam ID.\n\nGet your API key at: https://steamcommunity.com/dev/apikey\nFind your Steam ID at: https://steamid.io',
        schema: {
          type: 'object',
          properties: {
            apiKey: { type: 'string', title: 'Steam Web API Key' },
            steamId: { type: 'string', title: 'Steam ID (76561...)' },
          },
          required: ['apiKey', 'steamId'],
        },
      });
      apiKey = creds.apiKey;
      steamId = creds.steamId;
    } else {
      const creds = await collectSteamCredentialsManually();
      if (!creds) return;
      apiKey = creds.apiKey;
      steamId = creds.steamId;
    }
  }

  await page.closeBrowser();

  // ─── Helpers ──────────────────────────────────────────────
  async function steamGet(iface, method, version, params) {
    const qs = new URLSearchParams({ key: apiKey, steamid: steamId, ...params });
    const url = STEAM_API + '/' + iface + '/' + method + '/' + version + '/?' + qs.toString();
    const resp = await page.httpFetch(url);
    if (!resp.ok) return { _error: 'HTTP ' + resp.status };
    return resp.json;
  }

  // ─── Step 1: Profile ─────────────────────────────────────
  await page.setProgress({ phase: { step: 1, total: 4, label: 'Fetching profile' }, message: 'Getting player summary...' });

  const profileResp = await steamGet('ISteamUser', 'GetPlayerSummaries', 'v2', { steamids: steamId });
  if (profileResp._error) {
    await page.setData('error', 'Failed to fetch profile: ' + profileResp._error + '. Check your API key and Steam ID.');
    return;
  }

  const players = (profileResp.response && profileResp.response.players) || [];
  if (players.length === 0) {
    await page.setData('error', 'No player found for Steam ID ' + steamId + '. Check your Steam ID.');
    return;
  }

  const player = players[0];

  const levelResp = await steamGet('IPlayerService', 'GetSteamLevel', 'v1', {});
  const steamLevel = (levelResp.response && levelResp.response.player_level) || null;

  const profile = {
    steamId: player.steamid,
    personaName: player.personaname,
    profileUrl: player.profileurl,
    avatarUrl: player.avatarfull || player.avatar,
    realName: player.realname || null,
    country: player.loccountrycode || null,
    state: player.locstatecode || null,
    cityId: player.loccityid || null,
    steamLevel: steamLevel,
    accountCreated: player.timecreated ? new Date(player.timecreated * 1000).toISOString() : null,
    lastLogoff: player.lastlogoff ? new Date(player.lastlogoff * 1000).toISOString() : null,
    personaState: player.personastate,
    communityVisibilityState: player.communityvisibilitystate,
  };

  // ─── Step 2: Owned games ─────────────────────────────────
  await page.setProgress({ phase: { step: 2, total: 4, label: 'Fetching games' }, message: 'Getting owned games...' });

  const gamesResp = await steamGet('IPlayerService', 'GetOwnedGames', 'v1', {
    include_appinfo: '1',
    include_played_free_games: '1',
  });

  let games = [];
  if (!gamesResp._error && gamesResp.response && gamesResp.response.games) {
    games = gamesResp.response.games.map(function (g) {
      return {
        appId: g.appid,
        name: g.name,
        playtimeMinutes: g.playtime_forever || 0,
        playtimeHours: Math.round((g.playtime_forever || 0) / 60 * 10) / 10,
        playtimeTwoWeeksMinutes: g.playtime_2weeks || 0,
        iconUrl: g.img_icon_url
          ? 'https://media.steampowered.com/steamcommunity/public/images/apps/' + g.appid + '/' + g.img_icon_url + '.jpg'
          : null,
        lastPlayed: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : null,
      };
    });
    games.sort(function (a, b) { return b.playtimeMinutes - a.playtimeMinutes; });
  }

  const recentResp = await steamGet('IPlayerService', 'GetRecentlyPlayedGames', 'v1', {});
  let recentGames = [];
  if (!recentResp._error && recentResp.response && recentResp.response.games) {
    recentGames = recentResp.response.games.map(function (g) {
      return {
        appId: g.appid,
        name: g.name,
        playtimeTwoWeeksMinutes: g.playtime_2weeks || 0,
        playtimeForeverMinutes: g.playtime_forever || 0,
      };
    });
  }

  // ─── Step 3: Friends ─────────────────────────────────────
  await page.setProgress({ phase: { step: 3, total: 4, label: 'Fetching friends' }, message: 'Getting friend list...' });

  let friends = [];
  const friendsResp = await steamGet('ISteamUser', 'GetFriendList', 'v1', { relationship: 'friend' });
  if (!friendsResp._error && friendsResp.friendslist && friendsResp.friendslist.friends) {
    const friendIds = friendsResp.friendslist.friends;

    // Batch resolve friend names (100 at a time)
    var friendProfiles = {};
    for (var i = 0; i < friendIds.length; i += 100) {
      var batch = friendIds.slice(i, i + 100);
      var ids = batch.map(function (f) { return f.steamid; }).join(',');
      var batchResp = await page.httpFetch(
        STEAM_API + '/ISteamUser/GetPlayerSummaries/v2/?key=' + apiKey + '&steamids=' + ids
      );
      if (batchResp.ok && batchResp.json && batchResp.json.response) {
        var batchPlayers = batchResp.json.response.players || [];
        for (var p = 0; p < batchPlayers.length; p++) {
          friendProfiles[batchPlayers[p].steamid] = batchPlayers[p];
        }
      }
      if (i + 100 < friendIds.length) await page.sleep(300);
    }

    friends = friendIds.map(function (f) {
      var fp = friendProfiles[f.steamid];
      return {
        steamId: f.steamid,
        personaName: fp ? fp.personaname : null,
        avatarUrl: fp ? (fp.avatarfull || fp.avatar) : null,
        profileUrl: fp ? fp.profileurl : null,
        friendSince: f.friend_since ? new Date(f.friend_since * 1000).toISOString() : null,
        relationship: f.relationship,
      };
    });
  }

  // ─── Step 4: Build result ────────────────────────────────
  await page.setProgress({ phase: { step: 4, total: 4, label: 'Building result' }, message: 'Packaging data...' });

  var totalPlaytimeHours = Math.round(games.reduce(function (sum, g) { return sum + g.playtimeMinutes; }, 0) / 60);

  var topGames = games.slice(0, 5).map(function (g) { return g.name + ' (' + g.playtimeHours + 'h)'; }).join(', ');

  var result = {
    'steam.profile': profile,
    'steam.games': { owned: games, recentlyPlayed: recentGames },
    'steam.friends': friends,
    exportSummary: {
      count: games.length + friends.length,
      label: 'Steam data items',
      details: games.length + ' games (' + totalPlaytimeHours + 'h total), '
        + friends.length + ' friends, '
        + recentGames.length + ' recently played. '
        + (topGames ? 'Top: ' + topGames : ''),
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    platform: 'steam',
  };

  await page.setData('result', result);
})();
