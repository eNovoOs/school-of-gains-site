// Site-wide first-touch attribution. Loaded on every page (mirrored GHL pages
// and the /join flow). Captures utm_* + ad click ids from the landing URL and
// keeps them in localStorage for 30 days so they survive navigation between
// pages and reach the /join flow (and from there Beehiiv + GHL).
(function () {
  var KEY = 'sog_attribution';
  var TTL = 30 * 24 * 60 * 60 * 1000;
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ttclid'];

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !d.captured_at || Date.now() - new Date(d.captured_at).getTime() > TTL) return null;
      return d;
    } catch (_) { return null; }
  }

  function capture() {
    var qs = new URLSearchParams(location.search);
    var found = {};
    var any = false;
    for (var i = 0; i < PARAMS.length; i++) {
      var v = qs.get(PARAMS[i]);
      if (v) { found[PARAMS[i]] = v; any = true; }
    }
    var existing = read();
    // First touch wins: only (re)write when this visit carries tracking params
    // and nothing valid is stored yet, or when the stored data expired.
    if (!any) return existing;
    if (existing && existing.utm_source) return existing;
    found.landing_page = location.href.split('#')[0];
    found.referrer = document.referrer || '';
    found.captured_at = new Date().toISOString();
    try { localStorage.setItem(KEY, JSON.stringify(found)); } catch (_) {}
    return found;
  }

  var data = capture();
  if (!data) {
    // No tracking params ever seen: still remember where they first landed.
    data = { landing_page: location.href.split('#')[0], referrer: document.referrer || '', captured_at: new Date().toISOString() };
    try { if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) {}
  }

  window.SOGAttribution = { get: function () { return read() || data; } };
})();
