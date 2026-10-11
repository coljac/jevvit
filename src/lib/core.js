/*
 * Jevvit core: settings, the request we send to Jev, and the rule that turns
 * Jev's probability into hide / dim / show. Pure functions only (no browser
 * APIs), so it loads in the background, the content script, the extension pages
 * and Node's test runner alike.
 */
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else (root.Jevvit = root.Jevvit || {}).core = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
  const DEFAULT_MODEL = 'jev-latest';
  const QUESTION = 'match';

  const LIMITS = Object.freeze({
    prompt: 2000,
    criteria: 1000,
    model: 100,
    title: 500,
    flair: 100,
    body: 4000,
    request: 24000,
  });

  const DEFAULTS = Object.freeze({
    enabled: true,
    prompt: '',
    trueCriteria: '',
    falseCriteria: '',
    // 'hide': filter out posts that match the prompt. 'keep': filter out the ones that don't.
    mode: 'hide',
    // The "filter score" is P(match) in 'hide' mode and 1 - P(match) in 'keep' mode.
    hideAt: 0.7,
    unsureAt: 0.4, // 0 switches the "unsure" band off
    action: 'collapse', // collapse | hide | dim
    holdUntilJudged: true,
    includeBody: true,
    maxBodyChars: 600,
    exemptSubreddits: Object.freeze([]),
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
  });

  const MODES = ['hide', 'keep'];
  const ACTIONS = ['collapse', 'hide', 'dim'];

  function text(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/\r\n?/g, '\n').trim().slice(0, max);
  }

  function number(value, lo, hi, fallback) {
    const n = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  /** "r/AskReddit", "/r/askreddit", "askreddit" -> "askreddit" (or '' if it isn't a subreddit name). */
  function subredditName(value) {
    const m = /^\s*(?:\/?r\/)?([a-z0-9_]{2,21})\s*$/i.exec(typeof value === 'string' ? value : '');
    return m ? m[1].toLowerCase() : '';
  }

  function parseSubredditList(value) {
    const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : [];
    const seen = new Set();
    for (const part of parts) {
      const name = subredditName(part);
      if (name) seen.add(name);
    }
    return [...seen].slice(0, 200);
  }

  /**
   * The API key travels in an Authorization header, so only talk to https
   * endpoints, or to this machine (useful for a local mock or proxy).
   */
  function validateBaseUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return { ok: false, error: 'Enter a URL.' };
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: 'That is not a valid URL.' };
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      return { ok: false, error: 'Use https:// (plain http is only allowed for localhost).' };
    }
    if (url.username || url.password) return { ok: false, error: 'Do not put credentials in the URL.' };
    if (url.search || url.hash) return { ok: false, error: 'Leave off any ?query or #fragment.' };
    // Match patterns carry no port ("http://127.0.0.1/*" covers every port), and Firefox rejects one that has.
    return {
      ok: true,
      value: url.origin + url.pathname.replace(/\/+$/, ''),
      origin: url.origin,
      pattern: `${url.protocol}//${url.hostname}/*`,
    };
  }

  /** Coerce whatever is in storage into a complete, valid settings object. */
  function normaliseSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const hideAt = number(r.hideAt, 0.5, 0.99, DEFAULTS.hideAt);
    let unsureAt = number(r.unsureAt, 0, 0.99, DEFAULTS.unsureAt);
    if (unsureAt >= hideAt) unsureAt = 0;

    const base = validateBaseUrl(r.baseUrl);
    const model = text(r.model, LIMITS.model);

    return {
      enabled: r.enabled !== false,
      prompt: text(r.prompt, LIMITS.prompt),
      trueCriteria: text(r.trueCriteria, LIMITS.criteria),
      falseCriteria: text(r.falseCriteria, LIMITS.criteria),
      mode: MODES.includes(r.mode) ? r.mode : DEFAULTS.mode,
      hideAt,
      unsureAt,
      action: ACTIONS.includes(r.action) ? r.action : DEFAULTS.action,
      holdUntilJudged: r.holdUntilJudged !== false,
      includeBody: r.includeBody !== false,
      maxBodyChars: Math.round(number(r.maxBodyChars, 0, LIMITS.body, DEFAULTS.maxBodyChars)),
      exemptSubreddits: parseSubredditList(r.exemptSubreddits),
      model: /^[\w.:-]+$/.test(model) ? model : DEFAULT_MODEL,
      baseUrl: base.ok ? base.value : DEFAULT_BASE_URL,
    };
  }

  /** Active means: switched on and there is a prompt to judge by. (A key is checked by the background.) */
  function isActive(settings) {
    return Boolean(settings && settings.enabled && settings.prompt);
  }

  function isExempt(subreddit, settings) {
    const name = subredditName(subreddit);
    return Boolean(name) && settings.exemptSubreddits.includes(name);
  }

  /**
   * The one question we ask. The user's own words become the noul's
   * instructions untouched; the optional true/false criteria sharpen the boundary.
   */
  function buildQuestions(settings) {
    const question = { type: 'noul', instructions: settings.prompt };
    const criteria = {};
    if (settings.trueCriteria) criteria.true = settings.trueCriteria;
    if (settings.falseCriteria) criteria.false = settings.falseCriteria;
    if (Object.keys(criteria).length) question.criteria = criteria;
    return { [QUESTION]: question };
  }

  function clip(value, max) {
    const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }

  /**
   * What Jev gets to read about a post. Text only, no numbers or usernames:
   * just what a person would use to decide whether the story is their cup of tea.
   */
  function buildState(post, settings) {
    const state = {};
    const subreddit = clip(post.subreddit, 60);
    if (subreddit) state.subreddit = subreddit;
    state.title = clip(post.title, LIMITS.title);
    const flair = clip(post.flair, LIMITS.flair);
    if (flair) state.flair = flair;
    const domain = clip(post.domain, 100);
    if (domain && !/^self\./i.test(domain)) state.link_domain = domain;
    if (post.kind) state.post_type = clip(post.kind, 30);
    if (post.nsfw) state.nsfw = true;
    if (settings.includeBody && settings.maxBodyChars > 0) {
      const body = clip(post.body, settings.maxBodyChars);
      if (body) state.text = body;
    }
    return state;
  }

  function buildRequest(settings, state) {
    return { state, model: settings.model, questions: buildQuestions(settings) };
  }

  /** Pull P(match) out of a /v1/systemone response, or explain why we can't. */
  function parseAnswer(json) {
    const answer = json && json.answers && json.answers[QUESTION];
    if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' || !(answer.noul >= 0 && answer.noul <= 1)) {
      return null;
    }
    const usage = json.usage && typeof json.usage === 'object' ? json.usage : {};
    return {
      p: answer.noul,
      model: typeof json.model === 'string' ? json.model : '',
      inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    };
  }

  /** How much does Jev think this post should go? 0 = keep it, 1 = definitely filter it. */
  function filterScore(p, mode) {
    return mode === 'keep' ? 1 - p : p;
  }

  /** 'hide' | 'unsure' | 'show' for a probability, under the user's cutoffs. */
  function decide(p, settings) {
    const score = filterScore(p, settings.mode);
    let verdict = 'show';
    if (score >= settings.hideAt) verdict = 'hide';
    else if (settings.unsureAt > 0 && score >= settings.unsureAt) verdict = 'unsure';
    return { verdict, score };
  }

  /** Stable cache key for a request: same model, question and post text, same answer. */
  async function hashRequest(request) {
    const bytes = new TextEncoder().encode(JSON.stringify(request));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    DEFAULTS,
    LIMITS,
    QUESTION,
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    normaliseSettings,
    validateBaseUrl,
    parseSubredditList,
    subredditName,
    isActive,
    isExempt,
    buildQuestions,
    buildState,
    buildRequest,
    parseAnswer,
    filterScore,
    decide,
    hashRequest,
  };
});
