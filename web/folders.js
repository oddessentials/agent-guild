export const RECENT_FOLDERS_MAX = 5;

export function readRecentFolders(text) {
  let list;
  try { list = JSON.parse(text); } catch { return []; }
  return Array.isArray(list) ? list.filter((dir) => typeof dir === 'string' && dir.trim()).slice(0, RECENT_FOLDERS_MAX) : [];
}

export function rememberFolder(list, dir, { caseless = false } = {}) {
  const key = (value) => (caseless ? value.toLowerCase() : value);
  return [dir, ...list.filter((known) => key(known) !== key(dir))].slice(0, RECENT_FOLDERS_MAX);
}

export function matchFolders(list, query) {
  const wanted = query.trim().toLowerCase();
  return wanted ? list.filter((dir) => dir.toLowerCase().includes(wanted)) : list;
}
