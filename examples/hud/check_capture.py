import csv
from PIL import Image

image = Image.open("e2-hud.png").convert("RGBA")
seq_pixel = image.getpixel((10, 10))
seq = seq_pixel[0] | (seq_pixel[1] << 8) | (seq_pixel[2] << 16)
with open("frames.csv", newline="") as f:
    frames = [int(row["frame"]) + 1 for row in csv.DictReader(f)]
assert frames and 0 < seq <= frames[-1] and frames[-1] - seq < 30, (seq, frames[-1] if frames else None)
overlay = image.getpixel((60, 50))
assert 100 <= overlay[0] <= 155 and 100 <= overlay[2] <= 155, overlay
assert image.getpixel((500, 500))[2] > 240, image.getpixel((500, 500))
print(f"HUD sequence {seq}, game sequence {frames[-1]}, red overlay {image.getpixel((60, 50))}")
