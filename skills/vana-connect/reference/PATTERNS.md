# Data Extraction Patterns

## Choosing an approach

Research the platform first. The right extraction strategy depends on the platform's auth model and what's easiest for a normal (non-technical) user. Consider:

- **Does the user already have a browser session?** Most do. Browser login → extract data is the most natural UX. The user just logs in like they normally would.
- **Does the platform offer API keys or personal tokens?** Some users will prefer this (quick, no browser), but many won't know what an API key is. If you use this approach, guide the user clearly.
- **Is the platform's API on the same origin as the app?** If yes, in-page fetch works. If not (CORS), use `closeBrowser()` + `httpFetch()` to make requests from Node.js with extracted cookies.
- **Does the platform only render data in the DOM (no usable API)?** DOM extraction always works as a last resort.

There is no fixed ordering. Pick the approach that gives the best user experience for the specific platform. You can combine approaches (e.g., browser login for auth + httpFetch for data extraction).

### Available tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `page.evaluate(js)` | Run JS in the browser page | In-page fetch, DOM extraction, login detection |
| `page.closeBrowser()` | Close browser, extract session cookies | Before switching to httpFetch |
| `page.httpFetch(url, opts)` | Node.js HTTP with auto-injected cookies | Cross-origin APIs (bypasses CORS), API key auth |
| `page.captureNetwork(...)` | Intercept network responses | Platforms that load data during page bootstrap |
| `page.requestInput(...)` | Ask user for structured input | Credentials, API keys, 2FA codes |

### API key auth pattern

If the platform supports API keys and that's the best UX for the user:

```javascript
let apiKey = process.env.API_KEY_PLATFORMNAME || '';
if (!apiKey) {
  const input = await page.requestInput({
    message: 'Enter your Platform API key (find it at Settings → API)',
    schema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', title: 'API Key' }
      },
      required: ['apiKey']
    }
  });
  apiKey = input.apiKey;
}

await page.closeBrowser();
const resp = await page.httpFetch('https://api.platform.com/v1/me', {
  headers: { Authorization: 'Bearer ' + apiKey }
});
```

### Browser login + httpFetch pattern

If the user should log in via browser and the API is cross-origin:

```javascript
// 1. Navigate to login page, wait for user to log in
await page.goto('https://platform.com/login');
// ... login detection logic ...

// 2. Close browser — cookies are extracted automatically
await page.closeBrowser();

// 3. Make API calls from Node.js with session cookies (no CORS)
const resp = await page.httpFetch('https://api.platform.com/v1/me');
```

---

## Extraction Ladder

If you're unsure which approach works, try each rung. Max 2 attempts per rung before moving on.

## Rung 1: In-Page Fetch

**Try first.** Use `fetch()` or `XMLHttpRequest` from `page.evaluate()` to call the platform's API with the browser's existing session cookies.
**Example:** LinkedIn, ChatGPT, Spotify

### How to discover APIs:
1. Open the platform in Chrome
2. Open DevTools > Network tab
3. Filter by XHR/Fetch
4. Browse the platform — watch for JSON responses
5. Note the endpoint URLs, required headers, auth mechanisms

### Implementation — API fetch helper:

```javascript
const fetchApi = async (endpoint) => {
  const endpointStr = JSON.stringify(endpoint);
  try {
    return await page.evaluate(`
      (async () => {
        try {
          // Get CSRF token from cookies (platform-specific)
          const csrfToken = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
          const resp = await fetch(${endpointStr}, {
            headers: { 'csrf-token': csrfToken },
            credentials: 'include'
          });
          if (!resp.ok) return { _error: resp.status };
          return await resp.json();
        } catch(e) { return { _error: e.message }; }
      })()
    `);
  } catch (e) {
    return { _error: e.message || String(e) };
  }
};

// Usage
const data = await fetchApi('/api/v1/me');
if (data._error) {
  await page.setData('error', 'API failed: ' + data._error);
  return;
}
```

### Auth token extraction (ChatGPT pattern):

Some platforms embed auth tokens in the page source:

```javascript
const token = await page.evaluate(`
  (() => {
    try {
      // Look for auth tokens in script tags
      const bootstrapEl = document.getElementById('client-bootstrap');
      if (bootstrapEl) {
        const data = JSON.parse(bootstrapEl.textContent);
        return data.accessToken || null;
      }
      return null;
    } catch { return null; }
  })()
`);

// Use token in API calls
const tokenStr = JSON.stringify(token);
const data = await page.evaluate(`
  (async () => {
    const resp = await fetch('/backend-api/conversations', {
      headers: { 'Authorization': 'Bearer ' + ${tokenStr} }
    });
    return await resp.json();
  })()
`);
```

**When to move on:**
- `fetch()` returns 401/403 with `credentials: 'include'`
- Response is HTML (login page redirect) instead of JSON
- CORS error in browser console ("Failed to fetch", "blocked by CORS policy")
- Auth token not found in cookies, localStorage, sessionStorage, or page source

**CORS workaround — try `httpFetch` before Rung 2:** If Rung 1 fails due to CORS (the API is on a different origin from the app), try `page.closeBrowser()` + `page.httpFetch()`. This extracts session cookies from the browser and makes Node.js-side requests — no CORS. Only move to Rung 2 if `httpFetch` also fails (e.g., cookies are TLS-bound or the server rejects non-browser requests).

```javascript
// After login is confirmed:
await page.closeBrowser();  // extracts cookies

const resp = await page.httpFetch('https://api.platform.com/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '{ viewer { id name } }' }),
});
if (resp.ok && resp.json) {
  // httpFetch works — use it for all data collection
}
```

### Parallel API calls:

```javascript
const [profileData, positionsData] = await Promise.all([
  fetchApi('/api/profile'),
  fetchApi('/api/positions'),
]);
```

### Paginated API calls:

```javascript
const allItems = [];
let offset = 0;
const limit = 50;

while (true) {
  await page.setProgress({
    phase: { step: 2, total: 3, label: 'Fetching items' },
    message: `Fetched ${allItems.length} items so far...`,
    count: allItems.length,
  });

  const data = await fetchApi(`/api/items?offset=${offset}&limit=${limit}`);
  if (data._error) break;

  const items = data.elements || [];
  allItems.push(...items);

  if (items.length < limit) break; // last page
  offset += limit;
  await page.sleep(500); // rate limiting
}
```

---

## Rung 2: Network Capture

**Try if Rung 1 failed.** Register `captureNetwork` *before* navigating to intercept API responses during page bootstrap, before the app switches to WebSocket or other transports.
**Example:** Instagram, Twitter/X

### Implementation:

```javascript
// 1. Register capture BEFORE navigating
await page.captureNetwork({
  urlPattern: 'instagram.com/graphql/query',   // URL substring to match
  bodyPattern: 'PolarisProfilePage',            // Response body substring
  key: 'profile_data'                           // Key for retrieval
});

// 2. Navigate to trigger the request
await page.goto('https://www.instagram.com/username/');
await page.sleep(3000); // wait for requests to fire

// 3. Retrieve captured response
const response = await page.getCapturedResponse('profile_data');
if (response) {
  const user = response.data?.user;
  // Process user data...
}
```

### Multiple captures:

```javascript
// Register multiple captures
await page.captureNetwork({
  urlPattern: '/graphql',
  bodyPattern: 'UserProfile',
  key: 'user'
});
await page.captureNetwork({
  urlPattern: '/graphql',
  bodyPattern: 'UserMedia',
  key: 'media'
});

await page.goto('https://platform.com/profile');
await page.sleep(3000);

const userResp = await page.getCapturedResponse('user');
const mediaResp = await page.getCapturedResponse('media');
```

**When to move on to Rung 3:**
- `getCapturedResponse()` returns null after navigation + 5s wait
- Captured data is not useful (only static config, not user data)
- Platform uses a query allowlist (captured credentials can't make arbitrary API calls)

---

## Rung 3: DOM Extraction

**The most reliable rung.** Navigate to pages and extract data from the rendered DOM. If data is visible in the browser, it can be scraped. Works regardless of auth mechanism, including WebSocket-based SPAs.

### Selector strategy (critical):

Use ARIA roles, data attributes, semantic HTML, and tag structure for selectors. The validator flags obfuscated class names.

- Tag structure: `main > section`, `h2`, `p`
- ARIA roles: `[role="main"]`, `[aria-label*="repositories"]`
- Data attributes: `[data-testid="profile-name"]`, `[itemprop="name"]`
- Semantic HTML: `nav`, `article`, `header`, `aside`
- Text content matching via JS

### Implementation:

```javascript
const profileData = await page.evaluate(`
  (() => {
    // Use stable selectors
    const name = (document.querySelector('span[itemprop="name"]')?.textContent || '').trim();
    const bio = (document.querySelector('div[data-bio-text]')?.textContent || '').trim();

    // Use structural selectors as fallback
    const stats = document.querySelectorAll('nav a span');
    const followers = stats.length > 0 ? stats[0]?.textContent?.trim() : '';

    return { name, bio, followers };
  })()
`);
```

### Pagination via DOM:

```javascript
const allItems = [];
let pageNum = 1;
const maxPages = 20;

while (pageNum <= maxPages) {
  await page.goto(`https://platform.com/items?page=${pageNum}`);
  await page.sleep(1500);

  const items = await page.evaluate(`
    (() => {
      const rows = document.querySelectorAll('[data-testid="item-row"]');
      return Array.from(rows).map(row => ({
        title: (row.querySelector('h3')?.textContent || '').trim(),
        url: row.querySelector('a')?.href || '',
      }));
    })()
  `);

  if (!items || items.length === 0) break;
  allItems.push(...items);

  // Check for next page
  const hasNext = await page.evaluate(`!!document.querySelector('a[rel="next"]')`);
  if (!hasNext) break;

  pageNum++;
  await page.sleep(500);
}
```

---

## Putting It Together: The Extraction Ladder

When building a new connector, try each rung in order. A single test call tells you whether to continue or move on.

```javascript
// Rung 1: try in-page fetch
const probe = await page.evaluate(`
  (async () => {
    try {
      const r = await fetch('/api/v1/me', { credentials: 'include' });
      if (!r.ok) return { _failed: true, status: r.status };
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) return { _failed: true, reason: 'not-json' };
      return await r.json();
    } catch(e) { return { _failed: true, error: e.message }; }
  })()
`);

if (!probe._failed) {
  // Rung 1 works -- use fetchApi pattern for all data collection
} else {
  // Rung 1 failed -- go to Rung 2 or 3

  // Rung 2: captureNetwork (must be set up BEFORE navigating)
  await page.captureNetwork({ key: 'api', urlPattern: 'api.platform.com' });
  await page.goto('https://platform.com/dashboard');
  await page.sleep(5000);
  const captured = await page.getCapturedResponse('api');

  if (captured && captured.data) {
    // Rung 2 works -- use network capture pattern
  } else {
    // Rung 3: DOM extraction -- always works
    const data = await page.evaluate(`
      (() => {
        // Read data from the rendered page
        const items = document.querySelectorAll('[data-testid="item"]');
        return Array.from(items).map(el => ({
          title: (el.querySelector('h3')?.textContent || '').trim(),
          // ...
        }));
      })()
    `);
  }
}
```

---

## Platform Characteristics That Affect Strategy

### WebSocket-based SPAs

Some platforms (e.g., real-time collaboration tools, project management apps) load data over **WebSocket** after the initial page render, not via HTTP fetch calls. This has major implications:

- **`captureNetwork` captures nothing** — network capture only intercepts HTTP requests, not WebSocket frames.
- **In-page `fetch()` won't find same-origin API endpoints** — the platform may not have REST/GraphQL endpoints accessible from the browser page context at all.
- **`httpFetch` with extracted cookies often fails** — if the API is behind Cloudflare or similar bot protection, cookies are bound to the browser's TLS context and won't replay from Node.js.

**How to detect:** After login, open DevTools Network tab and filter by WS/WebSocket. If the app loads data over a WebSocket connection rather than XHR/fetch, you're dealing with this pattern.

**What works:** API keys (if the platform offers them) or DOM extraction (Rung 3). The extraction ladder's Rungs 1–2 will fail — recognize the pattern early and skip to what works.

### Cloudflare-protected APIs

Some platforms use Cloudflare (or similar CDN/bot protection) that binds session cookies to the browser's TLS fingerprint. Symptoms:

- Browser login works fine, cookies are extracted successfully
- `httpFetch` with those cookies returns 401/403
- The same cookies work in the browser but not from Node.js

**What works:** In-page `fetch()` (if same-origin), API keys, or DOM extraction. The `closeBrowser()` + `httpFetch()` strategy is non-viable for these platforms.

---

## Common Patterns

### Login detection:

Use URL-based detection as the primary signal. DOM selectors are supplementary.

```javascript
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const path = window.location.pathname;

        // URL-based (primary)
        if (/\\/(login|signin|sign-in|auth|sso|callback)/.test(path)) return false;
        if (path === '/') return false;
        if (!window.location.hostname.includes('PLATFORM_DOMAIN')) return false;

        if (!!document.querySelector('input[type="password"]')) return false;

        // DOM-based (supplementary) -- use a selector specific to the app shell
        // Good: meta[name='user-login'][content], button[data-testid='user-widget-link']
        // Bad: aside, nav, main (too generic, matches marketing pages)
        return !!document.querySelector('LOGGED_IN_SELECTOR');
      })()
    `);
  } catch (e) {
    return false; // navigation in progress (e.g. OAuth redirect)
  }
};
```

### Dismissing popups/modals:

```javascript
// Dismiss cookie banners, upgrade prompts, etc.
await page.evaluate(`
  (() => {
    const dismissSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      '[data-testid="close-button"]',
    ];
    for (const sel of dismissSelectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); break; }
    }
  })()
`);
await page.sleep(500);
```

### Safe text extraction:

```javascript
// Always guard against null/undefined
const getText = (selector) => `(document.querySelector('${selector}')?.textContent || '').trim()`;

const name = await page.evaluate(getText('h1.profile-name'));
```
