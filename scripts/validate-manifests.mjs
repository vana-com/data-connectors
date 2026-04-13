#!/usr/bin/env node
/**
 * Validate every *-playwright.json manifest against the canonical contract.
 *
 * This is a focused validator that enforces the rules from
 * schemas/manifest.schema.json. It has no npm dependencies.
 *
 * Acceptance targets:
 *   HC-MANIFEST-CONTRACT-001 — required fields present
 *   HC-MANIFEST-CONTRACT-002 — connector_id/source_id distinct and unique
 *   HC-MANIFEST-CONTRACT-003 — scopes are canonical platform.scope ids
 *   HC-VERSIONING-INDEPENDENT-001 — version dimensions not conflated
 *   HC-WHAT-NOT-TO-DO-002 — manifests do not contain shell-owned fields
 *
 * Usage: node scripts/validate-manifests.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const REQUIRED_FIELDS = [
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
  "scopes",
];

const ALLOWED_RUNTIMES = new Set(["playwright", "vanilla", "network-capture"]);

// Fields that belong in shell overlays, not canonical manifests
// (per HC-WHAT-NOT-TO-DO-002). Existing manifests include some of these as
// legacy aliases; we allow them but warn, and forbid new shell-specific fields.
const FORBIDDEN_SHELL_FIELDS = [
  "brand_color",
  "privacy_note",
  "cg_available",
  "availability",
  "route",
  "data_types",
];

const SCOPE_ID_PATTERN = /^[a-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_]*$/;
const MANIFEST_VERSION_PATTERN = /^[0-9]+\.[0-9]+$/;
const CONNECTOR_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-.]+)?$/;

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

function validateScopes(scopes, sourceId, errors, path) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    errors.push(`${path}: scopes must be a non-empty array`);
    return;
  }
  for (const [idx, entry] of scopes.entries()) {
    let scopeId;
    if (typeof entry === "string") {
      scopeId = entry;
    } else if (entry && typeof entry === "object" && "scope" in entry) {
      scopeId = entry.scope;
      const allowed = new Set(["scope", "label", "description", "schema"]);
      for (const k of Object.keys(entry)) {
        if (!allowed.has(k)) {
          errors.push(
            `${path}: scopes[${idx}] has disallowed field "${k}" (allowed: scope, label, description)`,
          );
        }
      }
    } else {
      errors.push(
        `${path}: scopes[${idx}] must be a string or an object with a "scope" field`,
      );
      continue;
    }
    if (typeof scopeId !== "string" || !SCOPE_ID_PATTERN.test(scopeId)) {
      errors.push(
        `${path}: scopes[${idx}] id "${scopeId}" does not match canonical platform.scope pattern`,
      );
      continue;
    }
    const expectedPrefix = `${sourceId}.`;
    if (!scopeId.startsWith(expectedPrefix)) {
      errors.push(
        `${path}: scope "${scopeId}" does not use the manifest's source_id "${sourceId}" as its prefix`,
      );
    }
  }
}

function validateConsumerMetadata(manifest, errors, path) {
  const { consumer_metadata: metadata } = manifest;
  if (metadata == null) {
    return;
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    errors.push(`${path}: consumer_metadata must be an object when present`);
    return;
  }

  const allowed = new Set([
    "display_name",
    "brand_domain",
    "aliases",
    "icon_key",
    "default_scope",
  ]);
  for (const key of Object.keys(metadata)) {
    if (!allowed.has(key)) {
      errors.push(
        `${path}: consumer_metadata has disallowed field "${key}" (allowed: ${[...allowed].join(", ")})`,
      );
    }
  }

  if (
    "display_name" in metadata &&
    (typeof metadata.display_name !== "string" ||
      metadata.display_name.trim() === "")
  ) {
    errors.push(
      `${path}: consumer_metadata.display_name must be a non-empty string`,
    );
  }

  if ("brand_domain" in metadata) {
    if (
      typeof metadata.brand_domain !== "string" ||
      metadata.brand_domain.trim() === ""
    ) {
      errors.push(
        `${path}: consumer_metadata.brand_domain must be a non-empty string`,
      );
    } else {
      try {
        const url = new URL(`https://${metadata.brand_domain}`);
        if (
          url.hostname !== metadata.brand_domain ||
          metadata.brand_domain.includes("/")
        ) {
          errors.push(
            `${path}: consumer_metadata.brand_domain "${metadata.brand_domain}" must be a bare hostname`,
          );
        }
      } catch {
        errors.push(
          `${path}: consumer_metadata.brand_domain "${metadata.brand_domain}" is not a valid hostname`,
        );
      }
    }
  }

  if ("aliases" in metadata) {
    if (!Array.isArray(metadata.aliases)) {
      errors.push(`${path}: consumer_metadata.aliases must be an array`);
    } else {
      const normalized = new Set();
      for (const [idx, alias] of metadata.aliases.entries()) {
        if (typeof alias !== "string" || alias.trim() === "") {
          errors.push(
            `${path}: consumer_metadata.aliases[${idx}] must be a non-empty string`,
          );
          continue;
        }
        const token = alias.trim().toLowerCase();
        if (normalized.has(token)) {
          errors.push(
            `${path}: consumer_metadata.aliases contains duplicate alias "${alias}"`,
          );
        }
        normalized.add(token);
      }
    }
  }

  if (
    "icon_key" in metadata &&
    (typeof metadata.icon_key !== "string" || metadata.icon_key.trim() === "")
  ) {
    errors.push(
      `${path}: consumer_metadata.icon_key must be a non-empty string`,
    );
  }

  if ("default_scope" in metadata) {
    if (
      typeof metadata.default_scope !== "string" ||
      metadata.default_scope.trim() === ""
    ) {
      errors.push(
        `${path}: consumer_metadata.default_scope must be a non-empty string`,
      );
    } else {
      const scopes = Array.isArray(manifest.scopes)
        ? manifest.scopes.map((entry) =>
            typeof entry === "string" ? entry : entry?.scope,
          )
        : [];
      if (!scopes.includes(metadata.default_scope)) {
        errors.push(
          `${path}: consumer_metadata.default_scope "${metadata.default_scope}" is not declared in scopes[]`,
        );
      }
    }
  }
}

function validateIconPath(filePath, manifest, errors, rel) {
  if (!manifest.icon) {
    return;
  }

  if (typeof manifest.icon !== "string" || manifest.icon.trim() === "") {
    errors.push(`${rel}: icon must be a non-empty string when present`);
    return;
  }

  const iconPath = manifest.icon.trim();
  if (iconPath.startsWith("/") || iconPath.includes("\\")) {
    errors.push(
      `${rel}: icon "${iconPath}" must be a relative POSIX path inside the connector directory`,
    );
    return;
  }

  const normalizedPath = normalize(iconPath);
  if (normalizedPath.startsWith("..")) {
    errors.push(
      `${rel}: icon "${iconPath}" must stay inside the connector directory`,
    );
    return;
  }

  const manifestDir = dirname(filePath);
  const resolvedIconPath = join(manifestDir, normalizedPath);
  if (!existsSync(resolvedIconPath) || !statSync(resolvedIconPath).isFile()) {
    errors.push(
      `${rel}: icon "${iconPath}" does not exist inside ${manifestDir.replace(repoRoot + "/", "")}/`,
    );
  }
}

function validateManifest(filePath, manifest, seenIds) {
  const errors = [];
  const warnings = [];
  const rel = filePath.replace(repoRoot + "/", "");

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      errors.push(`${rel}: missing required field "${field}"`);
    } else {
      const v = manifest[field];
      if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
        errors.push(`${rel}: required field "${field}" is empty`);
      }
    }
  }

  // manifest_version pattern
  if (
    manifest.manifest_version &&
    !MANIFEST_VERSION_PATTERN.test(manifest.manifest_version)
  ) {
    errors.push(
      `${rel}: manifest_version "${manifest.manifest_version}" must match N.N`,
    );
  }

  // connector_id pattern + uniqueness
  if (manifest.connector_id) {
    if (!CONNECTOR_ID_PATTERN.test(manifest.connector_id)) {
      errors.push(
        `${rel}: connector_id "${manifest.connector_id}" invalid format`,
      );
    }
    if (seenIds.has(manifest.connector_id)) {
      errors.push(
        `${rel}: connector_id "${manifest.connector_id}" is duplicated (first seen in ${seenIds.get(manifest.connector_id)})`,
      );
    } else {
      seenIds.set(manifest.connector_id, rel);
    }
  }

  // source_id pattern
  if (manifest.source_id) {
    if (!SOURCE_ID_PATTERN.test(manifest.source_id)) {
      errors.push(`${rel}: source_id "${manifest.source_id}" invalid format`);
    }
  }

  // connector_id vs source_id must differ (unless the connector is single-runtime
  // and has no artifact suffix, which is not currently the case for any manifest).
  if (
    manifest.connector_id &&
    manifest.source_id &&
    manifest.connector_id === manifest.source_id
  ) {
    errors.push(
      `${rel}: connector_id and source_id are identical ("${manifest.connector_id}") — they must be distinct`,
    );
  }

  // connector version pattern
  if (manifest.version && !CONNECTOR_VERSION_PATTERN.test(manifest.version)) {
    errors.push(`${rel}: version "${manifest.version}" is not semver`);
  }

  // page_api_version integer >= 1
  if (manifest.page_api_version != null) {
    if (
      typeof manifest.page_api_version !== "number" ||
      !Number.isInteger(manifest.page_api_version) ||
      manifest.page_api_version < 1
    ) {
      errors.push(
        `${rel}: page_api_version "${manifest.page_api_version}" must be an integer >= 1`,
      );
    }
  }

  // runtime enum
  if (manifest.runtime && !ALLOWED_RUNTIMES.has(manifest.runtime)) {
    errors.push(
      `${rel}: runtime "${manifest.runtime}" not in ${[...ALLOWED_RUNTIMES].join(",")}`,
    );
  }

  // connect_url is a URL
  if (manifest.connect_url) {
    try {
      new URL(manifest.connect_url);
    } catch {
      errors.push(
        `${rel}: connect_url "${manifest.connect_url}" is not a valid URL`,
      );
    }
  }

  // connect_selector non-trivial
  if (manifest.connect_selector && manifest.connect_selector.length < 4) {
    errors.push(`${rel}: connect_selector is too short`);
  }

  // scopes canonical
  if (manifest.source_id) {
    validateScopes(manifest.scopes, manifest.source_id, errors, rel);
  }

  validateConsumerMetadata(manifest, errors, rel);
  validateIconPath(filePath, manifest, errors, rel);

  // Forbidden shell-overlay fields
  for (const field of FORBIDDEN_SHELL_FIELDS) {
    if (field in manifest) {
      errors.push(
        `${rel}: contains shell-overlay-owned field "${field}" — move to the shell overlay`,
      );
    }
  }

  // Legacy aliases should match canonical values when both are present.
  const legacyAliases = [
    ["id", "connector_id"],
    ["connectURL", "connect_url"],
    ["connectSelector", "connect_selector"],
    ["iconURL", "icon"],
  ];
  for (const [legacy, canonical] of legacyAliases) {
    if (
      legacy in manifest &&
      canonical in manifest &&
      manifest[legacy] !== manifest[canonical]
    ) {
      errors.push(
        `${rel}: legacy field "${legacy}" (${JSON.stringify(manifest[legacy])}) disagrees with canonical "${canonical}" (${JSON.stringify(manifest[canonical])})`,
      );
    }
  }

  return { errors, warnings };
}

function main() {
  const connectorsDir = join(repoRoot, "connectors");
  const manifests = findManifests(connectorsDir);

  const allErrors = [];
  const allWarnings = [];
  const seenIds = new Map();

  for (const path of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      allErrors.push(`${path}: invalid JSON (${err.message})`);
      continue;
    }
    const { errors, warnings } = validateManifest(path, parsed, seenIds);
    allErrors.push(...errors);
    allWarnings.push(...warnings);
  }

  for (const w of allWarnings) console.warn(`warn: ${w}`);
  for (const e of allErrors) console.error(`error: ${e}`);

  console.log(
    `\nValidated ${manifests.length} manifests: ${allErrors.length} errors, ${allWarnings.length} warnings`,
  );
  process.exit(allErrors.length > 0 ? 1 : 0);
}

main();
