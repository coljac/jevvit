// A stand-in for the Jev API, and a pretend Reddit, so the extension can be exercised without a key or a spend.
//
//   node scripts/mock-jev.mjs        API on :8787, fake Reddit on :8788 (override with MOCK_API_PORT / MOCK_SITE_PORT)
//
// Then in the extension's settings use API address http://127.0.0.1:8787, any key matching MOCK_KEY (default
// "test-key-not-real"), and a prompt with quoted keywords, such as:  Is this post about "cat" or "dog"?
//
// Scoring is deliberately dumb and predictable:
//   a quoted keyword from the question appears in the post   -> 0.92
//   the post contains "[maybe]"                              -> 0.55
//   otherwise                                                -> 0.05
// Titles containing [429] get one 429 (retry-after-ms) before succeeding, [500] always fail, [slow] take 700ms,
// [garbage] answer 200 with nonsense.
//
// Like the real API, it sends no CORS headers to an unknown origin: the extension has to get its access from
// host permissions, and the tests would notice if it didn't.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { POSTS, newFeedPage, oldFeedPage, commentsPage } from './e2e/site.mjs';

const MAX_BODY = 200_000;

export function score(question, state) {
  const instructions = typeof question.instructions === 'string' ? question.instructions : JSON.stringify(question.instructions);
  const keywords = [...instructions.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const haystack = JSON.stringify(state).toLowerCase();
  if (keywords.some((k) => haystack.includes(k))) return 0.92;
  if (haystack.includes('[maybe]')) return 0.55;
  return 0.05;
}

export function startApi({ port = 0, key = 'test-key-not-real' } = {}) {
  const log = [];
  const seen429 = new Set();

  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/__log') return send(200, log);
    if (req.method === 'POST' && url.pathname === '/__reset') {
      log.length = 0;
      seen429.clear();
      return send(200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(200, { models: [{ name: 'jev-latest', description: 'mock', release_date: '2026-09-15' }] });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/systemone') {
      // Including CORS preflights: a real API answers an unknown extension origin without allow-origin.
      return send(req.method === 'OPTIONS' ? 400 : 404, { error: 'not found' });
    }

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(413, { error: 'too large' });
    }
    const entry = { at: Date.now(), auth: req.headers.authorization === `Bearer ${key}`, contentType: req.headers['content-type'], bodyHasKey: raw.includes(key) };
    log.push(entry);

    if (!entry.auth) {
      entry.status = 401;
      return send(401, { error: 'Invalid API key' });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      entry.status = 422;
      return send(422, { detail: [{ loc: ['body'], msg: 'JSON decode error', type: 'json_invalid' }] });
    }
    const question = body.questions && body.questions.match;
    if (body.state === undefined || typeof body.model !== 'string' || !question || question.type !== 'noul') {
      entry.status = 422;
      return send(422, { detail: [{ loc: ['body', 'questions'], msg: 'Field required', type: 'missing' }] });
    }
    Object.assign(entry, { model: body.model, state: body.state, question });

    const title = String((body.state && body.state.title) || '');
    if (title.includes('[500]')) {
      entry.status = 500;
      return send(500, { error: 'mock server error' });
    }
    if (title.includes('[429]') && !seen429.has(title)) {
      seen429.add(title);
      entry.status = 429;
      return send(429, { error: 'slow down' }, { 'retry-after-ms': '80' });
    }
    if (title.includes('[slow]')) await new Promise((r) => setTimeout(r, 700));
    if (title.includes('[garbage]')) {
      entry.status = 200;
      return send(200, '<html>not json</html>');
    }

    const p = score(question, body.state);
    entry.status = 200;
    entry.p = p;
    return send(200, {
      model: 'jev-1.13.0',
      usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 4 },
      answers: { match: { type: 'noul', noul: p } },
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ url: `http://127.0.0.1:${actual}`, key, log, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

export function startSite({ port = 0 } = {}) {
  const pages = {
    '/r/test/': () => newFeedPage(),
    '/old/r/test/': () => oldFeedPage(),
    '/r/aww/comments/aaa001/my_cat_learned_to_open_doors/': () => commentsPage(),
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const page = pages[path];
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page());
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.MOCK_KEY || 'test-key-not-real';
  const api = await startApi({ port: Number(process.env.MOCK_API_PORT) || 8787, key });
  const site = await startSite({ port: Number(process.env.MOCK_SITE_PORT) || 8788 });
  console.log(`mock Jev API   ${api.url}   (key: ${key})`);
  console.log(`fake Reddit    ${site.url}/r/test/   and   ${site.url}/old/r/test/`);
  console.log(`request log    ${api.url}/__log`);
  console.log(`${POSTS.length} stories per page. Try the prompt:  Is this post about "cat" or "dog"?`);
}
