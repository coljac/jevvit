# Jevvit

A browser plugin that I could use browsing reddit, that would filter the stories by passing each one to Jev[^1] (or equivalent) and filtering them according to a particular prompt? The plugin would have the prompt and API key.

^1: A System One model, i.e. a very fast and cheap AI


Start with firefox.

See ~/src/jev

## Notes for agents

The README covers usage, layout and commands. `just test` (unit) and `just e2e` (headless Chrome and Firefox
against `scripts/mock-jev.mjs` and a pretend Reddit) should both pass before you hand anything back. Neither
touches real Reddit, the real API or a real key, and nothing else should either: use the mock and
`test-key-not-real`.

Things learnt the hard way:

- Branded Chrome ignores `--load-extension`. The e2e driver loads it with CDP `Extensions.loadUnpacked` over
  `--remote-debugging-pipe`.
- Firefox rejects host match patterns with a port (`http://127.0.0.1/*`, not `:8787`) and has no IPv6-literal
  patterns. Marionette won't navigate to `moz-extension://` pages, so the driver opens them from chrome context.
  `openOptionsPage()` reuses an empty tab instead of opening a new one.
- Don't drive the dev browser with Marionette: it sets `navigator.webdriver` (true under Marionette, false in
  the dev Firefox; checked), and Reddit puts up bot checks for automated browsers. `scripts/dev.mjs` uses
  Firefox's remote debugging protocol instead, like web-ext. A CDP-launched Chrome is probably flagged the same
  way (not checked), which is why `just run-chrome` leaves loading the extension to you. If Reddit shows a bot
  check, leave it be.
- The TypeSafe API sends no CORS headers to extension origins: requests work only through host permissions, from
  the background script.
- Reddit selectors come from archived real pages (`shreddit-post` attributes; ads are `shreddit-ad-post`). Flair
  and text-body extraction on new Reddit, and all of old Reddit, are still unverified against the live site.
