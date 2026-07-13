#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  compareScopeCatalogContracts,
  readContractSnapshot,
} from "./diff-scope-catalog-package.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, "..");
const defaultPackageRoot = join(defaultRepoRoot, "packages", "scope-catalog");
const changelogPreamble =
  "All notable public scope-catalog contract changes are recorded here.\n\n";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function formatPairs(pairs) {
  return pairs.length > 0
    ? pairs.map(([sourceId, scopeId]) => `\`${sourceId}/${scopeId}\``).join(", ")
    : "None";
}

function renderChangelog(release, previousPackageRoot) {
  if (release.impact === "none" && previousPackageRoot) {
    const previousChangelogPath = join(previousPackageRoot, "CHANGELOG.md");
    if (!existsSync(previousChangelogPath)) {
      throw new Error("Previous package is missing CHANGELOG.md");
    }
    return readFileSync(previousChangelogPath, "utf8");
  }

  const entry = `## ${release.currentVersion}\n\n- Impact: ${release.impact}\n- Contract fingerprint: \`${release.currentContractFingerprint}\`\n- Added pairs: ${formatPairs(release.added)}\n- Removed pairs: ${formatPairs(release.removed)}\n- Changed pairs: ${release.changes.length}\n`;
  if (!previousPackageRoot) {
    return `# Changelog\n\n${changelogPreamble}${entry}`;
  }

  const previousChangelogPath = join(previousPackageRoot, "CHANGELOG.md");
  if (!existsSync(previousChangelogPath)) {
    throw new Error("Previous package is missing CHANGELOG.md");
  }
  const previousChangelog = readFileSync(previousChangelogPath, "utf8");
  const prefix = "# Changelog\n";
  if (!previousChangelog.startsWith(prefix)) {
    throw new Error("Previous package CHANGELOG.md must begin with # Changelog");
  }
  const previousBody = previousChangelog.slice(prefix.length).trimStart();
  const previousEntries = previousBody.startsWith(changelogPreamble)
    ? previousBody.slice(changelogPreamble.length)
    : previousBody;
  return `${prefix}\n${changelogPreamble}${entry}\n${previousEntries}`;
}

export function buildScopeCatalogPackage({
  repoRoot = defaultRepoRoot,
  packageRoot = defaultPackageRoot,
  previousPackageRoot = null,
} = {}) {
  const packageJsonPath = join(packageRoot, "package.json");
  const readmePath = join(packageRoot, "README.md");
  if (!existsSync(packageJsonPath) || !existsSync(readmePath)) {
    throw new Error("Package root must contain authored package.json and README.md");
  }
  const packageJson = readJson(packageJsonPath);
  if (packageJson.name !== "@opendatalabs/scope-catalog") {
    throw new Error("Package name must remain @opendatalabs/scope-catalog");
  }

  const current = readContractSnapshot(repoRoot);
  const previous = previousPackageRoot ? readContractSnapshot(previousPackageRoot) : null;
  const release = compareScopeCatalogContracts({ current, previous });

  for (const path of [
    "CHANGELOG.md",
    "connectors",
    "release.json",
    "schemas",
    "scope-catalog.json",
  ]) {
    rmSync(join(packageRoot, path), { force: true, recursive: true });
  }

  writeJson(packageJsonPath, { ...packageJson, version: release.currentVersion });
  copyFileSync(join(repoRoot, "scope-catalog.json"), join(packageRoot, "scope-catalog.json"));
  mkdirSync(join(packageRoot, "schemas"), { recursive: true });
  copyFileSync(
    join(repoRoot, current.catalog.catalogSchema.path),
    join(packageRoot, current.catalog.catalogSchema.path),
  );
  for (const path of current.payloadSchemas.keys()) {
    mkdirSync(dirname(join(packageRoot, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(packageRoot, path));
  }
  writeJson(join(packageRoot, "release.json"), release);
  writeFileSync(
    join(packageRoot, "CHANGELOG.md"),
    renderChangelog(release, previousPackageRoot),
  );

  const built = readContractSnapshot(packageRoot);
  if (built.fingerprint !== current.fingerprint) {
    throw new Error("Built package contract fingerprint differs from repository input");
  }
  if (built.payloadSchemas.size !== current.payloadSchemas.size) {
    throw new Error("Built package contains a different referenced payload-schema set");
  }
  return release;
}

function parseArgs(argv) {
  const result = { previousPackageRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--previous-package" && argv[index + 1]) {
      result.previousPackageRoot = resolve(argv[++index]);
    } else {
      throw new Error(
        "Usage: node scripts/build-scope-catalog-package.mjs [--previous-package <path>]",
      );
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { previousPackageRoot } = parseArgs(process.argv.slice(2));
    const release = buildScopeCatalogPackage({ previousPackageRoot });
    console.log(
      `Built @opendatalabs/scope-catalog ${release.currentVersion} (${release.impact}, ${release.currentContractFingerprint}).`,
    );
  } catch (error) {
    console.error(
      `[build-scope-catalog-package] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
