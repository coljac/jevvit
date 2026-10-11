/*
 * Jevvit background. The only code that holds the API key or talks to Jev.
 *
 * It runs as a Chrome service worker and as a Firefox event page. Both are
 * stopped after a short idle and restarted on the next message, so nothing
 * here may depend on memory surviving: verdicts and settings live in
 * storage, and the few maps below are only an optimisation within one wake.
 */
'use strict';

// Chrome gives a service worker no script list of its own; Firefox lists the same files in
// the manifest and has no importScripts.
if (typeof importScripts === 'function') importScripts('lib/core.js', 'lib/client.js', 'lib/cache.js');

const ext = globalThis.browser ?? globalThis.chrome;
const { core, client, cache: cacheLib } = globalThis.Jevvit;
const { JevError } = client;

const MAX_IN_FLIGHT = 6; // TypeSafe allows 80 requests a second; a feed page needs a handful at once
const AUTH_BLOCK_MS = 30_000;

const cache = cacheLib.createCache({ area: ext.storage.local });
const inFlight = new Map(); // request hash -> promise, so identical posts share one call
let authBlock = null; // after a 401, stop hammering the API with the same bad key

const pool = client.createPool(MAX_IN_FLIGHT);

async function loadConfig() {
  const { settings, apiKey } = await ext.storage.local.get(['settings', 'apiKey']);
  return {
    settings: core.normaliseSettings(settings),
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
  };
}

async function hasHostAccess(baseUrl) {
  const checked = core.validateBaseUrl(baseUrl);
  if (!checked.ok) return false;
  try {
    return await ext.permissions.contains({ origins: [checked.pattern] });
  } catch {
    return false;
  }
}

/** Turn a bare network failure into something actionable when the real cause is a missing permission. */
async function refineError(err, settings) {
  if (err instanceof JevError && err.kind === 'network' && !(await hasHostAccess(settings.baseUrl))) {
    const origin = core.validateBaseUrl(settings.baseUrl).origin || settings.baseUrl;
    return new JevError('perm', `Jevvit has not been given access to ${origin}. Open the settings and choose "Grant access".`);
  }
  return err;
}

/** The message from a content script is data about a web page, so rebuild it rather than trust it. */
function cleanState(raw) {
  if (!raw || typeof raw !== 'object') throw new JevError('request', 'No post to judge.');
  const state = {};
  for (const [key, max] of [
    ['subreddit', 60],
    ['title', core.LIMITS.title],
    ['flair', core.LIMITS.flair],
    ['link_domain', 100],
    ['post_type', 30],
    ['text', core.LIMITS.body],
  ]) {
    if (typeof raw[key] === 'string' && raw[key]) state[key] = raw[key].slice(0, max);
  }
  if (raw.nsfw === true) state.nsfw = true;
  if (!state.title) throw new JevError('request', 'The post has no title.');
  return state;
}

async function judgePost({ state, settings, apiKey, fresh }) {
  if (!core.isActive(settings)) throw new JevError('request', 'Write a prompt in the Jevvit settings first.');
  const request = core.buildRequest(settings, state);
  if (JSON.stringify(request).length > core.LIMITS.request) throw new JevError('request', 'That post is too long to send.');

  const key = await core.hashRequest(request);
  if (!fresh) {
    const hit = await cache.get(key);
    if (hit) return { p: hit.p, model: hit.model, cached: true };
  }

  const fingerprint = `${settings.baseUrl}|${apiKey}`;
  const blocked = () => authBlock && authBlock.fingerprint === fingerprint && Date.now() < authBlock.until;
  if (blocked()) throw authBlock.error;

  const shared = !fresh && inFlight.get(key);
  if (shared) return shared;

  const call = pool
    .run(async () => {
      // Requests queued behind the limit when a 401 came back must not go out with the same bad key.
      if (blocked()) throw authBlock.error;
      try {
        return await client.judge({ fetchImpl: fetch.bind(globalThis), baseUrl: settings.baseUrl, apiKey, request });
      } catch (err) {
        // Armed here, before the slot is freed, so the next queued request already sees it.
        if (err instanceof JevError && err.kind === 'auth') authBlock = { fingerprint, until: Date.now() + AUTH_BLOCK_MS, error: err };
        throw err;
      }
    })
    .then(async (answer) => {
      await cache.set(key, { p: answer.p, model: answer.model });
      cache.maybePrune().catch(() => {});
      return { p: answer.p, model: answer.model, cached: false, inputTokens: answer.inputTokens };
    })
    .catch(async (err) => {
      throw await refineError(err, settings);
    })
    .finally(() => {
      if (inFlight.get(key) === call) inFlight.delete(key);
    });
  if (!fresh) inFlight.set(key, call);
  return call;
}

/** Extension pages (options, popup) may test unsaved settings; a web page's content script may not. */
function isExtensionPage(sender) {
  return typeof sender.url === 'string' && sender.url.startsWith(ext.runtime.getURL(''));
}

async function handleJudge(msg, sender) {
  const trusted = isExtensionPage(sender);
  let config;
  if (trusted && msg.override && typeof msg.override === 'object') {
    config = {
      settings: core.normaliseSettings(msg.override.settings),
      apiKey: typeof msg.override.apiKey === 'string' ? msg.override.apiKey.trim() : '',
    };
  } else {
    config = await loadConfig();
  }
  return judgePost({ state: cleanState(msg.state), ...config, fresh: trusted && msg.fresh === true });
}

function setBadge(sender, hidden) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !ext.action) return;
  const count = Math.max(0, Math.min(9999, Number(hidden) | 0));
  const swallow = (p) => p && typeof p.catch === 'function' && p.catch(() => {});
  swallow(ext.action.setBadgeText({ tabId, text: count ? String(count) : '' }));
  swallow(ext.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }));
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || sender.id !== ext.runtime.id) return false;

  if (msg.type === 'judge') {
    handleJudge(msg, sender).then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: client.serialiseError(err) }),
    );
    return true; // the answer comes later
  }
  if (msg.type === 'badge') {
    setBadge(sender, msg.hidden);
    return false;
  }
  if (msg.type === 'openOptions') {
    ext.runtime.openOptionsPage();
    return false;
  }
  return false;
});

ext.runtime.onInstalled.addListener(async ({ reason, temporary }) => {
  if (reason !== 'install') return;
  // Firefox installs a temporary add-on afresh every time it starts (that's how `just run` loads Jevvit), keeping
  // its storage: there, only open the settings while there is still something to set up. A real install starts
  // empty, so it opens them straight away.
  if (temporary) {
    const { settings, apiKey } = await loadConfig();
    if (apiKey && settings.prompt) return;
  }
  ext.runtime.openOptionsPage();
});

cache.maybePrune().catch(() => {});
