import net from 'node:net';

// One blog, many URLs -> one canonical string.
export function normalizeUrl(raw) {
  const u = new URL(String(raw).trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  u.protocol = 'https:';
  u.hash = '';
  u.username = u.password = '';
  u.hostname = u.hostname.replace(/^www\./, '');
  if (u.port === '80' || u.port === '443') u.port = '';
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$/.test(k)) u.searchParams.delete(k);
  return u.toString().replace(/\/$/, '');
}

export function isPrivateIp(ip) {
  if (/^::ffff:/i.test(ip)) {
    const t = ip.slice(7);
    if (net.isIPv4(t)) ip = t; else return true;
  }
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

export function badHostname(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return isPrivateIp(host);
  return host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost|lan)$/.test(host);
}

// Normalised, public-looking http(s) URL or throws.
export function cleanUrl(raw) {
  const n = normalizeUrl(raw);
  if (n.length > 500) throw new Error('URL too long');
  if (badHostname(new URL(n).hostname)) throw new Error('Private or local address');
  return n;
}
