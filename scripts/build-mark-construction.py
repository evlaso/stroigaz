# /// script
# dependencies = ["svgpathtools", "numpy"]
# ///
"""Draw the construction grid of the mark: src/assets/brand/mark-construction.svg.

Circles are least-squares fits to the larger arcs of the real outlines in
src/assets/logo-mark.svg, so the drawing shows the geometry the mark really has.
The arcs are picked by segment number; check them after a new mark is imported
(the script prints the fit error of each circle).

  uv run scripts/build-mark-construction.py
"""
from pathlib import Path
import re
import numpy as np
from svgpathtools import parse_path

root = Path(__file__).resolve().parents[1]
source = (root / 'src/assets/logo-mark.svg').read_text()
ds = re.findall(r' d="([^"]+)"', source)
# Paths in drawing order: right, middle, left flame.
flames = dict(zip('RML', (parse_path(d) for d in ds)))
# (flame, segment numbers) of the arcs that set the shape.
ARCS = [
    ('R', [9, 10]),  # outer belly of the right flame, centred on the axis
    ('R', [2]),      # inner curve of the right flame's tip
    ('M', [2]),      # left curve of the middle flame
    ('L', [2, 3]),   # outer belly of the left flame
    ('L', [7, 8]),   # inner curve at the base of the left flame
]


def fit(flame, segments):
    pts = np.array([[z.real, z.imag] for i in segments for z in (flames[flame][i].point(t) for t in np.linspace(0, 1, 40))])
    x, y = pts[:, 0], pts[:, 1]
    cx, cy, c = np.linalg.lstsq(np.c_[2 * x, 2 * y, np.ones(len(x))], x * x + y * y, rcond=None)[0]
    r = np.sqrt(c + cx * cx + cy * cy)
    return cx, cy, r, np.abs(np.hypot(x - cx, y - cy) - r).max()


circles = []
for flame, segments in ARCS:
    cx, cy, r, err = fit(flame, segments)
    print(f'{flame} {segments}: centre ({cx:.1f}, {cy:.1f}), r {r:.1f}, max deviation {err:.1f}')
    circles.append((cx, cy, r))

# The axis runs through the bottom tip, where the three flames meet.
bottom = max(seg.end.imag for path in flames.values() for seg in path)
tips = [seg.point(t) for path in flames.values() for seg in path for t in np.linspace(0, 1, 20)]
axis = float(np.mean([z.real for z in tips if z.imag > bottom - 1]))

# Room for every circle plus a small margin.
x0 = min(cx - r for cx, cy, r in circles) - 20
x1 = max(cx + r for cx, cy, r in circles) + 20
y0 = min(cy - r for cx, cy, r in circles) - 20
y1 = max(cy + r for cx, cy, r in circles) + 20
w, h = x1 - x0, y1 - y0
line = 'fill="none" vector-effect="non-scaling-stroke"'
cross = 9
parts = [
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.1f} {y0:.1f} {w:.1f} {h:.1f}" width="{w:.0f}" height="{h:.0f}">',
    '<title>Построение знака СТРОЙГАЗ</title>',
    f'<g stroke="#A3A8AE" stroke-width="1" {line}>',
    f'<line x1="{axis:.1f}" y1="{y0:.1f}" x2="{axis:.1f}" y2="{y1:.1f}"/>',
    *(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}"/>' for cx, cy, r in circles),
    '</g>',
    f'<g stroke="#777D85" stroke-width="1" {line}>',
    *(f'<path d="M{cx - cross:.1f} {cy:.1f}h{2 * cross}M{cx:.1f} {cy - cross:.1f}v{2 * cross}"/>' for cx, cy, r in circles),
    '</g>',
    '<g fill="#18A44E" fill-opacity="0.14" stroke="#25282B" stroke-width="1" vector-effect="non-scaling-stroke">',
    *(f'<path vector-effect="non-scaling-stroke" d="{d}"/>' for d in ds),
    '</g>',
    '</svg>',
]
(root / 'src/assets/brand/mark-construction.svg').write_text('\n'.join(parts) + '\n')
