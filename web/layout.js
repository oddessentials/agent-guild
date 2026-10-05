export const TOPBAR_INLINE_MIN = 900;
export const DOCK_PUSH_MIN = 1280;
export const DOCK_FULL_MAX = 639;
export const DOCK_DEFAULT = 420;
export const DOCK_MIN = 320;
export const DOCK_MAX = 720;
export const WORKSPACE_MIN = 560;
export const SPLIT_COLUMNS_MIN = 1000;
export const SPLIT_ROWS_MIN_HEIGHT = 620;
export const SPLIT_ROWS_MIN_WIDTH = 560;
export const SPLIT_RATIO_MIN = 0.25;

export function topbarInline(width) {
  return width >= TOPBAR_INLINE_MIN;
}

export function dockMode(width) {
  if (width <= DOCK_FULL_MAX) return 'full';
  return width >= DOCK_PUSH_MIN ? 'push' : 'over';
}

export function clampDockWidth(value, windowWidth) {
  const max = Math.max(DOCK_MIN, Math.min(DOCK_MAX, windowWidth - WORKSPACE_MIN));
  const wanted = typeof value === 'number' && !Number.isNaN(value) ? value : DOCK_DEFAULT;
  return Math.round(Math.min(max, Math.max(DOCK_MIN, wanted)));
}

export function stageBesideDock(windowWidth, dockWidth) {
  return dockMode(windowWidth) !== 'full' && windowWidth - dockWidth - 32 >= WORKSPACE_MIN;
}

export function splitMode(width, height) {
  if (width >= SPLIT_COLUMNS_MIN) return 'columns';
  if (width >= SPLIT_ROWS_MIN_WIDTH && height >= SPLIT_ROWS_MIN_HEIGHT) return 'rows';
  return null;
}

export function clampRatio(value) {
  const ratio = Number.isFinite(value) ? value : 0.5;
  return Math.min(1 - SPLIT_RATIO_MIN, Math.max(SPLIT_RATIO_MIN, ratio));
}

export function bindSplitter(handle, { axis = () => 'x', start, move, end, step = 24, home = null, endKey = null }) {
  let drag = null;
  const coord = (e) => (axis() === 'x' ? e.clientX : e.clientY);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, at: coord(e), from: start() };
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (drag?.id === e.pointerId) move(coord(e) - drag.at, drag.from);
  });
  const finish = (e) => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    handle.classList.remove('dragging');
    end();
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', (e) => {
    const back = axis() === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const forward = axis() === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back || e.key === forward) move(e.key === back ? -step : step, start());
    else if (e.key === 'Home' && home) home();
    else if (e.key === 'End' && endKey) endKey();
    else return;
    e.preventDefault();
    end();
  });
}

/**
 * Publishes the part of the window an on-screen keyboard leaves visible as
 * `--<name>-viewport-top`, `--<name>-viewport-bottom` and `--<name>-viewport-height`
 * on `element` while `shown()` holds. iOS Safari keeps fixed elements at their full
 * height under its keyboard and pans the page beneath them, so they must fit themselves.
 * `fitted(height)` runs after each update, with null while the element is not shown.
 */
export function bindVisibleViewport(element, name, { shown = () => !element.hidden, watch = [element], fitted = () => {} } = {}) {
  const viewport = window.visualViewport;
  const props = ['top', 'bottom', 'height'].map((edge) => `--${name}-viewport-${edge}`);
  let frame;
  const update = () => {
    if (!shown()) {
      for (const prop of props) element.style.removeProperty(prop);
      return fitted(null);
    }
    // Magnification belongs to the browser; it must not resize the layout.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const top = viewport?.offsetTop || 0;
    const height = viewport?.height ?? innerHeight;
    element.style.setProperty(props[0], `${top}px`);
    element.style.setProperty(props[1], `${Math.max(0, innerHeight - top - height)}px`);
    element.style.setProperty(props[2], `${height}px`);
    fitted(height);
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  addEventListener('resize', schedule);
  addEventListener('pageshow', schedule);
  const observer = new MutationObserver(schedule);
  for (const watched of watch) observer.observe(watched, { attributes: true, attributeFilter: ['hidden'] });
  schedule();
  return schedule;
}
