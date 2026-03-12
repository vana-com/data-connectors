#!/usr/bin/env node

/**
 * Connector Validator
 *
 * Validates connector files (structure) and optionally connector output (data quality).
 * Returns machine-readable JSON for use by automated agents in the create-test-validate loop.
 *
 * Usage:
 *   node scripts/validate-connector.cjs <connector.js>
 *   node scripts/validate-connector.cjs <connector.js> --check-result ./connector-result.json
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

// ─── Main ───────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Connector Validator — validates structure and output of data connectors.

Usage:
  node scripts/validate-connector.cjs <connector.js>
  node scripts/validate-connector.cjs <connector.js> --check-result <result.json>

Flags:
  --check-result <file>  Also validate connector output data
  --help, -h             Show this help

Output: JSON report to stdout. Exit code 0 = valid, 1 = invalid.
`);
    process.exit(0);
  }

  const connectorPath = path.resolve(args[0]);
  let resultPath = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--check-result' && args[i + 1]) {
      resultPath = path.resolve(args[++i]);
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
    validateOutput(resultPath, metadata, connectorDir, check);
  }

  // Output
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.valid ? 0 : 1);
}

main();
