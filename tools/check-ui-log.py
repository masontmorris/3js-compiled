import re
import sys
from pathlib import Path

log = Path(sys.argv[1]).read_text(encoding='utf-8')
matches = re.findall(r'frames published: (\d+), skipped \(no free ring slot\): (\d+)', log)
assert any(int(published) > 0 for published, _ in matches), 'missing publication and skip counters'
assert re.search(r'patch round trip ms: n=\d+ p50=', log), 'missing patch round trip timings'
print('UI log has running publication, skip, and round trip counters')
