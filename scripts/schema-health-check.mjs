#!/usr/bin/env node

import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { execSync } from "child_process";

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
const baseRef = getOption("--base-ref", "origin/main");

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

function readGitJson(ref, relativePath) {
  try {
    const raw = execSync(`git show ${ref}:${relativePath}`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
// Discover base-branch scopes (for new-scope detection)
// ---------------------------------------------------------------------------

const baseScopeSet = new Set();
const baseRegistry = readGitJson(baseRef, "registry.json");
if (baseRegistry?.connectors) {
  for (const connector of baseRegistry.connectors) {
    const metadata = readGitJson(baseRef, `connectors/${connector.files.metadata}`);
    if (metadata?.scopes) {
      for (const entry of metadata.scopes) {
        baseScopeSet.add(entry.scope);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery (current branch)
// ---------------------------------------------------------------------------

// 1. Read registry.json
const registry = await readJson(join(REPO_ROOT, "registry.json"));
const connectors = registry.connectors;

// 2-4. Gather scopes from each connector's metadata
// Map: scope -> first connector id that declares it (for reporting)
const scopeToConnector = new Map();

for (const connector of connectors) {
  const metadataPath = join(REPO_ROOT, "connectors", connector.files.metadata);
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
  const isNew = !baseScopeSet.has(scope);

  let gatewayStatus = "skipped";
  let schemaId = null;
  let gatewayError = null;
  let metadataMismatches = [];
  let consistent = schemaFileExists; // baseline: schema file must exist

  if (!localOnly) {
    const gw = await queryGateway(scope);
    if (gw.status === "registered") {
      gatewayStatus = "registered";
      schemaId = gw.data?.id?.toString() ?? null;

      // Check 3: metadata comparison
      const gwData = gw.data;
      if (gwData) {
        // Compare scope field
        const gwScope = gwData.scope || null;
        if (gwScope !== scope) {
          const g = gwScope ?? "(missing)";
          metadataMismatches.push(`scope: local="${scope}" gateway="${g}"`);
        }

        // Compare against local schema file metadata if it exists
        if (schemaFileExists) {
          try {
            const localSchema = await readJson(join(schemaDir, `${scope}.json`));
            const localName = localSchema.name || null;
            const gwName = gwData.name || null;
            if (localName !== gwName) {
              const l = localName ?? "(missing)";
              const g = gwName ?? "(missing)";
              metadataMismatches.push(`name: local="${l}" gateway="${g}"`);
            }
            const localDialect = localSchema.dialect || null;
            const gwDialect = gwData.dialect || null;
            if (localDialect !== gwDialect) {
              const l = localDialect ?? "(missing)";
              const g = gwDialect ?? "(missing)";
              metadataMismatches.push(`dialect: local="${l}" gateway="${g}"`);
            }
          } catch {
            // Schema file read failed — already flagged by schemaFileExists check
          }
        }
      }

      if (metadataMismatches.length > 0) {
        consistent = false;
      }
    } else if (gw.status === "missing") {
      gatewayStatus = "missing";
      consistent = false;
    } else {
      gatewayStatus = "error";
      consistent = false;
    }

    if (gw.error) {
      gatewayError = gw.error;
    }
  }

  scopeResults.push({
    scope,
    connector: connectorId,
    isNew,
    schemaFileExists,
    gatewayStatus,
    ...(schemaId != null ? { schemaId } : {}),
    ...(gatewayError != null ? { gatewayError } : {}),
    ...(metadataMismatches.length > 0 ? { metadataMismatches } : {}),
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
const metadataDrift = scopeResults.filter(
  (r) => r.metadataMismatches && r.metadataMismatches.length > 0
);
const fullyConsistent = scopeResults.filter((r) => r.consistent);

const summary = {
  total: scopeResults.length,
  fullyConsistent: fullyConsistent.length,
  missingSchemaFile: missingSchemaFile.length,
  missingGateway: missingGateway.length,
  gatewayErrors: gatewayErrors.length,
  metadataDrift: metadataDrift.length,
  orphanedSchemas: orphanedSchemas.length,
};

const issueCount =
  summary.missingSchemaFile +
  summary.missingGateway +
  summary.gatewayErrors +
  summary.metadataDrift +
  summary.orphanedSchemas;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonOutput) {
  const report = {
    gateway: localOnly ? null : gatewayUrl,
    baseRef,
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
      const tag = r.isNew ? " [added in this PR]" : "";
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector})${tag}\n`);
    }
    process.stderr.write("\n");
  }

  if (missingGateway.length > 0) {
    process.stderr.write("Not registered in Gateway:\n");
    for (const r of missingGateway) {
      const tag = r.isNew ? " [added in this PR]" : "";
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector})${tag}\n`);
    }
    process.stderr.write("\n");
  }

  if (metadataDrift.length > 0) {
    process.stderr.write("Metadata mismatch between local schema and Gateway:\n");
    for (const r of metadataDrift) {
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector}):\n`);
      for (const m of r.metadataMismatches) {
        process.stderr.write(`      ${m}\n`);
      }
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
