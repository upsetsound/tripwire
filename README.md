# Tripwire

A Chrome extension for memecoin traders.

1. **Site watcher.** Watch a coin's website and get a desktop notification (with a sound) the moment it changes, so you don't have to sit there refreshing.
2. **CA highlighter.** Contract addresses on any page get highlighted. Click one and it's copied.

## Install (you and your friends)

1. Unzip `tripwire.zip` somewhere you won't delete it.
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `tripwire` folder.
4. Pin the extension (puzzle icon → pin Tripwire).

To update after editing code: hit the reload icon on the Tripwire card in `chrome://extensions`.

## Using it

**Watch a site**
- Open the coin's website, click the Tripwire icon, then **Watch [site]**.
- Or right-click the website link on Axiom / GMGN / pump.fun / X and choose **Tripwire: watch this link**.
- Or paste a URL into the popup.
- Pick how often it checks: 2s, 5s (default), 10s, 30s, 1m.

The first check records a baseline. After that you get an alert when:

| Alert | Meaning |
| --- | --- |
| **CA posted** | A new contract address appeared. Notification has a **Copy CA** button. |
| **Site updated** | Visible text, title, meta image or links changed. |
| **New deploy** | The site's JS/CSS files changed. Catches redeploys of sites whose HTML has no text. |
| **Site is live** | It was unreachable when you added it and just started responding. |

Unread changes show as a badge on the icon and an amber card in the popup with what was added or removed.

**CA highlighting**
- Works on every site. Hover a highlighted address to see "Click to copy", click to copy it.
- Click-drag still selects text normally.
- Turn it off globally or just for the current site in the popup footer.

## How it works

- `offscreen.js`: a hidden page that stays open and fetches each watched site on its interval. A small Web Worker (`ticker.js`) drives the timer, because Chrome throttles timers on hidden pages.
- `background.js`: stores the watch list, compares each result with the last one, and fires notifications.
- `shared.js`: CA detection and page parsing. Lines that are only numbers (countdowns, prices) are ignored so they don't trigger alerts. Query strings on asset files are ignored so cache-busters don't look like deploys.
- `content.js`: highlighting via the CSS Custom Highlight API, so it never edits the page's DOM. Wrapping text in spans breaks React sites like Axiom.

## Limits

- Only runs while Chrome is open.
- Reads raw HTML. A purely client-rendered site that changes text without redeploying won't show a text change.
- A site that renders something random on every load (live prices, rotating content) will alert too often. Use a longer interval for those.
- CA detection is a pattern match (Solana base58, EVM 0x). Rarely, a long random ID can be picked up.

## Ideas for v2

- A small server for Certificate Transparency monitoring: see new domains for a ticker before the site even goes up.
- Keyword triggers ("only alert if the word 'live' appears").
- Headless rendering for client-only sites.
