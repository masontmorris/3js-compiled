import difflib
import hashlib
import io
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

VENDOR = Path(__file__).resolve().parent.parent / 'crates/ui-host/vendor'
CRATES = {
    'servo-script': ('0.7.0', '84ab625df5e83104d2b1ef7066f6fbc879d24be07c14438eb25f427657ed7fee', ()),
    'servo-fonts': ('0.7.0', '871ff64ee0d5269a3caeae5c0e758d8e0579987e0187edf86ae0307103359051', ('tests/',)),
}


def published(name, version, sha256):
    file = f'{name}-{version}.crate'
    cargo_home = Path(os.environ.get('CARGO_HOME', Path.home() / '.cargo'))
    cached = sorted(cargo_home.glob(f'registry/cache/*/{file}'))
    data = cached[0].read_bytes() if cached else urllib.request.urlopen(
        f'https://static.crates.io/crates/{name}/{file}').read()
    assert hashlib.sha256(data).hexdigest() == sha256, f'{file} does not match the crates.io checksum'
    prefix = f'{name}-{version}/'
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        return {m.name[len(prefix):]: archive.extractfile(m).read() for m in archive if m.isfile()}


def text(data):
    return data.decode('utf-8').splitlines(keepends=True)


def changes(name, version, sha256, dropped):
    upstream = published(name, version, sha256)
    root = VENDOR / name
    local = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}
    extra = sorted(set(local) - set(upstream))
    missing = sorted(p for p in set(upstream) - set(local) if not p.startswith(dropped))
    assert not extra, f'{name}: files not in the published crate: {extra}'
    assert not missing, f'{name}: published files missing from the vendored copy: {missing}'
    diff = []
    for path in sorted(set(local) & set(upstream)):
        if local[path] != upstream[path]:
            diff += difflib.unified_diff(text(upstream[path]), text(local[path]), f'a/{path}', f'b/{path}')
    return ''.join(diff)


write = '--write' in sys.argv
for name, (version, sha256, dropped) in CRATES.items():
    patch = VENDOR / f'{name}.patch'
    diff = changes(name, version, sha256, dropped)
    if write:
        patch.write_bytes(diff.encode('utf-8'))
    else:
        assert patch.read_bytes().decode('utf-8') == diff, f'{name} differs from {patch.name}'
    print(f'{name} {version} differs from crates.io only by {patch.name} ({sum(line.startswith("@@") for line in diff.splitlines())} hunks)')
