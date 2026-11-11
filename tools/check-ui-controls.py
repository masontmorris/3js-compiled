# Per press of `host --entry tools/ui-repro/controls.js --script tools/ui-repro/controls.json`,
# the page's click events (click, auxclick, contextmenu, dblclick) from host.log, and any game
# pointer events, against the same case in an edge-ui-controls.mjs reference. A press is wrong
# when its click events differ from every Edge repeat of its case, or when the game received any
# of it.
# Usage: python tools/check-ui-controls.py <host.log> [reference, default tools/ui-repro/controls-edge.txt]
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

here = Path(__file__).parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(here / 'ui-repro'))
from controls import script

log = Path(sys.argv[1]).read_text(errors='replace')
reference = Path(sys.argv[2]) if len(sys.argv) > 2 else here / 'ui-repro' / 'controls-edge.txt'
trials = script()[1]
page = [(int(f), json.loads(e)) for e, f in re.findall(r'HUD event (\{.*?\}) at game frame (\d+)', log)]
game = [(k, int(f)) for k, f in re.findall(r'GAME (pointerdown|pointerup) x=-?\d+ button=-?\d+ at game frame (\d+)', log)]
CLICKS = ('click', 'auxclick', 'contextmenu', 'dblclick')


def fmt(e):
    path0 = f"/{e['path0']}" if e['path0'] != e['id'] else ''
    return f"{e['type']}:{e['id']}{path0}:b{e['button']}"


edge = defaultdict(set)
version = '?'
for line in reference.read_text(errors='replace').splitlines():
    if line.startswith('Edg/'):
        version = line.strip()
    m = re.match(r'CASE (\S+) \d+ clicks: (.*)$', line)
    if m:
        edge[m.group(1)].add(m.group(2).strip())
print(f'reference {version}; {len(page)} page events, {len(game)} game pointer events')

wrong = defaultdict(int)
for n, t in enumerate(trials):
    end = trials[n + 1]['start'] - 1 if n + 1 < len(trials) else 10 ** 9
    events = [e for f, e in page if t['start'] - 1 <= f < end]
    g = [k for k, f in game if t['start'] - 1 <= f < end]
    clicks = ' '.join(fmt(e) for e in events if e['type'] in CLICKS) or '-'
    want = edge.get(t['name'], set())
    ok = clicks in want and not g
    wrong[t['name']] += not ok
    print(f"{t['name']:7} {t['rep']} host: {clicks:40} edge: {' | '.join(sorted(want)) or '?':40} game: {g or '-'}"
          f"{'' if ok else '  <-- WRONG'}")
    print('          all: ' + ' '.join(f"{fmt(e)}@{e['x']}/{e['w']}" for e in events))
for name in dict.fromkeys(t['name'] for t in trials):
    print(f"case {name}: {wrong[name]} of {sum(t['name'] == name for t in trials)} wrong")
print(f'{sum(wrong.values())} of {len(trials)} presses wrong')
sys.exit(1 if sum(wrong.values()) else 0)
