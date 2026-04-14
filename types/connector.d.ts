/**
 * DataConnect Connector Type Definitions
 *
 * These types define the page API available to connector scripts.
 * The runner implementation lives in data-connect/playwright-runner/index.cjs.
 *
 * ## Versioning
 *
 * The major version of this contract is exported as `PAGE_API_VERSION` from
 * `types/page-api-version.ts`. Within a major version, additions are allowed
 * but removals and renames are not. Breaking changes require a bump of the
 * constant and a matching bump of the `page_api_version` field in connector
 * manifests.
 */

/** Major version of the page API contract. */
export type PageApiVersion = 1;

/** Result from page.showBrowser() */
export interface ShowBrowserResult {
  /** Whether the browser actually switched to headed mode */
  headed: boolean;
}

/** Options for page.goto() */
export interface GotoOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

/** Options for page.httpFetch() */
export interface HttpFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

/** Result from page.httpFetch() */
export interface HttpFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown | null;
  error: string | null;
}

/** Options for page.click() / page.fill() / page.press() */
export interface ElementActionOptions {
  timeout?: number;
  force?: boolean;
  delay?: number;
}

/** Options for page.waitForSelector() */
export interface WaitForSelectorOptions {
  timeout?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

/** Network capture configuration */
export interface NetworkCaptureConfig {
  key: string;
  urlPattern?: string;
  bodyPattern?: string;
}

/** Structured progress update */
export interface ProgressUpdate {
  phase?: { step: number; total: number; label?: string };
  message?: string;
  count?: number;
}

/** Payload for page.requestInput() */
export interface RequestInputPayload {
  /** Human-readable message describing what data is needed */
  message: string;
  /** JSON Schema describing the expected response shape (optional) */
  schema?: Record<string, unknown>;
}

/**
 * Page API injected into connector scripts.
 *
 * Available as the global `page` object. All methods are async.
 */
export interface PageAPI {
  /** Run JavaScript in the browser page context and return the result */
  evaluate(script: string): Promise<unknown>;

  /** Take a JPEG screenshot of the current page, returned as a base64 string */
  screenshot(): Promise<string>;

  /**
   * Request data from the driver (e.g., login credentials, 2FA codes).
   * The runner relays the request to the driver and resolves with the response.
   * Throws if the driver sends an error (e.g., user cancelled).
   */
  requestInput(payload: RequestInputPayload): Promise<Record<string, unknown>>;

  /** Navigate to a URL */
  goto(url: string, options?: GotoOptions): Promise<void>;

  /** Return the URL of the current page. */
  url(): Promise<string>;

  /** Click the first element matching the selector. */
  click(selector: string, options?: ElementActionOptions): Promise<void>;

  /** Fill the first input/textarea matching the selector with the given value. */
  fill(selector: string, value: string, options?: ElementActionOptions): Promise<void>;

  /**
   * Focus the first element matching the selector and press a key
   * (e.g. "Enter", "ArrowDown", "Control+A").
   */
  press(selector: string, key: string, options?: ElementActionOptions): Promise<void>;

  /** Wait for an element matching the selector to reach the requested state. */
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void>;

  /** Wait for a number of milliseconds */
  sleep(ms: number): Promise<void>;

  /** Send a key-value pair to the host. Use 'status' for log messages, 'error' for errors. */
  setData(key: string, value: unknown): Promise<void>;

  /** Send a structured progress update to drive the frontend progress UI */
  setProgress(update: ProgressUpdate): Promise<void>;

  /**
   * Escalate to headed mode for live human interaction (e.g., interactive CAPTCHAs).
   * Returns { headed: false } if the driver doesn't support headed mode.
   */
  showBrowser(url?: string): Promise<ShowBrowserResult>;

  /** Switch to headless mode. No-op if already headless. */
  goHeadless(): Promise<void>;

  /**
   * Poll a check function until it returns truthy.
   * Sends WAITING_FOR_USER status to the host.
   */
  promptUser(message: string, checkFn: () => Promise<unknown>, interval?: number): Promise<void>;

  /** Register a network response capture */
  captureNetwork(config: NetworkCaptureConfig): Promise<void>;

  /** Get a previously captured network response, or null */
  getCapturedResponse(key: string): Promise<{ url: string; data: unknown; timestamp: number } | null>;

  /** Check if a network response has been captured */
  hasCapturedResponse(key: string): boolean;

  /** Clear all network captures */
  clearNetworkCaptures(): Promise<void>;

  /** Close the browser but keep the process alive for httpFetch() calls */
  closeBrowser(): Promise<void>;

  /**
   * Make an HTTP request from Node.js with cookies auto-injected from the browser session.
   * Works after closeBrowser().
   */
  httpFetch(url: string, options?: HttpFetchOptions): Promise<HttpFetchResult>;
}

declare global {
  /** The page API available to connector scripts */
  const page: PageAPI;
}

export {};
