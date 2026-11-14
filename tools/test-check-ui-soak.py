# Runs check-ui-soak.py on synthetic soak folders whose memory is flat once frames run and lower
# before the first frame, and requires a pass: the steady-state cutoff must not admit samples taken
# before the first frame. Usage: python tools/test-check-ui-soak.py
import csv, json, subprocess, sys, tempfile
from pathlib import Path

CHECKER = Path(__file__).with_name('check-ui-soak.py')


def soak(dir, page_clock_s, first_frame_s):
    """The page clock starts page_clock_s after the sampler, and the first frame first_frame_s after."""
    dir.mkdir()
    with (dir / 'frames.csv').open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['frame', 'cpu_ms', 'interval_ms', 'render_cpu_ms', 'latency_ms', 'handed_at_ms', 'acquire_start_at_ms', 'acquired_at_ms'])
        for i in range(2400):
            t = (first_frame_s - page_clock_s) * 1000 + 16.667 * i
            w.writerow([i, 1.0, 16.667, 1.0, 10.0, f'{t:.3f}', f'{t:.3f}', f'{t:.3f}'])
    sampler_start = 1_700_000_000_000
    (dir / 'host.log').write_text(f'page clock origin unix ms: {sampler_start + page_clock_s * 1000:.3f}\n'
                                  'ui-host first frame shown at game frame 0\n')
    (dir / 'ui-host.log').write_text('ui-host frames published: 100, skipped (no free ring slot): 0\n')
    (dir / 'soak.json').write_text(json.dumps([{'type': 'wait', 'frames': 2400}]))
    (dir / 'sampler-clock.json').write_text(json.dumps({'host_start_elapsed_s': 0.0, 'sampler_start_unix_ms': sampler_start}))
    with (dir / 'samples.csv').open('w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['elapsed_s', 'proc', 'pid', 'handles', 'working_set_mb', 'private_mb', 'gpu_dedicated_mb', 'window'])
        for s in range(1, 51):
            for proc, pid in (('host', 1), ('ui-host', 2)):
                mb = 100 if s < first_frame_s else 200
                w.writerow([f'{s:.1f}', proc, pid, 500, mb, mb, 50, '1280x720'])


failed = 0
with tempfile.TemporaryDirectory() as tmp:
    for name, page_clock_s, first_frame_s in (('late first frame', 0, 10), ('late page clock', 8, 10)):
        dir = Path(tmp) / name.replace(' ', '-')
        soak(dir, page_clock_s, first_frame_s)
        result = subprocess.run([sys.executable, str(CHECKER), str(dir), '60'], capture_output=True, text=True)
        ok = result.returncode == 0
        failed += not ok
        print(f'{name}: exit {result.returncode} {"pass" if ok else "FAIL"}')
        if not ok:
            print(result.stdout)
sys.exit(1 if failed else 0)
