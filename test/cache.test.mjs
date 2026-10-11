import test from 'node:test';
import assert from 'node:assert/strict';
import cacheLib from '../src/lib/cache.js';

/** Just enough of storage.local for the cache: get(key|keys|null), set, remove. */
function fakeArea(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys) {
      if (keys === null) return Object.fromEntries(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

function setup(opts = {}) {
  const area = fakeArea({ settings: { prompt: 'keep me' }, apiKey: 'not-a-cache-entry' });
  const clock = { t: 1_000_000 };
  const cache = cacheLib.createCache({ area, now: () => clock.t, ...opts });
  return { area, clock, cache };
}

test('set then get returns the verdict; a miss returns null', async () => {
  const { cache } = setup();
  assert.equal(await cache.get('abc'), null);
  await cache.set('abc', { p: 0.25, model: 'jev-1.13.0' });
  assert.deepEqual(await cache.get('abc'), { p: 0.25, model: 'jev-1.13.0' });
});

test('entries expire after the TTL', async () => {
  const { cache, clock } = setup({ ttlMs: 10 * DAY });
  await cache.set('k', { p: 0.5, model: '' });
  clock.t += 9 * DAY;
  assert.notEqual(await cache.get('k'), null);
  clock.t += 2 * DAY;
  assert.equal(await cache.get('k'), null);
});

test('prune drops expired entries first, then the oldest beyond the cap, and leaves other keys alone', async () => {
  const { cache, clock, area } = setup({ ttlMs: 10 * DAY, maxEntries: 3 });
  await cache.set('old', { p: 0.1 });
  clock.t += 8 * DAY;
  for (const k of ['a', 'b', 'c', 'd']) {
    clock.t += 1000;
    await cache.set(k, { p: 0.2 });
  }
  clock.t += 3 * DAY; // 'old' is now past its TTL; a-d are still fresh
  const removed = await cache.prune();
  assert.equal(removed, 2); // 'old' (expired) + 'a' (oldest over the cap of 3)
  assert.equal(await cache.get('old'), null);
  assert.equal(await cache.get('a'), null);
  for (const k of ['b', 'c', 'd']) assert.notEqual(await cache.get(k), null, k);
  assert.deepEqual(area.data.get('settings'), { prompt: 'keep me' });
  assert.equal(area.data.get('apiKey'), 'not-a-cache-entry');
});

test('maybePrune is a cheap no-op until it is due', async () => {
  const { cache, clock, area } = setup({ maxEntries: 1, pruneEveryMs: 6 * 60 * 60 * 1000 });
  await cache.prune(); // records lastPrune
  await cache.set('a', { p: 0.1 });
  clock.t += 1000;
  await cache.set('b', { p: 0.2 });
  assert.equal(await cache.maybePrune(), 0, 'not due yet');
  assert.equal(await cache.count(), 2);
  clock.t += 7 * 60 * 60 * 1000;
  assert.equal(await cache.maybePrune(), 1, 'due now');
  assert.equal(await cache.count(), 1);
  assert.ok(area.data.has('cacheMeta'));
});

test('clear removes only cache entries', async () => {
  const { cache, area } = setup();
  await cache.set('a', { p: 0.1 });
  await cache.set('b', { p: 0.2 });
  assert.equal(await cache.clear(), 2);
  assert.equal(await cache.count(), 0);
  assert.ok(area.data.has('settings'));
  assert.ok(area.data.has('apiKey'));
});

test('a malformed stored entry is a miss, not a crash', async () => {
  const { cache, area } = setup();
  await area.set({ 'v1:weird': 'a string' });
  await area.set({ 'v1:alsoweird': { p: 'high', t: 1 } });
  assert.equal(await cache.get('weird'), null);
  assert.equal(await cache.get('alsoweird'), null);
});
