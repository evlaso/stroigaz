"""Crop each contour/metal pair to identical visible bounds after generation.
Requires rsvg-convert and Pillow; preserves each SVG's own coordinate system.
"""
from pathlib import Path
import re
import sys
import subprocess
import tempfile
from PIL import Image

paths = sorted(Path('src/assets/cases').glob('*-schematic.svg'))
paths += sorted(Path('src/assets/technologies').glob('*-schematic.svg'))
if len(sys.argv)>1:
    paths=[p for p in paths if p.parent.name==sys.argv[1] or p.stem==sys.argv[1]+'-schematic']
with tempfile.TemporaryDirectory(prefix='stroygaz-frames-') as temp:
    png = Path(temp) / 'frame.png'
    for line in paths:
        source = line.read_text()
        match = re.search(r'viewBox="([^"]+)"', source)
        vx, vy, vw, vh = map(float, match[1].split())
        subprocess.run(['rsvg-convert', '-w', '1520', '-o', str(png), str(line)], check=True)
        x0, y0, x1, y1 = Image.open(png).getchannel('A').getbbox()
        scale = 1520 / vw
        padding = 12
        bounds = [vx + x0 / scale - padding, vy + y0 / scale - padding,
                  (x1 - x0) / scale + 2 * padding, (y1 - y0) / scale + 2 * padding]
        frame = 'viewBox="' + ' '.join(f'{v:.3f}' for v in bounds) + '"'
        metal = Path(str(line).replace('-schematic.svg', '-color.svg'))
        for image in [line, metal]:
            image.write_text(re.sub(r'viewBox="[^"]+"', frame, image.read_text(), count=1))
print(f'{len(paths)} pairs framed identically')
