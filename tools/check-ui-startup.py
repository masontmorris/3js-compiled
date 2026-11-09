import csv
import sys
from pathlib import Path
from PIL import Image

run = Path(sys.argv[1])
hz = float(sys.argv[2])
rows = list(csv.DictReader((run / 'frames.csv').open()))
assert len(rows) >= 2
elapsed = 0.0
intervals = []
for row in rows[1:]:
    interval = float(row['interval_ms'])
    elapsed += interval
    if elapsed <= 1000:
        intervals.append(interval)
assert max(intervals) <= 2000 / hz, (max(intervals), 2000 / hz)

def has_hud(path):
    image = Image.open(path).convert('RGB')
    reference = image.getpixel((image.width // 2, image.height // 2))
    return sum(max(abs(a - b) for a, b in zip(image.getpixel((x, y)), reference)) > 10
               for y in range(0, min(300, image.height), 2)
               for x in range(0, min(420, image.width), 2)) >= 40

files = sorted((run / 'frames').glob('*.png'))
assert files and not has_hud(files[0])
assert any(has_hud(file) for file in files[1:]), 'HUD never appeared'
print(f'Game precedes HUD; max first-second interval {max(intervals):.3f} ms')
