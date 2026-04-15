import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve as resolvePath } from "node:path";
import { verify as verifySigstoreBundle } from "sigstore";

export const DEFAULT_CONNECTOR_INDEX_URL =
  "https://github.com/vana-com/data-connectors/releases/download/connectors-latest/connector-index.json";
export const DEFAULT_SIGSTORE_CERTIFICATE_ISSUER =
  "https://token.actions.githubusercontent.com";
export const DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY =
  "https://github.com/vana-com/data-connectors/.github/workflows/publish-connector-release-index.yml@refs/heads/main";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Unsupported version format "${version}"`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(a, b) {
  const av = typeof a === "string" ? parseVersion(a) : a;
  const bv = typeof b === "string" ? parseVersion(b) : b;
  if (av.major !== bv.major) return av.major - bv.major;
  if (av.minor !== bv.minor) return av.minor - bv.minor;
  return av.patch - bv.patch;
}

function evaluateComparator(version, comparator) {
  if (comparator === "*" || comparator === "") {
    return true;
  }

  const match = /^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(comparator);
  if (!match) {
    throw new Error(`Unsupported comparator "${comparator}"`);
  }

  const operator = match[1] ?? "=";
  const target = parseVersion(match[2]);
  const cmp = compareVersions(version, target);

  switch (operator) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "^":
      return (
        cmp >= 0 &&
        compareVersions(version, {
          major: target.major + 1,
          minor: 0,
          patch: 0,
        }) < 0
      );
    case "~":
      return (
        cmp >= 0 &&
        compareVersions(version, {
          major: target.major,
          minor: target.minor + 1,
          patch: 0,
        }) < 0
      );
    default:
      return false;
  }
}

export function satisfies(versionString, range) {
  const version = parseVersion(versionString);
  const normalized = range.trim();
  if (normalized === "" || normalized === "*") {
    return true;
  }
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => evaluateComparator(version, token));
}

export function selectResolvedEntry(entries, constraint, connectorId) {
  const matches = entries.filter((entry) => satisfies(entry.version, constraint));
  if (matches.length === 0) {
    const available = entries.map((entry) => entry.version).join(", ");
    throw new Error(
      `No published version for ${connectorId} satisfies "${constraint}". Available: ${available || "(none)"}`
    );
  }
  return matches.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function extractAvailableVersions(indexDoc, connectorId) {
  if (!indexDoc.connectors || typeof indexDoc.connectors !== "object") {
    throw new Error("Unsupported connector index shape");
  }
  const entries = indexDoc.connectors[connectorId];
  return Array.isArray(entries) ? entries : [];
}

async function fetchBinary(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function normalizeSignature(signature) {
  if (!signature || typeof signature !== "object") {
    return null;
  }

  return {
    type: signature.type ?? null,
    bundlePath: signature.bundlePath ?? signature.bundle_path ?? null,
    bundleUrl: signature.bundleUrl ?? signature.bundle_url ?? null,
  };
}

function resolveBundleUrl(subjectUrl, signature) {
  if (signature?.bundleUrl) {
    return signature.bundleUrl;
  }
  if (signature?.bundlePath) {
    return new URL(signature.bundlePath, subjectUrl).toString();
  }
  return `${subjectUrl}.sigstore.json`;
}

async function verifyRemoteSignature({
  payloadBuffer,
  subjectLabel,
  subjectUrl,
  signature,
  allowUnsignedRemote = false,
}) {
  const normalizedSignature = normalizeSignature(signature);
  if (!normalizedSignature) {
    if (allowUnsignedRemote) {
      return false;
    }
    throw new Error(`${subjectLabel} is missing Sigstore bundle metadata`);
  }

  const bundleUrl = resolveBundleUrl(subjectUrl, normalizedSignature);
  const bundleBuffer = await fetchBinary(bundleUrl);
  const bundle = JSON.parse(bundleBuffer.toString("utf8"));

  try {
    await verifySigstoreBundle(bundle, payloadBuffer, {
      certificateIssuer: DEFAULT_SIGSTORE_CERTIFICATE_ISSUER,
      certificateIdentityURI: DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
    });
  } catch (error) {
    throw new Error(
      `${subjectLabel} signature verification failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return true;
}

function ensureInside(baseDir, relativePath) {
  if (relativePath.startsWith("/") || relativePath.includes("\\")) {
    throw new Error(`Invalid artifact path "${relativePath}"`);
  }
  const normalizedPath = normalize(relativePath);
  if (normalizedPath.startsWith("..")) {
    throw new Error(`Artifact path escapes bundle root: "${relativePath}"`);
  }
  return join(baseDir, normalizedPath);
}

function walkFiles(dir, root = dir) {
  if (!existsSync(dir)) {
    return [];
  }

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

function unpackArtifactBuffer(buffer) {
  const tempRoot = mkdtempSync(join(tmpdir(), "connector-artifact-"));
  const tarPath = join(tempRoot, "artifact.tgz");
  const unpackDir = join(tempRoot, "bundle");
  mkdirSync(unpackDir, { recursive: true });
  writeFileSync(tarPath, buffer);
  execFileSync("tar", ["-xzf", tarPath, "-C", unpackDir]);

  try {
    const files = walkFiles(unpackDir);
    const manifestFile = files.find((file) => file.relativePath === "manifest.json");
    const scriptFile = files.find((file) => file.relativePath === "script.js");
    if (!manifestFile || !scriptFile) {
      throw new Error("Artifact missing manifest.json or script.js");
    }

    const schemaFiles = [];
    const assetFiles = [];
    let readme = null;

    for (const file of files) {
      if (file.relativePath === "manifest.json" || file.relativePath === "script.js") {
        continue;
      }
      if (file.relativePath === "README.md") {
        readme = {
          path: file.relativePath,
          buffer: readFileSync(file.path),
        };
        continue;
      }
      if (file.relativePath.startsWith("schemas/")) {
        schemaFiles.push({
          path: file.relativePath,
          buffer: readFileSync(file.path),
        });
        continue;
      }
      assetFiles.push({
        path: file.relativePath,
        buffer: readFileSync(file.path),
      });
    }

    return {
      manifestBuffer: readFileSync(manifestFile.path),
      scriptBuffer: readFileSync(scriptFile.path),
      schemaFiles,
      assetFiles,
      readme,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function resolveIndexSourcePath(rootDir) {
  const candidates = [
    join(rootDir, "connector-index.json"),
    join(rootDir, "dist", "connector-index.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function loadConnectorIndex({
  fromLocal = null,
  indexUrl = null,
  defaultLocalSource = null,
  defaultIndexUrl = DEFAULT_CONNECTOR_INDEX_URL,
  preferDefaultLocal = false,
  allowUnsignedRemote = false,
}) {
  const resolvedLocal = fromLocal
    ? resolvePath(fromLocal)
    : preferDefaultLocal && defaultLocalSource
      ? resolvePath(defaultLocalSource)
      : null;

  if (resolvedLocal && existsSync(resolvedLocal)) {
    const indexPath = resolveIndexSourcePath(resolvedLocal);
    if (!indexPath) {
      throw new Error(`No connector-index.json found under ${resolvedLocal}`);
    }
    return {
      mode: "local",
      rootDir: resolvedLocal,
      indexUrl: null,
      indexPath,
      doc: readJson(indexPath),
    };
  }

  const url = indexUrl ?? defaultIndexUrl;
  if (!url) {
    throw new Error("No connector index source configured");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const indexBuffer = Buffer.from(await response.arrayBuffer());
  const doc = JSON.parse(indexBuffer.toString("utf8"));
  const signatureVerified = await verifyRemoteSignature({
    payloadBuffer: indexBuffer,
    subjectLabel: "Connector index",
    subjectUrl: url,
    signature: doc.signature,
    allowUnsignedRemote,
  });

  return {
    mode: "remote",
    rootDir: null,
    indexUrl: url,
    indexPath: null,
    doc,
    signatureVerified,
  };
}

function resolveArtifactLocalPath(rootDir, artifactPath, connectorId) {
  if (!artifactPath) {
    throw new Error(`Local connector index entry for ${connectorId} is missing artifactPath`);
  }
  const resolvedPath = ensureInside(rootDir, artifactPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Local artifact not found: ${resolvedPath}`);
  }
  return resolvedPath;
}

function deriveSourceMeta(indexSource, connectors = []) {
  if (indexSource?.mode === "local" && indexSource.rootDir) {
    try {
      const sourceTag = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: indexSource.rootDir,
        encoding: "utf8",
      }).trim();
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: indexSource.rootDir,
        encoding: "utf8",
      }).trim();
      return { sourceTag, sourceCommit };
    } catch {
      return {
        sourceTag: resolvePath(indexSource.rootDir),
        sourceCommit: "unknown",
      };
    }
  }

  const sourceTags = [...new Set(connectors.map((entry) => entry.sourceTag).filter(Boolean))];
  const sourceCommits = [...new Set(connectors.map((entry) => entry.sourceCommit).filter(Boolean))];
  return {
    sourceTag: sourceTags.length === 1 ? sourceTags[0] : "mixed",
    sourceCommit: sourceCommits.length === 1 ? sourceCommits[0] : "mixed",
  };
}

function normalizeLockEntry(entry) {
  return {
    connectorId: entry.connectorId ?? entry.id,
    company: entry.company,
    version: entry.version,
    resolvedFrom: entry.resolvedFrom ?? entry.resolved_from ?? entry.version,
    sourceFiles: entry.sourceFiles ?? entry.source_files ?? entry.files,
    artifactUrl: entry.artifactUrl ?? entry.artifact_url ?? null,
    artifactPath: entry.artifactPath ?? entry.artifact_path ?? null,
    artifactSha256: entry.artifactSha256 ?? entry.artifact_sha256 ?? entry.checksums?.artifact,
    artifactSignature: normalizeSignature(
      entry.artifactSignature ?? entry.artifact_signature ?? null
    ),
    manifestSha256:
      entry.manifestSha256 ?? entry.manifest_sha256 ?? entry.checksums?.metadata,
    scriptSha256: entry.scriptSha256 ?? entry.script_sha256 ?? entry.checksums?.script,
    sourceTag: entry.sourceTag ?? entry.source_tag ?? entry.gitRef ?? entry.git_ref ?? null,
    sourceCommit:
      entry.sourceCommit ?? entry.source_commit ?? entry.gitRef ?? entry.git_ref ?? null,
    releaseId: entry.releaseId ?? entry.release_id ?? null,
    publishedAt: entry.publishedAt ?? entry.published_at ?? null,
    name: entry.name ?? null,
    description: entry.description ?? null,
  };
}

async function fetchArtifactForEntry(indexSource, entry) {
  if (indexSource?.mode === "local") {
    const artifactPath = resolveArtifactLocalPath(
      indexSource.rootDir,
      entry.artifactPath,
      entry.connectorId
    );
    return readFileSync(artifactPath);
  }

  if (!entry.artifactUrl) {
    throw new Error(`Connector ${entry.connectorId} is missing artifactUrl`);
  }
  const artifactBuffer = await fetchBinary(entry.artifactUrl);
  await verifyRemoteSignature({
    payloadBuffer: artifactBuffer,
    subjectLabel: `Connector artifact ${entry.connectorId}@${entry.version}`,
    subjectUrl: entry.artifactUrl,
    signature: entry.artifactSignature,
  });
  return artifactBuffer;
}

function unpackAndVerifyArtifact(entry, artifactBuffer) {
  const artifactChecksum = sha256Buffer(artifactBuffer);
  if (entry.artifactSha256 && entry.artifactSha256 !== artifactChecksum) {
    throw new Error(
      `${entry.connectorId} artifact checksum mismatch: expected ${entry.artifactSha256}, got ${artifactChecksum}`
    );
  }

  const unpacked = unpackArtifactBuffer(artifactBuffer);
  const manifest = JSON.parse(unpacked.manifestBuffer.toString("utf8"));
  const manifestChecksum = sha256Buffer(unpacked.manifestBuffer);
  const scriptChecksum = sha256Buffer(unpacked.scriptBuffer);

  if (entry.manifestSha256 && entry.manifestSha256 !== manifestChecksum) {
    throw new Error(
      `${entry.connectorId} manifest checksum mismatch: expected ${entry.manifestSha256}, got ${manifestChecksum}`
    );
  }
  if (entry.scriptSha256 && entry.scriptSha256 !== scriptChecksum) {
    throw new Error(
      `${entry.connectorId} script checksum mismatch: expected ${entry.scriptSha256}, got ${scriptChecksum}`
    );
  }

  if (entry.version && manifest.version !== entry.version) {
    throw new Error(
      `${entry.connectorId} version mismatch: index says ${entry.version} but artifact manifest declares ${manifest.version}`
    );
  }

  if (manifest.connector_id && manifest.connector_id !== entry.connectorId) {
    throw new Error(
      `${entry.connectorId} artifact manifest declares connector_id ${manifest.connector_id}`
    );
  }

  return {
    manifest,
    manifestBuffer: unpacked.manifestBuffer,
    scriptBuffer: unpacked.scriptBuffer,
    schemaFiles: unpacked.schemaFiles,
    assetFiles: unpacked.assetFiles,
    readme: unpacked.readme,
    checksums: {
      artifact: artifactChecksum,
      manifest: manifestChecksum,
      script: scriptChecksum,
    },
  };
}

function normalizeFetchedArtifact(entry, artifact) {
  return {
    connectorId: entry.connectorId,
    company: entry.company,
    version: entry.version,
    resolvedFrom: entry.resolvedFrom,
    entry,
    ...artifact,
  };
}

function metadataDirFromSourceFiles(entry) {
  const sourceFiles = entry.sourceFiles;
  if (!sourceFiles?.metadata || !sourceFiles?.script) {
    throw new Error(`Connector ${entry.connectorId} is missing sourceFiles metadata/script`);
  }
  return dirname(sourceFiles.metadata);
}

function buildSnapshotWrites(installRoot, resolved) {
  const writes = [
    {
      relativePath: `manifests/${resolved.connectorId}.json`,
      buffer: resolved.manifestBuffer,
    },
    {
      relativePath: `scripts/${resolved.connectorId}.js`,
      buffer: resolved.scriptBuffer,
    },
  ];

  for (const schemaFile of resolved.schemaFiles) {
    const fileName = schemaFile.path.split("/").at(-1);
    if (!fileName) continue;
    const relativePath = `schemas/${fileName}`;
    writes.push({
      relativePath,
      buffer: schemaFile.buffer,
    });
  }

  for (const assetFile of resolved.assetFiles) {
    writes.push({
      relativePath: `assets/${resolved.connectorId}/${assetFile.path}`,
      buffer: assetFile.buffer,
    });
  }

  return writes.map((write) => ({
    ...write,
    absolutePath: join(installRoot, write.relativePath),
  }));
}

function buildSourceWrites(installRoot, resolved) {
  const metadataDir = metadataDirFromSourceFiles(resolved.entry);
  const writes = [
    {
      relativePath: resolved.entry.sourceFiles.metadata,
      buffer: resolved.manifestBuffer,
    },
    {
      relativePath: resolved.entry.sourceFiles.script,
      buffer: resolved.scriptBuffer,
    },
  ];

  for (const schemaFile of resolved.schemaFiles) {
    const fileName = schemaFile.path.split("/").at(-1);
    if (!fileName || fileName === "manifest.schema.json") continue;
    writes.push({
      relativePath: join(metadataDir, "schemas", fileName),
      buffer: schemaFile.buffer,
    });
  }

  for (const assetFile of resolved.assetFiles) {
    writes.push({
      relativePath: join(metadataDir, assetFile.path),
      buffer: assetFile.buffer,
    });
  }

  if (resolved.readme) {
    writes.push({
      relativePath: join(metadataDir, resolved.readme.path),
      buffer: resolved.readme.buffer,
    });
  }

  return writes.map((write) => ({
    ...write,
    absolutePath: join(installRoot, write.relativePath),
  }));
}

function buildInstallWrites(layout, installRoot, resolved) {
  if (layout === "snapshot") {
    return buildSnapshotWrites(installRoot, resolved);
  }
  if (layout === "source") {
    return buildSourceWrites(installRoot, resolved);
  }
  throw new Error(`Unsupported install layout "${layout}"`);
}

async function fetchLockArtifacts({ lock, source }) {
  const normalizedEntries = (lock.connectors ?? []).map(normalizeLockEntry);
  const resolved = [];

  for (const entry of normalizedEntries) {
    const artifactBuffer = await fetchArtifactForEntry(source, entry);
    const artifact = unpackAndVerifyArtifact(entry, artifactBuffer);
    resolved.push(normalizeFetchedArtifact(entry, artifact));
  }

  return resolved;
}

function expectedWritesForLock({ installRoot, layout, resolved }) {
  return resolved.flatMap((entry) => buildInstallWrites(layout, installRoot, entry));
}

function ensureParentDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function removeUnexpectedEntries(installRoot, expectedPaths, preserveTopLevel = []) {
  const expected = new Set(expectedPaths);
  const preserve = new Set(preserveTopLevel);

  for (const file of walkFiles(installRoot)) {
    if (expected.has(file.relativePath)) {
      continue;
    }
    const topLevel = file.relativePath.split("/")[0];
    if (preserve.has(topLevel)) {
      continue;
    }
    rmSync(file.path, { force: true });
  }

  const candidateDirs = walkFiles(installRoot)
    .map((file) => dirname(join(installRoot, file.relativePath)))
    .sort((a, b) => b.length - a.length);

  for (const dir of candidateDirs) {
    if (dir === installRoot) continue;
    try {
      if (readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Ignore races from nested cleanup.
    }
  }
}

export async function fetchResolvedArtifact(indexSource, entry) {
  const normalizedEntry = normalizeLockEntry(entry);
  const artifactBuffer = await fetchArtifactForEntry(indexSource, normalizedEntry);
  return unpackAndVerifyArtifact(normalizedEntry, artifactBuffer);
}

export async function resolveConnectorArtifacts({
  dependencies,
  requestedConnectorIds,
  source,
}) {
  const connectorIds = requestedConnectorIds ?? Object.keys(dependencies.connectors);
  const resolved = [];

  for (const connectorId of connectorIds) {
    const constraint = dependencies.connectors[connectorId];
    if (!constraint) {
      throw new Error(`Missing version constraint for ${connectorId}`);
    }
    const availableEntries = extractAvailableVersions(source.doc, connectorId);
    const selected = selectResolvedEntry(availableEntries, constraint, connectorId);
    const artifact = await fetchResolvedArtifact(source, selected);
    resolved.push({
      connectorId,
      constraint,
      entry: selected,
      ...artifact,
    });
  }

  return {
    source,
    resolved,
  };
}

export async function generateLock({
  dependencies,
  source,
  dependencyFile = null,
  lockVersion = "1.0",
  generatedAt = new Date().toISOString(),
  requestedConnectorIds,
}) {
  const resolution = await resolveConnectorArtifacts({
    dependencies,
    source,
    requestedConnectorIds,
  });
  const sourceMeta = deriveSourceMeta(
    source,
    resolution.resolved.map((entry) => entry.entry)
  );

  return {
    lockVersion,
    dependencyFile,
    generatedAt,
    sourceRepo:
      source.doc.sourceRepo ??
      dependencies.source_repo ??
      "https://github.com/vana-com/data-connectors",
    sourceTag: sourceMeta.sourceTag,
    sourceCommit: sourceMeta.sourceCommit,
    index: {
      mode: source.mode,
      path: source.indexPath,
      url: source.indexUrl,
      version: source.doc.indexVersion ?? "unknown",
      signatureVerified: source.signatureVerified ?? false,
    },
    dependencies: dependencies.connectors,
    connectors: resolution.resolved
      .map((resolved) => ({
        connectorId: resolved.connectorId,
        company: resolved.entry.company,
        version: resolved.entry.version,
        resolvedFrom: resolved.constraint,
        sourceFiles: resolved.entry.sourceFiles,
        artifactUrl: resolved.entry.artifactUrl ?? null,
        artifactPath: resolved.entry.artifactPath ?? null,
        artifactSha256: resolved.checksums.artifact,
        artifactSignature: resolved.entry.artifactSignature ?? null,
        manifestSha256: resolved.checksums.manifest,
        scriptSha256: resolved.checksums.script,
        sourceTag: resolved.entry.sourceTag ?? resolved.entry.gitRef ?? sourceMeta.sourceTag,
        sourceCommit:
          resolved.entry.sourceCommit ?? resolved.entry.gitRef ?? sourceMeta.sourceCommit,
        releaseId: resolved.entry.releaseId ?? null,
        publishedAt: resolved.entry.publishedAt ?? null,
        name: resolved.entry.name ?? resolved.manifest.name,
        description: resolved.entry.description ?? resolved.manifest.description,
      }))
      .sort((a, b) => a.connectorId.localeCompare(b.connectorId)),
  };
}

export async function checkForUpdates({ lock, indexDoc }) {
  const updates = [];

  for (const rawLockEntry of lock.connectors ?? []) {
    const lockEntry = normalizeLockEntry(rawLockEntry);
    const availableEntries = extractAvailableVersions(indexDoc, lockEntry.connectorId);
    if (availableEntries.length === 0) {
      updates.push({
        connectorId: lockEntry.connectorId,
        status: "missing_from_index",
        currentVersion: lockEntry.version,
        latestVersion: null,
      });
      continue;
    }

    const latest = availableEntries.sort((a, b) => compareVersions(b.version, a.version))[0];
    if (compareVersions(latest.version, lockEntry.version) > 0) {
      updates.push({
        connectorId: lockEntry.connectorId,
        status: "update_available",
        currentVersion: lockEntry.version,
        latestVersion: latest.version,
        artifactSha256: latest.artifactSha256,
        artifactSignature: normalizeSignature(latest.artifactSignature ?? null),
      });
    }
  }

  return {
    hasUpdates: updates.length > 0,
    updates,
  };
}

export function pruneInstalled({
  installRoot,
  expectedPaths,
  preserveTopLevel = [],
}) {
  removeUnexpectedEntries(installRoot, expectedPaths, preserveTopLevel);
  return {
    installRoot,
    expectedCount: expectedPaths.length,
  };
}

export async function installFromLock({
  lock,
  source,
  installRoot,
  layout,
  prune = false,
  preserveTopLevel = [],
}) {
  const resolved = await fetchLockArtifacts({ lock, source });
  const writes = expectedWritesForLock({ installRoot, layout, resolved });
  const expectedPaths = writes.map((write) => write.relativePath);

  for (const write of writes) {
    ensureParentDir(write.absolutePath);
    writeFileSync(write.absolutePath, write.buffer);
  }

  if (prune) {
    pruneInstalled({
      installRoot,
      expectedPaths,
      preserveTopLevel,
    });
  }

  return {
    installRoot,
    layout,
    connectorCount: resolved.length,
    filesWritten: writes.length,
    expectedPaths,
  };
}

export async function verifyInstalled({
  lock,
  source,
  installRoot,
  layout,
}) {
  const resolved = await fetchLockArtifacts({ lock, source });
  const writes = expectedWritesForLock({ installRoot, layout, resolved });
  const missing = [];
  const mismatched = [];

  for (const write of writes) {
    if (!existsSync(write.absolutePath)) {
      missing.push(write.relativePath);
      continue;
    }

    const currentChecksum = sha256Buffer(readFileSync(write.absolutePath));
    const expectedChecksum = sha256Buffer(write.buffer);
    if (currentChecksum !== expectedChecksum) {
      mismatched.push(write.relativePath);
    }
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    installRoot,
    layout,
    expectedCount: writes.length,
    missing,
    mismatched,
  };
}
