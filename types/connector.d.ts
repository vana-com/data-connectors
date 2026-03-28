/**
 * DataConnect Connector Type Definitions
 *
 * These types define the page API available to connector scripts.
 * The runner implementation lives in data-connect/playwright-runner/index.cjs.
 */

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

/** Payload for page.requestInput() and page.requestData() */
export interface RequestInputPayload {
  /** Human-readable message describing what data is needed */
  message: string;
  /** JSON Schema describing the expected response shape (optional) */
  schema?: Record<string, unknown>;
}

/** Result from page.requestData() or page.requestManualAction() */
export type InteractionResult<T = Record<string, unknown>> =
  | { status: 'success'; data: T }
  | { status: 'skipped'; reason: 'no-input' };

/** Options for page.requestManualAction() */
export interface ManualActionOptions {
  /** URL to navigate the headed browser to */
  url?: string;
  /** Polling interval in ms (default: 2000) */
  interval?: number;
  /** Automatically switch back to headless after action completes (default: true) */
  autoGoHeadless?: boolean;
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
   * Request structured data from the user (credentials, 2FA codes, etc.).
   * Returns { status: 'success', data } or { status: 'skipped', reason: 'no-input' }.
   * Never throws for missing input — the connector decides what to do with a skip.
   */
  requestData(payload: RequestInputPayload): Promise<InteractionResult>;

  /**
   * Request the user to complete a manual action in a headed browser.
   * Opens headed browser, polls checkFn until truthy, goes headless, returns.
   * Returns { status: 'skipped', reason: 'no-input' } in --no-input mode.
   */
  requestManualAction(
    message: string,
    checkFn: () => Promise<unknown>,
    options?: ManualActionOptions,
  ): Promise<InteractionResult<void>>;

  /**
   * @deprecated Use requestData() instead — it returns a result object instead of
   * throwing in --no-input mode, letting the connector handle the skip gracefully.
   */
  requestInput(payload: RequestInputPayload): Promise<Record<string, unknown>>;

  /** Navigate to a URL */
  goto(url: string, options?: GotoOptions): Promise<void>;

  /** Wait for a number of milliseconds */
  sleep(ms: number): Promise<void>;

  /** Send a key-value pair to the host. Use 'status' for log messages, 'error' for errors. */
  setData(key: string, value: unknown): Promise<void>;

  /** Send a structured progress update to drive the frontend progress UI */
  setProgress(update: ProgressUpdate): Promise<void>;

  /**
   * @deprecated Use requestManualAction() instead — it merges showBrowser +
   * promptUser + goHeadless into one call with consistent skip semantics.
   */
  showBrowser(url?: string): Promise<ShowBrowserResult>;

  /**
   * @deprecated Use requestManualAction({ autoGoHeadless: false }) if you need
   * to control headless transitions manually.
   */
  goHeadless(): Promise<void>;

  /**
   * @deprecated Use requestManualAction() instead — promptUser is always used
   * with showBrowser + goHeadless, and requestManualAction handles all three.
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
