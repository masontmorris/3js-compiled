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
elapsed = 0.0
over = []
for frame, row in enumerate(rows[1:], start=1):
    interval = float(row['interval_ms'])
    elapsed += interval
    if elapsed > 1000:
        break
    if interval > limit:
        over.append((frame, round(interval, 3)))
text = f'over={len(over)}: first-second intervals over {limit:.3f} ms {over}'
if ui:
    shown = re.findall(r'ui-host first frame shown at game frame (\d+)', (run / 'host.log').read_text())
    assert shown, 'HUD never appeared'
    first = int(shown[0]) - 1
    assert first > 0, 'HUD appeared on the game\'s first frame'
    late = [frame for frame, _ in over if frame >= first]
    assert not late, f'{text}; frames {late} are at or after the HUD\'s first frame {first}'
    text = f'{text}; HUD from frame {first}'
print(text)
