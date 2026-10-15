/*
 * Background service worker: owns the watch list, decides what counts as a
 * change, and fires notifications. The actual fetching happens in the
 * offscreen page (offscreen.js), because service workers fall asleep and
 * chrome.alarms can't fire faster than every 30 seconds.
 */
importScripts('shared.js');

const DEFAULT_SETTINGS = { highlight: true, sound: true, disabledHosts: [] };
const MIN_INTERVAL = 2000;
const KIND_TITLE = { live: 'Site is live', ca: 'CA posted', text: 'Site updated', build: 'New deploy' };

// ---------- offscreen page ----------

let creating = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER', 'CLIPBOARD'],
        justification: 'Fetch and parse watched websites; copy contract addresses from notifications.',
      })
      .catch((e) => {
        if (!String(e).includes('single offscreen')) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {}
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

// ---------- state ----------

async function getWatches() {
  const { watches = [] } = await chrome.storage.local.get('watches');
  return watches;
}

// All writes to the watch list go through one queue so results that land at
// the same time can't overwrite each other.
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const list = await getWatches();
    const res = await fn(list);
    await chrome.storage.local.set({ watches: list });
    return [res, list];
  });
  queue = run.catch(() => {});
  return run;
}

const schedule = (list) => list.map((w) => ({ id: w.id, url: w.url, interval: w.interval }));

async function pushSchedule(list) {
  if (!list.length) return closeOffscreen();
  await ensureOffscreen();
  await toOffscreen({ type: 'SET_WATCHES', watches: schedule(list) });
}

function updateBadge(list) {
  const n = list.filter((w) => w.unseen).length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#E8A317' });
}

function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Enter a URL');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That doesn’t look like a URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) sites can be watched');
  u.hash = '';
  return u.toString();
}

async function addWatch(raw, interval = 5000) {
  const url = normalizeUrl(raw);
  const [, list] = await mutate((list) => {
    if (list.some((w) => w.url === url)) throw new Error('Already watching that site');
    list.unshift({
      id: crypto.randomUUID(),
      url,
      host: new URL(url).host,
      interval: Math.max(MIN_INTERVAL, Number(interval) || 5000),
      addedAt: Date.now(),
      status: 'pending', // pending | ok | down
      error: null,
      live: null, // has the site ever loaded?
      lastChecked: null,
      lastChanged: null,
      textHash: null,
      buildHash: null,
      casKey: null,
      cas: [],
      unseen: false,
      lastChange: null,
    });
  });
  await pushSchedule(list);
}

async function removeWatch(id) {
  const [, list] = await mutate((list) => {
    const i = list.findIndex((w) => w.id === id);
    if (i >= 0) list.splice(i, 1);
  });
  await chrome.storage.local.remove('text:' + id);
  updateBadge(list);
  await pushSchedule(list);
}

async function setInterval_(id, interval) {
  const [, list] = await mutate((list) => {
    const w = list.find((x) => x.id === id);
    if (w) w.interval = Math.max(MIN_INTERVAL, Number(interval) || 5000);
  });
  await pushSchedule(list);
}

async function markSeen(id) {
  const [, list] = await mutate((list) => {
    for (const w of list) if (id === 'all' || w.id === id) w.unseen = false;
  });
  updateBadge(list);
}

// ---------- change detection ----------

async function handleResult(r) {
  const [change, list] = await mutate(async (list) => {
    const w = list.find((x) => x.id === r.id);
    if (!w) return null;
    w.lastChecked = r.checkedAt;

    if (!r.ok) {
      w.status = 'down';
      w.error = r.error;
      if (w.textHash == null) w.live = false; // never loaded yet: remember it was down
      return null;
    }

    const neverLoaded = w.textHash == null;
    const cameLive = neverLoaded && w.live === false;
    w.status = 'ok';
    w.error = null;
    w.live = true;

    const key = 'text:' + w.id;
    const casKey = [...r.cas].sort().join(',');

    // First successful load of a site that was already up: just record a baseline.
    if (neverLoaded && !cameLive) {
      Object.assign(w, { textHash: r.textHash, buildHash: r.buildHash, casKey, cas: r.cas });
      await chrome.storage.local.set({ [key]: r.lines });
      return null;
    }

    const textChanged = r.textHash !== w.textHash;
    const buildChanged = r.buildHash !== w.buildHash;
    const casChanged = casKey !== w.casKey;
    if (!cameLive && !textChanged && !buildChanged && !casChanged) return null;

    const old = cameLive ? [] : (await chrome.storage.local.get(key))[key] || [];
    const { added, removed } = TW.diffLines(old, r.lines);
    const newCAs = r.cas.filter((c) => !(w.cas || []).includes(c));
    const kind = cameLive ? 'live' : newCAs.length ? 'ca' : textChanged || casChanged ? 'text' : 'build';

    Object.assign(w, { textHash: r.textHash, buildHash: r.buildHash, casKey, cas: r.cas });
    await chrome.storage.local.set({ [key]: r.lines });

    // Same lines, just reordered: not worth an alert.
    if (kind === 'text' && !added.length && !removed.length && !casChanged) return null;

    const lc = {
      kind,
      at: r.checkedAt,
      added: added.slice(0, 8),
      removed: removed.slice(0, 5),
      addedCount: added.length,
      removedCount: removed.length,
      newCAs,
    };
    w.lastChange = lc;
    w.lastChanged = r.checkedAt;
    w.unseen = true;
    return { w: { id: w.id, url: w.url, host: w.host }, lc };
  });

  if (change) {
    updateBadge(list);
    await notify(change.w, change.lc);
  }
}

// ---------- notifications ----------

async function notify(w, lc) {
  const { settings } = await chrome.storage.local.get('settings');
  const s = { ...DEFAULT_SETTINGS, ...settings };

  const firstText = lc.added.find((l) => !l.startsWith('[')) || lc.added[0];
  let message;
  if (lc.newCAs.length) message = lc.newCAs[0];
  else if (lc.kind === 'live') message = firstText ? '+ ' + firstText : 'The site just started responding';
  else if (firstText) message = '+ ' + firstText;
  else if (lc.kind === 'build') message = 'Asset files changed, likely a redeploy';
  else if (lc.removed.length) message = '− ' + lc.removed[0];
  else message = 'Something changed';

  const nid = `tw:${w.id}:${lc.at}`;
  const buttons = lc.newCAs.length ? [{ title: 'Copy CA' }, { title: 'Open site' }] : [{ title: 'Open site' }];
  await chrome.notifications.create(nid, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${KIND_TITLE[lc.kind]} · ${w.host}`,
    message: message.slice(0, 180),
    priority: 2,
    requireInteraction: true,
    buttons,
  });

  const { notifs = {} } = await chrome.storage.session.get('notifs');
  notifs[nid] = { id: w.id, url: w.url, ca: lc.newCAs[0] || null };
  await chrome.storage.session.set({ notifs });

  if (s.sound) {
    await ensureOffscreen();
    toOffscreen({ type: 'PLAY_SOUND' });
  }
}

async function notifTarget(nid) {
  const { notifs = {} } = await chrome.storage.session.get('notifs');
  return notifs[nid];
}

async function openSite(t) {
  await chrome.tabs.create({ url: t.url });
  await markSeen(t.id);
}

async function copyText(text) {
  await ensureOffscreen();
  await toOffscreen({ type: 'COPY', text });
}

chrome.notifications.onClicked.addListener(async (nid) => {
  const t = await notifTarget(nid);
  if (t) await openSite(t);
  chrome.notifications.clear(nid);
});

chrome.notifications.onButtonClicked.addListener(async (nid, index) => {
  const t = await notifTarget(nid);
  if (!t) return;
  if (t.ca && index === 0) {
    await copyText(t.ca);
    await markSeen(t.id);
  } else {
    await openSite(t);
  }
  chrome.notifications.clear(nid);
});

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;
  (async () => {
    switch (msg.type) {
      case 'OFFSCREEN_READY':
        return { watches: schedule(await getWatches()) };
      case 'RESULT':
        await handleResult(msg);
        return { ok: true };
      case 'ADD_WATCH':
        await addWatch(msg.url, msg.interval);
        return { ok: true };
      case 'REMOVE_WATCH':
        await removeWatch(msg.id);
        return { ok: true };
      case 'SET_INTERVAL':
        await setInterval_(msg.id, msg.interval);
        return { ok: true };
      case 'MARK_SEEN':
        await markSeen(msg.id);
        return { ok: true };
      default:
        return { error: 'Unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

// ---------- context menu ----------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'tw-link', title: 'Tripwire: watch this link', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'tw-page', title: 'Tripwire: watch this page', contexts: ['page'] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'tw-link' ? info.linkUrl : info.pageUrl || (tab && tab.url);
  try {
    await addWatch(url);
  } catch (e) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Tripwire',
      message: e.message || String(e),
    });
  }
});

// ---------- lifecycle ----------

async function init() {
  if (!(await chrome.alarms.get('keepalive'))) {
    chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  }
  const list = await getWatches();
  updateBadge(list);
  if (list.length) await pushSchedule(list);
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  init();
});
chrome.runtime.onStartup.addListener(init);
// Backstop: every 30s make sure the offscreen poller is still running.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepalive') init();
});
