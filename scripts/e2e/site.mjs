// A pretend Reddit for the end-to-end tests: the same markup shapes as the real thing, with made-up stories.
//
// New Reddit follows the structure seen in real captures of www.reddit.com listings: <shreddit-feed> holds
// <article><shreddit-post ...attributes...></article> pairs separated by <hr>. Old Reddit is div.thing.link in
// #siteTable. Titles are chosen so the mock Jev (scripts/mock-jev.mjs) gives each one a predictable verdict.

export const POSTS = [
  { id: 't3_aaa001', sub: 'aww', title: 'My cat learned to open doors', domain: 'i.redd.it', type: 'image' },
  { id: 't3_aaa002', sub: 'programming', title: "Rust 2026 edition: what's changed", domain: 'blog.rust-lang.org', type: 'link' },
  { id: 't3_aaa003', sub: 'pets', title: 'Ask me about my two cats and one dog', domain: 'self.pets', type: 'text', body: 'Happy to answer anything.' },
  { id: 't3_aaa004', sub: 'programming', title: 'Show: a tiny web framework in 200 lines', domain: 'github.com', type: 'link' },
  { id: 't3_aaa005', sub: 'test', title: 'Weekly discussion thread [maybe]', domain: 'self.test', type: 'text', body: 'A rambling thread.' },
  { id: 't3_aaa006', sub: 'todayilearned', title: 'Ten facts about volcanoes', domain: 'en.wikipedia.org', type: 'link' },
  { id: 't3_aaa007', sub: 'exempt_sub', title: 'My dog is a very good boy', domain: 'i.redd.it', type: 'image' },
  { id: 't3_aaa008', sub: 'sysadmin', title: 'Status page: outage report [429]', domain: 'status.example.com', type: 'link' },
  { id: 't3_aaa009', sub: 'food', title: 'Cooking: the perfect omelette', domain: 'example.com', type: 'link', flair: 'Recipe' },
  { id: 't3_aaa010', sub: 'casualconversation', title: 'Weekend plans?', domain: 'self.casualconversation', type: 'text', body: 'We adopted a kitten, so honestly the cat will run the weekend.' },
  { id: 't3_aaa011', sub: 'sysadmin', title: 'Planned maintenance window [500]', domain: 'status.example.com', type: 'link' },
];

export const MORE_POSTS = [
  { id: 't3_bbb001', sub: 'aww', title: 'Another cat video you did not ask for', domain: 'v.redd.it', type: 'video' },
  { id: 't3_bbb002', sub: 'finance', title: 'Quarterly earnings roundup', domain: 'example.com', type: 'link' },
  { id: 't3_bbb003', sub: 'hiking', title: 'Best trails near Melbourne', domain: 'example.com', type: 'link' },
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
const short = (id) => id.replace(/^t3_/, '');
const permalink = (p) => `/r/${p.sub}/comments/${short(p.id)}/${slug(p.title)}/`;

export function newPost(p, i = 0, viewContext = 'SubredditFeed') {
  const link = permalink(p);
  const flair = p.flair ? `<shreddit-post-flair slot="post-flair"><a><span>${esc(p.flair)}</span></a></shreddit-post-flair>` : '<shreddit-post-flair slot="post-flair"></shreddit-post-flair>';
  const body = p.body ? `<div slot="text-body"><div class="md"><p>${esc(p.body)}</p></div></div>` : '';
  return `
  <article class="w-full m-0" aria-label="${esc(p.title)}">
    <shreddit-post class="block relative cursor-pointer group" data-ks-item permalink="${link}"
      content-href="https://${p.domain.replace(/^self\./, 'www.reddit.com/r/')}/" view-context="${viewContext}" comment-count="${i + 2}"
      view-type="cardView" feedindex="${i}" created-timestamp="2026-10-09T10:00:00.000000+0000" domain="${esc(p.domain)}"
      id="${p.id}" post-title="${esc(p.title)}" post-type="${p.type}" score="${40 + i}" subreddit-id="t5_fix${i}"
      subreddit-prefixed-name="r/${p.sub}" author-id="t2_fixture" author="some_user_${i}">
      <a slot="full-post-link" class="absolute inset-0" href="${link}"></a>
      <div class="post-grid">
        <span slot="credit-bar" class="credit">r/${p.sub} &bull; 3 hr. ago</span>
        <a href="${link}" id="post-title-${p.id}" slot="title" class="post-title">${esc(p.title)}</a>
        ${flair}
        ${body}
        <div slot="thumbnail" class="thumb"></div>
      </div>
    </shreddit-post>
  </article>
  <hr class="border-0 border-b-sm border-solid border-b-neutral-border-weak">`;
}

const NEW_CSS = `
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: #fff; color: #1a1a1b; }
  @media (prefers-color-scheme: dark) { body { background: #0e1113; color: #e8eaeb; } }
  main { max-width: 640px; margin: 0 auto; padding: 8px 12px; }
  shreddit-feed, shreddit-post { display: block; }
  article { margin: 0; }
  shreddit-post { padding: 12px 8px; position: relative; }
  .post-grid { display: grid; gap: 4px; }
  .credit { font-size: 12px; opacity: .7; }
  .post-title { font-weight: 600; font-size: 18px; color: inherit; text-decoration: none; }
  .thumb { width: 100%; height: 60px; background: #8883; border-radius: 8px; }
  hr { border: 0; border-bottom: 1px solid #8885; margin: 0; }
  h1 { font-size: 16px; margin: 12px 0 4px; }
  button.more { margin: 12px 0; padding: 6px 12px; }
`;

const MORE_SCRIPT = (morePosts) => `
  const MORE = ${JSON.stringify(morePosts.map((p, i) => newPost(p, 20 + i)))};
  function loadMore() {
    const feed = document.querySelector('shreddit-feed');
    const holder = document.createElement('div');
    holder.innerHTML = MORE.join('');
    feed.append(...holder.children);   // like Reddit's infinite scroll: new nodes arrive after load
    document.getElementById('more').disabled = true;
  }
  document.getElementById('more').addEventListener('click', loadMore);
  if (location.search.includes('auto')) setTimeout(loadMore, 400);
`;

export function newFeedPage({ posts = POSTS, more = MORE_POSTS, heading = 'r/test' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(heading)} - fake reddit</title>
  <style>${NEW_CSS}</style></head><body><main id="main-content">
  <h1>${esc(heading)}</h1>
  <shreddit-feed class="nd:visible">${posts.map((p, i) => newPost(p, i)).join('')}
    <faceplate-partial loading="programmatic" src="/svc/shreddit/more"></faceplate-partial>
  </shreddit-feed>
  <button id="more" class="more" type="button">Load more</button>
  </main><script>${MORE_SCRIPT(more)}</script></body></html>`;
}

/** A comments page: the main post (which must never be filtered) plus a recommended post lower down. */
export function commentsPage() {
  const main = { id: 't3_aaa001', sub: 'aww', title: 'My cat learned to open doors', domain: 'i.redd.it', type: 'image' };
  const related = { id: 't3_ccc001', sub: 'aww', title: 'More cats doing cat things', domain: 'i.redd.it', type: 'image' };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(main.title)}</title>
  <style>${NEW_CSS}</style></head><body><main id="main-content">
  <div id="the-post">${newPost(main, 0, 'CommentsPage').replace('<hr class="border-0 border-b-sm border-solid border-b-neutral-border-weak">', '')}</div>
  <h1>Related</h1>
  <div id="related">${newPost(related, 1, 'RecommendationFeed')}</div>
  </main></body></html>`;
}

export function oldThing(p, i = 0) {
  const link = permalink(p);
  const isSelf = /^self\./.test(p.domain);
  const url = isSelf ? link : `https://${p.domain}/`;
  const flair = p.flair ? `<span class="linkflairlabel" title="${esc(p.flair)}">${esc(p.flair)}</span> ` : '';
  return `
  <div class=" thing id-${p.id} ${i % 2 ? 'even' : 'odd'} link " id="thing_${p.id}" data-fullname="${p.id}" data-type="link"
       data-subreddit="${p.sub}" data-subreddit-prefixed="r/${p.sub}" data-author="some_user_${i}" data-domain="${esc(p.domain)}"
       data-url="${url}" data-permalink="${link}" data-nsfw="false" data-promoted="false" data-score="${40 + i}" data-comments-count="${i + 2}">
    <p class="parent"></p>
    <span class="rank">${i + 1}</span>
    <div class="midcol unvoted"><div class="arrow up"></div><div class="score unvoted">${40 + i}</div><div class="arrow down"></div></div>
    <a class="thumbnail may-blank" href="${url}"></a>
    <div class="entry unvoted">
      <div class="top-matter">
        <p class="title">${flair}<a class="title may-blank" href="${url}" tabindex="1">${esc(p.title)}</a>
          <span class="domain">(<a href="/domain/${esc(p.domain)}/">${esc(p.domain)}</a>)</span></p>
        <p class="tagline">submitted 3 hours ago by <a class="author" href="/user/x">some_user_${i}</a> to <a class="subreddit hover may-blank" href="/r/${p.sub}/">r/${p.sub}</a></p>
        <ul class="flat-list buttons"><li class="first"><a class="bylink comments may-blank" href="${link}">${i + 2} comments</a></li></ul>
      </div>
    </div>
    <div class="child"></div><div class="clearleft"></div>
  </div><div class="clearleft"></div>`;
}

export function promotedOldThing() {
  return `
  <div class=" thing id-t3_ad001 promoted link " id="thing_t3_ad001" data-fullname="t3_ad001" data-type="link" data-subreddit="ads"
       data-domain="example.com" data-promoted="true" data-permalink="/r/ads/comments/ad001/buy_cats/">
    <span class="rank">&nbsp;</span>
    <div class="entry"><div class="top-matter"><p class="title"><a class="title may-blank" href="https://example.com/">Buy cats now (promoted)</a></p></div></div>
    <div class="clearleft"></div>
  </div><div class="clearleft"></div>`;
}

const OLD_CSS = `
  body { margin: 0; font: 13px/1.4 verdana, arial, sans-serif; background: #fff; color: #222; }
  #siteTable { max-width: 720px; margin: 0 auto; }
  .thing { position: relative; padding: 6px 4px 6px 28px; border-bottom: 1px solid #eee; overflow: hidden; }
  .rank { position: absolute; left: 4px; top: 8px; color: #999; }
  .midcol { float: left; width: 40px; text-align: center; color: #888; }
  .thumbnail { float: left; width: 70px; height: 50px; margin: 0 8px; background: #ddd; }
  .entry { overflow: hidden; }
  p { margin: 2px 0; } a.title { font-size: 15px; color: #0000cc; }
  .clearleft { clear: left; }
  .tagline, .flat-list { color: #888; font-size: 11px; list-style: none; padding: 0; margin: 0; }
`;

export function oldFeedPage({ posts = POSTS } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>test - fake old reddit</title>
  <style>${OLD_CSS}</style></head><body><div id="siteTable" class="sitetable linklisting">
  ${promotedOldThing()}${posts.map((p, i) => oldThing(p, i)).join('')}
  </div></body></html>`;
}
