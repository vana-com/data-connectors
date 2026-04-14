#!/usr/bin/env node
// Detect source_id changes in manifests between the base ref and HEAD.
// Fails if a connector's source_id changed without an explicit migration
// marker.
//
// Acceptance target:
//   HC-COMPAT-SOURCE-ID-001 — source_id values are stable across releases.
//
// Usage:
//   node scripts/check-source-id-stability.mjs
//   BASE_REF=origin/main node scripts/check-source-id-stability.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
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

function readManifestIds(content) {
  try {
    const m = JSON.parse(content);
    return {
      connector_id: m.connector_id || m.id || null,
      source_id: m.source_id || null,
    };
  } catch {
    return null;
  }
}

function main() {
  const baseRef = process.env.BASE_REF || "origin/main";
  const manifests = findManifests(join(repoRoot, "connectors"));
  const errors = [];
  let checked = 0;

  for (const path of manifests) {
    const rel = path.replace(repoRoot + "/", "");
    const headContent = readFileSync(path, "utf8");
    const head = readManifestIds(headContent);
    if (!head || !head.connector_id) continue;

    const baseContent = getFileAtRef(baseRef, rel);
    if (!baseContent) continue; // new manifest — nothing to compare against

    const base = readManifestIds(baseContent);
    if (!base || !base.source_id) continue; // base predates source_id field

    checked++;
    if (head.source_id && head.source_id !== base.source_id) {
      errors.push(
        `${rel}: source_id changed "${base.source_id}" → "${head.source_id}" (connector ${head.connector_id})`,
      );
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(
      `\nHC-COMPAT-SOURCE-ID-001 FAIL: ${errors.length} source_id change(s). source_ids must be stable across releases unless a versioned migration path is documented.`,
    );
    process.exit(1);
  }

  console.log(`Source ids stable across ${checked} manifest(s) with a base revision.`);
}

main();
