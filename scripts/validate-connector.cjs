#!/usr/bin/env node

/**
 * Connector Validator
 *
 * Validates connector files (structure) and optionally connector output (data quality).
 * Returns machine-readable JSON for use by automated agents in the create-test-validate loop.
 *
 * Understands the canonical honest connector result contract:
 *   - requestedScopes, errors[], reserved metadata keys
 *   - omitted / degraded / fatal dispositions
 *   - protocol violation detection
 *
 * Usage:
 *   node scripts/validate-connector.cjs <connector.js>
 *   node scripts/validate-connector.cjs <connector.js> --check-result ./connector-result.json
 *   node scripts/validate-connector.cjs <connector.js> --check-result ./connector-result.json --strict
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 */

const fs = require('fs');
const path = require('path');

// ─── Honest Contract Constants ─────────────────────────────

const RESERVED_METADATA_KEYS = new Set([
  'requestedScopes',
  'timestamp',
  'version',
  'platform',
  'exportSummary',
  'errors',
]);

const VALID_ERROR_CLASSES = new Set([
  'auth_failed',
  'rate_limited',
  'upstream_error',
  'navigation_error',
  'network_error',
  'selector_error',
  'timeout',
  'protocol_violation',
  'runtime_error',
  'personal_server_unavailable',
  'unknown',
]);

const VALID_DISPOSITIONS = new Set(['omitted', 'degraded', 'fatal']);

const VALID_PHASES = new Set(['init', 'auth', 'collect', 'transform', 'finalize']);

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

  // IIFE pattern
  check('script_iife',
    /\(async\s*\(\)\s*=>\s*\{/.test(script),
    'Uses async IIFE wrapper: (async () => { ... })()');

  // Login detection
  check('script_login_detection',
    /checkLogin|isLoggedIn|loginStatus|login.*detect/i.test(script),
    'Has login detection logic');

  // Automated login: reads credentials from process.env
  const hasEnvCredentials = /process\.env\.USER_LOGIN|process\.env\.USER_PASSWORD/i.test(script);
  check('script_env_credentials',
    hasEnvCredentials,
    hasEnvCredentials
      ? 'Reads credentials from process.env (automated login)'
      : 'Does not read credentials from process.env — automated login requires USER_LOGIN_<PLATFORM> and USER_PASSWORD_<PLATFORM>',
    'warning');

  // Automated login: fills form programmatically (optional with three-tier login)
  const hasFormFill = /\.value\s*=|nativeInputValueSetter/i.test(script);
  check('script_automated_form_fill',
    hasFormFill,
    hasFormFill
      ? 'Has automated form fill logic (sets input values)'
      : 'No automated form fill detected — OK if using session capture or manual login fallback',
    'warning');

  // Manual login (legacy pattern — optional for auto-login connectors)
  const hasShowBrowser = /page\.showBrowser/.test(script);
  const hasPromptUser = /page\.promptUser/.test(script);
  check('script_show_browser', hasShowBrowser,
    hasShowBrowser
      ? 'Has page.showBrowser() (manual login fallback)'
      : 'No page.showBrowser() — OK if using automated login',
    hasEnvCredentials ? 'warning' : 'error');
  check('script_prompt_user', hasPromptUser,
    hasPromptUser
      ? 'Has page.promptUser() (manual login fallback)'
      : 'No page.promptUser() — OK if using automated login',
    hasEnvCredentials ? 'warning' : 'error');

  // Phase 2: Go headless
  check('script_go_headless',
    /page\.goHeadless/.test(script),
    'Calls page.goHeadless() before data collection',
    'warning');

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

  // ── Honest contract script checks ──

  // requestedScopes in result construction
  const hasRequestedScopes = /requestedScopes/.test(script);
  check('script_requested_scopes',
    hasRequestedScopes,
    hasRequestedScopes
      ? 'References requestedScopes in result'
      : 'No requestedScopes found — retrofitted connectors must include requestedScopes in the result',
    'warning');

  // errors array in result construction
  const hasErrorsArray = /\berrors\s*:/.test(script) || /\berrors\s*=\s*\[/.test(script);
  check('script_errors_array',
    hasErrorsArray,
    hasErrorsArray
      ? 'Builds errors array in result'
      : 'No errors[] construction found — retrofitted connectors must include errors in the result',
    'warning');

  // Common mistake: function reference in page.evaluate instead of string
  const evalLines = script.split('\n').filter(l => l.includes('page.evaluate'));
  const badEvals = evalLines.filter(l => {
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

  return script;
}

// ─── Schema Validation ──────────────────────────────────────

function resolveSchemaPath(connectorDir, scopeName) {
  return path.join(connectorDir, 'schemas', `${scopeName}.json`);
}

function validateSchemas(metadata, connectorDir, check) {
  if (!metadata?.scopes || !Array.isArray(metadata.scopes)) {
    check('schemas_declared', false,
      'No scopes array in metadata — cannot validate schemas. Add scopes to metadata or create schemas manually.',
      'warning');
    return;
  }

  for (const scope of metadata.scopes) {
    const scopeName = scope.scope || scope.name;
    if (!scopeName) continue;

    const schemaPath = resolveSchemaPath(connectorDir, scopeName);
    check(`schema_exists_${scopeName}`,
      fs.existsSync(schemaPath),
      fs.existsSync(schemaPath)
        ? `Schema found: ${path.relative(process.cwd(), schemaPath)}`
        : `Schema missing: ${path.relative(process.cwd(), schemaPath)}`);

    if (fs.existsSync(schemaPath)) {
      try {
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
        const hasStructure = schema.name && schema.scope && schema.schema;
        check(`schema_structure_${scopeName}`,
          hasStructure,
          hasStructure
            ? `Schema has required fields (name, scope, schema)`
            : 'Schema missing required top-level fields (name, scope, schema)');
      } catch (e) {
        check(`schema_json_${scopeName}`, false, `Schema is not valid JSON: ${e.message}`);
      }
    }
  }
}

// ─── Protocol Violation Detection ───────────────────────────

function detectProtocolViolations(result) {
  const violations = [];

  // requestedScopes must be present, non-empty array
  if (!result.requestedScopes) {
    violations.push('requestedScopes is missing');
  } else if (!Array.isArray(result.requestedScopes)) {
    violations.push('requestedScopes is not an array');
  } else if (result.requestedScopes.length === 0) {
    violations.push('requestedScopes is empty');
  } else {
    // Check for duplicates
    const unique = new Set(result.requestedScopes);
    if (unique.size !== result.requestedScopes.length) {
      violations.push('requestedScopes contains duplicates');
    }
    // Check all entries are strings
    for (const s of result.requestedScopes) {
      if (typeof s !== 'string') {
        violations.push(`requestedScopes contains non-string entry: ${JSON.stringify(s)}`);
      }
    }
  }

  // errors must be present and an array
  if (!('errors' in result)) {
    violations.push('errors is missing');
  } else if (!Array.isArray(result.errors)) {
    violations.push('errors is not an array');
  }

  // Required metadata fields
  for (const key of ['timestamp', 'version', 'platform', 'exportSummary']) {
    if (result[key] === undefined || result[key] === null) {
      violations.push(`Missing required metadata field: ${key}`);
    }
  }

  // Scope keys produced outside requestedScopes
  if (Array.isArray(result.requestedScopes)) {
    const requested = new Set(result.requestedScopes);
    for (const key of Object.keys(result)) {
      if (RESERVED_METADATA_KEYS.has(key)) continue;
      if (key.includes('.') && !requested.has(key)) {
        violations.push(`Scope key "${key}" produced outside requestedScopes`);
      }
    }
  }

  return violations;
}

// ─── Error Entry Validation ─────────────────────────────────

function validateErrorEntries(errors, check, strict) {
  if (!Array.isArray(errors)) return;

  for (let i = 0; i < errors.length; i++) {
    const entry = errors[i];
    const prefix = `errors[${i}]`;

    // Required fields
    const hasErrorClass = entry.errorClass && typeof entry.errorClass === 'string';
    check(`${prefix}_errorClass`, hasErrorClass,
      hasErrorClass
        ? `errorClass: "${entry.errorClass}"`
        : `${prefix}: missing or invalid errorClass`);

    if (hasErrorClass) {
      check(`${prefix}_errorClass_valid`, VALID_ERROR_CLASSES.has(entry.errorClass),
        VALID_ERROR_CLASSES.has(entry.errorClass)
          ? `errorClass "${entry.errorClass}" is in the shared taxonomy`
          : `errorClass "${entry.errorClass}" is not in the shared taxonomy: ${[...VALID_ERROR_CLASSES].join(', ')}`,
        strict ? 'error' : 'warning');
    }

    const hasReason = entry.reason && typeof entry.reason === 'string';
    check(`${prefix}_reason`, hasReason,
      hasReason
        ? `reason: "${entry.reason.substring(0, 80)}"`
        : `${prefix}: missing or invalid reason`);

    const hasDisposition = entry.disposition && typeof entry.disposition === 'string';
    check(`${prefix}_disposition`, hasDisposition,
      hasDisposition
        ? `disposition: "${entry.disposition}"`
        : `${prefix}: missing disposition`);

    if (hasDisposition) {
      check(`${prefix}_disposition_valid`, VALID_DISPOSITIONS.has(entry.disposition),
        VALID_DISPOSITIONS.has(entry.disposition)
          ? `disposition "${entry.disposition}" is valid`
          : `disposition "${entry.disposition}" must be one of: omitted, degraded, fatal`);

      // omitted and degraded require scope
      if (entry.disposition === 'omitted' || entry.disposition === 'degraded') {
        const hasScope = entry.scope && typeof entry.scope === 'string';
        check(`${prefix}_scope_required`, hasScope,
          hasScope
            ? `scope: "${entry.scope}"`
            : `${prefix}: disposition "${entry.disposition}" requires a scope field`);
      }
    }

    // Phase is optional but should be from the stable set if present
    if (entry.phase) {
      check(`${prefix}_phase_valid`, VALID_PHASES.has(entry.phase),
        VALID_PHASES.has(entry.phase)
          ? `phase: "${entry.phase}"`
          : `phase "${entry.phase}" is not in the preferred set (${[...VALID_PHASES].join(', ')}) — non-blocking`,
        'warning');
    }
  }
}

// ─── Output Validation ──────────────────────────────────────

function validateOutput(resultPath, metadata, connectorDir, check, strict) {
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

  // ── Honest contract validation ──

  // Detect whether this result uses the honest contract
  const hasRequestedScopes = Array.isArray(result.requestedScopes);
  const hasErrors = Array.isArray(result.errors);
  const isHonestContract = hasRequestedScopes && hasErrors;

  // In non-strict mode, missing requestedScopes/errors is a warning (transitional)
  // In strict mode, it's an error (protocol violation)
  const contractSeverity = strict ? 'error' : 'warning';

  check('result_requested_scopes', hasRequestedScopes,
    hasRequestedScopes
      ? `requestedScopes: [${result.requestedScopes.join(', ')}]`
      : 'Missing requestedScopes — retrofitted connectors must include requestedScopes',
    contractSeverity);

  check('result_errors_array', hasErrors,
    hasErrors
      ? `errors: ${result.errors.length} entries`
      : 'Missing errors[] — retrofitted connectors must include errors array',
    contractSeverity);

  // Protocol violation detection (only when the honest contract is present)
  if (isHonestContract) {
    const violations = detectProtocolViolations(result);
    check('result_protocol_violations', violations.length === 0,
      violations.length === 0
        ? 'No protocol violations detected'
        : `Protocol violations: ${violations.join('; ')}`);

    // Validate error entries
    validateErrorEntries(result.errors, check, strict);

    // Scope membership: every produced scope key must be in requestedScopes
    const requested = new Set(result.requestedScopes);
    const scopedKeys = Object.keys(result).filter(
      k => !RESERVED_METADATA_KEYS.has(k) && k.includes('.')
    );

    for (const key of scopedKeys) {
      check(`result_scope_membership_${key}`, requested.has(key),
        requested.has(key)
          ? `Scope "${key}" is a member of requestedScopes`
          : `Scope "${key}" produced outside requestedScopes — protocol violation`);
    }

    // Check for omitted scopes: requested but not produced and no omitted error
    const producedScopes = new Set(scopedKeys);
    const omittedInErrors = new Set(
      result.errors
        .filter(e => e.disposition === 'omitted' && e.scope)
        .map(e => e.scope)
    );
    const degradedInErrors = new Set(
      result.errors
        .filter(e => e.disposition === 'degraded' && e.scope)
        .map(e => e.scope)
    );

    for (const scope of result.requestedScopes) {
      if (!producedScopes.has(scope) && !omittedInErrors.has(scope)) {
        check(`result_scope_accounted_${scope}`, false,
          `Requested scope "${scope}" is neither produced nor reported as omitted in errors[]`,
          strict ? 'error' : 'warning');
      }
      if (producedScopes.has(scope) && omittedInErrors.has(scope)) {
        check(`result_scope_conflict_${scope}`, false,
          `Scope "${scope}" is both produced and reported as omitted — contradictory`);
      }
    }

    // Scope-level summary
    check('result_scope_summary', true,
      `Scope summary: ${requested.size} requested, ${producedScopes.size} produced, ${degradedInErrors.size} degraded, ${omittedInErrors.size} omitted`);

  } else {
    // Legacy result — fall through to the original scope-based checks
    check('result_honest_contract', false,
      'Result does not use the honest contract (missing requestedScopes and/or errors[]). ' +
      'Retrofitted connectors should include both.',
      'warning');
  }

  // ── Common checks (both legacy and honest) ──

  // Identify scoped keys
  const scopedKeys = Object.keys(result).filter(
    k => k.includes('.') && !RESERVED_METADATA_KEYS.has(k)
  );

  check('result_has_scopes', scopedKeys.length > 0,
    scopedKeys.length > 0
      ? `${scopedKeys.length} scope(s): ${scopedKeys.join(', ')}`
      : 'No scoped keys found in result');

  // Validate each scope has data
  for (const key of scopedKeys) {
    const data = result[key];
    const isEmpty = data === null || data === undefined ||
      (typeof data === 'object' && Object.keys(data).length === 0);

    // Under the honest contract, empty-but-present scope payloads are valid
    if (isHonestContract) {
      check(`result_${key}_present`, true,
        isEmpty ? `Scope "${key}" is present but empty (valid under honest contract)` : `Scope "${key}" has data`);
    } else {
      check(`result_${key}_not_empty`, !isEmpty,
        isEmpty ? `Scope "${key}" is empty` : `Scope "${key}" has data`);
    }

    // Count items in arrays
    if (data && typeof data === 'object') {
      for (const [field, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
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
  for (const key of scopedKeys) {
    const schemaPath = resolveSchemaPath(connectorDir, key);
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

  // Sanity check: if we expected scopes from metadata, check they all appeared.
  // Under the honest contract, a scope validly omitted via errors[] is accounted for.
  if (metadata?.scopes && Array.isArray(metadata.scopes)) {
    const omittedInResult = isHonestContract
      ? new Set(
          result.errors
            .filter(e => e.disposition === 'omitted' && e.scope)
            .map(e => e.scope)
        )
      : new Set();

    for (const scope of metadata.scopes) {
      const scopeName = scope.scope || scope.name;
      if (!scopeName) continue;

      const produced = scopedKeys.includes(scopeName);
      const honestlyOmitted = omittedInResult.has(scopeName);

      check(`result_expected_scope_${scopeName}`,
        produced || honestlyOmitted,
        produced
          ? `Expected scope "${scopeName}" present in output`
          : honestlyOmitted
            ? `Expected scope "${scopeName}" honestly omitted via errors[]`
            : `Expected scope "${scopeName}" missing from output`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Connector Validator — validates structure and output of data connectors.

Understands the canonical honest connector result contract:
  - requestedScopes, errors[], reserved metadata keys
  - omitted / degraded / fatal dispositions
  - protocol violation detection

Usage:
  node scripts/validate-connector.cjs <connector.js>
  node scripts/validate-connector.cjs <connector.js> --check-result <result.json>
  node scripts/validate-connector.cjs <connector.js> --check-result <result.json> --strict

Flags:
  --check-result <file>  Also validate connector output data
  --strict               Treat missing honest contract fields as errors (not warnings)
  --help, -h             Show this help

Output: JSON report to stdout. Exit code 0 = valid, 1 = invalid.
`);
    process.exit(0);
  }

  const connectorPath = path.resolve(args[0]);
  let resultPath = null;
  let strict = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--check-result' && args[i + 1]) {
      resultPath = path.resolve(args[++i]);
    } else if (args[i] === '--strict') {
      strict = true;
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

  if (resultPath) {
    validateOutput(resultPath, metadata, connectorDir, check, strict);
  }

  // Output
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.valid ? 0 : 1);
}

main();
