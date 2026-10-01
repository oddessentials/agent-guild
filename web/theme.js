// Applies the chosen theme before the first paint, so the page never flashes
// the other one. Loaded in <head> as a plain script; app.js owns the toggle.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('agentGuild.theme'); } catch (e) { /* storage unavailable */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
})();
