# Page API Reference

The `page` object is injected as a global in connector scripts. It is NOT raw Playwright — it's a custom API provided by the DataConnect Playwright runner.

## Methods

### Navigation & Browser Control

#### `page.goto(url)`
Navigate to a URL.
```javascript
await page.goto('https://www.linkedin.com/feed/');
```

#### `page.showBrowser(url?)`
Switch to headed mode (visible browser window). Optionally navigate to a URL.
```javascript
await page.showBrowser('https://platform.com/login');
```

#### `page.goHeadless()`
Switch to headless mode (browser disappears). Call this after login is confirmed, before data extraction.
```javascript
await page.goHeadless();
```

#### `page.closeBrowser()`
Close the browser entirely. Use when you're done with browser interactions but still need the process alive for HTTP work.

#### `page.sleep(ms)`
Wait for a specified number of milliseconds.
```javascript
await page.sleep(2000); // wait 2 seconds
```

### JavaScript Execution

#### `page.evaluate(jsString)`
Execute JavaScript in the browser context and return the result. **Takes a string, not a function.**

To pass variables from the connector scope into the browser context, use `JSON.stringify()`:

```javascript
// Simple evaluation
const title = await page.evaluate(`document.title`);

// With interpolated variables
const endpoint = '/api/me';
const endpointStr = JSON.stringify(endpoint);
const data = await page.evaluate(`
  (async () => {
    const resp = await fetch(${endpointStr}, { credentials: 'include' });
    return await resp.json();
  })()
`);

// DOM inspection
const isLoggedIn = await page.evaluate(`
  (() => {
    return !!document.querySelector('.logged-in-indicator');
  })()
`);
```

### Data Communication

#### `page.setData(key, value)`
Send data to the host app. Three key types:

| Key | Purpose |
|-----|---------|
| `'status'` | Display a status message in the UI |
| `'error'` | Report an error (stops execution) |
| `'result'` | Send the final export result |

```javascript
await page.setData('status', 'Fetching profile...');
await page.setData('error', 'Failed to fetch data: ' + errorMessage);
await page.setData('result', resultObject);
```

#### `page.setProgress({phase, message, count})`
Structured progress reporting for the UI.

```javascript
await page.setProgress({
  phase: { step: 1, total: 3, label: 'Fetching profile' },
  message: 'Downloaded 50 of 200 items...',
  count: 50,
});
```

- `phase.step` / `phase.total` — drives the step indicator ("Step 1 of 3")
- `phase.label` — short label for the current phase
- `message` — human-readable progress text
- `count` — numeric count for progress tracking

### User Interaction

#### `page.promptUser(message, checkFn, pollInterval)`
Show a prompt to the user and poll a check function until it returns truthy.

```javascript
await page.promptUser(
  'Please log in to LinkedIn. Click "Done" when you see your feed.',
  async () => {
    return await checkLoginStatus();
  },
  2000  // poll every 2 seconds
);
```

The prompt displays in the DataConnect UI with a "Done" button. The `checkFn` is called every `pollInterval` ms. When it returns truthy, the prompt is dismissed and execution continues.

### Network Capture

#### `page.captureNetwork({urlPattern, bodyPattern, key})`
Register a network request interceptor. Captures responses matching the criteria.

```javascript
await page.captureNetwork({
  urlPattern: 'instagram.com/graphql/query',  // URL substring match
  bodyPattern: 'User',                         // Response body substring match
  key: 'user_data'                             // Retrieval key
});
```

#### `page.getCapturedResponse(key)`
Retrieve a captured network response. Returns the parsed JSON body or `null`.

```javascript
const response = await page.getCapturedResponse('user_data');
if (response) {
  const userData = response.data.user;
}
```

#### `page.clearNetworkCaptures()`
Clear all registered network captures.

## Important Notes

1. **`page.evaluate()` takes a STRING, not a function.** This is the most common mistake. The string is evaluated in the browser context.

2. **Variable passing:** You cannot use closures. Variables from the connector scope must be serialized:
   ```javascript
   // WRONG — variable not available in browser context
   const url = '/api/data';
   await page.evaluate(`fetch(url)`);

   // CORRECT — interpolate the value
   const url = '/api/data';
   await page.evaluate(`fetch(${JSON.stringify(url)})`);
   ```

3. **Async evaluate:** Wrap async code in an IIFE:
   ```javascript
   const data = await page.evaluate(`
     (async () => {
       const resp = await fetch('/api/data');
       return await resp.json();
     })()
   `);
   ```

4. **Error handling in evaluate:** Always try-catch inside the evaluated string:
   ```javascript
   const result = await page.evaluate(`
     (async () => {
       try {
         const resp = await fetch('/api/data', { credentials: 'include' });
         if (!resp.ok) return { _error: resp.status };
         return await resp.json();
       } catch(e) { return { _error: e.message }; }
     })()
   `);
   ```
