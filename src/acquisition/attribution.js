/* Anonymous attribution only. Analytics consent is separate from application consent. */
(function (window) {
  'use strict';
  var KEY = 'sog_attribution_v2';
  var CONSENT_KEY = 'sog_analytics_consent';
  var TTL = 30 * 86400000;
  var SESSION_TTL = 30 * 60000;
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'gclid', 'fbclid', 'gbraid', 'wbraid', 'ttclid'];
  var now = Date.now();
  var uuid = function () { return window.crypto.randomUUID(); };
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  function read(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } }
  function write(key, value) { try { window.localStorage.setItem(key, value); } catch (_) {} }
  function remove(key) { try { window.localStorage.removeItem(key); } catch (_) {} }
  // Retire the previous unconsented capture cache; never import it into the new model.
  remove('sog_attribution');
  var privacySignal = window.navigator.globalPrivacyControl === true || window.navigator.doNotTrack === '1';
  var consent = privacySignal ? 'denied' : read(CONSENT_KEY) || 'pending';
  if (!['granted', 'denied'].includes(consent)) consent = 'pending';
  function safePath(value) {
    // Route names only: never retain query strings, fragments, or an email-like path.
    var path = value || '/';
    return /^\/[a-zA-Z0-9/_-]{0,199}$/.test(path) && !/\d{9,}/.test(path) ? path : '/';
  }
  function ownHost(host) {
    return host === window.location.hostname || /(^|\.)school-of-gains\.com$/i.test(host);
  }
  function safeReferrer(value) {
    try { var ref = new URL(value); return /^https?:$/.test(ref.protocol) && !ownHost(ref.hostname) ? ref.origin : ''; } catch (_) { return ''; }
  }
  function param(value) {
    if (typeof value !== 'string') return '';
    var trimmed = value.trim();
    // Registered link values are codes, never free text or identity values.
    return /^[a-zA-Z0-9_.~-]{1,200}$/.test(trimmed) ? trimmed : '';
  }
  function safeTouch(input) {
    if (!input || typeof input !== 'object') return null;
    var date = Date.parse(input.captured_at);
    if (!Number.isFinite(date) || date > now + 300000 || now - date >= TTL) return null;
    var landing;
    try { landing = new URL(input.landing_page); } catch (_) { return null; }
    if (!/^https?:$/.test(landing.protocol) || !ownHost(landing.hostname)) return null;
    var result = { captured_at: new Date(date).toISOString(), landing_page: landing.origin + safePath(landing.pathname), referrer: safeReferrer(input.referrer) };
    PARAMS.forEach(function (key) { var value = param(input[key]); if (value) result[key] = value; });
    return result;
  }
  function nonDirect(touch) {
    return !!(touch.utm_source || touch.gclid || touch.gbraid || touch.wbraid || touch.fbclid || touch.ttclid || touch.referrer);
  }
  var current = { captured_at: new Date(now).toISOString(), landing_page: window.location.origin + safePath(window.location.pathname), referrer: safeReferrer(window.document.referrer) };
  var internal = false;
  try { internal = ownHost(new URL(window.document.referrer).hostname); } catch (_) {}
  if (!internal) {
    var query = new URLSearchParams(window.location.search);
    PARAMS.forEach(function (key) { var value = param(query.get(key)); if (value) current[key] = value; });
  }
  var state = { journeyId: uuid(), sessionId: uuid(), firstTouch: current, latestTouch: current, lastSeenAt: now };
  function hydrate() {
    try {
      var saved = JSON.parse(read(KEY));
      var id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      var first = safeTouch(saved && saved.firstTouch);
      var latest = safeTouch(saved && saved.latestTouch);
      if (!first || !latest || !id.test(saved.journeyId)) return;
      state = { journeyId: saved.journeyId, sessionId: id.test(saved.sessionId) && now - saved.lastSeenAt < SESSION_TTL ? saved.sessionId : uuid(), firstTouch: first, latestTouch: nonDirect(current) ? current : latest, lastSeenAt: now };
    } catch (_) {}
  }
  function persist() { if (consent === 'granted') write(KEY, JSON.stringify(state)); }
  if (consent === 'granted') { hydrate(); persist(); } else { remove(KEY); }
  var pageEventSent = false;
  function event(type) {
    if (consent !== 'granted') return Promise.resolve(false);
    return window.fetch('/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ eventId: uuid(), journeyId: state.journeyId, type: type, path: safePath(window.location.pathname), attribution: { firstTouch: state.firstTouch, latestTouch: state.latestTouch } }),
    }).then(function (response) { return response.ok; }).catch(function () { return false; });
  }
  function pageView() {
    if (!pageEventSent && consent === 'granted') { pageEventSent = true; event('page_view'); }
  }
  window.SOGAttribution = {
    get: function () { return clone(Object.assign({}, state.firstTouch, { journeyId: state.journeyId, firstTouch: state.firstTouch, latestTouch: state.latestTouch })); },
    getConsent: function () { return consent; },
    setConsent: function (value) {
      if (!['granted', 'denied'].includes(value)) return;
      consent = privacySignal ? 'denied' : value;
      write(CONSENT_KEY, consent);
      if (consent === 'granted') { hydrate(); persist(); pageView(); }
      else { remove(KEY); }
      window.dispatchEvent(new CustomEvent('sog:analytics-consent', { detail: { consent: consent } }));
    },
    track: event,
  };
  function installConsentControls() {
    if (!window.document.createElement) return;
    var banner = window.document.createElement('section');
    banner.className = 'analytics-consent';
    banner.setAttribute('aria-label', 'Analytics preferences');
    banner.hidden = consent !== 'pending';
    banner.innerHTML = '<div><h2 tabindex="-1">Your analytics choice</h2><p>Allow anonymous analytics to help us understand which pages and campaigns are useful. Your application works either way.</p><p class="consent-status" role="status"></p></div><div class="consent-buttons"><button type="button" data-choice="denied">Essential only</button><button type="button" data-choice="granted">Allow analytics</button></div>';
    var settings = window.document.createElement('button');
    settings.type = 'button';
    settings.className = 'analytics-settings';
    settings.textContent = 'Analytics preferences';
    var footer = window.document.querySelector('.site-footer div') || window.document.querySelector('footer');
    if (!footer) settings.className += ' analytics-settings-floating';
    (footer || window.document.body).appendChild(settings);
    window.document.body.appendChild(banner);
    function refresh() {
      banner.querySelector('.consent-status').textContent = privacySignal ? 'Your browser privacy preference is enabled. Analytics will remain off.' : consent === 'pending' ? '' : 'Current choice: ' + (consent === 'granted' ? 'analytics allowed.' : 'essential only.');
      banner.querySelector('[data-choice="granted"]').disabled = privacySignal;
    }
    settings.addEventListener('click', function () { banner.hidden = false; refresh(); banner.querySelector('h2').focus(); });
    banner.querySelectorAll('[data-choice]').forEach(function (button) {
      button.addEventListener('click', function () { window.SOGAttribution.setConsent(button.dataset.choice); banner.hidden = true; settings.focus({ preventScroll: true }); });
    });
    refresh();
  }
  installConsentControls();
  pageView();
})(window);
