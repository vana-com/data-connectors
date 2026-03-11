# Data Extraction Patterns

Three extraction rungs, tried in order. Start at Rung 1. If it fails within 2 attempts, move to the next rung.

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

**When to move on to Rung 2:**
- `fetch()` returns 401/403 with `credentials: 'include'`
- Response is HTML (login page redirect) instead of JSON
- CORS error in browser console ("Failed to fetch", "blocked by CORS policy")
- Auth token not found in cookies, localStorage, sessionStorage, or page source

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

**The most reliable rung.** Navigate to pages and extract data from the rendered DOM. If data is visible in the browser, it can be scraped. Works regardless of auth mechanism, including WebSocket-based SPAs (Linear, Notion, Figma).
**Example:** GitHub, Linear

### Selector strategy (critical):

**DO use:**
- Tag structure: `main > section`, `h2`, `p`
- ARIA roles: `[role="main"]`, `[aria-label*="repositories"]`
- Data attributes: `[data-testid="profile-name"]`, `[itemprop="name"]`
- Semantic HTML: `nav`, `article`, `header`, `aside`
- Text content matching via JS

**DO NOT use:**
- Obfuscated class names: `.x1lliihq`, `.css-1dbjc4n`
- Frequently-changing class names: `.feed-shared-update-v2__description`
- Framework-generated IDs: `#react-root-0-3-1`

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
