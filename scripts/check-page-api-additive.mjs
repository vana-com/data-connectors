#!/usr/bin/env node
// Detect removals and renames on the PageAPI interface in types/connector.d.ts.
// Fails if a method was present in the base revision but is missing in HEAD,
// unless PAGE_API_VERSION in types/page-api-version.ts has been bumped.
//
// Acceptance target:
//   HC-PHASE4-PAGE-API-ADDITIVE-001 — page API changes within a major version
//   are additive-only.
//
// Usage:
//   node scripts/check-page-api-additive.mjs
//   BASE_REF=origin/main node scripts/check-page-api-additive.mjs

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const typesPath = "types/connector.d.ts";
const versionPath = "types/page-api-version.ts";

function extractPageApiMethods(source) {
  // Find the PageAPI interface body and pull method names.
  const match = source.match(/export\s+interface\s+PageAPI\s*\{([\s\S]*?)\n\}/);
  if (!match) return null;
  const body = match[1];
  const methods = new Set();
  // Match lines that look like `methodName(...` at the start of a line
  // (ignoring doc comments and whitespace).
  const methodRegex = /^\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = methodRegex.exec(body)) !== null) {
    methods.add(m[1]);
  }
  return methods;
}

function extractPageApiVersion(source) {
  const m = source.match(/PAGE_API_VERSION\s*=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function getFileAtRef(ref, relPath) {
  try {
    return execSync(`git show ${ref}:${relPath}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function main() {
  const baseRef = process.env.BASE_REF || "origin/main";

  const headTypes = readFileSync(join(repoRoot, typesPath), "utf8");
  const baseTypes = getFileAtRef(baseRef, typesPath);

  if (!baseTypes) {
    console.log(`No base revision found at ${baseRef}:${typesPath} — skipping additive check.`);
    process.exit(0);
  }

  const baseMethods = extractPageApiMethods(baseTypes);
  const headMethods = extractPageApiMethods(headTypes);

  if (!baseMethods || !headMethods) {
    console.error("Could not locate PageAPI interface in one of the revisions.");
    process.exit(1);
  }

  const removed = [...baseMethods].filter((m) => !headMethods.has(m));
  const added = [...headMethods].filter((m) => !baseMethods.has(m));

  // Load current PAGE_API_VERSION from head.
  let headVersion = 1;
  if (existsSync(join(repoRoot, versionPath))) {
    const v = extractPageApiVersion(readFileSync(join(repoRoot, versionPath), "utf8"));
    if (v != null) headVersion = v;
  }
  const baseVersionSource = getFileAtRef(baseRef, versionPath);
  const baseVersion = baseVersionSource ? extractPageApiVersion(baseVersionSource) ?? 1 : 1;

  console.log(`Base: ${baseRef} (PAGE_API_VERSION=${baseVersion}, ${baseMethods.size} methods)`);
  console.log(`Head: PAGE_API_VERSION=${headVersion}, ${headMethods.size} methods`);
  if (added.length) console.log(`Added methods: ${added.join(", ")}`);
  if (removed.length) console.log(`Removed methods: ${removed.join(", ")}`);

  if (removed.length > 0 && headVersion === baseVersion) {
    console.error(
      `\nHC-PHASE4-PAGE-API-ADDITIVE-001 FAIL: ${removed.length} method(s) removed or renamed without a PAGE_API_VERSION bump:`,
    );
    for (const m of removed) console.error(`  - ${m}`);
    console.error(
      `\nEither re-add the method(s), or bump PAGE_API_VERSION in ${versionPath} and all manifests' page_api_version fields.`,
    );
    process.exit(1);
  }

  if (removed.length > 0 && headVersion > baseVersion) {
    console.log(
      `OK: removals present, but PAGE_API_VERSION bumped ${baseVersion} → ${headVersion}.`,
    );
  } else {
    console.log("OK: page API change is additive (or empty).");
  }
}

main();
