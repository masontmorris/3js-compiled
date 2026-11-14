import csv
import statistics
import sys
from pathlib import Path

rows = list(csv.DictReader(Path(sys.argv[1]).open()))
shown_at = next(i for i, row in enumerate(rows) if int(row['mark_r']) == 255)
shown = rows[shown_at]
valid = []
for position, row in enumerate(rows):
    i, seq = int(row['index']), int(row['seq'])
    if position >= shown_at:
        assert seq != 0, ('missing HUD sequence', i)
    if 0 < seq <= i + 1:
        rgb = tuple(int(row[c]) for c in ('r', 'g', 'b'))
        assert rgb == (seq & 255, (seq >> 8) & 255, (seq >> 16) & 255), (i, seq, rgb)
        assert int(row['mark_r']) == 255
        valid.append(i + 1 - seq)
assert len(valid) >= 1200, len(valid)
if '--first' in sys.argv:
    first_index, first_seq = int(shown['index']), int(shown['seq'])
    assert 0 < first_seq <= first_index + 1, ('first HUD frame has invalid sequence', first_index, first_seq)
    first_delay = first_index + 1 - first_seq
    assert first_delay <= 5, ('first frame delay', first_delay)
median = statistics.median(valid[:1200])
assert median <= 5, ('median delay', median)
print(f'first HUD delay {valid[0]} frames; p50 {median} frames over 1200 frames')
