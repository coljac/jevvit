/*
 * The Jev HTTP client: one POST to /v1/systemone, retried the way TypeSafe's
 * own SDK does it (429 / 408 / 5xx / dropped connections, honouring
 * retry-after). Every dependency that touches the outside world (fetch, sleep,
 * the clock) is injected, so the tests never need a network.
 *
 * Only the background script uses this: it is the one place that holds the
 * API key and talks to the API.
 */
(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.Jevvit.core;
  const exported = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else (root.Jevvit = root.Jevvit || {}).client = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  const SYSTEM_ONE_PATH = '/v1/systemone';
  const MAX_ERROR_TEXT = 200;
  const MAX_RETRY_WAIT_MS = 10000;

  /**
   * kind: nokey | perm | auth | request | rate | server | network | response
   * `message` is written for people and is safe to show: it never contains the key.
   */
  class JevError extends Error {
    constructor(kind, message, extra) {
      super(message);
      this.name = 'JevError';
      this.kind = kind;
      this.status = (extra && extra.status) || 0;
      this.retryAfterMs = extra && extra.retryAfterMs != null ? extra.retryAfterMs : null;
    }

    get retryable() {
      return this.kind === 'rate' || this.kind === 'server' || this.kind === 'network';
    }
  }

  /** The plain object that survives a trip through runtime.sendMessage. */
  function serialiseError(err) {
    if (err instanceof JevError) return { kind: err.kind, message: err.message, status: err.status };
    return { kind: 'network', message: 'Something went wrong talking to Jev.', status: 0 };
  }

  /** retry-after-ms first, then retry-after (seconds or an HTTP date), as the SDK does. */
  function parseRetryAfter(headers, now) {
    const ms = headers.get('retry-after-ms');
    if (ms != null && ms.trim() !== '' && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
    const secs = headers.get('retry-after');
    if (secs != null && secs.trim() !== '') {
      // A number is seconds (a negative one is no hint at all). Only text is tried as a date,
      // because V8's lenient parser would happily read "-1" as one.
      const n = Number(secs);
      if (Number.isFinite(n)) return n >= 0 ? n * 1000 : null;
      const when = Date.parse(secs);
      if (!Number.isNaN(when)) return Math.max(0, when - now());
    }
    return null;
  }

  /** The SDK's extract_message: error / message / detail, in their various shapes. */
  function extractMessage(body) {
    if (typeof body === 'string') return body || null;
    if (!body || typeof body !== 'object') return null;
    const { error, message, detail } = body;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof message === 'string') return message;
    if (typeof detail === 'string') return detail;
    if (detail && !Array.isArray(detail) && typeof detail.message === 'string') return detail.message;
    if (Array.isArray(detail)) {
      const parts = detail
        .filter((d) => d && typeof d.msg === 'string')
        .map((d) => {
          const path = Array.isArray(d.loc) ? d.loc.filter((x) => x !== 'body').join('.') : '';
          return path ? `${path}: ${d.msg}` : d.msg;
        });
      return parts.join('; ') || null;
    }
    return null;
  }

  function clipText(s) {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > MAX_ERROR_TEXT ? t.slice(0, MAX_ERROR_TEXT - 1) + '…' : t;
  }

  function errorForStatus(status, serverMessage, retryAfterMs) {
    const detail = serverMessage ? ` (${clipText(serverMessage)})` : '';
    if (status === 401 || status === 403) {
      return new JevError('auth', `TypeSafe rejected the API key (HTTP ${status}). Check it in the Jevvit settings.`, { status });
    }
    if (status === 429) {
      return new JevError('rate', 'TypeSafe is rate limiting requests (HTTP 429).', { status, retryAfterMs });
    }
    if (status === 408 || status >= 500) {
      return new JevError('server', `TypeSafe had a problem (HTTP ${status}).${detail}`, { status, retryAfterMs });
    }
    return new JevError('request', `TypeSafe did not accept the request (HTTP ${status})${detail}.`, { status });
  }

  async function requestOnce({ fetchImpl, url, apiKey, body, timeoutMs, now }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new JevError('network', 'TypeSafe did not answer in time.');
      throw new JevError('network', 'Could not reach TypeSafe. Check your connection.');
    }

    try {
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      if (!response.ok) {
        throw errorForStatus(response.status, extractMessage(parsed), parseRetryAfter(response.headers, now));
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new JevError('response', 'TypeSafe sent back something Jevvit could not read.');
      }
      return parsed;
    } catch (err) {
      if (err instanceof JevError) throw err;
      if (err && err.name === 'AbortError') throw new JevError('network', 'TypeSafe did not answer in time.');
      throw new JevError('network', 'The connection to TypeSafe dropped.');
    } finally {
      clearTimeout(timer);
    }
  }

  function backoffMs(attempt, random) {
    const exponential = Math.min(4000, 400 * 2 ** attempt);
    return Math.round(exponential * (0.75 + 0.25 * random()));
  }

  /**
   * Ask Jev about one post. Resolves to { p, model, inputTokens } or throws a JevError.
   * `request` is the object built by core.buildRequest.
   */
  async function judge({
    fetchImpl,
    baseUrl,
    apiKey,
    request,
    timeoutMs = 15000,
    maxRetries = 3,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = Date.now,
  }) {
    if (!apiKey) throw new JevError('nokey', 'Add your TypeSafe API key in the Jevvit settings.');
    const url = baseUrl + SYSTEM_ONE_PATH;

    for (let attempt = 0; ; attempt++) {
      try {
        const json = await requestOnce({ fetchImpl, url, apiKey, body: request, timeoutMs, now });
        const answer = core.parseAnswer(json);
        if (!answer) throw new JevError('response', 'TypeSafe answered, but not with the yes/no value Jevvit asked for.');
        return answer;
      } catch (err) {
        if (!(err instanceof JevError) || !err.retryable || attempt >= maxRetries) throw err;
        const wait = err.retryAfterMs != null ? Math.min(err.retryAfterMs, MAX_RETRY_WAIT_MS) : backoffMs(attempt, random);
        await sleep(wait);
      }
    }
  }

  /**
   * Run at most `limit` tasks at once; the rest wait their turn. A task that throws (even synchronously)
   * frees its slot like any other, so one failure can never stall the queue.
   */
  function createPool(limit) {
    let running = 0;
    const waiting = [];
    const pump = () => {
      while (running < limit && waiting.length) {
        const { task, resolve, reject } = waiting.shift();
        running++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            running--;
            pump();
          });
      }
    };
    return {
      run: (task) =>
        new Promise((resolve, reject) => {
          waiting.push({ task, resolve, reject });
          pump();
        }),
      get active() {
        return running;
      },
      get queued() {
        return waiting.length;
      },
    };
  }

  return { JevError, serialiseError, judge, createPool, parseRetryAfter, extractMessage, SYSTEM_ONE_PATH };
});
