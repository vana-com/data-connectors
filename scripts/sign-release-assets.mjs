#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "sigstore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const artifactsDir = join(repoRoot, "artifacts");
const indexPath = join(repoRoot, "connector-index.json");
const scopeCatalogPath = join(repoRoot, "scope-catalog.json");
const scopeCatalogSchemaPath = join(repoRoot, "schemas", "scope-catalog.schema.json");

function walkArtifacts(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walkArtifacts(full));
      continue;
    }
    if (full.endsWith(".tgz")) {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function bundlePathFor(subjectPath) {
  return `${subjectPath}.sigstore.json`;
}

async function signSubject(subjectPath) {
  const payload = readFileSync(subjectPath);
  const bundle = await sign(payload);
  writeFileSync(bundlePathFor(subjectPath), `${JSON.stringify(bundle, null, 2)}\n`);
}

async function main() {
  const publicContractPaths = [indexPath, scopeCatalogPath, scopeCatalogSchemaPath];
  for (const path of publicContractPaths) {
    if (!existsSync(path)) {
      throw new Error(`Missing ${path}`);
    }
  }

  const artifactPaths = walkArtifacts(artifactsDir);
  for (const staleBundle of walkArtifacts(artifactsDir).map(bundlePathFor)) {
    rmSync(staleBundle, { force: true });
  }
  for (const path of publicContractPaths) {
    rmSync(bundlePathFor(path), { force: true });
  }

  for (const path of publicContractPaths) {
    await signSubject(path);
  }
  for (const artifactPath of artifactPaths) {
    await signSubject(artifactPath);
  }

  console.log(
    `Signed ${artifactPaths.length + publicContractPaths.length} release subject(s).`,
  );
}

main().catch((error) => {
  console.error(
    `[sign-release-assets] ERROR: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
