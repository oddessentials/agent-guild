"""Poly Haven (CC0) downloads for the Yard environments.

Files are cached in .cache/polyhaven and pinned by the MD5 the Poly Haven API
publishes, recorded in polyhaven.lock.json. A changed upstream file stops the
build instead of silently changing the art.
Run directly to prefetch: python concept-art/guild-yard/env/polyhaven.py
"""
import hashlib, json, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CACHE = ROOT / '.cache/polyhaven'
LOCK = HERE / 'polyhaven.lock.json'
API = 'https://api.polyhaven.com'

def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'agent-guild-yard-build'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def _md5(path):
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def _download(url, md5, path, lock):
    pinned = lock.get(url)
    if pinned and pinned != md5:
        raise SystemExit(f'Poly Haven changed {url}; review it and update {LOCK.name}')
    if not (path.exists() and _md5(path) == md5):
        data = _get(url)
        if hashlib.md5(data).hexdigest() != md5:
            raise SystemExit(f'Checksum mismatch downloading {url}')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    lock[url] = md5
    return path

def _save(lock):
    LOCK.write_text(json.dumps(dict(sorted(lock.items())), indent=1) + '\n', newline='\n')

def hdri(asset, res='4k'):
    entry = json.loads(_get(f'{API}/files/{asset}'))['hdri'][res]['hdr']
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    path = _download(entry['url'], entry['md5'], CACHE / asset / Path(entry['url']).name, lock)
    _save(lock)
    return path

def texture(asset, res='2k', maps=('Diffuse', 'nor_gl', 'Rough')):
    files = json.loads(_get(f'{API}/files/{asset}'))
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    result = {}
    for name in maps:
        entry = files[name][res]['jpg']
        result[name] = _download(entry['url'], entry['md5'], CACHE / asset / Path(entry['url']).name, lock)
    _save(lock)
    return result

def model(asset, res='1k'):
    """A model's .blend with its textures alongside, as Poly Haven lays them out."""
    entry = json.loads(_get(f'{API}/files/{asset}'))['blend'][res]['blend']
    lock = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    folder = CACHE / asset / res
    path = _download(entry['url'], entry['md5'], folder / Path(entry['url']).name, lock)
    for rel, inc in entry.get('include', {}).items():
        _download(inc['url'], inc['md5'], folder / rel, lock)
    _save(lock)
    return path

if __name__ == '__main__':
    import guild_env
    guild_env.fetch_all()
