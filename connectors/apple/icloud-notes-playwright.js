/**
 * iCloud Notes Connector
 *
 * Authenticates with Apple ID, then uses the CloudKit API directly
 * to fetch all notes with full content via paginated queries.
 *
 * RUNTIME NOTE (for maintainers, not end users): this script depends on
 * CG-runtime-only page methods — getInput, frame_click/fill/evaluate/
 * waitForSelector, keyboard_press/type — and does not yet run under the
 * canonical DataConnect playwright-runner. The manifest's capabilities
 * array advertises this as `cg-legacy-page-api` so runners can reject the
 * connector up front. Runtime convergence is a Phase 4+ follow-up: either
 * rewrite the Apple auth widget flow to use requestInput + the canonical
 * minimum surface, or promote frame_* and keyboard_* into that surface.
 */

// ── Helpers ──────────────────────────────────────────────────────────

// Resilience helpers. See connectors/meta/instagram-playwright.js for
// the rationale — canonical scripts can't import shared modules, so
// these helpers are inlined per connector until the proxy layer exposes
// them natively.
const withTimeout = async (promise, ms, label) => {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const safeGoto = async (url, options = {}) => {
  const { attempts = 3, timeout = 15000, betweenMs = 2000 } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await withTimeout(
        page.goto(url, { timeout }),
        timeout + 5000,
        `goto ${url}`,
      );
      return true;
    } catch (error) {
      const message = error?.message || String(error);
      console.error(
        `[icloud-notes] Navigation attempt ${attempt}/${attempts} failed for ${url}: ${message}`,
      );
      if (attempt < attempts) {
        await page.sleep(betweenMs);
      }
    }
  }
  return false;
};

function decodeBase64(value) {
  if (!value) return null;
  try {
    return atob(value);
  } catch {
    return null;
  }
}

function timestampToISO(ts) {
  if (!ts) return null;
  return new Date(ts).toISOString();
}

async function tryDecompress(bytes, format) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  const chunks = [];
  const readAll = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();

  writer.write(bytes);
  writer.close();
  await readAll;

  const decompressed = new Uint8Array(
    chunks.reduce((acc, c) => acc + c.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    decompressed.set(chunk, offset);
    offset += chunk.length;
  }
  return decompressed;
}

function extractCleanText(decompressedBytes) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const fullText = decoder.decode(decompressedBytes);

  const textRuns = [];
  const runRe = /[\x20-\x7E\u00A0-\uFFFF]{4,}/g;
  let match;
  while ((match = runRe.exec(fullText)) !== null) {
    const run = match[0];
    const cleanCount = (
      run.match(
        /[a-zA-Z0-9 .,;:!?'"()\-\n\r\t\u2018\u2019\u201C\u201D\u2026\u2013\u2014]/g,
      ) || []
    ).length;
    if (cleanCount / run.length > 0.6) {
      textRuns.push(run);
    }
  }

  return textRuns.length > 0 ? textRuns.join("\n") : null;
}

async function extractTextFromProtobuf(base64Data) {
  try {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const formats = ["gzip", "deflate", "deflate-raw"];
    for (const format of formats) {
      try {
        const decompressed = await tryDecompress(bytes, format);
        const text = extractCleanText(decompressed);
        if (text) return text;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Returns { fullName, ckBaseUrl, dsid } or null
const getCloudKitConfig = async () => {
  try {
    return await page.evaluate(`
      (async () => {
        try {
          const resp = await fetch('https://setup.icloud.com/setup/ws/1/validate', {
            method: 'POST',
            credentials: 'include'
          });
          if (!resp.ok) return null;
          const data = await resp.json();
          const fullName = data?.dsInfo?.fullName || null;
          const dsid = data?.dsInfo?.dsid || null;
          const ckBaseUrl = data?.webservices?.ckdatabasews?.url || null;
          if (!fullName || !dsid || !ckBaseUrl) return null;
          return { fullName, dsid: String(dsid), ckBaseUrl };
        } catch { return null; }
      })()
    `);
  } catch {
    return null;
  }
};

// ── Phase 1: Navigate and check login ────────────────────────────────

await page.setData("status", "Launching iCloud...");
const notesReachable = await safeGoto("https://www.icloud.com/notes");
if (!notesReachable) {
  return {
    success: false,
    error: "Could not reach iCloud Notes after multiple attempts.",
  };
}
await page.sleep(5000);

let config = await getCloudKitConfig();
let isLoggedIn = !!config;

// ── Phase 2: Login flow ──────────────────────────────────────────────

if (!isLoggedIn) {
  const APPLE_FRAME = "idmsa.apple.com";

  // Helper: check if Apple auth frame is present
  const findAuthFrame = async () => {
    try {
      return await page.evaluate(`!!document.getElementById('aid-auth-widget-iFrame')`);
    } catch {
      return false;
    }
  };

  const waitForAuthFrame = async (maxWait = 15000) => {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (await findAuthFrame()) return true;
      await page.sleep(1000);
    }
    return false;
  };

  await page.setData("status", "Opening sign in...");
  let hasAuthFrame = await findAuthFrame();

  if (!hasAuthFrame) {
    const clicked = await page.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const signIn = btns.find(el => /^Sign\\s*In$/i.test((el.textContent || '').trim()));
        if (signIn) { signIn.click(); return true; }
        return false;
      })()
    `);
    if (clicked) hasAuthFrame = await waitForAuthFrame(10000);
  }

  if (!hasAuthFrame) {
    await page.setData("status", "Retrying sign in...");
    await safeGoto("https://www.icloud.com/");
    await page.sleep(5000);
    const clicked = await page.evaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const signIn = btns.find(el => /^Sign\\s*In$/i.test((el.textContent || '').trim()));
        if (signIn) { signIn.click(); return true; }
        return false;
      })()
    `);
    if (clicked) hasAuthFrame = await waitForAuthFrame(10000);
  }

  let credentials = null;
  let lastError = null;
  let loginAttempts = 0;

  while (hasAuthFrame && !isLoggedIn && loginAttempts < 3 && typeof page.getInput === 'function') {
    loginAttempts++;

    if (!credentials || lastError) {
      credentials = await page.getInput({
        title: "Sign in to iCloud",
        description: lastError || "Enter your Apple ID to access your notes",
        schema: {
          type: "object",
          required: ["appleId", "password"],
          properties: {
            appleId: { type: "string", title: "Apple ID" },
            password: { type: "string", title: "Password" },
          },
        },
        uiSchema: {
          appleId: {
            "ui:placeholder": "email@example.com",
            "ui:autofocus": true,
          },
          password: { "ui:widget": "password", "ui:placeholder": "Password" },
        },
        submitLabel: "Sign In",
        error: lastError,
      });
    }

    await page.setData("status", "Entering credentials...");

    try {
      await page.frame_waitForSelector(
        APPLE_FRAME,
        'input#account_name_text_field, input[type="email"], input[name="account_name"]',
        { timeout: 10000 },
      );
      await page.frame_fill(
        APPLE_FRAME,
        'input#account_name_text_field, input[type="email"], input[name="account_name"]',
        credentials.appleId,
      );
      await page.sleep(500);
      try {
        await page.frame_click(
          APPLE_FRAME,
          '#sign-in, button[type="submit"], .si-button',
          { timeout: 5000 },
        );
      } catch (e) {
        await page.keyboard_press("Enter");
      }
      await page.sleep(3000);

      await page.frame_waitForSelector(
        APPLE_FRAME,
        'input#password_text_field, input[type="password"], input[name="password"]',
        { timeout: 10000 },
      );
      await page.frame_fill(
        APPLE_FRAME,
        'input#password_text_field, input[type="password"], input[name="password"]',
        credentials.password,
      );
      await page.sleep(500);
      try {
        await page.frame_click(
          APPLE_FRAME,
          '#sign-in, button[type="submit"], .si-button',
          { timeout: 5000 },
        );
      } catch (e) {
        await page.keyboard_press("Enter");
      }

      await page.setData("status", "Authenticating...");
      await page.sleep(10000);
    } catch (e) {
      lastError = `Login form error: ${e.message || String(e)}`;
      continue;
    }

    config = await getCloudKitConfig();
    if (config) {
      isLoggedIn = true;
      break;
    }

    let needs2FA = false;
    try {
      const twoFACheck = await page.frame_evaluate(
        APPLE_FRAME,
        `
        (() => {
          const text = document.body?.innerText || '';
          const hasCodeInput = !!document.querySelector('input[name="security_code"], input.form-textbox-input, input[id*="code"], input[type="tel"]');
          return hasCodeInput || text.includes('Two-Factor') || text.includes('verification code') || text.includes('Verification Code') || text.includes('Enter the code');
        })()
      `,
      );
      needs2FA = !!twoFACheck;
    } catch (e) {
      const stillHasIframe = await page.evaluate(
        `!!document.getElementById('aid-auth-widget-iFrame')`,
      );
      needs2FA = stillHasIframe;
    }

    if (needs2FA) {
      await page.setData("status", "Two-factor authentication required");
      const otpResult = await page.getInput({
        title: "Two-Factor Authentication",
        description:
          "Enter the verification code sent to your trusted device or phone",
        schema: {
          type: "object",
          required: ["code"],
          properties: {
            code: {
              type: "string",
              title: "Verification Code",
              minLength: 6,
              maxLength: 8,
            },
          },
        },
        uiSchema: {
          code: { "ui:placeholder": "000000", "ui:autofocus": true },
        },
        submitLabel: "Verify",
      });

      await page.setData("status", "Verifying code...");
      try {
        await page.frame_fill(
          APPLE_FRAME,
          'input[name="security_code"], input.form-textbox-input, input[id*="code"], input[type="tel"]',
          otpResult.code,
        );
        await page.sleep(1000);
        try {
          await page.frame_click(
            APPLE_FRAME,
            'button[type="submit"], .si-button, button.button-primary',
            { timeout: 5000 },
          );
        } catch (e) {
          await page.keyboard_press("Enter");
        }
      } catch (e) {
        await page.keyboard_type(otpResult.code, { delay: 50 });
        await page.sleep(500);
        await page.keyboard_press("Enter");
      }

      await page.sleep(8000);

      try {
        const trustCheck = await page.frame_evaluate(
          APPLE_FRAME,
          `
          document.body?.innerText?.includes('Trust') || false
        `,
        );
        if (trustCheck) {
          try {
            await page.frame_click(
              APPLE_FRAME,
              'button.button-primary, button[type="submit"]',
              { timeout: 5000 },
            );
          } catch (e) {
            await page.keyboard_press("Enter");
          }
          await page.sleep(5000);
        }
      } catch (e) {}

      config = await getCloudKitConfig();
      if (config) {
        isLoggedIn = true;
        break;
      }
    }

    let errorCheck = null;
    try {
      errorCheck = await page.frame_evaluate(
        APPLE_FRAME,
        `
        (() => {
          const text = document.body?.innerText || '';
          if (text.includes('incorrect') || text.includes('Incorrect')) return 'Incorrect Apple ID or password.';
          if (text.includes('locked') || text.includes('disabled')) return 'This Apple ID has been locked or disabled.';
          return null;
        })()
      `,
      );
    } catch {}
    if (!errorCheck) {
      errorCheck = await page.evaluate(`
        (() => {
          const text = document.body.innerText || '';
          if (text.includes('incorrect') || text.includes('Incorrect')) return 'Incorrect Apple ID or password.';
          if (text.includes('locked') || text.includes('disabled')) return 'This Apple ID has been locked or disabled.';
          return null;
        })()
      `);
    }
    lastError = errorCheck || "Sign in failed. Please check your credentials.";
  }

  if (!isLoggedIn) {
    // Manual login fallback is only available when the runtime can surface
    // a headed browser to the end user. In runtimes like Context Gateway
    // where the remote browser is invisible (showBrowser returns
    // { headed: false }), calling promptUser would either hang indefinitely
    // or throw, so return a clean error instead.
    let canShowHeaded = false;
    if (typeof page.showBrowser === "function") {
      try {
        const result = await page.showBrowser(
          "https://www.icloud.com/notes",
        );
        canShowHeaded = !!(result && result.headed);
      } catch {
        canShowHeaded = false;
      }
    }

    if (canShowHeaded) {
      await page.setData(
        "status",
        "Please sign in manually in the browser below.",
      );
      await page.promptUser(
        "Automatic sign-in failed. Please sign in to your Apple ID manually, including any 2FA. The process will continue automatically once you are signed in.",
        async () => {
          config = await getCloudKitConfig();
          return !!config;
        },
        5000,
      );
      await page.goHeadless();
      isLoggedIn = !!config;
    } else {
      return {
        success: false,
        error: 'Login requires a headed browser or requestInput support.',
      };
    }
  }
}

if (!isLoggedIn || !config) {
  await page.setData("error", "Login failed");
  return { success: false, error: "Could not sign in to iCloud" };
}

const { fullName, dsid, ckBaseUrl } = config;
await page.setData("status", `Signed in as ${fullName}`);

// ── Phase 3: Query folders via CloudKit API ──────────────────────────

await page.setData("status", "Fetching folders...");

const queryUrl = `${ckBaseUrl}/database/1/com.apple.notes/production/private/records/query?dsid=${dsid}`;
const folderMap = {};

const folderResult = await page.evaluate(`
  (async () => {
    try {
      const resp = await fetch(${JSON.stringify(queryUrl)}, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          query: {
            recordType: 'SearchIndexes',
            filterBy: [{
              comparator: 'EQUALS',
              fieldName: 'indexName',
              fieldValue: { value: 'parentless', type: 'STRING' }
            }]
          },
          zoneID: { zoneName: 'Notes' },
          resultsLimit: 200
        })
      });
      if (!resp.ok) return { error: 'folders query failed: ' + resp.status };
      return await resp.json();
    } catch (e) {
      return { error: e.message || String(e) };
    }
  })()
`);

for (const record of folderResult?.records || []) {
  if (record.recordType === "Folder") {
    const title = decodeBase64(record.fields?.TitleEncrypted?.value);
    folderMap[record.recordName] = title || record.recordName;
  }
}

// ── Phase 4: Query all notes with pagination ─────────────────────────

await page.setData("status", "Fetching notes...");

const allNoteRecords = [];
let continuationMarker = null;
let pageNum = 0;

do {
  pageNum++;
  const body = {
    query: {
      recordType: "SearchIndexes",
      filterBy: [
        {
          comparator: "EQUALS",
          fieldName: "indexName",
          fieldValue: { value: "recents", type: "STRING" },
        },
      ],
      sortBy: [{ fieldName: "modTime", ascending: false }],
    },
    zoneID: { zoneName: "Notes" },
    resultsLimit: 200,
  };
  if (continuationMarker) {
    body.continuationMarker = continuationMarker;
  }

  const pageResult = await page.evaluate(`
    (async () => {
      try {
        const resp = await fetch('${queryUrl}', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'text/plain' },
          body: '${JSON.stringify(body).replace(/'/g, "\\'")}'
        });
        if (!resp.ok) return { error: 'notes query failed: ' + resp.status };
        return await resp.json();
      } catch (e) {
        return { error: e.message || String(e) };
      }
    })()
  `);

  if (pageResult?.error) {
    await page.setData(
      "status",
      `API error on page ${pageNum}: ${pageResult.error}`,
    );
    break;
  }

  const records = pageResult?.records || [];
  allNoteRecords.push(...records);
  continuationMarker = pageResult?.continuationMarker || null;

  await page.setData(
    "status",
    `Fetching notes... (${allNoteRecords.length} found)`,
  );
} while (continuationMarker);

// ── Phase 5: Parse and build results ─────────────────────────────────

await page.setData("status", `Processing ${allNoteRecords.length} notes...`);

const notes = [];
const parseErrors = [];

for (const record of allNoteRecords) {
  if (record.recordType !== "Note") continue;

  try {
    const fields = record.fields || {};
    const deleted = fields.Deleted?.value === 1;
    if (deleted) continue;

    const title = decodeBase64(fields.TitleEncrypted?.value);
    const snippet = decodeBase64(fields.SnippetEncrypted?.value);
    const folderRef =
      fields.Folder?.value?.recordName ||
      (fields.Folders?.value || [])[0]?.recordName;

    let textContent = null;
    const textDataRaw = fields.TextDataEncrypted?.value || null;
    if (textDataRaw) {
      textContent = await extractTextFromProtobuf(textDataRaw);
    }

    notes.push({
      recordName: record.recordName,
      title,
      snippet,
      folder: folderMap[folderRef] || folderRef || null,
      isPinned: !!fields.IsPinned?.value,
      createdDate: timestampToISO(
        fields.CreationDate?.value || record.created?.timestamp,
      ),
      modifiedDate: timestampToISO(
        fields.ModificationDate?.value || record.modified?.timestamp,
      ),
      hasAttachments: (fields.Attachments?.value || []).length > 0,
      textContent,
    });
  } catch (err) {
    parseErrors.push({
      recordName: record.recordName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Phase 6: Return results ──────────────────────────────────────────

const folders = Object.entries(folderMap).map(([recordName, title]) => ({
  recordName,
  title,
}));

const notesWithContent = notes.filter((n) => n.textContent).length;
const result = {
  'icloud_notes.notes': {
    notes,
    total: notes.length,
    userName: fullName,
  },
  'icloud_notes.folders': {
    folders,
    total: folders.length,
  },
  parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  exportSummary: {
    count: notes.length,
    label: notes.length === 1 ? "note" : "notes",
    details: `${notes.length} notes from iCloud Notes (${notesWithContent} with full content)`,
  },
  platform: "icloud_notes",
  timestamp: new Date().toISOString(),
  version: "1.0.0",
};

await page.setData("result", result);
await page.setData("status", `iCloud Notes - ${notes.length} notes captured`);
return { success: true, data: result };
