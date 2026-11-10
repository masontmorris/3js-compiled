import csv
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
hz = float(sys.argv[2])
ui = '--no-ui' not in sys.argv
rows = list(csv.DictReader((run / 'frames.csv').open()))
assert len(rows) >= 2
elapsed = 0.0
intervals = []
for frame, row in enumerate(rows[1:], start=1):
    interval = float(row['interval_ms'])
    elapsed += interval
    if elapsed <= 1000:
        intervals.append((frame, interval))
limit = 2000 / hz
over = [(frame, interval) for frame, interval in intervals if interval > limit]
worst = max(interval for _, interval in intervals)
frame0 = float(rows[0]['cpu_ms'])
shown = re.findall(r'ui-host first frame shown at game frame (\d+)', (run / 'host.log').read_text())
assert not over, f'frame 0 cpu {frame0:.2f} ms; {len(over)} first-second intervals over {limit:.3f} ms at frames {over[:6]}'
if ui:
    assert shown, 'HUD never appeared'
    assert int(shown[0]) > 1, f'HUD appeared on game frame {shown[0]}'
    print(f'HUD from game frame {shown[0]}; frame 0 cpu {frame0:.2f} ms; max first-second interval {worst:.3f} ms')
else:
    print(f'frame 0 cpu {frame0:.2f} ms; max first-second interval {worst:.3f} ms')
