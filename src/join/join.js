// Shared helpers for the /join onboarding flow.
(function () {
  var KEY = 'sog_join_email';
  var qs = new URLSearchParams(location.search);

  function getEmail() {
    var e = qs.get('email');
    if (e) { try { sessionStorage.setItem(KEY, e); } catch (_) {} return e; }
    try { return sessionStorage.getItem(KEY) || ''; } catch (_) { return ''; }
  }
  function setEmail(e) { try { sessionStorage.setItem(KEY, e); } catch (_) {} }
  function withEmail(path) {
    var e = getEmail();
    return e ? path + (path.indexOf('?') > -1 ? '&' : '?') + 'email=' + encodeURIComponent(e) : path;
  }
  // Pages after step 1 require a captured email; otherwise send them back to step 1.
  function requireEmail() {
    var e = getEmail();
    if (!e) location.replace('/join');
    return e;
  }
  // Rewrite links marked data-keep-email so the email travels between steps.
  document.addEventListener('DOMContentLoaded', function () {
    var links = document.querySelectorAll('[data-keep-email]');
    for (var i = 0; i < links.length; i++) links[i].href = withEmail(links[i].getAttribute('href'));
    var els = document.querySelectorAll('[data-email]');
    for (var j = 0; j < els.length; j++) els[j].textContent = getEmail();
  });

  window.SOGJoin = { getEmail: getEmail, setEmail: setEmail, withEmail: withEmail, requireEmail: requireEmail };
})();
