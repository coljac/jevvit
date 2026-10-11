/*
 * A small verdict cache on top of an extension storage area (storage.local).
 *
 * One storage key per verdict, so a write is cheap and nothing is held in
 * memory: the Chrome service worker and the Firefox event page are both
 * killed after a short idle and must be able to start again from storage
 * alone. Keys are hashes of (model, question, post text), so an edited prompt
 * can never be served a stale verdict.
 */
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else (root.Jevvit = root.Jevvit || {}).cache = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFIX = 'v1:';
  const META_KEY = 'cacheMeta';
  const DAY = 24 * 60 * 60 * 1000;

  /**
   * `area` is anything with get(keys) / set(obj) / remove(keys) returning
   * promises. That is storage.local in the browser and a Map-backed fake in tests.
   */
  function createCache({ area, now = Date.now, maxEntries = 4000, ttlMs = 30 * DAY, pruneEveryMs = 6 * 60 * 60 * 1000 }) {
    let writesSinceCheck = 0;

    async function get(key) {
      const stored = (await area.get(PREFIX + key))[PREFIX + key];
      if (!stored || typeof stored.p !== 'number') return null;
      if (now() - stored.t > ttlMs) return null;
      return { p: stored.p, model: stored.m || '' };
    }

    async function set(key, { p, model }) {
      await area.set({ [PREFIX + key]: { p, m: model || '', t: now() } });
      writesSinceCheck++;
    }

    /** Drop expired entries, then the oldest ones beyond maxEntries. Returns how many went. */
    async function prune() {
      const everything = await area.get(null);
      const entries = Object.entries(everything)
        .filter(([k, v]) => k.startsWith(PREFIX) && v && typeof v.t === 'number')
        .map(([k, v]) => ({ k, t: v.t }));
      const cutoff = now() - ttlMs;
      const doomed = entries.filter((e) => e.t < cutoff).map((e) => e.k);
      const fresh = entries.filter((e) => e.t >= cutoff).sort((a, b) => b.t - a.t);
      for (const e of fresh.slice(maxEntries)) doomed.push(e.k);
      if (doomed.length) await area.remove(doomed);
      await area.set({ [META_KEY]: { lastPrune: now() } });
      writesSinceCheck = 0;
      return doomed.length;
    }

    /** Cheap to call often: only does work when it is due. */
    async function maybePrune() {
      if (writesSinceCheck < 400) {
        const meta = (await area.get(META_KEY))[META_KEY];
        if (meta && now() - meta.lastPrune < pruneEveryMs) return 0;
      }
      return prune();
    }

    async function count() {
      const everything = await area.get(null);
      return Object.keys(everything).filter((k) => k.startsWith(PREFIX)).length;
    }

    async function clear() {
      const everything = await area.get(null);
      const keys = Object.keys(everything).filter((k) => k.startsWith(PREFIX));
      if (keys.length) await area.remove(keys);
      return keys.length;
    }

    return { get, set, prune, maybePrune, count, clear };
  }

  return { createCache, PREFIX };
});
