# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""Optical centring of project illustrations on /projects/ and the homepage.

Usage:
  uv run scripts/illustration-shift.py          # recompute and update the JSON
  uv run scripts/illustration-shift.py --check  # print the table, write nothing

Re-run after adding or replacing a project's illustration.

object-fit: contain centres an illustration by its frame, but many drawings are
lopsided: flanges, an open door, a tank beside the skid. For every project in
src/_data/caseStudies.json the script measures the horizontal centre of mass of
the colour illustration's alpha silhouette (colorIllustration; the contour
drawing shares its frame 1:1) and stores:

  illustrationShift  how far to move the picture so that centre lands on the
                     frame's axis, in percent of the picture's own width
                     (negative = to the left);
  illustrationRatio  width / height of the picture, which the CSS needs to know
                     the rendered width before the image loads.

Each pixel column is weighted by the square of its opacity sum, so solid bodies
outweigh thin protrusions (pipes, flanges, a door panel) and the axis settles
between the frame centre and the main body. src/assets/style.css
(.diagram-shifted) applies the shift and, where the frame is tight, trades at
most a few percent of scale for it, so nothing is ever cropped.
"""
from pathlib import Path
import argparse
import json

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src/_data/caseStudies.json"
POWER = 3


def measure(path: Path) -> tuple[float, float]:
    image = Image.open(path).convert("RGBA")
    alpha = np.asarray(image, dtype=np.float64)[..., 3] / 255.0
    height, width = alpha.shape
    weight = alpha.sum(axis=0) ** POWER
    centre = (weight * (np.arange(width) + 0.5)).sum() / weight.sum()
    return (width / 2 - centre) / width * 100, width / height


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="print only, do not write the JSON")
    args = parser.parse_args()

    text = DATA.read_text(encoding="utf-8")
    projects = json.loads(text)
    for index, project in enumerate(projects):
        source = project.get("colorIllustration")
        if not source:
            continue
        shift, ratio = measure(ROOT / "src" / source.lstrip("/"))
        values = {"illustrationShift": round(shift, 1), "illustrationRatio": round(ratio, 4)}
        print(f"{project['slug']:16} shift {values['illustrationShift']:+5.1f}%  ratio {values['illustrationRatio']:.4f}")
        if all(key in project for key in values):
            project.update(values)
        else:
            # Keep the new fields next to the pictures they describe.
            rebuilt = {}
            for key, value in project.items():
                if key not in values:
                    rebuilt[key] = value
                if key == "colorIllustration":
                    rebuilt.update(values)
            projects[index] = rebuilt

    output = json.dumps(projects, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        return
    if output != text:
        DATA.write_text(output, encoding="utf-8")
        print(f"Updated {DATA.relative_to(ROOT)}")
    else:
        print("No changes")


if __name__ == "__main__":
    main()
