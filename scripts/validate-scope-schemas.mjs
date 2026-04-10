#!/usr/bin/env node
// Validate that every scope declared in a manifest has a matching
// schema file under schemas/ (or under connectors/<platform>/schemas/).
//
// Acceptance target:
//   HC-RESULT-CONTRACT-001 — every public scope has a declared JSON schema.
//
// Usage: node scripts/validate-scope-schemas.mjs

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function findManifests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...findManifests(full));
    } else if (entry.endsWith("-playwright.json")) {
      out.push(full);
    }
  }
  return out;
}

function findSchemaFiles() {
  const out = new Map();
  function walk(d) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(".")) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".json") && entry !== "manifest.schema.json") {
        try {
          const parsed = JSON.parse(readFileSync(full, "utf8"));
          if (parsed && typeof parsed.scope === "string") {
            out.set(parsed.scope, full);
          }
        } catch {
          // ignore non-schema json
        }
      }
    }
  }
  walk(join(repoRoot, "schemas"));
  walk(join(repoRoot, "connectors"));
  return out;
}

function extractScopes(manifest) {
  if (!Array.isArray(manifest.scopes)) return [];
  return manifest.scopes
    .map((s) => (typeof s === "string" ? s : s && s.scope))
    .filter(Boolean);
}

function loadRegistryConnectorIds() {
  const registryPath = join(repoRoot, "registry.json");
  if (!existsSync(registryPath)) return null;
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!Array.isArray(registry.connectors)) return null;
    return new Set(registry.connectors.map((c) => c.id));
  } catch {
    return null;
  }
}

function main() {
  const manifests = findManifests(join(repoRoot, "connectors"));
  const schemasByScope = findSchemaFiles();
  // Only enforce coverage for connectors that are distributed via registry.json.
  // Unregistered/experimental connectors in the tree are not held to the
  // public-contract bar until they ship.
  const registeredIds = loadRegistryConnectorIds();
  const errors = [];
  let checked = 0;

  for (const path of manifests) {
    const rel = path.replace(repoRoot + "/", "");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (registeredIds && parsed.connector_id && !registeredIds.has(parsed.connector_id)) {
      // Not in registry yet — skip (still validate basic manifest shape elsewhere).
      continue;
    }
    checked++;
    for (const scope of extractScopes(parsed)) {
      if (!schemasByScope.has(scope)) {
        errors.push(`${rel}: declares scope "${scope}" but no schema file exists`);
      }
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(`\nScope/schema coverage failed: ${errors.length} errors.`);
    process.exit(1);
  }

  console.log(
    `Scope coverage OK: ${checked} registered manifest(s) against ${schemasByScope.size} schema(s).`,
  );
}

main();
