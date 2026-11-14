import json
import subprocess
from pathlib import Path

metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--no-deps', '--locked', '--format-version', '1']))
packages = {p['name']: p for p in metadata['packages']}
assert packages['threejsc-host']['license'] == 'MIT OR Apache-2.0'
assert packages['threejsc-ui']['license'] == 'MPL-2.0'
assert Path(packages['threejsc-ui']['manifest_path']).parent.joinpath('src/lib.rs').read_text().startswith('// This Source Code Form')
assert not any('Mozilla Public' in p.read_text(encoding='utf-8') for p in Path('crates/host/src').glob('*.rs'))
print('Host and UI package licenses match their source files')
