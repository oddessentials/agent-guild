// Applies the chosen skin and light or dark theme before the first paint, so
// the page never flashes another one. Loaded in <head> as a plain script;
// app.js owns the controls.
(function () {
  // The skins the page offers, in menu order. Each has a stylesheet at
  // /skins/<id>/skin.css, linked from index.html.
  var skins = [
    { id: 'guild', name: 'Guild' },
    { id: 'professional', name: 'Professional' },
    { id: 'orbital', name: 'Orbital' },
    { id: 'grove', name: 'Grove' },
    { id: 'gnomeland', name: 'Gnomeland' },
    { id: 'goblinville', name: 'Goblinville' },
  ];
  window.agentGuildSkins = skins;
  var defaultSkin = 'professional';

  var theme = null;
  var skin = null;
  try {
    theme = localStorage.getItem('agentGuild.theme');
    skin = localStorage.getItem('agentGuild.skin');
  } catch (e) { /* storage unavailable */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (!skins.some(function (s) { return s.id === skin; })) skin = defaultSkin;
  var view = 'cards';
  try {
    if (localStorage.getItem('agentGuild.view') === 'yard') view = 'yard';
  } catch (e) { /* storage unavailable */ }
  var art = null;
  try {
    art = localStorage.getItem('agentGuild.art');
    if (art !== 'on' && art !== 'off') {
      art = 'off';
      for (var i = 0; i < localStorage.length; i++) if (/^agentGuild\.(?!art$)/.test(localStorage.key(i))) art = 'on';
      localStorage.setItem('agentGuild.art', art);
    }
  } catch (e) { /* storage unavailable */ }
  if (art !== 'on') art = 'off';
  // After card art, which reads a saved view as a page that has used Agent Guild.
  var app = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.agentGuild)
    || (window.agentGuild && typeof window.agentGuild.postMessage === 'function');
  if ((window.parent && window.parent !== window) || app) {
    var params = new URLSearchParams(location.hash.slice(1));
    var asked = params.get('view');
    if (params.get('layout') === 'compact') {
      document.documentElement.dataset.layout = 'compact';
      view = 'yard';
      if (skins.some(function (s) { return s.id === params.get('skin'); })) skin = params.get('skin');
      if (params.get('theme') === 'light' || params.get('theme') === 'dark') theme = params.get('theme');
    } else if (asked === 'cards' || asked === 'yard') {
      view = asked;
      try { localStorage.setItem('agentGuild.view', view); } catch (e) { /* storage unavailable */ }
    }
  }
  document.documentElement.dataset.view = view;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.skin = skin;
  document.documentElement.dataset.art = art;
})();
