# /// script
# dependencies = ["fonttools", "uharfbuzz"]
# ///
"""Build portable outlined SVG logos using the same Prosto One as the header."""
from pathlib import Path
from io import BytesIO
import re
import zipfile
import xml.etree.ElementTree as ET
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

root = Path(__file__).resolve().parents[1]
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
    return re.sub(r'fill="(?!none")[^"]+"', f'fill="{color}"', svg)

(root / 'src/assets/logo-mark-white.svg').write_text(recolor(source, '#FFFFFF'))
source_root = ET.fromstring(source)
inline = re.sub(r'<svg[^>]*>', '<svg class="brand-mark" width="32" height="32" aria-hidden="true" viewBox="' + source_root.attrib['viewBox'] + '" fill="none" xmlns="http://www.w3.org/2000/svg">', recolor(source, 'currentColor'), count=1)
(root / 'src/_includes/brand-mark.njk').write_text(inline)
mark = '\n'.join(re.findall(r'<path[^>]+/>', source))
# Normalize the supplied square symbol to the wordmark's 86-unit layout.
mark_scale = 86 / float(source_root.attrib['viewBox'].split()[3])
mark = f'<g transform="scale({mark_scale:.8f})">{mark}</g>'
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

variants = [('color', '#25282B', '#25282B'), ('white', '#FFFFFF', '#FFFFFF'), ('mono', '#25282B', '#25282B')]
for name, ink, text in variants:
    symbol = recolor(mark, ink)
    (out / f'mark-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 0 62 88">{symbol}</svg>')
    (out / f'logo-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 0 {x+6:.3f} 88">{symbol}<g fill="{text}" stroke="{text}" stroke-width="{letter_stroke:.4f}" stroke-linejoin="round" paint-order="stroke fill">{"".join(letters)}</g></svg>')
with zipfile.ZipFile(out / 'stroigaz-logos.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(out.glob('*.svg')):
        archive.write(file, file.name)
