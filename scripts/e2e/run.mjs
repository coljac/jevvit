// Runs the end-to-end scenarios in real browsers against a mock Jev API and a pretend Reddit.
//
//   node scripts/e2e/run.mjs                 chrome, then firefox
//   node scripts/e2e/run.mjs chrome          just one
//   node scripts/e2e/run.mjs firefox --only feed,old
//
// Nothing here touches the real Reddit, the real Jev API or your own browser profile: each run builds the test
// variant of the extension (loopback hosts allowed), starts throwaway servers on random ports, and launches
// a browser with a fresh profile under .profiles/.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { startApi, startSite } from '../mock-jev.mjs';
import { launchChrome } from './cdp.mjs';
import { launchFirefox } from './marionette.mjs';
import { runScenarios } from './scenarios.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--only');
const browsers = named.length ? named : ['chrome', 'firefox'];
const headless = !flag('--headed');

async function runOne(browser) {
  console.log(`\n=== ${browser}${headless ? ' (headless)' : ''} ===`);
  const { dir } = build(browser, { test: true });
  const api = await startApi();
  const site = await startSite();
  const profileDir = join(ROOT, '.profiles', `e2e-${browser}`);
  const log = (line) => console.log(line);
  const launch = browser === 'chrome' ? launchChrome : launchFirefox;
  const driver = await launch({ profileDir, extensionDir: dir, headless, log });
  let results = [];
  try {
    results = await runScenarios({ driver, api, site, outDir: join(ROOT, 'build', 'e2e'), log, only });
  } catch (err) {
    console.log(`\nSCENARIO ERROR: ${err.stack || err.message}`);
    results.push({ name: `scenario crashed: ${err.message}`, ok: false });
    if (driver.output) {
      const tail = driver.output().trim().split('\n').slice(-25).join('\n');
      if (tail) console.log(`browser output (tail):\n${tail}`);
    }
    if (driver.workerConsole) {
      const w = await driver.workerConsole().catch(() => []);
      if (w.length) console.log(`background console:\n${w.map((e) => `  [${e.type}] ${e.text}`).join('\n')}`);
    }
  } finally {
    await driver.quit();
    await api.close();
    await site.close();
  }
  return results;
}

let failed = 0;
const summary = [];
for (const browser of browsers) {
  const results = await runOne(browser);
  const bad = results.filter((r) => !r.ok);
  failed += bad.length;
  summary.push(`${browser}: ${results.length - bad.length}/${results.length} checks passed`);
}
console.log(`\n${summary.join('\n')}`);
process.exit(failed ? 1 : 0);
