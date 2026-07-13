import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildScopeCatalogPackage } from "./build-scope-catalog-package.mjs";
import { checkScopeCatalogPackage } from "./check-scope-catalog-package.mjs";
import {
  compareScopeCatalogContracts,
  decideScopeCatalogPublication,
  readContractSnapshot,
} from "./diff-scope-catalog-package.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function makeContractFixture() {
  const root = mkdtempSync(join(tmpdir(), "scope-catalog-package-contract-"));
  writeJson(join(root, "schemas", "scope-catalog.schema.json"), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
  });
  writeJson(join(root, "connectors", "alpha", "schemas", "alpha.profile.json"), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    scope: "alpha.profile",
    type: "object",
  });
  writeJson(join(root, "scope-catalog.json"), {
    catalogVersion: "1.0.0",
    catalogSchema: { path: "schemas/scope-catalog.schema.json" },
    distribution: { repository: "https://example.test/catalog" },
    generatedFrom: { manifests: ["connectors/alpha/alpha-playwright.json"] },
    scopes: [
      {
        sourceId: "alpha",
        scopeId: "alpha.profile",
        description: "Alpha profile.",
        schema: { path: "connectors/alpha/schemas/alpha.profile.json" },
        maturity: "beta",
        fulfillment: {
          desktop: {
            status: "supported",
            connectors: [{ id: "alpha-playwright", status: "beta" }],
          },
          web: { status: "unsupported" },
        },
      },
    ],
  });
  return root;
}

function cloneFixture(root) {
  const clone = mkdtempSync(join(tmpdir(), "scope-catalog-package-clone-"));
  cpSync(root, clone, { recursive: true });
  return clone;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compareFixtureMutation({ preparePrevious, mutateCurrent }) {
  const previousRoot = makeContractFixture();
  writeJson(join(previousRoot, "package.json"), { version: "2.4.6" });
  preparePrevious?.(previousRoot);
  const currentRoot = cloneFixture(previousRoot);
  mutateCurrent(currentRoot);
  return compareScopeCatalogContracts({
    current: readContractSnapshot(currentRoot),
    previous: readContractSnapshot(previousRoot),
  });
}

function mutateCatalog(root, mutate) {
  const path = join(root, "scope-catalog.json");
  const catalog = readJson(path);
  mutate(catalog);
  writeJson(path, catalog);
}

function readContractFingerprintInLocale(root, locale) {
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "diff-scope-catalog-package.mjs"),
      "--current-package",
      root,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).currentContractFingerprint;
}

test("initial, unchanged, major, minor and patch contracts select deterministic versions", () => {
  const initialRoot = makeContractFixture();
  const initial = compareScopeCatalogContracts({
    current: readContractSnapshot(initialRoot),
    previous: null,
  });
  assert.equal(initial.impact, "minor");
  assert.equal(initial.currentVersion, "1.0.0");
  assert.equal(initial.previousVersion, null);
  assert.deepEqual(initial.added, [["alpha", "alpha.profile"]]);

  writeJson(join(initialRoot, "package.json"), { version: "2.4.6" });
  const unchangedRoot = cloneFixture(initialRoot);
  const unchangedCatalog = readJson(join(unchangedRoot, "scope-catalog.json"));
  unchangedCatalog.distribution.sourceCommit = "a".repeat(40);
  unchangedCatalog.distribution.releaseTag = "connectors-aaaaaaaaaaaa";
  unchangedCatalog.generatedFrom.manifests = ["a-different-provenance-path.json"];
  unchangedCatalog.scopes[0].schema.url =
    "https://raw.githubusercontent.com/example/repo/aaaaaaaa/schema.json";
  writeJson(join(unchangedRoot, "scope-catalog.json"), unchangedCatalog);
  writeFileSync(join(unchangedRoot, "connector-implementation.js"), "changed only\n");
  const unchanged = compareScopeCatalogContracts({
    current: readContractSnapshot(unchangedRoot),
    previous: readContractSnapshot(initialRoot),
  });
  assert.equal(unchanged.impact, "none");
  assert.equal(unchanged.currentVersion, "2.4.6");

  const majorRoot = cloneFixture(initialRoot);
  writeJson(
    join(majorRoot, "connectors", "alpha", "schemas", "alpha.profile.json"),
    { scope: "alpha.profile", type: "object", required: ["id"] },
  );
  const major = compareScopeCatalogContracts({
    current: readContractSnapshot(majorRoot),
    previous: readContractSnapshot(initialRoot),
  });
  assert.equal(major.impact, "major");
  assert.equal(major.currentVersion, "3.0.0");
  assert.equal(major.changes[0].schema.previous.path, "connectors/alpha/schemas/alpha.profile.json");
  assert.match(major.changes[0].schema.previous.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    major.changes[0].schema.previous.fingerprint,
    major.changes[0].schema.current.fingerprint,
  );

  const minorRoot = cloneFixture(initialRoot);
  const minorCatalog = readJson(join(minorRoot, "scope-catalog.json"));
  minorCatalog.scopes[0].fulfillment.web = { status: "supported" };
  writeJson(join(minorRoot, "scope-catalog.json"), minorCatalog);
  const minor = compareScopeCatalogContracts({
    current: readContractSnapshot(minorRoot),
    previous: readContractSnapshot(initialRoot),
  });
  assert.equal(minor.impact, "minor");
  assert.equal(minor.currentVersion, "2.5.0");

  const patchRoot = cloneFixture(initialRoot);
  const patchCatalog = readJson(join(patchRoot, "scope-catalog.json"));
  patchCatalog.scopes[0].description = "A clearer Alpha profile description.";
  writeJson(join(patchRoot, "scope-catalog.json"), patchCatalog);
  const patch = compareScopeCatalogContracts({
    current: readContractSnapshot(patchRoot),
    previous: readContractSnapshot(initialRoot),
  });
  assert.equal(patch.impact, "patch");
  assert.equal(patch.currentVersion, "2.4.7");
  assert.deepEqual(patch.changes, [
    {
      pair: ["alpha", "alpha.profile"],
      description: {
        previous: "Alpha profile.",
        current: "A clearer Alpha profile description.",
      },
    },
  ]);
});

test("package build preserves package-relative paths and check rejects extra payload schemas", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "scope-catalog-package-output-"));
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "package.template.json"),
    join(packageRoot, "package.template.json"),
  );
  cpSync(join(repoRoot, "packages", "scope-catalog", "README.md"), join(packageRoot, "README.md"));
  cpSync(join(repoRoot, "packages", "scope-catalog", ".gitignore"), join(packageRoot, ".gitignore"));

  buildScopeCatalogPackage({ repoRoot, packageRoot });
  const catalog = readJson(join(packageRoot, "scope-catalog.json"));
  const release = readJson(join(packageRoot, "release.json"));
  const packageJson = readJson(join(packageRoot, "package.json"));

  assert.equal(packageJson.name, "@opendatalabs/scope-catalog");
  assert.equal(packageJson.version, "1.0.0");
  assert.equal(release.currentVersion, "1.0.0");
  assert.equal(release.previousVersion, null);
  assert.match(release.currentContractFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(catalog.catalogVersion, "1.0.0");
  for (const scope of catalog.scopes) {
    assert.ok(readFileSync(join(packageRoot, scope.schema.path)).length > 0);
  }
  assert.doesNotThrow(() => checkScopeCatalogPackage({ repoRoot, packageRoot }));

  writeJson(join(packageRoot, "connectors", "extra", "schemas", "extra.json"), {
    type: "object",
  });
  assert.throws(
    () => checkScopeCatalogPackage({ repoRoot, packageRoot }),
    /unexpected package file: connectors\/extra\/schemas\/extra\.json/,
  );
});

test("conservative mechanical rules cover every major and minor contract category", () => {
  const majorCases = [
    {
      name: "pair removed",
      mutateCurrent: (root) => mutateCatalog(root, (catalog) => catalog.scopes.pop()),
    },
    {
      name: "catalog-schema bytes changed",
      mutateCurrent: (root) =>
        writeJson(join(root, "schemas", "scope-catalog.schema.json"), {
          type: "object",
          required: ["scopes"],
        }),
    },
    {
      name: "Desktop connector removed",
      preparePrevious: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.desktop.connectors.push({
            id: "alpha-backup-playwright",
            status: "experimental",
          });
        }),
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.desktop.connectors.pop();
        }),
    },
    {
      name: "Web support removed",
      preparePrevious: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.web = { status: "supported" };
        }),
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.web = { status: "blocked" };
        }),
    },
    {
      name: "maturity decreases",
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].maturity = "experimental";
        }),
    },
    {
      name: "limit metadata changes",
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.desktop.connectors[0].limits = [
            {
              type: "maxItems",
              value: 10,
              unit: "items",
              description: "At most ten items.",
            },
          ];
        }),
    },
  ];
  for (const fixture of majorCases) {
    assert.equal(compareFixtureMutation(fixture).impact, "major", fixture.name);
  }

  const minorCases = [
    {
      name: "pair added",
      mutateCurrent: (root) => {
        writeJson(join(root, "connectors", "alpha", "schemas", "alpha.posts.json"), {
          scope: "alpha.posts",
          type: "array",
        });
        mutateCatalog(root, (catalog) => {
          catalog.scopes.push({
            ...structuredClone(catalog.scopes[0]),
            scopeId: "alpha.posts",
            description: "Alpha posts.",
            schema: { path: "connectors/alpha/schemas/alpha.posts.json" },
          });
        });
      },
    },
    {
      name: "connector added",
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.desktop.connectors.push({
            id: "alpha-backup-playwright",
            status: "experimental",
          });
        }),
    },
    {
      name: "Desktop becomes supported with limits",
      preparePrevious: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.desktop = {
            status: "unsupported",
            connectors: [],
          };
        }),
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.desktop = {
            status: "supported",
            limits: [
              {
                type: "maxItems",
                value: 10,
                unit: "items",
                description: "At most ten items.",
              },
            ],
            connectors: [{ id: "alpha-playwright", status: "beta" }],
          };
        }),
    },
    {
      name: "Web becomes supported",
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].fulfillment.web = {
            status: "supported",
            limits: [
              {
                type: "maxItems",
                value: 10,
                unit: "items",
                description: "At most ten items.",
              },
            ],
          };
        }),
    },
    {
      name: "maturity increases",
      mutateCurrent: (root) =>
        mutateCatalog(root, (catalog) => {
          catalog.scopes[0].maturity = "stable";
        }),
    },
  ];
  for (const fixture of minorCases) {
    assert.equal(compareFixtureMutation(fixture).impact, "minor", fixture.name);
  }

  const blockerEvidence = compareFixtureMutation({
    mutateCurrent: (root) =>
      mutateCatalog(root, (catalog) => {
        catalog.scopes[0].fulfillment.web = {
          status: "blocked",
          blocker: { id: "evidence-1", description: "Capture live evidence." },
        };
      }),
  });
  assert.equal(blockerEvidence.impact, "patch");
});

test("reordering equivalent Desktop and Web limits leaves the contract unchanged", () => {
  const reordered = compareFixtureMutation({
    preparePrevious: (root) =>
      mutateCatalog(root, (catalog) => {
        const limits = [
          {
            type: "maxItems",
            value: 10,
            unit: "items",
            description: "At most ten items.",
          },
          {
            type: "timeWindow",
            value: 30,
            unit: "days",
            description: "The last thirty days.",
          },
        ];
        catalog.scopes[0].fulfillment.desktop.connectors[0].limits = limits;
        catalog.scopes[0].fulfillment.web = {
          status: "supported",
          limits: structuredClone(limits),
        };
      }),
    mutateCurrent: (root) =>
      mutateCatalog(root, (catalog) => {
        catalog.scopes[0].fulfillment.desktop.connectors[0].limits.reverse();
        catalog.scopes[0].fulfillment.web.limits.reverse();
      }),
  });
  assert.equal(reordered.impact, "none");
  assert.deepEqual(reordered.changes, []);
  assert.equal(
    reordered.currentContractFingerprint,
    reordered.previousContractFingerprint,
  );
});

test("contract fingerprints are identical across locale settings", () => {
  const root = makeContractFixture();
  mutateCatalog(root, (catalog) => {
    catalog.scopes[0].fulfillment.desktop.connectors = [
      { id: "alpha.I", status: "beta" },
      { id: "alpha.i", status: "beta" },
    ];
  });

  assert.equal(
    readContractFingerprintInLocale(root, "en_US.UTF-8"),
    readContractFingerprintInLocale(root, "tr_TR.UTF-8"),
  );
});

test("duplicate Desktop connector IDs are rejected deterministically", () => {
  const root = makeContractFixture();
  mutateCatalog(root, (catalog) => {
    catalog.scopes[0].fulfillment.desktop.connectors = [
      {
        id: "alpha-playwright",
        status: "beta",
        limits: [{ type: "maxItems", value: 10, unit: "items" }],
      },
      {
        id: "alpha-playwright",
        status: "stable",
        limits: [{ type: "maxItems", value: 20, unit: "items" }],
      },
    ];
  });

  function rejectionMessage() {
    try {
      readContractSnapshot(root);
    } catch (error) {
      assert.ok(error instanceof Error);
      return error.message;
    }
    assert.fail("Expected duplicate Desktop connector IDs to be rejected");
  }

  const firstMessage = rejectionMessage();
  mutateCatalog(root, (catalog) => {
    catalog.scopes[0].fulfillment.desktop.connectors.reverse();
  });
  assert.equal(rejectionMessage(), firstMessage);
  assert.equal(
    firstMessage,
    'Duplicate Desktop connector ID for catalog pair ["alpha","alpha.profile"]: alpha-playwright',
  );
});

test("later builds bump from the published package and keep a cumulative changelog", () => {
  const previousRepoRoot = makeContractFixture();
  const previousPackageRoot = mkdtempSync(join(tmpdir(), "scope-catalog-package-previous-"));
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "package.template.json"),
    join(previousPackageRoot, "package.template.json"),
  );
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "README.md"),
    join(previousPackageRoot, "README.md"),
  );
  buildScopeCatalogPackage({
    repoRoot: previousRepoRoot,
    packageRoot: previousPackageRoot,
  });

  const currentRepoRoot = cloneFixture(previousRepoRoot);
  mutateCatalog(currentRepoRoot, (catalog) => {
    catalog.scopes[0].description = "A clearer compatible description.";
  });
  const currentPackageRoot = mkdtempSync(join(tmpdir(), "scope-catalog-package-current-"));
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "package.template.json"),
    join(currentPackageRoot, "package.template.json"),
  );
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "README.md"),
    join(currentPackageRoot, "README.md"),
  );
  const release = buildScopeCatalogPackage({
    repoRoot: currentRepoRoot,
    packageRoot: currentPackageRoot,
    previousPackageRoot,
  });
  const changelog = readFileSync(join(currentPackageRoot, "CHANGELOG.md"), "utf8");
  assert.equal(release.previousVersion, "1.0.0");
  assert.equal(release.currentVersion, "1.0.1");
  assert.equal(release.impact, "patch");
  assert.ok(changelog.indexOf("All notable") < changelog.indexOf("## 1.0.1"));
  assert.ok(changelog.indexOf("## 1.0.1") < changelog.indexOf("## 1.0.0"));
  assert.equal(changelog.match(/^# Changelog$/gm)?.length, 1);
});

test("later fulfillment changes without limits round-trip through release.json", () => {
  const previousRepoRoot = makeContractFixture();
  const previousPackageRoot = mkdtempSync(join(tmpdir(), "scope-catalog-package-previous-"));
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "package.template.json"),
    join(previousPackageRoot, "package.template.json"),
  );
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "README.md"),
    join(previousPackageRoot, "README.md"),
  );
  buildScopeCatalogPackage({
    repoRoot: previousRepoRoot,
    packageRoot: previousPackageRoot,
  });

  const currentRepoRoot = cloneFixture(previousRepoRoot);
  mutateCatalog(currentRepoRoot, (catalog) => {
    catalog.scopes[0].fulfillment.desktop.connectors.push({
      id: "alpha-backup-playwright",
      status: "experimental",
    });
    catalog.scopes[0].fulfillment.web = { status: "supported" };
  });
  const currentPackageRoot = mkdtempSync(join(tmpdir(), "scope-catalog-package-current-"));
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "package.template.json"),
    join(currentPackageRoot, "package.template.json"),
  );
  cpSync(
    join(repoRoot, "packages", "scope-catalog", "README.md"),
    join(currentPackageRoot, "README.md"),
  );
  buildScopeCatalogPackage({
    repoRoot: currentRepoRoot,
    packageRoot: currentPackageRoot,
    previousPackageRoot,
  });

  assert.doesNotThrow(() =>
    checkScopeCatalogPackage({
      repoRoot: currentRepoRoot,
      packageRoot: currentPackageRoot,
      previousPackageRoot,
    }),
  );
});

test("publication authorization prevents initial push publication and permits later releases", () => {
  const initialRelease = {
    currentVersion: "1.0.0",
    previousVersion: null,
    impact: "minor",
  };
  assert.deepEqual(
    decideScopeCatalogPublication({
      eventName: "push",
      packageExists: false,
      initialConfirmed: false,
      release: initialRelease,
    }),
    {
      shouldPublish: false,
      authentication: "none",
      reason:
        "Initial package does not exist; push and unconfirmed dispatch runs validate and pack but cannot publish.",
    },
  );
  assert.deepEqual(
    decideScopeCatalogPublication({
      eventName: "workflow_dispatch",
      packageExists: false,
      initialConfirmed: false,
      release: initialRelease,
    }),
    {
      shouldPublish: false,
      authentication: "none",
      reason:
        "Initial package does not exist; push and unconfirmed dispatch runs validate and pack but cannot publish.",
    },
  );
  assert.deepEqual(
    decideScopeCatalogPublication({
      eventName: "workflow_dispatch",
      packageExists: false,
      initialConfirmed: true,
      release: initialRelease,
    }),
    {
      shouldPublish: true,
      authentication: "bootstrap-token",
      reason: "Initial 1.0.0 publication explicitly confirmed by Callum.",
    },
  );
  assert.deepEqual(
    decideScopeCatalogPublication({
      eventName: "push",
      packageExists: true,
      initialConfirmed: false,
      release: { currentVersion: "1.0.1", previousVersion: "1.0.0", impact: "patch" },
    }),
    {
      shouldPublish: true,
      authentication: "oidc-trusted-publishing",
      reason: "Published predecessor 1.0.0 exists; release impact is patch.",
    },
  );
  assert.equal(
    decideScopeCatalogPublication({
      eventName: "push",
      packageExists: true,
      initialConfirmed: false,
      release: { currentVersion: "1.0.0", previousVersion: "1.0.0", impact: "none" },
    }).shouldPublish,
    false,
  );
  assert.throws(
    () =>
      decideScopeCatalogPublication({
        eventName: "workflow_dispatch",
        packageExists: false,
        initialConfirmed: true,
        release: { currentVersion: "2.0.0", previousVersion: null, impact: "major" },
      }),
    /Initial publication must be 1\.0\.0/,
  );

  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "publish-scope-catalog.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirmInitialPublish:/);
  assert.match(workflow, /decideScopeCatalogPublication/);
  assert.match(workflow, /node-version: "24\.4\.0"/);
  assert.match(workflow, /npm install --global npm@11\.5\.1/);
  assert.match(workflow, /Authentication: \\`\$authentication\\`/);
  assert.match(workflow, /delete the NPM_TOKEN GitHub secret/);
  assert.match(workflow, /npm trusted publishing must already be configured/);
  assert.match(workflow, /npm publish .*--access public --provenance/);
  assert.equal(workflow.match(/npm publish /g)?.length, 2);
  assert.doesNotMatch(workflow, /consumer-update-prs|unity-surfaces|vana-data-app-starter/);
});

test("every publication requires the checked-out SHA to remain current main", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "publish-scope-catalog.yml"),
    "utf8",
  );
  function readPublishStep(name) {
    const marker = `\n      - name: ${name}`;
    const start = workflow.indexOf(marker);
    assert.notEqual(start, -1, `workflow must contain ${name}`);
    const next = workflow.indexOf("\n      - name:", start + marker.length);
    return workflow.slice(start, next === -1 ? undefined : next);
  }

  function readPublishScript(step) {
    const runMarker = "        run: |\n";
    const runStart = step.indexOf(runMarker);
    assert.notEqual(runStart, -1, "publication freshness guard must run with publish");
    return step
      .slice(runStart + runMarker.length)
      .replace(/^ {10}/gm, "")
      .replace("${{ steps.pack.outputs.tarball }}", "scope-catalog.tgz");
  }

  const initialStep = readPublishStep("Publish initial package with bootstrap token");
  const laterStep = readPublishStep("Publish later package with trusted publishing");
  const publishScripts = [readPublishScript(initialStep), readPublishScript(laterStep)];

  function runPublishGate({ publishScript, checkedOutSha, currentMainSha }) {
    const root = mkdtempSync(join(tmpdir(), "scope-catalog-publication-gate-"));
    const npmCallsPath = join(root, "npm-calls");
    const summaryPath = join(root, "summary");
    writeFileSync(npmCallsPath, "");
    writeFileSync(summaryPath, "");
    const gitStub = `git() {
        if [ "$*" != "ls-remote --exit-code origin refs/heads/main" ]; then
          echo "unexpected git arguments: $*" >&2
          return 96
        fi
        printf "%s\\trefs/heads/main\\n" "$CURRENT_MAIN_SHA"
      }`;
    const npmStub = 'npm() { printf "%s\\n" "$*" >> "$NPM_CALLS"; }';
    const result = spawnSync(
      "bash",
      ["-c", `${gitStub}\n${npmStub}\n${publishScript}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHECKED_OUT_SHA: checkedOutSha,
          CURRENT_MAIN_SHA: currentMainSha,
          GITHUB_STEP_SUMMARY: summaryPath,
          NPM_CALLS: npmCallsPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return {
      npmCalls: readFileSync(npmCallsPath, "utf8"),
      summary: readFileSync(summaryPath, "utf8"),
    };
  }

  const oldSha = "1".repeat(40);
  const currentSha = "2".repeat(40);
  for (const publishScript of publishScripts) {
    const stale = runPublishGate({
      publishScript,
      checkedOutSha: oldSha,
      currentMainSha: currentSha,
    });
    assert.equal(stale.npmCalls, "");
    assert.match(stale.summary, /publication skipped/i);
    assert.match(stale.summary, new RegExp(oldSha));
    assert.match(stale.summary, new RegExp(currentSha));

    const current = runPublishGate({
      publishScript,
      checkedOutSha: currentSha,
      currentMainSha: currentSha,
    });
    assert.equal(
      current.npmCalls,
      "publish scope-catalog.tgz --access public --provenance\n",
    );
    assert.equal(current.summary, "");
  }

  assert.match(
    initialStep,
    /authentication == 'bootstrap-token'/,
  );
  assert.match(initialStep, /github\.event_name == 'workflow_dispatch'/);
  assert.match(initialStep, /inputs\.confirmInitialPublish == true/);
  assert.match(initialStep, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(laterStep, /authentication == 'oidc-trusted-publishing'/);
  assert.doesNotMatch(laterStep, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  for (const step of [initialStep, laterStep]) {
    assert.match(step, /CHECKED_OUT_SHA: \$\{\{ github\.sha \}\}/);
    assert.doesNotMatch(step, /EVENT_NAME/);
  }
  assert.equal(workflow.match(/NODE_AUTH_TOKEN/g)?.length, 1);
  assert.match(workflow, /concurrency:\n  group: publish-scope-catalog\n  cancel-in-progress: false/);
});
