(function () {
  var params = new URLSearchParams(location.search);
  var root = document.documentElement;
  var chosen = {
    skin: (window.agentGuildSkins || []).some(function (s) { return s.id === params.get('skin'); }) ? params.get('skin') : null,
    theme: params.get('theme') === 'light' || params.get('theme') === 'dark' ? params.get('theme') : null,
    view: params.get('view') === 'cards' || params.get('view') === 'yard' ? params.get('view') : null,
  };
  var keys = Object.keys(chosen).filter(function (key) { return chosen[key]; });
  keys.forEach(function (key) {
    root.dataset[key] = chosen[key];
    try { localStorage.setItem('agentGuild.' + key, chosen[key]); } catch (e) { /* storage unavailable */ }
  });
  if (keys.length) {
    try {
      localStorage.removeItem('agentGuild.panes');
      localStorage.removeItem('agentGuild.dock');
    } catch (e) { /* storage unavailable */ }
  }
}());
