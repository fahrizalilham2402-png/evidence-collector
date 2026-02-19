import sys
import cv2
import pytesseract
import re

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

img = cv2.imread(sys.argv[1])
if img is None:
    print("NOT_FOUND")
    print("NOT_FOUND")
    sys.exit(0)

h, w = img.shape[:2]
roi = img[int(h*0.75):int(h*0.95), 0:w]

gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
_, th = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY_INV)
big = cv2.resize(th, None, fx=3, fy=3)

text = pytesseract.image_to_string(
    big,
    config="--psm 6 -c tessedit_char_whitelist=-.0123456789"
)

numbers = re.findall(r"-?\d+\.\d+", text)

lat = None
lon = None

for n in numbers:
    val = float(n)
    if -11.0 <= val <= 6.0:
        lat = n
    elif 95.0 <= val <= 141.0:
        lon = n

if lat and lon:
    print(lat)
    print(lon)
else:
    print("NOT_FOUND")
    print("NOT_FOUND")
