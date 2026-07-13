import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertBundledScopeSchemasMatch } from "./connector-artifact-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(
  repoRoot,
  "artifacts",
  "github-playwright",
  "github-playwright-1.5.0.tgz",
);
const manifestPath = join(
  repoRoot,
  "connectors",
  "github",
  "github-playwright.json",
);

test("current payload schemas match the immutable connector bundle", () => {
  assert.doesNotThrow(() =>
    assertBundledScopeSchemasMatch({ artifactPath, manifestPath }),
  );
});

test("schema-only changes require a connector version bump", () => {
  const root = mkdtempSync(join(tmpdir(), "connector-schema-drift-"));
  const fixtureManifestPath = join(root, "github-playwright.json");
  cpSync(manifestPath, fixtureManifestPath);
  cpSync(join(dirname(manifestPath), "schemas"), join(root, "schemas"), {
    recursive: true,
  });
  const schemaPath = join(root, "schemas", "github.profile.json");
  writeFileSync(schemaPath, `${readFileSync(schemaPath, "utf8")}\n`);

  assert.throws(
    () =>
      assertBundledScopeSchemasMatch({
        artifactPath,
        manifestPath: fixtureManifestPath,
      }),
    /github\.profile schema changed without a connector version bump/,
  );
});
