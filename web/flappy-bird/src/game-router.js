// Keep the existing Main Mini App URL and old Flappy links. The raw launch
// fragment is forwarded unchanged; Occupiers verifies its signature again.
(function () {
  var fragment = new URLSearchParams(window.location.hash.slice(1));
  var raw = fragment.get('tgWebAppData') || '';
  var start = new URLSearchParams(raw).get('start_param') || fragment.get('tgWebAppStartParam') || '';
  var route = /^occupiers_[a-f0-9]{32}$/.test(start) ? '/occupiers/'
    : /^duel(?:_[A-HJ-NP-Z2-9]{5})?$/.test(start) ? '/duel/' : '';
  if (!route) return;
  document.documentElement.style.visibility = 'hidden';
  window.location.replace(route + window.location.search + window.location.hash);
})();
