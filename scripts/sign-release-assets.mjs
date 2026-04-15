#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "sigstore";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const artifactsDir = join(repoRoot, "artifacts");
const indexPath = join(repoRoot, "connector-index.json");

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
  if (!existsSync(indexPath)) {
    throw new Error(`Missing ${indexPath}`);
  }

  const artifactPaths = walkArtifacts(artifactsDir);
  for (const staleBundle of walkArtifacts(artifactsDir).map(bundlePathFor)) {
    rmSync(staleBundle, { force: true });
  }
  rmSync(bundlePathFor(indexPath), { force: true });

  await signSubject(indexPath);
  for (const artifactPath of artifactPaths) {
    await signSubject(artifactPath);
  }

  console.log(`Signed ${artifactPaths.length + 1} release subject(s).`);
}

main().catch((error) => {
  console.error(
    `[sign-release-assets] ERROR: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
