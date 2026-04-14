#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const registryPath = join(repoRoot, "registry.json");
const indexPath = join(repoRoot, "connector-index.json");
const artifactsDir = join(repoRoot, "artifacts");

function resolveHeadGitRef() {
  const explicitRef = process.env.CONNECTOR_ARTIFACT_REF?.trim();
  if (explicitRef) {
    return explicitRef;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveCommittedArtifactRef(existingIndex) {
  if (!existingIndex?.connectors) {
    return null;
  }

  const refs = new Set();
  for (const versions of Object.values(existingIndex.connectors)) {
    if (!Array.isArray(versions) || versions.length === 0) {
      continue;
    }

    const latest = versions.at(-1);
    if (latest?.gitRef) {
      refs.add(latest.gitRef);
    }
  }

  if (refs.size === 1) {
    return [...refs][0];
  }

  return null;
}

function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function copyIntoBundle(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath));
}

function walkFiles(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full, root));
    } else {
      out.push({
        path: full,
        relativePath: full.slice(root.length + 1),
      });
    }
  }
  return out;
}

function normalizeManifestAssetPaths(manifest) {
  const assetPaths = [];
  if (typeof manifest.icon === "string" && manifest.icon.trim() !== "") {
    assetPaths.push(manifest.icon.trim());
  }
  if (typeof manifest.iconURL === "string" && manifest.iconURL.trim() !== "") {
    assetPaths.push(manifest.iconURL.trim());
  }
  return [...new Set(assetPaths)];
}

function resolveConnectorSchemaPath(metadataSource, scope) {
  const schemaSource = join(dirname(metadataSource), "schemas", `${scope}.json`);
  if (!existsSync(schemaSource)) {
    throw new Error(
      `Schema not found for ${metadataSource.slice(repoRoot.length + 1)}: schemas/${scope}.json`
    );
  }
  return schemaSource;
}

function createArtifactBundle(entry, metadata) {
  const tempRoot = mkdtempSync(join(tmpdir(), "connector-bundle-"));
  const bundleDir = join(tempRoot, "bundle");
  mkdirSync(bundleDir, { recursive: true });

  try {
    const scriptSource = join(repoRoot, "connectors", entry.files.script);
    const metadataSource = join(repoRoot, "connectors", entry.files.metadata);
    copyIntoBundle(metadataSource, join(bundleDir, "manifest.json"));
    copyIntoBundle(scriptSource, join(bundleDir, "script.js"));

    for (const scopeEntry of metadata.scopes ?? []) {
      const scope = typeof scopeEntry === "string" ? scopeEntry : scopeEntry?.scope;
      if (!scope) continue;
      const schemaSource = resolveConnectorSchemaPath(metadataSource, scope);
      copyIntoBundle(schemaSource, join(bundleDir, "schemas", `${scope}.json`));
    }

    copyIntoBundle(
      join(repoRoot, "schemas", "manifest.schema.json"),
      join(bundleDir, "schemas", "manifest.schema.json")
    );

    for (const relativeAssetPath of normalizeManifestAssetPaths(metadata)) {
      const assetSource = join(dirname(metadataSource), relativeAssetPath);
      if (!existsSync(assetSource)) {
        throw new Error(`Asset not found for ${entry.id}: ${relativeAssetPath}`);
      }
      copyIntoBundle(assetSource, join(bundleDir, relativeAssetPath));
    }

    const readmeSource = join(dirname(metadataSource), "README.md");
    if (existsSync(readmeSource)) {
      copyIntoBundle(readmeSource, join(bundleDir, "README.md"));
    }

    return {
      scriptSource,
      metadataSource,
      bundleDir,
    };
  } finally {
    // Caller is responsible for cleanup because bundleDir is needed for tar creation.
  }
}

function sortIndex(indexDoc) {
  const sorted = Object.fromEntries(
    Object.entries(indexDoc.connectors)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([connectorId, entries]) => [
        connectorId,
        entries.sort((a, b) => {
          const partsA = a.version.split(".").map(Number);
          const partsB = b.version.split(".").map(Number);
          return (
            partsA[0] - partsB[0] ||
            partsA[1] - partsB[1] ||
            partsA[2] - partsB[2]
          );
        }),
      ])
  );
  return {
    ...indexDoc,
    connectors: sorted,
  };
}

function main() {
  const checkMode = process.argv.includes("--check");
  const registry = readJson(registryPath);
  const existingIndex = existsSync(indexPath) ? readJson(indexPath) : null;
  const gitRef =
    process.env.CONNECTOR_ARTIFACT_REF?.trim() ||
    (checkMode && resolveCommittedArtifactRef(existingIndex)) ||
    resolveHeadGitRef();
  const repoBaseUrl = `https://raw.githubusercontent.com/vana-com/data-connectors/${gitRef}`;
  const nextIndex = {
    indexVersion: "1.0",
    sourceRepo: "https://github.com/vana-com/data-connectors",
    generatedAt: registry.lastUpdated ?? new Date().toISOString(),
    connectors: {},
  };

  if (!checkMode && !existsSync(artifactsDir)) {
    mkdirSync(artifactsDir, { recursive: true });
  }

  const expectedArtifactPaths = new Set();

  for (const entry of registry.connectors) {
    const metadata = readJson(join(repoRoot, "connectors", entry.files.metadata));
    const bundle = createArtifactBundle(entry, metadata);
    const artifactDir = join(artifactsDir, entry.id);
    mkdirSync(artifactDir, { recursive: true });
    const artifactFilename = `${entry.id}-${entry.version}.tgz`;
    const artifactPath = join(artifactDir, artifactFilename);
    const tempArtifactPath = join(dirname(bundle.bundleDir), artifactFilename);

    execFileSync("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "-czf",
      tempArtifactPath,
      "-C",
      bundle.bundleDir,
      ".",
    ]);

    const manifestBuffer = readFileSync(bundle.metadataSource);
    const scriptBuffer = readFileSync(bundle.scriptSource);
    const artifactBuffer = readFileSync(tempArtifactPath);

    const packaged = {
      connectorId: entry.id,
      company: entry.company,
      version: entry.version,
      name: entry.name,
      status: entry.status,
      description: entry.description,
      sourceFiles: entry.files,
      publishedAt: entry.publishedAt ?? entry.lastUpdated ?? registry.lastUpdated,
      gitRef: entry.gitRef ?? gitRef,
      pageApiVersion: metadata.page_api_version,
      manifestSha256: sha256Buffer(manifestBuffer),
      scriptSha256: sha256Buffer(scriptBuffer),
      artifactSha256: sha256Buffer(artifactBuffer),
      artifactPath: artifactPath.slice(repoRoot.length + 1),
      artifactUrl: `${repoBaseUrl}/${artifactPath.slice(repoRoot.length + 1)}`,
      scopes: (metadata.scopes ?? []).map((scopeEntry) =>
        typeof scopeEntry === "string" ? scopeEntry : scopeEntry.scope
      ),
      consumerMetadata: entry.consumerMetadata ?? null,
    };

    if (!checkMode) {
      writeFileSync(artifactPath, artifactBuffer);
    }

    expectedArtifactPaths.add(packaged.artifactPath);
    rmSync(dirname(bundle.bundleDir), { recursive: true, force: true });

    const previousVersions = existingIndex?.connectors?.[entry.id] ?? [];
    const retained = previousVersions.filter((version) => version.version !== entry.version);
    nextIndex.connectors[entry.id] = [...retained, packaged];
  }

  const normalizedIndex = sortIndex(nextIndex);
  const nextText = `${JSON.stringify(normalizedIndex, null, 2)}\n`;
  const beforeText = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

  if (checkMode) {
    if (beforeText !== nextText) {
      throw new Error(
        "connector-index.json drift detected. Run `node scripts/generate-connector-index.mjs`."
      );
    }

    for (const artifactPath of expectedArtifactPaths) {
      if (!existsSync(join(repoRoot, artifactPath))) {
        throw new Error(`Missing artifact: ${artifactPath}`);
      }
    }

    console.log("Connector index and artifacts are up to date.");
    return;
  }

  for (const file of walkFiles(artifactsDir)) {
    const repoRelativePath = `artifacts/${file.relativePath}`;
    if (!expectedArtifactPaths.has(repoRelativePath)) {
      unlinkSync(file.path);
    }
  }

  writeFileSync(indexPath, nextText);
  console.log(
    `Generated connector-index.json with ${Object.keys(normalizedIndex.connectors).length} connector entries.`
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
