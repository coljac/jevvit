import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, manifestFor, validateBuild } from '../scripts/build.mjs';

function withOut(fn) {
  const out = mkdtempSync(join(tmpdir(), 'jevvit-build-'));
  try {
    return fn(out);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

test('each browser gets a complete build with the background it understands', () => {
  withOut((out) => {
    const firefox = readManifest(build('firefox', { out }).dir);
    assert.deepEqual(firefox.background, { scripts: ['lib/core.js', 'lib/client.js', 'lib/cache.js', 'background.js'] });
    assert.equal(firefox.browser_specific_settings.gecko.id, 'jevvit@coljac.net');
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ['websiteContent'] });

    const chrome = readManifest(build('chrome', { out }).dir);
    assert.deepEqual(chrome.background, { service_worker: 'background.js' });
    assert.equal('browser_specific_settings' in chrome, false);
  });
});

test('the build refuses to leave out a file the extension refers to', () => {
  withOut((out) => {
    const { dir, manifest } = build('chrome', { out });
    rmSync(join(dir, 'popup', 'popup.js'));
    assert.throws(() => validateBuild(dir, manifest), /popup\/popup\.js/);
  });
});

test('shipped builds reach only Reddit and the API; loopback is for the test build alone', () => {
  for (const browser of ['firefox', 'chrome']) {
    const shipped = manifestFor(browser);
    assert.deepEqual(shipped.host_permissions, ['https://api.typesafe.ai/*', '*://*.reddit.com/*']);
    assert.deepEqual(shipped.content_scripts[0].matches, ['*://*.reddit.com/*']);

    const testBuild = manifestFor(browser, { test: true });
    assert.ok(testBuild.host_permissions.includes('http://127.0.0.1/*'));
    assert.match(testBuild.name, /test build/);
  }
});

test('no host pattern carries a port, which Firefox would refuse', () => {
  const m = manifestFor('firefox', { test: true });
  const patterns = [...m.host_permissions, ...m.optional_host_permissions, ...m.content_scripts.flatMap((cs) => cs.matches)];
  for (const p of patterns) assert.doesNotMatch(p, /:\d+\//, p);
});
