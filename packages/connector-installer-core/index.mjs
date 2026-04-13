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
  defaultIndexUrl = null,
}) {
  const resolvedLocal = fromLocal
    ? resolvePath(fromLocal)
    : defaultLocalSource
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

  return {
    mode: "remote",
    rootDir: null,
    indexUrl: url,
    indexPath: null,
    doc: await response.json(),
  };
}

function resolveLocalArtifactPath(rootDir, entry) {
  if (!entry.artifactPath) {
    throw new Error(`Local connector index entry for ${entry.connectorId ?? entry.id} is missing artifactPath`);
  }
  const artifactPath = ensureInside(rootDir, entry.artifactPath);
  if (!existsSync(artifactPath)) {
    throw new Error(`Local artifact not found: ${artifactPath}`);
  }
  return artifactPath;
}

export async function fetchResolvedArtifact(indexSource, entry) {
  let artifactBuffer;

  if (indexSource.mode === "local") {
    const artifactPath = resolveLocalArtifactPath(indexSource.rootDir, entry);
    artifactBuffer = readFileSync(artifactPath);
  } else {
    artifactBuffer = await fetchBinary(entry.artifactUrl);
  }

  const artifactChecksum = sha256Buffer(artifactBuffer);
  if (entry.artifactSha256 && entry.artifactSha256 !== artifactChecksum) {
    throw new Error(
      `${entry.id ?? entry.connectorId} artifact checksum mismatch: expected ${entry.artifactSha256}, got ${artifactChecksum}`
    );
  }

  const unpacked = unpackArtifactBuffer(artifactBuffer);
  const manifest = JSON.parse(unpacked.manifestBuffer.toString("utf8"));
  const manifestChecksum = sha256Buffer(unpacked.manifestBuffer);
  const scriptChecksum = sha256Buffer(unpacked.scriptBuffer);

  if (entry.manifestSha256 && entry.manifestSha256 !== manifestChecksum) {
    throw new Error(
      `${entry.id ?? entry.connectorId} manifest checksum mismatch: expected ${entry.manifestSha256}, got ${manifestChecksum}`
    );
  }
  if (entry.scriptSha256 && entry.scriptSha256 !== scriptChecksum) {
    throw new Error(
      `${entry.id ?? entry.connectorId} script checksum mismatch: expected ${entry.scriptSha256}, got ${scriptChecksum}`
    );
  }

  if (entry.version && manifest.version !== entry.version) {
    throw new Error(
      `${entry.id ?? entry.connectorId} version mismatch: index says ${entry.version} but artifact manifest declares ${manifest.version}`
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
