// Applies the chosen skin and light or dark theme before the first paint, so
// the page never flashes another one. Loaded in <head> as a plain script;
// app.js owns the controls.
(function () {
  // The skins the page offers, in menu order; the first is the default. Each
  // has a stylesheet at /skins/<id>/skin.css, linked from index.html.
  var skins = [
    { id: 'guild', name: 'Guild' },
    { id: 'professional', name: 'Professional' },
    { id: 'orbital', name: 'Orbital' },
    { id: 'grove', name: 'Grove' },
    // yard: false keeps Cards on screen until that skin has a world in web/yard/model.mjs.
    { id: 'gnomeland', name: 'Gnomeland', yard: false },
    { id: 'goblinville', name: 'Goblinville', yard: false },
  ];
  window.agentGuildSkins = skins;

  var theme = null;
  var skin = null;
  try {
    theme = localStorage.getItem('agentGuild.theme');
    skin = localStorage.getItem('agentGuild.skin');
  } catch (e) { /* storage unavailable */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (!skins.some(function (s) { return s.id === skin; })) skin = skins[0].id;
  var entry = skins.find(function (s) { return s.id === skin; });
  var view = 'cards';
  // Leave a saved Yard preference in place. Skins without a world open on Cards.
  try {
    if (entry.yard !== false && localStorage.getItem('agentGuild.view') === 'yard') view = 'yard';
  } catch (e) { /* storage unavailable */ }
  document.documentElement.dataset.view = view;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.skin = skin;
})();
