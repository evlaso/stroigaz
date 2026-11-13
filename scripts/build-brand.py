# /// script
# dependencies = ["fonttools", "uharfbuzz"]
# ///
"""Build portable outlined SVG logos using the same Prosto One as the header.

Usage:
  uv run scripts/build-brand.py
      Rebuild everything from src/assets/logo-mark.svg.
  uv run scripts/build-brand.py --mark path/to/new-mark.svg
      Replace the mark first: take the paths of a supplied drawing (any frame,
      fill colour ignored), colour the outer flames #118A43 and the middle one
      #18A44E by their horizontal position, crop the viewBox to the outline
      bounds with the usual proportional margin and write
      src/assets/logo-mark.svg. Then rebuild everything as above.

Every run also renders the raster images from scripts/brand-templates/*.html
with headless Chromium (CHROME env var, chromium on PATH or the Playwright
cache): src/assets/apple-touch-icon.png and the mark area of
src/assets/og-image.png. Pass --no-raster to skip that step.
"""
from pathlib import Path
from io import BytesIO
import argparse
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--mark', type=Path, help='SVG drawing of a new three-flame mark')
parser.add_argument('--no-raster', action='store_true', help='do not render PNG images')
args = parser.parse_args()

# Margin around the outline bounds, as a share of the outline height.
MARK_MARGIN = 0.02066
# Outer flames and the middle flame, left to right.
MARK_COLORS = ['#118A43', '#18A44E', '#118A43']


def outline_bounds(ds):
    pen = BoundsPen(None)
    for d in ds:
        parse_path(d, pen)
    return pen.bounds


if args.mark:
    drawing = args.mark.read_text()
    ds = re.findall(r'<path[^>]* d="([^"]+)"', drawing)
    assert len(ds) == len(MARK_COLORS), f'Expected {len(MARK_COLORS)} paths, found {len(ds)}'
    assert 'transform' not in drawing, 'Flatten transforms before importing the mark'
    # Colour flames by position, keep the drawing order for the overlaps.
    centers = [sum(outline_bounds([d])[0::2]) / 2 for d in ds]
    rank = {i: n for n, i in enumerate(sorted(range(len(ds)), key=centers.__getitem__))}
    x0, y0, x1, y1 = outline_bounds(ds)
    pad = (y1 - y0) * MARK_MARGIN
    vb = (x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad)
    height = 73
    body = '\n'.join(f'<path d="{d}" fill="{MARK_COLORS[rank[i]]}"/>' for i, d in enumerate(ds))
    (root / 'src/assets/logo-mark.svg').write_text(
        f'<svg width="{round(height * vb[2] / vb[3])}" height="{height}" viewBox="{" ".join(f"{v:.3f}" for v in vb)}" fill="none" xmlns="http://www.w3.org/2000/svg">\n{body}\n</svg>\n')
out = root / 'src/assets/brand'
out.mkdir(exist_ok=True)
font = TTFont(root / 'src/assets/fonts/prosto-one/ProstoOne-Regular.ttf')
assert all(ord(c) in font.getBestCmap() for c in 'СТРОЙГАЗ'), 'Missing Cyrillic glyphs'
stream = BytesIO()
font.save(stream)
face = hb.Face(stream.getvalue())
hfont = hb.Font(face)
hfont.scale = (face.upem, face.upem)
buffer = hb.Buffer()
buffer.add_str('СТРОЙГАЗ')
buffer.guess_segment_properties()
hb.shape(hfont, buffer)
glyphs = font.getGlyphSet()
order = font.getGlyphOrder()
scale = 50 / font['OS/2'].sCapHeight
x = 86
# Match the header's subtle 0.018em outline.
letter_stroke = 0.018 * face.upem
letters = []
for info, pos in zip(buffer.glyph_infos, buffer.glyph_positions):
    pen = SVGPathPen(glyphs)
    glyphs[order[info.codepoint]].draw(pen)
    letters.append(f'<path transform="translate({x + pos.x_offset * scale:.4f} {72 - pos.y_offset * scale:.4f}) scale({scale:.8f} {-scale:.8f})" d="{pen.getCommands()}"/>')
    x += pos.x_advance * scale
source = (root / 'src/assets/logo-mark.svg').read_text()
def recolor(svg, color):
    if color is None:
        return svg
    return re.sub(r'fill="(?!none")[^"]+"', f'fill="{color}"', svg)

(root / 'src/assets/logo-mark-white.svg').write_text(recolor(source, '#FFFFFF'))
source_root = ET.fromstring(source)
# The header keeps the supplied green shades of the mark.
inline = re.sub(r'<svg[^>]*>', '<svg class="brand-mark" width="32" height="32" aria-hidden="true" viewBox="' + source_root.attrib['viewBox'] + '" fill="none" xmlns="http://www.w3.org/2000/svg">', source, count=1)
(root / 'src/_includes/brand-mark.njk').write_text(inline)
paths = '\n'.join(re.findall(r'<path[^>]+/>', source))
# Fit the mark's real outline bounds into the place of the previous symbol:
# y 2.205..84.897 in the wordmark's 88-unit layout, right edge 70.885
# (15.115 units before the first letter at x=86).
mark_vb = [float(v) for v in source_root.attrib['viewBox'].split()]
mark_x0, mark_y0, mark_x1, mark_y1 = outline_bounds(re.findall(r' d="([^"]+)"', source))
mark_top, mark_bottom, mark_right = 2.205, 84.897, 70.885
mark_scale = (mark_bottom - mark_top) / (mark_y1 - mark_y0)
mark_left = mark_right - (mark_x1 - mark_x0) * mark_scale
mark = f'<g transform="translate({mark_right - mark_x1 * mark_scale:.4f} {mark_top - mark_y0 * mark_scale:.4f}) scale({mark_scale:.8f})">{paths}</g>'
# Keep the previous 3.116-unit margin left of the mark and the same right edge.
logo_left = mark_left - 3.116
logo_right = 12 + x + 6
# A large Cyrillic С stays readable at browser-tab sizes.
favicon_glyph = glyphs[font.getBestCmap()[ord('С')]]
favicon_pen = SVGPathPen(glyphs)
favicon_glyph.draw(favicon_pen)
favicon_bounds = BoundsPen(glyphs)
favicon_glyph.draw(favicon_bounds)
left, bottom, right, top = favicon_bounds.bounds
favicon_scale = 19 / max(right - left, top - bottom)
favicon_x = 15.75 - (left + right) / 2 * favicon_scale
favicon_y = 16 + (bottom + top) / 2 * favicon_scale
favicon_stroke = 1.1 / favicon_scale
favicon = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#078844"/><path fill="#FFFFFF" stroke="#FFFFFF" stroke-width="{favicon_stroke:.4f}" stroke-linejoin="round" transform="translate({favicon_x:.4f} {favicon_y:.4f}) scale({favicon_scale:.8f} {-favicon_scale:.8f})" d="{favicon_pen.getCommands()}"/></svg>'
(root / 'src/assets/favicon.svg').write_text(favicon)

# None keeps the supplied green shades of the mark.
variants = [('color', None, '#25282B'), ('white', '#FFFFFF', '#FFFFFF'), ('mono', '#25282B', '#25282B')]
for name, ink, text in variants:
    symbol = recolor(mark, ink)
    (out / f'mark-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{source_root.attrib["viewBox"]}">{recolor(paths, ink)}</svg>')
    (out / f'logo-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{logo_left:.3f} 0 {logo_right - logo_left:.3f} 88">{symbol}<g fill="{text}" stroke="{text}" stroke-width="{letter_stroke:.4f}" stroke-linejoin="round" paint-order="stroke fill">{"".join(letters)}</g></svg>')
with zipfile.ZipFile(out / 'stroigaz-logos.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    # Only the downloadable variants; the folder also holds page illustrations.
    for file in sorted(out / f'{kind}-{name}.svg' for kind in ('logo', 'mark') for name, *_ in variants):
        archive.write(file, file.name)


def find_chrome():
    if os.environ.get('CHROME'):
        return os.environ['CHROME']
    for name in ('chromium', 'chromium-browser', 'google-chrome', 'chrome-headless-shell'):
        if shutil.which(name):
            return shutil.which(name)
    cache = Path.home() / '.cache/ms-playwright'
    found = sorted(cache.glob('chromium_headless_shell-*/chrome-*/chrome-headless-shell')) + sorted(cache.glob('chromium-*/chrome-linux*/chrome'))
    return str(found[-1]) if found else None


def render(template, size, target, **values):
    """Fill {{name}} placeholders of an HTML template and screenshot it."""
    html = (root / 'scripts/brand-templates' / template).read_text()
    for key, value in values.items():
        html = html.replace('{{' + key + '}}', value)
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / 'page.html'
        page.write_text(html)
        shot = Path(tmp) / 'shot.png'
        subprocess.run([chrome, '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
                        '--force-device-scale-factor=1', f'--window-size={size[0]},{size[1]}',
                        '--allow-file-access-from-files', f'--screenshot={shot}', page.as_uri()],
                       check=True, capture_output=True)
        # Chromium writes RGBA; the published images stay plain RGB.
        subprocess.run(['magick', str(shot), '-alpha', 'off', '-strip', f'PNG24:{target}'], check=True)


if not args.no_raster:
    chrome = find_chrome()
    assert chrome, 'Headless Chromium not found: set CHROME or pass --no-raster'
    white_mark = (root / 'src/assets/logo-mark-white.svg').read_text()
    # Apple touch icon: white mark, outline 128 px high, centred on 180 x 180.
    render('apple-touch-icon.html', (180, 180), root / 'src/assets/apple-touch-icon.png',
           mark=white_mark, height=f'{128 * (mark_vb[3] / (mark_y1 - mark_y0)):.3f}')
    # Open Graph: repaint only the mark area of the existing 1200 x 630 card;
    # the mark's viewBox sits at (80, 80) and is 88 px high.
    og = root / 'src/assets/og-image.png'
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / 'og-base.png'
        shutil.copy(og, base)
        render('og-image.html', (1200, 630), og, mark=white_mark, base=base.as_uri())
