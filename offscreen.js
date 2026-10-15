/*
 * Offscreen poller. A hidden extension page that stays open, fetches each
 * watched site on its interval, parses it, and reports results to the
 * background worker. The 1-second tick comes from a Web Worker because
 * timers on hidden pages can get throttled to once a minute.
 */
const watches = new Map(); // id -> { id, url, interval, next, inflight }
const TIMEOUT_MS = 12000;

function setWatches(list) {
  const keep = new Set();
  for (const w of list || []) {
    keep.add(w.id);
    const cur = watches.get(w.id);
    if (cur) {
      if (cur.url !== w.url) cur.next = 0;
      cur.url = w.url;
      cur.interval = w.interval;
      cur.next = Math.min(cur.next, Date.now() + w.interval);
    } else {
      watches.set(w.id, { ...w, next: 0, inflight: false });
    }
  }
  for (const id of [...watches.keys()]) if (!keep.has(id)) watches.delete(id);
}

function send(msg) {
  return chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

async function check(w) {
  const checkedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const u = new URL(w.url);
    u.searchParams.set('_tw', String(checkedAt)); // get past CDN caches
    const res = await fetch(u, { cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const parsed = TW.parsePage(doc);
    if (watches.has(w.id)) send({ type: 'RESULT', id: w.id, ok: true, checkedAt, ...parsed });
  } catch (e) {
    const error = e.name === 'AbortError' ? 'Timed out' : /Failed to fetch/i.test(e.message) ? 'Unreachable' : e.message || String(e);
    if (watches.has(w.id)) send({ type: 'RESULT', id: w.id, ok: false, checkedAt, error });
  } finally {
    clearTimeout(timer);
  }
}

function tick() {
  const now = Date.now();
  for (const w of watches.values()) {
    if (w.inflight || now < w.next) continue;
    w.inflight = true;
    w.next = now + w.interval;
    check(w).finally(() => (w.inflight = false));
  }
}

const ticker = new Worker('ticker.js');
ticker.onmessage = tick;

// ---------- sound + clipboard ----------

let audio;
function beep() {
  try {
    audio = audio || new AudioContext();
    audio.resume();
    const t = audio.currentTime;
    [
      [880, 0],
      [1320, 0.12],
    ].forEach(([freq, delay]) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, t + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.18);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.2);
    });
  } catch {}
}

function copy(text) {
  const ta = document.getElementById('clip');
  ta.value = text;
  ta.select();
  document.execCommand('copy');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'SET_WATCHES') setWatches(msg.watches);
  else if (msg.type === 'PLAY_SOUND') beep();
  else if (msg.type === 'COPY') copy(msg.text);
});

send({ type: 'OFFSCREEN_READY' }).then((res) => {
  if (res && res.watches) setWatches(res.watches);
});
