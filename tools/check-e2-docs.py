import sys
from pathlib import Path

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('.')
plan = (root / 'docs/plan.md').read_text(encoding='utf-8')
testing = (root / 'docs/testing.md').read_text(encoding='utf-8')
assert 'cargo build --release --locked -p threejsc-host' in plan
assert 'cargo build --release --locked --manifest-path crates/ui-host/Cargo.toml' in plan
assert '[the build guide](build.md)' in plan
assert 'cargo test --workspace --locked' in plan
assert 'add `--manifest-path crates/ui-host/Cargo.toml` to each command' in plan
assert 'measure frames 6,000 through 8,999' in plan
assert '--no-ui' in testing and 'ui-host.log' in testing
print('E2 build and test instructions present')
