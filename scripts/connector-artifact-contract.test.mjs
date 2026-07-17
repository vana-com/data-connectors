import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertBundledScopeSchemasMatch,
  assertConnectorIndexSigned,
} from "./connector-artifact-contract.mjs";

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

test("a fully signed index passes the publish signature gate", () => {
  assert.doesNotThrow(() =>
    assertConnectorIndexSigned({
      connectors: {
        "alpha-playwright": [
          {
            version: "1.0.0",
            artifactSignature: {
              type: "sigstoreBundle",
              bundlePath: "alpha-playwright-1.0.0.tgz.sigstore.json",
              bundleUrl:
                "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-test/alpha-playwright-1.0.0.tgz.sigstore.json",
            },
          },
          {
            version: "2.0.0",
            artifactSignature: {
              type: "sigstoreBundle",
              bundlePath: "alpha-playwright-2.0.0.tgz.sigstore.json",
            },
          },
        ],
      },
    }),
  );
});

test("an index with unsigned retained entries fails the publish signature gate", () => {
  assert.throws(
    () =>
      assertConnectorIndexSigned({
        connectors: {
          "alpha-playwright": [
            // Retained entry carried over without signature metadata — the
            // shape that shipped in the 2026-07-13 index and bricked installs.
            { version: "1.0.0" },
            {
              version: "2.0.0",
              artifactSignature: {
                type: "sigstoreBundle",
                bundlePath: "alpha-playwright-2.0.0.tgz.sigstore.json",
              },
            },
          ],
          "beta-playwright": [
            { version: "3.0.0", artifactSignature: {} },
          ],
        },
      }),
    /unsigned entries: alpha-playwright@1\.0\.0, beta-playwright@3\.0\.0/,
  );
});
