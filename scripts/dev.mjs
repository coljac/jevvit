// Starts a real, visible browser with Jevvit in it, for trying it out or working on it. Each browser gets its own
// profile under .profiles/, kept between runs so your settings stay put. Your everyday browser profile is never
// touched. It isn't meant for everyday browsing: while the dev Firefox runs, any program on this machine can
// connect to its debugging port, unprompted. For everyday use, install a signed copy in your own profile.
//
//   node scripts/dev.mjs firefox   build, then load build/firefox as a temporary add-on: into the dev Firefox if it
//                                  is already running (which reloads it), otherwise into a new one
//   node scripts/dev.mjs chrome    build, then start the dev Chrome (load build/chrome by hand, once)
//   node scripts/dev.mjs stop      close the dev browsers
//
// Add --headless to try it without a window (it then leaves Reddit alone, too).
//
// Firefox is driven over its remote debugging protocol, the way Mozilla's web-ext does it, rather than over
// Marionette like the e2e tests: Marionette sets navigator.webdriver, and Reddit's bot checks notice. Chrome only
// takes an unpacked extension from its own extensions page or under automation (which would probably flag it
// the same way), so there you load it once by hand and the profile keeps it.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES = join(ROOT, '.profiles');
const BINARIES = { firefox: 'firefox', chrome: 'google-chrome' };
const START_PAGE = 'https://www.reddit.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIREFOX_PREFS = `// Written by scripts/dev.mjs every time it starts this profile.
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
// A temporary add-on is uninstalled when Firefox closes. Keep its storage, and the address it lives at, so the
// key, the prompt and the remembered verdicts are still there next time.
user_pref("extensions.webextensions.keepStorageOnUninstall", true);
user_pref("extensions.webextensions.keepUuidOnUninstall", true);
user_pref("browser.shell.checkDefaultBrowser", false);
`;

const paths = (browser) => ({
  profile: join(PROFILES, `dev-${browser}`),
  log: join(PROFILES, `dev-${browser}.log`),
  state: join(PROFILES, `dev-${browser}.json`),
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

/** The dev browser started earlier, if it is still running: { pid, port? } or null. */
function running(browser) {
  const { state, profile } = paths(browser);
  let saved;
  try {
    saved = JSON.parse(readFileSync(state, 'utf8'));
    process.kill(saved.pid, 0);
  } catch {
    return null;
  }
  try {
    // Make sure that pid hasn't since been handed to some other program.
    if (!readFileSync(`/proc/${saved.pid}/cmdline`, 'utf8').includes(profile)) return null;
  } catch {
    // no /proc here: trust the pid
  }
  return saved;
}

/** Whether the process has gone, waiting up to `ms` for it to. */
async function exited(pid, ms = 10000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

/** Launch a browser that outlives this script, its output going to a fresh dev log (or nowhere, when quiet). */
function launch(browser, args, { quiet = false } = {}) {
  const { log } = paths(browser);
  mkdirSync(PROFILES, { recursive: true });
  const out = quiet ? 'ignore' : openSync(log, 'w');
  const child = spawn(BINARIES[browser], args, { detached: true, stdio: ['ignore', out, out] });
  if (!quiet) closeSync(out);
  child.unref();
  const status = { failure: null };
  child.on('error', (err) => (status.failure = `could not start ${BINARIES[browser]}: ${err.message}`));
  child.on('exit', (code) => (status.failure ??= `${browser} quit straight away (exit ${code}); see ${relative(ROOT, log)}. Is the dev ${browser} already open?`));
  return { child, status };
}

/** Firefox's remote debugging protocol: "<byte length>:<json>" packets over TCP, the same framing as Marionette. */
function rdpClient(socket) {
  let buffer = Buffer.alloc(0);
  const waiting = [];
  const fail = (err) => waiting.splice(0).forEach((w) => w.reject(err));
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(0x3a);
      const length = colon < 0 ? NaN : Number(buffer.subarray(0, colon).toString());
      if (!(length >= 0) || buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString('utf8'));
      buffer = buffer.subarray(colon + 1 + length);
      // Replies carry no "type"; a packet with one is an event nobody here asked for.
      const i = waiting.findIndex((w) => w.from === packet.from);
      if (i < 0 || packet.type) continue;
      const [w] = waiting.splice(i, 1);
      if (packet.error) w.reject(new Error(`${packet.error}: ${packet.message || ''}`));
      else w.resolve(packet);
    }
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('the debugging connection closed')));
  const expect = (from) => new Promise((resolve, reject) => waiting.push({ from, resolve, reject }));
  return {
    greeting: expect('root'),
    request(to, type, params = {}) {
      const reply = expect(to);
      const json = JSON.stringify({ to, type, ...params });
      socket.write(`${Buffer.byteLength(json)}:${json}`);
      return reply;
    },
    close: () => socket.end(),
  };
}

async function connectRdp(port, status = { failure: null }) {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (status.failure) throw new Error(status.failure);
    const socket = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        resolve(null);
      });
    });
    if (socket) return rdpClient(socket);
    if (Date.now() > deadline) throw new Error(`Firefox's debugging server never answered on port ${port}`);
    await sleep(200);
  }
}

/** Install (or replace) the temporary add-on in a running Firefox. Returns its id. */
async function installTemporaryAddon(port, dir, status) {
  const client = await connectRdp(port, status);
  try {
    await client.greeting;
    const root = await client.request('root', 'getRoot');
    if (!root.addonsActor) throw new Error('this Firefox does not offer remote add-on installs');
    const { addon } = await client.request(root.addonsActor, 'installTemporaryAddon', { addonPath: dir, openDevTools: false });
    return addon.id;
  } finally {
    client.close();
  }
}

async function firefox({ headless }) {
  const { dir, manifest } = build('firefox');
  const { profile, log, state } = paths('firefox');
  const live = running('firefox');
  if (live) {
    try {
      const id = await installTemporaryAddon(live.port, dir);
      console.log(`Reloaded Jevvit ${manifest.version} (${id}) in the dev Firefox, from ${relative(ROOT, dir)}.`);
      return;
    } catch (err) {
      // Reloading an add-on closes its own tabs. If Jevvit's settings page was the last tab open, that closes the
      // window, and Firefox with it: start afresh. Anything else is a real failure.
      if (!(await exited(live.pid))) throw err;
      console.log("The dev Firefox closed as Jevvit reloaded (Jevvit's settings page was its last tab), so starting it again.");
    }
  }
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'user.js'), FIREFOX_PREFS);
  const port = await freePort();
  const args = ['--no-remote', '--profile', profile, '--start-debugger-server', String(port)];
  const { child, status } = launch('firefox', [...args, ...(headless ? ['--headless', 'about:about'] : [START_PAGE])]);
  writeFileSync(state, JSON.stringify({ pid: child.pid, port }));
  const id = await installTemporaryAddon(port, dir, status);
  console.log(`Started the dev Firefox (profile ${relative(ROOT, profile)}) with Jevvit ${manifest.version} (${id}) loaded.`);
  console.log(`Its output goes to ${relative(ROOT, log)}. Run this again after a change to reload Jevvit; \`just stop\` closes it.`);
}

function chrome({ headless }) {
  const { dir } = build('chrome');
  const { profile, state } = paths('chrome');
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : [])];
  const where = relative(ROOT, dir);
  if (running('chrome')) {
    // Chrome passes this on to the copy that's already running (which opens it in a new tab), then quits.
    launch('chrome', [...args, 'chrome://extensions/'], { quiet: true });
    console.log(`Rebuilt ${where}. In the dev Chrome, press the reload arrow on Jevvit's card at chrome://extensions to pick it up.`);
    return;
  }
  const { child } = launch('chrome', [...args, 'chrome://extensions/', ...(headless ? [] : [START_PAGE])]);
  writeFileSync(state, JSON.stringify({ pid: child.pid }));
  console.log(`Started the dev Chrome (profile ${relative(ROOT, profile)}).`);
  console.log(`If Jevvit isn't on chrome://extensions yet: switch on Developer mode, press "Load unpacked" and pick ${where}.`);
  console.log(`The profile remembers it, and Chrome reads ${where} afresh each time it starts.`);
}

async function stop() {
  for (const browser of Object.keys(BINARIES)) {
    const live = running(browser);
    rmSync(paths(browser).state, { force: true });
    if (!live) continue;
    process.kill(live.pid, 'SIGTERM');
    console.log((await exited(live.pid)) ? `Closed the dev ${browser}.` : `The dev ${browser} (pid ${live.pid}) is taking its time to close.`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const headless = rest.includes('--headless');
try {
  if (command === 'firefox') await firefox({ headless });
  else if (command === 'chrome') chrome({ headless });
  else if (command === 'stop') await stop();
  else {
    console.error('usage: node scripts/dev.mjs firefox|chrome|stop [--headless]');
    process.exit(2);
  }
} catch (err) {
  console.error(`dev: ${err.message}`);
  process.exit(1);
}
