import csv
import statistics
import sys
from pathlib import Path

rows = list(csv.DictReader(Path(sys.argv[1]).open()))
valid = []
for row in rows:
    i, seq = int(row['index']), int(row['seq'])
    if 0 < seq <= i + 1:
        rgb = tuple(int(row[c]) for c in ('r', 'g', 'b'))
        assert rgb == (seq & 255, (seq >> 8) & 255, (seq >> 16) & 255), (i, seq, rgb)
        assert int(row['mark_r']) == 255
        valid.append(i + 1 - seq)
assert len(valid) >= 1200, len(valid)
if '--first' in sys.argv:
    assert valid[0] <= 5, ('first frame delay', valid[0])
median = statistics.median(valid[:1200])
assert median <= 5, ('median delay', median)
print(f'first HUD delay {valid[0]} frames; p50 {median} frames over 1200 frames')
