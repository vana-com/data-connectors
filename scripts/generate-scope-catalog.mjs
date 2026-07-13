#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, "..");
const repositoryUrl = "https://github.com/vana-com/data-connectors";
const rawRepositoryUrl = "https://raw.githubusercontent.com/vana-com/data-connectors";
const maturityRank = new Map([
  ["stable", 0],
  ["beta", 1],
  ["experimental", 2],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function formatValidationErrors(errors) {
  return (errors ?? [])
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message}`)
    .join("; ");
}

function validateAgainstSchema(document, schema, label) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(document)) {
    throw new Error(
      `${label} failed schema validation: ${formatValidationErrors(validate.errors)}`,
    );
  }
}

function scopeIdFromManifestEntry(entry) {
  return typeof entry === "string" ? entry : entry?.scope;
}

function descriptionFromManifestEntry(entry) {
  return typeof entry === "object" ? entry?.description : null;
}

function supportsScopeLimits(manifestVersion) {
  const [major, minor] = String(manifestVersion).split(".").map(Number);
  return major > 1 || (major === 1 && minor >= 1);
}

function loadPublishedScopes(repoRoot) {
  const registry = readJson(join(repoRoot, "registry.json"));
  if (!Array.isArray(registry.connectors)) {
    throw new Error("registry.json must contain a connectors array");
  }

  const groupedScopes = new Map();
  const manifestPaths = [];
  const seenConnectorIds = new Set();

  for (const registryEntry of registry.connectors) {
    if (seenConnectorIds.has(registryEntry.id)) {
      throw new Error(`Duplicate registry connector id: ${registryEntry.id}`);
    }
    seenConnectorIds.add(registryEntry.id);

    if (!maturityRank.has(registryEntry.status)) {
      throw new Error(
        `Registry connector ${registryEntry.id} has invalid status ${registryEntry.status}`,
      );
    }

    const metadataPath = join(repoRoot, "connectors", registryEntry.files?.metadata ?? "");
    if (!existsSync(metadataPath)) {
      throw new Error(`Registry connector ${registryEntry.id} metadata does not exist`);
    }
    const manifest = readJson(metadataPath);
    manifestPaths.push(relative(repoRoot, metadataPath));
    if (manifest.connector_id !== registryEntry.id) {
      throw new Error(
        `Registry connector ${registryEntry.id} points to manifest ${manifest.connector_id}`,
      );
    }
    if (!manifest.source_id || !Array.isArray(manifest.scopes)) {
      throw new Error(`Manifest ${relative(repoRoot, metadataPath)} has no source_id or scopes`);
    }

    const manifestScopeIds = new Set();
    for (const scopeEntry of manifest.scopes) {
      const scopeId = scopeIdFromManifestEntry(scopeEntry);
      const description = descriptionFromManifestEntry(scopeEntry);
      if (!scopeId || !description?.trim()) {
        throw new Error(
          `Published manifest ${relative(repoRoot, metadataPath)} must describe every scope`,
        );
      }
      if (!scopeId.startsWith(`${manifest.source_id}.`)) {
        throw new Error(
          `${scopeId} does not belong to manifest source_id ${manifest.source_id}`,
        );
      }
      if (manifestScopeIds.has(scopeId)) {
        throw new Error(
          `${relative(repoRoot, metadataPath)} declares duplicate scope ${scopeId}`,
        );
      }
      manifestScopeIds.add(scopeId);
      if (scopeEntry.limits && !supportsScopeLimits(manifest.manifest_version)) {
        throw new Error(
          `${relative(repoRoot, metadataPath)} must use manifest_version 1.1 or later to declare scope limits`,
        );
      }

      const schemaPath = join(dirname(metadataPath), "schemas", `${scopeId}.json`);
      if (!existsSync(schemaPath)) {
        throw new Error(`Missing schema for published scope ${scopeId}`);
      }
      const scopeSchema = readJson(schemaPath);
      if (scopeSchema.scope !== scopeId || !scopeSchema.description?.trim()) {
        throw new Error(
          `Schema ${relative(repoRoot, schemaPath)} must identify and describe ${scopeId}`,
        );
      }

      const candidate = {
        sourceId: manifest.source_id,
        description: description.trim(),
        schemaPath: relative(repoRoot, schemaPath),
        connector: {
          id: registryEntry.id,
          status: registryEntry.status,
          ...(scopeEntry.limits ? { limits: scopeEntry.limits } : {}),
        },
      };
      const group = groupedScopes.get(scopeId) ?? [];
      group.push(candidate);
      groupedScopes.set(scopeId, group);
    }
  }

  return {
    groupedScopes,
    manifestPaths: manifestPaths.sort((left, right) => left.localeCompare(right)),
  };
}

function validateExactWebSet(publishedScopes, webInput) {
  const webIds = webInput.scopes.map(({ scopeId }) => scopeId);
  const duplicateIds = webIds.filter((scopeId, index) => webIds.indexOf(scopeId) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate Web capability entries: ${[...new Set(duplicateIds)].sort().join(", ")}`);
  }

  const publishedIds = new Set(publishedScopes.keys());
  const webIdSet = new Set(webIds);
  const missing = [...publishedIds].filter((scopeId) => !webIdSet.has(scopeId)).sort();
  const extra = [...webIdSet].filter((scopeId) => !publishedIds.has(scopeId)).sort();
  if (missing.length > 0) {
    throw new Error(`Missing Web capability entries: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    throw new Error(`Extra Web capability entries: ${extra.join(", ")}`);
  }
}

function buildCatalog(repoRoot, { sourceCommit, releaseTag } = {}) {
  if ((sourceCommit && !releaseTag) || (!sourceCommit && releaseTag)) {
    throw new Error("sourceCommit and releaseTag must be provided together");
  }
  if (sourceCommit && !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("sourceCommit must be a full lowercase Git commit SHA");
  }
  const webInputPath = join(repoRoot, "scopes", "web-capabilities.json");
  const webInput = readJson(webInputPath);
  const webInputSchema = readJson(
    join(repoRoot, "schemas", "web-scope-capabilities.schema.json"),
  );
  validateAgainstSchema(webInput, webInputSchema, "web-capabilities.json");

  const { groupedScopes: publishedScopes, manifestPaths } = loadPublishedScopes(repoRoot);
  validateExactWebSet(publishedScopes, webInput);

  const blockerById = new Map();
  for (const blocker of webInput.blockers) {
    if (blockerById.has(blocker.id)) {
      throw new Error(`Duplicate Web blocker id: ${blocker.id}`);
    }
    blockerById.set(blocker.id, blocker);
  }
  const webByScope = new Map(webInput.scopes.map((entry) => [entry.scopeId, entry]));

  const scopes = [...publishedScopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scopeId, candidates]) => {
      candidates.sort(
        (left, right) =>
          maturityRank.get(left.connector.status) - maturityRank.get(right.connector.status) ||
          left.connector.id.localeCompare(right.connector.id),
      );
      const primary = candidates[0];
      if (candidates.some(({ sourceId }) => sourceId !== primary.sourceId)) {
        throw new Error(`Published scope ${scopeId} has conflicting source IDs`);
      }
      const descriptions = new Set(candidates.map(({ description }) => description));
      if (descriptions.size > 1) {
        throw new Error(`Published scope ${scopeId} has conflicting manifest descriptions`);
      }
      const schemaPaths = new Set(candidates.map(({ schemaPath }) => schemaPath));
      if (schemaPaths.size > 1) {
        throw new Error(
          `Published scope ${scopeId} has conflicting schema paths: ${[...schemaPaths].sort().join(", ")}`,
        );
      }

      const webInputEntry = webByScope.get(scopeId);
      const web = { status: webInputEntry.status };
      if (webInputEntry.limits) {
        web.limits = webInputEntry.limits;
      }
      if (webInputEntry.blockerId) {
        const blocker = blockerById.get(webInputEntry.blockerId);
        if (!blocker) {
          throw new Error(
            `Web capability ${scopeId} references unknown blocker ${webInputEntry.blockerId}`,
          );
        }
        web.blocker = blocker;
      }

      return {
        sourceId: primary.sourceId,
        scopeId,
        description: primary.description,
        schema: {
          path: primary.schemaPath,
          ...(sourceCommit
            ? { url: `${rawRepositoryUrl}/${sourceCommit}/${primary.schemaPath}` }
            : {}),
        },
        maturity: primary.connector.status,
        fulfillment: {
          desktop: {
            status: "supported",
            connectors: candidates.map(({ connector }) => connector),
          },
          web,
        },
      };
    });

  const catalog = {
    catalogSchema: {
      path: "schemas/scope-catalog.schema.json",
      releaseAsset: "scope-catalog.schema.json",
    },
    distribution: {
      repository: repositoryUrl,
      ...(sourceCommit ? { sourceCommit, releaseTag } : {}),
    },
    catalogVersion: "1.0.0",
    generatedBy: "scripts/generate-scope-catalog.mjs",
    generatedFrom: {
      publishability: {
        path: "registry.json",
        manifestSelector: "connectors[].files.metadata",
      },
      manifests: manifestPaths,
      webCapabilities: "scopes/web-capabilities.json",
    },
    scopes,
  };
  const catalogSchema = readJson(join(repoRoot, "schemas", "scope-catalog.schema.json"));
  validateAgainstSchema(catalog, catalogSchema, "scope-catalog.json");
  return catalog;
}

function renderWebStatus(web) {
  if (web.status === "supported") return "✅";
  if (web.status === "blocked") return `Blocked (${web.blocker.id})`;
  return "—";
}

function renderLimits(scope) {
  const limits = [];
  for (const limit of scope.fulfillment.web.limits ?? []) {
    limits.push(`Web: ${limit.description}`);
  }
  for (const connector of scope.fulfillment.desktop.connectors) {
    for (const limit of connector.limits ?? []) {
      limits.push(`Desktop (${connector.id}): ${limit.description}`);
    }
  }
  return limits.join("; ") || "—";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderScopesMarkdown(catalog) {
  const rows = catalog.scopes.map((scope) => {
    const connectors = scope.fulfillment.desktop.connectors
      .map(({ id, status }) => `${id} (${status})`)
      .join("; ");
    return `| ${escapeCell(scope.sourceId)} | \`${scope.scopeId}\` | ${escapeCell(scope.description)} | [JSON Schema](${scope.schema.path}) | ${renderWebStatus(scope.fulfillment.web)} | ✅ | ${escapeCell(renderLimits(scope))} | ${escapeCell(connectors)} |`;
  });

  return `<!-- Generated by scripts/generate-scope-catalog.mjs. Do not edit. -->
# Scope Coverage Catalog

The public human-readable view of [\`scope-catalog.json\`](scope-catalog.json).
Connector manifests plus \`registry.json\` own published Desktop scopes. [\`scopes/web-capabilities.json\`](scopes/web-capabilities.json) independently owns Web/Data Pipe capability and limits.

## Versioned artifact contract

Every immutable \`connectors-<commit12>\` GitHub release includes \`scope-catalog.json\` and its Sigstore bundle. Resolve each \`schema.path\` against the full commit referenced by that release tag. The mutable \`main\` URL is only a discovery surface, not a version pin.

## Coverage

| Source | Scope | Description | Schema | Web | Desktop | Material limits | Connector(s) / maturity |
|---|---|---|---|:--:|:--:|---|---|
${rows.join("\n")}

## Blocked evidence

${catalog.scopes
  .filter(({ fulfillment }) => fulfillment.web.status === "blocked")
  .map(({ scopeId, fulfillment }) => `- \`${scopeId}\`: ${fulfillment.web.blocker.description} Required: ${fulfillment.web.blocker.requiredCapture.join(" ")}`)
  .join("\n") || "None."}

## Maintenance

Do not edit this file. Update connector manifests/\`registry.json\` for Desktop truth or \`scopes/web-capabilities.json\` for Web truth, then run \`node scripts/generate-scope-catalog.mjs\`.
`;
}

function checkOrWrite(path, expected, check) {
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
      throw new Error(
        `${relative(dirname(path), path)} drift detected. Run \`node scripts/generate-scope-catalog.mjs\`.`,
      );
    }
    return;
  }
  writeFileSync(path, expected);
}

export function generateScopeCatalog({
  repoRoot = defaultRepoRoot,
  check = false,
  sourceCommit,
  releaseTag,
} = {}) {
  const catalog = buildCatalog(repoRoot, { sourceCommit, releaseTag });
  checkOrWrite(
    join(repoRoot, "scope-catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
    check,
  );
  checkOrWrite(join(repoRoot, "SCOPES.md"), renderScopesMarkdown(catalog), check);
  return catalog;
}

function parseArgs(argv) {
  if (argv.length === 0) return { check: false };
  if (argv.length === 1 && argv[0] === "--check") return { check: true };
  throw new Error(`Usage: node scripts/generate-scope-catalog.mjs [--check]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { check } = parseArgs(process.argv.slice(2));
    const catalog = generateScopeCatalog({
      check,
      sourceCommit: process.env.SCOPE_CATALOG_SOURCE_COMMIT?.trim() || undefined,
      releaseTag: process.env.SCOPE_CATALOG_RELEASE_TAG?.trim() || undefined,
    });
    console.log(
      check
        ? `Scope catalog is up to date (${catalog.scopes.length} scopes).`
        : `Generated scope-catalog.json and SCOPES.md (${catalog.scopes.length} scopes).`,
    );
  } catch (error) {
    console.error(
      `[generate-scope-catalog] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
