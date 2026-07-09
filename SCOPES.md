# Scope Coverage Registry

**The single reference for every data scope, how it can be fulfilled (web vs.
desktop), and the exact connectors behind it.**

This file is **maintained by hand.** It is the source of truth people read when
they need to answer "can the web flow produce `instagram.ads`?" (it can't — see
the table). There is intentionally no generator and no automated sync: the set
of web-fulfillable scopes changes rarely, so when it changes, edit this file
directly. (Background: an Instagram scope mismatch surfaced in an end-to-end
test — a scope requested via the web flow that only the desktop connector can
actually produce.)

## How to read this

- **Web** — the scope can be produced by the ODL **Data Pipe API**
  (`data-pipe.vana.org`), the hosted "light" flow used by the Vana Web app. Today
  the Data Pipe API produces `*.profile` for the five sources it has been wired
  for (Instagram, Spotify, YouTube, LinkedIn, GitHub), plus capped Instagram
  posts. Update this column **by hand** when the Data Pipe API gains a new
  source/scope.
- **Desktop** — the scope can be produced by a Playwright **connector** in this
  repo (the heavy flow, run via the Data Connect desktop app). Derived from the
  connector manifests + `registry.json`.
- **Connectors** — the exact connector id(s) that fulfill the scope, with status.
  A scope may be served by more than one connector.

> A request for a scope marked Desktop-only (e.g. `instagram.ads`) cannot be
> satisfied by the web flow alone — the Personal Server will have no data for it.
> That is the exact web-vs-desktop scope mismatch this registry exists to make
> explicit.

## Coverage

| Source | Scope | Web | Desktop | Connector(s) |
|---|---|:--:|:--:|---|
| amazon | `amazon.orders` | — | ✅ | amazon-playwright (beta) |
| amazon | `amazon.profile` | — | ✅ | amazon-playwright (beta) |
| chatgpt | `chatgpt.conversations` | — | ✅ | chatgpt-playwright (stable) |
| chatgpt | `chatgpt.memories` | — | ✅ | chatgpt-playwright (stable) |
| claude | `claude.conversations` | — | ✅ | claude-playwright (experimental) |
| claude | `claude.projects` | — | ✅ | claude-playwright (experimental) |
| doordash | `doordash.orders` | — | ✅ | doordash-playwright (beta) |
| github | `github.profile` | ✅ | ✅ | github-playwright (stable) |
| github | `github.repositories` | — | ✅ | github-playwright (stable) |
| github | `github.starred` | — | ✅ | github-playwright (stable) |
| heb | `heb.nutrition` | — | ✅ | heb-playwright (experimental) |
| heb | `heb.orders` | — | ✅ | heb-playwright (experimental) |
| heb | `heb.profile` | — | ✅ | heb-playwright (experimental) |
| icloud_notes | `icloud_notes.folders` | — | ✅ | icloud-notes-playwright (experimental) |
| icloud_notes | `icloud_notes.notes` | — | ✅ | icloud-notes-playwright (experimental) |
| instagram | `instagram.ads` | — | ✅ | instagram-ads-playwright (beta); instagram-playwright (stable) |
| instagram | `instagram.following` | — | ✅ | instagram-playwright (stable) |
| instagram | `instagram.posts` | ✅ ¹ | ✅ | instagram-playwright (stable) |
| instagram | `instagram.profile` | ✅ | ✅ | instagram-playwright (stable) |
| linkedin | `linkedin.connections` | — | ✅ | linkedin-playwright (stable) |
| linkedin | `linkedin.education` | — | ✅ | linkedin-playwright (stable) |
| linkedin | `linkedin.experience` | — | ✅ | linkedin-playwright (stable) |
| linkedin | `linkedin.languages` | — | ✅ | linkedin-playwright (stable) |
| linkedin | `linkedin.profile` | ✅ | ✅ | linkedin-playwright (stable) |
| linkedin | `linkedin.skills` | — | ✅ | linkedin-playwright (stable) |
| oura | `oura.activity` | — | ✅ | oura-playwright (stable) |
| oura | `oura.readiness` | — | ✅ | oura-playwright (stable) |
| oura | `oura.sleep` | — | ✅ | oura-playwright (stable) |
| shop | `shop.orders` | — | ✅ | shop-playwright (beta) |
| spotify | `spotify.playlists` | — | ✅ | spotify-playwright (stable) |
| spotify | `spotify.profile` | ✅ | ✅ | spotify-playwright (stable) |
| spotify | `spotify.savedTracks` | — | ✅ | spotify-playwright (stable) |
| steam | `steam.friends` | — | ✅ | steam-playwright (experimental) |
| steam | `steam.games` | — | ✅ | steam-playwright (experimental) |
| steam | `steam.profile` | — | ✅ | steam-playwright (experimental) |
| uber | `uber.receipts` | — | ✅ | uber-playwright (beta) |
| uber | `uber.trips` | — | ✅ | uber-playwright (beta) |
| wholefoods | `wholefoods.nutrition` | — | ✅ | wholefoods-playwright (experimental) |
| wholefoods | `wholefoods.orders` | — | ✅ | wholefoods-playwright (experimental) |
| wholefoods | `wholefoods.profile` | — | ✅ | wholefoods-playwright (experimental) |
| youtube | `youtube.history` | — | ✅ | youtube-playwright (beta) |
| youtube | `youtube.likes` | — | ✅ | youtube-playwright (beta) |
| youtube | `youtube.playlistItems` | — | ✅ | youtube-playwright (beta) |
| youtube | `youtube.playlists` | — | ✅ | youtube-playwright (beta) |
| youtube | `youtube.profile` | ✅ | ✅ | youtube-playwright (beta) |
| youtube | `youtube.subscriptions` | — | ✅ | youtube-playwright (beta) |
| youtube | `youtube.watchLater` | — | ✅ | youtube-playwright (beta) |

¹ **`instagram.posts` on Web is capped at the 150 most recent posts.** The Data
Pipe API web flow returns at most 150 posts; for a complete post history use the
Desktop connector (`instagram-playwright`), which has no such limit.

## Maintaining this file

- **A connector adds/removes a scope** → update the Desktop rows + Connector(s)
  column for that source.
- **The Data Pipe API gains a web-fulfillable scope** → flip its **Web** cell to
  ✅. Keep `unity-surfaces` `web-writable-scopes.ts` consistent with the Web
  column by hand (the web app changes infrequently enough that this is fine).
