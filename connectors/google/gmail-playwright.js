/**
 * Gmail Receipts Connector (Playwright)
 *
 * Exports the 100 most recent Gmail rows matching purchases, flights, or
 * tickets. Google authentication is always completed by the user in a visible
 * browser; credentials and message data remain in the local connector runtime.
 *
 * Extraction method: authenticated Gmail search + DOM extraction.
 */

const PLATFORM = "gmail";
const VERSION = "1.0.0-playwright";
const SCOPE = "gmail.receipts";
const CANONICAL_SCOPES = [SCOPE];
const MAX_MESSAGES = 100;
const MAX_PAGES = 10;
const SEARCH_URL =
  "https://mail.google.com/mail/u/0/#search/category%3Apurchases+OR+flight+OR+ticket";

const makeConnectorError = (
  errorClass,
  reason,
  disposition,
  extras = {},
) => ({
  errorClass,
  reason,
  disposition,
  ...extras,
});

const makeFatalRunError = (errorClass, reason, phase = "collect") => {
  const error = new Error(reason);
  error.telemetryError = makeConnectorError(errorClass, reason, "fatal", {
    phase,
  });
  return error;
};

const inferErrorClass = (message, fallback = "runtime_error") => {
  const text = String(message || "").toLowerCase();
  if (text.includes("auth") || text.includes("login")) return "auth_failed";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("navigate") || text.includes("navigation")) {
    return "navigation_error";
  }
  if (text.includes("selector") || text.includes("message row")) {
    return "selector_error";
  }
  return fallback;
};

const buildResult = ({ requestedScopes, messages, errors }) => {
  const result = {
    requestedScopes: [...requestedScopes],
    timestamp: new Date().toISOString(),
    version: VERSION,
    platform: PLATFORM,
    exportSummary: {
      count: messages?.length || 0,
      label: messages?.length === 1 ? "message" : "messages",
      details: {
        messages: messages?.length || 0,
        limit: MAX_MESSAGES,
        query: "category:purchases OR flight OR ticket",
      },
    },
    errors,
  };

  if (Array.isArray(messages) && requestedScopes.includes(SCOPE)) {
    Object.assign(result, { "gmail.receipts": messages });
  }

  return result;
};

const resolveRequestedScopes = () => {
  const raw =
    typeof page.requestedScopes === "function" ? page.requestedScopes() : null;

  if (raw == null) return [...CANONICAL_SCOPES];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw makeFatalRunError(
      "protocol_violation",
      "Gmail connector received an empty or invalid requestedScopes array.",
      "init",
    );
  }

  const deduped = Array.from(new Set(raw));
  const unsupported = deduped.filter(
    (scope) => !CANONICAL_SCOPES.includes(scope),
  );
  if (unsupported.length > 0) {
    throw makeFatalRunError(
      "protocol_violation",
      `Gmail connector received unsupported requestedScopes: ${unsupported.join(", ")}.`,
      "init",
    );
  }

  return deduped;
};

const safeGoto = async (url, attempts = 3) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { timeout: 60000 });
      return true;
    } catch (_error) {
      if (attempt < attempts) await page.sleep(1500);
    }
  }
  return false;
};

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        if (window.location.hostname !== 'mail.google.com') return false;
        if (document.querySelector('input[type="password"]')) return false;
        return !!document.querySelector(
          '[aria-label="Search mail"], [role="main"]'
        );
      })()
    `);
  } catch (_error) {
    return false;
  }
};

const inspectSearchState = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const main = document.querySelector('[role="main"]');
        const rowSelector =
          'tr[data-legacy-thread-id], tr[data-thread-id]';
        const rows = main ? main.querySelectorAll(rowSelector) : [];
        const text = (main?.innerText || '').replace(/\\s+/g, ' ').trim();
        const empty = /no (?:emails|messages).*match|no conversations in this view/i.test(text);
        return {
          authenticated: window.location.hostname === 'mail.google.com' &&
            !!document.querySelector('[aria-label="Search mail"], [role="main"]'),
          rowCount: rows.length,
          empty,
        };
      })()
    `);
  } catch (_error) {
    return { authenticated: false, rowCount: 0, empty: false };
  }
};

const waitForSearchResults = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await inspectSearchState();
    if (state.rowCount > 0 || state.empty) return state;
    await page.sleep(1000);
  }
  return inspectSearchState();
};

const extractVisibleMessages = async () => {
  try {
    const value = await page.evaluate(`
      (() => {
        const clean = (value) => String(value || '')
          .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
          .replace(/\\s+/g, ' ')
          .trim();

        const fallbackId = (parts) => {
          const input = parts.join('\\u001f');
          let hash = 0x811c9dc5;
          for (let index = 0; index < input.length; index += 1) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
          }
          return 'gmail-' + (hash >>> 0).toString(16).padStart(8, '0');
        };

        const main = document.querySelector('[role="main"]');
        if (!main) return { messages: [], hasNext: false, selectorFound: false };

        let rows = Array.from(main.querySelectorAll(
          'tr[data-legacy-thread-id], tr[data-thread-id]'
        ));

        // Some Gmail rollouts omit thread attributes. Restrict the fallback to
        // table rows containing Gmail's semantic sender email attribute.
        if (rows.length === 0) {
          rows = Array.from(main.querySelectorAll('tr')).filter(
            (row) => row.querySelector('[email]')
          );
        }

        const messages = rows.map((row, rowIndex) => {
          try {
            const senderNode = row.querySelector('[email]');
            const senderName = clean(
              senderNode?.getAttribute('name') || senderNode?.textContent
            );
            const senderEmail = clean(senderNode?.getAttribute('email'));
            const sender = senderName && senderEmail &&
              senderName.toLowerCase() !== senderEmail.toLowerCase()
              ? senderName + ' <' + senderEmail + '>'
              : (senderName || senderEmail);

            // Gmail does not expose semantic subject/snippet attributes. These
            // short class names are used only after the stable row/sender gate,
            // with structural fallbacks for alternate rollouts.
            const subjectNode = row.querySelector('.bog') ||
              row.querySelector('[data-subject]') ||
              Array.from(row.querySelectorAll('span')).find((span) => {
                const candidate = clean(span.textContent);
                return candidate && span !== senderNode && candidate.length > 2;
              });
            const snippetNode = row.querySelector('.y2') ||
              row.querySelector('[data-snippet]');
            const dateNode = row.querySelector(
              'td.xW [title], td.xW time, td.xW span, ' +
              'td:last-of-type [title], td:last-of-type time, td:last-of-type span'
            );

            const subject = clean(
              subjectNode?.getAttribute('data-subject') || subjectNode?.textContent
            );
            const snippet = clean(
              snippetNode?.getAttribute('data-snippet') || snippetNode?.textContent
            ).replace(/^[-–—]\\s*/, '');
            const date = clean(
              dateNode?.getAttribute('title') ||
              dateNode?.getAttribute('datetime') ||
              dateNode?.textContent
            );

            const id = clean(
              row.getAttribute('data-legacy-last-message-id') ||
              row.getAttribute('data-legacy-thread-id') ||
              row.getAttribute('data-thread-id') ||
              row.id
            ) || fallbackId([date, sender, subject, snippet, String(rowIndex)]);

            return { id, date, sender, subject, snippet };
          } catch (_error) {
            return null;
          }
        }).filter(Boolean);

        const next = Array.from(document.querySelectorAll(
          '[aria-label="Older"], [aria-label="Next page"], ' +
          '[data-tooltip="Older"], [data-tooltip="Next page"]'
        )).find((element) => {
          const disabled = element.getAttribute('aria-disabled') === 'true' ||
            element.hasAttribute('disabled');
          const visible = !!(element.offsetWidth || element.offsetHeight ||
            element.getClientRects().length);
          return visible && !disabled;
        });

        return {
          messages,
          hasNext: !!next,
          selectorFound: rows.length > 0,
          firstId: messages[0]?.id || '',
        };
      })()
    `);

    return value || {
      messages: [],
      hasNext: false,
      selectorFound: false,
      firstId: "",
    };
  } catch (_error) {
    return {
      messages: [],
      hasNext: false,
      selectorFound: false,
      firstId: "",
    };
  }
};

const clickNextPage = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const next = Array.from(document.querySelectorAll(
          '[aria-label="Older"], [aria-label="Next page"], ' +
          '[data-tooltip="Older"], [data-tooltip="Next page"]'
        )).find((element) => {
          const disabled = element.getAttribute('aria-disabled') === 'true' ||
            element.hasAttribute('disabled');
          const visible = !!(element.offsetWidth || element.offsetHeight ||
            element.getClientRects().length);
          return visible && !disabled;
        });
        if (!next) return false;
        next.click();
        return true;
      })()
    `);
  } catch (_error) {
    return false;
  }
};

const waitForPageChange = async (previousFirstId) => {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await page.sleep(1000);
    const current = await extractVisibleMessages();
    if (current.firstId && current.firstId !== previousFirstId) return true;
  }
  return false;
};

const collectMessages = async () => {
  const messages = [];
  const seenIds = new Set();
  let paginationFailed = false;
  let selectorFound = false;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const pageData = await extractVisibleMessages();
    selectorFound = selectorFound || pageData.selectorFound;

    for (const message of pageData.messages || []) {
      if (!message?.id || seenIds.has(message.id)) continue;
      seenIds.add(message.id);
      messages.push(message);
      if (messages.length >= MAX_MESSAGES) break;
    }

    await page.setProgress({
      phase: { step: 2, total: 2, label: "Collecting confirmations" },
      message: `Collected ${messages.length} of up to ${MAX_MESSAGES} messages...`,
      count: messages.length,
    });

    if (messages.length >= MAX_MESSAGES || !pageData.hasNext) break;
    if (!(await clickNextPage())) {
      paginationFailed = true;
      break;
    }
    if (!(await waitForPageChange(pageData.firstId))) {
      paginationFailed = true;
      break;
    }
    await page.sleep(500);
  }

  return {
    messages: messages.slice(0, MAX_MESSAGES),
    paginationFailed,
    selectorFound,
  };
};

(async () => {
  let requestedScopes = [...CANONICAL_SCOPES];

  try {
    requestedScopes = resolveRequestedScopes();

    await page.setProgress({
      phase: { step: 1, total: 2, label: "Signing in" },
      message: "Checking your saved Gmail session...",
    });

    if (!(await safeGoto(SEARCH_URL))) {
      throw makeFatalRunError(
        "navigation_error",
        "Could not reach Gmail after multiple attempts.",
        "auth",
      );
    }
    await page.sleep(2500);

    let loggedIn = await checkLoginStatus();
    if (!loggedIn) {
      const browserResult = await page.showBrowser(SEARCH_URL);
      if (!browserResult?.headed) {
        throw makeFatalRunError(
          "auth_failed",
          "Gmail login requires a visible browser session.",
          "auth",
        );
      }

      await page.setData(
        "status",
        "Sign in to Google in the browser. Your credentials remain on this device.",
      );
      await page.promptUser(
        "Complete Google sign-in, including any two-factor verification. Continue when Gmail is open.",
        async () => await checkLoginStatus(),
        2000,
      );
      loggedIn = await checkLoginStatus();
    }

    if (!loggedIn) {
      throw makeFatalRunError(
        "auth_failed",
        "Gmail login could not be confirmed.",
        "auth",
      );
    }

    await page.goHeadless();
    if (!(await safeGoto(SEARCH_URL))) {
      throw makeFatalRunError(
        "navigation_error",
        "Gmail opened, but the purchase and travel search could not be loaded.",
      );
    }

    await page.setProgress({
      phase: { step: 2, total: 2, label: "Collecting confirmations" },
      message: "Loading purchase and travel confirmation messages...",
      count: 0,
    });

    const searchState = await waitForSearchResults();
    if (!searchState.authenticated) {
      throw makeFatalRunError(
        "auth_failed",
        "The Gmail session expired before collection completed.",
        "collect",
      );
    }

    if (searchState.empty) {
      const result = buildResult({ requestedScopes, messages: [], errors: [] });
      await page.setData("result", result);
      await page.setData("status", "Complete! No matching Gmail messages found.");
      return result;
    }

    const collection = await collectMessages();
    const errors = [];

    if (!collection.selectorFound && collection.messages.length === 0) {
      errors.push(
        makeConnectorError(
          "selector_error",
          "Gmail loaded, but no recognizable message rows were found.",
          "omitted",
          { scope: SCOPE, phase: "collect" },
        ),
      );
    } else if (collection.paginationFailed) {
      errors.push(
        makeConnectorError(
          "navigation_error",
          "Gmail pagination stopped before all available matching rows could be read.",
          "degraded",
          { scope: SCOPE, phase: "collect" },
        ),
      );
    }

    const producedMessages = collection.selectorFound
      ? collection.messages
      : null;
    const result = buildResult({
      requestedScopes,
      messages: producedMessages,
      errors,
    });

    await page.setData("result", result);
    await page.setData(
      "status",
      `Complete! Exported ${collection.messages.length} Gmail messages.`,
    );
    return result;
  } catch (error) {
    const telemetryError =
      error?.telemetryError ||
      makeConnectorError(
        inferErrorClass(error?.message || String(error)),
        error?.message || String(error),
        "fatal",
        { phase: "collect" },
      );
    const result = buildResult({
      requestedScopes,
      messages: null,
      errors: [telemetryError],
    });
    await page.setData("result", result);
    await page.setData("error", telemetryError.reason);
    return result;
  }
})();
