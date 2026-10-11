import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import core from '../src/lib/core.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const settings = (over = {}) => core.normaliseSettings({ prompt: 'Is this about cats?', ...over });

test('defaults: a blank install is valid but inactive until there is a prompt', () => {
  const s = core.normaliseSettings(undefined);
  assert.equal(s.enabled, true);
  assert.equal(s.prompt, '');
  assert.equal(s.model, 'jev-latest');
  assert.equal(s.baseUrl, 'https://api.typesafe.ai');
  assert.equal(core.isActive(s), false);
  assert.equal(core.isActive(settings()), true);
  assert.equal(core.isActive(settings({ enabled: false })), false);
});

test('normaliseSettings clamps and repairs bad values rather than throwing', () => {
  const s = core.normaliseSettings({
    prompt: '  spaced out  ',
    mode: 'sideways',
    action: 'explode',
    hideAt: 7,
    unsureAt: 'lots',
    maxBodyChars: -5,
    model: 'bad model!',
    baseUrl: 'ftp://nope',
  });
  assert.equal(s.prompt, 'spaced out');
  assert.equal(s.mode, 'hide');
  assert.equal(s.action, 'collapse');
  assert.equal(s.hideAt, 0.99);
  assert.equal(s.unsureAt, core.DEFAULTS.unsureAt);
  assert.equal(s.maxBodyChars, 0);
  assert.equal(s.model, 'jev-latest');
  assert.equal(s.baseUrl, 'https://api.typesafe.ai');
});

test('an "unsure" cutoff at or above the hide cutoff switches the unsure band off', () => {
  assert.equal(settings({ hideAt: 0.6, unsureAt: 0.6 }).unsureAt, 0);
  assert.equal(settings({ hideAt: 0.6, unsureAt: 0.9 }).unsureAt, 0);
  assert.equal(settings({ hideAt: 0.6, unsureAt: 0.3 }).unsureAt, 0.3);
});

test('the prompt is capped, but the user\'s wording is otherwise untouched', () => {
  const long = 'x'.repeat(5000);
  assert.equal(settings({ prompt: long }).prompt.length, core.LIMITS.prompt);
  assert.equal(settings({ prompt: 'Is "this" <b>fine</b>?' }).prompt, 'Is "this" <b>fine</b>?');
});

test('validateBaseUrl only allows https, or http on this machine', () => {
  assert.deepEqual(core.validateBaseUrl('https://api.typesafe.ai/'), {
    ok: true,
    value: 'https://api.typesafe.ai',
    origin: 'https://api.typesafe.ai',
    pattern: 'https://api.typesafe.ai/*',
  });
  // Match patterns have no port: Firefox refuses to be asked for "http://127.0.0.1:8787/*".
  assert.equal(core.validateBaseUrl('http://127.0.0.1:8787').pattern, 'http://127.0.0.1/*');
  assert.equal(core.validateBaseUrl('https://proxy.example.com:8443/x').pattern, 'https://proxy.example.com/*');
  assert.equal(core.validateBaseUrl('https://proxy.example.com/typesafe//').value, 'https://proxy.example.com/typesafe');
  assert.equal(core.validateBaseUrl('http://127.0.0.1:8787').value, 'http://127.0.0.1:8787');
  assert.equal(core.validateBaseUrl('http://localhost:3000/v1x').origin, 'http://localhost:3000');
  for (const bad of ['http://api.typesafe.ai', 'https://u:p@api.typesafe.ai', 'https://a.b/?k=v', 'https://a.b/#x', 'nonsense', '', null]) {
    assert.equal(core.validateBaseUrl(bad).ok, false, String(bad));
  }
});

test('subreddit lists accept r/, /r/ and bare names, any case, any separator', () => {
  assert.deepEqual(core.parseSubredditList('r/AskReddit, /r/news\nprogramming;  AskReddit x'), ['askreddit', 'news', 'programming']);
  assert.deepEqual(core.parseSubredditList(['R/Foo', 'bar']), ['foo', 'bar']);
  assert.deepEqual(core.parseSubredditList(42), []);
  const s = settings({ exemptSubreddits: 'r/Cats' });
  assert.equal(core.isExempt('r/cats', s), true);
  assert.equal(core.isExempt('cats', s), true);
  assert.equal(core.isExempt('r/dogs', s), false);
  assert.equal(core.isExempt('', s), false);
});

test('buildQuestions: the prompt becomes one noul, with optional criteria', () => {
  assert.deepEqual(core.buildQuestions(settings()), {
    match: { type: 'noul', instructions: 'Is this about cats?' },
  });
  assert.deepEqual(core.buildQuestions(settings({ trueCriteria: 'Cats.', falseCriteria: 'Not cats.' })).match.criteria, {
    true: 'Cats.',
    false: 'Not cats.',
  });
  assert.deepEqual(core.buildQuestions(settings({ falseCriteria: 'Not cats.' })).match.criteria, { false: 'Not cats.' });
});

test('buildState: only text a person would judge by, nothing empty, no usernames or counts', () => {
  const s = settings();
  const state = core.buildState(
    {
      subreddit: 'r/cats',
      title: '  My   cat\nis loud ',
      flair: 'Discussion',
      domain: 'i.redd.it',
      kind: 'image',
      nsfw: true,
      body: 'Some body text',
      author: 'someone',
      score: 99,
    },
    s,
  );
  assert.deepEqual(state, {
    subreddit: 'r/cats',
    title: 'My cat is loud',
    flair: 'Discussion',
    link_domain: 'i.redd.it',
    post_type: 'image',
    nsfw: true,
    text: 'Some body text',
  });
  assert.equal('author' in state, false);
  assert.equal('score' in state, false);

  const bare = core.buildState({ title: 'Just a title', domain: 'self.cats' }, s);
  assert.deepEqual(bare, { title: 'Just a title' });
});

test('buildState: body text is clipped, and can be switched off', () => {
  const body = 'word '.repeat(400);
  const clipped = core.buildState({ title: 't', body }, settings({ maxBodyChars: 50 }));
  assert.ok(clipped.text.length <= 50);
  assert.ok(clipped.text.endsWith('…'));
  assert.equal('text' in core.buildState({ title: 't', body }, settings({ includeBody: false })), false);
  assert.equal('text' in core.buildState({ title: 't', body }, settings({ maxBodyChars: 0 })), false);
});

test('buildRequest matches what the official TypeSafe SDK serialises', () => {
  const ref = fixture('sdk-request.json');
  assert.equal(ref.url, 'https://api.typesafe.ai/v1/systemone');
  const s = settings({
    prompt: 'Is this post about web frameworks?',
    trueCriteria: 'Announces or discusses a web framework.',
    falseCriteria: 'Anything else.',
  });
  const state = core.buildState(
    { subreddit: 'r/programming', title: 'Show: a tiny Rust web framework', domain: 'github.com', kind: 'link' },
    s,
  );
  const body = JSON.parse(JSON.stringify(core.buildRequest(s, state)));
  assert.deepEqual(body, ref.body);
});

test('parseAnswer reads the SDK\'s sample response, and refuses anything else', () => {
  const ok = core.parseAnswer(fixture('sdk-response.json'));
  assert.deepEqual(ok, { p: 0.9132, model: 'jev-1.13.0', inputTokens: 61 });

  assert.equal(core.parseAnswer(null), null);
  assert.equal(core.parseAnswer({}), null);
  assert.equal(core.parseAnswer({ answers: { match: { type: 'choice', choice: 'a' } } }), null);
  assert.equal(core.parseAnswer({ answers: { match: { type: 'noul', noul: 1.2 } } }), null);
  assert.equal(core.parseAnswer({ answers: { match: { type: 'noul', noul: '0.4' } } }), null);
  assert.equal(core.parseAnswer({ answers: { other: { type: 'noul', noul: 0.4 } } }), null);
  assert.equal(core.parseAnswer({ answers: { match: { type: 'noul', noul: 0 } } }).p, 0);
});

test('decide: "hide" mode filters what matches; "keep" mode filters what does not', () => {
  const hide = settings({ mode: 'hide', hideAt: 0.7, unsureAt: 0.4 });
  assert.equal(core.decide(0.95, hide).verdict, 'hide');
  assert.equal(core.decide(0.7, hide).verdict, 'hide');
  assert.equal(core.decide(0.69, hide).verdict, 'unsure');
  assert.equal(core.decide(0.4, hide).verdict, 'unsure');
  assert.equal(core.decide(0.39, hide).verdict, 'show');
  assert.equal(core.decide(0.02, hide).verdict, 'show');

  const keep = settings({ mode: 'keep', hideAt: 0.7, unsureAt: 0.4 });
  assert.equal(core.decide(0.02, keep).verdict, 'hide'); // clearly not what I want
  assert.equal(core.decide(0.3, keep).verdict, 'hide');
  assert.equal(core.decide(0.31, keep).verdict, 'unsure');
  assert.equal(core.decide(0.6, keep).verdict, 'unsure');
  assert.equal(core.decide(0.61, keep).verdict, 'show');
  assert.equal(core.decide(0.98, keep).verdict, 'show');
  assert.ok(Math.abs(core.decide(0.1, keep).score - 0.9) < 1e-9);
});

test('decide: with the unsure band off, the middle is simply shown', () => {
  const s = settings({ hideAt: 0.7, unsureAt: 0 });
  assert.equal(core.decide(0.6, s).verdict, 'show');
  assert.equal(core.decide(0.75, s).verdict, 'hide');
});

test('hashRequest is stable, short, and changes with any ingredient', async () => {
  const s = settings();
  const state = { title: 'Cats' };
  const a = await core.hashRequest(core.buildRequest(s, state));
  const b = await core.hashRequest(core.buildRequest(s, { title: 'Cats' }));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, await core.hashRequest(core.buildRequest(s, { title: 'Dogs' })));
  assert.notEqual(a, await core.hashRequest(core.buildRequest(settings({ prompt: 'Is this about dogs?' }), state)));
  assert.notEqual(a, await core.hashRequest(core.buildRequest(settings({ model: 'jev-1.13.0' }), state)));
  assert.notEqual(a, await core.hashRequest(core.buildRequest(settings({ trueCriteria: 'x' }), state)));
  // Display settings must not bust the cache: the verdict doesn't depend on them.
  assert.equal(a, await core.hashRequest(core.buildRequest(settings({ mode: 'keep', hideAt: 0.9, action: 'dim' }), state)));
});
