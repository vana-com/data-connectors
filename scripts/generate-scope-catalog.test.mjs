import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateScopeCatalog } from "./generate-scope-catalog.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "scope-catalog-test-"));
  mkdirSync(join(root, "schemas"), { recursive: true });
  cpSync(
    join(repoRoot, "schemas", "web-scope-capabilities.schema.json"),
    join(root, "schemas", "web-scope-capabilities.schema.json"),
  );
  cpSync(
    join(repoRoot, "schemas", "scope-catalog.schema.json"),
    join(root, "schemas", "scope-catalog.schema.json"),
  );

  writeJson(join(root, "registry.json"), {
    connectors: [
      {
        id: "alpha-playwright",
        status: "stable",
        files: { metadata: "alpha/alpha-playwright.json" },
      },
    ],
  });
  writeJson(join(root, "connectors", "alpha", "alpha-playwright.json"), {
    manifest_version: "1.1",
    connector_id: "alpha-playwright",
    source_id: "alpha",
    scopes: [
      {
        scope: "alpha.profile",
        description: "The published Alpha profile.",
        limits: [
          {
            type: "maxItems",
            value: 25,
            unit: "items",
            description: "The Desktop connector returns at most 25 items.",
          },
        ],
      },
    ],
  });
  writeJson(join(root, "connectors", "alpha", "schemas", "alpha.profile.json"), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    scope: "alpha.profile",
    description: "Canonical Alpha profile schema.",
    type: "object",
  });
  writeJson(join(root, "connectors", "ignored", "ignored-playwright.json"), {
    manifest_version: "1.0",
    connector_id: "ignored-playwright",
    source_id: "ignored",
    scopes: [{ scope: "ignored.profile", description: "Not published." }],
  });
  writeJson(join(root, "scopes", "web-capabilities.json"), {
    $schema: "../schemas/web-scope-capabilities.schema.json",
    schemaVersion: "1.0.0",
    contract: "Test Web API",
    provenance: {
      issue: "TEST-1",
      baselineCommit: "a".repeat(40),
      note: "Test evidence.",
    },
    blockers: [],
    scopes: [{ scopeId: "alpha.profile", status: "unsupported" }],
  });
  return root;
}

test("generated files are clean and exclude unregistered manifests", () => {
  const root = makeFixture();
  generateScopeCatalog({ repoRoot: root });
  generateScopeCatalog({ repoRoot: root, check: true });

  const catalog = JSON.parse(readFileSync(join(root, "scope-catalog.json")));
  assert.deepEqual(catalog.scopes.map(({ scopeId }) => scopeId), ["alpha.profile"]);
  assert.equal(catalog.scopes[0].description, "The published Alpha profile.");
  assert.deepEqual(catalog.scopes[0].fulfillment.desktop.connectors[0].limits, [
    {
      type: "maxItems",
      value: 25,
      unit: "items",
      description: "The Desktop connector returns at most 25 items.",
    },
  ]);
  assert.deepEqual(catalog.generatedFrom, {
    publishability: {
      path: "registry.json",
      manifestSelector: "connectors[].files.metadata",
    },
    manifests: ["connectors/alpha/alpha-playwright.json"],
    webCapabilities: "scopes/web-capabilities.json",
  });
});

test("missing Web capability entries fail exact-set validation", () => {
  const root = makeFixture();
  const inputPath = join(root, "scopes", "web-capabilities.json");
  const input = JSON.parse(readFileSync(inputPath));
  input.scopes = [];
  writeJson(inputPath, input);

  assert.throws(
    () => generateScopeCatalog({ repoRoot: root }),
    /Missing Web capability entries: alpha\.profile/,
  );
});

test("extra Web capability entries fail exact-set validation", () => {
  const root = makeFixture();
  const inputPath = join(root, "scopes", "web-capabilities.json");
  const input = JSON.parse(readFileSync(inputPath));
  input.scopes.push({ scopeId: "extra.profile", status: "unsupported" });
  writeJson(inputPath, input);

  assert.throws(
    () => generateScopeCatalog({ repoRoot: root }),
    /Extra Web capability entries: extra\.profile/,
  );
});

test("malformed Web capability entries fail schema validation", () => {
  const root = makeFixture();
  const inputPath = join(root, "scopes", "web-capabilities.json");
  const input = JSON.parse(readFileSync(inputPath));
  input.scopes[0].status = "maybe";
  writeJson(inputPath, input);

  assert.throws(
    () => generateScopeCatalog({ repoRoot: root }),
    /web-capabilities\.json failed schema validation/,
  );
});

test("conflicting registered schema evidence fails", () => {
  const root = makeFixture();
  const registryPath = join(root, "registry.json");
  const registry = JSON.parse(readFileSync(registryPath));
  registry.connectors.push({
    id: "alpha-alt-playwright",
    status: "beta",
    files: { metadata: "alpha-alt/alpha-alt-playwright.json" },
  });
  writeJson(registryPath, registry);
  writeJson(join(root, "connectors", "alpha-alt", "alpha-alt-playwright.json"), {
    manifest_version: "1.0",
    connector_id: "alpha-alt-playwright",
    source_id: "alpha",
    scopes: [{ scope: "alpha.profile", description: "The published Alpha profile." }],
  });
  writeJson(
    join(root, "connectors", "alpha-alt", "schemas", "alpha.profile.json"),
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      scope: "alpha.profile",
      description: "A conflicting canonical schema.",
      type: "object",
    },
  );

  assert.throws(
    () => generateScopeCatalog({ repoRoot: root }),
    /alpha\.profile has conflicting schema paths/,
  );
});

test("conflicting registered manifest descriptions fail", () => {
  const root = makeFixture();
  const registryPath = join(root, "registry.json");
  const registry = JSON.parse(readFileSync(registryPath));
  registry.connectors.push({
    id: "alpha-alt-playwright",
    status: "beta",
    files: { metadata: "alpha/alpha-alt-playwright.json" },
  });
  writeJson(registryPath, registry);
  writeJson(join(root, "connectors", "alpha", "alpha-alt-playwright.json"), {
    manifest_version: "1.0",
    connector_id: "alpha-alt-playwright",
    source_id: "alpha",
    scopes: [{ scope: "alpha.profile", description: "A conflicting description." }],
  });

  assert.throws(
    () => generateScopeCatalog({ repoRoot: root }),
    /alpha\.profile has conflicting manifest descriptions/,
  );
});

test("duplicate scope IDs within one published manifest fail", () => {
  const root = makeFixture();
  const manifestPath = join(root, "connectors", "alpha", "alpha-playwright.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.scopes.push({
    scope: "alpha.profile",
    description: "The published Alpha profile.",
  });
  writeJson(manifestPath, manifest);

  assert.throws(
    () => generateScopeCatalog({ repoRoot: root }),
    /alpha-playwright\.json declares duplicate scope alpha\.profile/,
  );
});

test("release generation embeds immutable payload-schema URLs", () => {
  const root = makeFixture();
  const sourceCommit = "b".repeat(40);
  const releaseTag = `connectors-${sourceCommit.slice(0, 12)}`;
  generateScopeCatalog({ repoRoot: root, sourceCommit, releaseTag });

  const catalog = JSON.parse(readFileSync(join(root, "scope-catalog.json")));
  assert.deepEqual(catalog.distribution, {
    repository: "https://github.com/vana-com/data-connectors",
    sourceCommit,
    releaseTag,
  });
  assert.equal(
    catalog.scopes[0].schema.url,
    `https://raw.githubusercontent.com/vana-com/data-connectors/${sourceCommit}/connectors/alpha/schemas/alpha.profile.json`,
  );
});

test("release workflow runs for connector changes", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "publish-connector-release-index.yml"),
    "utf8",
  );
  assert.match(workflow, /- "connectors\/\*\*"/);
  assert.match(workflow, /SCOPE_CATALOG_SOURCE_COMMIT/);
  assert.match(workflow, /SCOPE_CATALOG_RELEASE_TAG/);
});

test("the checked-in catalog contains every published scope exactly once", () => {
  generateScopeCatalog({ repoRoot, check: true });

  const registry = JSON.parse(readFileSync(join(repoRoot, "registry.json")));
  const expected = new Set();
  for (const connector of registry.connectors) {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "connectors", connector.files.metadata)),
    );
    for (const scope of manifest.scopes) {
      expected.add(typeof scope === "string" ? scope : scope.scope);
    }
  }

  const catalog = JSON.parse(readFileSync(join(repoRoot, "scope-catalog.json")));
  const actual = catalog.scopes.map(({ scopeId }) => scopeId);
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(new Set(actual), expected);
  assert.match(
    catalog.scopes.find(({ scopeId }) => scopeId === "github.contributions").description,
    /last 4 years/,
  );
  assert.equal(
    catalog.scopes
      .find(({ scopeId }) => scopeId === "youtube.history")
      .fulfillment.desktop.connectors[0].limits[0].value,
    50,
  );
});
