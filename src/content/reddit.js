/*
 * Jevvit content script (reddit.com).
 *
 * Finds the stories on the page, asks the background script what Jev makes of
 * each one, and hides, collapses or dims the ones the user asked it to. It
 * never sees the API key and never talks to the network itself.
 *
 * Two Reddits are understood:
 *   new  <shreddit-post> inside <article>, separated by <hr>
 *   old  div.thing.link inside #siteTable
 */
(() => {
  'use strict';

  if (globalThis.__jevvitContent) return;
  globalThis.__jevvitContent = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const { core } = globalThis.Jevvit;

  const POST_SELECTOR = 'shreddit-post, div.thing.link';
  const CONFIG_ERRORS = new Set(['nokey', 'auth', 'perm']);
  const MAX_READ_TRIES = 12; // new Reddit fills in a post's attributes a moment after inserting it
  const MEMO_LIMIT = 2000;
  const HOLD_MAX_MS = 8000; // a post is never kept out of sight longer than this; a late verdict still applies

  let cfg = core.normaliseSettings(undefined);
  let active = false; // switched on, with a prompt
  let paused = false; // "show everything on this page"
  let ready = false; // settings loaded
  let epoch = 0; // bumped whenever settings change, so stale answers can be ignored
  let dead = false; // the extension was reloaded under us

  const records = new Set();
  const byElement = new WeakMap();
  const queue = new Set();
  const memo = new Map(); // request-relevant settings + post state -> P(match)
  const totals = { answered: 0, fromCache: 0, errors: 0, lastError: null };
  let drainTimer = null;
  let badgeTimer = null;
  let noticeShown = false;

  // ---------------------------------------------------------------- reading posts

  const norm = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

  function textOf(node) {
    if (!node) return '';
    try {
      return norm(node.textContent || (node.shadowRoot && node.shadowRoot.textContent) || '');
    } catch {
      return '';
    }
  }

  const commentsId = (path) => {
    const m = /\/comments\/([a-z0-9]+)/i.exec(path || '');
    return m ? m[1].toLowerCase() : '';
  };

  /** True when this post is the one the page is about (a comments page), which we never filter. */
  function isThisPage(permalink) {
    const here = commentsId(location.pathname);
    return Boolean(here) && here === commentsId(permalink);
  }

  /** Cheap checks that need no waiting: should this element be left entirely alone? */
  function ignorable(el) {
    if (el.localName === 'shreddit-post') {
      return (
        /comments/i.test(el.getAttribute('view-context') || '') ||
        isThisPage(el.getAttribute('permalink')) ||
        el.hasAttribute('promoted') ||
        el.hasAttribute('is-promoted')
      );
    }
    return (
      el.classList.contains('promoted') ||
      el.dataset.promoted === 'true' ||
      isThisPage(el.dataset.permalink)
    );
  }

  function readNew(el) {
    const attr = (name) => norm(el.getAttribute(name));
    const title = attr('post-title');
    if (!title) return null; // not filled in yet
    const name = attr('subreddit-name');
    return {
      id: attr('id') || attr('permalink') || title,
      title,
      subreddit: attr('subreddit-prefixed-name') || (name ? `r/${name}` : ''),
      kind: attr('post-type'),
      domain: attr('domain'),
      flair: textOf(el.querySelector('shreddit-post-flair')),
      body: textOf(el.querySelector('[slot="text-body"]')),
      nsfw: el.hasAttribute('nsfw') || attr('is-nsfw') === 'true',
    };
  }

  function readOld(el) {
    const link = el.querySelector('a.title');
    const title = link ? norm(link.textContent) : '';
    if (!title) return null;
    const domain = norm(el.dataset.domain);
    return {
      id: el.dataset.fullname || title,
      title,
      subreddit: el.dataset.subreddit ? `r/${el.dataset.subreddit}` : '',
      kind: /^self\./i.test(domain) ? 'text' : 'link',
      domain,
      flair: textOf(el.querySelector('.linkflairlabel')),
      body: '', // old Reddit only loads a self post's text when it is expanded
      nsfw: el.dataset.nsfw === 'true',
    };
  }

  /** What to hide: the <article> around a new-Reddit post (when it holds only that post), else the post. */
  function targetFor(el) {
    if (el.localName !== 'shreddit-post') return el;
    const article = el.closest('article');
    return article && article.querySelectorAll('shreddit-post').length === 1 ? article : el;
  }

  // ------------------------------------------------------------ marking the page

  function mark(rec, state) {
    rec.status = state;
    rec.target.setAttribute('data-jevvit', state);
  }

  function hideSeparator(rec) {
    const next = rec.target.nextElementSibling;
    if (next && next.localName === 'hr') {
      next.setAttribute('data-jevvit-sep', 'hidden');
      rec.sep = next;
    }
  }

  function restoreSeparator(rec) {
    if (rec.sep) rec.sep.removeAttribute('data-jevvit-sep');
    rec.sep = null;
  }

  function removeStub(rec) {
    if (rec.stub) rec.stub.remove();
    rec.stub = null;
  }

  /** Put the post back exactly as Reddit rendered it. */
  function clearMarks(rec) {
    removeStub(rec);
    restoreSeparator(rec);
    rec.target.removeAttribute('data-jevvit');
  }

  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }

  /** A stub needs a plain wrapper to live in; a bare <shreddit-post> would not render a stray child. */
  function canHostStub(rec) {
    return rec.target.localName !== 'shreddit-post';
  }

  function mountStub(rec) {
    removeStub(rec);
    const percent = Math.round(rec.p * 100);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jevvit-stub';
    button.title = `Jev rates this ${percent}% likely to match your prompt. Click to show it.`;
    for (const [cls, text] of [
      ['label', 'Filtered by Jevvit'],
      ['title', clip(rec.post.title, 110)],
      ['meta', `${percent}%`],
      ['show', 'Show'],
    ]) {
      const part = document.createElement('span');
      part.className = `jevvit-stub__${cls}`;
      part.textContent = text;
      button.append(part);
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      rec.revealed = true;
      clearMarks(rec);
      mark(rec, 'revealed');
      scheduleBadge();
    });
    rec.target.prepend(button);
    rec.stub = button;
  }

  /** Turn a probability into what the user sees. */
  function apply(rec, p) {
    rec.p = p;
    if (paused || !active) return;
    if (rec.revealed) return;
    const { verdict } = core.decide(p, cfg);
    clearMarks(rec);
    if (verdict === 'show') {
      mark(rec, 'shown');
    } else if (verdict === 'unsure') {
      mark(rec, 'unsure');
    } else if (cfg.action === 'hide') {
      mark(rec, 'hidden');
      hideSeparator(rec);
    } else if (cfg.action === 'dim' || !canHostStub(rec)) {
      mark(rec, 'dimmed');
    } else {
      mark(rec, 'collapsed');
      mountStub(rec);
    }
    scheduleBadge();
  }

  /** Something went wrong with this post: leave it as Reddit rendered it. */
  function release(rec, status) {
    clearMarks(rec);
    rec.status = status;
    scheduleBadge();
  }

  // ------------------------------------------------------------------ judging

  function memoKey(state) {
    return JSON.stringify([cfg.prompt, cfg.trueCriteria, cfg.falseCriteria, cfg.model, state]);
  }

  function remember(key, p) {
    if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value);
    memo.set(key, p);
  }

  async function send(message) {
    try {
      return await ext.runtime.sendMessage(message);
    } catch (err) {
      if (/context invalidated/i.test(String(err && err.message))) shutDown();
      return { ok: false, error: { kind: 'network', message: 'Lost contact with the Jevvit background script. Reload the page.' } };
    }
  }

  async function judge(rec) {
    const post = rec.post;
    if (core.isExempt(post.subreddit, cfg)) return release(rec, 'skipped');

    const state = core.buildState(post, cfg);
    const key = memoKey(state);
    let p = memo.get(key);

    if (p === undefined) {
      const mine = epoch;
      const reply = await send({ type: 'judge', state });
      if (mine !== epoch || !rec.el.isConnected) return; // settings changed meanwhile; a newer pass owns this post
      if (!reply || !reply.ok) return fail(rec, reply && reply.error);
      p = reply.p;
      totals.answered++;
      if (reply.cached) totals.fromCache++;
      remember(key, p);
    }
    apply(rec, p);
  }

  function fail(rec, error) {
    const err = error || { kind: 'network', message: 'No answer from Jevvit.' };
    totals.errors++;
    totals.lastError = err;
    release(rec, 'error');
    if (CONFIG_ERRORS.has(err.kind)) notice(err.message);
  }

  // ---------------------------------------------------------------- tracking posts

  function track(el) {
    if (byElement.has(el) || ignorable(el)) return;
    const rec = {
      el,
      target: targetFor(el),
      read: el.localName === 'shreddit-post' ? readNew : readOld,
      post: null,
      status: 'pending',
      p: null,
      tries: 0,
      stub: null,
      sep: null,
      revealed: false,
    };
    byElement.set(el, rec);
    records.add(rec);
    if (ready && active && !paused && cfg.holdUntilJudged) hold(rec);
    queue.add(rec);
    scheduleDrain();
  }

  /** Keep a post out of sight until it is judged, but give up after HOLD_MAX_MS so a slow answer can't hide it. */
  function hold(rec) {
    mark(rec, 'hold');
    setTimeout(() => {
      if (rec.status === 'hold') {
        rec.target.removeAttribute('data-jevvit');
        rec.status = 'pending';
      }
    }, HOLD_MAX_MS);
  }

  function discover(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(POST_SELECTOR)) track(root);
    for (const el of root.querySelectorAll(POST_SELECTOR)) track(el);
  }

  function scheduleDrain(delay = 25) {
    if (drainTimer === null) drainTimer = setTimeout(drain, delay);
  }

  function drain() {
    drainTimer = null;
    if (dead || !ready) return;
    let again = false;
    for (const rec of [...queue]) {
      queue.delete(rec);
      if (!rec.el.isConnected) {
        records.delete(rec);
        continue;
      }
      if (!active || paused) {
        rec.status = 'pending';
        continue;
      }
      rec.post = rec.read(rec.el);
      if (rec.post && ignorable(rec.el)) {
        release(rec, 'skipped'); // e.g. the page's own post, whose attributes arrived late
        continue;
      }
      if (!rec.post) {
        if (++rec.tries < MAX_READ_TRIES) {
          queue.add(rec);
          again = true;
        } else {
          release(rec, 'unreadable');
        }
        continue;
      }
      judge(rec).catch((err) => {
        console.debug('[jevvit]', err);
        release(rec, 'error');
      });
    }
    if (again) scheduleDrain(120);
  }

  /** The user changed something: re-run every post we know about. Verdicts we already have apply at once. */
  function reevaluate() {
    epoch++;
    for (const rec of records) {
      if (!rec.el.isConnected) {
        records.delete(rec);
        continue;
      }
      rec.revealed = false;
      if (!active || paused) {
        clearMarks(rec);
        rec.status = 'pending';
        continue;
      }
      queue.add(rec);
    }
    // Anything still marked from before stays until its new verdict arrives, so a tweak doesn't flash the page.
    scheduleDrain(0);
    scheduleBadge();
  }

  // ------------------------------------------------------------- stats, badge, notice

  function snapshot() {
    const counts = {};
    for (const rec of records) counts[rec.status] = (counts[rec.status] || 0) + 1;
    const n = (...states) => states.reduce((sum, s) => sum + (counts[s] || 0), 0);
    return {
      enabled: cfg.enabled,
      hasPrompt: Boolean(cfg.prompt),
      active,
      paused,
      posts: records.size,
      judged: totals.answered,
      fromCache: totals.fromCache,
      shown: n('shown'),
      unsure: n('unsure'),
      filtered: n('hidden', 'collapsed', 'dimmed'),
      revealed: n('revealed'),
      skipped: n('skipped'),
      waiting: n('pending', 'hold'),
      errors: totals.errors,
      lastError: totals.lastError,
    };
  }

  function scheduleBadge() {
    if (badgeTimer !== null) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      if (dead) return;
      send({ type: 'badge', hidden: snapshot().filtered });
    }, 300);
  }

  function notice(text) {
    if (noticeShown || !document.documentElement) return;
    noticeShown = true;
    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box { font: 13px/1.45 system-ui, sans-serif; max-width: 320px; padding: 12px 14px; border-radius: 10px;
             color: #fff; background: #3b36b5; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
      .row { display: flex; gap: 8px; margin-top: 10px; }
      button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.55);
               color: #fff; background: transparent; cursor: pointer; }
      button:hover, button:focus-visible { background: rgba(255,255,255,.18); }
    `;
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'alert');
    const message = document.createElement('div');
    message.textContent = `Jevvit: ${text} Posts are showing unfiltered.`;
    const row = document.createElement('div');
    row.className = 'row';
    const open = document.createElement('button');
    open.textContent = 'Open settings';
    open.addEventListener('click', () => {
      send({ type: 'openOptions' });
      host.remove();
    });
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => host.remove());
    row.append(open, dismiss);
    box.append(message, row);
    root.append(style, box);
    document.documentElement.append(host);
  }

  // ------------------------------------------------------------------ plumbing

  function configure(settings) {
    cfg = core.normaliseSettings(settings);
    active = core.isActive(cfg);
  }

  function pause(next) {
    paused = Boolean(next);
    reevaluate();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) discover(node);
  });

  function shutDown() {
    dead = true;
    observer.disconnect();
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || sender.id !== ext.runtime.id) return false;
    if (msg.type === 'jevvit:stats') {
      sendResponse(snapshot());
    } else if (msg.type === 'jevvit:pause') {
      pause(msg.paused);
      sendResponse(snapshot());
    }
    return false;
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || dead) return;
    configure(changes.settings.newValue);
    reevaluate();
  });

  // Watch from the very first node, so posts parsed before the settings arrive are not missed.
  observer.observe(document, { childList: true, subtree: true });

  ext.storage.local
    .get('settings')
    .then(({ settings }) => {
      configure(settings);
      ready = true;
      if (document.documentElement) discover(document.documentElement);
      for (const rec of records) {
        if (active && !paused && cfg.holdUntilJudged && !rec.target.hasAttribute('data-jevvit')) hold(rec);
        queue.add(rec);
      }
      scheduleDrain(0);
    })
    .catch((err) => console.debug('[jevvit] could not read settings', err));
})();
