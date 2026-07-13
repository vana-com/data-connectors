#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildScopeCatalogPackage } from "./build-scope-catalog-package.mjs";
import {
  compareScopeCatalogContracts,
  readContractSnapshot,
} from "./diff-scope-catalog-package.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDir, "..");
const defaultPackageRoot = join(defaultRepoRoot, "packages", "scope-catalog");
const requiredExports = {
  "./scope-catalog.json": "./scope-catalog.json",
  "./schemas/scope-catalog.schema.json": "./schemas/scope-catalog.schema.json",
  "./connectors/*": "./connectors/*",
  "./release.json": "./release.json",
  "./package.json": "./package.json",
};
const requiredFiles = [
  "CHANGELOG.md",
  "README.md",
  "connectors",
  "release.json",
  "schemas",
  "scope-catalog.json",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  });
}

function assertSameFileTree(actualRoot, expectedRoot) {
  const actualFiles = listFiles(actualRoot).sort();
  const expectedFiles = listFiles(expectedRoot).sort();
  assert.deepEqual(actualFiles, expectedFiles, "package file set is not deterministic");
  for (const path of actualFiles) {
    assert.ok(
      readFileSync(join(actualRoot, path)).equals(readFileSync(join(expectedRoot, path))),
      `package file differs from deterministic build: ${path}`,
    );
  }
}

export function checkScopeCatalogPackage({
  repoRoot = defaultRepoRoot,
  packageRoot = defaultPackageRoot,
  previousPackageRoot = null,
} = {}) {
  const packageJson = readJson(join(packageRoot, "package.json"));
  assert.equal(packageJson.name, "@opendatalabs/scope-catalog");
  assert.deepEqual(packageJson.files, requiredFiles);
  assert.deepEqual(packageJson.exports, requiredExports);
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    registry: "https://registry.npmjs.org",
  });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "https://github.com/vana-com/data-connectors.git",
    directory: "packages/scope-catalog",
  });

  const packageSnapshot = readContractSnapshot(packageRoot);
  const repoSnapshot = readContractSnapshot(repoRoot);
  assert.equal(packageSnapshot.fingerprint, repoSnapshot.fingerprint);
  const previousSnapshot = previousPackageRoot
    ? readContractSnapshot(previousPackageRoot)
    : null;
  const expectedRelease = compareScopeCatalogContracts({
    current: repoSnapshot,
    previous: previousSnapshot,
  });
  assert.deepEqual(readJson(join(packageRoot, "release.json")), expectedRelease);
  assert.equal(packageJson.version, expectedRelease.currentVersion);

  const expectedFiles = new Set([
    "CHANGELOG.md",
    "README.md",
    "package.json",
    "release.json",
    "scope-catalog.json",
    packageSnapshot.catalog.catalogSchema.path,
    ...packageSnapshot.payloadSchemas.keys(),
  ]);
  for (const path of listFiles(packageRoot)) {
    if (!expectedFiles.has(path)) throw new Error(`unexpected package file: ${path}`);
  }
  for (const path of expectedFiles) {
    if (!statSync(join(packageRoot, path)).isFile()) {
      throw new Error(`missing package file: ${path}`);
    }
  }

  const expectedRoot = mkdtempSync(join(tmpdir(), "scope-catalog-package-check-"));
  cpSync(join(packageRoot, "package.json"), join(expectedRoot, "package.json"));
  cpSync(join(packageRoot, "README.md"), join(expectedRoot, "README.md"));
  buildScopeCatalogPackage({
    repoRoot,
    packageRoot: expectedRoot,
    previousPackageRoot,
  });
  assertSameFileTree(packageRoot, expectedRoot);
  return expectedRelease;
}

function parseArgs(argv) {
  const result = { previousPackageRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--previous-package" && argv[index + 1]) {
      result.previousPackageRoot = resolve(argv[++index]);
    } else {
      throw new Error(
        "Usage: node scripts/check-scope-catalog-package.mjs [--previous-package <path>]",
      );
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { previousPackageRoot } = parseArgs(process.argv.slice(2));
    const release = checkScopeCatalogPackage({ previousPackageRoot });
    console.log(
      `Scope catalog package is deterministic and complete (${release.currentVersion}, ${release.impact}).`,
    );
  } catch (error) {
    console.error(
      `[check-scope-catalog-package] ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
