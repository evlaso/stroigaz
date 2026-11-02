# /// script
# dependencies = ["fonttools", "uharfbuzz"]
# ///
"""Build portable outlined SVG logos using the same Days One as the header."""
from pathlib import Path
from io import BytesIO
import re
import zipfile
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

root = Path(__file__).resolve().parents[1]
out = root / 'src/assets/brand'
out.mkdir(exist_ok=True)
font = TTFont(root / 'src/assets/fonts/days-one/DaysOne-Regular.ttf')
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
scale = 70 / face.upem
x = 86
letters = []
for info, pos in zip(buffer.glyph_infos, buffer.glyph_positions):
    pen = SVGPathPen(glyphs)
    glyphs[order[info.codepoint]].draw(pen)
    letters.append(f'<path transform="translate({x + pos.x_offset * scale:.4f} {68 - pos.y_offset * scale:.4f}) scale({scale:.8f} {-scale:.8f})" d="{pen.getCommands()}"/>')
    x += pos.x_advance * scale
source = (root / 'src/assets/logo-mark.svg').read_text()
(root / 'src/assets/logo-mark-white.svg').write_text(source.replace('#118A43', '#FFFFFF'))
inline = source.replace('width="86" height="86"', 'class="brand-mark" width="32" height="32" aria-hidden="true"').replace('#118A43', 'currentColor')
(root / 'src/_includes/brand-mark.njk').write_text(inline)
mark = '\n'.join(re.findall(r'<path[^>]+/>', source))
favicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#078844" d="M0 0h32v32H0z"/></svg>'
(root / 'src/assets/favicon.svg').write_text(favicon)

variants = [('color', '#118A43', '#25282B'), ('white', '#FFFFFF', '#FFFFFF'), ('mono', '#25282B', '#25282B')]
for name, ink, text in variants:
    symbol = mark.replace('#118A43', ink)
    (out / f'mark-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 0 62 88">{symbol}</svg>')
    (out / f'logo-{name}.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 0 {x-8:.3f} 88">{symbol}<g fill="{text}" stroke="{text}" stroke-width="1.26" stroke-linejoin="round" paint-order="stroke fill">{"".join(letters)}</g></svg>')
with zipfile.ZipFile(out / 'stroigaz-logos.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(out.glob('*.svg')):
        archive.write(file, file.name)
