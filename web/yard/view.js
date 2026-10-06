import { WORLDS, sessionPose } from './model.mjs';

const $ = id => document.getElementById(id);
const make = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, ...(text === undefined ? {} : { textContent: text }) });
// Fails a load that makes no progress for 30 s. start receives a callback
// for each sign of progress, which restarts the clock and reaches onProgress.
async function boundedLoad(start, onProgress) {
  let timer, stall, settled = false;
  const stalled = new Promise((resolve, reject) => { stall = reject; });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall(new Error('The Yard took too long to load.')), 30000);
  };
  arm();
  try {
    return await Promise.race([start(bytes => { if (!settled) { arm(); onProgress(bytes); } }), stalled]);
  } finally { settled = true; clearTimeout(timer); }
}
const megabytes = bytes => (bytes / 1048576).toFixed(1) + ' MB';

/** A layout with injected canonical controls. No API, sockets, or business rules. */
export function initYard(controller) {
  let selected = null, renderer = null, loading = null, failed = false, disposed = false;
  let sceneAttempt = 0, worldAttempt = 0, pendingRenderer = null, swapReveal = 0;
  const rows = new Map();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let view = root.dataset.view === 'yard' ? 'yard' : 'cards';
  let snapshot = controller.snapshot();
  let lastSkin = '', lastTheme = '';
  const sceneVisible = () => view === 'yard' && !$('app').hidden && document.visibilityState !== 'hidden' && $('terminal-panel').hidden;
  const skinEntry = (skin = root.dataset.skin) => (window.agentGuildSkins || []).find((item) => item.id === skin) || null;
  // A skin has a yard only when model.mjs has its world.
  const skinAllowsYard = (skin = root.dataset.skin) => Boolean(WORLDS[skin]);
  function select(next, { focus = false } = {}) {
    selected = next;
    updateInspector();
    for (const [key, row] of rows) row.setAttribute('aria-pressed', String(key === (next ? next.kind + ':' + next.id : '')));
    renderer?.select(next);
    if (focus) renderer?.focus(next);
    $('yard-focus').disabled = !next;
    $('yard-deselect').hidden = !next;
  }
  function updateInspector() {
    $('yard-welcome').hidden = Boolean(selected);
    controller.mountInspector($('yard-inspector'), selected);
  }
  function setView(next, { remember = true } = {}) {
    const allowed = skinAllowsYard();
    view = next === 'yard' && allowed ? 'yard' : 'cards';
    root.dataset.view = view;
    if (remember) { try { localStorage.setItem('agentGuild.view', next === 'yard' && allowed ? 'yard' : 'cards'); } catch {} }
    $('view-cards').checked = view === 'cards';
    const yardChoice = $('view-yard');
    yardChoice.checked = view === 'yard';
    yardChoice.disabled = !allowed;
    if (allowed) yardChoice.parentElement.removeAttribute('title');
    else yardChoice.parentElement.title = `${skinEntry()?.name || 'This skin'} has no yard yet.`;
    $('yard').hidden = view !== 'yard';
    $('providers').hidden = view === 'yard';
    $('providers').inert = view === 'yard';
    for (const section of document.querySelectorAll('#app > section.sessions, #app > section.news')) {
      section.hidden = view === 'yard';
      section.inert = view === 'yard';
    }
    if (view === 'yard') update();
    renderer?.setActive(sceneVisible());
  }
  function showLoading(text, mode) {
    $('yard-loading').dataset.mode = mode;
    $('yard-loading-text').textContent = text;
    $('yard-loading-size').textContent = '';
  }
  const loadingProgress = bytes => { $('yard-loading-size').textContent = bytes ? megabytes(bytes) : ''; };
  function hideLoading() {
    clearTimeout(swapReveal);
    $('yard-loading').hidden = true;
  }
  async function ensureScene() {
    if (disposed || renderer || loading || failed || view !== 'yard' || $('app').hidden) return;
    const attempt = ++sceneAttempt;
    showLoading('Preparing your yard…', 'scene');
    $('yard-loading').hidden = false;
    $('yard-failure').hidden = true;
    $('yard-swap-failure').hidden = true;
    loading = (async () => {
      let candidate;
      try {
        const { YardRenderer } = await import('./renderer.js');
        if (disposed || attempt !== sceneAttempt) return;
        candidate = new YardRenderer($('yard-stage'), $('yard-labels'), {
          select: next => select(next),
          open: id => controller.openSession(id),
          error: () => { if (attempt === sceneAttempt) failScene(); },
        });
        pendingRenderer = candidate;
        // Appearance can change while the first world is loading.
        let skin, theme;
        do {
          skin = root.dataset.skin; theme = root.dataset.theme;
          if (!WORLDS[skin]) { candidate.dispose(); return; }
          showLoading('Loading ' + WORLDS[skin].title + '…', 'scene');
          await boundedLoad(progress => candidate.setWorld(skin, theme, { progress }), loadingProgress);
        } while (!disposed && !candidate.disposed && attempt === sceneAttempt && (skin !== root.dataset.skin || theme !== root.dataset.theme));
        if (disposed || candidate.disposed || attempt !== sceneAttempt) { candidate.dispose(); return; }
        pendingRenderer = null;
        renderer = candidate;
        lastSkin = skin; lastTheme = theme;
        renderer.setReducedMotion(motion.matches);
        renderer.update(snapshot.providers, snapshot.sessions);
        renderer.select(selected);
        renderer.setActive(sceneVisible());
        hideLoading();
        $('yard-stage').dataset.ready = 'true';
      } catch (err) {
        candidate?.dispose();
        if (attempt === sceneAttempt && !disposed) {
          failScene();
          console.warn('Yard could not load:', err.message);
        }
      } finally { if (attempt === sceneAttempt) { loading = null; pendingRenderer = null; } }
    })();
    await loading;
  }
  function failScene() {
    const restoreFocus = $('yard-stage').contains(document.activeElement);
    sceneAttempt++; worldAttempt++; loading = null;
    pendingRenderer?.dispose(); pendingRenderer = null;
    failed = true;
    renderer?.dispose(); renderer = null;
    hideLoading();
    $('yard-swap-failure').hidden = true;
    $('yard-failure').hidden = false;
    $('yard-stage').dataset.ready = 'false';
    if (restoreFocus) $('yard-retry').focus();
  }
  function roster() {
    const host = $('yard-roster'), seen = new Set();
    const filter = $('yard-filter').value.trim().toLocaleLowerCase();
    const entries = [
      ...snapshot.providers.map(p => ({ kind:'provider', id:p.id, title:p.tool, sub:p.available ? 'Provider · Ready' : 'Provider · Not installed', color:p.color, search:p.vendor, status:p.available ? 'ready' : 'locked' })),
      ...snapshot.sessions.map(s => ({ kind:'session', id:s.id, title:s.name, sub:s.provider.tool + ' · ' + (sessionPose(s) === 'working' ? 'Working' : sessionPose(s) === 'exited' ? 'Exited' : 'Running'), color:s.provider.color, status:sessionPose(s), search:[s.cwd,s.account?.label,s.model?.name,s.id].join(' ') })),
    ];
    let visibleIndex = 0, matched = 0;
    for (const entry of entries) {
      const key = entry.kind + ':' + entry.id;
      seen.add(key);
      let row = rows.get(key);
      if (!row) {
        row = make('button','yard-row');
        row.type = 'button';
        row.dataset.key = key;
        row.append(make('span','yard-row-mark'), make('span','yard-row-copy'), make('span','yard-row-status'));
        row.children[1].append(make('span','yard-row-title'),make('span','yard-row-sub'));
        row.addEventListener('click',() => select({kind:entry.kind,id:entry.id}));
        row.addEventListener('dblclick',() => { if(entry.kind === 'session') controller.openSession(entry.id); });
        rows.set(key,row);
      }
      row.hidden = Boolean(filter && ![entry.title,entry.sub,entry.search].join(' ').toLocaleLowerCase().includes(filter));
      if (!row.hidden) matched++;
      row.dataset.status = entry.status;
      row.style.setProperty('--unit-color',entry.color || '#baaa80');
      row.children[0].textContent = entry.kind === 'provider' ? '⌂' : '◆';
      row.children[0].setAttribute('aria-hidden','true');
      row.children[1].children[0].textContent = entry.title;
      row.children[1].children[1].textContent = entry.sub;
      row.setAttribute('aria-pressed',String(selected?.kind === entry.kind && selected?.id === entry.id));
      row.setAttribute('aria-label',entry.title + ', ' + entry.sub);
      row.title = entry.title + '\n' + entry.sub;
      if (host.children[visibleIndex] !== row) host.insertBefore(row,host.children[visibleIndex] || null);
      visibleIndex++;
    }
    for (const [key,row] of rows) if (!seen.has(key)) { row.remove(); rows.delete(key); }
    $('yard-roster-count').textContent = String(snapshot.sessions.length) + ' sessions';
    $('yard-no-results').hidden = matched !== 0;
    $('yard-no-results').textContent = filter ? 'No providers or sessions match your search.' : 'No providers or sessions yet.';
  }
  // The current world stays up and usable while another loads, and after it
  // fails. A swap that is ready almost at once shows no progress.
  function swapWorld() {
    const current = renderer, attempt = ++worldAttempt, title = WORLDS[lastSkin].title;
    $('yard-swap-failure').hidden = true;
    hideLoading();
    showLoading('Loading ' + title + '…', 'swap');
    swapReveal = setTimeout(() => { if (attempt === worldAttempt) $('yard-loading').hidden = false; }, 250);
    const settle = () => renderer === current && attempt === worldAttempt && (hideLoading(), true);
    boundedLoad(progress => current.setWorld(lastSkin, lastTheme, { progress }), loadingProgress).then(() => {
      if (!settle()) return;
      current.update(snapshot.providers,snapshot.sessions); current.select(selected);
    }).catch(() => {
      if (!settle()) return;
      current.abandonWorld();
      $('yard-swap-failure-text').textContent = title + ' could not load.';
      $('yard-swap-failure').hidden = false;
    });
  }
  function update() {
    if (disposed || view !== 'yard') return;
    snapshot = controller.snapshot();
    if (selected && !(selected.kind === 'provider' ? snapshot.providers : snapshot.sessions).some(x => x.id === selected.id)) {
      const row = rows.get(selected.kind + ':' + selected.id);
      const restoreFocus = row?.contains(document.activeElement) || $('yard-inspector').contains(document.activeElement);
      select(null);
      if (restoreFocus) $('yard-filter').focus();
    }
    const world = WORLDS[root.dataset.skin];
    if (!world) return;
    $('yard-title').textContent = world.title;
    $('yard-subtitle').textContent = world.subtitle;
    const working = snapshot.sessions.filter(s => sessionPose(s) === 'working').length;
    const running = snapshot.sessions.filter(s => s.status === 'running').length;
    $('yard-summary').textContent = snapshot.connected ? working + ' working · ' + running + ' running' : 'Reconnecting…';
    roster();
    updateInspector();
    const news = snapshot.news?.items?.[0];
    let href = null;
    try { const url = new URL(news?.url); if (['https:','http:'].includes(url.protocol)) href=url.href; } catch {}
    $('yard-headline').hidden = !href;
    $('yard-news-empty').hidden = Boolean(href);
    if (href) { $('yard-headline').textContent = news.title; $('yard-headline').href = href; }
    if (renderer) {
      if (lastSkin !== root.dataset.skin || lastTheme !== root.dataset.theme) {
        if (!WORLDS[root.dataset.skin]) return;
        lastSkin = root.dataset.skin; lastTheme = root.dataset.theme;
        swapWorld();
      }
      renderer.update(snapshot.providers,snapshot.sessions);
      renderer.setActive(sceneVisible());
    } else ensureScene();
  }
  $('view-cards').addEventListener('change',() => setView('cards'));
  $('view-yard').addEventListener('change',() => { if (skinAllowsYard()) setView('yard'); });
  $('yard-cards').addEventListener('click',() => { setView('cards'); ($('settings').checkVisibility() ? $('settings') : $('menu-toggle')).focus(); });
  $('yard-retry').addEventListener('click',() => { failed=false; ensureScene(); });
  $('yard-swap-retry').addEventListener('click',() => {
    if ($('yard-swap-failure').contains(document.activeElement)) $('yard-stage').focus();
    $('yard-swap-failure').hidden = true;
    lastSkin = ''; lastTheme = '';
    update();
  });
  $('yard-filter').addEventListener('input',roster);
  $('yard-news').addEventListener('click',controller.openNews);
  $('yard-deselect').addEventListener('click',() => { select(null); $('yard-filter').focus(); });
  $('yard-fit').addEventListener('click',() => renderer?.overview());
  $('yard-focus').addEventListener('click',() => renderer?.focus(selected));
  $('yard-zoom-in').addEventListener('click',() => renderer?.zoom(1.2));
  $('yard-zoom-out').addEventListener('click',() => renderer?.zoom(1/1.2));
  $('yard-stage').addEventListener('keydown',event => {
    if (event.target !== $('yard-stage') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') { select(null); event.preventDefault(); }
    else if (event.key === 'Enter' && selected?.kind === 'session') { controller.openSession(selected.id); event.preventDefault(); }
    else if (event.key === '+' || event.key === '=') { renderer?.zoom(1.2); event.preventDefault(); }
    else if (event.key === '-') { renderer?.zoom(1/1.2); event.preventDefault(); }
    else if (event.key === 'Home') { renderer?.overview(); event.preventDefault(); }
    else if (event.key.startsWith('Arrow')) { renderer?.pan(event.key); event.preventDefault(); }
  });
  const visibility = () => { update(); renderer?.setActive(sceneVisible()); };
  // A skin change keeps the saved preference and only changes what is on screen.
  const onAppearance = () => {
    let preferYard = false;
    try { preferYard = localStorage.getItem('agentGuild.view') === 'yard'; } catch {}
    setView(preferYard && skinAllowsYard() ? 'yard' : 'cards', { remember: false });
    renderer?.setActive(sceneVisible());
  };
  const motionChange = () => renderer?.setReducedMotion(motion.matches);
  const pageHide = () => renderer?.setActive(false);
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === 'data-skin' || record.attributeName === 'data-theme')) onAppearance();
    else visibility();
  });
  observer.observe(root,{attributes:true,attributeFilter:['data-skin','data-theme']});
  observer.observe($('app'),{attributes:true,attributeFilter:['hidden']});
  observer.observe($('terminal-panel'),{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',visibility);
  motion.addEventListener('change',motionChange);
  window.addEventListener('pagehide',pageHide);
  window.addEventListener('pageshow',visibility);
  setView(view,{remember:false});
  return { update, select, setView, dispose() {
    disposed=true; sceneAttempt++; worldAttempt++; clearTimeout(swapReveal); observer.disconnect(); pendingRenderer?.dispose(); renderer?.dispose();
    document.removeEventListener('visibilitychange',visibility);
    motion.removeEventListener('change',motionChange);
    window.removeEventListener('pagehide',pageHide);
    window.removeEventListener('pageshow',visibility);
  } };
}
