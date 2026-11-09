import sys
from PIL import Image

image = Image.open(sys.argv[2]).convert("RGB")
checks = {
    "alpha": [((150, 150), (128, 0, 128)), ((600, 300), (0, 0, 255))],
    "opaque": [((100, 100), (64, 64, 64)), ((400, 100), (128, 128, 128)),
               ((680, 100), (192, 192, 192)), ((960, 100), (255, 128, 0))],
}
for point, expected in checks[sys.argv[1]]:
    actual = image.getpixel(point)
    assert all(abs(a - b) <= 2 for a, b in zip(actual, expected)), (point, actual, expected)
print(f"{sys.argv[1]} pixels match")
