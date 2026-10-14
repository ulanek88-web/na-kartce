"""Generuje ikony aplikacji (PIL): zielony kwadrat z żółtym krążkiem."""
from PIL import Image, ImageDraw
import os
out = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(out, exist_ok=True)
GREEN, YEL, DARK = (14, 122, 79), (255, 201, 60), (9, 80, 52)

def make(size, maskable=False, rounded=True):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable or not rounded:
        d.rectangle([0, 0, S, S], fill=GREEN)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * .22), fill=GREEN)
    r = S * (.24 if maskable else .30)
    c = S / 2
    d.ellipse([c - r, c - r, c + r, c + r], fill=YEL)
    r2 = r * .78
    d.pieslice([c - r, c - r, c + r, c + r], 20, 160, fill=(235, 176, 30))
    d.ellipse([c - r2 * .6, c - r2 * .75, c + r2 * .35, c + r2 * .2], fill=(255, 218, 110))
    return im.resize((size, size), Image.LANCZOS)

make(512).save(f'{out}/icon-512.png')
make(192).save(f'{out}/icon-192.png')
make(512, maskable=True).save(f'{out}/maskable-512.png')
make(180, rounded=False).save(f'{out}/apple-touch-icon.png')
make(32).save(f'{out}/favicon-32.png')
make(1024, rounded=False).save(os.path.join(out, '..', '..', 'tools', 'icon-source.png'))
print('ikony gotowe')
