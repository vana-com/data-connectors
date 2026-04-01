#!/usr/bin/env node

import { readFile, readdir } from "fs/promises";
import { join, basename } from "path";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(name) {
  return args.includes(name);
}

function getOption(name, fallback) {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const jsonOutput = getFlag("--json");
const localOnly = getFlag("--local-only");
const gatewayUrl = getOption(
  "--gateway-url",
  process.env.GATEWAY_URL || ""
);

// ---------------------------------------------------------------------------
// Resolve repo root (script lives in scripts/ under the repo root)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function queryGateway(scope) {
  const url = `${gatewayUrl}/v1/schemas?scope=${encodeURIComponent(scope)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 200) {
      const body = await res.json();
      return { status: "registered", data: body.data ?? null };
    }
    if (res.status === 404) {
      return { status: "missing", data: null };
    }
    return { status: "error", data: null, error: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "error", data: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Validate args
// ---------------------------------------------------------------------------

if (!localOnly && !gatewayUrl) {
  process.stderr.write(
    "Error: Gateway URL required. Set GATEWAY_URL env var or pass --gateway-url, or use --local-only.\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// 1. Read registry.json
const registry = await readJson(join(REPO_ROOT, "registry.json"));
const connectors = registry.connectors;

// 2-4. Gather scopes from each connector's metadata
// Map: scope -> first connector id that declares it (for reporting)
const scopeToConnector = new Map();

for (const connector of connectors) {
  const metadataPath = join(REPO_ROOT, connector.files.metadata);
  let metadata;
  try {
    metadata = await readJson(metadataPath);
  } catch (err) {
    process.stderr.write(
      `Warning: could not read metadata for ${connector.id}: ${err.message}\n`
    );
    continue;
  }

  if (!Array.isArray(metadata.scopes)) continue;

  for (const entry of metadata.scopes) {
    if (!scopeToConnector.has(entry.scope)) {
      scopeToConnector.set(entry.scope, connector.id);
    }
  }
}

// 5. Scan schemas/ directory for orphaned schema detection
const schemaDir = join(REPO_ROOT, "schemas");
let schemaFiles;
try {
  schemaFiles = (await readdir(schemaDir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
} catch {
  schemaFiles = [];
}

const declaredScopes = new Set(scopeToConnector.keys());
const orphanedSchemas = schemaFiles.filter((s) => !declaredScopes.has(s));

// ---------------------------------------------------------------------------
// Three-way checks
// ---------------------------------------------------------------------------

const scopeResults = [];

for (const [scope, connectorId] of scopeToConnector) {
  const schemaFileExists = schemaFiles.includes(scope);

  let gatewayStatus = "skipped";
  let schemaId = null;
  let gatewayError = null;
  let consistent = schemaFileExists; // baseline: schema file must exist

  if (!localOnly) {
    const gw = await queryGateway(scope);
    if (gw.status === "registered") {
      gatewayStatus = "registered";
      schemaId = gw.data?.id?.toString() ?? null;
      // Check 3: verify scope field matches
      const gwScope = gw.data?.scope;
      if (gwScope && gwScope !== scope) {
        gatewayStatus = "scope-mismatch";
        consistent = false;
      } else {
        consistent = consistent && true;
      }
    } else if (gw.status === "missing") {
      gatewayStatus = "missing";
      consistent = false;
    } else {
      gatewayStatus = "error";
      consistent = false;
    }

    // Capture error message if present
    if (gw.error) {
      gatewayError = gw.error;
    }
  }

  scopeResults.push({
    scope,
    connector: connectorId,
    schemaFileExists,
    gatewayStatus,
    ...(schemaId != null ? { schemaId } : {}),
    ...(gatewayError != null ? { gatewayError } : {}),
    consistent,
  });
}

// ---------------------------------------------------------------------------
// Summarise
// ---------------------------------------------------------------------------

const missingSchemaFile = scopeResults.filter((r) => !r.schemaFileExists);
const missingGateway = scopeResults.filter(
  (r) => r.gatewayStatus === "missing"
);
const gatewayErrors = scopeResults.filter((r) => r.gatewayStatus === "error");
const fullyConsistent = scopeResults.filter((r) => r.consistent);

const summary = {
  total: scopeResults.length,
  fullyConsistent: fullyConsistent.length,
  missingSchemaFile: missingSchemaFile.length,
  missingGateway: missingGateway.length,
  gatewayErrors: gatewayErrors.length,
  orphanedSchemas: orphanedSchemas.length,
};

const issueCount =
  summary.missingSchemaFile +
  summary.missingGateway +
  summary.gatewayErrors +
  summary.orphanedSchemas;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonOutput) {
  const report = {
    gateway: gatewayUrl,
    timestamp: new Date().toISOString(),
    summary,
    scopes: scopeResults,
    orphanedSchemas,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// Human-readable summary always goes to stderr
if (issueCount === 0) {
  process.stderr.write(
    `Schema health check PASSED: all ${summary.total} scopes are consistent.\n`
  );
} else {
  process.stderr.write(
    `Schema health check FAILED: ${issueCount} issue(s) found\n\n`
  );

  if (missingSchemaFile.length > 0) {
    process.stderr.write("Missing local schema files:\n");
    for (const r of missingSchemaFile) {
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector})\n`);
    }
    process.stderr.write("\n");
  }

  if (missingGateway.length > 0) {
    process.stderr.write("Not registered in Gateway:\n");
    for (const r of missingGateway) {
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector})\n`);
    }
    process.stderr.write("\n");
  }

  if (gatewayErrors.length > 0) {
    process.stderr.write("Gateway errors:\n");
    for (const r of gatewayErrors) {
      const detail = r.gatewayError ? `: ${r.gatewayError}` : "";
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector})${detail}\n`);
    }
    process.stderr.write("\n");
  }

  if (orphanedSchemas.length > 0) {
    process.stderr.write(
      "Orphaned schema files (no connector declares this scope):\n"
    );
    for (const s of orphanedSchemas) {
      process.stderr.write(`  - schemas/${s}.json\n`);
    }
    process.stderr.write("\n");
  }

  process.stderr.write(
    "These issues must be resolved before connectors can be used by Personal Servers.\n"
  );
}

process.exit(issueCount === 0 ? 0 : 1);
