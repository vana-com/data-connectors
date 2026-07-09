# Contributing to Data Connectors

Thanks for your interest in Data Connectors. This repository is the connector
library for the PDPP (Personal Data Polyfill Project) ecosystem: Playwright
browser-automation connectors that export a user's data from web platforms.
Credentials never leave the device.

This guide applies to human and AI contributors alike. It distills the durable
conventions for working in this repo: the no-personal-data rule, how to add or
modify a connector, test expectations, and pull-request conventions.

## Ground rules

- **No personal data in the repo.** Do not commit real names, personal handles,
  emails, phone numbers, private absolute paths, auth tokens, session files, or
  captured personal data in code, fixtures, docs, or reports. Committed fixtures
  MUST be synthetic (see the existing `*.mock`-style fixtures for the expected
  shape). Session data files contain auth tokens and are gitignored — never
  commit them.
- **Credentials stay on-device.** Connectors must never send tokens or passwords
  to external servers. Data extraction happens locally in the browser.
- **Respect the distribution contract.** Connectors are consumed downstream as
  signed, checksummed, pinned dependencies. Changes to a connector's script or
  manifest require a version bump and regenerated checksums (see below).

## Adding or modifying a connector

The full mechanical walkthrough — file layout, the two-phase architecture, the
canonical result shape, the Page API, local testing, and registry checksums —
lives in [`README.md`](README.md). Read the **Contributing** and **Testing
locally** sections there before starting.

In short:

1. Fork this repo and create a branch (`feat/<platform>-connector`).
2. Add or edit files under `connectors/<company>/` (script, manifest, schemas).
3. Test locally per the README (`node run-connector.cjs …`).
4. Bump the version in the connector manifest and regenerate `registry.json`
   entries and checksums.
5. Open a pull request.

## Building and testing

This repo uses plain Node tooling — no install is required for the schema and
contract tests:

```bash
node --test scripts/test-connectors.test.cjs   # schema + contract validation
```

The ChatGPT resume test under `connectors/openai/__tests__/` is an end-to-end
browser test that requires Playwright installed (run it from a checkout with
`node_modules` available, or set `NODE_PATH` per the file header). It is gated on
that environment and is not part of the default no-install test run.

Prefer captured (synthetic) fixtures over live credential/probe cycles when
reproducing connector behavior.

## Pull request conventions

- **Branch and PR.** All changes go through public pull requests.
- **Conventional Commits.** Commit messages follow
  [Conventional Commits](https://www.conventionalcommits.org/). `fix:` and
  `feat:` describe patch- and minor-level connector changes respectively.
- **Sign your commits (DCO).** This project uses the
  [Developer Certificate of Origin](https://developercertificate.org/). Every
  commit must carry a `Signed-off-by` line certifying you have the right to
  submit it under the project's license. Add one automatically with:

  ```bash
  git commit --signoff
  ```

  which appends `Signed-off-by: Your Name <your@email>` using your `git config`
  identity. Ensure your configured name and email are real.

## Governance

Maintainers and their scopes are listed in [`MAINTAINERS.md`](MAINTAINERS.md).
Maintainer changes are proposed through pull request.

## Security

To report a security vulnerability, follow the process in
[`SECURITY.md`](SECURITY.md). Do not open a public issue for security reports.

## Code of conduct

Participation in this project is governed by
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
