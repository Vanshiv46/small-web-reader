import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, cleanUrl, isPrivateIp, badHostname } from './lib.js';
import { SEED_FEEDS, seedBatches } from './seed.js';

const PORT = process.env.PORT || 3000;
const SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
const SALT = process.env.IP_SALT || crypto.randomBytes(16).toString('hex');
const MAX_BATCH = 100, MAX_BODY = 3 * 1024 * 1024, MIN_FOLLOWERS = Number(process.env.MIN_FOLLOWERS || 2);
const here = path.dirname(fileURLToPath(import.meta.url));

const db = new DatabaseSync(process.env.DB_PATH || path.join(here, 'data.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS feeds(url TEXT PRIMARY KEY, title TEXT);
CREATE TABLE IF NOT EXISTS subs(batch INTEGER NOT NULL, feed TEXT NOT NULL, PRIMARY KEY(batch, feed));
CREATE INDEX IF NOT EXISTS subs_feed ON subs(feed);
CREATE TABLE IF NOT EXISTS hits(ip TEXT NOT NULL, ts INTEGER NOT NULL);`);

const nextBatch = () => db.prepare('SELECT COALESCE(MAX(batch),0)+1 AS n FROM subs').get().n;
const insertBatch = list => {
  const id = nextBatch();
  const f = db.prepare('INSERT OR IGNORE INTO feeds(url,title) VALUES(?,?)');
  const s = db.prepare('INSERT OR IGNORE INTO subs(batch,feed) VALUES(?,?)');
  db.exec('BEGIN');
  try { for (const u of list) { f.run(u, new URL(u).hostname); s.run(id, u); } db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
if (db.prepare('SELECT COUNT(*) c FROM subs').get().c === 0) {
  for (const f of SEED_FEEDS) db.prepare('INSERT OR REPLACE INTO feeds VALUES(?,?)').run(normalizeUrl(f.url), f.title);
  for (const b of seedBatches()) insertBatch(b.map(normalizeUrl));
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { res.set('x-content-type-options', 'nosniff'); next(); });

// Rate limit: only a salted hash of the IP is kept; rows expire after 1 hour.
const limiter = (kind, max, win) => (req, res, next) => {
  const now = Date.now();
  db.prepare('DELETE FROM hits WHERE ts < ?').run(now - 3600e3);
  const k = crypto.createHash('sha256').update(kind + req.ip + SALT).digest('hex');
  const n = db.prepare('SELECT COUNT(*) c FROM hits WHERE ip=? AND ts>?').get(k, now - win).c;
  if (n >= max) return res.status(429).json({ error: 'Too many requests. Please wait a bit and try again.' });
  db.prepare('INSERT INTO hits VALUES(?,?)').run(k, now);
  next();
};

// ---------- Fetch route: raw bytes in, raw bytes out. No parsing, no storing. ----------
async function assertPublic(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (badHostname(u.hostname)) throw new Error('Blocked: private or local address');
  if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) {
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Blocked: resolves to a private address');
  }
}

app.get('/api/fetch', limiter('fetch', 120, 60e3), async (req, res) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    let url = String(req.query.url || ''), r;
    for (let i = 0; i < 5; i++) { // follow redirects ourselves so every hop is re-checked
      await assertPublic(url);
      r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: {
        'user-agent': 'SmallWebReader/1.0',
        accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/html,*/*' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
      break;
    }
    if (r.status >= 300 && r.status < 400) throw new Error('Too many redirects');
    const chunks = []; let size = 0;
    for await (const c of r.body) { size += c.length; if (size > MAX_BODY) throw new Error('Response too large'); chunks.push(c); }
    res.status(r.status).set({
      'content-type': 'text/plain; charset=utf-8', // proxied content can never run on our origin
      'content-security-policy': 'sandbox',
      'x-origin-content-type': r.headers.get('content-type') || '',
      'x-final-url': url, 'cache-control': 'no-store'
    }).send(Buffer.concat(chunks));
  } catch (e) {
    const timeout = e.name === 'AbortError';
    if (!res.headersSent) res.status(timeout ? 504 : 502).json({ error: timeout ? 'The site took too long to respond' : e.message });
  } finally { clearTimeout(timer); }
});

// ---------- Discovery API ----------
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const used = new Map();
function useToken(t) {
  const [n, ts, sig] = String(t || '').split('.');
  const age = Date.now() - Number(ts);
  if (!n || !sig || !Number.isFinite(age) || age > 600e3 || age < 0 || used.has(n)) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(n + ts));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  used.set(n, Date.now());
  for (const [k, v] of used) if (Date.now() - v > 600e3) used.delete(k);
  return true;
}

function cleanList(feeds, min = 1) {
  if (!Array.isArray(feeds)) throw new Error('feeds must be an array');
  if (feeds.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} feeds per request`);
  const out = new Set();
  for (const f of feeds) { try { out.add(cleanUrl(f)); } catch { /* skip invalid entries */ } }
  if (out.size < min) throw new Error(`Need at least ${min} valid public feed URL${min > 1 ? 's' : ''}`);
  return [...out];
}
const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };

app.get('/api/discovery/token', limiter('token', 20, 3600e3), (req, res) => {
  const n = crypto.randomBytes(8).toString('hex'), ts = Date.now();
  res.json({ token: `${n}.${ts}.${sign(n + ts)}` });
});

app.post('/api/discovery/submit', limiter('submit', 5, 3600e3), wrap((req, res) => {
  if (!useToken(req.body?.token)) throw new Error('Invalid or already used token. Please try again.');
  const list = cleanList(req.body?.feeds, 2); // one feed says nothing about "together"
  insertBatch(list);
  res.json({ ok: true, stored: list.length });
}));

const titled = r => ({ url: r.url, title: r.title || new URL(r.url).hostname, followers: r.followers, together: r.together });

function popular(exclude = [], limit = 10) {
  const ph = exclude.map(() => '?').join(',') || "''";
  return db.prepare(`SELECT s.feed AS url, f.title, COUNT(*) AS followers FROM subs s LEFT JOIN feeds f ON f.url=s.feed
    WHERE s.feed NOT IN (${ph}) GROUP BY s.feed HAVING followers >= ? ORDER BY followers DESC LIMIT ?`)
    .all(...exclude, MIN_FOLLOWERS, limit).map(titled);
}

app.post('/api/discovery/recommend', limiter('rec', 60, 60e3), wrap((req, res) => {
  const mine = cleanList(req.body?.feeds || [], 0);
  let recs = [];
  if (mine.length) {
    const ph = mine.map(() => '?').join(',');
    recs = db.prepare(`
      SELECT s2.feed AS url, f.title, COUNT(DISTINCT s2.batch) AS together,
        (SELECT COUNT(*) FROM subs WHERE feed = s2.feed) AS followers
      FROM subs s1 JOIN subs s2 ON s1.batch = s2.batch AND s2.feed <> s1.feed
      LEFT JOIN feeds f ON f.url = s2.feed
      WHERE s1.feed IN (${ph}) AND s2.feed NOT IN (${ph})
      GROUP BY s2.feed HAVING followers >= ?
      ORDER BY together * 3 + followers DESC LIMIT 10`).all(...mine, ...mine, MIN_FOLLOWERS)
      .map(r => ({ ...titled(r), reason: `${r.together} reader${r.together > 1 ? 's' : ''} who follow your blogs also follow this one` }));
  }
  if (recs.length < 5) {
    const have = new Set(recs.map(r => r.url));
    for (const p of popular([...mine, ...have], 10 - recs.length)) recs.push({ ...p, reason: `Popular: followed by ${p.followers} readers` });
  }
  res.json({ recommendations: recs });
}));

app.get('/api/discovery/popular', limiter('pop', 60, 60e3), (req, res) => res.json({ popular: popular([], 15) }));
app.get('/api/seed', (req, res) => res.json({ feeds: SEED_FEEDS }));

app.use(express.static(path.join(here, 'public')));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status === 413 ? 'Request too large' : 'Something went wrong' }));

if (process.argv[1] === fileURLToPath(import.meta.url)) app.listen(PORT, () => console.log(`Small Web Reader on http://localhost:${PORT}`));
export default app;
