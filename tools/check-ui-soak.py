import csv
import json
import re
import sys
from pathlib import Path

run = Path(sys.argv[1])
hz = float(sys.argv[2]) if len(sys.argv) > 2 else 169.0
limit = 5.0
rows = list(csv.DictReader((run / 'samples.csv').open()))
clock = run / 'sampler-clock.json'
log = (run / 'host.log').read_text()
# The host logs its page clock's origin, the clock of frames.csv's handed_at_ms, and the sampler its
# own start, so their difference puts samples and frames on one timeline. Older folders lack one or
# both: they fall back to the host's process start, or to counting from frame 0.
sampler = json.loads(clock.read_text()) if clock.exists() else {}
page_origin = re.search(r'page clock origin unix ms: ([\d.]+)', log)
if page_origin and 'sampler_start_unix_ms' in sampler:
    offset = (float(page_origin.group(1)) - sampler['sampler_start_unix_ms']) / 1000.0
elif sampler:
    offset = sampler['host_start_elapsed_s']
    print('note: no page clock origin; timing from host process start')
else:
    offset = 0.0
    print('note: sampler clock offset unavailable; using legacy timing')
shown = int(re.search(r'ui-host first frame shown at game frame (\d+)', log).group(1))
frames = list(csv.DictReader((run / 'frames.csv').open()))
if sampler and frames and frames[0].get('handed_at_ms'):
    seconds_at = lambda frame: float(frames[min(frame, len(frames) - 1)]['handed_at_ms']) / 1000.0
else:
    seconds_at = lambda frame: sum(float(f['interval_ms']) for f in frames[1:frame]) / 1000.0
start, frame, resizes = seconds_at(shown), 0, 0
for step in json.loads((run / 'soak.json').read_text()):
    frame += step.get('frames', 0)
    reached_resize = step['type'] == 'resize' and frame < len(frames)
    resizes += reached_resize
    if resizes == 10 and reached_resize:
        start = max(start, seconds_at(frame))
print(f'{resizes} resizes reached')
assert len(frames) >= frame, f'incomplete soak: {len(frames)} frames recorded, {frame} scheduled'
ui_log = (run / 'ui-host.log').read_text()
published, skipped = map(int, re.findall(r'frames published: (\d+), skipped \(no free ring slot\): (\d+)', ui_log)[-1])
# The sampler writes a row with no pid when it finds no process, before ui-host starts or after
# it exits. Such a row has no readings.
missing = sum(not r['pid'] for r in rows)
rows = [r for r in rows if r['pid']]
assert len(set(r['pid'] for r in rows if r['proc'] == 'ui-host')) == 1, 'ui-host relaunched during the soak'
intervals = sorted(float(f['interval_ms']) for f in frames[shown:])
median = intervals[len(intervals) // 2]
at_vsync = abs(median - 1000.0 / hz) < 0.1 * 1000.0 / hz
print(f'{len(intervals)} frames after the HUD, {resizes} resizes, measured from {start:.1f} s, median interval {median:.3f} ms,'
      f' {missing} samples without a process'
      f'{"" if at_vsync else f"  FAIL: not vsync at {hz} Hz"}')

failed = not at_vsync
unjudged = False
# ui-host's private memory at one window size alternates between two levels, one per ring
# state, in runs of several samples, and a sample now and then carries the other size's GPU
# reading. So each window size is judged on its own, and the first third of its samples is
# compared with the last third by quartile: the lower quartile follows the lower level and the
# upper quartile the upper one, and neither moves for a stray sample. A size needs 6 samples
# in each third to be judged.
quartiles = lambda values: (values[len(values) // 4], values[(3 * len(values)) // 4])
for proc in ('host', 'ui-host'):
    for key, ruled in (('private_mb', True), ('handles', True), ('gpu_dedicated_mb', True), ('working_set_mb', False)):
        process_rows = [r for r in rows if r['proc'] == proc and float(r['elapsed_s']) - offset > start]
        windows = sorted({r.get('window') or 'any size' for r in process_rows})
        series = [r for r in process_rows if r.get(key)]
        judged = 0
        for window in windows:
            at = [r for r in series if (r.get('window') or 'any size') == window]
            if len(at) < 18:
                print(f'{proc:8} {key:16} {window:9} {len(at):3} samples, not judged')
                unjudged |= ruled
                continue
            judged += 1
            third = len(at) // 3
            early = quartiles(sorted(float(r[key]) for r in at[:third]))
            late = quartiles(sorted(float(r[key]) for r in at[-third:]))
            growth = [(b - a) / a * 100.0 if a else (float('inf') if b > 0 else 0.0)
                      for a, b in zip(early, late)]
            ok = max(growth) < limit or not ruled
            failed |= not ok
            print(f'{proc:8} {key:16} {window:9} {len(at):3} samples, {at[0]["elapsed_s"]}-{at[-1]["elapsed_s"]} s:'
                  f' low {early[0]:.1f} -> {late[0]:.1f} ({growth[0]:+.2f}%), high {early[1]:.1f} -> {late[1]:.1f} ({growth[1]:+.2f}%)'
                  f'{"" if not ruled else ("  pass" if ok else "  FAIL")}')
        if not judged and ruled:
            unjudged = True
            print(f'{proc:8} {key:16} no window size has 18 samples  NOT JUDGED')
share = skipped / max(published + skipped, 1) * 100.0
skip_ok = skipped == 0 if resizes else share < 1.0
failed |= not skip_ok
print(f'skipped ring slots {skipped} of {published + skipped} ({share:.2f}%){"  pass" if skip_ok else "  FAIL"}')
sys.exit(1 if failed else 2 if unjudged else 0)
