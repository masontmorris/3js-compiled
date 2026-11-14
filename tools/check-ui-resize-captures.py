import sys
from pathlib import Path
from PIL import Image

captures = sorted(Path(sys.argv[1]).glob('*.png'))
assert captures, f'no captures in {sys.argv[1]}'
blank = [p.name for p in captures if Image.open(p).convert('RGB').getpixel((60, 50))[0] <= 100]
print(f'{len(captures) - len(blank)} of {len(captures)} captures show the HUD; blank: {blank}')
assert not blank, f'{len(blank)} captures without the HUD'
