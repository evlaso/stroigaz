#!/usr/bin/env python3
"""Extract named STEP assembly occurrences and their world-space bounding boxes.

Run from the project root; the input is DATA, never an import/working directory:
  uv venv --python 3.12 /absolute/scratchpad/step-venv
  uv pip install --python /absolute/scratchpad/step-venv/bin/python cadquery-ocp
  /absolute/scratchpad/step-venv/bin/python scripts/anatomy/step-layout.py \
    '/absolute/path/to/model.stp' --output /absolute/scratchpad/layout.json

Tested with Python 3.12.15 and cadquery-ocp 8.0.1.1.0. The 109 MB dosing model
took 42.2 s / 1003 MiB peak RSS for 989 located occurrences on the test machine.
No FreeCAD, full CadQuery, Blender, sudo or system-wide packages are required.

Uses OpenCascade's STEPCAF/XCAF reader (AP203/AP214/AP242), preserving assembly
names, repeated occurrences and accumulated instance rotations/translations.
Coordinates/AABBs are in millimetres, in the original assembly's coordinate
system, NOT a website specification. No tessellation/mesh is necessary: exact
B-rep bounds are used (assembly boxes are unions of child boxes, and repeated
parts reuse bounds for the same rotation). --fast-bounds uses conservative
OpenCascade bounds instead, useful for an initial pass on a very large model.
--cylinder-radius 100 records analytic cylindrical faces
of that radius or larger on leaf parts (useful for locating tank axes). Those
faces may be trimmed, hollow or repeated; they are NOT automatic tank detection.

The JSON is an inspection inventory, not a guessed process diagram. Select and
union named assemblies manually, check the designer's reference, then translate
and uniformly scale the major envelopes into build-cases.mjs primitives. For
RO-1 Rev5.STEP / CIP Rev4.STEP use the same command with another absolute input
and output. Large files can need several GB of RAM; run each model separately.
No CAD file, library or executable is loaded from the input directory.
"""

import argparse
import hashlib
import json
from pathlib import Path
import resource
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cylinder-radius', type=float, default=100,
                        help='Minimum analytic face radius in mm (default: 100).')
    parser.add_argument('--fast-bounds', action='store_true',
                        help='Use conservative B-rep bounds instead of AddOptimal.')
    args = parser.parse_args()
    if not args.input.is_absolute() or not args.output.is_absolute():
        parser.error('Use absolute input and output paths.')
    if args.input.resolve() == args.output.resolve():
        parser.error('Output must not overwrite the STEP input.')
    if args.cylinder_radius < 0:
        parser.error('--cylinder-radius must be nonnegative.')

    try:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.BRepBndLib import BRepBndLib
        from OCP.GeomAbs import GeomAbs_Cylinder
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.Interface import Interface_Static
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDF import TDF_Label, TDF_Tool
        try:
            from OCP.TDF import TDF_LabelSequence
        except ImportError:  # OCCT 8 renamed the generated collection bindings.
            from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS
        from OCP.XCAFDoc import XCAFDoc_DocumentTool
    except ImportError as exc:
        parser.exit(1, f'{exc}\nInstall cadquery-ocp in the scratchpad venv; see docstring.\n')

    started = time.perf_counter()
    digest = hashlib.sha256()
    with args.input.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    reader = STEPCAFControl_Reader()
    Interface_Static.SetCVal_s('xstep.cascade.unit', 'MM')
    reader.SetNameMode(True)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)
    status = reader.ReadFile(str(args.input))
    if status != IFSelect_RetDone:
        parser.exit(1, f'STEP read failed: {status}\n')
    read_at = time.perf_counter()
    print(f'STEP parsed in {read_at - started:.2f}s; transferring B-rep...', flush=True)
    doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    if not reader.Transfer(doc):
        parser.exit(1, 'STEP to XCAF transfer failed.\n')
    transfer_at = time.perf_counter()
    print(f'B-rep transferred in {transfer_at - read_at:.2f}s; measuring occurrences...', flush=True)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def entry(label):
        text = TCollection_AsciiString()
        TDF_Tool.Entry_s(label, text)
        return text.ToCString()

    def name(label):
        attr = TDataStd_Name()
        return attr.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attr) else ''

    def rounded(values):
        return [round(v, 4) for v in values]

    def bbox(shape):
        bounds = Bnd_Box()
        if args.fast_bounds:
            BRepBndLib.Add_s(shape, bounds, False)
        else:
            BRepBndLib.AddOptimal_s(shape, bounds, False, False)
        if bounds.IsVoid():
            return None
        # Corner access also works with OCCT 8's unbound Bnd_Box::Limits return.
        values = (*bounds.CornerMin().Coord(), *bounds.CornerMax().Coord())
        return {'min': rounded(values[:3]), 'max': rounded(values[3:]),
                'size': rounded(values[i + 3] - values[i] for i in range(3)),
                'center': rounded((values[i + 3] + values[i]) / 2 for i in range(3))}

    def cylinders(shape):
        faces = TopExp_Explorer(shape, TopAbs_FACE)
        as_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face
        found = {}
        while faces.More():
            surface = BRepAdaptor_Surface(as_face(faces.Current()))
            if surface.GetType() == GeomAbs_Cylinder:
                cylinder = surface.Cylinder()
                radius = cylinder.Radius()
                if radius >= args.cylinder_radius:
                    axis = cylinder.Axis()
                    location = rounded(axis.Location().Coord())
                    direction = rounded(axis.Direction().Coord())
                    key = (round(radius, 3), *location, *direction)
                    found[key] = {'radius': round(radius, 4), 'axis_point': location,
                                  'axis_direction': direction}
            faces.Next()
        return list(found.values())

    nodes = []
    measured = {}

    def translated(bounds, offset):
        return {k: rounded(v[i] + offset[i] for i in range(3)) if k != 'size' else v
                for k, v in bounds.items()} if bounds else None

    def union(bounds):
        bounds = [b for b in bounds if b]
        if not bounds:
            return None
        lo = [min(b['min'][i] for b in bounds) for i in range(3)]
        hi = [max(b['max'][i] for b in bounds) for i in range(3)]
        return {'min': lo, 'max': hi, 'size': rounded(hi[i] - lo[i] for i in range(3)),
                'center': rounded((hi[i] + lo[i]) / 2 for i in range(3))}

    def visit(label, parent_id=None, parent_location=None, depth=0):
        definition = label
        world = parent_location if parent_location is not None else TopLoc_Location()
        if tool.IsReference_s(label):
            definition = TDF_Label()
            if not tool.GetReferredShape_s(label, definition):
                raise RuntimeError(f'Unresolved occurrence {entry(label)}')
            world = world.Multiplied(tool.GetLocation_s(label))
        shape = tool.GetShape_s(definition)
        if shape.IsNull():
            return
        shape = shape.Moved(world)
        assembly = tool.IsAssembly_s(definition)
        transform = world.Transformation()
        node_id = len(nodes)
        record = {'id': node_id, 'parent': parent_id, 'depth': depth,
                  'label': entry(label), 'definition': entry(definition),
                  'name': name(definition), 'occurrence_name': name(label),
                  'assembly': assembly, 'bbox': None,
                  'transform': [[round(transform.Value(i, j), 9) for j in range(1, 5)]
                                for i in range(1, 4)]}
        nodes.append(record)
        if assembly:
            children = TDF_LabelSequence()
            tool.GetComponents_s(definition, children, False)
            for i in range(1, children.Length() + 1):
                visit(children.Value(i), node_id, world, depth + 1)
            record['bbox'] = union(n['bbox'] for n in nodes[node_id + 1:] if n['parent'] == node_id)
        else:
            key = (record['definition'], *(v for row in record['transform'] for v in row[:3]))
            offset = [row[3] for row in record['transform']]
            if key not in measured:
                bounds = bbox(shape)
                analytic = cylinders(shape)
                measured[key] = (bounds, analytic, offset)
                if len(measured) % 25 == 0:
                    print(f'{len(nodes)} occurrences, {len(measured)} unique oriented parts...', flush=True)
            bounds, analytic, previous = measured[key]
            delta = [offset[i] - previous[i] for i in range(3)]
            record['bbox'] = translated(bounds, delta)
            record['cylinders'] = [{**c, 'axis_point': rounded(c['axis_point'][i] + delta[i] for i in range(3))}
                                   for c in analytic]

    roots = TDF_LabelSequence()
    tool.GetFreeShapes(roots)
    for i in range(1, roots.Length() + 1):
        visit(roots.Value(i))
    finished = time.perf_counter()
    result = {'source': str(args.input), 'source_bytes': args.input.stat().st_size,
              'source_sha256': digest.hexdigest(), 'reader': 'OpenCascade STEPCAF/XCAF',
              'units': 'mm', 'coordinate_system': 'original STEP assembly, located occurrences',
              'bounds_method': 'conservative BRepBndLib.Add' if args.fast_bounds else 'BRepBndLib.AddOptimal',
              'cylinder_min_radius': args.cylinder_radius,
              'timings_seconds': {'read': round(read_at - started, 3),
                                  'transfer': round(transfer_at - read_at, 3),
                                  'measure': round(finished - transfer_at, 3),
                                  'total': round(finished - started, 3)},
              'peak_rss_mib': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
              'root_count': roots.Length(), 'node_count': len(nodes), 'nodes': nodes}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'nodes'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
