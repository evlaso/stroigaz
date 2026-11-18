# /// script
# dependencies = ["fonttools", "uharfbuzz"]
# ///
"""Build portable outlined SVG logos: the mark and «Стройгаз» in Onest 600.

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
from fontTools.varLib.instancer import instantiateVariableFont
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
WORDMARK = 'Стройгаз'
# Same weight and tracking as the header (.brand strong in style.css).
WORDMARK_WEIGHT = 600
WORDMARK_TRACKING = -0.02
FAVICON_WEIGHT = 750


def onest(weight):
    """A static instance of the variable Onest at the given weight."""
    return instantiateVariableFont(TTFont(root / 'src/assets/fonts/onest/Onest-Variable.ttf'), {'wght': weight})


font = onest(WORDMARK_WEIGHT)
assert all(ord(c) in font.getBestCmap() for c in WORDMARK), 'Missing Cyrillic glyphs'
stream = BytesIO()
font.save(stream)
face = hb.Face(stream.getvalue())
hfont = hb.Font(face)
hfont.scale = (face.upem, face.upem)
buffer = hb.Buffer()
buffer.add_str(WORDMARK)
buffer.guess_segment_properties()
hb.shape(hfont, buffer)
glyphs = font.getGlyphSet()
order = font.getGlyphOrder()
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
# The mark's real outline bounds take y 2.205..84.897 of the 88-unit layout,
# LOGO_MARGIN from the left edge of the viewBox; the same margin follows the
# last letter.
mark_vb = [float(v) for v in source_root.attrib['viewBox'].split()]
mark_x0, mark_y0, mark_x1, mark_y1 = outline_bounds(re.findall(r' d="([^"]+)"', source))
mark_top, mark_bottom = 2.205, 84.897
mark_height = mark_bottom - mark_top
LOGO_MARGIN = 3.116
mark_scale = mark_height / (mark_y1 - mark_y0)
mark_left = LOGO_MARGIN
mark_right = mark_left + (mark_x1 - mark_x0) * mark_scale
mark = f'<g transform="translate({mark_left - mark_x0 * mark_scale:.4f} {mark_top - mark_y0 * mark_scale:.4f}) scale({mark_scale:.8f})">{paths}</g>'
# Wordmark, in shares of the mark's outline height: cap height, the gap
# between the ink of the mark and of С, and the baseline below the mark's top.
CAP_HEIGHT = 0.57
GAP = 0.14
BASELINE = 0.82
scale = CAP_HEIGHT * mark_height / font['OS/2'].sCapHeight
baseline = mark_top + BASELINE * mark_height
tracking = WORDMARK_TRACKING * face.upem


def ink(glyph):
    pen = BoundsPen(glyphs)
    glyph.draw(pen)
    return pen.bounds


x = mark_right + GAP * mark_height - ink(glyphs[order[buffer.glyph_infos[0].codepoint]])[0] * scale
letters = []
for n, (info, pos) in enumerate(zip(buffer.glyph_infos, buffer.glyph_positions)):
    glyph = glyphs[order[info.codepoint]]
    pen = SVGPathPen(glyphs)
    glyph.draw(pen)
    letters.append(f'<path transform="translate({x + pos.x_offset * scale:.4f} {baseline - pos.y_offset * scale:.4f}) scale({scale:.8f} {-scale:.8f})" d="{pen.getCommands()}"/>')
    ink_right = x + (pos.x_offset + ink(glyph)[2]) * scale
    if n < len(buffer.glyph_infos) - 1:
        x += (pos.x_advance + tracking) * scale
logo_left = 0
logo_right = ink_right + LOGO_MARGIN
# A bold Cyrillic С from Onest stays readable at browser-tab sizes; its open
# side needs a quarter unit to the right to look centred.
favicon_font = onest(FAVICON_WEIGHT)
favicon_glyphs = favicon_font.getGlyphSet()
favicon_glyph = favicon_glyphs[favicon_font.getBestCmap()[ord('С')]]
favicon_pen = SVGPathPen(favicon_glyphs)
favicon_glyph.draw(favicon_pen)
favicon_bounds = BoundsPen(favicon_glyphs)
favicon_glyph.draw(favicon_bounds)
left, bottom, right, top = favicon_bounds.bounds
favicon_scale = 20 / max(right - left, top - bottom)
favicon_x = 16.25 - (left + right) / 2 * favicon_scale
favicon_y = 16 + (bottom + top) / 2 * favicon_scale
favicon = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#078844"/><path fill="#FFFFFF" transform="translate({favicon_x:.4f} {favicon_y:.4f}) scale({favicon_scale:.8f} {-favicon_scale:.8f})" d="{favicon_pen.getCommands()}"/></svg>'
(root / 'src/assets/favicon.svg').write_text(favicon)

# None keeps the supplied green shades of the mark.
variants = [('color', None, '#25282B'), ('white', '#FFFFFF', '#FFFFFF'), ('mono', '#25282B', '#25282B')]
for name, ink, text in variants:
    symbol = recolor(mark, ink)
    (out / f'mark-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{source_root.attrib["viewBox"]}">{recolor(paths, ink)}</svg>')
    (out / f'logo-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{logo_left:.3f} 0 {logo_right - logo_left:.3f} 88">{symbol}<g fill="{text}">{"".join(letters)}</g></svg>')
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
    # Open Graph: repaint only the logo area of the existing 1200 x 630 card.
    # The mark keeps its place: its viewBox at (80, 80), 88 px high.
    og = root / 'src/assets/og-image.png'
    og_unit = 88 / mark_vb[3]
    og_scale = (mark_y1 - mark_y0) * og_unit / mark_height
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / 'og-base.png'
        shutil.copy(og, base)
        render('og-image.html', (1200, 630), og, logo=(out / 'logo-white.svg').read_text(), base=base.as_uri(),
               left=f'{80 + (mark_x0 - mark_vb[0]) * og_unit - mark_left * og_scale:.3f}',
               top=f'{80 + (mark_y0 - mark_vb[1]) * og_unit - mark_top * og_scale:.3f}',
               height=f'{88 * og_scale:.3f}')
