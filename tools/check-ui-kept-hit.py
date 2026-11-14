# Per trial: what the capture taken just before the click shows at the click point, and who got the click
# within 60 frames. Trials are 600 frames apart.
import json, re, sys
from pathlib import Path
from PIL import Image
caps, log = Path(sys.argv[1]), Path(sys.argv[2]).read_text(errors='replace')
game = [(int(x), int(f)) for x, f in re.findall(r'GAME pointerdown x=(\d+) at game frame (\d+)', log)]
hud = [int(f) for f in re.findall(r'HUD event \{"type":"click".*? at game frame (\d+)', log)]
script = json.load(open(Path(__file__).parent / 'ui-repro' / 'kept-hit.json'))
frame, starts = 0, []
for step in script:
    if step['type'] == 'wait': frame += step['frames']
    elif step['type'] == 'capture': frame += 1; starts.append(frame)
wrong = 0
captures = sorted(caps.glob('t*.png'))
if len(captures) != len(starts):
    sys.exit(f'expected {len(starts)} captures, found {len(captures)}')
for i, (path, start) in enumerate(zip(captures, starts)):
    x = int(path.stem.split('-x')[1])
    drawn = Image.open(path).convert('RGB').getpixel((x, 60)) == (0, 200, 0)
    near = lambda f: start <= f <= start + 60
    game_received = any(near(f) for gx, f in game if gx == x)
    page_received = any(near(f) for f in hud)
    to = ' and '.join(name for name, received in (('game', game_received), ('page', page_received)) if received) or 'nobody'
    ok = game_received == (not drawn) and page_received == drawn
    wrong += not ok
    print(f'{path.name}: button drawn at x={x}: {drawn}; click went to {to}{"" if ok else "  <-- WRONG"}')
print(f'{wrong} of {len(starts)} clicks disagree with the frame on screen')
sys.exit(1 if wrong or not starts else 0)
