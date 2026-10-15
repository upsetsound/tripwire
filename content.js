/*
 * Content script: highlights contract addresses on any page; click one to copy.
 *
 * Uses the CSS Custom Highlight API instead of wrapping text in <span>s, so the
 * page's DOM is never modified. Wrapping text breaks React apps (Axiom, GMGN,
 * pump.fun) the same way Google Translate does.
 */
(() => {
  if (window.__tripwire) return;
  window.__tripwire = true;
  if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME']);
  const hl = new Highlight();
  const copiedHl = new Highlight();
  copiedHl.priority = 1;

  const byNode = new Map(); // Text node -> [{ range, ca }]
  let enabled = false;
  let observer = null;
  let pending = new Set();
  let flushTimer = null;

  // ---------- overlay (toast + hover hint), isolated in a shadow root ----------

  const host = document.createElement('tripwire-overlay');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .pill { position: fixed; z-index: 2147483647; pointer-events: none; font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        letter-spacing: .01em; color: #F5F2EB; background: #0F1B2D; border-radius: 999px; padding: 7px 11px; box-shadow: 0 6px 24px rgba(15,27,45,.25);
        opacity: 0; transition: opacity .12s ease, transform .12s ease; white-space: nowrap; }
      .hint { transform: translateY(4px); }
      .hint.on { opacity: .92; transform: none; }
      .toast { left: 50%; bottom: 28px; transform: translate(-50%, 8px); padding: 10px 14px; font-size: 13px; }
      .toast.on { opacity: 1; transform: translate(-50%, 0); }
      .toast b { font-weight: 600; color: #E8A317; margin-right: 8px; }
      .toast code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .85; }
      textarea { position: fixed; left: -9999px; top: 0; opacity: 0; }
    </style>
    <div class="pill hint">Click to copy CA</div>
    <div class="pill toast"><b>Copied</b><code></code></div>
    <textarea tabindex="-1"></textarea>`;
  const hint = shadow.querySelector('.hint');
  const toast = shadow.querySelector('.toast');
  const toastCode = toast.querySelector('code');
  const clip = shadow.querySelector('textarea');

  function mountOverlay() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // ---------- scanning ----------

  function skipped(el) {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (SKIP.has(e.tagName.toUpperCase()) || e.isContentEditable || e === host) return true;
    }
    return false;
  }

  function clearNode(n) {
    const arr = byNode.get(n);
    if (!arr) return;
    for (const x of arr) hl.delete(x.range);
    byNode.delete(n);
  }

  function scanText(n) {
    clearNode(n);
    const t = n.nodeValue;
    if (!t || t.length < 32 || !TW.QUICK_RE.test(t)) return;
    const parent = n.parentElement;
    if (!parent || skipped(parent)) return;
    const arr = [];
    for (const m of t.matchAll(TW.ANY_RE)) {
      if (!TW.isCA(m[0])) continue;
      const range = new Range();
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      hl.add(range);
      arr.push({ range, ca: m[0] });
    }
    if (arr.length) byNode.set(n, arr);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) return scanText(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (root === host) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.length >= 32 && TW.QUICK_RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(scanText);
  }

  function flush() {
    flushTimer = null;
    const batch = pending;
    pending = new Set();
    for (const n of batch) if (n.isConnected) scan(n);
    for (const n of [...byNode.keys()]) if (!n.isConnected) clearNode(n);
  }

  function onMutations(muts) {
    for (const m of muts) {
      if (m.type === 'characterData') pending.add(m.target);
      else m.addedNodes.forEach((n) => pending.add(n));
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    CSS.highlights.set('tw-ca', hl);
    CSS.highlights.set('tw-ca-copied', copiedHl);
    mountOverlay();
    scan(document.body);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    observer && observer.disconnect();
    observer = null;
    hl.clear();
    copiedHl.clear();
    byNode.clear();
    pending.clear();
    CSS.highlights.delete('tw-ca');
    CSS.highlights.delete('tw-ca-copied');
    hint.classList.remove('on');
  }

  // ---------- hit testing ----------

  function caAt(x, y) {
    if (!byNode.size) return null;
    let node = null;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      node = p && p.offsetNode;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      node = r && r.startContainer;
    }
    const arr = node && byNode.get(node);
    if (!arr) return null;
    for (const entry of arr) {
      for (const rect of entry.range.getClientRects()) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return entry;
      }
    }
    return null;
  }

  // ---------- copy ----------

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      clip.value = text;
      clip.select();
      document.execCommand('copy');
    }
  }

  let toastTimer;
  function showToast(ca) {
    toastCode.textContent = TW.shortCA(ca);
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1400);
  }

  window.addEventListener(
    'click',
    (e) => {
      if (!enabled || e.button !== 0) return;
      const sel = getSelection();
      if (sel && !sel.isCollapsed) return; // user is selecting text, leave it alone
      const hit = caAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      copy(hit.ca);
      showToast(hit.ca);
      copiedHl.add(hit.range);
      setTimeout(() => copiedHl.delete(hit.range), 900);
    },
    true
  );

  let moveQueued = false;
  let lastMove = null;
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!enabled || !byNode.size) return;
      lastMove = e;
      if (moveQueued) return;
      moveQueued = true;
      requestAnimationFrame(() => {
        moveQueued = false;
        const hit = caAt(lastMove.clientX, lastMove.clientY);
        if (hit) {
          hint.style.left = lastMove.clientX + 14 + 'px';
          hint.style.top = lastMove.clientY + 16 + 'px';
          hint.classList.add('on');
        } else {
          hint.classList.remove('on');
        }
      });
    },
    { passive: true }
  );

  // ---------- settings ----------

  function apply(settings) {
    const s = { highlight: true, disabledHosts: [], ...settings };
    const on = s.highlight && !s.disabledHosts.includes(location.host);
    on ? enable() : disable();
  }

  chrome.storage.local.get('settings', ({ settings }) => apply(settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) apply(changes.settings.newValue);
  });
})();
