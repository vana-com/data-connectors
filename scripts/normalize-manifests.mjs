#!/usr/bin/env node
/**
 * Normalize all *-playwright.json manifests to the canonical manifest.schema.json shape.
 *
 * This script is safe to re-run. It:
 *   - adds canonical fields (manifest_version, connector_id, source_id, page_api_version,
 *     connect_url, connect_selector, icon) derived from existing legacy fields
 *   - preserves legacy fields (id, connectURL, connectSelector, iconURL) for backward compatibility
 *   - does not change version, name, company, description, scopes, runtime, or vectorize_config
 *
 * Usage: node scripts/normalize-manifests.mjs [--check]
 *   --check: exit non-zero if any manifest would be changed (for CI)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const CANONICAL_MANIFEST_VERSION = "1.0";
const CANONICAL_PAGE_API_VERSION = 1;

// Explicit source_id overrides for connectors where the connector id contains
// a qualifier that is NOT part of the canonical product-facing source_id.
// For example, instagram-ads-playwright is a second artifact that emits data
// into the "instagram" source (scope instagram.ads), not a separate source.
const SOURCE_ID_OVERRIDES = {
  "instagram-ads-playwright": "instagram",
};

/**
 * Derive source_id from connector id. Examples:
 *   instagram-playwright      -> instagram
 *   instagram-ads-playwright  -> instagram (via override, because it emits into the instagram source)
 *   chatgpt-playwright        -> chatgpt
 *   shop-playwright           -> shop
 *   goodreads-playwright      -> goodreads
 */
function deriveSourceId(connectorId) {
  if (SOURCE_ID_OVERRIDES[connectorId]) return SOURCE_ID_OVERRIDES[connectorId];
  const trimmed = connectorId.replace(/-playwright$/, "");
  return trimmed.replace(/-/g, "_");
}

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

function normalizeManifest(manifest) {
  const normalized = { ...manifest };

  // manifest_version (new)
  if (!normalized.manifest_version) {
    normalized.manifest_version = CANONICAL_MANIFEST_VERSION;
  }

  // connector_id (new, mirrors legacy id)
  if (!normalized.connector_id) {
    if (!normalized.id) {
      throw new Error(`Manifest missing both id and connector_id`);
    }
    normalized.connector_id = normalized.id;
  }

  // source_id (new, derived from connector_id).
  // Overrides always take precedence so that re-normalizing corrects historical
  // derivations of qualified connector ids (e.g. instagram-ads-playwright).
  if (SOURCE_ID_OVERRIDES[normalized.connector_id]) {
    normalized.source_id = SOURCE_ID_OVERRIDES[normalized.connector_id];
  } else if (!normalized.source_id) {
    normalized.source_id = deriveSourceId(normalized.connector_id);
  }

  // page_api_version (new)
  if (normalized.page_api_version == null) {
    normalized.page_api_version = CANONICAL_PAGE_API_VERSION;
  }

  // connect_url (new, mirrors legacy connectURL)
  if (!normalized.connect_url && normalized.connectURL) {
    normalized.connect_url = normalized.connectURL;
  }

  // connect_selector (new, mirrors legacy connectSelector)
  if (!normalized.connect_selector && normalized.connectSelector) {
    normalized.connect_selector = normalized.connectSelector;
  }

  // icon (new, mirrors legacy iconURL)
  if (!normalized.icon && normalized.iconURL) {
    normalized.icon = normalized.iconURL;
  }

  // Reorder keys so canonical fields come first for readability.
  const keyOrder = [
    "manifest_version",
    "connector_id",
    "source_id",
    "version",
    "name",
    "company",
    "description",
    "runtime",
    "page_api_version",
    "connect_url",
    "connect_selector",
    "icon",
    "scopes",
    "runtime_requirements",
    "capabilities",
    // legacy
    "id",
    "connectURL",
    "connectSelector",
    "iconURL",
    "exportFrequency",
    "vectorize_config",
  ];

  const ordered = {};
  for (const key of keyOrder) {
    if (key in normalized) ordered[key] = normalized[key];
  }
  // Append anything not in keyOrder.
  for (const [k, v] of Object.entries(normalized)) {
    if (!(k in ordered)) ordered[k] = v;
  }
  return ordered;
}

function main() {
  const checkMode = process.argv.includes("--check");
  const connectorsDir = join(repoRoot, "connectors");
  const manifests = findManifests(connectorsDir);

  let changed = 0;
  const drift = [];

  for (const path of manifests) {
    const before = readFileSync(path, "utf8");
    const parsed = JSON.parse(before);
    const after = normalizeManifest(parsed);
    const afterText = JSON.stringify(after, null, 2) + "\n";

    if (before !== afterText) {
      if (checkMode) {
        drift.push(path);
      } else {
        writeFileSync(path, afterText);
        console.log(`normalized: ${path.replace(repoRoot + "/", "")}`);
      }
      changed++;
    }
  }

  if (checkMode && drift.length > 0) {
    console.error(
      `${drift.length} manifest(s) are not normalized. Run: node scripts/normalize-manifests.mjs`,
    );
    for (const p of drift) {
      console.error(`  - ${p.replace(repoRoot + "/", "")}`);
    }
    process.exit(1);
  }

  console.log(
    `Processed ${manifests.length} manifests, ${changed} ${checkMode ? "would change" : "updated"}.`,
  );
}

main();
