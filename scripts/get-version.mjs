#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const ROOT_PACKAGE_JSON = path.join(ROOT_DIR, 'package.json');
const OSIRIS_PACKAGE_JSON = path.join(ROOT_DIR, 'apps', 'osiris', 'package.json');
const ANDROID_GRADLE = path.join(ROOT_DIR, 'apps', 'osiris-android', 'app', 'build.gradle.kts');

function parseArgs(argv) {
  const args = {
    mode: 'raw',
    bump: '',
    write: false,
    sync: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === '--raw') args.mode = 'raw';
    else if (cur === '--tag') args.mode = 'tag';
    else if (cur === '--android-name') args.mode = 'android-name';
    else if (cur === '--android-code') args.mode = 'android-code';
    else if (cur === '--bump' && argv[i + 1]) args.bump = argv[++i];
    else if (cur === '--write') args.write = true;
    else if (cur === '--sync') args.sync = true;
  }
  return args;
}

function parseSemver(input) {
  const trimmed = String(input).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid semver in VERSION: "${trimmed}"`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bumpSemver(base, bump) {
  if (bump === 'major') return { major: base.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: base.major, minor: base.minor + 1, patch: 0 };
  if (bump === 'patch') return { major: base.major, minor: base.minor, patch: base.patch + 1 };
  throw new Error(`Unsupported bump type: "${bump}". Use patch|minor|major.`);
}

function androidCodeFromSemver(v) {
  return v.major * 10000 + v.minor * 100 + v.patch;
}

function readVersion() {
  if (!fs.existsSync(VERSION_FILE)) throw new Error('VERSION file not found');
  return parseSemver(fs.readFileSync(VERSION_FILE, 'utf-8'));
}

function writeVersion(v) {
  fs.writeFileSync(VERSION_FILE, `${formatSemver(v)}\n`, 'utf-8');
}

function syncJsonVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  json.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
}

function syncAndroidVersionName(version) {
  const oldText = fs.readFileSync(ANDROID_GRADLE, 'utf-8');
  const nextText = oldText.replace(
    /versionName\s*=\s*"[^"]*"/,
    `versionName = "${version}"`,
  );
  fs.writeFileSync(ANDROID_GRADLE, nextText, 'utf-8');
}

function syncVersion(version) {
  syncJsonVersion(ROOT_PACKAGE_JSON, version);
  syncJsonVersion(OSIRIS_PACKAGE_JSON, version);
  syncAndroidVersionName(version);
}

function printMode(mode, v) {
  const version = formatSemver(v);
  if (mode === 'tag') {
    process.stdout.write(`v${version}\n`);
    return;
  }
  if (mode === 'android-code') {
    process.stdout.write(`${androidCodeFromSemver(v)}\n`);
    return;
  }
  process.stdout.write(`${version}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let version = readVersion();
  if (args.bump) {
    version = bumpSemver(version, args.bump);
    if (args.write) writeVersion(version);
  }
  if (args.sync) syncVersion(formatSemver(version));
  printMode(args.mode, version);
}

main();
