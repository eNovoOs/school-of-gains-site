// Compatibility only. The build loads /acquisition/attribution.js first.
// Never restore the retired localStorage tracking or replace the consent-aware API.
(function () {
  if (!window.SOGAttribution) {
    window.SOGAttribution = { get: function () { return {}; } };
  }
})();
