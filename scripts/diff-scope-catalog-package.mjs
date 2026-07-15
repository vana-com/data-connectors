#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, "..");
const maturityRank = new Map([
  ["experimental", 0],
  ["beta", 1],
  ["stable", 2],
]);
const impactRank = new Map([
  ["none", 0],
  ["patch", 1],
  ["minor", 2],
  ["major", 3],
]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(compareCodeUnits)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeLimits(limits) {
  if (!Array.isArray(limits)) return limits;
  return limits
    .map(stableValue)
    .sort((left, right) => compareCodeUnits(stableJson(left), stableJson(right)));
}

function normalizeDesktop(desktop) {
  if (!desktop) return desktop;
  const normalized = structuredClone(desktop);
  normalized.limits = normalizeLimits(normalized.limits);
  normalized.connectors = normalized.connectors?.map((connector) => ({
    ...connector,
    limits: normalizeLimits(connector.limits),
  }));
  normalized.connectors?.sort((left, right) =>
    compareCodeUnits(`${left.id}\0${left.status}`, `${right.id}\0${right.status}`),
  );
  return stableValue(normalized);
}

function normalizeWeb(web) {
  if (!web) return web;
  return stableValue({ ...structuredClone(web), limits: normalizeLimits(web.limits) });
}

function assertPackageRelativePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    normalize(path).startsWith("..") ||
    normalize(path) !== path
  ) {
    throw new Error(`${label} must be a normalized package-relative path: ${path}`);
  }
}

function normalizeCatalog(catalog) {
  const normalized = structuredClone(catalog);
  delete normalized.generatedFrom;
  if (normalized.distribution) {
    delete normalized.distribution.sourceCommit;
    delete normalized.distribution.releaseTag;
  }
  for (const scope of normalized.scopes ?? []) {
    delete scope.schema?.url;
    if (scope.fulfillment) {
      scope.fulfillment.desktop = normalizeDesktop(scope.fulfillment.desktop);
      scope.fulfillment.web = normalizeWeb(scope.fulfillment.web);
    }
  }
  normalized.scopes?.sort((left, right) =>
    compareCodeUnits(
      `${left.sourceId}\0${left.scopeId}`,
      `${right.sourceId}\0${right.scopeId}`,
    ),
  );
  return stableValue(normalized);
}

function pair(scope) {
  return [scope.sourceId, scope.scopeId];
}

function pairKey(scopeOrPair) {
  return JSON.stringify(Array.isArray(scopeOrPair) ? scopeOrPair : pair(scopeOrPair));
}

function buffersEqual(left, right) {
  return left.length === right.length && left.equals(right);
}

function bytesFingerprint(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function valuesEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function maxImpact(current, candidate) {
  return impactRank.get(candidate) > impactRank.get(current) ? candidate : current;
}

function classifyMaturity(previous, current) {
  const previousRank = maturityRank.get(previous);
  const currentRank = maturityRank.get(current);
  if (previousRank === undefined || currentRank === undefined) return "major";
  if (currentRank < previousRank) return "major";
  if (currentRank > previousRank) return "minor";
  return "none";
}

function connectorById(desktop) {
  return new Map((desktop?.connectors ?? []).map((connector) => [connector.id, connector]));
}

function classifyDesktop(previous, current) {
  previous = normalizeDesktop(previous);
  current = normalizeDesktop(current);
  let impact = "none";
  if (previous?.status !== current?.status) {
    if (previous?.status === "supported") impact = maxImpact(impact, "major");
    else if (current?.status === "supported") impact = maxImpact(impact, "minor");
    else impact = maxImpact(impact, "patch");
  }
  if (!valuesEqual(previous?.limits, current?.limits)) {
    const supportedPathAdded = previous?.status !== "supported" && current?.status === "supported";
    if (!supportedPathAdded) impact = maxImpact(impact, "major");
  }

  const previousConnectors = connectorById(previous);
  const currentConnectors = connectorById(current);
  for (const id of previousConnectors.keys()) {
    if (!currentConnectors.has(id)) impact = maxImpact(impact, "major");
  }
  for (const id of currentConnectors.keys()) {
    if (!previousConnectors.has(id)) impact = maxImpact(impact, "minor");
  }
  for (const [id, previousConnector] of previousConnectors) {
    const currentConnector = currentConnectors.get(id);
    if (!currentConnector) continue;
    if (previousConnector.status !== currentConnector.status) {
      impact = maxImpact(
        impact,
        classifyMaturity(previousConnector.status, currentConnector.status),
      );
    }
    if (!valuesEqual(previousConnector.limits, currentConnector.limits)) {
      impact = maxImpact(impact, "major");
    }
    const { status: _previousStatus, limits: _previousLimits, ...previousMetadata } =
      previousConnector;
    const { status: _currentStatus, limits: _currentLimits, ...currentMetadata } =
      currentConnector;
    if (!valuesEqual(previousMetadata, currentMetadata)) {
      impact = maxImpact(impact, "patch");
    }
  }
  return impact;
}

function classifyWeb(previous, current) {
  previous = normalizeWeb(previous);
  current = normalizeWeb(current);
  let impact = "none";
  if (previous?.status !== current?.status) {
    if (previous?.status === "supported") impact = maxImpact(impact, "major");
    else if (current?.status === "supported") impact = maxImpact(impact, "minor");
    else impact = maxImpact(impact, "patch");
  }
  if (!valuesEqual(previous?.limits, current?.limits)) {
    const supportedPathAdded = previous?.status !== "supported" && current?.status === "supported";
    if (!supportedPathAdded) impact = maxImpact(impact, "major");
  }
  if (!valuesEqual(previous?.blocker, current?.blocker)) {
    impact = maxImpact(impact, "patch");
  }
  const { status: _previousStatus, limits: _previousLimits, blocker: _previousBlocker, ...previousMetadata } =
    previous ?? {};
  const { status: _currentStatus, limits: _currentLimits, blocker: _currentBlocker, ...currentMetadata } =
    current ?? {};
  if (!valuesEqual(previousMetadata, currentMetadata)) {
    impact = maxImpact(impact, "patch");
  }
  return impact;
}

function bumpVersion(version, impact) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) throw new Error(`Previous package version is not plain semver: ${version}`);
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (impact === "none") return version;
  if (impact === "major") return `${major + 1}.0.0`;
  if (impact === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function readContractSnapshot(root) {
  const catalogPath = join(root, "scope-catalog.json");
  if (!existsSync(catalogPath)) throw new Error(`Missing scope-catalog.json in ${root}`);
  const catalog = readJson(catalogPath);
  if (!Array.isArray(catalog.scopes)) throw new Error("scope-catalog.json must contain scopes");
  assertPackageRelativePath(catalog.catalogSchema?.path, "catalogSchema.path");

  const scopes = new Map();
  const payloadSchemas = new Map();
  for (const scope of catalog.scopes) {
    if (!scope?.sourceId || !scope?.scopeId) {
      throw new Error("Every catalog scope must contain sourceId and scopeId");
    }
    const key = pairKey(scope);
    const connectorIds = new Set();
    const duplicateConnectorIds = new Set();
    for (const connector of scope.fulfillment?.desktop?.connectors ?? []) {
      if (connectorIds.has(connector.id)) duplicateConnectorIds.add(connector.id);
      connectorIds.add(connector.id);
    }
    if (duplicateConnectorIds.size > 0) {
      const duplicates = [...duplicateConnectorIds].sort(compareCodeUnits);
      throw new Error(
        `Duplicate Desktop connector ID${duplicates.length === 1 ? "" : "s"} for catalog pair ${key}: ${duplicates.join(", ")}`,
      );
    }
    if (scopes.has(key)) throw new Error(`Duplicate catalog pair: ${key}`);
    scopes.set(key, scope);
    assertPackageRelativePath(scope.schema?.path, `${scope.scopeId} schema.path`);
    if (payloadSchemas.has(scope.schema.path)) {
      throw new Error(`Duplicate referenced payload schema: ${scope.schema.path}`);
    }
    const path = join(root, scope.schema.path);
    if (!existsSync(path)) throw new Error(`Missing referenced payload schema: ${scope.schema.path}`);
    payloadSchemas.set(scope.schema.path, readFileSync(path));
  }

  const catalogSchemaPath = join(root, catalog.catalogSchema.path);
  if (!existsSync(catalogSchemaPath)) {
    throw new Error(`Missing catalog schema: ${catalog.catalogSchema.path}`);
  }
  const packageJsonPath = join(root, "package.json");
  const version = existsSync(packageJsonPath) ? readJson(packageJsonPath).version ?? null : null;
  const normalizedCatalog = normalizeCatalog(catalog);
  const fingerprintInput = {
    catalog: normalizedCatalog,
    catalogSchema: {
      path: catalog.catalogSchema.path,
      bytes: readFileSync(catalogSchemaPath).toString("base64"),
    },
    payloadSchemas: [...payloadSchemas]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([path, bytes]) => ({ path, bytes: bytes.toString("base64") })),
  };
  const fingerprint = `sha256:${createHash("sha256").update(stableJson(fingerprintInput)).digest("hex")}`;

  return {
    root,
    version,
    catalog,
    normalizedCatalog,
    catalogSchemaBytes: readFileSync(catalogSchemaPath),
    payloadSchemas,
    scopes,
    fingerprint,
  };
}

function changedField(previous, current) {
  return valuesEqual(previous, current) ? null : { previous, current };
}

function schemaReleaseValue(snapshot, scope) {
  return {
    path: scope.schema.path,
    fingerprint: bytesFingerprint(snapshot.payloadSchemas.get(scope.schema.path)),
  };
}

export function compareScopeCatalogContracts({ current, previous }) {
  const added = [...current.scopes]
    .filter(([key]) => !previous?.scopes.has(key))
    .map(([, scope]) => pair(scope))
    .sort((left, right) => compareCodeUnits(pairKey(left), pairKey(right)));
  const removed = previous
    ? [...previous.scopes]
        .filter(([key]) => !current.scopes.has(key))
        .map(([, scope]) => pair(scope))
        .sort((left, right) => compareCodeUnits(pairKey(left), pairKey(right)))
    : [];
  const changes = [];
  let impact = previous ? "none" : "minor";

  if (previous && current.fingerprint !== previous.fingerprint) {
    if (!buffersEqual(current.catalogSchemaBytes, previous.catalogSchemaBytes)) {
      impact = maxImpact(impact, "major");
    }
    if (removed.length > 0) impact = maxImpact(impact, "major");
    if (added.length > 0) impact = maxImpact(impact, "minor");

    for (const [key, currentScope] of current.scopes) {
      const previousScope = previous.scopes.get(key);
      if (!previousScope) continue;
      const change = { pair: pair(currentScope) };
      const description = changedField(previousScope.description, currentScope.description);
      const previousSchemaMetadata = { ...previousScope.schema };
      const currentSchemaMetadata = { ...currentScope.schema };
      delete previousSchemaMetadata.url;
      delete currentSchemaMetadata.url;
      const schema = changedField(previousSchemaMetadata, currentSchemaMetadata);
      const maturity = changedField(previousScope.maturity, currentScope.maturity);
      const desktop = changedField(
        normalizeDesktop(previousScope.fulfillment?.desktop),
        normalizeDesktop(currentScope.fulfillment?.desktop),
      );
      const web = changedField(
        normalizeWeb(previousScope.fulfillment?.web),
        normalizeWeb(currentScope.fulfillment?.web),
      );
      if (description) {
        change.description = description;
        impact = maxImpact(impact, "patch");
      }
      if (schema) {
        change.schema = {
          previous: schemaReleaseValue(previous, previousScope),
          current: schemaReleaseValue(current, currentScope),
        };
        impact = maxImpact(impact, "major");
      }
      if (maturity) {
        change.maturity = maturity;
        impact = maxImpact(
          impact,
          classifyMaturity(previousScope.maturity, currentScope.maturity),
        );
      }
      if (desktop) {
        change.desktop = desktop;
        impact = maxImpact(
          impact,
          classifyDesktop(
            previousScope.fulfillment?.desktop,
            currentScope.fulfillment?.desktop,
          ),
        );
      }
      if (web) {
        change.web = web;
        impact = maxImpact(
          impact,
          classifyWeb(previousScope.fulfillment?.web, currentScope.fulfillment?.web),
        );
      }
      const previousSchemaBytes = previous.payloadSchemas.get(previousScope.schema.path);
      const currentSchemaBytes = current.payloadSchemas.get(currentScope.schema.path);
      if (!buffersEqual(previousSchemaBytes, currentSchemaBytes)) {
        impact = maxImpact(impact, "major");
        if (!change.schema) {
          change.schema = {
            previous: schemaReleaseValue(previous, previousScope),
            current: schemaReleaseValue(current, currentScope),
          };
        }
      }
      if (Object.keys(change).length > 1) changes.push(change);
    }

    const previousTopLevel = structuredClone(previous.normalizedCatalog);
    const currentTopLevel = structuredClone(current.normalizedCatalog);
    delete previousTopLevel.scopes;
    delete currentTopLevel.scopes;
    if (!valuesEqual(previousTopLevel, currentTopLevel)) {
      const breakingTopLevelChange =
        previousTopLevel.catalogVersion !== currentTopLevel.catalogVersion ||
        !valuesEqual(previousTopLevel.catalogSchema, currentTopLevel.catalogSchema);
      impact = maxImpact(impact, breakingTopLevelChange ? "major" : "patch");
    }
    if (impact === "none") impact = "patch";
  }

  if (previous && current.fingerprint === previous.fingerprint) {
    impact = "none";
  }
  const previousVersion = previous?.version ?? null;
  const currentVersion = previousVersion ? bumpVersion(previousVersion, impact) : "1.0.0";
  return {
    schemaVersion: "1.0.0",
    currentVersion,
    previousVersion,
    currentContractFingerprint: current.fingerprint,
    previousContractFingerprint: previous?.fingerprint ?? null,
    added,
    removed,
    changes,
    impact,
  };
}

export function decideScopeCatalogPublication({
  eventName,
  packageExists,
  initialConfirmed,
  release,
}) {
  if (!["push", "workflow_dispatch"].includes(eventName)) {
    throw new Error(`Unsupported publication event: ${eventName}`);
  }
  if (!["major", "minor", "patch", "none"].includes(release?.impact)) {
    throw new Error(`Unsupported release impact: ${release?.impact}`);
  }
  if (release.impact === "none") {
    return {
      shouldPublish: false,
      authentication: "none",
      reason: "Public contract fingerprint is unchanged.",
    };
  }
  if (packageExists) {
    if (!release.previousVersion) {
      throw new Error("A published predecessor requires previousVersion");
    }
    return {
      shouldPublish: true,
      authentication: "oidc-trusted-publishing",
      reason: `Published predecessor ${release.previousVersion} exists; release impact is ${release.impact}.`,
    };
  }
  if (eventName === "workflow_dispatch" && initialConfirmed) {
    if (release.currentVersion !== "1.0.0" || release.previousVersion !== null) {
      throw new Error("Initial publication must be 1.0.0 with no previous version");
    }
    return {
      shouldPublish: true,
      authentication: "bootstrap-token",
      reason: "Initial 1.0.0 publication explicitly confirmed by Callum.",
    };
  }
  return {
    shouldPublish: false,
    authentication: "none",
    reason:
      "Initial package does not exist; push and unconfirmed dispatch runs validate and pack but cannot publish.",
  };
}

function parseArgs(argv) {
  const result = { currentRoot: defaultRepoRoot, previousRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--current-package" && argv[index + 1]) {
      result.currentRoot = resolve(argv[++index]);
    } else if (argument === "--previous-package" && argv[index + 1]) {
      result.previousRoot = resolve(argv[++index]);
    } else {
      throw new Error(
        "Usage: node scripts/diff-scope-catalog-package.mjs [--current-package <path>] [--previous-package <path>]",
      );
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { currentRoot, previousRoot } = parseArgs(process.argv.slice(2));
    const release = compareScopeCatalogContracts({
      current: readContractSnapshot(currentRoot),
      previous: previousRoot ? readContractSnapshot(previousRoot) : null,
    });
    process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
  } catch (error) {
    console.error(
      `[diff-scope-catalog-package] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
