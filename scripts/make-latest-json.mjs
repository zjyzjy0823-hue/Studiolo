#!/usr/bin/env node
/**
 * scripts/make-latest-json.mjs
 * Generates latest.json updater manifest from release artifacts and .sig signatures.
 */

import fs from 'node:fs';
import path from 'node:path';

function printHelp() {
  console.log(`
Usage: node scripts/make-latest-json.mjs [options]

Options:
  --version <version>    Release version (e.g. 0.9.11)
  --release-dir <dir>    Directory containing release artifacts (*.sig, packages)
  --base-url <url>       Base download URL for release assets
  --notes <notes>        Release notes / changelog text (optional)
  --output <path>        Output file path (default: <release-dir>/latest.json)
  --help, -h             Show this help message

Platform matching:
  *_x64.app.tar.gz.sig    -> darwin-x86_64
  *_aarch64.app.tar.gz.sig -> darwin-aarch64
  *-setup.exe.sig         -> windows-x86_64
`);
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version') {
      options.version = args[++i];
    } else if (arg === '--release-dir') {
      options.releaseDir = args[++i];
    } else if (arg === '--base-url') {
      options.baseUrl = args[++i];
    } else if (arg === '--notes') {
      options.notes = args[++i];
    } else if (arg === '--output') {
      options.output = args[++i];
    }
  }
  return options;
}

const EXPECTED_PLATFORMS = ['darwin-x86_64', 'darwin-aarch64', 'windows-x86_64'];

function matchPlatform(filename) {
  if (filename.endsWith('_x64.app.tar.gz.sig')) {
    return 'darwin-x86_64';
  }
  if (filename.endsWith('_aarch64.app.tar.gz.sig')) {
    return 'darwin-aarch64';
  }
  if (filename.endsWith('-setup.exe.sig')) {
    return 'windows-x86_64';
  }
  return null;
}

export function generateLatestManifest({ version, releaseDir, baseUrl, notes = '' }) {
  if (!version) {
    throw new Error('Missing required option: --version');
  }
  if (!releaseDir) {
    throw new Error('Missing required option: --release-dir');
  }
  if (!baseUrl) {
    throw new Error('Missing required option: --base-url');
  }

  const resolvedDir = path.resolve(releaseDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Release directory does not exist: ${resolvedDir}`);
  }

  const entries = fs.readdirSync(resolvedDir);
  const platforms = {};

  for (const entry of entries) {
    if (!entry.endsWith('.sig')) continue;
    const platform = matchPlatform(entry);
    if (!platform) continue;

    const sigFilePath = path.join(resolvedDir, entry);
    const signature = fs.readFileSync(sigFilePath, 'utf8').trim();
    const assetFilename = entry.slice(0, -4); // remove .sig
    const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
    const url = `${cleanBaseUrl}/${assetFilename}`;

    platforms[platform] = {
      signature,
      url,
    };
  }

  // Warn about missing expected platforms on stderr, but do not fail
  for (const expected of EXPECTED_PLATFORMS) {
    if (!platforms[expected]) {
      console.warn(`[make-latest-json] Warning: missing platform signature for '${expected}' in ${resolvedDir}`);
    }
  }

  return {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (!options.version || !options.releaseDir || !options.baseUrl) {
    printHelp();
    console.error('\nError: --version, --release-dir, and --base-url are required.\n');
    process.exit(1);
  }

  try {
    const manifest = generateLatestManifest(options);
    const outputPath = options.output
      ? path.resolve(options.output)
      : path.join(path.resolve(options.releaseDir), 'latest.json');

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`Successfully generated updater manifest: ${outputPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
