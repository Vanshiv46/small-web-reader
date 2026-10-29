export const SEED_FEEDS = [
  { url: 'https://jvns.ca/atom.xml', title: 'Julia Evans', tag: 'tech' },
  { url: 'https://overreacted.io/rss.xml', title: 'Overreacted', tag: 'tech' },
  { url: 'https://simonwillison.net/atom/everything/', title: "Simon Willison's Weblog", tag: 'tech' },
  { url: 'https://danluu.com/atom.xml', title: 'Dan Luu', tag: 'tech' },
  { url: 'https://martinfowler.com/feed.atom', title: 'Martin Fowler', tag: 'tech' },
  { url: 'https://www.joelonsoftware.com/feed/', title: 'Joel on Software', tag: 'essays' },
  { url: 'https://blog.codinghorror.com/rss/', title: 'Coding Horror', tag: 'essays' },
  { url: 'https://www.kalzumeus.com/feed/', title: 'Kalzumeus', tag: 'essays' },
  { url: 'https://waitbutwhy.com/feed', title: 'Wait But Why', tag: 'essays' },
  { url: 'https://daringfireball.net/feeds/main', title: 'Daring Fireball', tag: 'apple' },
  { url: 'https://www.marginalia.nu/index.xml', title: 'Marginalia', tag: 'tech' },
  { url: 'https://xkcd.com/atom.xml', title: 'xkcd', tag: 'fun' }
];

// Deterministic synthetic anonymous batches so Discover is never empty.
export function seedBatches(count = 80) {
  let s = 42;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const groups = { tech: [], essays: [], apple: [], fun: [] };
  SEED_FEEDS.forEach(f => groups[f.tag].push(f.url));
  const pick = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);
  const batches = [];
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const main = r < 0.5 ? 'tech' : r < 0.8 ? 'essays' : r < 0.9 ? 'apple' : 'fun';
    const b = pick(groups[main], 2 + Math.floor(rnd() * 3));
    if (rnd() < 0.5) b.push(...pick(SEED_FEEDS.map(f => f.url), 1 + Math.floor(rnd() * 2)));
    batches.push([...new Set(b)]);
  }
  return batches;
}
