'use strict';
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v; else e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter(x => x != null && x !== false));
  return e;
};

// ---------- Local storage (IndexedDB): feeds, posts, full articles ----------
const dbp = new Promise((ok, no) => {
  const r = indexedDB.open('swr', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('feeds', { keyPath: 'url' }); d.createObjectStore('posts', { keyPath: 'id' }); d.createObjectStore('articles', { keyPath: 'id' }); };
  r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
});
const tx = async (store, mode, fn) => {
  const d = await dbp;
  return new Promise((ok, no) => { const t = d.transaction(store, mode); const req = fn(t.objectStore(store)); t.oncomplete = () => ok(req && req.result); t.onerror = () => no(t.error); });
};
const dbAll = s => tx(s, 'readonly', o => o.getAll());
const dbGet = (s, k) => tx(s, 'readonly', o => o.get(k));
const dbPut = (s, v) => tx(s, 'readwrite', o => o.put(v)).catch(() => {});
const dbDel = (s, k) => tx(s, 'readwrite', o => o.delete(k)).catch(() => {});

// ---------- Network via our fetch route ----------
async function fetchText(url) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch('/api/fetch?url=' + encodeURIComponent(url), { signal: c.signal });
    if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch {} throw new Error(m || 'The site answered with an error (' + r.status + ')'); }
    return { text: await r.text(), finalUrl: r.headers.get('x-final-url') || url };
  } catch (e) { throw new Error(e.name === 'AbortError' ? 'The site took too long to respond' : e.message); }
  finally { clearTimeout(t); }
}
const looksLikeFeed = t => /<(rss|feed|rdf:rdf)[\s>]/i.test(t.slice(0, 2000)) && !/<html[\s>]/i.test(t.slice(0, 500));

async function findFeed(input) {
  let u = input.trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const first = await fetchText(u);
  if (looksLikeFeed(first.text)) return first.finalUrl;
  const doc = new DOMParser().parseFromString(first.text, 'text/html');
  const declared = [...doc.querySelectorAll('link[rel~="alternate"]')].filter(l => /rss|atom/i.test(l.type || '') && l.getAttribute('href'))
    .map(l => new URL(l.getAttribute('href'), first.finalUrl).href);
  const guesses = ['/feed', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/rss'].map(p => new URL(p, first.finalUrl).href);
  for (const c of [...declared, ...guesses]) {
    try { const r = await fetchText(c); if (looksLikeFeed(r.text)) return r.finalUrl; } catch {}
  }
  throw new Error("Couldn't find a feed on that site. Try pasting the feed link directly.");
}

function parseFeed(xml, feedUrl) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('This feed is broken (malformed XML)');
  const kid = (el, n) => [...el.children].find(x => x.localName === n);
  const txt = (el, ...ns) => { for (const n of ns) { const c = kid(el, n); if (c && c.textContent.trim()) return c.textContent.trim(); } return ''; };
  const root = doc.documentElement, atom = root.localName === 'feed';
  const title = txt(atom ? root : (doc.querySelector('channel') || root), 'title') || new URL(feedUrl).hostname;
  const items = [...doc.querySelectorAll(atom ? 'entry' : 'item')].slice(0, 50).map(it => {
    let link = txt(it, 'link');
    if (atom) { const ls = [...it.children].filter(x => x.localName === 'link'); const l = ls.find(x => (x.getAttribute('rel') || 'alternate') === 'alternate') || ls[0]; link = l ? l.getAttribute('href') : ''; }
    try { link = new URL(link || txt(it, 'guid'), feedUrl).href; } catch { return null; }
    if (!/^https?:/.test(link)) return null;
    return { id: link, feed: feedUrl, link, title: txt(it, 'title') || link, date: Date.parse(txt(it, 'published', 'pubDate', 'updated', 'date')) || 0,
      summary: txt(it, 'encoded', 'content', 'summary', 'description'), read: false };
  }).filter(Boolean);
  return { title, items };
}

// ---------- Safety: everything from the web is sanitised before it touches the page ----------
if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', n => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  if (n.tagName === 'IMG') { n.setAttribute('referrerpolicy', 'no-referrer'); n.setAttribute('loading', 'lazy'); }
});
const clean = html => window.DOMPurify ? DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'iframe'] }) : '';
const excerpt = html => (new DOMParser().parseFromString(clean(html), 'text/html').body.textContent || '').trim().slice(0, 220);

// ---------- State ----------
let feeds = [], posts = [], filter = null, unreadOnly = false, tab = 'timeline';
const feedName = u => (feeds.find(f => f.url === u) || {}).title || new URL(u).hostname;
const ago = ts => { if (!ts) return 'date unknown'; const d = (Date.now() - ts) / 864e5; return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? Math.floor(d) + ' days ago' : new Date(ts).toLocaleDateString(); };
const bare = u => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

async function addFeed(input, msg) {
  const say = (t, err) => { if (msg) { msg.textContent = t; msg.className = 'msg' + (err ? ' err' : ''); } };
  say('Looking for a feed…');
  try {
    const url = await findFeed(input);
    if (feeds.some(f => bare(f.url) === bare(url))) { say('You already follow this blog.'); return; }
    const f = { url, title: new URL(url).hostname, error: null, updated: 0 };
    feeds.push(f); await dbPut('feeds', f);
    await refreshFeed(f); render(); say('Added ' + f.title + '.');
  } catch (e) { say(e.message, true); }
}

async function refreshFeed(f) {
  try {
    const { text } = await fetchText(f.url);
    const parsed = parseFeed(text, f.url);
    const old = new Map(posts.filter(p => p.feed === f.url).map(p => [p.id, p]));
    for (const it of parsed.items) {
      const prev = old.get(it.id);
      const p = prev ? { ...it, read: prev.read, date: it.date || prev.date } : it;
      if (prev) Object.assign(prev, p); else posts.push(p);
      await dbPut('posts', p);
    }
    f.title = parsed.title; f.error = null; f.updated = Date.now();
  } catch (e) { f.error = e.message; }
  await dbPut('feeds', f);
}

let refreshing = false;
async function refreshAll() {
  if (refreshing || !navigator.onLine || !feeds.length) return;
  refreshing = true; render();
  await Promise.allSettled(feeds.map(refreshFeed)); // one dead feed never blocks the rest
  refreshing = false; render();
}

// ---------- Views ----------
function render() {
  const hr = new Date().getHours();
  $('#greet').textContent = hr < 5 ? 'Late night reading?' : hr < 12 ? 'Good morning.' : hr < 18 ? 'Good afternoon.' : 'Good evening.';
  const unread = posts.filter(p => !p.read).length;
  $('#sub').textContent = feeds.length ? (unread ? `${unread} unread from the people you follow.` : "You're all caught up.") : 'Your reading list is empty for now.';
  renderFeeds(); if (tab === 'timeline') renderTimeline();
}

function renderFeeds() {
  $('#feedList').replaceChildren(
    h('div', { class: 'feed' + (!filter ? ' on' : '') }, h('button', { class: 'name', onclick: () => { filter = null; setTab('timeline'); } }, 'All posts')),
    ...feeds.map(f => {
      const n = posts.filter(p => p.feed === f.url && !p.read).length;
      return h('div', { class: 'feed' + (filter === f.url ? ' on' : ''), title: f.error || f.url },
        h('button', { class: 'name', onclick: () => { filter = f.url; setTab('timeline'); } }, f.title),
        f.error ? h('span', { class: 'bad', title: f.error }, '⚠') : null,
        n ? h('span', { class: 'n' }, n) : null,
        h('button', { class: 'x', 'aria-label': 'Unfollow ' + f.title, onclick: () => removeFeed(f) }, '✕'));
    }));
}

async function removeFeed(f) {
  if (!confirm(`Unfollow ${f.title}? Its saved posts will be removed from this device.`)) return;
  feeds = feeds.filter(x => x !== f);
  for (const p of posts.filter(p => p.feed === f.url)) { await dbDel('posts', p.id); await dbDel('articles', p.id); }
  posts = posts.filter(p => p.feed !== f.url); await dbDel('feeds', f.url);
  if (filter === f.url) filter = null; render();
}

async function addStarter(btn) {
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const { feeds: list } = await (await fetch('/api/seed')).json();
    for (const s of list.slice(0, 8)) { if (!feeds.some(f => bare(f.url) === bare(s.url))) { const f = { url: s.url, title: s.title, error: null, updated: 0 }; feeds.push(f); await dbPut('feeds', f); } }
    render(); await refreshAll();
  } catch { btn.disabled = false; btn.textContent = 'Try again'; }
}

function renderTimeline() {
  const box = $('#timeline');
  if (!feeds.length) {
    box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Follow a few blogs to get started.'),
      h('p', { class: 'muted' }, 'Paste a blog address on the left and we’ll find its feed. No account, no algorithm, and everything you read stays on this device.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: e => addStarter(e.target) }, 'Add 8 starter blogs'))));
    return;
  }
  const list = posts.filter(p => (!filter || p.feed === filter) && (!unreadOnly || !p.read)).sort((a, b) => b.date - a.date).slice(0, 200);
  const bar = h('div', { class: 'bar' },
    h('label', {}, h('input', { type: 'checkbox', ...(unreadOnly ? { checked: '' } : {}), onchange: e => { unreadOnly = e.target.checked; renderTimeline(); } }), ' Unread only'),
    h('span', { class: 'sp' }),
    h('span', { class: 'pill' + (navigator.onLine ? '' : ' off') }, navigator.onLine ? (refreshing ? 'Refreshing…' : 'Online') : 'Offline · showing saved posts'),
    h('button', { onclick: refreshAll, ...(navigator.onLine ? {} : { disabled: '' }) }, 'Refresh'),
    h('button', { onclick: markAllRead }, 'Mark all read'));
  const items = list.length ? list.map(p => h('button', { class: 'post' + (p.read ? ' read' : ''), onclick: () => openReader(p) },
      h('span', { class: 'dot' }), h('div', { class: 'meta' }, feedName(p.feed) + ' · ' + ago(p.date)), h('h3', {}, p.title),
      p.summary ? h('p', {}, excerpt(p.summary)) : null))
    : [h('div', { class: 'empty' }, h('h3', {}, unreadOnly ? 'Nothing unread here.' : 'No posts yet.'), h('p', { class: 'muted' }, refreshing ? 'Fetching the latest posts…' : 'Hit refresh, or check the ⚠ marks in the sidebar for feeds that failed.'))];
  box.replaceChildren(bar, ...items);
}

async function markAllRead() { for (const p of posts) if ((!filter || p.feed === filter) && !p.read) { p.read = true; await dbPut('posts', p); } render(); }

async function openReader(p) {
  const r = $('#reader'); r.hidden = false; r.scrollTop = 0;
  const body = h('div', { class: 'body' }, 'Loading the full article…');
  const badge = h('span', { class: 'pill' }, 'Loading');
  r.replaceChildren(h('div', { class: 'tools' }, h('button', { onclick: () => { r.hidden = true; } }, '← Back'),
    h('a', { href: p.link, target: '_blank', rel: 'noopener noreferrer' }, h('button', {}, 'Open original'))),
    h('h1', {}, p.title), h('div', { class: 'meta muted' }, feedName(p.feed) + ' · ' + ago(p.date) + ' '), badge, body);
  if (!p.read) { p.read = true; dbPut('posts', p); render(); }
  let art = await dbGet('articles', p.id).catch(() => null);
  if (!art && navigator.onLine) {
    try {
      const { text, finalUrl } = await fetchText(p.link);
      const doc = new DOMParser().parseFromString(text, 'text/html');
      doc.head.prepend(Object.assign(doc.createElement('base'), { href: finalUrl }));
      const a = new Readability(doc).parse();
      if (!a || !a.content || (a.textContent || '').length < 200) throw new Error('thin');
      const html = clean(a.content); if (!html) throw new Error('unsafe');
      art = { id: p.id, html, saved: Date.now() }; dbPut('articles', art);
    } catch { art = null; }
  }
  if (art) { body.innerHTML = art.html; badge.textContent = 'Full article · saved for offline'; }
  else if (p.summary) { body.innerHTML = clean(p.summary); badge.textContent = navigator.onLine ? 'Summary only · full text unavailable' : 'Summary only · you’re offline'; }
  else { body.textContent = 'We couldn’t load this article' + (navigator.onLine ? '.' : ' while offline.') + ' Use “Open original” to read it on the site.'; badge.textContent = 'Unavailable'; }
}

// ---------- Discover (anonymous, opt-in) ----------
async function renderDiscover() {
  const box = $('#discover'); const mine = feeds.map(f => f.url);
  const consent = h('input', { type: 'checkbox', id: 'consent' }); const status = h('p', { class: 'msg', role: 'status' });
  const share = h('button', { class: 'primary', disabled: '', onclick: async () => {
    share.disabled = true; status.className = 'msg'; status.textContent = 'Sending…';
    try {
      const { token } = await (await fetch('/api/discovery/token')).json();
      const r = await fetch('/api/discovery/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, feeds: mine }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error);
      status.textContent = 'Thanks! Your list was added anonymously (' + j.stored + ' blogs).';
    } catch (e) { status.className = 'msg err'; status.textContent = e.message; share.disabled = false; }
  } }, 'Share my list anonymously');
  consent.addEventListener('change', () => { share.disabled = !consent.checked || mine.length < 2; });
  box.replaceChildren(h('div', { class: 'consent' },
    h('label', {}, consent, h('span', {}, 'Help others discover blogs. I agree to send my list of blogs once, with no name, no account and no ID. The server only counts which blogs appear together.')),
    h('div', { class: 'row', style: 'margin-top:.8rem' }, share), status,
    mine.length < 2 ? h('p', { class: 'msg' }, 'Follow at least 2 blogs to share.') : null),
    h('p', { class: 'muted' }, 'Loading suggestions…'));
  try {
    const r = await fetch('/api/discovery/recommend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feeds: mine }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    const recs = j.recommendations;
    box.lastChild.replaceWith(...(recs.length ? recs.map(x => h('div', { class: 'rec' },
      h('div', {}, h('h3', {}, x.title), h('p', {}, x.reason), h('p', {}, new URL(x.url).hostname)),
      h('button', { onclick: async e => { e.target.disabled = true; e.target.textContent = 'Adding…'; await addFeed(x.url); renderDiscover(); } }, 'Follow')))
      : [h('p', { class: 'muted' }, 'No suggestions yet. Check back once more people have shared.')]));
  } catch (e) { box.lastChild.replaceWith(h('p', { class: 'msg err' }, navigator.onLine ? e.message : 'Suggestions need an internet connection.')); }
}

function setTab(t) {
  tab = t; $('#timeline').hidden = t !== 'timeline'; $('#discover').hidden = t !== 'discover';
  $('#tabTimeline').setAttribute('aria-selected', t === 'timeline'); $('#tabDiscover').setAttribute('aria-selected', t === 'discover'); render();
  if (t === 'discover') renderDiscover();
}

// ---------- Boot ----------
$('#addForm').addEventListener('submit', async e => { e.preventDefault(); const i = $('#addInput'); await addFeed(i.value, $('#addMsg')); i.value = ''; });
$('#tabTimeline').onclick = () => setTab('timeline'); $('#tabDiscover').onclick = () => setTab('discover');
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#reader').hidden = true; });
window.addEventListener('online', refreshAll); window.addEventListener('offline', render);
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { feeds = await dbAll('feeds'); posts = await dbAll('posts'); } catch { feeds = []; posts = []; }
  render();            // cached timeline appears instantly...
  refreshAll();        // ...then a background refresh when online
  setInterval(refreshAll, 15 * 60 * 1000);
})();
