/*
 * Shared helpers. Loaded by the background worker, the offscreen page,
 * the popup and the content script, so keep it dependency-free.
 */
(function (g) {
  // Solana (base58, 32-44 chars) or EVM (0x + 40 hex).
  const ANY_RE = /\b(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
  const QUICK_RE = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/;
  const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
  const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // Real base58 addresses almost always mix digits, upper and lower case.
  // Requiring all three filters out long plain words and slugs.
  function isCA(s) {
    if (EVM_RE.test(s)) return true;
    return SOL_RE.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
  }

  function findCAs(text) {
    const out = [];
    for (const m of String(text || '').matchAll(ANY_RE)) {
      if (isCA(m[0]) && !out.includes(m[0])) out.push(m[0]);
    }
    return out;
  }

  function shortCA(s) {
    return s.length > 12 ? s.slice(0, 4) + '…' + s.slice(-4) : s;
  }

  // FNV-1a, 32-bit. Only used to detect "did this change", not for security.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Lines that are only numbers, times or prices (countdowns, tickers) are
  // dropped so they don't trigger an alert on every check.
  const NOISE_LINE = /^[\d\s:.,/$%+\-–()]+$/;

  const META = [
    ['description', 'meta[name="description"]'],
    ['og:title', 'meta[property="og:title"]'],
    ['og:description', 'meta[property="og:description"]'],
    ['og:image', 'meta[property="og:image"]'],
    ['twitter:image', 'meta[name="twitter:image"]'],
  ];

  /*
   * Turn a parsed HTML Document into comparable pieces:
   *   lines     — visible text, key meta tags and outbound links
   *   textHash  — changes when any of those lines change
   *   buildHash — changes when the JS/CSS asset files change (a redeploy),
   *               which still catches client-rendered sites whose HTML has no text
   *   cas       — contract addresses found in text, links, meta or JSON data
   * Note: mutates the document (strips scripts and styles).
   */
  function parsePage(doc) {
    const assets = [];
    doc.querySelectorAll('script[src], link[href]').forEach((el) => {
      if (el.tagName === 'LINK') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (!/stylesheet|modulepreload|preload/.test(rel)) return;
      }
      const ref = el.getAttribute('src') || el.getAttribute('href') || '';
      assets.push(ref.split(/[?#]/)[0]); // ignore cache-busting query strings
    });
    assets.sort();

    const lines = [];
    const title = (doc.title || '').replace(/\s+/g, ' ').trim();
    if (title) lines.push('[title] ' + title);
    for (const [label, sel] of META) {
      const el = doc.querySelector(sel);
      const c = el && el.getAttribute('content');
      if (c && c.trim()) lines.push(`[${label}] ${c.trim()}`);
    }

    // Embedded JSON (e.g. Next.js __NEXT_DATA__) is scanned for CAs only.
    let jsonText = '';
    doc
      .querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__')
      .forEach((s) => (jsonText += ' ' + s.textContent));

    doc.querySelectorAll('script, style, noscript, template, svg, iframe').forEach((n) => n.remove());

    const root = doc.body || doc.documentElement;
    if (root) {
      const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const s = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (s && !NOISE_LINE.test(s)) lines.push(s);
      }
    }

    const links = new Set();
    doc.querySelectorAll('a[href]').forEach((a) => {
      const h = (a.getAttribute('href') || '').trim();
      if (h && !/^(#|javascript:|mailto:|tel:)/i.test(h)) links.add(h);
    });
    [...links].sort().forEach((h) => lines.push('[link] ' + h));

    const capped = lines.slice(0, 3000).map((l) => l.slice(0, 500));
    return {
      lines: capped,
      cas: findCAs(capped.join('\n') + '\n' + jsonText),
      textHash: hash(capped.join('\n')),
      buildHash: hash(assets.join('|')),
    };
  }

  function diffLines(oldLines, newLines) {
    const a = new Set(oldLines);
    const b = new Set(newLines);
    return {
      added: [...new Set(newLines.filter((l) => !a.has(l)))],
      removed: [...new Set(oldLines.filter((l) => !b.has(l)))],
    };
  }

  g.TW = { ANY_RE, QUICK_RE, isCA, findCAs, shortCA, hash, parsePage, diffLines };
})(globalThis);
