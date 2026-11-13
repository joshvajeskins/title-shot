"""Convert raw generated PNGs to web-sized WebP in web/public/art (keeps alpha)."""
import glob, os
from PIL import Image
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, '..', '..', 'web', 'public', 'art')
os.makedirs(OUT, exist_ok=True)
SIZES = {'arena-wide': 1920, 'arena-tall': 1080, 'keyart': 1920, 'lobby-wall': 1920, 'crowd-strip': 1800,
         'paper-texture': 512, 'promoter-vance': 720}
def width_for(name):
    if name in SIZES: return SIZES[name]
    if name.startswith('belt-'): return 1100
    if name.startswith('fighter-'): return 640
    if name.startswith('emblem-'): return 360
    return 900
for f in sorted(glob.glob(os.path.join(ROOT, 'raw', '*.png'))):
    name = os.path.splitext(os.path.basename(f))[0]
    dst = os.path.join(OUT, name + '.webp')
    if os.path.exists(dst) and os.path.getmtime(dst) > os.path.getmtime(f): continue
    im = Image.open(f)
    w = width_for(name)
    if im.width > w: im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(dst, 'WEBP', quality=82, method=6)
    print(name, im.size, im.mode, os.path.getsize(dst) // 1024, 'KB')
