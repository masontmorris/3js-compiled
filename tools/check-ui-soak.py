import csv
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
limit = 5.0
rows = list(csv.DictReader((run / 'samples.csv').open()))
log = (run / 'host.log').read_text()
shown = int(re.search(r'ui-host first frame shown at game frame (\d+)', log).group(1))
frames = list(csv.DictReader((run / 'frames.csv').open()))
hud_at = sum(float(f['interval_ms']) for f in frames[1:shown]) / 1000.0
ui_log = (run / 'ui-host.log').read_text()
published, skipped = map(int, re.findall(r'frames published: (\d+), skipped \(no free ring slot\): (\d+)', ui_log)[-1])
assert len(set(r['pid'] for r in rows if r['proc'] == 'ui-host')) == 1, 'ui-host relaunched during the soak'

failed = False
for proc in ('host', 'ui-host'):
    series = [r for r in rows if r['proc'] == proc and float(r['elapsed_s']) > hud_at]
    first, last = series[0], series[-1]
    minutes = (float(last['elapsed_s']) - float(first['elapsed_s'])) / 60.0
    for key, ruled in (('private_mb', True), ('handles', True), ('working_set_mb', False)):
        a, b = float(first[key]), float(last[key])
        growth = (b - a) / a * 100.0
        ok = growth < limit or not ruled
        failed |= not ok
        rate = (b - a) / minutes
        print(f'{proc:8} {key:15} {a:9.1f} -> {b:9.1f} ({growth:+6.2f}%, {rate:+.3f}/min over {minutes:.1f} min)'
              f'{"" if not ruled else ("  pass" if ok else "  FAIL")}')
share = skipped / max(published + skipped, 1) * 100.0
failed |= share >= 1.0
print(f'skipped ring slots {skipped} of {published + skipped} ({share:.2f}%){"  pass" if share < 1.0 else "  FAIL"}')
sys.exit(1 if failed else 0)
