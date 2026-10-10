// Request ordering and paging are kept independent of the DOM so delayed responses
// can be exercised with explicitly released promises, without timers or a browser.
export function createHistoryPreview({ read, changed, authError = () => {} }) {
  let request = 0;
  const state = { target: null, messages: [], nextCursor: null, loading: false, error: null, incomplete: false, omitted: false };
  function clear(target = null) {
    request++;
    Object.assign(state, { target, messages: [], nextCursor: null, loading: false, error: null, incomplete: false, omitted: false });
    changed(state);
  }
  async function load(more = false) {
    if (!state.target || (more && (state.loading || !state.nextCursor))) return;
    const ticket = ++request;
    const target = state.target;
    const cursor = more ? state.nextCursor : null;
    Object.assign(state, { loading: true, error: null });
    if (!more) Object.assign(state, { messages: [], nextCursor: null, incomplete: false, omitted: false });
    changed(state);
    try {
      const detail = await read(target, cursor);
      if (request !== ticket) return;
      Object.assign(state, { messages: more ? [...state.messages, ...detail.messages] : detail.messages,
        nextCursor: detail.nextCursor, incomplete: detail.incomplete, omitted: state.omitted || detail.omitted });
    } catch (err) {
      if (request !== ticket) return;
      authError(err);
      state.error = err.message || 'The conversation could not be read.';
      // A stale cursor cannot be retried; other errors can retry the same page.
      if (err.code === 'history_changed') state.nextCursor = null;
    } finally {
      if (request === ticket) { state.loading = false; changed(state); }
    }
  }
  return { state, clear, select(target) { clear(target); return load(); }, refresh: () => load(), more: () => load(true) };
}
