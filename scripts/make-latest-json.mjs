#!/usr/bin/env node
/**
 * scripts/make-latest-json.mjs
 * Generates latest.json updater manifest from release artifacts and .sig signatures.
 * Also generates android.json updater manifest for Android APK releases.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function printHelp() {
  console.log(`
Usage: node scripts/make-latest-json.mjs [options]

Options:
  --version <version>           Release version (e.g. 0.9.11)
  --release-dir <dir>           Directory containing release artifacts (*.sig, packages)
  --base-url <url>              Base download URL for release assets
  --notes <notes>               Release notes / changelog text (optional)
  --apk <path>                  Path to Android APK (optional, auto-detected in release-dir if omitted)
  --output <path>               Output file path for latest.json (default: <release-dir>/latest.json)
  --android-output <path>       Output file path for android.json (default: <output-dir>/android.json)
  --help, -h                    Show this help message

Platform matching:
  *_x64.app.tar.gz.sig          -> darwin-x86_64
  *_aarch64.app.tar.gz.sig      -> darwin-aarch64
  *-setup.exe.sig               -> windows-x86_64
  *_arm64-release.apk           -> Android feed (android.json)
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
    } else if (arg === '--apk') {
      options.apk = args[++i];
    } else if (arg === '--android-output') {
      options.androidOutput = args[++i];
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

export function generateAndroidManifest({ version, releaseDir, baseUrl, notes = '', apk }) {
  if (!version) {
    throw new Error('Missing required option: --version');
  }
  if (!baseUrl) {
    throw new Error('Missing required option: --base-url');
  }

  let apkPath = null;
  if (apk) {
    const filename = path.basename(apk);
    if (!filename.includes(`_${version}_`)) {
      throw new Error(`APK 文件名 (${filename}) 与版本 (${version}) 不一致，必须包含 _${version}_`);
    }
    apkPath = path.resolve(apk);
  } else if (releaseDir) {
    const resolvedDir = path.resolve(releaseDir);
    if (fs.existsSync(resolvedDir)) {
      const entries = fs.readdirSync(resolvedDir);
      const apkCandidates = entries.filter(e => e.endsWith('_arm64-release.apk'));
      if (apkCandidates.length === 0) {
        return null;
      }
      const targetSuffix = `_${version}_arm64-release.apk`;
      const matched = apkCandidates.find(e => e.endsWith(targetSuffix));
      if (!matched) {
        const foundVersions = apkCandidates.map(e => {
          const m = e.match(/_([^_]+)_arm64-release\.apk$/);
          return m ? m[1] : e;
        });
        throw new Error(
          `未在 releaseDir (${resolvedDir}) 中找到版本 ${version} 的 APK (期望匹配 *${targetSuffix})。` +
          `目录中存在的 APK: ${apkCandidates.join(', ')} (版本: ${foundVersions.join(', ')})，请求的版本: ${version}`
        );
      }
      apkPath = path.join(resolvedDir, matched);
    } else {
      return null;
    }
  }

  if (!apkPath || !fs.existsSync(apkPath)) {
    return null;
  }

  const fileBuffer = fs.readFileSync(apkPath);
  const size = fs.statSync(apkPath).size;
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const assetFilename = path.basename(apkPath);
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBaseUrl}/${assetFilename}`;

  return {
    version,
    url,
    size,
    sha256,
    notes,
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

    const androidManifest = generateAndroidManifest(options);
    if (androidManifest) {
      const androidOutputPath = options.androidOutput
        ? path.resolve(options.androidOutput)
        : path.join(path.dirname(outputPath), 'android.json');
      fs.mkdirSync(path.dirname(androidOutputPath), { recursive: true });
      fs.writeFileSync(androidOutputPath, JSON.stringify(androidManifest, null, 2) + '\n', 'utf8');
      console.log(`Successfully generated Android manifest: ${androidOutputPath}`);
    } else {
      console.warn(`[make-latest-json] Warning: no *_arm64-release.apk found in ${options.releaseDir}; skipped android.json generation.`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
