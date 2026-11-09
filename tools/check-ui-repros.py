import csv
import statistics
import sys
from pathlib import Path
from PIL import Image

out = Path(sys.argv[1])
hz = float(sys.argv[2]) if len(sys.argv) > 2 else 169.0


def text(case, name):
    path = out / case / name
    return path.read_text(encoding='utf-8', errors='replace') if path.exists() else ''


def launches(case):
    return len([line for line in text(case, 'ui-host-pids.txt').split() if line.strip()])


def hud(case, png):
    path = out / case / png
    if not path.exists():
        return False
    gray = Image.open(path).convert('RGB').getpixel((300, 50))
    return all(abs(channel - 128) <= 2 for channel in gray)


def frames(case, start):
    rows = list(csv.DictReader((out / case / 'frames.csv').open()))[start:]
    return [float(r['cpu_ms']) for r in rows], [float(r['interval_ms']) for r in rows]


def check(case):
    log = text(case, 'host.log')
    if case == 'once':
        yield 'game receives the click', 'HUD event {"type":"click"}' in log
    elif case == 'big':
        yield 'one ui-host for the session', launches(case) == 1
        yield 'HUD shown at frame 720', hud(case, 'plain-720.png')
        yield 'game sees the rejection', 'send rejected: RangeError' in log
    elif case == 'resize':
        yield 'one ui-host for the session', launches(case) == 1
        yield 'HUD shown after the resizes', hud(case, 'resize-after.png')
    elif case == 'surrogate':
        yield 'click reaches the page', 'UIEV {"type":"click"}' in log
        yield 'click does not reach the game', 'GAMEPTR' not in log
        yield 'later events of the reply arrive', 'UIEV {"type":"after","tail":"plain"}' in log
    elif case in ('flood', 'plain'):
        cpu, intervals = frames(case, 120)
        yield f'cpu p50 {statistics.median(cpu):.3f} ms under 2 ms', statistics.median(cpu) < 2.0
        yield f'max interval {max(intervals):.3f} ms within {2000 / hz:.3f} ms', max(intervals) <= 2000 / hz
    elif case.startswith('pace'):
        yield from check_pacing(case)


def pacing(case):
    reports = [line for line in text(case, 'ui-host.log').splitlines() if 'patches received' in line]
    published = [int(line.split()[3].rstrip(',')) for line in text(case, 'ui-host.log').splitlines()
                 if line.startswith('ui-host frames published:')]
    evaluated = [sum(int(part.split()[1]) for part in line.split(' / ') if part.split()[0] in ('evaluated', 'polls'))
                 for line in reports]
    span = 5.0 * (len(evaluated) - 2)
    samples = [line.split(',') for line in text(case, 'ui-host-cpu.csv').splitlines()[1:]]
    samples = [(float(t), float(c)) for t, _, c in samples if float(t) >= 10.0]
    cpu = (samples[-1][1] - samples[0][1]) / (samples[-1][0] - samples[0][0]) * 1000.0
    return (evaluated[-1] - evaluated[1]) / span, (published[-1] - published[1]) / span, cpu


def check_pacing(case):
    evals, frames_per_s, cpu = pacing(case)
    yield f'{evals:.1f} evaluations/s, {frames_per_s:.1f} Servo frames/s, ui-host cpu {cpu:.0f} ms/s', \
        evals <= frames_per_s + 1.0


failed = 0
for case in sorted(p.name for p in out.iterdir() if p.is_dir()):
    for claim, ok in check(case):
        failed += not ok
        print(f'{case:9} {"pass" if ok else "FAIL"}  {claim}')
sys.exit(1 if failed else 0)
