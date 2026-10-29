import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, cleanUrl, isPrivateIp } from '../lib.js';

test('same blog, different URLs, one canonical form', () => {
  const a = normalizeUrl('http://www.Example.com/feed/?utm_source=x#top');
  assert.equal(a, 'https://example.com/feed');
  assert.equal(normalizeUrl('https://example.com/feed'), a);
});
test('private and local addresses are rejected', () => {
  for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'http://192.168.1.5/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://intranet/'])
    assert.throws(() => cleanUrl(u), undefined, u);
  assert.throws(() => cleanUrl('ftp://example.com/'));
  assert.ok(cleanUrl('https://blog.example.com/rss.xml'));
});
test('isPrivateIp', () => {
  assert.ok(isPrivateIp('::ffff:127.0.0.1'));
  assert.ok(!isPrivateIp('8.8.8.8'));
});
