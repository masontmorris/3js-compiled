import sys
from pathlib import Path
from PIL import Image

frames = sorted(Path(sys.argv[1]).glob('*.png'))
need = float(sys.argv[2]) if len(sys.argv) > 2 else 0.95
red = lambda image, x, y: image.getpixel((x, y))[0] > 100
hud, stretched = [], []
for index, path in enumerate(frames):
    image = Image.open(path).convert('RGB')
    hud.append(red(image, 60, 50))
    if hud[-1] and not (red(image, 235, 50) and red(image, 60, 95)
                        and not red(image, 245, 50) and not red(image, 60, 105)):
        stretched.append(index)
assert any(hud), 'HUD never appeared'
first = hud.index(True)
after = hud[first:]
shown = sum(after) / len(after)
gaps = [i + first for i, h in enumerate(after) if not h]
print(f'{len(frames)} frames; HUD first at frame {first}; HUD on {sum(after)} of {len(after)} frames since ({shown:.1%}); frames without it: {gaps[:20]}; stretched: {stretched[:20]} ({len(stretched)})')
assert shown >= need, f'HUD on {shown:.1%} of frames, need {need:.0%}'
assert not stretched, f'{len(stretched)} frames show a stretched HUD'
