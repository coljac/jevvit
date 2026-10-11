import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import core from '../src/lib/core.js';
import client from '../src/lib/client.js';

const { JevError } = client;
const SECRET = 'sk-test-SECRET-do-not-leak';
const okBody = JSON.parse(readFileSync(new URL('./fixtures/sdk-response.json', import.meta.url), 'utf8'));
const request = core.buildRequest(core.normaliseSettings({ prompt: 'Is this about cats?' }), { title: 'Cats' });

/** A fake fetch that plays back a script of responses/throws, recording what it was asked. */
function scripted(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(init);
    const { status = 200, body = okBody, headers = {} } = step;
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(raw, { status, headers });
  };
  return { fetchImpl, calls };
}

const run = (steps, extra = {}) => {
  const sleeps = [];
  const s = scripted(steps);
  const promise = client.judge({
    fetchImpl: s.fetchImpl,
    baseUrl: 'https://api.typesafe.ai',
    apiKey: SECRET,
    request,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1,
    ...extra,
  });
  return { promise, calls: s.calls, sleeps };
};

test('a good answer: right URL, method, headers and body; nothing sensitive besides the bearer token', async () => {
  const { promise, calls } = run([{}]);
  assert.deepEqual(await promise, { p: 0.9132, model: 'jev-1.13.0', inputTokens: 61 });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(init.body), request);
  assert.equal(init.body.includes(SECRET), false);
});

test('no key: fails before any request is made', async () => {
  const { promise, calls } = run([{}], { apiKey: '' });
  await assert.rejects(promise, (e) => e instanceof JevError && e.kind === 'nokey');
  assert.equal(calls.length, 0);
});

test('401 and 403: reported as an auth problem and not retried', async () => {
  for (const status of [401, 403]) {
    const { promise, calls } = run([{ status, body: { error: 'bad key' } }]);
    await assert.rejects(promise, (e) => e.kind === 'auth' && e.status === status && !e.message.includes(SECRET));
    assert.equal(calls.length, 1);
  }
});

test('422 validation errors are not retried, and the server\'s reason is surfaced', async () => {
  const body = { detail: [{ loc: ['body', 'questions', 'match', 'instructions'], msg: 'Field required', type: 'missing' }] };
  const { promise, calls } = run([{ status: 422, body }]);
  await assert.rejects(promise, (e) => e.kind === 'request' && /questions\.match\.instructions: Field required/.test(e.message));
  assert.equal(calls.length, 1);
});

test('429 honours retry-after (seconds) and then succeeds', async () => {
  const { promise, calls, sleeps } = run([{ status: 429, body: {}, headers: { 'retry-after': '2' } }, {}]);
  assert.equal((await promise).p, 0.9132);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('429 prefers retry-after-ms, and never waits longer than the cap', async () => {
  const a = run([{ status: 429, body: {}, headers: { 'retry-after-ms': '250', 'retry-after': '9' } }, {}]);
  await a.promise;
  assert.deepEqual(a.sleeps, [250]);

  const b = run([{ status: 429, body: {}, headers: { 'retry-after': '600' } }, {}]);
  await b.promise;
  assert.deepEqual(b.sleeps, [10000]);
});

test('without retry-after, backoff grows and stops after maxRetries', async () => {
  const { promise, calls, sleeps } = run([{ status: 503, body: 'down' }]);
  await assert.rejects(promise, (e) => e.kind === 'server' && e.status === 503);
  assert.equal(calls.length, 4); // first try + 3 retries
  assert.deepEqual(sleeps, [400, 800, 1600]); // random() = 1 -> full delay
});

test('dropped connections are retried, then reported as a network problem', async () => {
  const flaky = run([new TypeError('NetworkError when attempting to fetch resource.'), {}]);
  assert.equal((await flaky.promise).p, 0.9132);
  assert.equal(flaky.calls.length, 2);

  const down = run([new TypeError('Failed to fetch')], { maxRetries: 1 });
  await assert.rejects(down.promise, (e) => e.kind === 'network');
  assert.equal(down.calls.length, 2);
});

test('a request that never answers is aborted at the timeout', async () => {
  const hang = (init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const { promise } = run([hang], { timeoutMs: 20, maxRetries: 0 });
  await assert.rejects(promise, (e) => e.kind === 'network' && /in time/.test(e.message));
});

test('garbage back from the server is a response error, not a crash', async () => {
  for (const body of ['<html>nope</html>', '', '[]', { answers: {} }, { answers: { match: { type: 'choice', choice: 'x' } } }]) {
    const { promise } = run([{ body }], { maxRetries: 0 });
    await assert.rejects(promise, (e) => e instanceof JevError && e.kind === 'response', JSON.stringify(body));
  }
});

test('no error message ever contains the API key', async () => {
  const cases = [
    { status: 401, body: { error: `key ${SECRET} is invalid` } }, // even if a server were to echo it back
    { status: 500, body: 'oops' },
    { status: 400, body: { message: 'bad' } },
  ];
  for (const c of cases) {
    const { promise } = run([c], { maxRetries: 0 });
    await assert.rejects(promise, (e) => {
      // A 401's server message is deliberately not repeated at all.
      return !e.message.includes(SECRET);
    });
  }
});

test('serialiseError keeps only what the UI needs', () => {
  const e = new JevError('auth', 'nope', { status: 401, retryAfterMs: 5 });
  assert.deepEqual(client.serialiseError(e), { kind: 'auth', message: 'nope', status: 401 });
  assert.equal(client.serialiseError(new Error('boom')).kind, 'network');
});

test('parseRetryAfter understands seconds, milliseconds and HTTP dates', () => {
  const h = (o) => new Headers(o);
  const now = () => Date.parse('2026-10-10T00:00:00Z');
  assert.equal(client.parseRetryAfter(h({ 'retry-after': '3' }), now), 3000);
  assert.equal(client.parseRetryAfter(h({ 'retry-after-ms': '120' }), now), 120);
  assert.equal(client.parseRetryAfter(h({ 'retry-after': 'Sat, 10 Oct 2026 00:00:05 GMT' }), now), 5000);
  assert.equal(client.parseRetryAfter(h({ 'retry-after': 'Sat, 10 Oct 2026 00:00:00 GMT' }), () => now() + 9999), 0);
  assert.equal(client.parseRetryAfter(h({ 'retry-after': '-1' }), now), null);
  assert.equal(client.parseRetryAfter(h({}), now), null);
});

test('createPool never runs more than the limit at once, and runs everything', async () => {
  const pool = client.createPool(3);
  let active = 0;
  let peak = 0;
  const task = (n) => async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n;
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.run(task(i))));
  assert.deepEqual(results, [...Array(12).keys()]);
  assert.equal(peak, 3);
  assert.equal(pool.active, 0);
  assert.equal(pool.queued, 0);
});

test('createPool: a task that throws, even synchronously, frees its slot and never stalls the queue', async () => {
  const pool = client.createPool(2);
  const outcomes = await Promise.allSettled([
    pool.run(() => {
      throw new Error('sync boom'); // not an async function: this used to leak the slot
    }),
    pool.run(async () => {
      throw new Error('async boom');
    }),
    pool.run(() => 'fine'),
    pool.run(() => {
      throw new Error('another sync boom');
    }),
    pool.run(async () => 'also fine'),
    pool.run(() => 'and one more'),
  ]);
  assert.deepEqual(
    outcomes.map((o) => (o.status === 'fulfilled' ? o.value : o.reason.message)),
    ['sync boom', 'async boom', 'fine', 'another sync boom', 'also fine', 'and one more'],
  );
  assert.equal(pool.active, 0);
  assert.equal(pool.queued, 0);
});

test('createPool starts waiting tasks in the order they were queued', async () => {
  const pool = client.createPool(1);
  const order = [];
  await Promise.all([1, 2, 3, 4].map((n) => pool.run(async () => void order.push(n))));
  assert.deepEqual(order, [1, 2, 3, 4]);
});
