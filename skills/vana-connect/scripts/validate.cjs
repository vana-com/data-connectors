#!/usr/bin/env node

/**
 * Connector Validator
 *
 * Validates connector files (structure) and optionally connector output (data quality).
 * Returns machine-readable JSON for use by automated agents in the create-test-validate loop.
 *
 * Usage:
 *   node scripts/validate.cjs <connector.js>
 *   node scripts/validate.cjs <connector.js> --check-result ./connector-result.json
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 */

const fs = require('fs');
const path = require('path');

// ─── Report Builder ─────────────────────────────────────────

function createReport() {
  const report = {
    valid: true,
    checks: [],
    summary: { passed: 0, failed: 0, warnings: 0 },
  };

  function check(name, passed, message, severity = 'error') {
    report.checks.push({ name, passed, message, severity });
    if (passed) {
      report.summary.passed++;
    } else if (severity === 'error') {
      report.summary.failed++;
      report.valid = false;
    } else {
      report.summary.warnings++;
    }
  }

  return { report, check };
}

// ─── Simple JSON Schema Validator ───────────────────────────

function validateAgainstSchema(data, schema, prefix = '') {
  const errors = [];

  if (data === null || data === undefined) {
    errors.push(`${prefix || 'root'}: value is null/undefined`);
    return errors;
  }

  if (schema.type === 'object') {
    if (typeof data !== 'object' || Array.isArray(data)) {
      errors.push(`${prefix || 'root'}: expected object, got ${Array.isArray(data) ? 'array' : typeof data}`);
      return errors;
    }

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (data[field] === undefined || data[field] === null) {
          errors.push(`${prefix ? prefix + '.' : ''}${field}: missing required field`);
        }
      }
    }

    // Check additionalProperties
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          errors.push(`${prefix ? prefix + '.' : ''}${key}: unexpected field`);
        }
      }
    }

    // Recursively check properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (data[key] !== undefined && data[key] !== null) {
          const propPrefix = prefix ? `${prefix}.${key}` : key;
          errors.push(...validateAgainstSchema(data[key], propSchema, propPrefix));
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push(`${prefix || 'root'}: expected array, got ${typeof data}`);
      return errors;
    }
    // Validate first few items against items schema
    if (schema.items && data.length > 0) {
      const sampleSize = Math.min(data.length, 3);
      for (let i = 0; i < sampleSize; i++) {
        errors.push(...validateAgainstSchema(data[i], schema.items, `${prefix}[${i}]`));
      }
    }
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') {
      errors.push(`${prefix}: expected string, got ${typeof data}`);
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof data !== 'number') {
      errors.push(`${prefix}: expected number, got ${typeof data}`);
    }
  } else if (schema.type === 'boolean') {
    if (typeof data !== 'boolean') {
      errors.push(`${prefix}: expected boolean, got ${typeof data}`);
    }
  }

  return errors;
}

// ─── Schema Meta-Validation ─────────────────────────────────
// Checks that a JSON Schema object is itself well-formed (no ajv dependency).

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const VALID_FORMATS = new Set([
  'date-time', 'date', 'time', 'email', 'uri', 'uri-reference',
  'hostname', 'ipv4', 'ipv6', 'uuid', 'regex',
]);

function validateSchemaShape(schema, prefix = 'schema') {
  const errors = [];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    errors.push(`${prefix}: must be an object`);
    return errors;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) {
      if (!VALID_TYPES.has(t)) {
        errors.push(`${prefix}.type: invalid type "${t}" (expected one of: ${[...VALID_TYPES].join(', ')})`);
      }
    }
  }

  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      errors.push(`${prefix}.properties: must be an object`);
    } else {
      for (const [key, val] of Object.entries(schema.properties)) {
        errors.push(...validateSchemaShape(val, `${prefix}.properties.${key}`));
      }
    }
  }

  if (schema.items !== undefined) {
    if (schema.type && schema.type !== 'array') {
      errors.push(`${prefix}: "items" is only valid for type "array", got type "${schema.type}"`);
    }
    if (typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      errors.push(...validateSchemaShape(schema.items, `${prefix}.items`));
    }
  }

  if (schema.type === 'array' && schema.items === undefined) {
    errors.push(`${prefix}: type "array" should have "items" defining the element schema`);
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      errors.push(`${prefix}.required: must be an array`);
    }
  }

  if (schema.format !== undefined && !VALID_FORMATS.has(schema.format)) {
    errors.push(`${prefix}.format: unknown format "${schema.format}" (known: ${[...VALID_FORMATS].join(', ')})`);
  }

  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    errors.push(`${prefix}.enum: must be an array`);
  }

  return errors;
}

// ─── Metadata Validation ────────────────────────────────────

function validateMetadata(metadataPath, check) {
  check('metadata_exists', fs.existsSync(metadataPath),
    fs.existsSync(metadataPath) ? `Found: ${path.basename(metadataPath)}` : `Missing: ${metadataPath}`);

  if (!fs.existsSync(metadataPath)) return null;

  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    check('metadata_valid_json', true, 'Valid JSON');
  } catch (e) {
    check('metadata_valid_json', false, 'Invalid JSON: ' + e.message);
    return null;
  }

  const required = ['id', 'version', 'name', 'company', 'description', 'connectURL', 'connectSelector', 'runtime'];
  for (const field of required) {
    const val = metadata[field];
    check(`metadata_${field}`, !!val,
      val ? `${field} = "${String(val).substring(0, 60)}"` : `Missing required field: ${field}`);
  }

  check('metadata_runtime_playwright', metadata.runtime === 'playwright',
    metadata.runtime === 'playwright' ? 'runtime is "playwright"' : `Unexpected runtime: "${metadata.runtime}"`);

  try {
    new URL(metadata.connectURL);
    check('metadata_url_valid', true, `connectURL is valid: ${metadata.connectURL}`);
  } catch {
    check('metadata_url_valid', false, `connectURL is not a valid URL: "${metadata.connectURL}"`);
  }

  check('metadata_connect_selector', metadata.connectSelector && metadata.connectSelector.length > 3,
    metadata.connectSelector
      ? `connectSelector = "${metadata.connectSelector.substring(0, 80)}"`
      : 'connectSelector is empty or too short');

  return metadata;
}

// ─── Script Validation ──────────────────────────────────────

function validateScript(scriptPath, check) {
  check('script_exists', fs.existsSync(scriptPath),
    fs.existsSync(scriptPath) ? `Found: ${path.basename(scriptPath)}` : `Missing: ${scriptPath}`);

  if (!fs.existsSync(scriptPath)) return '';

  const script = fs.readFileSync(scriptPath, 'utf-8');

  // Detect connector pattern: API-key connectors use httpFetch + requestInput/env,
  // browser-login connectors use showBrowser/promptUser/goto + evaluate
  const hasHttpFetch = /page\.httpFetch/.test(script);
  const hasRequestInput = /page\.requestInput/.test(script);
  const hasCloseBrowser = /page\.closeBrowser/.test(script);
  const isApiKeyPattern = hasHttpFetch && (hasRequestInput || /process\.env\.\w*(?:API|TOKEN|KEY)/i.test(script));

  // IIFE pattern
  check('script_iife',
    /\(async\s*\(\)\s*=>\s*\{/.test(script),
    'Uses async IIFE wrapper: (async () => { ... })()');

  if (isApiKeyPattern) {
    // API-key connector checks
    check('script_api_key_input',
      hasRequestInput || /process\.env/i.test(script),
      'Has credential input (requestInput or process.env)');
    check('script_close_browser', hasCloseBrowser,
      hasCloseBrowser
        ? 'Calls page.closeBrowser() before API calls'
        : 'No page.closeBrowser() — browser resources may not be freed',
      'warning');
    check('script_http_fetch', true, 'Uses page.httpFetch() for API calls');
  } else {
    // Browser-login connector checks
    check('script_login_detection',
      /checkLogin|isLoggedIn|loginStatus|login.*detect/i.test(script),
      'Has login detection logic');

    const hasEnvCredentials = /process\.env\.USER_LOGIN|process\.env\.USER_PASSWORD/i.test(script);
    check('script_env_credentials',
      hasEnvCredentials,
      hasEnvCredentials
        ? 'Reads credentials from process.env (automated login)'
        : 'Does not read credentials from process.env — automated login requires USER_LOGIN_<PLATFORM> and USER_PASSWORD_<PLATFORM>',
      'warning');

    const hasFormFill = /\.value\s*=|getOwnPropertyDescriptor\s*\(\s*(?:window\.)?HTMLInputElement\.prototype/i.test(script);
    check('script_automated_form_fill',
      hasFormFill,
      hasFormFill
        ? 'Has automated form fill logic (sets input values or native setter)'
        : 'No automated form fill detected — connector may require manual login',
      hasEnvCredentials ? 'error' : 'warning');

    const hasShowBrowser = /page\.showBrowser/.test(script);
    const hasPromptUser = /page\.promptUser/.test(script);
    check('script_show_browser', hasShowBrowser,
      hasShowBrowser
        ? 'Has page.showBrowser() (browser login)'
        : 'No page.showBrowser() — OK if using automated login',
      hasEnvCredentials ? 'warning' : 'error');
    check('script_prompt_user', hasPromptUser,
      hasPromptUser
        ? 'Has page.promptUser() (browser login)'
        : 'No page.promptUser() — OK if using automated login',
      hasEnvCredentials ? 'warning' : 'error');

    check('script_go_headless',
      /page\.goHeadless/.test(script),
      'Calls page.goHeadless() before data collection',
      'warning');
  }

  // Result building
  check('script_set_result',
    /page\.setData\s*\(\s*['"]result['"]/.test(script),
    'Calls page.setData("result", ...) to return data');

  // Error handling
  check('script_error_handling',
    /page\.setData\s*\(\s*['"]error['"]/.test(script),
    'Has error handling via page.setData("error", ...)', 'warning');

  // Progress reporting
  check('script_progress',
    /page\.setProgress/.test(script),
    'Reports progress via page.setProgress()', 'warning');

  // exportSummary
  check('script_export_summary',
    /exportSummary/.test(script),
    'Includes exportSummary in result');

  // Common mistake: function reference in page.evaluate instead of string
  // Look for page.evaluate( followed by ( or async without a backtick or quote
  const evalLines = script.split('\n').filter(l => l.includes('page.evaluate'));
  const badEvals = evalLines.filter(l => {
    // Match page.evaluate( NOT followed by ` or ' or "
    return /page\.evaluate\s*\(\s*(?:async\s+)?\(/.test(l) &&
      !/page\.evaluate\s*\(\s*['"`]/.test(l);
  });
  check('script_evaluate_uses_strings',
    badEvals.length === 0,
    badEvals.length === 0
      ? 'page.evaluate() uses string arguments (correct)'
      : `CRITICAL: ${badEvals.length} page.evaluate() call(s) may use function references instead of strings. page.evaluate() takes a JS string.`);

  // Obfuscated CSS selectors (e.g., .x1lliihq, .css-1dbjc4n)
  const obfuscatedMatches = script.match(/['"]\.(?:[a-z]{1,3}[0-9][a-z0-9_-]{4,}|css-[a-z0-9]+)['"]/g) || [];
  check('script_no_obfuscated_selectors',
    obfuscatedMatches.length === 0,
    obfuscatedMatches.length === 0
      ? 'No obfuscated CSS selectors detected'
      : `Found ${obfuscatedMatches.length} potentially obfuscated selector(s): ${obfuscatedMatches.slice(0, 3).join(', ')}`,
    'warning');

  // Extract scoped result keys from the script
  const scopeKeyPattern = /['"]([\w-]+\.[\w-]+)['"]\s*:/g;
  const metaKeys = new Set(['exports.default', 'module.exports', 'console.log', 'window.location',
    'process.env', 'e.message', 'resp.status', 'data.user', 'error.message']);
  const scopeKeys = new Set();
  let m;
  while ((m = scopeKeyPattern.exec(script)) !== null) {
    if (!metaKeys.has(m[1]) && !m[1].startsWith('com.')) {
      scopeKeys.add(m[1]);
    }
  }

  check('script_scoped_keys',
    scopeKeys.size > 0,
    scopeKeys.size > 0
      ? `Found scoped keys: ${[...scopeKeys].join(', ')}`
      : 'No scoped result keys (platform.scope) found — new connectors should use scoped keys like "platform.scope"',
    scopeKeys.size > 0 ? 'error' : 'warning');

  // Debug code detection
  const debugPatterns = [
    { re: /\[DEBUG\]/g, name: 'DEBUG tags' },
    { re: /console\.log\s*\(/g, name: 'console.log statements' },
  ];
  const debugFindings = [];
  for (const { re, name } of debugPatterns) {
    const matches = script.match(re);
    if (matches) debugFindings.push(`${matches.length} ${name}`);
  }
  check('script_no_debug_code', debugFindings.length === 0,
    debugFindings.length === 0
      ? 'No debug code detected'
      : `Debug code found: ${debugFindings.join(', ')}. Remove before contributing.`);

  // Login method diversity (browser-login connectors only)
  if (!isApiKeyPattern) {
    const hasMethodField = /method|loginMethod|login_method|signInMethod/i.test(script) &&
      hasRequestInput;
    const hasMultipleLoginPaths = (script.match(/google|apple|sso|oauth|saml|amazon/gi) || []).length >= 2;
    check('script_multiple_login_methods',
      hasMethodField || hasMultipleLoginPaths,
      hasMethodField || hasMultipleLoginPaths
        ? 'Supports multiple login methods'
        : 'Only one login method detected. If the platform offers multiple options (email, Google, Apple, SSO), ask the user which one they use.',
      'warning');
  }

  return script;
}

// ─── Schema Validation ──────────────────────────────────────

function validateSchemas(metadata, connectorDir, check) {
  const schemasDir = path.resolve(connectorDir, '..', 'schemas');

  if (!metadata?.scopes || !Array.isArray(metadata.scopes)) {
    check('schemas_declared', false,
      'No scopes array in metadata — cannot validate schemas. Add scopes to metadata or create schemas manually.',
      'warning');
    return;
  }

  for (const scope of metadata.scopes) {
    const scopeName = scope.scope || scope.name;
    if (!scopeName) continue;

    const schemaPath = path.join(schemasDir, `${scopeName}.json`);
    check(`schema_exists_${scopeName}`,
      fs.existsSync(schemaPath),
      fs.existsSync(schemaPath)
        ? `Schema found: schemas/${scopeName}.json`
        : `Schema missing: schemas/${scopeName}.json`);

    if (fs.existsSync(schemaPath)) {
      try {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
        const hasStructure = schema.name && schema.scope && schema.schema;
        check(`schema_structure_${scopeName}`,
          hasStructure,
          hasStructure
            ? `Schema has required fields (name, scope, schema)`
            : 'Schema missing required top-level fields (name, scope, schema)');

        // Meta-validate the inner schema object
        if (schema.schema) {
          const metaErrors = validateSchemaShape(schema.schema);
          check(`schema_valid_${scopeName}`,
            metaErrors.length === 0,
            metaErrors.length === 0
              ? `Schema is well-formed JSON Schema`
              : `Schema structure errors: ${metaErrors.slice(0, 5).join('; ')}${metaErrors.length > 5 ? ` (+${metaErrors.length - 5} more)` : ''}`);

          // Check description coverage
          const missingDescs = [];
          (function walkDescs(s, prefix) {
            if (s.properties) {
              for (const [key, prop] of Object.entries(s.properties)) {
                const p = prefix ? `${prefix}.${key}` : key;
                if (!prop.description) missingDescs.push(p);
                if (prop.type === 'object' && prop.properties) walkDescs(prop, p);
                if (prop.type === 'array' && prop.items?.properties) walkDescs(prop.items, `${p}[]`);
              }
            }
          })(schema.schema, '');
          check(`schema_descriptions_${scopeName}`,
            missingDescs.length === 0,
            missingDescs.length === 0
              ? 'All schema fields have descriptions'
              : `${missingDescs.length} field(s) missing description: ${missingDescs.slice(0, 5).join(', ')}${missingDescs.length > 5 ? ` (+${missingDescs.length - 5} more)` : ''}`);
        }
      } catch (e) {
        check(`schema_json_${scopeName}`, false, `Schema is not valid JSON: ${e.message}`);
      }
    }
  }
}

// ─── Output Validation ──────────────────────────────────────

function validateOutput(resultPath, metadata, connectorDir, check) {
  check('result_exists', fs.existsSync(resultPath),
    fs.existsSync(resultPath) ? `Found: ${path.basename(resultPath)}` : `Missing: ${resultPath}`);

  if (!fs.existsSync(resultPath)) return;

  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    check('result_valid_json', true, 'Valid JSON');
  } catch (e) {
    check('result_valid_json', false, 'Invalid JSON: ' + e.message);
    return;
  }

  // Identify scoped keys (keys containing '.' that aren't metadata)
  const metaKeyNames = new Set(['exportSummary', 'timestamp', 'version', 'platform']);
  const scopedKeys = Object.keys(result).filter(k => k.includes('.') && !metaKeyNames.has(k));

  check('result_has_scopes', scopedKeys.length > 0,
    scopedKeys.length > 0
      ? `${scopedKeys.length} scope(s): ${scopedKeys.join(', ')}`
      : 'No scoped keys found in result');

  // Validate each scope has data
  let totalItems = 0;
  for (const key of scopedKeys) {
    const data = result[key];
    const isEmpty = data === null || data === undefined ||
      (typeof data === 'object' && Object.keys(data).length === 0);

    check(`result_${key}_not_empty`, !isEmpty,
      isEmpty ? `Scope "${key}" is empty` : `Scope "${key}" has data`);

    // Count items in arrays
    if (data && typeof data === 'object') {
      for (const [field, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
          totalItems += value.length;
          check(`result_${key}_${field}_count`, value.length > 0,
            `${key}.${field}: ${value.length} items`,
            value.length === 0 ? 'warning' : 'error');
        }
      }
    }
  }

  // Metadata fields
  check('result_export_summary', !!result.exportSummary,
    result.exportSummary
      ? `exportSummary: ${JSON.stringify(result.exportSummary)}`
      : 'Missing exportSummary');

  if (result.exportSummary) {
    check('result_summary_count', typeof result.exportSummary.count === 'number' && result.exportSummary.count >= 0,
      `count: ${result.exportSummary.count}`);
    check('result_summary_label', !!result.exportSummary.label,
      `label: "${result.exportSummary.label || ''}"`);
    check('result_summary_details', !!result.exportSummary.details,
      `details: "${result.exportSummary.details || ''}"`, 'warning');
  }

  check('result_timestamp', !!result.timestamp,
    result.timestamp ? `timestamp: ${result.timestamp}` : 'Missing timestamp');
  check('result_version', !!result.version,
    result.version ? `version: ${result.version}` : 'Missing version');
  check('result_platform', !!result.platform,
    result.platform ? `platform: ${result.platform}` : 'Missing platform');

  // Schema compliance for each scope
  const schemasDir = path.resolve(connectorDir, '..', 'schemas');
  for (const key of scopedKeys) {
    const schemaPath = path.join(schemasDir, `${key}.json`);
    if (!fs.existsSync(schemaPath)) continue;

    try {
      const schemaFile = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
      if (schemaFile.schema) {
        const errors = validateAgainstSchema(result[key], schemaFile.schema);
        check(`result_schema_${key}`, errors.length === 0,
          errors.length === 0
            ? `${key} conforms to schema`
            : `${key} schema violations: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`);
      }
    } catch (e) {
      check(`result_schema_${key}`, false, `Schema validation error: ${e.message}`, 'warning');
    }
  }

  // UI artifact scanning — detect DOM leftovers in result data
  const artifactPatterns = [
    { re: /\[edit\]/i, name: '[edit]' },
    { re: /\(edit profile\)/i, name: '(edit profile)' },
    { re: /\(edit\)/i, name: '(edit)' },
    { re: /\n\s{4,}/g, name: 'excessive whitespace' },
  ];
  function scanForArtifacts(obj, objPath) {
    const findings = [];
    if (typeof obj === 'string') {
      for (const { re, name } of artifactPatterns) {
        if (re.test(obj)) findings.push(`${objPath}: contains "${name}"`);
      }
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 10); i++) {
        findings.push(...scanForArtifacts(obj[i], `${objPath}[${i}]`));
      }
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        findings.push(...scanForArtifacts(v, objPath ? `${objPath}.${k}` : k));
      }
    }
    return findings;
  }
  for (const key of scopedKeys) {
    const artifacts = scanForArtifacts(result[key], key);
    check(`result_clean_data_${key}`, artifacts.length === 0,
      artifacts.length === 0
        ? `${key}: data is clean (no UI artifacts)`
        : `${key}: found ${artifacts.length} UI artifact(s): ${artifacts.slice(0, 3).join('; ')}${artifacts.length > 3 ? ` (+${artifacts.length - 3} more)` : ''}`);
  }

  // Sanity check: if we expected scopes from metadata, check they all appeared
  if (metadata?.scopes && Array.isArray(metadata.scopes)) {
    for (const scope of metadata.scopes) {
      const scopeName = scope.scope || scope.name;
      if (scopeName) {
        check(`result_expected_scope_${scopeName}`,
          scopedKeys.includes(scopeName),
          scopedKeys.includes(scopeName)
            ? `Expected scope "${scopeName}" present in output`
            : `Expected scope "${scopeName}" missing from output`);
      }
    }
  }
}

// ─── Secret Scanning ─────────────────────────────────────────

function scanForSecrets(scriptPath, metadataPath, check) {
  const files = [scriptPath, metadataPath].filter(f => fs.existsSync(f));
  const patterns = [
    { name: 'API key literal', re: /['"](?:lin_api_|sk-|ghp_|gho_|fip_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]{10,}['"]/g },
    { name: 'Bearer token literal', re: /['"]Bearer\s+[A-Za-z0-9._-]{20,}['"]/g },
    { name: 'Password literal', re: /(?:password|passwd|secret)\s*[:=]\s*['"][^'"]{4,}['"]/gi },
    { name: 'Email address', re: /['"][a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}['"]/g },
  ];

  let found = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const { name, re } of patterns) {
      const matches = content.match(re);
      if (matches) {
        found.push(`${name} in ${path.basename(filePath)}: ${matches[0].substring(0, 30)}...`);
      }
    }
  }

  check('no_hardcoded_secrets', found.length === 0,
    found.length === 0
      ? 'No hardcoded secrets detected'
      : `BLOCKED: Found ${found.length} potential secret(s): ${found.join('; ')}`);

  return found.length === 0;
}

// ─── Contribute ──────────────────────────────────────────────

function contribute(connectorPath, connectorDir, metadataPath) {
  const { execSync } = require('child_process');

  // Check git auth
  let useGh = false;
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    useGh = true;
  } catch {}

  if (!useGh) {
    try {
      execSync('git ls-remote https://github.com/vana-com/data-connectors.git HEAD', { stdio: 'pipe' });
    } catch {
      console.error('Cannot authenticate with GitHub. Install and auth `gh` CLI, or configure git credentials.');
      process.exit(1);
    }
  }

  // Collect files
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  const schemasDir = path.resolve(connectorDir, '..', 'schemas');
  const files = [connectorPath, metadataPath];
  if (metadata?.scopes && Array.isArray(metadata.scopes)) {
    for (const scope of metadata.scopes) {
      const scopeName = scope.scope || scope.name;
      if (scopeName) {
        const schemaPath = path.join(schemasDir, `${scopeName}.json`);
        if (fs.existsSync(schemaPath)) files.push(schemaPath);
      }
    }
  }

  const platform = metadata?.name || path.basename(connectorDir);
  const branchName = `connector/${platform.toLowerCase().replace(/\s+/g, '-')}`;

  console.log(`\nContributing ${platform} connector...`);
  console.log(`Files: ${files.map(f => path.relative(process.cwd(), f)).join(', ')}`);

  // Find repo root (look for registry.json)
  let repoRoot = process.cwd();
  for (let d = repoRoot; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'registry.json'))) { repoRoot = d; break; }
  }

  try {
    // Fork if needed
    if (useGh) {
      try { execSync('gh repo fork vana-com/data-connectors --clone=false', { stdio: 'pipe', cwd: repoRoot }); } catch {}
    }

    execSync(`git checkout -b ${branchName}`, { stdio: 'pipe', cwd: repoRoot });
    for (const f of files) {
      execSync(`git add ${path.relative(repoRoot, f)}`, { stdio: 'pipe', cwd: repoRoot });
    }
    // Also add registry.json if it was updated
    const registryPath = path.join(repoRoot, 'registry.json');
    if (fs.existsSync(registryPath)) {
      execSync(`git add registry.json`, { stdio: 'pipe', cwd: repoRoot });
    }

    const commitMsg = `feat: add ${platform} connector`;
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'pipe', cwd: repoRoot });

    if (useGh) {
      execSync(`git push -u origin ${branchName}`, { stdio: 'pipe', cwd: repoRoot });
      const prUrl = execSync(
        `gh pr create --title "${commitMsg}" --body "Adds a new connector for ${platform}.\\n\\nGenerated by the vana-connect skill." --head ${branchName}`,
        { encoding: 'utf-8', cwd: repoRoot }
      ).trim();
      console.log(`\nPR created: ${prUrl}`);
    } else {
      execSync(`git push -u origin ${branchName}`, { stdio: 'pipe', cwd: repoRoot });
      console.log(`\nBranch pushed: ${branchName}`);
      console.log(`Open a PR at: https://github.com/vana-com/data-connectors/compare/${branchName}`);
    }
  } catch (e) {
    console.error('Contribution failed:', e.message);
    process.exit(1);
  }
}

// ─── Main ───────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Connector Validator — validates structure and output of data connectors.

Usage:
  node scripts/validate.cjs <connector.js>
  node scripts/validate.cjs <connector.js> --check-result <result.json>
  node scripts/validate.cjs <connector.js> --contribute

Flags:
  --check-result <file>  Also validate connector output data
  --contribute           Validate, scan for secrets, and open a PR to share the connector
  --help, -h             Show this help

Output: JSON report to stdout. Exit code 0 = valid, 1 = invalid.
`);
    process.exit(0);
  }

  const connectorPath = path.resolve(args[0]);
  let resultPath = null;
  let shouldContribute = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--check-result' && args[i + 1]) {
      resultPath = path.resolve(args[++i]);
    } else if (args[i] === '--contribute') {
      shouldContribute = true;
    }
  }

  const { report, check } = createReport();

  // Derive paths
  const connectorDir = path.dirname(connectorPath);
  const metadataPath = connectorPath.replace(/\.js$/, '.json');

  // Run validations
  const metadata = validateMetadata(metadataPath, check);
  validateScript(connectorPath, check);
  validateSchemas(metadata, connectorDir, check);
  const secretsClean = scanForSecrets(connectorPath, metadataPath, check);

  if (resultPath) {
    validateOutput(resultPath, metadata, connectorDir, check);
  }

  // Output
  console.log(JSON.stringify(report, null, 2));

  if (shouldContribute) {
    if (!report.valid) {
      console.error('\nValidation failed — fix errors before contributing.');
      process.exit(1);
    }
    if (!secretsClean) {
      console.error('\nHardcoded secrets detected — remove them before contributing.');
      process.exit(1);
    }
    contribute(connectorPath, connectorDir, metadataPath);
  } else if (report.valid) {
    const platform = metadata?.name || path.basename(connectorDir);
    console.error(`\nThis connector is ready to share. Run with --contribute to open a PR so others can connect their ${platform} data.`);
  }

  process.exit(report.valid ? 0 : 1);
}

main();
