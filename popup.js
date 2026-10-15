const DEFAULTS = { highlight: true, sound: true, disabledHosts: [] };
const KIND = { live: 'LIVE', ca: 'CA POSTED', text: 'UPDATED', build: 'REDEPLOY' };
const INTERVALS = [
  [2000, '2s'],
  [5000, '5s'],
  [10000, '10s'],
  [30000, '30s'],
  [60000, '1m'],
];

const $ = (s) => document.querySelector(s);
const send = (type, data = {}) => chrome.runtime.sendMessage({ target: 'bg', type, ...data });
const state = { watches: [], settings: { ...DEFAULTS } };
const cards = new Map();
let tab = null; // { url, host, watchable }

// ---------- helpers ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function label(w) {
  const u = new URL(w.url);
  return w.host + (u.pathname !== '/' ? u.pathname : '');
}

function showError(msg) {
  const e = $('#err');
  e.textContent = msg || '';
  e.hidden = !msg;
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = 'Copied';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('copied');
  }, 900);
}

async function openWatch(id) {
  const w = state.watches.find((x) => x.id === id);
  if (!w) return;
  await send('MARK_SEEN', { id });
  chrome.tabs.create({ url: w.url });
}

// ---------- cards ----------

function buildCard(w) {
  const li = el('li', 'card');

  const top = el('div', 'top');
  const dot = el('span', 'dot');
  const host = el('button', 'host');
  host.title = 'Open site';
  host.onclick = () => openWatch(w.id);
  const tag = el('span', 'tag');
  const rm = el('button', 'icon', '×');
  rm.title = 'Stop watching';
  rm.onclick = () => send('REMOVE_WATCH', { id: w.id });
  top.append(dot, host, tag, rm);

  const meta = el('div', 'meta');
  const checked = el('span');
  const changed = el('span');
  const sel = el('select', 'interval');
  sel.title = 'Check every';
  INTERVALS.forEach(([v, l]) => {
    const o = el('option', null, l);
    o.value = String(v);
    sel.append(o);
  });
  sel.onchange = () => send('SET_INTERVAL', { id: w.id, interval: Number(sel.value) });
  meta.append(checked, changed, sel);

  const change = el('div', 'change');
  const cas = el('div', 'cas');
  const actions = el('div', 'actions');
  const seen = el('button', 'ghost small', 'Mark seen');
  seen.onclick = () => send('MARK_SEEN', { id: w.id });
  actions.append(seen);

  li.append(top, meta, change, cas, actions);
  li._r = { dot, host, tag, checked, changed, sel, change, cas, actions };
  return li;
}

function renderChange(box, lc) {
  box.replaceChildren();
  if (!lc) return;
  const pretty = (l) => l.replace(/^\[link\] /, 'link: ').replace(/^\[([^\]]+)\] /, '$1: ');
  if (lc.kind === 'live') box.append(el('div', 'ln note', 'Site just went live'));
  if (lc.kind === 'build' && !lc.addedCount && !lc.removedCount) {
    box.append(el('div', 'ln note', 'Asset files changed, likely a redeploy'));
  }
  lc.added.slice(0, 4).forEach((l) => box.append(el('div', 'ln add', '+ ' + pretty(l))));
  lc.removed.slice(0, 2).forEach((l) => box.append(el('div', 'ln rem', '− ' + pretty(l))));
  const more = Math.max(0, lc.addedCount - 4) + Math.max(0, lc.removedCount - 2);
  if (more) box.append(el('div', 'ln note', `+${more} more line${more === 1 ? '' : 's'} changed`));
}

function renderCAs(box, w) {
  box.replaceChildren();
  const fresh = new Set(w.unseen && w.lastChange ? w.lastChange.newCAs : []);
  (w.cas || []).forEach((ca) => {
    const b = el('button', 'ca' + (fresh.has(ca) ? ' new' : ''), TW.shortCA(ca));
    b.title = ca + '\nClick to copy';
    b.onclick = () => copy(ca, b);
    box.append(b);
  });
}

function updateCard(li, w) {
  const r = li._r;
  li.classList.toggle('unseen', !!w.unseen);

  r.dot.className = 'dot ' + (w.status === 'ok' ? 'ok' : w.status === 'down' ? 'bad' : 'wait');
  r.dot.title = w.status === 'ok' ? 'Reachable' : w.status === 'down' ? w.error || 'Unreachable' : 'First check pending';
  r.host.textContent = label(w);

  const lc = w.lastChange;
  const showTag = !!(lc && w.unseen);
  r.tag.hidden = !showTag;
  r.tag.textContent = showTag ? KIND[lc.kind] : '';
  r.tag.dataset.kind = lc ? lc.kind : '';

  r.checked.dataset.ts = w.lastChecked || '';
  r.changed.dataset.ts = w.lastChanged || '';
  r.checked.dataset.err = w.status === 'down' ? w.error || 'Unreachable' : '';
  if (document.activeElement !== r.sel) r.sel.value = String(w.interval);

  const changeKey = lc ? lc.at : 0;
  if (r.changeKey !== changeKey) {
    r.changeKey = changeKey;
    renderChange(r.change, lc);
  }
  r.change.classList.toggle('fresh', !!w.unseen);

  const casKey = (w.cas || []).join(',') + '|' + (w.unseen && lc ? lc.newCAs.join(',') : '');
  if (r.casKey !== casKey) {
    r.casKey = casKey;
    renderCAs(r.cas, w);
  }
  r.actions.hidden = !w.unseen;
}

function updateTimes() {
  for (const li of cards.values()) {
    const { checked, changed } = li._r;
    const err = checked.dataset.err;
    const ct = Number(checked.dataset.ts);
    checked.className = err ? 'err-text' : '';
    checked.textContent = err ? `${err} · ${ct ? ago(ct) : ''}` : ct ? 'checked ' + ago(ct) : 'checking…';
    const ch = Number(changed.dataset.ts);
    changed.textContent = ch ? '· changed ' + ago(ch) : '';
  }
}

// ---------- render ----------

function render() {
  const list = $('#list');
  const ids = new Set(state.watches.map((w) => w.id));
  for (const [id, li] of cards) {
    if (!ids.has(id)) {
      li.remove();
      cards.delete(id);
    }
  }
  state.watches.forEach((w, i) => {
    let li = cards.get(w.id);
    if (!li) {
      li = buildCard(w);
      cards.set(w.id, li);
    }
    updateCard(li, w);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
  });

  $('#empty').hidden = state.watches.length > 0;
  $('#clearAll').hidden = !state.watches.some((w) => w.unseen);

  const s = state.settings;
  $('#hl').checked = s.highlight;
  $('#snd').checked = s.sound;
  const siteRow = $('#siteRow');
  siteRow.hidden = !(s.highlight && tab && tab.watchable);
  if (tab && tab.watchable) {
    $('#siteLabel').textContent = 'on ' + tab.host;
    $('#site').checked = !s.disabledHosts.includes(tab.host);
  }

  const watchBtn = $('#watchTab');
  if (!tab || !tab.watchable) {
    watchBtn.disabled = true;
    watchBtn.textContent = 'Open a website to watch it';
  } else if (state.watches.some((w) => w.url === tab.url)) {
    watchBtn.disabled = true;
    watchBtn.textContent = 'Watching this tab ✓';
  } else {
    watchBtn.disabled = false;
    watchBtn.textContent = 'Watch ' + tab.host;
  }

  updateTimes();
}

// ---------- events ----------

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  chrome.storage.local.set({ settings: state.settings });
}

async function add(url) {
  showError('');
  const res = await send('ADD_WATCH', { url, interval: Number($('#interval').value) });
  if (res && res.error) {
    showError(res.error);
    return false;
  }
  return true;
}

$('#watchTab').onclick = () => tab && add(tab.url);
$('#addForm').onsubmit = async (e) => {
  e.preventDefault();
  if (await add($('#url').value)) $('#url').value = '';
};
$('#clearAll').onclick = () => send('MARK_SEEN', { id: 'all' });
$('#hl').onchange = (e) => saveSettings({ highlight: e.target.checked });
$('#snd').onchange = (e) => saveSettings({ sound: e.target.checked });
$('#site').onchange = (e) => {
  const hosts = new Set(state.settings.disabledHosts);
  e.target.checked ? hosts.delete(tab.host) : hosts.add(tab.host);
  saveSettings({ disabledHosts: [...hosts] });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.watches) state.watches = changes.watches.newValue || [];
  if (changes.settings) state.settings = { ...DEFAULTS, ...changes.settings.newValue };
  if (changes.watches || changes.settings) render();
});

(async () => {
  const [{ watches = [], settings }, [active]] = await Promise.all([
    chrome.storage.local.get(['watches', 'settings']),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  state.watches = watches;
  state.settings = { ...DEFAULTS, ...settings };
  if (active && active.url && /^https?:/.test(active.url)) {
    const u = new URL(active.url);
    u.hash = '';
    tab = { url: u.toString(), host: u.host, watchable: true };
  }
  render();
  setInterval(updateTimes, 1000);
})();
