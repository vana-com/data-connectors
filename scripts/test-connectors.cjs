#!/usr/bin/env node
/**
 * test-connectors.cjs — Batch smoke test for data connectors.
 *
 * Wraps run-connector.cjs to run each connector headlessly, validates output
 * against declared scopes, and reports per-connector health.
 *
 * Usage:
 *   node scripts/test-connectors.cjs [options]
 *
 * Options:
 *   --connectors <id>,<id>  Override default connector set (comma-separated IDs)
 *   --include-beta          Include beta connectors (default: stable only)
 *   --validate-schemas      Validate result data against schemas/*.json
 *
 * Exit codes: 0 all pass/warn, 1 any fail/auth/timeout
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'registry.json');
const CONNECTORS_DIR = path.join(ROOT, 'connectors');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const RUN_CONNECTOR = path.join(ROOT, 'run-connector.cjs');

// ─── ANSI Colors ────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ─── Arg Parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { connectors: null, includeBeta: false, validateSchemas: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--connectors' && argv[i + 1]) {
      opts.connectors = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (argv[i] === '--include-beta') {
      opts.includeBeta = true;
    } else if (argv[i] === '--validate-schemas') {
      opts.validateSchemas = true;
    }
  }
  return opts;
}

// ─── Connector Resolution ───────────────────────────────────

function resolveConnectors(registry, opts) {
  if (opts.connectors) {
    return opts.connectors.map(id => {
      const entry = registry.connectors.find(c => c.id === id);
      if (!entry) throw new Error(`Connector not found in registry: ${id}`);
      return entry;
    });
  }
  const allowed = opts.includeBeta ? ['stable', 'beta'] : ['stable'];
  return registry.connectors.filter(c => allowed.includes(c.status));
}

// ─── Lightweight JSON Schema Validator ──────────────────────
// Validates required fields and basic types. Not a full JSON Schema
// implementation — just enough for smoke testing connector output.

function validateSchema(data, schema) {
  const errors = [];
  if (!schema || schema.type !== 'object' || !schema.properties) return errors;

  // Check required fields
  for (const field of (schema.required || [])) {
    if (!(field in data) || data[field] === undefined || data[field] === null) {
      errors.push(`Required field missing: ${field}`);
    }
  }

  // Check types of present fields
  for (const [field, spec] of Object.entries(schema.properties)) {
    if (!(field in data) || data[field] === null || data[field] === undefined) continue;
    const value = data[field];
    const expectedType = spec.type;
    if (!expectedType) continue;

    let actual;
    if (Array.isArray(value)) actual = 'array';
    else actual = typeof value;

    if (expectedType === 'array' && actual !== 'array') {
      errors.push(`${field}: expected array, got ${actual}`);
    } else if (expectedType !== 'array' && actual !== expectedType) {
      errors.push(`${field}: expected ${expectedType}, got ${actual}`);
    }
  }

  return errors;
}

// ─── Outcome Classification ─────────────────────────────────

function classifyOutcome(exitCode, stdoutLines) {
  if (exitCode === 2) return { status: 'auth', error: 'need-input: connector requires credentials' };
  if (exitCode === 3) return { status: 'auth', error: 'legacy-auth: connector uses headed login not supported in batch mode' };
  if (exitCode === 1) {
    const isTimeout = stdoutLines.some(line => {
      try {
        const msg = JSON.parse(line);
        return msg.type === 'error' && msg.message && msg.message.includes('Timeout after 5 minutes');
      } catch { return false; }
    });
    return isTimeout
      ? { status: 'timeout', error: 'Timed out after 5 minutes' }
      : { status: 'fail', error: 'Connector exited with error' };
  }
  if (exitCode === 0) return { status: 'needs-validation' };
  return { status: 'fail', error: `Unknown exit code: ${exitCode}` };
}

// ─── Result Validation ──────────────────────────────────────

function validateResult(data, metadata) {
  const expectedScopes = (metadata.scopes || []).map(s => s.scope);
  const scopesFound = [];
  const scopesMissing = [];
  const warnings = [];

  for (const scope of expectedScopes) {
    const bareSuffix = scope.includes('.') ? scope.split('.').slice(1).join('.') : null;
    const value = scope in data ? data[scope] : (bareSuffix && bareSuffix in data ? data[bareSuffix] : undefined);

    if (value === undefined || value === null) {
      scopesMissing.push(scope);
      continue;
    }

    scopesFound.push(scope);

    if (Array.isArray(value) && value.length === 0) {
      warnings.push(`${scope}: empty array`);
    } else if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      warnings.push(`${scope}: empty object`);
    }
  }

  if (scopesMissing.length > 0) {
    return { status: 'fail', scopesFound, scopesMissing, warnings };
  }
  if (warnings.length > 0) {
    return { status: 'warn', scopesFound, scopesMissing, warnings };
  }
  return { status: 'pass', scopesFound, scopesMissing, warnings };
}

// ─── Run a single connector via run-connector.cjs ───────────

function runConnector(connectorEntry, opts) {
  return new Promise((resolve) => {
    const scriptPath = path.join(ROOT, connectorEntry.files.script);
    const metadataPath = scriptPath.replace(/\.js$/, '.json');
    const outputPath = path.join(RESULTS_DIR, `${connectorEntry.id}.json`);

    // Load metadata for connectURL and scope info
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); } catch {}
    const startUrl = metadata.connectURL || 'about:blank';

    // Delete stale result file
    try { fs.unlinkSync(outputPath); } catch {}

    const startTime = Date.now();
    const stdoutLines = [];

    const child = spawn(process.execPath, [
      RUN_CONNECTOR, scriptPath, startUrl, '--output', outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) stdoutLines.push(line.trim());
      }
    });

    // Suppress stderr (runner debug output)
    child.stderr.on('data', () => {});

    child.on('close', (exitCode) => {
      const duration = Date.now() - startTime;
      const outcome = classifyOutcome(exitCode || 0, stdoutLines);

      if (outcome.status === 'needs-validation') {
        // Read and validate result file
        let data = null;
        try { data = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); } catch {}

        if (!data) {
          resolve({ connector: connectorEntry.id, status: 'fail', exitCode: 0, duration, error: 'No result file produced' });
          return;
        }

        const validation = validateResult(data, metadata);

        // Optional schema validation
        let schemaErrors = [];
        if (opts.validateSchemas) {
          const schemasDir = path.join(ROOT, 'schemas');
          for (const scope of validation.scopesFound) {
            const schemaPath = path.join(schemasDir, `${scope}.json`);
            if (!fs.existsSync(schemaPath)) continue;
            try {
              const schemaFile = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
              const scopeKey = scope in data ? scope : scope.split('.').slice(1).join('.');
              const errs = validateSchema(data[scopeKey], schemaFile.schema);
              schemaErrors.push(...errs.map(e => `${scope}: ${e}`));
            } catch {}
          }
        }

        resolve({
          connector: connectorEntry.id,
          status: validation.status,
          exitCode: 0,
          duration,
          scopesExpected: (metadata.scopes || []).map(s => s.scope),
          scopesFound: validation.scopesFound,
          scopesMissing: validation.scopesMissing,
          warnings: validation.warnings.length > 0 ? validation.warnings : undefined,
          schemaErrors: schemaErrors.length > 0 ? schemaErrors : undefined,
        });
      } else {
        resolve({
          connector: connectorEntry.id,
          status: outcome.status,
          exitCode: exitCode || 0,
          duration,
          error: outcome.error,
        });
      }
    });
  });
}

// ─── Reporting ──────────────────────────────────────────────

function printResults(results) {
  const timestamp = new Date().toISOString();
  console.log(`\n${c.bold}Connector Smoke Test${c.reset} ${c.dim}— ${timestamp}${c.reset}\n`);

  for (const r of results) {
    const dur = (r.duration / 1000).toFixed(1) + 's';
    const scopeCount = r.scopesExpected
      ? `${r.scopesFound.length}/${r.scopesExpected.length} scopes`
      : '—';

    let detail = '';
    if (r.warnings && r.warnings.length > 0) detail = `  (${r.warnings.join(', ')})`;
    if (r.scopesMissing && r.scopesMissing.length > 0) detail = `  (missing: ${r.scopesMissing.join(', ')})`;
    if (r.error) detail = `  (${r.error})`;

    let statusStr;
    switch (r.status) {
      case 'pass':    statusStr = `${c.green}PASS${c.reset}   `; break;
      case 'warn':    statusStr = `${c.yellow}WARN${c.reset}   `; break;
      case 'auth':    statusStr = `${c.magenta}AUTH${c.reset}   `; break;
      case 'fail':    statusStr = `${c.red}FAIL${c.reset}   `; break;
      case 'timeout': statusStr = `${c.red}TIMEOUT${c.reset}`; break;
      default:        statusStr = `${c.gray}???${c.reset}    `;
    }

    const id = r.connector.padEnd(28);
    const sc = scopeCount.padEnd(14);
    console.log(`  ${statusStr} ${id} ${sc} ${dur}${c.dim}${detail}${c.reset}`);
  }

  const counts = { pass: 0, warn: 0, auth: 0, fail: 0, timeout: 0 };
  let totalDuration = 0;
  for (const r of results) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    totalDuration += r.duration;
  }

  const parts = [];
  if (counts.pass) parts.push(`${c.green}${counts.pass} pass${c.reset}`);
  if (counts.warn) parts.push(`${c.yellow}${counts.warn} warn${c.reset}`);
  if (counts.auth) parts.push(`${c.magenta}${counts.auth} auth${c.reset}`);
  if (counts.fail) parts.push(`${c.red}${counts.fail} fail${c.reset}`);
  if (counts.timeout) parts.push(`${c.red}${counts.timeout} timeout${c.reset}`);

  console.log(`\n${parts.join(' · ')} — ${(totalDuration / 1000).toFixed(1)}s total\n`);

  return counts;
}

function writeJsonReport(results) {
  const timestamp = new Date().toISOString();
  const counts = { pass: 0, warn: 0, auth: 0, fail: 0, timeout: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  const report = {
    timestamp,
    summary: { ...counts, total: results.length },
    results,
  };

  const reportPath = path.join(RESULTS_DIR, `connector-smoke-${timestamp.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`${c.dim}Report: ${reportPath}${c.reset}\n`);
  return reportPath;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Load registry
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`${c.red}Registry not found: ${REGISTRY_PATH}${c.reset}`);
    process.exit(1);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

  // Resolve connectors
  const connectors = resolveConnectors(registry, opts);
  if (connectors.length === 0) {
    console.error(`${c.red}No connectors matched.${c.reset}`);
    process.exit(1);
  }

  // Ensure results directory
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Verify run-connector.cjs exists
  if (!fs.existsSync(RUN_CONNECTOR)) {
    console.error(`${c.red}run-connector.cjs not found: ${RUN_CONNECTOR}${c.reset}`);
    process.exit(1);
  }

  // Run connectors sequentially (each needs its own browser)
  const results = [];
  for (const entry of connectors) {
    const label = `${c.cyan}${entry.name}${c.reset} ${c.dim}(${entry.id})${c.reset}`;
    process.stdout.write(`  Running ${label}...`);
    const result = await runConnector(entry, opts);
    // Clear the "Running..." line
    process.stdout.write('\r\x1b[K');
    results.push(result);
  }

  // Report
  const counts = printResults(results);
  writeJsonReport(results);

  // Exit 1 if any fail/auth/timeout
  const hasFailure = counts.fail > 0 || counts.auth > 0 || counts.timeout > 0;
  process.exit(hasFailure ? 1 : 0);
}

// ─── Exports for testing ────────────────────────────────────

if (require.main !== module) {
  module.exports = { parseArgs, resolveConnectors, classifyOutcome, validateResult, validateSchema };
} else {
  main().catch((err) => {
    console.error(`${c.red}Fatal: ${err.message}${c.reset}`);
    process.exit(1);
  });
}
