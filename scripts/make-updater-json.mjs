// Generates latest.json for the Tauri updater from signed release bundles.
// Run after `npx tauri build` with TAURI_SIGNING_PRIVATE_KEY set. The
// installers themselves are the update packages: NSIS setup.exe on Windows,
// the .app.tar.gz tarball on macOS (Tauri 2 updates from the tarball, the
// dmg stays a manual-install asset), and the AppImage on Linux.
//
// Windows is the mandatory baseline. macOS/Linux dirs are opt-in: without
// the flag the platform is simply skipped, so the script keeps working for
// a pure-Windows release (this guarded the pipeline before the first
// cross-platform tags). A flag that points to a missing dir is an error —
// that means the pipeline lost its artifacts. The --macos flag outlived
// this repository's macOS releases: it serves the prosa-mac fork, which
// syncs this script (#121).
//
// Usage: node scripts/make-updater-json.mjs <tag> [options]
//   tag                    release tag; must match the app version (v0.1.4 <-> 0.1.4)
//   --nsis <dir>           Windows NSIS dir (default src-tauri/target/release/bundle/nsis)
//   --macos <dir>          macOS updater dir with *.app.tar.gz + .sig
//                          (…/release/bundle/macos); ONE universal tarball
//                          covers darwin-aarch64 + darwin-x86_64
//   --appimage-x64 <dir>   Linux x64 AppImage dir (.../release/bundle/appimage on the x64 runner)
//   --appimage-arm64 <dir> Linux arm64 AppImage dir (same relative path on the arm64 runner)
//   --out <file>           output file (default src-tauri/target/release/bundle/latest.json)

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Releases live in the main code repo; the app checks for updates here
// (see plugins.updater.endpoints in src-tauri/tauri.conf.json).
const RELEASES_REPO = 'Wad-man/prosa';

const root = fileURLToPath(new URL('..', import.meta.url));
const die = (msg) => {
  console.error(`make-updater-json: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const tag = args.shift();
if (!tag) {
  console.error('usage: node scripts/make-updater-json.mjs <tag> [--nsis <dir>] [--macos <dir>] [--appimage-x64 <dir>] [--appimage-arm64 <dir>] [--out <file>]');
  process.exit(1);
}

const OPTIONS = ['nsis', 'macos', 'appimage-x64', 'appimage-arm64', 'out'];
// every remaining arg must be "--name value" pairs — a bare positional is
// almost certainly the old pre-flag call and must fail loudly, not write
// to the default paths by accident
for (let i = 0; i < args.length; i += 2) {
  const name = args[i];
  if (!name?.startsWith('--') || !OPTIONS.includes(name.slice(2))) die(`unexpected argument "${name ?? ''}" (expected --${OPTIONS.join('|--')} <value> pairs)`);
  const value = args[i + 1];
  if (!value || value.startsWith('--')) die(`${name} requires a value`);
}

const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return resolve(args[i + 1]);
};

const nsisDir = opt('nsis', join(root, 'src-tauri/target/release/bundle/nsis'));
const macosDir = opt('macos');
const appimageX64Dir = opt('appimage-x64');
const appimageArm64Dir = opt('appimage-arm64');
const outFile = opt('out', join(root, 'src-tauri/target/release/bundle/latest.json'));

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
if (tag !== `v${version}`) die(`tag ${tag} does not match tauri.conf.json version ${version}`);

const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
if (!cargo || cargo[1] !== version) die(`Cargo.toml version does not match tauri.conf.json (${version})`);

// Find exactly one file matching a '*' wildcard pattern in a bundle dir and
// load its minisign signature — no glob dependency needed.
const findOne = (dir, pattern) => {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  const matches = readdirSync(dir).filter((f) => re.test(f)).sort();
  if (matches.length !== 1) die(`expected exactly one "${pattern}" in ${dir}, found ${matches.length}`);
  const name = matches[0];
  let signature;
  try {
    signature = readFileSync(join(dir, `${name}.sig`), 'utf8').trim();
  } catch {
    die(`missing signature file ${name}.sig in ${dir}`);
  }
  return {
    name,
    signature,
    url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
};

if (!existsSync(nsisDir)) die(`${nsisDir} not found — run a signed build first`);
const platforms = {
  'windows-x86_64': findOne(nsisDir, `*_${version}_x64-setup.exe`),
};

if (macosDir) {
  if (!existsSync(macosDir)) die(`--macos ${macosDir} not found`);
  // one universal .app.tar.gz serves both macOS arches in the updater
  const mac = findOne(macosDir, '*.app.tar.gz');
  platforms['darwin-aarch64'] = mac;
  platforms['darwin-x86_64'] = mac;
}

if (appimageX64Dir) {
  if (!existsSync(appimageX64Dir)) die(`--appimage-x64 ${appimageX64Dir} not found`);
  platforms['linux-x86_64'] = findOne(appimageX64Dir, '*.AppImage');
}
if (appimageArm64Dir) {
  if (!existsSync(appimageArm64Dir)) die(`--appimage-arm64 ${appimageArm64Dir} not found`);
  platforms['linux-aarch64'] = findOne(appimageArm64Dir, '*.AppImage');
}

const manifest = {
  version,
  notes: `ProsaMD ${tag}`,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(
    Object.entries(platforms).map(([platform, { signature, url }]) => [platform, { signature, url }]),
  ),
};

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outFile}`);
console.log(`  version:   ${version}`);
for (const [platform, { name, url }] of Object.entries(platforms)) {
  console.log(`  ${platform.padEnd(15)} ${name}`);
  console.log(`  ${' '.repeat(15)} ${url}`);
}
