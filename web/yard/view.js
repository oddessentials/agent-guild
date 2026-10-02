import { WORLDS, sessionPose } from './model.mjs';

const $ = id => document.getElementById(id);
const make = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, ...(text === undefined ? {} : { textContent: text }) });

/** A layout with injected canonical controls. No API, sockets, or business rules. */
export function initYard(controller) {
  let selected = null, renderer = null, loading = null, failed = false, disposed = false;
  const rows = new Map();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let view = root.dataset.view === 'yard' ? 'yard' : 'cards';
  let snapshot = controller.snapshot();
  let lastSkin = '', lastTheme = '';
  const sceneVisible = () => view === 'yard' && !$('app').hidden && document.visibilityState !== 'hidden' && $('terminal-panel').hidden;
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
    view = next === 'yard' ? 'yard' : 'cards';
    root.dataset.view = view;
    if (remember) { try { localStorage.setItem('agentGuild.view', view); } catch {} }
    $('view-cards').setAttribute('aria-pressed', String(view === 'cards'));
    $('view-yard').setAttribute('aria-pressed', String(view === 'yard'));
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
  async function ensureScene() {
    if (renderer || loading || failed || view !== 'yard' || $('app').hidden) return;
    $('yard-loading').hidden = false;
    $('yard-failure').hidden = true;
    loading = (async () => {
      let candidate;
      try {
        const { YardRenderer } = await import('./renderer.js');
        if (disposed) return;
        candidate = new YardRenderer($('yard-stage'), $('yard-labels'), {
          select: next => select(next),
          open: id => controller.openSession(id),
          error: () => failScene(),
        });
        await candidate.setWorld(root.dataset.skin, root.dataset.theme);
        if (disposed) { candidate.dispose(); return; }
        renderer = candidate;
        lastSkin = root.dataset.skin; lastTheme = root.dataset.theme;
        renderer.setReducedMotion(motion.matches);
        renderer.update(snapshot.providers, snapshot.sessions);
        renderer.select(selected);
        renderer.setActive(sceneVisible());
        $('yard-loading').hidden = true;
        $('yard-stage').dataset.ready = 'true';
      } catch (err) {
        candidate?.dispose();
        failScene();
        console.warn('Yard could not load:', err.message);
      } finally { loading = null; }
    })();
    await loading;
  }
  function failScene() {
    failed = true;
    renderer?.dispose(); renderer = null;
    $('yard-loading').hidden = true;
    $('yard-failure').hidden = false;
    $('yard-stage').dataset.ready = 'false';
  }
  function roster() {
    const host = $('yard-roster'), seen = new Set();
    const filter = $('yard-filter').value.trim().toLocaleLowerCase();
    const entries = [
      ...snapshot.providers.map(p => ({ kind:'provider', id:p.id, title:p.tool, sub:p.available ? 'Provider · Ready' : 'Provider · Not installed', color:p.color, search:p.vendor, status:p.available ? 'ready' : 'locked' })),
      ...snapshot.sessions.map(s => ({ kind:'session', id:s.id, title:s.name, sub:s.provider.tool + ' · ' + (sessionPose(s) === 'working' ? 'Working' : sessionPose(s) === 'exited' ? 'Exited' : 'Running'), color:s.provider.color, status:sessionPose(s), search:[s.cwd,s.account?.label,s.model?.name,s.id].join(' ') })),
    ];
    let visibleIndex = 0;
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
      row.dataset.status = entry.status;
      row.style.setProperty('--unit-color',entry.color || '#baaa80');
      row.children[0].textContent = entry.kind === 'provider' ? '⌂' : '◆';
      row.children[1].children[0].textContent = entry.title;
      row.children[1].children[1].textContent = entry.sub;
      row.setAttribute('aria-pressed',String(selected?.kind === entry.kind && selected?.id === entry.id));
      if (host.children[visibleIndex] !== row) host.insertBefore(row,host.children[visibleIndex] || null);
      visibleIndex++;
    }
    for (const [key,row] of rows) if (!seen.has(key)) { row.remove(); rows.delete(key); }
    $('yard-roster-count').textContent = String(snapshot.sessions.length) + ' sessions';
  }
  function update() {
    if (disposed || view !== 'yard') return;
    snapshot = controller.snapshot();
    if (selected && !(selected.kind === 'provider' ? snapshot.providers : snapshot.sessions).some(x => x.id === selected.id)) select(null);
    const world = WORLDS[root.dataset.skin] || WORLDS.guild;
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
        lastSkin = root.dataset.skin; lastTheme = root.dataset.theme;
        renderer.setWorld(lastSkin,lastTheme).then(() => { renderer?.update(snapshot.providers,snapshot.sessions); renderer?.select(selected); }).catch(failScene);
      }
      renderer.update(snapshot.providers,snapshot.sessions);
      renderer.setActive(sceneVisible());
    } else ensureScene();
  }
  $('view-cards').addEventListener('click',() => setView('cards'));
  $('view-yard').addEventListener('click',() => setView('yard'));
  $('yard-cards').addEventListener('click',() => { setView('cards'); $('view-cards').focus(); });
  $('yard-retry').addEventListener('click',() => { failed=false; ensureScene(); });
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
  const observer = new MutationObserver(visibility);
  observer.observe(root,{attributes:true,attributeFilter:['data-skin','data-theme']});
  observer.observe($('app'),{attributes:true,attributeFilter:['hidden']});
  observer.observe($('terminal-panel'),{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',visibility);
  motion.addEventListener('change',() => renderer?.setReducedMotion(motion.matches));
  window.addEventListener('pagehide',() => { renderer?.setActive(false); });
  window.addEventListener('pageshow',visibility);
  setView(view,{remember:false});
  return { update, select, setView, dispose() { disposed=true; observer.disconnect(); renderer?.dispose(); document.removeEventListener('visibilitychange',visibility); } };
}
