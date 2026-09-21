const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const script = fs.readFileSync(require('node:path').join(__dirname, '../src/acquisition/attribution.js'), 'utf8');
function browser({ url = 'https://school-of-gains.com/apply', referrer = '', storage = new Map(), deniedStorage = false, privacy = false } = {}) {
  const requests = [];
  const location = new URL(url);
  const window = { location, document: { referrer }, navigator: { globalPrivacyControl: privacy }, crypto: { randomUUID },
    localStorage: { getItem(k) { if (deniedStorage) throw Error(); return storage.get(k) || null; }, setItem(k, v) { if (deniedStorage) throw Error(); storage.set(k, v); }, removeItem(k) { if (deniedStorage) throw Error(); storage.delete(k); } },
    fetch(url, options) { requests.push(JSON.parse(options.body)); return Promise.resolve({ ok: true }); }, dispatchEvent() {} };
  vm.runInNewContext(script, { window, URL, URLSearchParams, Date, CustomEvent: class {} });
  return { api: window.SOGAttribution, requests, storage };
}
test('pending consent captures current application context without storage or analytics', () => {
  const b = browser({ url: 'https://school-of-gains.com/apply?utm_source=meetup&utm_medium=offline&email=person@example.com' });
  assert.equal(b.api.get().firstTouch.utm_source, 'meetup');
  assert.equal(b.api.getConsent(), 'pending');
  assert.equal(b.storage.size, 0);
  assert.equal(b.requests.length, 0);
  assert.equal(JSON.stringify(b.api.get()).includes('person'), false);
});
test('consented journey survives internal navigation, later campaigns update latest only', () => {
  const storage = new Map([['sog_analytics_consent', 'granted']]);
  const first = browser({ storage, url: 'https://school-of-gains.com/links?utm_source=meetup&utm_medium=offline' });
  const internal = browser({ storage, url: 'https://school-of-gains.com/apply?utm_source=website', referrer: 'https://school-of-gains.com/links?email=secret@example.com' });
  assert.equal(internal.api.get().journeyId, first.api.get().journeyId);
  assert.equal(internal.api.get().latestTouch.utm_source, 'meetup');
  const later = browser({ storage, url: 'https://school-of-gains.com/apply?utm_source=google&utm_medium=cpc&gclid=ad_123' });
  assert.equal(later.api.get().firstTouch.utm_source, 'meetup');
  assert.equal(later.api.get().latestTouch.utm_source, 'google');
  const direct = browser({ storage });
  assert.equal(direct.api.get().latestTouch.utm_source, 'google');
});
test('first direct visit remains first while latest becomes referral, stripped to origin', () => {
  const storage = new Map([['sog_analytics_consent', 'granted']]);
  browser({ storage });
  const next = browser({ storage, referrer: 'https://www.google.com/search?q=private&email=secret@example.com' });
  assert.equal(next.api.get().firstTouch.referrer, '');
  assert.equal(next.api.get().latestTouch.referrer, 'https://www.google.com');
});
test('rejects email-like UTM values and query identity; consent revocation clears journey storage', () => {
  const b = browser({ url: 'https://school-of-gains.com/apply?utm_source=person%40example.com&utm_campaign=spring_2026&phone=15551234567' });
  b.api.setConsent('granted');
  assert.equal(b.api.get().firstTouch.utm_source, undefined);
  assert.equal(b.requests.length, 1);
  assert.equal(JSON.stringify(b.requests).includes('5551234567'), false);
  b.api.setConsent('denied');
  assert.equal(b.storage.has('sog_attribution_v2'), false);
  b.api.track('quiz_started');
  assert.equal(b.requests.length, 1);
});
test('expired attribution is discarded rather than returned through a stale fallback', () => {
  const storage = new Map([['sog_analytics_consent', 'granted']]);
  const first = browser({ storage, url: 'https://school-of-gains.com/apply?utm_source=old' });
  const saved = JSON.parse(storage.get('sog_attribution_v2'));
  saved.firstTouch.captured_at = saved.latestTouch.captured_at = '2000-01-01T00:00:00.000Z';
  storage.set('sog_attribution_v2', JSON.stringify(saved));
  const next = browser({ storage });
  assert.notEqual(next.api.get().journeyId, first.api.get().journeyId);
  assert.equal(next.api.get().firstTouch.utm_source, undefined);
});
test('blocked storage and privacy signals do not break applications or enable analytics', () => {
  const blocked = browser({ deniedStorage: true });
  assert.ok(blocked.api.get().journeyId);
  const privateBrowser = browser({ privacy: true });
  privateBrowser.api.setConsent('granted');
  assert.equal(privateBrowser.api.getConsent(), 'denied');
  assert.equal(privateBrowser.requests.length, 0);
});
test('returned attribution cannot mutate future submitted snapshots', () => {
  const b = browser({ url: 'https://school-of-gains.com/apply?utm_source=meetup' });
  b.api.get().firstTouch.utm_source = 'edited';
  assert.equal(b.api.get().firstTouch.utm_source, 'meetup');
});
test('legacy join reads first-touch flat aliases without reviving old storage', () => {
  const storage = new Map([['sog_analytics_consent', 'granted'], ['sog_attribution', JSON.stringify({ utm_source: 'retired' })]]);
  const b = browser({ storage, url: 'https://school-of-gains.com/links?utm_source=meetup&utm_medium=offline' });
  assert.equal(b.api.get().utm_source, 'meetup');
  assert.equal(b.api.get().utm_source, b.api.get().firstTouch.utm_source);
  assert.equal(storage.has('sog_attribution'), false);
  const shim = fs.readFileSync(require('node:path').join(__dirname, '../src/join/attribution.js'), 'utf8');
  const window = { SOGAttribution: b.api };
  vm.runInNewContext(shim, { window });
  assert.equal(window.SOGAttribution, b.api);
});

test('registered public evidence survives capture, consented navigation and server validation without source inference', () => {
  const storage = new Map([['sog_analytics_consent', 'granted']]);
  const first = browser({ storage, url: 'https://school-of-gains.com/links?utm_source=instagram&utm_medium=organic_social&link_id=sog_link_006&legacy_route=legacy_001&route_map_version=v1' });
  const next = browser({ storage, referrer: 'https://school-of-gains.com/links' });
  const { event, touch } = require('../lib/attribution');
  const input = event(first.requests[0]);
  for (const captured of [next.api.get().firstTouch, input.attribution.firstTouch]) {
    assert.equal(captured.link_id, 'sog_link_006');
    assert.equal(captured.legacy_route, 'legacy_001');
    assert.equal(captured.route_map_version, 'v1');
    assert.equal(captured.utm_source, 'instagram');
  }
  assert.equal(input.attribution.firstTouch.confidence, 'explicit');
  const markerOnly = touch({ legacy_route: 'legacy_011', route_map_version: 'v1' });
  assert.equal(markerOnly.source, 'direct');
  assert.equal(markerOnly.utm_source, undefined);
  assert.equal(markerOnly.confidence, 'unknown');
});

test('client and server share exact evidence allowlists; unknown/affiliate and malformed markers are discarded', () => {
  const { touch } = require('../lib/attribution');
  for (const [key, values] of Object.entries({
    link_id: ['sog_link_001', 'sog_link_014', 'sog_link_015', 'sog_link_999', 'person@example.com', ['sog_link_001']],
    legacy_route: ['legacy_001', 'legacy_046', 'legacy_047', '/linktree-mads', ['legacy_001']]
  })) {
    for (const value of values) {
      const query = new URLSearchParams({ [key]: value, route_map_version: 'v1' });
      const client = browser({ url: 'https://school-of-gains.com/links?' + query }).api.get().firstTouch;
      const server = touch({ [key]: String(value), route_map_version: 'v1' });
      assert.equal(client[key], server[key]);
    }
  }
  assert.equal(touch({link_id:['sog_link_001']}).link_id, undefined);
  for (const value of [{legacy_route:'legacy_001'}, {route_map_version:'v1'}, {legacy_route:'legacy_001',route_map_version:'v2'}]) {
    const client = browser({ url: 'https://school-of-gains.com/links?' + new URLSearchParams(value) }).api.get().firstTouch;
    const server = touch(value);
    assert.equal(client.legacy_route, undefined);
    assert.equal(server.legacy_route, undefined);
    assert.equal(client.route_map_version, undefined);
    assert.equal(server.route_map_version, undefined);
  }
});

test('duplicate or internal evidence cannot replace source or propagate arbitrary URL values', () => {
  const duplicated = browser({url:'https://school-of-gains.com/links?utm_source=google&link_id=sog_link_001&link_id=sog_link_002&legacy_route=legacy_001&route_map_version=v1&route_map_version=v2'}).api.get().firstTouch;
  assert.equal(duplicated.utm_source,'google');
  assert.equal(duplicated.link_id,undefined);
  assert.equal(duplicated.legacy_route,undefined);
  const internal = browser({url:'https://school-of-gains.com/apply?link_id=sog_link_001&legacy_route=legacy_011&route_map_version=v1',referrer:'https://school-of-gains.com/links'}).api.get().firstTouch;
  assert.equal(internal.link_id,undefined);
  assert.equal(internal.legacy_route,undefined);
});
