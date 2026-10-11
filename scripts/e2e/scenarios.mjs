// End-to-end scenarios, written once against the small driver interface in cdp.mjs / marionette.mjs:
//   open(url) goto(tab,url) eval(tab,fn,...args) click(tab,selector) waitFor(tab,fn,args,opts)
//   screenshot(tab,file) close(tab), plus name, extensionBase and openedSettingsOnInstall
// Each one configures the extension the way a person would (through the options page), then looks at what
// happened to a pretend Reddit and at what the mock Jev API was actually asked.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { POSTS } from './site.mjs';

const KEY = 'test-key-not-real';
const PROMPT = 'Is this post about "cat" or "dog"?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- helpers that run inside pages (they are serialised, so they must not close over anything) ----------------

const pageSnapshotNew = () =>
  [...document.querySelectorAll('shreddit-post')].map((p) => {
    const t = p.closest('article') || p;
    const cs = getComputedStyle(t);
    const next = t.nextElementSibling;
    return {
      id: p.id.replace('t3_', ''),
      state: t.getAttribute('data-jevvit'),
      visible: t.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      opacity: Number(cs.opacity),
      stub: Boolean(t.querySelector(':scope > .jevvit-stub')),
      stubText: (t.querySelector(':scope > .jevvit-stub') || {}).textContent || '',
      postShown: getComputedStyle(p).display !== 'none',
      sepHidden: Boolean(next && next.tagName === 'HR' && next.getAttribute('data-jevvit-sep') === 'hidden'),
    };
  });

const pageSnapshotOld = () =>
  [...document.querySelectorAll('div.thing.link')].map((t) => {
    const cs = getComputedStyle(t);
    return {
      id: t.dataset.fullname.replace('t3_', ''),
      state: t.getAttribute('data-jevvit'),
      visible: t.getClientRects().length > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
      stub: Boolean(t.querySelector(':scope > .jevvit-stub')),
      entryShown: getComputedStyle(t.querySelector('.entry')).display !== 'none',
    };
  });

const pageNoHold = (selector) => {
  const els = [...document.querySelectorAll(selector)];
  return els.length > 0 && els.every((e) => e.closest('[data-jevvit]')?.getAttribute('data-jevvit') !== 'hold') && els.some((e) => e.closest('[data-jevvit]'));
};

// ---- small test kit --------------------------------------------------------------------------------------------

export function createKit(log) {
  const results = [];
  const kit = {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail });
      log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n       ${String(detail).split('\n').join('\n       ')}` : ''}`);
      return Boolean(ok);
    },
    equal(name, actual, expected) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      return kit.check(name, a === e, `expected ${e}\n  actual ${a}`);
    },
  };
  return kit;
}

const FULL = {
  fields: {
    apiKey: KEY,
    model: 'jev-latest',
    prompt: PROMPT,
    trueCriteria: '',
    falseCriteria: '',
    hideAt: 70,
    unsureAt: 40,
    holdUntilJudged: true,
    includeBody: true,
    maxBodyChars: 600,
    enabled: true,
    exemptSubreddits: 'r/exempt_sub',
  },
  radios: { mode: 'hide', action: 'collapse' },
};

export async function runScenarios({ driver: d, api, site, outDir, log, only }) {
  const kit = createKit(log);
  mkdirSync(outDir, { recursive: true });
  const shot = (tab, name) => d.screenshot(tab, join(outDir, `${d.name}-${name}.png`)).catch(() => {});

  async function apiLog() {
    return (await fetch(`${api.url}/__log`)).json();
  }
  async function reset() {
    await fetch(`${api.url}/__reset`, { method: 'POST' });
  }

  /** Set the options through the real form. `over` overrides pieces of FULL; clearCache forgets verdicts first. */
  async function configure(over = {}, { clearCache = true } = {}) {
    const cfg = {
      fields: { ...FULL.fields, baseUrl: api.url, ...(over.fields || {}) },
      radios: { ...FULL.radios, ...(over.radios || {}) },
    };
    const tab = await d.open(`${d.extensionBase}/options/options.html`);
    await d.waitFor(tab, () => document.getElementById('cacheInfo').textContent.length > 0, [], { what: 'the options page to initialise' });
    if (clearCache) {
      await d.eval(tab, () => document.getElementById('clearCache').click());
      await d.waitFor(tab, () => /^Forgot/.test(document.getElementById('saved').textContent), [], { what: 'the cache to clear' });
    }
    await d.eval(tab, (cfg) => {
      for (const [id, v] of Object.entries(cfg.fields)) {
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = Boolean(v);
        else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      for (const [name, v] of Object.entries(cfg.radios)) document.querySelector(`input[name="${name}"][value="${v}"]`).click();
    }, cfg);
    await d.click(tab, '#save'); // a trusted click: Firefox only honours permissions.request from a real user action
    await d.waitFor(tab, () => /^Saved/.test(document.getElementById('saved').textContent), [], { what: 'the settings to save' });
    const outcome = await d.eval(tab, () => ({
      saved: document.getElementById('saved').textContent,
      baseUrlError: document.getElementById('baseUrlError').textContent,
    }));
    await d.close(tab);
    await reset();
    return outcome;
  }

  async function openFeed(path, { snapshot = pageSnapshotNew, selector = 'shreddit-post', settleCount } = {}) {
    const tab = await d.open(`${site.url}${path}`);
    await d.waitFor(tab, pageNoHold, [selector], { timeout: 20000, what: `${path} to settle (nothing left held)` });
    await sleep(250);
    return { tab, snap: () => d.eval(tab, snapshot) };
  }

  /** A fresh browser can be slow to start the add-on's storage: wait for it once, loudly, before any scenario. */
  async function warmUp() {
    const tab = await d.open(`${d.extensionBase}/options/options.html`);
    await d.waitFor(tab, () => document.getElementById('cacheInfo').textContent.length > 0, [], { timeout: 30000, what: 'the extension to start (first options page load)' });
    await d.close(tab);
    log('  extension is up');
  }
  await warmUp();

  const stateMap = (snap) => Object.fromEntries(snap.map((s) => [s.id, s.state]));
  const only_ = (name) => !only || only.some((o) => name.includes(o));

  // ------------------------------------------------------------------------------------------------------------

  if (only_('setup')) {
    log('\n[setup] the options page saves and remembers');
    kit.check('the settings page opened by itself on first install', d.openedSettingsOnInstall === true);
    const outcome = await configure();
    const tab = await d.open(`${d.extensionBase}/options/options.html`);
    await d.waitFor(tab, () => document.getElementById('cacheInfo').textContent.length > 0, [], { what: 'options init' });
    const form = await d.eval(tab, () => ({
      prompt: document.getElementById('prompt').value,
      baseUrl: document.getElementById('baseUrl').value,
      apiKeyType: document.getElementById('apiKey').type,
      apiKeyFilled: document.getElementById('apiKey').value.length > 0,
      mode: document.querySelector('input[name=mode]:checked').value,
      banner: document.getElementById('banner').hidden,
      accessHidden: document.getElementById('access').hidden,
      rule: document.getElementById('rule').textContent,
      baseUrlError: document.getElementById('baseUrlError').textContent,
      saved: document.getElementById('saved').textContent,
    }));
    kit.equal('prompt persisted', form.prompt, PROMPT);
    kit.check('API address persisted', form.baseUrl === api.url, `expected ${api.url}, got ${form.baseUrl}; the page said: "${outcome.saved}" / "${outcome.baseUrlError}"`);
    kit.check('API key persisted and masked', form.apiKeyFilled && form.apiKeyType === 'password');
    kit.check('no "set me up" banner once configured', form.banner === true);
    kit.check('no "grant access" prompt once access is held', form.accessHidden === true, 'the access box is showing');
    kit.check('the rule sentence reads sensibly', /When Jev is at least 70% sure a story matches your description, it is collapsed to one line\./.test(form.rule), form.rule);
    await shot(tab, 'options');
    await d.close(tab);
  }

  if (only_('feed')) {
    log('\n[feed] new Reddit: states, privacy of what is sent, and the API contract');
    await configure();
    const { tab, snap } = await openFeed('/r/test/');
    const s = await snap();
    await shot(tab, 'feed-collapsed');
    kit.equal('post count', s.length, POSTS.length);
    kit.equal('verdicts', stateMap(s), {
      aaa001: 'collapsed', aaa002: 'shown', aaa003: 'collapsed', aaa004: 'shown', aaa005: 'unsure', aaa006: 'shown',
      aaa007: null, aaa008: 'shown', aaa009: 'shown', aaa010: 'collapsed', aaa011: null,
    });
    const byId = Object.fromEntries(s.map((x) => [x.id, x]));
    kit.check('a collapsed post shows a one-line stub with its title and the percentage', byId.aaa001.stub && /My cat learned to open doors/.test(byId.aaa001.stubText) && /92%/.test(byId.aaa001.stubText), byId.aaa001.stubText);
    kit.check('the collapsed post itself is out of sight, its stub in view', byId.aaa001.visible && !byId.aaa001.postShown);
    kit.check('"unsure" posts are only dimmed', byId.aaa005.visible && byId.aaa005.opacity < 1 && byId.aaa005.opacity > 0.3, byId.aaa005.opacity);
    kit.check('an exempt subreddit is left alone even though it matches', byId.aaa007.state === null && byId.aaa007.visible && !byId.aaa007.stub);
    kit.check('a post that failed (500) is shown, not lost', byId.aaa011.visible && byId.aaa011.state === null);
    kit.check('nothing is left held back', s.every((x) => x.state !== 'hold'));

    const calls = await apiLog();
    const asked = calls.filter((c) => c.status === 200 || c.status === 429 || c.status === 500);
    kit.check('every request carried the API key as a bearer token', calls.every((c) => c.auth));
    kit.check('the key never appears in a request body', calls.every((c) => !c.bodyHasKey));
    kit.check('every request was JSON', calls.every((c) => c.contentType === 'application/json'));
    kit.check('the question is the prompt, as a noul, untouched', asked.every((c) => c.question && c.question.type === 'noul' && c.question.instructions === PROMPT));
    kit.check('the model is the configured one', asked.every((c) => c.model === 'jev-latest'));
    const states = asked.map((c) => c.state);
    kit.check('only text fields are sent: no author, score or counts', states.every((st) => Object.keys(st).every((k) => ['subreddit', 'title', 'flair', 'link_domain', 'post_type', 'text', 'nsfw'].includes(k))), JSON.stringify(states[0]));
    kit.check('the exempt subreddit was never sent anywhere', !states.some((st) => st.subreddit === 'r/exempt_sub'));
    const omelette = states.find((st) => /omelette/.test(st.title));
    kit.equal('a link post is sent as subreddit, title, flair, domain and type', omelette, { subreddit: 'r/food', title: 'Cooking: the perfect omelette', flair: 'Recipe', link_domain: 'example.com', post_type: 'link' });
    kit.check('a text post sends the start of its body', states.some((st) => st.post_type === 'text' && /kitten/.test(st.text || '')));
    kit.check('the 429 was retried and then succeeded', calls.filter((c) => /\[429\]/.test((c.state || {}).title || '')).map((c) => c.status).join() === '429,200', calls.filter((c) => /\[429\]/.test((c.state || {}).title || '')).map((c) => c.status).join());
    kit.check('the 500 was retried a few times then given up on', calls.filter((c) => /\[500\]/.test((c.state || {}).title || '')).length === 4);

    // second visit: everything answered from the cache, except the one that never succeeded
    await reset();
    await d.goto(tab, `${site.url}/r/test/`);
    await d.waitFor(tab, pageNoHold, ['shreddit-post'], { timeout: 20000, what: 'a revisit to settle' });
    await sleep(300);
    const again = await d.eval(tab, pageSnapshotNew);
    kit.equal('revisit gives the same verdicts', stateMap(again), stateMap(s));
    const second = await apiLog();
    kit.check('revisiting costs nothing: only the failed post is asked about again', second.every((c) => /\[500\]/.test((c.state || {}).title || '')), `${second.length} calls: ${second.map((c) => (c.state || {}).title).join(' | ')}`);

    // infinite scroll
    await reset();
    await d.eval(tab, () => document.getElementById('more').click());
    await d.waitFor(tab, () => document.querySelectorAll('shreddit-post').length === 14 && ![...document.querySelectorAll('[data-jevvit]')].some((e) => e.getAttribute('data-jevvit') === 'hold'), [], { what: 'late-arriving posts to be judged' });
    await sleep(200);
    const more = await d.eval(tab, pageSnapshotNew);
    kit.equal('posts added after load are judged too', [more.find((x) => x.id === 'bbb001').state, more.find((x) => x.id === 'bbb002').state, more.find((x) => x.id === 'bbb003').state], ['collapsed', 'shown', 'shown']);

    // reveal
    await d.eval(tab, () => document.querySelector('article[data-jevvit="collapsed"] > .jevvit-stub').click());
    const revealed = (await d.eval(tab, pageSnapshotNew)).find((x) => x.id === 'aaa001');
    kit.check('clicking the stub brings the story back', revealed.state === 'revealed' && revealed.postShown && !revealed.stub, JSON.stringify(revealed));
    await d.close(tab);
  }

  if (only_('comments')) {
    log('\n[comments] the page\'s own post is never filtered');
    await configure();
    const tab = await d.open(`${site.url}/r/aww/comments/aaa001/my_cat_learned_to_open_doors/`);
    await d.waitFor(tab, () => document.querySelector('#related article')?.getAttribute('data-jevvit') === 'collapsed', [], { timeout: 15000, what: 'the related post to be collapsed' });
    const mainPost = await d.eval(tab, () => {
      const t = document.querySelector('#the-post article');
      return { state: t.getAttribute('data-jevvit'), visible: t.getClientRects().length > 0 && getComputedStyle(t).visibility !== 'hidden' };
    });
    kit.check('the post you opened stays exactly as it was', mainPost.state === null && mainPost.visible, JSON.stringify(mainPost));
    const related = await d.eval(tab, () => {
      const t = document.querySelector('#related article');
      return { state: t.getAttribute('data-jevvit'), stub: Boolean(t.querySelector(':scope > .jevvit-stub')) };
    });
    kit.check('a related post on the same page is still filtered', related.state === 'collapsed' && related.stub, JSON.stringify(related));
    kit.check('the page\'s own post was never sent to Jev', (await apiLog()).every((c) => !/open doors/.test((c.state || {}).title || '')));
    await shot(tab, 'comments');
    await d.close(tab);
  }

  if (only_('live')) {
    log('\n[live] changing settings re-applies at once, without asking Jev again');
    await configure();
    const { tab, snap } = await openFeed('/r/test/');
    await reset();
    await configure({ radios: { mode: 'keep' } }, { clearCache: false });
    await d.waitFor(tab, () => document.querySelector('shreddit-post#t3_aaa002')?.closest('article')?.getAttribute('data-jevvit') === 'collapsed', [], { what: 'the open page to flip to "keep" mode' });
    await sleep(250);
    const s = await snap();
    kit.equal('keep mode: matches stay, the rest collapse', stateMap(s), {
      aaa001: 'shown', aaa002: 'collapsed', aaa003: 'shown', aaa004: 'collapsed', aaa005: 'unsure', aaa006: 'collapsed',
      aaa007: null, aaa008: 'collapsed', aaa009: 'collapsed', aaa010: 'shown', aaa011: null,
    });
    kit.equal('no new API calls: the verdicts were already known', (await apiLog()).filter((c) => !/\[500\]/.test((c.state || {}).title || '')).length, 0);
    await shot(tab, 'feed-keep-mode');

    await configure({ radios: { mode: 'hide', action: 'hide' } }, { clearCache: false });
    await d.waitFor(tab, () => document.querySelector('shreddit-post#t3_aaa001')?.closest('article')?.getAttribute('data-jevvit') === 'hidden', [], { what: 'the page to switch to hiding' });
    const hidden = await snap();
    const h1 = hidden.find((x) => x.id === 'aaa001');
    kit.check('hide: the story and its divider are gone', h1.state === 'hidden' && !h1.visible && h1.sepHidden, JSON.stringify(h1));
    kit.check('hide: other stories untouched', hidden.find((x) => x.id === 'aaa002').visible);
    await shot(tab, 'feed-hidden');

    await configure({ radios: { mode: 'hide', action: 'dim' } }, { clearCache: false });
    await d.waitFor(tab, () => document.querySelector('shreddit-post#t3_aaa001')?.closest('article')?.getAttribute('data-jevvit') === 'dimmed', [], { what: 'the page to switch to dimming' });
    const dimmed = (await snap()).find((x) => x.id === 'aaa001');
    kit.check('dim: faded but still there, and the divider is back', dimmed.visible && dimmed.opacity < 0.3 && !dimmed.sepHidden, JSON.stringify(dimmed));
    await shot(tab, 'feed-dimmed');

    await configure({ fields: { enabled: false } }, { clearCache: false });
    await d.waitFor(tab, () => ![...document.querySelectorAll('[data-jevvit]')].length, [], { what: 'the page to be restored when switched off' });
    const off = await snap();
    kit.check('switched off: the page is exactly as Reddit rendered it', off.every((x) => x.state === null && x.visible && !x.stub && !x.sepHidden));
    await d.close(tab);
  }

  if (only_('body')) {
    log('\n[body] leaving the body text out');
    await configure({ fields: { includeBody: false } });
    const { tab, snap } = await openFeed('/r/test/');
    const s = await snap();
    kit.equal('without the body, the kitten post is no longer a match', stateMap(s).aaa010, 'shown');
    kit.check('and no request carried body text', (await apiLog()).every((c) => !(c.state && 'text' in c.state)));
    await d.close(tab);
  }

  if (only_('old')) {
    log('\n[old] old Reddit');
    await configure();
    const { tab, snap } = await openFeed('/old/r/test/', { snapshot: pageSnapshotOld, selector: 'div.thing.link:not(.promoted)' });
    const s = await snap();
    await shot(tab, 'old-reddit');
    const m = stateMap(s);
    kit.equal('old Reddit verdicts', [m.aaa001, m.aaa002, m.aaa003, m.aaa005, m.aaa007, m.aaa010], ['collapsed', 'shown', 'collapsed', 'unsure', null, 'shown']);
    kit.check('the promoted post is left alone', m.ad001 === null && s.find((x) => x.id === 'ad001').visible);
    const first = s.find((x) => x.id === 'aaa001');
    kit.check('a collapsed old-Reddit story is one line with a stub', first.visible && first.stub && !first.entryShown, JSON.stringify(first));
    kit.check('old Reddit has no body text, so the kitten post is judged on its title alone', m.aaa010 === 'shown', m.aaa010);
    kit.check('the promoted post was never sent to Jev', (await apiLog()).every((c) => !/promoted/.test((c.state || {}).title || '')));
    await d.close(tab);
  }

  if (only_('badkey')) {
    log('\n[badkey] a rejected key leaves the page alone and says why');
    await configure({ fields: { apiKey: 'not-the-key' } });
    const tab = await d.open(`${site.url}/r/test/`);
    await d.waitFor(tab, () => [...document.documentElement.children].some((e) => /2147483647/.test(e.getAttribute('style') || '')), [], { timeout: 15000, what: 'the "key rejected" notice' });
    await sleep(500);
    const s = await d.eval(tab, pageSnapshotNew);
    kit.check('every story is visible and unmarked', s.every((x) => x.visible && x.state === null && !x.stub), JSON.stringify(s.filter((x) => x.state !== null || !x.visible)));
    const calls = await apiLog();
    kit.check('Jevvit stopped asking after the first rejections', calls.length > 0 && calls.length <= 6, `${calls.length} calls`);
    kit.check('all of those were rejected', calls.every((c) => c.status === 401));
    await shot(tab, 'bad-key');
    await d.close(tab);
  }

  if (only_('tryit')) {
    log('\n[tryit] the options page can judge one story before saving');
    await configure();
    const tab = await d.open(`${d.extensionBase}/options/options.html`);
    await d.waitFor(tab, () => document.getElementById('cacheInfo').textContent.length > 0, [], { what: 'options init' });
    await d.eval(tab, () => {
      document.getElementById('tryTitle').value = 'Why my cat hates Mondays';
      document.getElementById('trySubreddit').value = 'r/aww';
      document.getElementById('tryButton').click();
    });
    await d.waitFor(tab, () => /Jev says/.test(document.getElementById('tryResult').textContent), [], { what: 'the answer' });
    const text = await d.eval(tab, () => document.getElementById('tryResult').textContent);
    kit.check('shows the probability and what would happen', /92% likely to match, so it would be collapsed to one line/.test(text), text);
    await d.eval(tab, () => {
      document.getElementById('tryTitle').value = 'Volcano facts';
      document.getElementById('tryButton').click();
    });
    await d.waitFor(tab, () => /5% likely/.test(document.getElementById('tryResult').textContent), [], { what: 'the second answer' });
    kit.check('a non-match is shown as such', /shown as normal/.test(await d.eval(tab, () => document.getElementById('tryResult').textContent)));

    await d.eval(tab, () => {
      const key = document.getElementById('apiKey');
      key.value = 'wrong';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('tryButton').click();
    });
    await d.waitFor(tab, () => /rejected the API key/.test(document.getElementById('tryResult').textContent), [], { what: 'the rejection' });
    kit.check('a bad key is reported in plain words', true);
    await d.goto(tab, `${d.extensionBase}/options/options.html`);
    await d.waitFor(tab, () => document.getElementById('cacheInfo').textContent.length > 0, [], { what: 'options reload' });
    kit.check('and trying it did not overwrite the saved key', (await d.eval(tab, () => document.getElementById('apiKey').value)) === KEY);
    await d.close(tab);
  }

  if (only_('popup')) {
    log('\n[popup] the toolbar popup renders');
    await configure();
    const tab = await d.open(`${d.extensionBase}/popup/popup.html`);
    await d.waitFor(tab, () => document.getElementById('status').textContent.length > 0, [], { what: 'popup status' });
    const p = await d.eval(tab, () => ({ status: document.getElementById('status').textContent, enabled: document.getElementById('enabled').checked, stats: document.getElementById('stats').hidden, pause: document.getElementById('pause').hidden }));
    kit.check('says what to do next when no Reddit tab is in front', /Open a Reddit page/.test(p.status), p.status);
    kit.check('the switch reflects the setting, and no stats show without a page', p.enabled && p.stats && p.pause);
    await shot(tab, 'popup');
    await d.close(tab);
  }

  return kit.results;
}
