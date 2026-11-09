import re
import sys
from pathlib import Path

private = [int(m) for m in re.findall(r'ui-host memory: .*private (\d+) MB', Path(sys.argv[1]).read_text(encoding='utf-8'))]
steady = private[12:]
assert len(steady) >= 24, ('too few 5 s memory samples after the first minute', len(private))
n = len(steady)
mean_x, mean_y = (n - 1) / 2, sum(steady) / n
slope = sum((x - mean_x) * (y - mean_y) for x, y in enumerate(steady)) / sum((x - mean_x) ** 2 for x in range(n))
per_minute = slope * 12
assert per_minute < 1.0, f'ui-host private memory grows {per_minute:.2f} MB/min'
print(f'ui-host private memory {steady[0]} to {steady[-1]} MB over {n * 5} s; slope {per_minute:.2f} MB/min')
