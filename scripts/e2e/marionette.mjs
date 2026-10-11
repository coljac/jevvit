// Drives Firefox over Marionette (the protocol geckodriver speaks) with no dependencies.
//
// Marionette frames each message as "<byte length>:<json>" over TCP. Commands are [0, id, name, params] and
// replies [1, id, error, result]. The extension goes in with Addon:Install, as a temporary add-on, exactly like
// "Load Temporary Add-on" in about:debugging.

import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

// Fixed, so the extension's moz-extension:// address is known before the browser starts.
const EXTENSION_UUID = '6f2a8d3c-4b1e-4f70-9a55-0d6c1c2e7a11';
const ADDON_ID = 'jevvit@coljac.net';

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

class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.greeting = new Promise((resolve) => (this.onGreeting = resolve));
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('close', () => {
      for (const w of this.pending.values()) w.reject(new Error('Marionette connection closed'));
      this.pending.clear();
    });
  }

  drain() {
    for (;;) {
      const colon = this.buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(this.buffer.subarray(0, colon).toString());
      if (!Number.isFinite(length) || this.buffer.length < colon + 1 + length) return;
      const body = this.buffer.subarray(colon + 1, colon + 1 + length).toString('utf8');
      this.buffer = this.buffer.subarray(colon + 1 + length);
      this.handle(JSON.parse(body));
    }
  }

  handle(msg) {
    if (!Array.isArray(msg)) return this.onGreeting(msg);
    const [, id, error, result] = msg;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (error) waiter.reject(new Error(`${waiter.name}: ${error.error}: ${error.message}`));
    else waiter.resolve(result);
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const json = JSON.stringify([0, id, name, params]);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, name });
      this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    });
  }
}

const PREFS = (port) => `
user_pref("marionette.port", ${port});
user_pref("marionette.log.level", "Warn");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage", "about:blank");
user_pref("startup.homepage_welcome_url", "about:blank");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.blocklist.enabled", false);
user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [ADDON_ID]: EXTENSION_UUID }))});
user_pref("extensions.webextOptionalPermissionPrompts", false);
user_pref("devtools.console.stdout.content", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("network.proxy.type", 0);
user_pref("signon.rememberSignons", false);
`;

export async function launchFirefox({ binary = 'firefox', profileDir, extensionDir, headless = true, log = () => {} }) {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const port = await freePort();
  writeFileSync(join(profileDir, 'user.js'), PREFS(port));

  const args = ['--marionette', '-remote-allow-system-access', ...(headless ? ['--headless'] : []), '--no-remote', '--profile', profileDir, 'about:blank'];
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));

  let socket;
  for (let i = 0; i < 100 && !socket; i++) {
    socket = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        resolve(null);
      });
    });
    if (!socket) await sleep(150);
  }
  if (!socket) {
    child.kill();
    throw new Error(`Firefox did not open Marionette on port ${port}\n${output.slice(-800)}`);
  }

  const m = new Marionette(socket);
  await m.greeting;
  await m.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });

  const installed = await m.send('Addon:Install', { path: extensionDir, temporary: true }).catch((err) => {
    child.kill();
    throw new Error(`could not install the extension: ${err.message}\n${output.slice(-800)}`);
  });
  log(`firefox: extension installed (${installed.value || ADDON_ID})`);

  const unwrap = (r) => (r && typeof r === 'object' && 'value' in r ? r.value : r);

  async function switchTo(tab) {
    await m.send('WebDriver:SwitchToWindow', { handle: tab.handle, focus: true });
  }

  /** Run a script with the browser's own privileges. */
  async function chromeScript(script, args = []) {
    await m.send('Marionette:SetContext', { value: 'chrome' });
    try {
      return unwrap(await m.send('WebDriver:ExecuteScript', { script, args }));
    } finally {
      await m.send('Marionette:SetContext', { value: 'content' });
    }
  }

  const handles = async () => unwrap(await m.send('WebDriver:GetWindowHandles'));

  /** WebDriver refuses to navigate to moz-extension:// pages, so open those from the browser itself. */
  async function openExtensionPage(url) {
    const before = await handles();
    await chromeScript(
      `const tab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       gBrowser.selectedTab = tab;`,
      [url],
    );
    let handle;
    for (let i = 0; i < 50 && !handle; i++) {
      handle = (await handles()).find((h) => !before.includes(h));
      if (!handle) await sleep(60);
    }
    if (!handle) throw new Error(`no tab appeared for ${url}`);
    return handle;
  }

  const driver = {
    name: 'firefox',
    extensionBase: `moz-extension://${EXTENSION_UUID}`,

    async open(url) {
      if (url && url.startsWith('moz-extension:')) {
        const tab = { handle: await openExtensionPage(url) };
        await switchTo(tab);
        return tab;
      }
      const { handle } = await m.send('WebDriver:NewWindow', { type: 'tab', focus: true });
      const tab = { handle };
      await switchTo(tab);
      if (url) await m.send('WebDriver:Navigate', { url });
      return tab;
    },

    async goto(tab, url) {
      if (url.startsWith('moz-extension:')) {
        const old = tab.handle;
        tab.handle = await openExtensionPage(url); // a fresh tab at that address, replacing the old one
        await m.send('WebDriver:SwitchToWindow', { handle: old, focus: true });
        await m.send('WebDriver:CloseWindow');
        await switchTo(tab);
        return;
      }
      await switchTo(tab);
      await m.send('WebDriver:Navigate', { url });
    },

    async eval(tab, fn, ...args) {
      await switchTo(tab);
      const script = `const f = ${fn.toString()}; return (async () => await f(...arguments[0]))();`;
      const result = await m.send('WebDriver:ExecuteScript', { script, args: [args], sandbox: 'default' });
      return unwrap(result);
    },

    async click(tab, selector) {
      await switchTo(tab);
      const found = unwrap(await m.send('WebDriver:FindElement', { using: 'css selector', value: selector }));
      await m.send('WebDriver:ElementClick', { id: found[ELEMENT] });
    },

    async waitFor(tab, fn, args = [], { timeout = 10000, interval = 80, what = 'condition' } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await driver.eval(tab, fn, ...args);
          if (last) return last;
        } catch (err) {
          last = err.message;
        }
        await sleep(interval);
      }
      throw new Error(`timed out waiting for ${what}${last ? ` (last: ${typeof last === 'string' ? last : JSON.stringify(last)})` : ''}`);
    },

    async screenshot(tab, file) {
      await switchTo(tab);
      const { value } = await m.send('WebDriver:TakeScreenshot', { full: true, hash: false, scroll: false });
      writeFileSync(file, Buffer.from(value, 'base64'));
    },

    consoleOf: () => [],

    /** Whatever Firefox printed that looks like it came from the extension. */
    async workerConsole() {
      return output
        .split('\n')
        .filter((l) => /jevvit|moz-extension|JavaScript error|TypeError|ReferenceError/i.test(l))
        .slice(-40)
        .map((text) => ({ type: 'log', text }));
    },

    async close(tab) {
      await switchTo(tab).catch(() => {});
      await m.send('WebDriver:CloseWindow').catch(() => {});
      // Land on a tab that still exists, so the next command has somewhere to run.
      const handles = unwrap(await m.send('WebDriver:GetWindowHandles').catch(() => []));
      if (Array.isArray(handles) && handles.length) await m.send('WebDriver:SwitchToWindow', { handle: handles[0] }).catch(() => {});
    },

    async quit() {
      await m.send('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },

    output: () => output,
  };

  // The add-on opens its settings page on first install, a little after Addon:Install returns. Firefox reuses an
  // empty tab for that rather than opening a new one, so it usually takes over the blank start tab. Wait for it
  // wherever it lands (the setup scenario checks that it happened), then go back to one blank tab, so nothing
  // turns up in the middle of a scenario.
  // A temporary install reads storage before deciding, and a brand-new profile is slow to open it: allow 30s.
  const settingsUrl = `${driver.extensionBase}/options/options.html`;
  let firstRun = null;
  for (const deadline = Date.now() + 30000; Date.now() < deadline && !firstRun; ) {
    for (const handle of await handles()) {
      await m.send('WebDriver:SwitchToWindow', { handle, focus: true });
      if (unwrap(await m.send('WebDriver:GetCurrentURL')) === settingsUrl) {
        firstRun = handle;
        break;
      }
    }
    if (!firstRun) await sleep(100);
  }
  driver.openedSettingsOnInstall = Boolean(firstRun);
  if (firstRun) {
    if ((await handles()).length > 1) await m.send('WebDriver:CloseWindow');
    else await m.send('WebDriver:Navigate', { url: 'about:blank' }); // closing the last tab would close the browser
  }
  await m.send('WebDriver:SwitchToWindow', { handle: (await handles())[0], focus: true });
  log(`firefox: ${firstRun ? 'the add-on opened its settings page on install' : 'the add-on did NOT open its settings page on install'}`);
  return driver;
}
