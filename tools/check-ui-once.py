from PIL import Image
import sys
pixel = Image.open(sys.argv[1]).convert('RGB').getpixel((50, 50))
assert pixel == (77, 0, 0), pixel
print('One state snapshot reached the page')
