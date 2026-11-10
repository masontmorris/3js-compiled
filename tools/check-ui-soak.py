import csv
import json
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
hz = float(sys.argv[2]) if len(sys.argv) > 2 else 169.0
limit = 5.0
rows = list(csv.DictReader((run / 'samples.csv').open()))
log = (run / 'host.log').read_text()
shown = int(re.search(r'ui-host first frame shown at game frame (\d+)', log).group(1))
frames = list(csv.DictReader((run / 'frames.csv').open()))
seconds_at = lambda frame: sum(float(f['interval_ms']) for f in frames[1:frame]) / 1000.0
start, frame, resizes = seconds_at(shown), 0, 0
for step in json.loads((run / 'soak.json').read_text()):
    frame += step.get('frames', 0)
    resizes += step['type'] == 'resize'
    if resizes == 10 and step['type'] == 'resize':
        start = max(start, seconds_at(frame))
ui_log = (run / 'ui-host.log').read_text()
published, skipped = map(int, re.findall(r'frames published: (\d+), skipped \(no free ring slot\): (\d+)', ui_log)[-1])
assert len(set(r['pid'] for r in rows if r['proc'] == 'ui-host')) == 1, 'ui-host relaunched during the soak'
intervals = sorted(float(f['interval_ms']) for f in frames[shown:])
median = intervals[len(intervals) // 2]
at_vsync = abs(median - 1000.0 / hz) < 0.1 * 1000.0 / hz
print(f'{len(intervals)} frames after the HUD, {resizes} resizes, measured from {start:.1f} s, median interval {median:.3f} ms'
      f'{"" if at_vsync else f"  FAIL: not vsync at {hz} Hz"}')

failed = not at_vsync
for proc in ('host', 'ui-host'):
    for key, ruled in (('private_mb', True), ('handles', True), ('gpu_dedicated_mb', True), ('working_set_mb', False)):
        series = [r for r in rows if r['proc'] == proc and float(r['elapsed_s']) > start and r.get(key)]
        labelled = [r for r in series if r.get('window')]
        if 'window' in rows[0] and labelled:
            series = labelled
        if not series:
            failed |= ruled
            print(f'{proc:8} {key:16} no samples{"  FAIL" if ruled else ""}')
            continue
        first = series[0]
        last = [r for r in series if r.get('window') == first.get('window')][-1]
        minutes = (float(last['elapsed_s']) - float(first['elapsed_s'])) / 60.0
        a, b = float(first[key]), float(last[key])
        growth = (b - a) / a * 100.0
        ok = growth < limit or not ruled
        failed |= not ok
        end = (float(series[-1][key]) - a) / a * 100.0
        print(f'{proc:8} {key:16} {a:9.1f} -> {b:9.1f} ({growth:+6.2f}%, {(b - a) / minutes:+.3f}/min over {minutes:.1f} min'
              f' at {first.get("window") or "any size"}; last sample {end:+.2f}%){"" if not ruled else ("  pass" if ok else "  FAIL")}')
share = skipped / max(published + skipped, 1) * 100.0
skip_ok = skipped == 0 if resizes else share < 1.0
failed |= not skip_ok
print(f'skipped ring slots {skipped} of {published + skipped} ({share:.2f}%){"  pass" if skip_ok else "  FAIL"}')
sys.exit(1 if failed else 0)
