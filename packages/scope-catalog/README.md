# `@opendatalabs/scope-catalog`

Versioned, JSON-first distribution of Vana's public source and scope contract.

Install an exact version:

```sh
npm install --save-exact @opendatalabs/scope-catalog@1.0.0
```

Import the catalog and release metadata:

```js
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const catalog = require("@opendatalabs/scope-catalog/scope-catalog.json");
const release = require("@opendatalabs/scope-catalog/release.json");
```

Each `scope.schema.path` is relative to the package root and is exported at the same package subpath. For example, resolve `connectors/github/schemas/github.profile.json` as:

```js
const schema = require(
  "@opendatalabs/scope-catalog/connectors/github/schemas/github.profile.json",
);
```

`catalogVersion` versions the catalog JSON format. The npm package version independently versions changes to the published public contract.

## Exports

- `@opendatalabs/scope-catalog/scope-catalog.json`
- `@opendatalabs/scope-catalog/schemas/scope-catalog.schema.json`
- `@opendatalabs/scope-catalog/connectors/*`
- `@opendatalabs/scope-catalog/release.json`
- `@opendatalabs/scope-catalog/package.json`

## Release metadata

`release.json` records the current and previous package versions and contract fingerprints, added and removed `[sourceId, scopeId]` pairs, per-pair old/current field changes, and the selected `major`, `minor`, `patch`, or `none` impact.

The package supports Node.js 20 or later and npm-compatible package managers. The Dependabot dependency name is `@opendatalabs/scope-catalog`.
