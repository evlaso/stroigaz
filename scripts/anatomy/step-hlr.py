#!/usr/bin/env python3
"""Visible STEP assembly contours, without replacing the site's primitive models.

Run with the scratchpad cadquery-ocp venv, ALWAYS in isolated mode (-I):
  /absolute/step-venv/bin/python -I scripts/anatomy/step-hlr.py \
    /absolute/model.stp --output-dir /absolute/scratchpad \
    --reference /absolute/reference.png \
    --current /absolute/dosing-step-schematic.svg --export-mesh

Input folders are untrusted DATA: no imports, commands or working-directory
changes from there. STEPCAF/XCAF preserves accumulated occurrence placements.
Orientation is R(rotation) * mirror in the ORIGINAL STEP XY axes, independent
of build-cases.mjs. Optional --shift ID=DX,DY relocates complete occurrence groups
in original STEP XY millimetres, BEFORE reflection/rotation. Descendants and
external accessory subtrees overlapping only that group's original XY bbox move
together (no Z restriction); shared inter-group pipes are not stretched. Select
by full occurrence path, unique XCAF label, or unique exact STEP name.
--shift-subtree ID=DX,DY moves only that occurrence's descendants: useful for
relocating a pipe support without capturing the nearby stationary panel.
The dosing default is mirror X / +350
degrees (opposite panel side); use --mirror / --rotation for other models.
--inventory-only writes occurrence-path/solid IDs, STEP names and world bounds.
--exclude-body ID / --exclude-name NAME are repeatable exact-match filters;
exclusions remove whole B-reps BEFORE HLR, not just their visible strokes.
The orthographic camera,
20 px default padding (--padding overrides it), 760x500 canvas, #383e43 ink
and 1.05 px strokes match line-scene.mjs.
Poly HLR uses an actual B-rep triangulation (not a wireframe or depth-image trace).
Exact HLR is available with --algorithm exact; large assemblies can take hours.

Threshold = longest world-axis B-rep bounding-box side / full assembly Z height.
Compound leaves are split into solids before filtering, to remove fasteners even
inside imported vendor components. Surviving parts retain their real geometry;
there is no name-based replacement, invented pipework or suppression of occlusion.
Use a lower threshold plus --suppress-fasteners to retain small functional pipe
fittings without restoring named standard bolts/nuts/washers. This opt-in matches
only hardware names, NOT PVC union nuts or unnamed imported component solids.
Fine features *within one surviving solid*, e.g. threads, may still be present.
Projected short chains are removed AFTER stitching, so smooth circles made of
many tiny segments survive. RDP simplification and quantized deduplication keep
SVG small. No hidden, seam (RgN) or tangent (Rg1) edges are emitted by default.

Optional mesh export writes render-metal.py's scene JSON, scaled to its usual
~300-unit lighting space, with smooth OCCT vertex normals and topology-preserving
VTK decimation (VTK is included in cadquery-ocp's dependencies). It does not run that
renderer or write any src/assets files. No packages outside the venv are needed
for SVG/mesh; PNGs/comparison additionally use system rsvg-convert and Pillow.
"""

import argparse
from collections import defaultdict
from html import escape
import json
import math
from pathlib import Path
import re
import resource
import subprocess
import time


WIDTH, HEIGHT, PAD = 760, 500, 20
VARIANTS = {'coarse': .06, 'medium': .035, 'fine': .02}


def log(message):
    print(message, flush=True)


def camera():
    a, e = map(math.radians, (55, 31))
    return ([math.sin(a), -math.cos(a), 0],
            [math.cos(a) * math.sin(e), math.sin(a) * math.sin(e), -math.cos(e)],
            [math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)])


def project(point):
    right, down, _ = camera()
    return tuple(sum(a * b for a, b in zip(point, axis)) for axis in (right, down))


def orientation_matrix(mirror, degrees):
    """Reflect original STEP X/Y, then rotate counterclockwise about +Z."""
    angle = math.radians(degrees)
    c, s = math.cos(angle), math.sin(angle)
    x, y = (-1 if mirror == 'x' else 1), (-1 if mirror == 'y' else 1)
    return ((c * x, -s * y, 0), (s * x, c * y, 0), (0, 0, 1))


def excluded_body(record, ids, names):
    return record['id'] in ids or record['name'] in names


def standard_fastener(name):
    """Conservative hardware names; a PVC union nut is functional geometry."""
    return bool(re.match(r'^(?:(?:Болт|Винт|Шпилька|Шайба)(?:\s|$)|'
                         r'Гайка\s+[МM]\d|(?:BOLT|SCREW|STUD|WASHER|NUT)(?:\s|$))',
                         name.strip(), re.IGNORECASE))


def parse_shift(value):
    try:
        selector, vector = value.rsplit('=', 1)
        dx, dy = map(float, vector.split(','))
        if not selector or not all(math.isfinite(v) for v in (dx, dy)):
            raise ValueError
        return selector, (dx, dy)
    except ValueError:
        raise argparse.ArgumentTypeError('Use --shift ID=DX,DY with finite XY millimetres.') from None


def in_subtree(identifier, root):
    return identifier == root or identifier.startswith(root + '/')


def union_bounds(boxes):
    boxes = [box for box in boxes if box is not None]
    if not boxes:
        return None
    return tuple(min(b[i] for b in boxes) for i in range(3)) + tuple(
        max(b[i + 3] for b in boxes) for i in range(3))


def shift_groups(occurrences, inventory, requests, subtree_requests=()):
    """Resolve against ORIGINAL bounds; independent of request order and exclusions.

    Explicit ancestry wins. Otherwise take the outermost accessory subtree whose
    XY bbox overlaps exactly one seed, preserving fittings protruding past the tank
    envelope (e.g. a sight tube). Nodes spanning multiple seeds are descended into;
    indivisible shared bodies stay fixed and are reported for explicit exclusion.
    Subtree-only requests never seed spatial accessory capture.
    No nearest-neighbour guessing, recursive bbox growth or partial-body shifts.
    """
    groups = []
    requests_with_modes = ([(r, False) for r in requests] +
                           [(r, True) for r in subtree_requests])
    for (selector, vector), subtree_only in requests_with_modes:
        matches = [n for n in occurrences if selector in
                   (n['id'], n['label'], n['name'], n['occurrence_name'])]
        if len(matches) != 1:
            raise ValueError(f'Shift selector {selector!r}: expected one occurrence, found {len(matches)}; '
                             'use a full occurrence path.')
        node = matches[0]
        if node['bounds'] is None:
            raise ValueError(f'Shift selector {selector!r} has no surface bodies.')
        if any(in_subtree(node['id'], g['id']) or in_subtree(g['id'], node['id']) for g in groups):
            raise ValueError('Duplicate/nested shift groups are not allowed.')
        groups.append({'selector': selector, 'id': node['id'], 'name': node['name'],
                       'subtree_only': subtree_only,
                       'delta_mm': [*vector, 0], 'original_bounds': node['bounds'],
                       'members': [], 'accessory_roots': []})
    assignments, spatial_roots, shared = {}, {}, []
    for node in occurrences:  # Preorder: an accessory's children inherit its assignment.
        explicit = [g for g in groups if in_subtree(node['id'], g['id'])]
        inherited = [g for root, g in spatial_roots.items() if in_subtree(node['id'], root)]
        if explicit or inherited:
            assignments[node['id']] = (explicit or inherited)[0]
            continue
        if node['bounds'] is None or any(in_subtree(g['id'], node['id']) for g in groups):
            continue
        box = node['bounds']
        hits = [g for g in groups if not g['subtree_only'] and
                all(min(box[i + 3], g['original_bounds'][i + 3]) >
                    max(box[i], g['original_bounds'][i]) + 1e-7 for i in (0, 1))]
        if len(hits) == 1:
            assignments[node['id']] = hits[0]
            spatial_roots[node['id']] = hits[0]
            hits[0]['accessory_roots'].append(node['id'])
    for record in inventory:
        occurrence = record['id'].rsplit('/solid:', 1)[0]
        group = assignments.get(occurrence)
        if group:
            record['shift_group'] = group['id']
            record['shift_mm'] = group['delta_mm']
            record['shifted_bounds'] = tuple(v + group['delta_mm'][i % 3]
                                              for i, v in enumerate(record['bounds']))
            group['members'].append(record['id'])
        elif groups:
            box = record['bounds']
            if sum(all(min(box[i + 3], g['original_bounds'][i + 3]) >
                        max(box[i], g['original_bounds'][i]) + 1e-7 for i in (0, 1))
                   for g in groups if not g['subtree_only']) > 1:
                shared.append(record['id'])
    return groups, shared


def simplify(points, tolerance):
    """Iterative Ramer-Douglas-Peucker, including closed chains."""
    if len(points) < 3:
        return points
    keep = {0, len(points) - 1}
    pending = [(0, len(points) - 1)]
    while pending:
        lo, hi = pending.pop()
        ax, ay = points[lo]
        bx, by = points[hi]
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        best, index = tolerance * tolerance, None
        for i in range(lo + 1, hi):
            px, py = points[i]
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / denom)) if denom else 0
            distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if distance > best:
                best, index = distance, i
        if index is not None:
            keep.add(index)
            pending.extend(((lo, index), (index, hi)))
    return [points[i] for i in sorted(keep)]


def stitch(polylines, snap=.06, minimum=.9, tolerance=.18):
    """Deduplicate segment graph; join degree-2 nodes, never across a junction."""
    vertices, segments = {}, set()
    adjacency = defaultdict(list)

    def vertex(p):
        key = tuple(round(v / snap) for v in p)
        vertices.setdefault(key, p)
        return key

    for points in polylines:
        for a, b in zip(points, points[1:]):
            ka, kb = vertex(a), vertex(b)
            if ka != kb:
                segments.add(tuple(sorted((ka, kb))))
    segments = sorted(segments)
    for i, (a, b) in enumerate(segments):
        adjacency[a].append(i)
        adjacency[b].append(i)
    visited, chains = set(), []

    def walk(start, edge):
        keys = [start]
        while edge not in visited:
            visited.add(edge)
            a, b = segments[edge]
            end = b if keys[-1] == a else a
            keys.append(end)
            if len(adjacency[end]) != 2:
                break
            edge = next((i for i in adjacency[end] if i not in visited), edge)
        points = [vertices[k] for k in keys]
        length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        if length >= minimum:
            chains.append(simplify(points, tolerance))

    for key, edges in sorted(adjacency.items()):
        if len(edges) != 2:
            for edge in edges:
                if edge not in visited:
                    walk(key, edge)
    for edge, (start, _) in enumerate(segments):
        if edge not in visited:
            walk(start, edge)
    return chains, len(segments)


def svg_text(chains, label):
    def number(v):
        return f'{v:.2f}'.rstrip('0').rstrip('.') if abs(v) >= .005 else '0'

    paths = []
    for points in chains:
        d = 'M' + 'L'.join(','.join(map(number, p)) for p in points)
        paths.append(d)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" class="iso-svg iso" data-theme="light" '
            f'data-frame="canvas" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" '
            f'aria-label="{escape(label, quote=True)}">'
            '<g fill="none" stroke="#383e43" stroke-width="1.05" '
            'stroke-linejoin="round" stroke-linecap="round">'
            f'<path d="{"".join(paths)}"/></g></svg>\n')


def rasterize(svg, png):
    subprocess.run(['rsvg-convert', '--width', str(WIDTH * 2), '--height', str(HEIGHT * 2),
                    '--output', str(png), str(svg)], check=True)


def comparison(args, records, height):
    from PIL import Image, ImageChops, ImageDraw, ImageFont

    cell_w, cell_h = 800, 650
    sheet = Image.new('RGB', (cell_w * (len(records) + 2), cell_h), '#f5f6f7')
    draw = ImageDraw.Draw(sheet)
    candidates = ['/usr/share/fonts/inter/InterVariable.ttf',
                  '/usr/share/fonts/TTF/DejaVuSans.ttf',
                  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    font_path = next((p for p in candidates if Path(p).exists()), None)
    if font_path is None:
        font_path = subprocess.check_output(['fc-match', '-f', '%{file}', 'sans-serif'], text=True)
    title = ImageFont.truetype(font_path, 24)
    small = ImageFont.truetype(font_path, 18)
    current_png = args.output_dir / 'dosing-hlr-current.png'
    rasterize(args.current, current_png)
    items = [(current_png, 'Утверждённые примитивы', args.current.name)]
    for name, record in records.items():
        ratio = record['threshold_ratio']
        items.append((args.output_dir / f'dosing-hlr-{name}.png',
                        'STEP-контур стало' if args.shift or args.shift_subtree else
                       {'coarse': 'Крупно', 'medium': 'Средне', 'fine': 'Мелко'}[name],
                      f'≥ {ratio * 100:g}% H = {height * ratio:.1f} мм; '
                      f'{record["kept_bodies"]} тел; {record["svg_bytes"] / 1024:.1f} КиБ'))
    items.append((args.reference, 'Референс конструкторов', 'Исходный ракурс; без зеркалирования'))
    for i, (path, caption, detail) in enumerate(items):
        x = i * cell_w
        draw.text((x + 24, 20), caption, font=title, fill='#292e32')
        draw.text((x + 24, 60), detail, font=small, fill='#596168')
        with Image.open(path) as source:
            source = source.convert('RGBA')
            # Remove only empty margins, not any CAD geometry.
            background = Image.new('RGBA', source.size, 'white')
            flat = Image.alpha_composite(background, source).convert('RGB')
            bbox = ImageChops.difference(flat, Image.new('RGB', flat.size, 'white')).getbbox()
            if bbox:
                source = source.crop(bbox)
            source.thumbnail((cell_w - 48, 510), Image.Resampling.LANCZOS)
            sheet.paste(source, (x + (cell_w - source.width) // 2,
                                110 + (510 - source.height) // 2), source)
        if i:
            draw.line((x, 0, x, cell_h), fill='#d8dcdf', width=2)
    sheet.save(args.output_dir / ('dosing-hlr-shift.png' if args.shift or args.shift_subtree else 'dosing-hlr-comparison.png'))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--algorithm', choices=('poly', 'exact'), default='poly')
    parser.add_argument('--mirror', choices=('none', 'x', 'y'), default='x',
                        help='Reflection in original STEP axes, BEFORE --rotation.')
    parser.add_argument('--rotation', type=float, default=350, help='Rotation about STEP +Z in degrees.')
    parser.add_argument('--shift', type=parse_shift, action='append', default=[], metavar='ID=DX,DY',
                        help='Move occurrence plus XY-overlapping accessories before orientation; repeatable, mm.')
    parser.add_argument('--shift-subtree', type=parse_shift, action='append', default=[], metavar='ID=DX,DY',
                        help='Move only occurrence descendants, without capturing spatial accessories; repeatable, mm.')
    parser.add_argument('--variants', choices=tuple(VARIANTS), nargs='+', default=list(VARIANTS))
    parser.add_argument('--exclude-body', action='append', default=[], metavar='ID',
                        help='Exclude exact occurrence-path/solid ID from inventory; repeatable.')
    parser.add_argument('--exclude-name', action='append', default=[], metavar='NAME',
                        help='Exclude exact STEP definition name; repeatable, affects all matching occurrences.')
    parser.add_argument('--suppress-fasteners', action='store_true',
                        help='Remove conservatively named standard hardware before HLR; keep PVC union nuts.')
    parser.add_argument('--inventory-only', action='store_true', help='Write body inventory without meshing/HLR.')
    parser.add_argument('--thresholds', type=float, nargs=3, default=list(VARIANTS.values()),
                        metavar=('COARSE', 'MEDIUM', 'FINE'))
    parser.add_argument('--deflection', type=float, default=1.5, help='Absolute mesh deflection in mm.')
    parser.add_argument('--angular-deflection', type=float, default=.3, help='Mesh angular deflection in radians.')
    parser.add_argument('--min-chain', type=float, default=.9, help='Minimum stitched chain length in canvas px.')
    parser.add_argument('--padding', type=float, default=PAD, help='Canvas inset in px (default: 20).')
    parser.add_argument('--simplify', type=float, default=.18, help='RDP tolerance in canvas px.')
    parser.add_argument('--tangent-edges', action='store_true', help='Also include visible Rg1 edges.')
    parser.add_argument('--export-mesh', action='store_true', help='Export medium scene for render-metal.py.')
    parser.add_argument('--mesh-triangles', type=int, default=100000,
                        help='Target exported triangles (preserved boundaries can limit reduction).')
    parser.add_argument('--no-png', action='store_true')
    parser.add_argument('--current', type=Path)
    parser.add_argument('--reference', type=Path)
    args = parser.parse_args()
    for path in (args.input, args.output_dir, args.current, args.reference):
        if path is not None and not path.is_absolute():
            parser.error('All paths must be absolute (untrusted input directory is data only).')
    if args.output_dir.resolve() == args.input.parent.resolve():
        parser.error('Output directory must not be the untrusted input directory.')
    if not all(0 <= value < 1 for value in args.thresholds) or args.thresholds != sorted(args.thresholds, reverse=True):
        parser.error('Thresholds must descend from coarse to fine, in [0, 1).')
    if min(args.deflection, args.angular_deflection) <= 0 or min(args.min_chain, args.simplify) < 0:
        parser.error('Mesh tolerances must be positive; chain/simplify tolerances nonnegative.')
    if args.mesh_triangles < 1:
        parser.error('--mesh-triangles must be positive.')
    if not math.isfinite(args.rotation):
        parser.error('--rotation must be finite.')
    if not math.isfinite(args.padding) or not 0 <= args.padding < min(WIDTH, HEIGHT) / 2:
        parser.error('--padding must be finite and in [0, 250).')
    if args.export_mesh and 'medium' not in args.variants:
        parser.error('--export-mesh needs --variants medium.')
    if bool(args.current) != bool(args.reference):
        parser.error('--current and --reference must be supplied together.')
    if args.no_png and args.current:
        parser.error('Comparison needs PNG output.')
    args.output_dir.mkdir(parents=True, exist_ok=True)

    from OCP.Bnd import Bnd_Box
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape, HLRBRep_PolyAlgo, HLRBRep_PolyHLRToShape
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_Tool
    try:
        from OCP.TDF import TDF_LabelSequence
    except ImportError:
        from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Compound
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

    as_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face
    as_edge = getattr(TopoDS, 'Edge_s', None) or TopoDS.Edge

    started = time.perf_counter()
    timings = {}
    reader = STEPCAFControl_Reader()
    Interface_Static.SetCVal_s('xstep.cascade.unit', 'MM')
    reader.SetNameMode(True)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)
    if reader.ReadFile(str(args.input)) != IFSelect_RetDone:
        raise RuntimeError('STEP read failed')
    timings['read'] = round(time.perf_counter() - started, 3)
    log(f'STEP parsed: {timings["read"]}s; transferring…')
    tick = time.perf_counter()
    doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    if not reader.Transfer(doc):
        raise RuntimeError('STEPCAF/XCAF transfer failed')
    timings['transfer'] = round(time.perf_counter() - tick, 3)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    tick = time.perf_counter()

    def bounds(shape):
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(shape, box, False, False)
        if box.IsVoid():
            return None
        return (*box.CornerMin().Coord(), *box.CornerMax().Coord())

    def compound(shapes):
        result = TopoDS_Compound()
        builder = BRep_Builder()
        builder.MakeCompound(result)
        for shape in shapes:
            builder.Add(result, shape)
        return result

    # Keep shapes in original world coordinates while measuring thresholds.
    bodies, inventory, occurrences, leaves = [], [], [], 0
    measured = {}

    def entry(label):
        text = TCollection_AsciiString()
        TDF_Tool.Entry_s(label, text)
        return text.ToCString()

    def visit(label, parent, path=()):
        nonlocal leaves
        path = (*path, entry(label))
        definition, world = label, parent
        if tool.IsReference_s(label):
            definition = TDF_Label()
            if not tool.GetReferredShape_s(label, definition):
                raise RuntimeError('Unresolved STEP occurrence')
            world = world.Multiplied(tool.GetLocation_s(label))
        def label_name(item):
            attr = TDataStd_Name()
            return attr.Get().ToExtString() if item.FindAttribute(TDataStd_Name.GetID_s(), attr) else ''

        node = {'id': '/'.join(path), 'label': entry(label), 'definition': entry(definition),
                'name': label_name(definition), 'occurrence_name': label_name(label), 'bounds': None}
        occurrences.append(node)
        first_body = len(inventory)
        if tool.IsAssembly_s(definition):
            children = TDF_LabelSequence()
            tool.GetComponents_s(definition, children, False)
            for i in range(1, children.Length() + 1):
                visit(children.Value(i), world, path)
            node['bounds'] = union_bounds(r['bounds'] for r in inventory[first_body:])
            return
        shape = tool.GetShape_s(definition)
        if shape.IsNull():
            return
        leaves += 1
        shape = shape.Moved(world)
        solids = TopExp_Explorer(shape, TopAbs_SOLID)
        parts = []
        while solids.More():
            parts.append(solids.Current())
            solids.Next()
        if not parts and TopExp_Explorer(shape, TopAbs_FACE).More():
            parts = [shape]
        attr = TDataStd_Name()
        name = attr.Get().ToExtString() if definition.FindAttribute(TDataStd_Name.GetID_s(), attr) else ''
        for index, part in enumerate(parts, 1):
            # Located repeated bodies reuse translation-invariant size only.
            key = (part.TShape(), tuple(round(part.Location().Transformation().Value(i, j), 8)
                                       for i in range(1, 4) for j in range(1, 4)))
            if key not in measured:
                box = bounds(part)
                if box is None:
                    continue
                measured[key] = max(box[i + 3] - box[i] for i in range(3))
            box = bounds(part)
            if box is None:
                continue
            record = {'id': '/'.join(path) + f'/solid:{index}', 'name': name,
                      'definition': entry(definition), 'bounds': box, 'longest_mm': measured[key]}
            inventory.append(record)
            bodies.append((part, measured[key]))
        node['bounds'] = union_bounds(r['bounds'] for r in inventory[first_body:])

    roots = TDF_LabelSequence()
    tool.GetFreeShapes(roots)
    for i in range(1, roots.Length() + 1):
        visit(roots.Value(i), TopLoc_Location())
    if not bodies:
        raise RuntimeError('No surface bodies in STEP')
    full = compound(shape for shape, _ in bodies)
    full_bounds = bounds(full)
    height = full_bounds[5] - full_bounds[2]
    if height <= 0:
        raise RuntimeError('Assembly has no Z height')
    timings['inventory'] = round(time.perf_counter() - tick, 3)
    log(f'{leaves} leaves / {len(bodies)} bodies; H={height:.2f}mm; inventory {timings["inventory"]}s')
    unknown = set(args.exclude_body) - {record['id'] for record in inventory}
    unknown_names = set(args.exclude_name) - {record['name'] for record in inventory}
    if unknown or unknown_names:
        parser.error(f'Unknown exclusions: {sorted(unknown | unknown_names)}')
    try:
        groups, shared = shift_groups(occurrences, inventory, args.shift, args.shift_subtree)
    except ValueError as exc:
        parser.error(str(exc))
    excluded = [record for record in inventory if excluded_body(record, args.exclude_body, args.exclude_name)]
    fasteners = [record for record in inventory if args.suppress_fasteners and
                 standard_fastener(record['name']) and record not in excluded]
    removed_ids = {record['id'] for record in excluded + fasteners}
    (args.output_dir / 'dosing-hlr-inventory.json').write_text(
        json.dumps({'source': str(args.input), 'assembly_height_mm': height, 'bodies': inventory,
                     'occurrences': occurrences, 'shift_groups': groups, 'unshifted_shared_bodies': shared,
                     'excluded': excluded, 'suppressed_fasteners': fasteners}, ensure_ascii=False, indent=2) + '\n')
    if args.inventory_only:
        return
    relocated, active_records = [], []
    for (shape, size), record in zip(bodies, inventory):
        if record['id'] in removed_ids:
            continue
        if 'shift_mm' in record:
            translation = gp_Trsf()
            translation.SetTranslation(gp_Vec(*record['shift_mm']))
            shape = shape.Moved(TopLoc_Location(translation))
        relocated.append((shape, size))
        active_records.append(record)
    bodies = relocated
    tick = time.perf_counter()
    matrix = orientation_matrix(args.mirror, args.rotation)
    orientation = gp_Trsf()
    orientation.SetValues(*(value for row in matrix for value in (*row, 0)))
    # Transform together: shared topology remains shared and gets meshed once.
    selected = [(shape, size) for shape, size in bodies if size >= min(args.thresholds) * height]
    selected_records = [record for (_, size), record in zip(bodies, active_records)
                        if size >= min(args.thresholds) * height]
    if not selected:
        parser.error('Exclusions/thresholds removed every body.')
    transformed = BRepBuilderAPI_Transform(compound(shape for shape, _ in selected), orientation, True)
    parts = [(transformed.ModifiedShape(shape), size) for shape, size in selected]
    mesh = BRepMesh_IncrementalMesh(transformed.Shape(), args.deflection, False,
                                   args.angular_deflection, True)
    if not mesh.IsDone():
        raise RuntimeError('Assembly meshing failed')
    timings['transform_mesh'] = round(time.perf_counter() - tick, 3)
    log(f'{len(parts)} selected bodies meshed in {timings["transform_mesh"]}s')

    # Fit to actual full mesh vertices, not loose projected bounding-box corners.
    # A shared envelope across variants makes threshold comparisons meaningful.
    projected, triangle_count = [], 0
    faces = TopExp_Explorer(transformed.Shape(), TopAbs_FACE)
    while faces.More():
        face = as_face(faces.Current())
        location = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, location)
        if tri is not None:
            triangle_count += tri.NbTriangles()
            trsf = location.Transformation()
            for i in range(1, tri.NbNodes() + 1):
                projected.append(project(tri.Node(i).Transformed(trsf).Coord()))
        faces.Next()
    if not projected:
        raise RuntimeError('Mesher produced no triangles')
    lo = [min(p[i] for p in projected) for i in range(2)]
    hi = [max(p[i] for p in projected) for i in range(2)]
    scale = min((WIDTH - args.padding * 2) / (hi[0] - lo[0]),
                (HEIGHT - args.padding * 2) / (hi[1] - lo[1]))
    origin = [WIDTH / 2 - (lo[0] + hi[0]) / 2 * scale, HEIGHT / 2 - (lo[1] + hi[1]) / 2 * scale]
    log(f'{triangle_count} mesh triangles; {scale:.5f}px/mm')
    right, _, toward = camera()
    projector = HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*toward), gp_Dir(*right)))
    records = {}
    for name, ratio in zip(VARIANTS, args.thresholds):
        if name not in args.variants:
            continue
        tick = time.perf_counter()
        kept = [shape for shape, size in parts if size >= ratio * height]
        kept_records = [record for (_, size), record in zip(parts, selected_records) if size >= ratio * height]
        if not kept:
            raise RuntimeError(f'{name}: threshold removed every body')
        shape = compound(kept)
        log(f'{name}: {len(kept)} bodies ≥ {ratio * height:.2f}mm; running {args.algorithm} HLR…')
        if args.algorithm == 'poly':
            algo = HLRBRep_PolyAlgo()
            algo.Load(shape)
            algo.Projector(projector)
            algo.Update()
            result = HLRBRep_PolyHLRToShape()
            result.Update(algo)
        else:
            algo = HLRBRep_Algo()
            algo.Add(shape)
            algo.Projector(projector)
            algo.Update()
            algo.Hide()
            result = HLRBRep_HLRToShape(algo)
        hlr_seconds = time.perf_counter() - tick
        log(f'{name}: HLR {hlr_seconds:.2f}s; extracting visible sharp/outline edges…')
        polylines, raw_edges = [], 0
        categories = [result.VCompound(), result.OutLineVCompound()]
        if args.tangent_edges:
            categories.append(result.Rg1LineVCompound())
        for category in categories:
            if category.IsNull():
                continue
            edges = TopExp_Explorer(category, TopAbs_EDGE)
            while edges.More():
                curve = BRepAdaptor_Curve(as_edge(edges.Current()))
                sample = GCPnts_QuasiUniformDeflection(curve, max(.02, args.simplify / scale / 2))
                if sample.IsDone() and sample.NbPoints() > 1:
                    # HLRToShape output is already in projector coordinates.
                    polylines.append([(origin[0] + sample.Value(i).X() * scale,
                                       origin[1] + sample.Value(i).Y() * scale)
                                      for i in range(1, sample.NbPoints() + 1)])
                raw_edges += 1
                edges.Next()
        chains, unique_segments = stitch(polylines, minimum=args.min_chain, tolerance=args.simplify)
        svg = args.output_dir / f'dosing-hlr-{name}.svg'
        svg.write_text(svg_text(chains, f'Установка приготовления и дозирования — STEP HLR, {name}'), encoding='utf-8')
        geometry_seconds = time.perf_counter() - tick
        if not args.no_png:
            rasterize(svg, svg.with_suffix('.png'))
        records[name] = {'threshold_ratio': ratio, 'threshold_mm': round(ratio * height, 3),
                          'kept_bodies': len(kept), 'kept_body_ids': [record['id'] for record in kept_records],
                          'raw_edges': raw_edges,
                         'unique_segments': unique_segments, 'stitched_chains': len(chains),
                         'svg_points': sum(len(p) for p in chains), 'svg_bytes': svg.stat().st_size,
                         'hlr_seconds': round(hlr_seconds, 3),
                         'geometry_seconds': round(geometry_seconds, 3),
                         'with_png_seconds': round(time.perf_counter() - tick, 3)}
        log(f'{name}: {svg.stat().st_size / 1024:.1f}KiB / {len(chains)} chains / {geometry_seconds:.2f}s')
    # Computing smooth vertex normals mutates OCCT's shared triangulations.
    # Do this only after every Poly HLR pass, so variant order is immaterial.
    if args.export_mesh:
        tick = time.perf_counter()
        medium = compound(shape for shape, size in parts if size >= args.thresholds[1] * height)
        # render-metal.py derives its output name from this exact suffix.
        mesh_line = args.output_dir / 'dosing-hlr-medium-schematic.svg'
        mesh_line.write_bytes((args.output_dir / 'dosing-hlr-medium.svg').read_bytes())
        mesh_info = export_mesh(medium, args.output_dir / 'dosing-hlr-medium-scene.json',
                                mesh_line, scale, origin, toward, args.mesh_triangles)
        timings['mesh_export'] = round(time.perf_counter() - tick, 3)
    if args.current:
        comparison(args, records, height)
    report = {'source': str(args.input), 'source_bytes': args.input.stat().st_size,
              'algorithm': args.algorithm,
              'orientation': {'coordinate_system': 'original STEP', 'mirror': args.mirror,
                              'rotation_degrees': args.rotation, 'matrix': matrix},
               'excluded_bodies': excluded,
               'suppress_fasteners': args.suppress_fasteners, 'suppressed_fasteners': fasteners,
              'shift_groups': groups, 'unshifted_shared_bodies': shared,
              'shift_coordinate_system': 'original STEP XY mm, before mirror/rotation; Z unchanged',
              'camera': {'azimuth': 55, 'elevation': 31}, 'canvas': [WIDTH, HEIGHT],
               'ink': '#383e43', 'stroke_width': 1.05, 'padding': args.padding,
              'assembly_height_mm': height, 'leaf_occurrences': leaves, 'body_count': len(inventory),
              'mesh_deflection_mm': args.deflection, 'mesh_angular_deflection': args.angular_deflection,
              'mesh_triangles': triangle_count, 'min_chain_px': args.min_chain,
              'simplification_px': args.simplify, 'fit_scale_px_per_mm': scale, 'fit_origin': origin,
              'projected_geometry_bounds': [[origin[i] + lo[i] * scale for i in range(2)],
                                            [origin[i] + hi[i] * scale for i in range(2)]],
              'timings_seconds': timings, 'variants': records,
              'total_seconds': round(time.perf_counter() - started, 3),
              'peak_rss_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)}
    if args.export_mesh:
        report['exported_mesh'] = mesh_info
    (args.output_dir / 'dosing-hlr-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    log(json.dumps(report, ensure_ascii=False, indent=2))


def export_mesh(shape, output, line, scale, origin, toward, target_triangles=100000):
    """Adapt existing OCCT mesh to render-metal.py, no additional CAD export."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepLib import BRepLib_ToolTriangulatedShape
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    import numpy as np
    from vtkmodules.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray, vtk_to_numpy
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    from vtkmodules.vtkFiltersCore import vtkDecimatePro

    as_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face

    # Center the mesh, so render-metal.py's fixed studio light is nearby.
    point_blocks, normal_blocks, index_blocks = [], [], []
    point_count = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = as_face(explorer.Current())
        location = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, location)
        if tri is not None:
            BRepLib_ToolTriangulatedShape.ComputeNormals_s(face, tri)
            trsf = location.Transformation()
            coords = [tri.Node(i).Transformed(trsf).Coord() for i in range(1, tri.NbNodes() + 1)]
            normals = []
            sign = -1 if face.Orientation() == TopAbs_REVERSED else 1
            for i in range(1, tri.NbNodes() + 1):
                n = tri.Normal(i).Transformed(trsf)
                normals.append([v * sign for v in n.Coord()])
            indices = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)], dtype=np.int64) - 1
            if sign < 0:
                indices = indices[:, ::-1]
            point_blocks.append(np.asarray(coords))
            normal_blocks.append(np.asarray(normals))
            index_blocks.append(indices + point_count)
            point_count += len(coords)
        explorer.Next()
    points = np.concatenate(point_blocks)
    normals = np.concatenate(normal_blocks)
    indices = np.concatenate(index_blocks)
    original_count = len(indices)
    # Retain face boundaries, sharp features and topology, including small pipes.
    # Do NOT merge coincident vertices with different analytic face normals.
    vtk_points = vtkPoints()
    vtk_points.SetData(numpy_to_vtk(points, deep=True))
    cells = vtkCellArray()
    cells.SetData(numpy_to_vtkIdTypeArray(np.arange(0, indices.size + 1, 3, dtype=np.int64), deep=True),
                  numpy_to_vtkIdTypeArray(indices.ravel(), deep=True))
    data = vtkPolyData()
    data.SetPoints(vtk_points)
    data.SetPolys(cells)
    data.GetPointData().SetNormals(numpy_to_vtk(normals, deep=True))
    if len(indices) > target_triangles:
        reducer = vtkDecimatePro()
        reducer.SetInputData(data)
        reducer.SetTargetReduction(1 - target_triangles / len(indices))
        reducer.PreserveTopologyOn()
        reducer.SplittingOff()
        reducer.BoundaryVertexDeletionOff()
        reducer.Update()
        data = reducer.GetOutput()
        points = vtk_to_numpy(data.GetPoints().GetData())
        normals = vtk_to_numpy(data.GetPointData().GetNormals())
        indices = vtk_to_numpy(data.GetPolys().GetConnectivityArray()).reshape(-1, 3)
    low, high = points.min(axis=0), points.max(axis=0)
    unit = 300 / max(high[i] - low[i] for i in range(3))
    center = [(low[i] + high[i]) / 2 if i < 2 else low[i] for i in range(3)]
    points = np.round((points - center) * unit, 6)
    normals = np.round(normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12), 6)
    right, down, _ = camera()
    axes = [[right[i] * scale / unit, down[i] * scale / unit] for i in range(3)]
    shift = project(center)
    result = {'routes': [], 'toward': toward,
              'origin': [origin[i] + shift[i] * scale for i in range(2)],
              'axes': axes, 'linePath': str(line),
              'source': 'Actual filtered STEP triangulation; neutral steel, no CAD colors'}
    # Stream triangles rather than expanding millions of nested Python lists.
    with output.open('w') as stream:
        stream.write(json.dumps(result, separators=(',', ':'))[:-1] + ',"surfaces":[')
        for i, triangle in enumerate(indices):
            if i:
                stream.write(',')
            stream.write(json.dumps({'pts': points[triangle].tolist(), 'normals': normals[triangle].tolist(),
                                     'material': 'steel'}, separators=(',', ':')))
        stream.write(']}\n')
    info = {'source_triangles': original_count, 'exported_triangles': len(indices),
            'scene_bytes': output.stat().st_size, 'path': str(output),
            'decimation': 'VTK DecimatePro; preserve topology, boundaries and face normals',
            'materials': 'neutral steel (CAD colors not imported)'}
    log(f'Medium mesh: {original_count} → {len(indices)} triangles, '
        f'{output.stat().st_size / 1024 / 1024:.1f}MiB → {output}')
    return info


if __name__ == '__main__':
    main()
