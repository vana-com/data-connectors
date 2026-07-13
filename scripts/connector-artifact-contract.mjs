import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function scopeId(entry) {
  return typeof entry === "string" ? entry : entry?.scope;
}

export function assertBundledScopeSchemasMatch({ artifactPath, manifestPath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.scopes ?? []) {
    const scope = scopeId(entry);
    if (!scope) continue;

    const schemaPath = join(dirname(manifestPath), "schemas", `${scope}.json`);
    const currentSchema = readFileSync(schemaPath);
    let bundledSchema;
    try {
      bundledSchema = execFileSync("tar", [
        "-xOf",
        artifactPath,
        `./schemas/${scope}.json`,
      ]);
    } catch {
      throw new Error(`${scope} schema is missing from the immutable connector bundle`);
    }

    if (!currentSchema.equals(bundledSchema)) {
      throw new Error(`${scope} schema changed without a connector version bump`);
    }
  }
}
