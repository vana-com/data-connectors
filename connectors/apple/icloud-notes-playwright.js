/**
 * iCloud Notes Connector
 *
 * Authenticates with Apple ID, then uses the CloudKit API directly
 * to fetch note and folder data from iCloud Notes.
 *
 * RUNTIME NOTE (for maintainers, not end users): this script depends on
 * CG-runtime-only page methods — getInput, frame_click/fill/evaluate,
 * keyboard_press/type — and does not yet run under the canonical
 * DataConnect playwright-runner minimum surface. The manifest's
 * capabilities array advertises this as `cg-legacy-page-api` so runners
 * can reject the connector up front until runtime convergence lands.
 */

(async () => {
  const PLATFORM = "icloud_notes";
  const VERSION = "0.2.0";
  const CANONICAL_SCOPES = [
    "icloud_notes.notes",
    "icloud_notes.folders",
  ];

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
    if (
      text.includes("auth") ||
      text.includes("login") ||
      text.includes("sign in") ||
      text.includes("credential") ||
      text.includes("password")
    ) {
      return "auth_failed";
    }
    if (text.includes("timeout") || text.includes("timed out")) {
      return "timeout";
    }
    if (
      text.includes("network") ||
      text.includes("fetch") ||
      text.includes("net::")
    ) {
      return "network_error";
    }
    if (text.includes("navigate") || text.includes("reach")) {
      return "navigation_error";
    }
    return fallback;
  };

  const buildResult = ({ requestedScopes, scopes, errors, exportSummary }) => ({
    requestedScopes: [...requestedScopes],
    timestamp: new Date().toISOString(),
    version: VERSION,
    platform: PLATFORM,
    exportSummary,
    errors,
    ...scopes,
  });

  const buildEmptyResult = (requestedScopes, errors) =>
    buildResult({
      requestedScopes,
      scopes: {},
      errors,
      exportSummary: {
        count: 0,
        label: "notes",
        details: {
          notes: 0,
          notesWithContent: 0,
          folders: 0,
        },
      },
    });

  const resolveRequestedScopes = () => {
    const raw =
      typeof page.requestedScopes === "function" ? page.requestedScopes() : null;
    if (raw == null) {
      return [...CANONICAL_SCOPES];
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw makeFatalRunError(
        "protocol_violation",
        "iCloud Notes connector received an empty or invalid requestedScopes array.",
        "init",
      );
    }

    const deduped = Array.from(new Set(raw));
    const invalid = deduped.filter((scope) => !CANONICAL_SCOPES.includes(scope));
    if (invalid.length > 0) {
      throw makeFatalRunError(
        "protocol_violation",
        `iCloud Notes connector received unsupported requestedScopes: ${invalid.join(", ")}.`,
        "init",
      );
    }

    return deduped;
  };

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

  const decodeBase64 = (value) => {
    if (!value) return null;
    try {
      return atob(value);
    } catch {
      return null;
    }
  };

  const timestampToISO = (ts) => {
    if (!ts) return null;
    return new Date(ts).toISOString();
  };

  const tryDecompress = async (bytes, format) => {
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
      chunks.reduce((acc, chunk) => acc + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      decompressed.set(chunk, offset);
      offset += chunk.length;
    }
    return decompressed;
  };

  const extractCleanText = (decompressedBytes) => {
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
  };

  const extractTextFromProtobuf = async (base64Data) => {
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
  };

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
          } catch {
            return null;
          }
        })()
      `);
    } catch {
      return null;
    }
  };

  const authenticate = async () => {
    await page.setData("status", "Launching iCloud...");
    const notesReachable = await safeGoto("https://www.icloud.com/notes");
    if (!notesReachable) {
      throw makeFatalRunError(
        "navigation_error",
        "Could not reach iCloud Notes after multiple attempts.",
        "init",
      );
    }
    await page.sleep(5000);

    let config = await getCloudKitConfig();
    let isLoggedIn = !!config;

    if (isLoggedIn) {
      return config;
    }

    const APPLE_FRAME = "idmsa.apple.com";

    const findAuthFrame = async () => {
      try {
        return await page.evaluate(
          `!!document.getElementById('aid-auth-widget-iFrame')`,
        );
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
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const signIn = buttons.find((el) => /^Sign\\s*In$/i.test((el.textContent || '').trim()));
          if (signIn) {
            signIn.click();
            return true;
          }
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
          const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const signIn = buttons.find((el) => /^Sign\\s*In$/i.test((el.textContent || '').trim()));
          if (signIn) {
            signIn.click();
            return true;
          }
          return false;
        })()
      `);
      if (clicked) hasAuthFrame = await waitForAuthFrame(10000);
    }

    let credentials = null;
    let lastError = null;
    let loginAttempts = 0;

    while (
      hasAuthFrame &&
      !isLoggedIn &&
      loginAttempts < 3 &&
      typeof page.getInput === "function"
    ) {
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
            password: {
              "ui:widget": "password",
              "ui:placeholder": "Password",
            },
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
        } catch {
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
        } catch {
          await page.keyboard_press("Enter");
        }

        await page.setData("status", "Authenticating...");
        await page.sleep(10000);
      } catch (error) {
        lastError = `Login form error: ${error?.message || String(error)}`;
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
      } catch {
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
          } catch {
            await page.keyboard_press("Enter");
          }
        } catch {
          await page.keyboard_type(otpResult.code, { delay: 50 });
          await page.sleep(500);
          await page.keyboard_press("Enter");
        }

        await page.sleep(8000);

        try {
          const trustCheck = await page.frame_evaluate(
            APPLE_FRAME,
            `document.body?.innerText?.includes('Trust') || false`,
          );
          if (trustCheck) {
            try {
              await page.frame_click(
                APPLE_FRAME,
                'button.button-primary, button[type="submit"]',
                { timeout: 5000 },
              );
            } catch {
              await page.keyboard_press("Enter");
            }
            await page.sleep(5000);
          }
        } catch {}

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
            const text = document.body?.innerText || '';
            if (text.includes('incorrect') || text.includes('Incorrect')) return 'Incorrect Apple ID or password.';
            if (text.includes('locked') || text.includes('disabled')) return 'This Apple ID has been locked or disabled.';
            return null;
          })()
        `);
      }

      lastError =
        errorCheck || "Sign in failed. Please check your credentials.";
    }

    if (isLoggedIn && config) {
      return config;
    }

    let canShowHeaded = false;
    if (typeof page.showBrowser === "function") {
      try {
        const result = await page.showBrowser("https://www.icloud.com/notes");
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
      if (config) {
        return config;
      }
    }

    throw makeFatalRunError(
      "auth_failed",
      lastError ||
        "Could not sign in to iCloud Notes. Login requires a headed browser or requestInput support.",
      "auth",
    );
  };

  const fetchFolders = async (queryUrl) => {
    await page.setData("status", "Fetching folders...");

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
        } catch (error) {
          return { error: error.message || String(error) };
        }
      })()
    `);

    if (folderResult?.error) {
      return {
        folderMap: {},
        folders: [],
        error: makeConnectorError(
          inferErrorClass(folderResult.error, "upstream_error"),
          `Could not fetch iCloud Notes folders: ${folderResult.error}`,
          "omitted",
          { scope: "icloud_notes.folders", phase: "collect" },
        ),
      };
    }

    const folderMap = {};
    for (const record of folderResult?.records || []) {
      if (record.recordType !== "Folder") continue;
      const title = decodeBase64(record.fields?.TitleEncrypted?.value);
      folderMap[record.recordName] = title || record.recordName;
    }

    const folders = Object.entries(folderMap).map(([recordName, title]) => ({
      recordName,
      title,
    }));

    return {
      folderMap,
      folders,
      error: null,
    };
  };

  const fetchNotes = async (queryUrl, folderMap, foldersError) => {
    await page.setData("status", "Fetching notes...");

    const allNoteRecords = [];
    let continuationMarker = null;
    let pageNum = 0;
    let pageFailure = null;

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
          } catch (error) {
            return { error: error.message || String(error) };
          }
        })()
      `);

      if (pageResult?.error) {
        pageFailure = {
          message: pageResult.error,
          page: pageNum,
        };
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

    await page.setData(
      "status",
      `Processing ${allNoteRecords.length} notes...`,
    );

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
      } catch (error) {
        parseErrors.push({
          recordName: record.recordName,
          message: error?.message || String(error),
        });
      }
    }

    const reasons = [];
    let issueClass = null;
    let disposition = null;

    if (pageFailure) {
      reasons.push(
        `Notes query stopped on page ${pageFailure.page}: ${pageFailure.message}.`,
      );
      issueClass = inferErrorClass(pageFailure.message, "upstream_error");
      disposition = notes.length > 0 ? "degraded" : "omitted";
    }

    if (parseErrors.length > 0) {
      reasons.push(`Could not parse ${parseErrors.length} note record(s).`);
      if (!issueClass) {
        issueClass = "runtime_error";
      }
      if (!disposition) {
        disposition = notes.length > 0 ? "degraded" : "omitted";
      }
    }

    if (foldersError) {
      reasons.push("Folder names could not be resolved for some notes.");
      if (!issueClass) {
        issueClass = foldersError.errorClass;
      }
      if (!disposition) {
        disposition = notes.length > 0 ? "degraded" : "omitted";
      }
    }

    const error =
      reasons.length > 0
        ? makeConnectorError(
            issueClass || "runtime_error",
            reasons.join(" "),
            disposition || (notes.length > 0 ? "degraded" : "omitted"),
            { scope: "icloud_notes.notes", phase: "collect" },
          )
        : null;

    return {
      notes,
      notesWithContent: notes.filter((note) => note.textContent).length,
      error,
    };
  };

  let requestedScopes = [...CANONICAL_SCOPES];

  try {
    requestedScopes = resolveRequestedScopes();
    const wantsScope = (scope) => requestedScopes.includes(scope);

    const config = await authenticate();
    const { fullName, dsid, ckBaseUrl } = config;
    await page.setData("status", `Signed in as ${fullName}`);

    const queryUrl =
      `${ckBaseUrl}/database/1/com.apple.notes/production/private/records/query?dsid=${dsid}`;

    let folderMap = {};
    let folders = [];
    let foldersError = null;

    if (wantsScope("icloud_notes.notes") || wantsScope("icloud_notes.folders")) {
      const foldersResult = await fetchFolders(queryUrl);
      folderMap = foldersResult.folderMap;
      folders = foldersResult.folders;
      foldersError = foldersResult.error;
    }

    let notes = [];
    let notesWithContent = 0;
    let notesError = null;

    if (wantsScope("icloud_notes.notes")) {
      const notesResult = await fetchNotes(queryUrl, folderMap, foldersError);
      notes = notesResult.notes;
      notesWithContent = notesResult.notesWithContent;
      notesError = notesResult.error;
    }

    const scopes = {};
    const errors = [];

    if (wantsScope("icloud_notes.notes")) {
      if (!notesError || notesError.disposition !== "omitted") {
        scopes["icloud_notes.notes"] = {
          notes,
          total: notes.length,
          userName: fullName || null,
        };
      }
      if (notesError) {
        errors.push(notesError);
      }
    }

    if (wantsScope("icloud_notes.folders")) {
      if (!foldersError || foldersError.disposition !== "omitted") {
        scopes["icloud_notes.folders"] = {
          folders,
          total: folders.length,
        };
      }
      if (foldersError) {
        errors.push(foldersError);
      }
    }

    const result = buildResult({
      requestedScopes,
      scopes,
      errors,
      exportSummary: {
        count: notes.length,
        label: notes.length === 1 ? "note" : "notes",
        details: {
          notes: notes.length,
          notesWithContent,
          folders: folders.length,
        },
      },
    });

    await page.setData("result", result);
    await page.setData(
      "status",
      `iCloud Notes - ${notes.length} notes captured`,
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
    const result = buildEmptyResult(requestedScopes, [telemetryError]);
    await page.setData("result", result);
    await page.setData("error", telemetryError.reason);
    return result;
  }
})();
