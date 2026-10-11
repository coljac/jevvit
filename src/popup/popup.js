'use strict';

const ext = globalThis.browser ?? globalThis.chrome;
const { core } = globalThis.Jevvit;

const $ = (id) => document.getElementById(id);

let tab = null;
let stats = null;

/** The current tab, if it is a Reddit page (the tab's url is only visible to us for sites we have access to). */
async function redditTab() {
  const [current] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!current || current.id == null || !current.url) return null;
  try {
    const host = new URL(current.url).hostname;
    return host === 'reddit.com' || host.endsWith('.reddit.com') ? current : null;
  } catch {
    return null;
  }
}

async function askPage(message) {
  try {
    return (await ext.tabs.sendMessage(tab.id, message)) || null;
  } catch {
    return null; // no content script there: the page was open before Jevvit was installed, or isn't a listing
  }
}

function statusLine(settings, hasKey) {
  if (!settings.enabled) return 'Filtering is switched off.';
  if (!hasKey) return 'Add your API key in Settings to get started.';
  if (!settings.prompt) return 'Write a prompt in Settings to start filtering.';
  if (!tab) return 'Open a Reddit page to see it work.';
  if (!stats) return 'Reload this Reddit tab so Jevvit can run on it.';
  if (stats.paused) return 'Showing everything on this page.';
  if (!stats.posts) return 'No stories recognised here yet. Jevvit works on listings like the front page or a subreddit.';
  return `Watching ${stats.posts} ${stats.posts === 1 ? 'story' : 'stories'} on this page.`;
}

async function render() {
  const { settings: stored, apiKey } = await ext.storage.local.get(['settings', 'apiKey']);
  const settings = core.normaliseSettings(stored);
  const hasKey = typeof apiKey === 'string' && apiKey.trim() !== '';

  tab = await redditTab();
  stats = tab && settings.enabled ? await askPage({ type: 'jevvit:stats' }) : null;

  $('enabled').checked = settings.enabled;
  $('enabledLabel').textContent = settings.enabled ? 'On' : 'Off';
  $('status').textContent = statusLine(settings, hasKey);

  const showStats = Boolean(stats && stats.active);
  $('stats').hidden = !showStats;
  if (showStats) {
    $('sJudged').textContent = stats.judged;
    $('sFiltered').textContent = stats.filtered;
    $('sUnsure').textContent = stats.unsure;
    $('sShown').textContent = stats.shown;
  }

  const problem = stats && stats.lastError && stats.errors ? stats.lastError.message : '';
  $('problem').hidden = !problem;
  $('problem').textContent = problem;

  $('pause').hidden = !(stats && settings.prompt && hasKey);
  $('pause').textContent = stats && stats.paused ? 'Filter this page again' : 'Show everything on this page';
}

$('enabled').addEventListener('change', async () => {
  const { settings } = await ext.storage.local.get('settings');
  await ext.storage.local.set({ settings: { ...core.normaliseSettings(settings), enabled: $('enabled').checked } });
  setTimeout(render, 150);
});

$('pause').addEventListener('click', async () => {
  if (!tab || !stats) return;
  await askPage({ type: 'jevvit:pause', paused: !stats.paused });
  render();
});

$('settings').addEventListener('click', () => {
  ext.runtime.openOptionsPage();
  window.close();
});

render();
setInterval(render, 1000); // the numbers move while stories are being judged
