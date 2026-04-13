#!/usr/bin/env node
// Detect breaking changes to public scope schemas between the base ref and
// HEAD. A breaking change is: a removed property, a removed required field,
// or a new required field.
//
// If a breaking change is present, the schema's `version` field must be
// bumped (major) compared to the base revision.
//
// Acceptance target:
//   HC-COMPAT-ADDITIVE-SCHEMA-001 — public scope schemas evolve additively
//   unless a version bump is introduced.
//
// Usage:
//   node scripts/check-additive-schemas.mjs
//   BASE_REF=origin/main node scripts/check-additive-schemas.mjs

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function listSchemas() {
  const registryPath = join(repoRoot, "registry.json");
  if (!existsSync(registryPath)) {
    return [];
  }

  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const schemaFiles = [];

  for (const connector of registry.connectors ?? []) {
    const metadataPath = join(repoRoot, "connectors", connector.files.metadata);
    if (!existsSync(metadataPath)) {
      continue;
    }

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const manifestDir = dirname(metadataPath);
    for (const entry of metadata.scopes ?? []) {
      const scope = typeof entry === "string" ? entry : entry?.scope;
      if (!scope) {
        continue;
      }
      const schemaPath = join(manifestDir, "schemas", `${scope}.json`);
      if (existsSync(schemaPath)) {
        schemaFiles.push(schemaPath);
      }
    }
  }

  return schemaFiles;
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

function parseMajor(version) {
  if (typeof version !== "string") return 0;
  const m = version.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function collectProperties(schema, path = "") {
  const out = new Map();
  if (!schema || typeof schema !== "object") return out;
  if (schema.type === "object" && schema.properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, sub] of Object.entries(schema.properties)) {
      const subPath = path ? `${path}.${key}` : key;
      out.set(subPath, { required: required.has(key) });
      if (sub && typeof sub === "object") {
        for (const [k, v] of collectProperties(sub, subPath)) {
          out.set(k, v);
        }
        if (sub.type === "array" && sub.items) {
          for (const [k, v] of collectProperties(sub.items, `${subPath}[]`)) {
            out.set(k, v);
          }
        }
      }
    }
  }
  return out;
}

function diffSchemas(baseSchema, headSchema) {
  const baseProps = collectProperties(baseSchema);
  const headProps = collectProperties(headSchema);
  const removed = [];
  const newlyRequired = [];
  for (const [key] of baseProps) {
    if (!headProps.has(key)) removed.push(key);
  }
  for (const [key, meta] of headProps) {
    const baseMeta = baseProps.get(key);
    if (baseMeta && !baseMeta.required && meta.required) {
      newlyRequired.push(key);
    }
  }
  return { removed, newlyRequired };
}

function main() {
  const baseRef = process.env.BASE_REF || "origin/main";
  const schemaFiles = listSchemas();
  const errors = [];
  let checked = 0;

  for (const path of schemaFiles) {
    const rel = path.replace(repoRoot + "/", "");
    const headContent = readFileSync(path, "utf8");
    let head;
    try {
      head = JSON.parse(headContent);
    } catch {
      continue;
    }
    const baseContent = getFileAtRef(baseRef, rel);
    if (!baseContent) continue;
    let base;
    try {
      base = JSON.parse(baseContent);
    } catch {
      continue;
    }

    checked++;
    const { removed, newlyRequired } = diffSchemas(base.schema, head.schema);
    const baseMajor = parseMajor(base.version);
    const headMajor = parseMajor(head.version);

    const breaking = removed.length > 0 || newlyRequired.length > 0;
    if (breaking && headMajor <= baseMajor) {
      errors.push(
        `${rel}: breaking schema change without major version bump (base v${base.version}, head v${head.version}). removed=${JSON.stringify(removed)} newly_required=${JSON.stringify(newlyRequired)}`,
      );
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(
      `\nHC-COMPAT-ADDITIVE-SCHEMA-001 FAIL: ${errors.length} breaking schema change(s). Either revert the change or bump the schema's major version.`,
    );
    process.exit(1);
  }

  console.log(`Schemas additive: ${checked} schema(s) checked.`);
}

main();
