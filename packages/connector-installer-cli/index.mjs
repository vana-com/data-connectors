#!/usr/bin/env node

import {
  generateLock,
  installFromLock,
  loadConnectorIndex,
  readJson,
  verifyInstalled,
  checkForUpdates,
} from "../connector-installer-core/index.mjs";

function usage() {
  console.error(`Usage:
  connector-installer lock --dependencies <path> [--lock <path>] [--index-url <url>] [--from-local <dir>]
  connector-installer install --lock <path> --install-root <dir> --layout <snapshot|source> [--index-url <url>] [--from-local <dir>] [--prune]
  connector-installer verify --lock <path> --install-root <dir> --layout <snapshot|source> [--index-url <url>] [--from-local <dir>]
  connector-installer updates --lock <path> [--index-url <url>] [--from-local <dir>]`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--prune") {
      options.prune = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    );
    options[key] = rest[i + 1] ?? null;
    i += 1;
  }

  return options;
}

async function loadIndexSource(options) {
  return loadConnectorIndex({
    fromLocal: options.fromLocal ?? null,
    indexUrl: options.indexUrl ?? null,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.command) {
    usage();
    process.exit(1);
  }

  if (options.command === "lock") {
    if (!(options.dependencies && options.lock)) {
      usage();
      process.exit(1);
    }

    const dependencies = readJson(options.dependencies);
    const source = await loadIndexSource(options);
    const lock = await generateLock({
      dependencies,
      source,
      dependencyFile: options.dependencies,
    });
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
    return;
  }

  if (options.command === "install") {
    if (!(options.lock && options.installRoot && options.layout)) {
      usage();
      process.exit(1);
    }

    const lock = readJson(options.lock);
    const source = await loadIndexSource(options);
    const result = await installFromLock({
      lock,
      source,
      installRoot: options.installRoot,
      layout: options.layout,
      prune: Boolean(options.prune),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (options.command === "verify") {
    if (!(options.lock && options.installRoot && options.layout)) {
      usage();
      process.exit(1);
    }

    const lock = readJson(options.lock);
    const source = await loadIndexSource(options);
    const result = await verifyInstalled({
      lock,
      source,
      installRoot: options.installRoot,
      layout: options.layout,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (options.command === "updates") {
    if (!options.lock) {
      usage();
      process.exit(1);
    }

    const lock = readJson(options.lock);
    const source = await loadIndexSource(options);
    const result = await checkForUpdates({
      lock,
      indexDoc: source.doc,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
