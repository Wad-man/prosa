// Generates latest.json for the Tauri updater from a signed NSIS build.
// Run after `npx tauri build` with TAURI_SIGNING_PRIVATE_KEY set, so that
// bundle/nsis contains <product>_<version>_x64-setup.exe + .sig
// (for NSIS the installer itself is the update package).
//
// Usage: node scripts/make-updater-json.mjs <tag> [bundleDir] [outFile]
//   tag        release tag; must match the app version (v0.1.4 <-> 0.1.4)
//   bundleDir  defaults to src-tauri/target/release/bundle/nsis
//   outFile    defaults to src-tauri/target/release/bundle/latest.json

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public releases-only repo; the app checks for updates here
// (see plugins.updater.endpoints in src-tauri/tauri.conf.json).
const RELEASES_REPO = 'Wad-man/prosa-releases';

const root = fileURLToPath(new URL('..', import.meta.url));
const die = (msg) => {
  console.error(`make-updater-json: ${msg}`);
  process.exit(1);
};

const tag = process.argv[2];
if (!tag) {
  console.error('usage: node scripts/make-updater-json.mjs <tag> [bundleDir] [outFile]');
  process.exit(1);
}
const bundleDir = resolve(process.argv[3] ?? join(root, 'src-tauri/target/release/bundle/nsis'));
const outFile = resolve(process.argv[4] ?? join(root, 'src-tauri/target/release/bundle/latest.json'));

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
if (tag !== `v${version}`) die(`tag ${tag} does not match tauri.conf.json version ${version}`);

const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
if (!cargo || cargo[1] !== version) die(`Cargo.toml version does not match tauri.conf.json (${version})`);

const setup = `${conf.productName}_${version}_x64-setup.exe`;
if (!readdirSync(bundleDir).includes(setup)) {
  die(`${setup} not found in ${bundleDir} — run a signed build first`);
}

let signature;
try {
  signature = readFileSync(join(bundleDir, `${setup}.sig`), 'utf8').trim();
} catch {
  die(`missing signature file ${setup}.sig`);
}

const manifest = {
  version,
  notes: `Prosa ${tag}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/${encodeURIComponent(setup)}`,
    },
  },
};

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outFile}`);
console.log(`  version:   ${version}`);
console.log(`  package:   ${setup}`);
console.log(`  url:       ${manifest.platforms['windows-x86_64'].url}`);
