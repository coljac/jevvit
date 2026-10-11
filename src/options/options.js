'use strict';

const ext = globalThis.browser ?? globalThis.chrome;
const { core, cache: cacheLib } = globalThis.Jevvit;

const $ = (id) => document.getElementById(id);
const REDDIT_ORIGIN = '*://*.reddit.com/*';
const DEFAULT_ORIGIN = core.validateBaseUrl(core.DEFAULT_BASE_URL).origin;
const cache = cacheLib.createCache({ area: ext.storage.local });

let saved = { settings: core.normaliseSettings(undefined), apiKey: '' };

// ------------------------------------------------------------------ the form

const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
};

function fill({ settings, apiKey }) {
  $('apiKey').value = apiKey;
  $('model').value = settings.model;
  $('baseUrl').value = settings.baseUrl;
  $('prompt').value = settings.prompt;
  $('trueCriteria').value = settings.trueCriteria;
  $('falseCriteria').value = settings.falseCriteria;
  setRadio('mode', settings.mode);
  setRadio('action', settings.action);
  $('hideAt').value = Math.round(settings.hideAt * 100);
  $('unsureAt').value = Math.round(settings.unsureAt * 100);
  $('holdUntilJudged').checked = settings.holdUntilJudged;
  $('includeBody').checked = settings.includeBody;
  $('maxBodyChars').value = settings.maxBodyChars;
  $('enabled').checked = settings.enabled;
  $('exemptSubreddits').value = settings.exemptSubreddits.join('\n');
  refreshDerived();
}

function read() {
  const raw = {
    enabled: $('enabled').checked,
    prompt: $('prompt').value,
    trueCriteria: $('trueCriteria').value,
    falseCriteria: $('falseCriteria').value,
    mode: radioValue('mode'),
    action: radioValue('action'),
    hideAt: Number($('hideAt').value) / 100,
    unsureAt: Number($('unsureAt').value) / 100,
    holdUntilJudged: $('holdUntilJudged').checked,
    includeBody: $('includeBody').checked,
    maxBodyChars: Number($('maxBodyChars').value),
    exemptSubreddits: $('exemptSubreddits').value,
    model: $('model').value.trim() || core.DEFAULT_MODEL,
    baseUrl: $('baseUrl').value.trim() || core.DEFAULT_BASE_URL,
  };
  return { raw, settings: core.normaliseSettings(raw), apiKey: $('apiKey').value.trim() };
}

const percent = (x) => `${Math.round(x * 100)}%`;
const actionWords = { collapse: 'collapsed to one line', hide: 'hidden', dim: 'dimmed' };

function ruleText(s) {
  const verb = s.mode === 'hide' ? 'matches' : 'does not match';
  let text = `When Jev is at least ${percent(s.hideAt)} sure a story ${verb} your description, it is ${actionWords[s.action]}.`;
  if (s.unsureAt > 0) text += ` From ${percent(s.unsureAt)} it only dims the story a little.`;
  return text;
}

function refreshDerived() {
  const { settings } = read();
  $('hideAtOut').textContent = percent(settings.hideAt);
  $('unsureAtOut').textContent = settings.unsureAt > 0 ? percent(settings.unsureAt) : 'off';
  $('rule').textContent = ruleText(settings);
  $('bodyRow').hidden = !$('includeBody').checked;
}

function setSaved(text, bad = false) {
  const el = $('saved');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

// ---------------------------------------------------------------- permissions

/** What Jevvit needs access to right now. Synchronous, so it can be used inside a click handler. */
function neededAccess() {
  const base = core.validateBaseUrl($('baseUrl').value.trim() || core.DEFAULT_BASE_URL);
  const api = base.ok ? base : core.validateBaseUrl(core.DEFAULT_BASE_URL);
  return { origins: [REDDIT_ORIGIN, api.pattern], host: new URL(api.origin).host };
}

async function refreshAccess() {
  const { origins, host } = neededAccess();
  let ok = false;
  try {
    ok = await ext.permissions.contains({ origins });
  } catch {
    ok = false;
  }
  $('access').hidden = ok;
  if (!ok) {
    $('accessText').textContent = `Jevvit needs access to reddit.com (to filter your pages) and ${host} (to ask Jev). Your browser hasn't granted that yet.`;
  }
  return ok;
}

$('grant').addEventListener('click', () => {
  // request() has to be the first thing the click does, or the browser may not count it as a user action.
  requestAccess().then(async ({ granted, reason }) => {
    await refreshAccess();
    if (!granted) $('accessText').textContent += ` (${reason}.)`;
  });
});

// -------------------------------------------------------------------- saving

function refreshBanner() {
  let text = '';
  if (!saved.apiKey) text = 'Add your TypeSafe API key, write a prompt, and save. Then open Reddit.';
  else if (!saved.settings.prompt) text = 'Write a prompt and save, then open Reddit.';
  else if (!saved.settings.enabled) text = 'Filtering is switched off.';
  $('banner').hidden = !text;
  $('banner').textContent = text;
}

async function refreshCacheInfo() {
  const n = await cache.count();
  $('cacheInfo').textContent = `${n} verdict${n === 1 ? '' : 's'} remembered, kept up to 30 days, so revisiting a page costs nothing.`;
}

function showBaseUrlError(message) {
  $('baseUrlError').hidden = !message;
  $('baseUrlError').textContent = message || '';
}

$('baseUrl').addEventListener('input', () => {
  const value = $('baseUrl').value.trim();
  const check = value ? core.validateBaseUrl(value) : { ok: true };
  showBaseUrlError(check.ok ? '' : check.error);
});

/** Resolves to { granted, reason }: a refusal and a failure look different to the person saving. */
function requestAccess() {
  return ext.permissions.request({ origins: neededAccess().origins }).then(
    (granted) => ({ granted, reason: granted ? '' : 'it was declined' }),
    (err) => ({ granted: false, reason: err && err.message ? err.message : 'the browser refused the request' }),
  );
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  // Ask for permissions first thing: it only counts if it is made straight from the click.
  const granting = requestAccess();
  save(granting).catch((err) => setSaved(`Could not save: ${err.message}`, true));
});

async function save(granting) {
  const { raw, settings, apiKey } = read();
  const base = core.validateBaseUrl(raw.baseUrl);
  if (!base.ok) {
    showBaseUrlError(base.error);
    setSaved('Fix the API address first.', true);
    return;
  }
  const { granted, reason } = await granting;
  const custom = base.origin !== DEFAULT_ORIGIN;
  if (custom && !granted) {
    // Never keep an address we have no permission to reach: the key would have nowhere to go but an error.
    settings.baseUrl = saved.settings.baseUrl;
    $('baseUrl').value = settings.baseUrl;
    showBaseUrlError(`Access to ${base.origin} wasn't granted (${reason}), so the API address was left as it was.`);
  }

  await ext.storage.local.set({ settings });
  if (apiKey) await ext.storage.local.set({ apiKey });
  else await ext.storage.local.remove('apiKey');

  saved = { settings, apiKey };
  fill(saved);
  refreshBanner();
  await refreshAccess();
  setSaved(custom && !granted ? 'Saved, apart from the API address.' : 'Saved.');
}

// ---------------------------------------------------------------------- try it

const verdictWords = (settings, verdict) =>
  verdict === 'show' ? 'shown as normal' : verdict === 'unsure' ? 'dimmed a little' : actionWords[settings.action];

function showResult(text, kind = '') {
  const el = $('tryResult');
  el.textContent = text;
  el.className = `result ${kind}`;
}

async function tryIt() {
  const { settings, apiKey } = read();
  const title = $('tryTitle').value.trim();
  if (!title) return showResult('Enter a title first.', 'bad');
  if (!settings.prompt) return showResult('Write a prompt first.', 'bad');

  const subreddit = core.subredditName($('trySubreddit').value);
  const state = core.buildState(
    { title, subreddit: subreddit ? `r/${subreddit}` : '', domain: $('tryDomain').value.trim(), kind: 'link', body: $('tryText').value },
    settings,
  );
  showResult('Asking Jev…');
  const reply = await ext.runtime
    .sendMessage({ type: 'judge', state, fresh: true, override: { settings, apiKey } })
    .catch(() => null);
  if (!reply || !reply.ok) return showResult((reply && reply.error && reply.error.message) || 'No answer from the background script.', 'bad');

  const { verdict } = core.decide(reply.p, settings);
  const tokens = reply.inputTokens ? `, ${reply.inputTokens} input tokens` : '';
  showResult(`Jev says ${percent(reply.p)} likely to match, so it would be ${verdictWords(settings, verdict)}. (${reply.model || settings.model}${tokens})`, 'good');
}

$('tryButton').addEventListener('click', () => tryIt());
for (const id of ['tryTitle', 'trySubreddit', 'tryDomain']) {
  $(id).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // Enter here means "judge it", not "save everything"
    tryIt();
  });
}

// ----------------------------------------------------------------------- misc

$('toggleKey').addEventListener('click', () => {
  const field = $('apiKey');
  const reveal = field.type === 'password';
  field.type = reveal ? 'text' : 'password';
  $('toggleKey').textContent = reveal ? 'Hide' : 'Show';
  $('toggleKey').setAttribute('aria-pressed', String(reveal));
});

$('clearCache').addEventListener('click', async () => {
  const n = await cache.clear();
  await refreshCacheInfo();
  setSaved(`Forgot ${n} verdict${n === 1 ? '' : 's'}.`);
});

$('form').addEventListener('input', () => {
  refreshDerived();
  setSaved('Unsaved changes');
});
$('apiKey').addEventListener('input', () => refreshAccess());

async function init() {
  const { settings, apiKey } = await ext.storage.local.get(['settings', 'apiKey']);
  saved = { settings: core.normaliseSettings(settings), apiKey: typeof apiKey === 'string' ? apiKey : '' };
  fill(saved);
  refreshBanner();
  await Promise.all([refreshAccess(), refreshCacheInfo()]);
  setSaved('');
}

init();
