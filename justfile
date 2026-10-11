# Jevvit: a browser extension that filters Reddit with Jev. `just` on its own lists the recipes.

default:
    @just --list

# Start the dev Firefox with Jevvit loaded (or reload Jevvit if it's open), then follow its log
run: run-firefox

# Start the dev Firefox with Jevvit loaded (or reload Jevvit if it's open), then follow its log
run-firefox:
    node scripts/dev.mjs firefox
    tail -n 20 -F .profiles/dev-firefox.log

# Start the dev Chrome (load build/chrome by hand the first time; it says how)
run-chrome:
    node scripts/dev.mjs chrome

# Close the dev browsers
stop:
    node scripts/dev.mjs stop

# Close the dev browsers, then start the dev Firefox again
restart: stop run

# Follow the dev Firefox's log
logs:
    tail -n 50 -F .profiles/dev-firefox.log

# Build the Firefox and Chrome versions into build/
build:
    node scripts/build.mjs

# Build, then zip each version into dist/ (for AMO signing or the Chrome Web Store)
zip:
    node scripts/build.mjs --zip

# Unit tests: no browser needed, about a second
test:
    node --test "test/*.test.mjs"

# End-to-end tests in headless Chrome and Firefox against a mock Jev and a pretend Reddit, e.g. `just e2e firefox --only feed`
e2e *args:
    node scripts/e2e/run.mjs {{args}}

# A mock Jev API on http://127.0.0.1:8787, for trying Jevvit without a real key (see the README)
mock:
    node scripts/mock-jev.mjs

# Redraw the toolbar icons
icons:
    node scripts/icons.mjs

# Delete build output, zips and the e2e browser profiles (the dev profiles stay)
clean:
    rm -rf build dist .profiles/e2e-chrome .profiles/e2e-firefox
