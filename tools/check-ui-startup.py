import csv
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
hz = float(sys.argv[2])
ui = '--no-ui' not in sys.argv
rows = list(csv.DictReader((run / 'frames.csv').open()))
assert len(rows) >= 2
limit = 2000 / hz
intervals = [float(row['interval_ms']) for row in rows]
elapsed = 0.0
over = []
for frame, interval in enumerate(intervals[1:], start=1):
    if elapsed > 1000:
        break
    elapsed += interval
    if interval > limit:
        over.append((frame, round(interval, 3)))
text = f'over={len(over)}: first-second intervals over {limit:.3f} ms {over}'
if ui:
    shown = re.findall(r'ui-host first frame shown at game frame (\d+)', (run / 'host.log').read_text())
    assert shown, 'HUD never appeared'
    first = int(shown[0]) - 1
    assert first > 0, 'HUD appeared on the game\'s first frame'
    window = [(frame, round(intervals[frame], 3)) for frame in range(first, min(first + 31, len(intervals)))
              if intervals[frame] > limit]
    text = f'{text}; HUD from frame {first}; hud_over={len(window)}: intervals over the limit from it through 30 frames after {window}'
    hitch = [frame for frame, _ in window if frame <= first + 1]
    assert not hitch, f'{text}; frames {hitch} are the HUD\'s first frame or the next one'
print(text)
