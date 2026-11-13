"""Writes the color-management fixtures to crates/host/tests/fixtures/color: one 64x32 image of eight 16x16 color
blocks in each encoding a browser color-manages, with Display P3 as the tagged space where there is one.
tools/platform/color-reference.mjs reads back what Edge makes of each. Needs Pillow:
    python tools/platform/color_fixtures.py <Display P3 ICC profile>
"""

import io
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image

COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (0, 255, 255), (128, 128, 128), (200, 100, 50), (30, 60, 90)]
OUT = Path(__file__).resolve().parents[2] / 'crates/host/tests/fixtures/color'


def pixels():
    image = Image.new('RGBA', (64, 32))
    for i, color in enumerate(COLORS):
        x, y = (i % 4) * 16, (i // 4) * 16
        image.paste(color + (255,), (x, y, x + 16, y + 16))
    return image


def chunk(kind, data):
    body = kind + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)


def png(extra):
    """A PNG of the blocks with `extra` chunks between IHDR and IDAT."""
    raw = b''.join(b'\0' + pixels().tobytes()[y * 256:(y + 1) * 256] for y in range(32))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 32, 8, 6, 0, 0, 0))
            + b''.join(chunk(kind, data) for kind, data in extra) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def main():
    icc = Path(sys.argv[1]).read_bytes()
    iccp = (b'iCCP', b'Display P3\0\0' + zlib.compress(icc))
    p3_chrm = struct.pack('>8I', 31270, 32900, 68000, 32000, 26500, 69000, 15000, 6000)
    OUT.mkdir(parents=True, exist_ok=True)
    files = {
        'plain.png': png([]),
        'iccp-p3.png': png([iccp]),
        'srgb.png': png([(b'sRGB', b'\0')]),
        'gama18.png': png([(b'gAMA', struct.pack('>I', 55556))]),
        'gama-chrm-p3.png': png([(b'gAMA', struct.pack('>I', 45455)), (b'cHRM', p3_chrm)]),
        'cicp-p3.png': png([(b'cICP', bytes([12, 13, 0, 1]))]),
        'cicp-srgb-iccp-p3.png': png([(b'cICP', bytes([1, 13, 0, 1])), iccp]),
        'srgb-gama18.png': png([(b'sRGB', b'\0'), (b'gAMA', struct.pack('>I', 55556))]),
        'srgb-iccp-p3.png': png([(b'sRGB', b'\0'), iccp]),
    }
    jpeg = io.BytesIO()
    pixels().convert('RGB').save(jpeg, 'JPEG', quality=100, subsampling=0, icc_profile=icc)
    files['p3.jpg'] = jpeg.getvalue()
    webp = io.BytesIO()
    pixels().save(webp, 'WEBP', lossless=True, icc_profile=icc)
    files['p3.webp'] = webp.getvalue()
    for name, data in files.items():
        (OUT / name).write_bytes(data)
    print(f'{len(files)} fixtures in {OUT}')


main()
