// Builds the extension for each browser from the one source tree in src/.
//
//   node scripts/build.mjs                 build/firefox and build/chrome
//   node scripts/build.mjs --zip           ...and dist/jevvit-<version>-<browser>.zip
//   node scripts/build.mjs --test          ...and build/<browser>-test, with loopback hosts added for the
//                                          end-to-end harness (never packaged)
//   node scripts/build.mjs firefox --zip   just one browser
//
// The two browsers differ only in their manifest: Chrome wants a service worker for the background, Firefox an
// event page (and an add-on id). Everything else is copied as it is.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const BROWSERS = ['firefox', 'chrome'];

const LIB_SCRIPTS = ['lib/core.js', 'lib/client.js', 'lib/cache.js'];
const TEST_HOSTS = ['http://127.0.0.1/*', 'http://localhost/*'];

export const ADDON_ID = 'jevvit@coljac.net';

/** The browser-specific half of the manifest. */
const overlays = {
  chrome: () => ({
    minimum_chrome_version: '111',
    background: { service_worker: 'background.js' },
  }),
  firefox: () => ({
    background: { scripts: [...LIB_SCRIPTS, 'background.js'] },
    browser_specific_settings: {
      gecko: {
        id: ADDON_ID,
        strict_min_version: '140.0',
        // What leaves the browser: the text of the stories being judged, sent to the Jev API.
        data_collection_permissions: { required: ['websiteContent'] },
      },
    },
  }),
};

export function manifestFor(browser, { test = false } = {}) {
  const base = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const manifest = { ...base, ...overlays[browser]() };
  if (test) {
    manifest.name = `${base.name} (test build)`;
    manifest.host_permissions = [...base.host_permissions, ...TEST_HOSTS];
    manifest.content_scripts = base.content_scripts.map((cs) => ({ ...cs, matches: [...cs.matches, ...TEST_HOSTS] }));
  }
  return manifest;
}

/** Every file the manifest and the pages point at must exist. Throws with the full list if not. */
export function validateBuild(dir, manifest) {
  const refs = new Set();
  const add = (p) => p && refs.add(p);

  Object.values(manifest.icons || {}).forEach(add);
  Object.values((manifest.action || {}).default_icon || {}).forEach(add);
  add((manifest.action || {}).default_popup);
  add((manifest.options_ui || {}).page);
  add((manifest.background || {}).service_worker);
  ((manifest.background || {}).scripts || []).forEach(add);
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach(add);

  const pages = [...refs].filter((p) => p.endsWith('.html'));
  for (const page of pages) {
    const html = readFileSync(join(dir, page), 'utf8');
    for (const [, url] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (/^(https?:|data:)/.test(url)) continue;
      refs.add(relative(dir, resolve(dirname(join(dir, page)), url)));
    }
  }

  // Chrome loads the same files from importScripts() in background.js; keep that list honest too.
  const worker = existsSync(join(dir, 'background.js')) ? readFileSync(join(dir, 'background.js'), 'utf8') : '';
  const imported = /importScripts\(([^)]*)\)/.exec(worker);
  if (imported) for (const [, file] of imported[1].matchAll(/'([^']+)'/g)) refs.add(file);

  const missing = [...refs].filter((p) => !existsSync(join(dir, p)));
  if (missing.length) throw new Error(`build is missing files it refers to: ${missing.join(', ')}`);
  return [...refs].sort();
}

export function build(browser, { test = false, out = join(ROOT, 'build') } = {}) {
  const dir = join(out, test ? `${browser}-test` : browser);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(SRC, dir, { recursive: true, filter: (p) => p !== join(SRC, 'manifest.json') });
  const manifest = manifestFor(browser, { test });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  validateBuild(dir, manifest);
  return { dir, manifest };
}

function countFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? countFiles(join(dir, e.name)) : 1),
    0,
  );
}

export function zip(browser, dir, manifest) {
  const dist = join(ROOT, 'dist');
  mkdirSync(dist, { recursive: true });
  const file = join(dist, `jevvit-${manifest.version}-${browser}.zip`);
  rmSync(file, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', file, '.'], { cwd: dir });
  return file;
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const named = argv.filter((a) => !a.startsWith('--'));
  const browsers = named.length ? named : BROWSERS;
  for (const b of browsers) if (!BROWSERS.includes(b)) throw new Error(`unknown browser "${b}" (use ${BROWSERS.join(' or ')})`);

  for (const browser of browsers) {
    const { dir, manifest } = build(browser);
    console.log(`${browser}: ${relative(ROOT, dir)} (${countFiles(dir)} files, v${manifest.version})`);
    if (flags.has('--zip')) {
      const file = zip(browser, dir, manifest);
      console.log(`  zipped ${relative(ROOT, file)} (${statSync(file).size} bytes)`);
    }
    if (flags.has('--test')) {
      const t = build(browser, { test: true });
      console.log(`${browser}: ${relative(ROOT, t.dir)} (test build, loopback hosts allowed)`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
