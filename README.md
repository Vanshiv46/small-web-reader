# Small Web Reader

An RSS/Atom reader with **anonymous, algorithm-free discovery**. Follow blogs directly, read full articles offline, and find new blogs from co-subscription counts. No accounts, no tracking.

Live demo: (https://small-web-reader.onrender.com/)

## Architecture

```
Browser (all the smart work)                    Server (one Express app)
┌─────────────────────────────────┐   /api/fetch    ┌───────────────────────────────┐
│ UI: timeline, sidebar, reader,  │ ──────────────► │ Fetch route: SSRF-checked,    │
│ Discover                        │ ◄────────────── │ raw bytes only, nothing stored│
│ Autodiscovery + RSS/Atom parser │                 ├───────────────────────────────┤
│ Readability + DOMPurify         │  /api/discovery │ Discovery API (SQLite)        │
│ IndexedDB cache + Service Worker│ ◄─────────────► │ token · submit · recommend ·  │
└─────────────────────────────────┘                 │ popular                       │
                                                    └───────────────────────────────┘
```

## Setup

```bash
npm install
npm start          # http://localhost:3000
npm test           # URL normalisation + private-IP tests
```

Env vars (all optional): `PORT`, `DB_PATH` (default `./data.db`), `APP_SECRET` (signs tokens), `IP_SALT` (salt for IP hashes), `MIN_FOLLOWERS` (default 2).
On first start the DB gets 12 seed blogs and 80 synthetic anonymous batches so Discover is never empty.

**Deploy (Render):** New > Web Service > connect this repo. Build `npm install`, start `npm start` (needs Node 22.5+; uses built-in node:sqlite, no native build) (a `render.yaml` is included). Add a persistent disk or accept that data resets on redeploy (the seed is recreated automatically).

## Privacy and threat model

**Server stores:** anonymous batches (a set of normalised feed URLs, no ID, no timestamp) and rate-limit rows with `sha256(kind + IP + salt)`, deleted after 1 hour.
**Never stores:** accounts, cookies, raw IPs, fetched page content, reading history.
**Opt-in:** nothing is saved unless the user ticks the consent box and presses the share button. Asking for recommendations sends the list only for the query; it is not saved.

| Threat | Defence |
|---|---|
| SSRF via fetch route | http(s) only; private/local/link-local/IPv6-mapped ranges blocked; DNS result re-checked; every redirect hop re-checked; 12 s timeout; 3 MB cap |
| XSS from proxied content | Fetch route replies `text/plain` + `CSP: sandbox` + `nosniff`; client sanitises with DOMPurify (fails closed if missing) |
| Fake popularity / spam | Single-use HMAC tokens (10 min expiry), 5 submits/hour per hashed IP, batch cap 100, min 2 feeds, invalid/private URLs dropped, feeds need >= 2 followers to be recommended |
| Same blog, many URLs | `http/https`, `www.`, trailing slash, `#hash`, `utm_*` normalised to one form |
| **Accepted risks** | An attacker with many IPs can still skew counts. Tiny DNS-rebinding window between check and fetch. Third-party images can see the reader's IP (referrer stripped). |

## Demo / edge cases
- Click **Add 8 starter blogs**, then open **Discover**.
- Autodiscovery: type `jvns.ca` (site URL, not feed URL).
- No feed: add `example.com`. Dead feed: add `https://example.invalid/feed`. Duplicates: `www.` and non-`www.` forms count once.
- Seed-list trap: `simonwillison.net/atom/everything/` and `.../everything` are the same blog (normalised to one).
- Offline: open an article, turn off Wi-Fi, reload; timeline and saved article still load.

## Known limitations
No OPML, folders/tags, ETag or robots.txt support yet.
