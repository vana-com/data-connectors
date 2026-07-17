#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const connectorsRoot = join(repoRoot, "connectors");
const indexPath = join(repoRoot, "fixture-index.json");
const registryPath = join(repoRoot, "registry.json");
const rawBaseUrl = (
  process.env.FIXTURE_RAW_BASE_URL ||
  "https://raw.githubusercontent.com/PDP-Connect/data-connectors/main"
).replace(/\/$/, "");
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCOPE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SCENARIO_PATTERN = /^[a-z][a-z0-9-]*$/;
const FIXTURE_PATH_PATTERN =
  /^connectors\/[^/]+\/fixtures\/[A-Za-z0-9._-]+\.json$/;
const SCHEMA_PATH_PATTERN =
  /^connectors\/[^/]+\/schemas\/[A-Za-z0-9._-]+\.json$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function repoRelative(filePath) {
  return relative(repoRoot, filePath).split("\\").join("/");
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${repoRelative(filePath)} is not valid JSON: ${error.message}`);
  }
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function scopeNames(manifest) {
  return (manifest.scopes ?? [])
    .map((scopeEntry) =>
      typeof scopeEntry === "string" ? scopeEntry : scopeEntry?.scope,
    )
    .filter(Boolean);
}

function readConnectorManifests(connectorDir) {
  return readdirSync(connectorDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const path = join(connectorDir, entry);
      return { path, manifest: readJson(path) };
    })
    .filter(({ manifest }) => Array.isArray(manifest.scopes));
}

function resolveManifestForScope(connectorDir, scope) {
  const matches = readConnectorManifests(connectorDir).filter(({ manifest }) =>
    scopeNames(manifest).includes(scope),
  );

  if (matches.length === 0) {
    throw new Error(
      `${repoRelative(connectorDir)} has a fixture for ${scope}, but no connector manifest declares that scope`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${repoRelative(connectorDir)} has multiple connector manifests declaring ${scope}; split fixtures into an unambiguous connector directory`,
    );
  }

  return matches[0];
}

function findFixtureFiles() {
  const fixtureFiles = [];

  for (const connectorDirName of readdirSync(connectorsRoot)) {
    const connectorDir = join(connectorsRoot, connectorDirName);
    if (!statSync(connectorDir).isDirectory()) continue;

    const fixturesDir = join(connectorDir, "fixtures");
    if (!existsSync(fixturesDir) || !statSync(fixturesDir).isDirectory()) {
      continue;
    }

    for (const fixtureName of readdirSync(fixturesDir)) {
      if (!fixtureName.endsWith(".json")) continue;
      fixtureFiles.push(join(fixturesDir, fixtureName));
    }
  }

  return fixtureFiles.sort((a, b) => repoRelative(a).localeCompare(repoRelative(b)));
}

function parseFixtureName(fixturePath) {
  const name = basename(fixturePath, ".json");
  const parts = name.split(".");
  const scenario = parts.pop();
  const scope = parts.join(".");

  if (!scope.includes(".") || !scenario) {
    throw new Error(
      `${repoRelative(fixturePath)} must be named <scope>.<scenario>.json, for example spotify.savedTracks.small.json`,
    );
  }
  if (!SCENARIO_PATTERN.test(scenario)) {
    throw new Error(
      `${repoRelative(fixturePath)} scenario "${scenario}" must be lowercase kebab-case`,
    );
  }

  return { scope, scenario };
}

function schemaTypeMatches(value, type) {
  if (Array.isArray(type)) {
    return type.some((candidate) => schemaTypeMatches(value, candidate));
  }
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function resolveSchemaRef(ref, rootSchema) {
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .reduce((node, rawPart) => {
      if (!node || typeof node !== "object") return undefined;
      const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
      return node[part];
    }, rootSchema);
}

function validateAgainstSchema(value, schema, path = "root", rootSchema = schema) {
  const errors = [];

  if (!schema || typeof schema !== "object") return errors;

  if (typeof schema.$ref === "string") {
    const resolved = resolveSchemaRef(schema.$ref, rootSchema);
    if (!resolved) {
      errors.push(`${path}: unsupported schema reference ${schema.$ref}`);
      return errors;
    }
    return validateAgainstSchema(value, resolved, path, rootSchema);
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      errors.push(...validateAgainstSchema(value, branch, path, rootSchema));
    }
    if (errors.length > 0) return errors;
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (branch) =>
        validateAgainstSchema(value, branch, path, rootSchema).length === 0,
    );
    if (matched.length !== 1) {
      errors.push(`${path}: matched ${matched.length} oneOf branches, expected exactly 1`);
    }
    return errors;
  }

  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((branch) =>
      validateAgainstSchema(value, branch, path, rootSchema),
    );
    if (branchErrors.every((branch) => branch.length > 0)) {
      errors.push(`${path}: did not match any allowed schema`);
    }
    return errors;
  }

  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.map(JSON.stringify).join(", ")}`);
  }

  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    errors.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${actual}`);
    return errors;
  }

  if (schema.pattern && typeof value === "string") {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value)) {
      errors.push(`${path}: did not match pattern ${schema.pattern}`);
    }
  }
  if (schema.format === "uri" && typeof value === "string") {
    try {
      new URL(value);
    } catch {
      errors.push(`${path}: expected URI`);
    }
  }
  if (schema.format === "date-time" && typeof value === "string") {
    if (Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: expected date-time`);
    }
  }

  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    for (const field of schema.required ?? []) {
      if (!(field in value) || value[field] === undefined || value[field] === null) {
        errors.push(`${path}.${field}: missing required field`);
      }
    }

    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key}: unexpected field`);
        }
      }
    }

    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in value && value[key] !== undefined && value[key] !== null) {
        errors.push(
          ...validateAgainstSchema(value[key], propSchema, `${path}.${key}`, rootSchema),
        );
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} item(s)`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(
          ...validateAgainstSchema(item, schema.items, `${path}[${index}]`, rootSchema),
        );
      });
    }
  }

  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: expected >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: expected <= ${schema.maximum}`);
    }
  }

  return errors;
}

function deriveRecordCount(payload, scopeSchema) {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== "object") return 0;

  if (Number.isInteger(payload.total) && payload.total >= 0) {
    return payload.total;
  }

  const schemaArrayKeys = Object.entries(scopeSchema?.properties ?? {})
    .filter(([, propertySchema]) => propertySchema?.type === "array")
    .map(([key]) => key)
    .filter((key) => Array.isArray(payload[key]));

  if (schemaArrayKeys.length === 1) {
    return payload[schemaArrayKeys[0]].length;
  }

  const arrayEntries = Object.values(payload).filter(Array.isArray);
  if (arrayEntries.length === 1) return arrayEntries[0].length;

  return 0;
}

function buildFixtureEntry(fixturePath) {
  const connectorDir = dirname(dirname(fixturePath));
  const { scope, scenario } = parseFixtureName(fixturePath);
  const { path: manifestPath, manifest } = resolveManifestForScope(connectorDir, scope);
  const schemaPath = join(connectorDir, "schemas", `${scope}.json`);

  if (!existsSync(schemaPath)) {
    throw new Error(
      `${repoRelative(fixturePath)} maps to ${scope}, but ${repoRelative(schemaPath)} does not exist`,
    );
  }

  const scopeSchemaFile = readJson(schemaPath);
  const scopeSchema = scopeSchemaFile.schema;
  if (!scopeSchema) {
    throw new Error(`${repoRelative(schemaPath)} is missing top-level schema`);
  }

  const fixtureText = readFileSync(fixturePath, "utf8");
  const payload = readJson(fixturePath);
  const schemaErrors = validateAgainstSchema(payload, scopeSchema);
  if (schemaErrors.length > 0) {
    throw new Error(
      `${repoRelative(fixturePath)} violates ${repoRelative(schemaPath)}: ${schemaErrors.slice(0, 8).join("; ")}`,
    );
  }

  const connectorId = manifest.connector_id ?? manifest.id;
  const sourceId = manifest.source_id ?? scope.split(".")[0];
  if (!connectorId) {
    throw new Error(`${repoRelative(manifestPath)} is missing connector_id/id`);
  }

  const path = repoRelative(fixturePath);
  return {
    id: `${connectorId}.${scope}.${scenario}`,
    connectorId,
    sourceId,
    scope,
    scenario,
    recordCount: deriveRecordCount(payload, scopeSchema),
    path,
    rawUrl: `${rawBaseUrl}/${path}`,
    schemaPath: repoRelative(schemaPath),
    sizeBytes: Buffer.byteLength(fixtureText),
    sha256: sha256(fixtureText),
  };
}

function validateFixtureIndexDocument(index) {
  const errors = [];

  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return ["fixture-index.json: root must be an object"];
  }
  if (index.indexVersion !== "1.0") {
    errors.push("fixture-index.json: indexVersion must be 1.0");
  }
  if (typeof index.sourceRepo !== "string") {
    errors.push("fixture-index.json: sourceRepo must be a string");
  } else {
    try {
      new URL(index.sourceRepo);
    } catch {
      errors.push("fixture-index.json: sourceRepo must be a URI");
    }
  }
  if (typeof index.generatedAt !== "string" || Number.isNaN(Date.parse(index.generatedAt))) {
    errors.push("fixture-index.json: generatedAt must be a date-time string");
  }
  if (!Array.isArray(index.fixtures)) {
    errors.push("fixture-index.json: fixtures must be an array");
    return errors;
  }

  for (const [fixtureIndex, fixture] of index.fixtures.entries()) {
    const prefix = `fixture-index.json fixtures[${fixtureIndex}]`;
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const required = [
      "id",
      "connectorId",
      "sourceId",
      "scope",
      "scenario",
      "recordCount",
      "path",
      "rawUrl",
      "schemaPath",
      "sizeBytes",
      "sha256",
    ];
    for (const field of required) {
      if (!(field in fixture)) errors.push(`${prefix}: missing ${field}`);
    }

    if (
      typeof fixture.connectorId !== "string" ||
      !CONNECTOR_ID_PATTERN.test(fixture.connectorId)
    ) {
      errors.push(`${prefix}: invalid connectorId`);
    }
    if (typeof fixture.sourceId !== "string" || !CONNECTOR_ID_PATTERN.test(fixture.sourceId)) {
      errors.push(`${prefix}: invalid sourceId`);
    }
    if (typeof fixture.scope !== "string" || !SCOPE_PATTERN.test(fixture.scope)) {
      errors.push(`${prefix}: invalid scope`);
    }
    if (typeof fixture.scenario !== "string" || !SCENARIO_PATTERN.test(fixture.scenario)) {
      errors.push(`${prefix}: invalid scenario`);
    }
    if (
      typeof fixture.id !== "string" ||
      fixture.id !== `${fixture.connectorId}.${fixture.scope}.${fixture.scenario}`
    ) {
      errors.push(`${prefix}: id must equal connectorId.scope.scenario`);
    }
    if (!Number.isInteger(fixture.recordCount) || fixture.recordCount < 0) {
      errors.push(`${prefix}: recordCount must be a non-negative integer`);
    }
    if (typeof fixture.path !== "string" || !FIXTURE_PATH_PATTERN.test(fixture.path)) {
      errors.push(`${prefix}: invalid fixture path`);
    } else if (!fixture.path.endsWith(`${fixture.scope}.${fixture.scenario}.json`)) {
      errors.push(
        `${prefix}: fixture path must end with ${fixture.scope}.${fixture.scenario}.json`,
      );
    }
    if (typeof fixture.rawUrl !== "string") {
      errors.push(`${prefix}: rawUrl must be a string`);
    } else {
      try {
        new URL(fixture.rawUrl);
      } catch {
        errors.push(`${prefix}: rawUrl must be a URI`);
      }
    }
    if (
      typeof fixture.schemaPath !== "string" ||
      !SCHEMA_PATH_PATTERN.test(fixture.schemaPath)
    ) {
      errors.push(`${prefix}: invalid schemaPath`);
    } else if (!fixture.schemaPath.endsWith(`${fixture.scope}.json`)) {
      errors.push(`${prefix}: schemaPath must end with ${fixture.scope}.json`);
    }
    if (!Number.isInteger(fixture.sizeBytes) || fixture.sizeBytes < 2) {
      errors.push(`${prefix}: sizeBytes must be an integer >= 2`);
    }
    if (typeof fixture.sha256 !== "string" || !SHA256_PATTERN.test(fixture.sha256)) {
      errors.push(`${prefix}: invalid sha256`);
    }
  }

  return errors;
}

function scenarioRank(scenario) {
  const preferred = ["empty", "small", "medium", "large"];
  const index = preferred.indexOf(scenario);
  return index === -1 ? preferred.length : index;
}

function generatedAt() {
  if (!existsSync(registryPath)) return "1970-01-01T00:00:00.000Z";
  return readJson(registryPath).lastUpdated ?? "1970-01-01T00:00:00.000Z";
}

function buildFixtureIndex() {
  const fixtures = findFixtureFiles()
    .map(buildFixtureEntry)
    .sort(
      (a, b) =>
        a.connectorId.localeCompare(b.connectorId) ||
        a.scope.localeCompare(b.scope) ||
        scenarioRank(a.scenario) - scenarioRank(b.scenario) ||
        a.scenario.localeCompare(b.scenario),
    );

  const ids = new Set();
  for (const fixture of fixtures) {
    if (ids.has(fixture.id)) {
      throw new Error(`Duplicate fixture id: ${fixture.id}`);
    }
    ids.add(fixture.id);
  }

  return {
    $schema: "./schemas/fixture-index.schema.json",
    indexVersion: "1.0",
    sourceRepo: "https://github.com/PDP-Connect/data-connectors",
    generatedAt: generatedAt(),
    fixtures,
  };
}

function main() {
  const checkMode = process.argv.includes("--check");
  const validateOnly = process.argv.includes("--validate-only");
  const index = buildFixtureIndex();
  const indexErrors = validateFixtureIndexDocument(index);
  if (indexErrors.length > 0) {
    throw new Error(indexErrors.join("\n"));
  }
  const text = `${JSON.stringify(index, null, 2)}\n`;

  if (validateOnly) {
    console.log(`Validated ${index.fixtures.length} fixture(s).`);
    return;
  }

  if (checkMode) {
    const before = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
    if (before !== text) {
      throw new Error(
        "fixture-index.json drift detected. Run `node scripts/generate-fixture-index.mjs`.",
      );
    }
    console.log(`Fixture index is up to date with ${index.fixtures.length} fixture(s).`);
    return;
  }

  writeFileSync(indexPath, text);
  console.log(`Generated fixture-index.json with ${index.fixtures.length} fixture(s).`);
}

main();
