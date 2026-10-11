// Drives Chrome over the DevTools protocol with no dependencies.
//
// Chrome 137+ ignores --load-extension in branded builds, so the extension goes in with the protocol's own
// Extensions.loadUnpacked, which needs --remote-debugging-pipe and --enable-unsafe-extension-debugging.
// The pipe speaks NUL-terminated JSON on file descriptors 3 (to the browser) and 4 (from it).

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Pipe {
  constructor(toBrowser, fromBrowser) {
    this.out = toBrowser;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    let buf = '';
    fromBrowser.setEncoding('utf8');
    fromBrowser.on('data', (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf('\0')) >= 0) {
        const raw = buf.slice(0, at);
        buf = buf.slice(at + 1);
        if (raw) this.dispatch(JSON.parse(raw));
      }
    });
  }

  dispatch(msg) {
    if (msg.id) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    } else {
      for (const fn of this.listeners) fn(msg);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }
}

export async function launchChrome({ binary = 'google-chrome', profileDir, extensionDir, headless = true, log = () => {} }) {
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--password-store=basic',
    '--window-size=1280,1700',
    '--force-device-scale-factor=1',
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const pipe = new Pipe(child.stdio[3], child.stdio[4]);

  const consoles = new Map(); // sessionId -> [{type, text}]
  pipe.onEvent((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.sessionId) {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      (consoles.get(m.sessionId) || consoles.set(m.sessionId, []).get(m.sessionId)).push({ type: m.params.type, text });
    }
    if (m.method === 'Runtime.exceptionThrown' && m.sessionId) {
      const d = m.params.exceptionDetails;
      (consoles.get(m.sessionId) || consoles.set(m.sessionId, []).get(m.sessionId)).push({ type: 'exception', text: d.exception?.description || d.text });
    }
  });

  const loaded = await pipe.send('Extensions.loadUnpacked', { path: extensionDir }).catch((err) => {
    child.kill();
    throw new Error(`could not load the extension: ${err.message}\n${stderr.slice(-800)}`);
  });
  const extensionId = loaded.id;
  log(`chrome: extension loaded as ${extensionId}`);

  async function attach(targetId) {
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    await pipe.send('Runtime.enable', {}, sessionId);
    await pipe.send('Page.enable', {}, sessionId).catch(() => {});
    return sessionId;
  }

  const driver = {
    name: 'chrome',
    extensionBase: `chrome-extension://${extensionId}`,
    version: null,

    async open(url) {
      const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await attach(targetId);
      const tab = { targetId, sessionId };
      if (url) await driver.goto(tab, url);
      return tab;
    },

    async goto(tab, url) {
      const loadedOnce = new Promise((resolve) => {
        const handler = (m) => {
          if (m.method === 'Page.loadEventFired' && m.sessionId === tab.sessionId) {
            pipe.listeners.splice(pipe.listeners.indexOf(handler), 1);
            resolve();
          }
        };
        pipe.onEvent(handler);
      });
      const nav = await pipe.send('Page.navigate', { url }, tab.sessionId);
      if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
      await Promise.race([loadedOnce, sleep(15000)]);
    },

    async eval(tab, fn, ...args) {
      const expression = `(async () => { const f = ${fn.toString()}; return await f(...${JSON.stringify(args)}); })()`;
      const res = await pipe.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        tab.sessionId,
      );
      if (res.exceptionDetails) throw new Error(`page threw: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
      return res.result.value;
    },

    /** A real, trusted mouse click, the way a person would do it. */
    async click(tab, selector) {
      const rect = await driver.eval(tab, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, selector);
      if (!rect) throw new Error(`nothing matches ${selector} to click`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await pipe.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, tab.sessionId);
      }
    },

    async waitFor(tab, fn, args = [], { timeout = 10000, interval = 60, what = 'condition' } = {}) {
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

    async screenshot(tab, file, { height } = {}) {
      const clip = height ? { x: 0, y: 0, width: 1280, height, scale: 1 } : undefined;
      const { data } = await pipe.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }, tab.sessionId);
      writeFileSync(file, Buffer.from(data, 'base64'));
    },

    consoleOf(tab) {
      return consoles.get(tab.sessionId) || [];
    },

    /** Console output and errors from the extension's background service worker. */
    async workerConsole() {
      const { targetInfos } = await pipe.send('Target.getTargets');
      const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
      if (!worker) return [{ type: 'note', text: 'service worker is not running' }];
      const sessionId = await attach(worker.targetId);
      await sleep(50);
      return consoles.get(sessionId) || [];
    },

    async close(tab) {
      await pipe.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    },

    async quit() {
      await pipe.send('Browser.close').catch(() => {});
      await Promise.race([exited, sleep(4000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },

    stderr: () => stderr,
  };

  // The add-on opens its settings page on first install. Wait for it (the setup scenario checks that it happened),
  // then close it so the scenarios start from a clean slate.
  const settingsUrl = `${driver.extensionBase}/options/options.html`;
  let firstRun = null;
  let pages = [];
  for (const deadline = Date.now() + 30000; Date.now() < deadline && !firstRun; ) {
    pages = (await pipe.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
    firstRun = pages.find((t) => t.url === settingsUrl);
    if (!firstRun) await sleep(100);
  }
  driver.openedSettingsOnInstall = Boolean(firstRun);
  // Leave it be if it is the only tab: closing the last one would close the browser.
  if (firstRun && pages.length > 1) await pipe.send('Target.closeTarget', { targetId: firstRun.targetId }).catch(() => {});
  log(`chrome: ${firstRun ? 'the add-on opened its settings page on install' : 'the add-on did NOT open its settings page on install'}`);
  return driver;
}
