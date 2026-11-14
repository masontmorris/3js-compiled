import math
import re
import sys
from pathlib import Path

log = Path(sys.argv[1]).read_text(encoding='utf-8')
matches = re.findall(r'frames published: (\d+), skipped \(no free ring slot\): (\d+)', log)
assert any(int(published) > 0 for published, _ in matches), 'missing publication and skip counters'
timings = re.findall(r'patch round trip ms: n=(\d+) p50=(\S+) p95=(\S+)', log)
def complete(record):
    try:
        n, p50, p95 = record
        return int(n) > 0 and math.isfinite(float(p50)) and math.isfinite(float(p95))
    except ValueError:
        return False
assert any(complete(record) for record in timings), 'missing patch round trip timings'
print('UI log has running publication, skip, and round trip counters')
