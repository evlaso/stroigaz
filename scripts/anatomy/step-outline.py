#!/usr/bin/env python3
"""Whole STEP -> orthographic G-buffer + depth-tested CAD curves -> centreline SVG.

Run from a TRUSTED directory, with the CAD venv in isolated mode:
  /home/foxqa/.cache/stroygaz-step-venv/bin/python -I \
    /home/foxqa/Projects/stroygaz/scripts/anatomy/step-outline.py \
    /absolute/model.step --output-dir /absolute/output --rotation 350 --mirror x

Use --contact-sheet first for a new model: 1..8 are rotations 0..315 degrees,
9..16 the same rotations AFTER reflection of original STEP X. Only orientation
is model-specific. Placements, shells, small parts and fasteners are preserved.
There are deliberately NO body/name/size filters, shifts or hand-drawn edges.

Requires cadquery-ocp, numpy, Pillow and VTK (a cadquery-ocp dependency) in the
venv. VTK's explicit EGL offscreen window requires Mesa EGL or a GPU driver;
no X server, desktop, GUI, browser or external renderer is used. No potrace is
needed: topology-preserving thinning and a centreline graph tracer keep the
site's uniform 1.05 px strokes instead of tracing variable-width filled ribbons.

Camera/style: line-scene.mjs, 55/31 degrees, 760x500, pad 20, ink #383e43.
Defaults: 4x G-buffer, mesh chord-error target .18 canvas px, crease >= 32 degrees,
plane-corrected depth jump >= .35 canvas px. --supersample 8 resolves thinner
features. --crease-angle/--depth-jump control image-space detail, NEVER bodies.
Original non-periodic CAD edges are also rasterised against this same z-buffer:
coplanar display frames and smoothly filleted tank grooves cannot be recovered
from depth/normal discontinuities alone. NO HLR edge visibility classifier runs.
Every face enters the z-buffer. Faces rejected by OCCT's mesher are intersected
analytically against the same orthographic pixel rays (including STEP trims).
This automatic fallback uses the original face, NOT repaired/replaced geometry.
This prevents whole-body filtering losses, not a mathematical guarantee for
subpixel features, unmodelled textures, truly occluded geometry or faulty STEP data.

Inputs are untrusted DATA. All supplied paths must be absolute. Nothing in the
input folder is imported/executed, and output must be outside that folder.
Numeric mesh caches are keyed by source SHA-256 + meshing settings + OCP version;
loading uses allow_pickle=False. --no-cache disables them. report.json records
counts, timings, peak RSS and raw-edge/vector coverage. --reference and optional
--comparison-svg/--comparison-report make outline-review.png. The latter pair
MUST be an unfiltered, unshifted exact-HLR SVG/report of the same orientation
(not a production dependency); projection fitting is aligned automatically.
"""

import argparse
import gc
import hashlib
from html import escape
import importlib.metadata
import json
import math
from pathlib import Path
import resource
import sys
import time

import numpy as np


WIDTH, HEIGHT, PAD = 760, 500, 20
INK, STROKE = '#383e43', 1.05


def log(message):
    print(message, flush=True)


def camera():
    """Rows are screen right, screen DOWN and toward camera; same as the site."""
    a, e = map(math.radians, (55, 31))
    return np.array(((math.sin(a), -math.cos(a), 0),
                     (math.cos(a) * math.sin(e), math.sin(a) * math.sin(e), -math.cos(e)),
                     (math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e))))


def orientation_matrix(mirror, degrees):
    """Original STEP axes: reflect FIRST, then rotate about +Z. Never move parts."""
    angle = math.radians(degrees)
    c, s = math.cos(angle), math.sin(angle)
    return np.array(((c, -s, 0), (s, c, 0), (0, 0, 1))) @ np.diag(
        (-1 if mirror == 'x' else 1, -1 if mirror == 'y' else 1, 1))


def fit_projection(points, width=WIDTH, height=HEIGHT, padding=PAD):
    low, high = points[:, :2].min(axis=0), points[:, :2].max(axis=0)
    span = high - low
    if np.any(span <= 0):
        raise ValueError('Degenerate projected geometry')
    scale = float(min((width - 2 * padding) / span[0], (height - 2 * padding) / span[1]))
    origin = np.array((width / 2, height / 2)) - (low + high) * scale / 2
    return scale, origin, np.array((low * scale + origin, high * scale + origin))


def simplify(points, tolerance):
    """Iterative RDP, with a bounded point-to-segment error; also handles loops."""
    if len(points) < 3 or tolerance == 0:
        return points
    keep = {0, len(points) - 1}
    pending = [(0, len(points) - 1)]
    while pending:
        lo, hi = pending.pop()
        a, b = np.asarray(points[lo]), np.asarray(points[hi])
        p = np.asarray(points[lo + 1:hi])
        if not len(p):
            continue
        delta = b - a
        denom = float(delta @ delta)
        t = np.clip((p - a) @ delta / denom, 0, 1) if denom else np.zeros(len(p))
        distances = np.sum((p - a - t[:, None] * delta) ** 2, axis=1)
        index = int(np.argmax(distances))
        if distances[index] > tolerance ** 2:
            index += lo + 1
            keep.add(index)
            pending.extend(((lo, index), (index, hi)))
    return [points[i] for i in sorted(keep)]


def detect_edges(depth, normals, scale, supersample, crease_angle=32, depth_jump=.35):
    """Image-space silhouettes, normal creases, plane-corrected depth jumps.

    depth is in world units, increasing toward camera; normals use right/DOWN/
    toward axes. A tilted planar face must NOT turn into a band of depth edges.
    Comparing the 3-D neighbour displacement to both local tangent planes avoids
    this. The foreground sample owns an occlusion edge, never the hidden sample.
    """
    valid = np.isfinite(depth)
    silhouette = np.zeros(valid.shape, bool)
    crease = np.zeros_like(silhouette)
    jump = np.zeros_like(silhouette)
    cosine = math.cos(math.radians(crease_angle))
    for axis in (0, 1):
        a = (slice(None, -1), slice(None)) if axis == 0 else (slice(None), slice(None, -1))
        b = (slice(1, None), slice(None)) if axis == 0 else (slice(None), slice(1, None))
        va, vb = valid[a], valid[b]
        both = va & vb
        silhouette[a] |= va & ~vb
        silhouette[b] |= vb & ~va
        na, nb = normals[a], normals[b]
        sharp = both & (np.einsum('ijk,ijk->ij', na, nb) < cosine)
        with np.errstate(invalid='ignore'):
            dz = (depth[b] - depth[a]) * scale
        dz = np.where(both, dz, 0)
        # One high-resolution sample = 1/supersample canvas pixels.
        residual_a = np.abs(na[..., 1 - axis] / supersample + na[..., 2] * dz)
        residual_b = np.abs(nb[..., 1 - axis] / supersample + nb[..., 2] * dz)
        discontinuity = both & (np.abs(dz) > depth_jump) & (
            np.maximum(residual_a, residual_b) > depth_jump)
        foreground_a = depth[a] >= depth[b]
        jump[a] |= discontinuity & foreground_a
        jump[b] |= discontinuity & ~foreground_a
        crease[a] |= sharp & foreground_a
        crease[b] |= sharp & ~foreground_a
    return silhouette, jump, crease


def close_gaps(mask):
    """One high-res pixel cross closing, extensive: never discard source edges."""
    p = np.pad(mask, 1)
    dilated = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    p = np.pad(dilated, 1)
    return mask | (p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:])


def skeletonize(mask):
    """Zhang-Suen thinning, no component/length pruning; preserve isolated dots."""
    image = np.pad(mask, 1)
    while True:
        removed = 0
        for step in (0, 1):
            n = (image[:-2, 1:-1], image[:-2, 2:], image[1:-1, 2:], image[2:, 2:],
                 image[2:, 1:-1], image[2:, :-2], image[1:-1, :-2], image[:-2, :-2])
            count = sum(p.astype(np.uint8) for p in n)
            transitions = sum((~n[i] & n[(i + 1) % 8]).astype(np.uint8) for i in range(8))
            if step == 0:
                keep_a, keep_b = n[0] & n[2] & n[4], n[2] & n[4] & n[6]
            else:
                keep_a, keep_b = n[0] & n[2] & n[6], n[0] & n[4] & n[6]
            erase = image[1:-1, 1:-1] & (count >= 2) & (count <= 6) & (
                transitions == 1) & ~keep_a & ~keep_b
            # The textbook simultaneous Zhang-Suen rule can erase an isolated
            # 2x2 component completely. Preserve its deterministic NW anchor.
            # This is important: a tiny visible fitting must become a dot, not
            # disappear just because its pixel component had even dimensions.
            collapse = erase[:-1, :-1] & erase[:-1, 1:] & erase[1:, :-1] & erase[1:, 1:]
            erase[:-1, :-1] &= ~collapse
            removed += int(erase.sum())
            image[1:-1, 1:-1][erase] = False
        if not removed:
            return image[1:-1, 1:-1].copy()


def trace_skeleton(mask, supersample):
    """Trace every graph edge once, including loops, junctions and isolated dots.

    Diagonal adjacency is omitted when a common orthogonal pixel exists, avoiding
    triangular shortcuts/false junctions on a staircase. No short chain is pruned.
    """
    height, width = mask.shape
    pixels = set(map(int, np.flatnonzero(mask)))
    adjacency = {}
    for p in sorted(pixels):
        y, x = divmod(p, width)
        neighbors = []
        for dy, dx in ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)):
            yy, xx = y + dy, x + dx
            q = yy * width + xx
            if 0 <= yy < height and 0 <= xx < width and q in pixels:
                if dy and dx and (y * width + xx in pixels or yy * width + x in pixels):
                    continue
                neighbors.append(q)
        adjacency[p] = neighbors
    visited, chains = set(), []

    def edge(p, q):
        return (min(p, q), max(p, q))

    def walk(p, q):
        chain = [p]
        while edge(p, q) not in visited:
            visited.add(edge(p, q))
            chain.append(q)
            candidates = adjacency[q]
            if len(candidates) != 2:
                break
            p, q = q, candidates[0] if candidates[1] == p else candidates[1]
        chains.append(chain)

    for p, neighbors in adjacency.items():
        if not neighbors:
            chains.append([p])
        elif len(neighbors) != 2:
            for q in neighbors:
                if edge(p, q) not in visited:
                    walk(p, q)
    for p, neighbors in adjacency.items():
        for q in neighbors:
            if edge(p, q) not in visited:
                walk(p, q)
    return [[((p % width + .5) / supersample, (p // width + .5) / supersample)
             for p in chain] for chain in chains]


def svg_text(chains, label):
    def number(value):
        text = f'{value:.2f}'.rstrip('0').rstrip('.')
        if text.startswith('0.'):
            return text[1:]
        if text.startswith('-0.'):
            return '-' + text[2:]
        return '0' if text == '-0' else text
    paths = []
    for points in chains:
        # Short relative deltas are much smaller than repeated absolute canvas
        # coordinates. Compute them AFTER centipixel quantisation, so compression
        # introduces NO accumulated drift or extra geometric simplification.
        quantized = [(round(x * 100), round(y * 100)) for x, y in points]
        d = 'M' + ','.join(number(v / 100) for v in quantized[0])
        for i, (a, b) in enumerate(zip(quantized, quantized[1:]), 1):
            if i == len(quantized) - 1 and b == quantized[0] and len(quantized) > 2:
                d += 'z'
                continue
            absolute = 'L' + ','.join(number(v / 100) for v in b)
            relative = 'l' + ','.join(number((b[j] - a[j]) / 100) for j in range(2))
            d += relative if len(relative) < len(absolute) else absolute
        if len(points) == 1:
            d += 'l.001,0'  # Round cap retains a one-sample isolated feature.
        paths.append(d)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" class="iso-svg iso" data-theme="light" '
            f'data-frame="canvas" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" '
            f'role="img" aria-label="{escape(label, quote=True)}">'
            f'<g fill="none" stroke="{INK}" stroke-width="{STROKE}" '
            'stroke-linejoin="round" stroke-linecap="round">'
            f'<path d="{"".join(paths)}"/></g></svg>\n')


def load_mesh(args, report):
    """XCAF preserves accumulated assembly placements; enumerate ALL occurrences."""
    tick = time.perf_counter()
    digest = hashlib.sha256()
    with args.input.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    key = {'sha256': digest.hexdigest(), 'mesh_schema': 3, 'mesh_error_px': args.mesh_error,
           'angular_deflection': args.angular_deflection, 'contact_sheet': args.contact_sheet,
           'ocp': importlib.metadata.version('cadquery-ocp')}
    report['source_sha256'] = key['sha256']
    cache = args.output_dir / ('mesh-contact.npz' if args.contact_sheet else 'mesh.npz')
    meta = cache.with_suffix('.json')
    candidates = [cache]
    if args.contact_sheet:
        candidates.append(args.output_dir / 'mesh.npz')
    for candidate in candidates if not args.no_cache else []:
        if not candidate.exists() or not candidate.with_suffix('.json').exists():
            continue
        previous = json.loads(candidate.with_suffix('.json').read_text())
        old = previous['key']
        # A finer FINAL mesh is a free low-resolution preview if already cached.
        fine_preview = args.contact_sheet and all(old.get(k) == key[k] for k in ('sha256', 'mesh_schema', 'ocp')) and (
            old['mesh_error_px'] <= key['mesh_error_px'] and old['angular_deflection'] <= key['angular_deflection'])
        if (old == key or fine_preview) and all(Path(f['brep']).is_file() for f in previous['mesh'].get('analytic_faces', [])):
            with np.load(candidate, allow_pickle=False) as data:
                arrays = tuple(data[name].copy() for name in ('points', 'normals', 'triangles', 'feature_segments'))
            report['mesh'] = previous['mesh']
            report['mesh_cache_hit'] = True
            report['mesh_cache_source'] = str(candidate)
            report['timings_seconds']['load_mesh_cache'] = round(time.perf_counter() - tick, 3)
            log(f'Numeric mesh cache: {len(arrays[2]):,} triangles')
            return (*arrays[:3], previous['mesh'].get('analytic_faces', []), arrays[3])
    report['mesh_cache_hit'] = False
    from OCP.Bnd import Bnd_Box
    from OCP.BRep import BRep_Tool
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepLib import BRepLib_ToolTriangulatedShape
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepTools import BRepTools
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.GProp import GProp_GProps
    from OCP.Interface import Interface_Static
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDF import TDF_Label
    try:
        from OCP.TDF import TDF_LabelSequence
    except ImportError:
        from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    tick = time.perf_counter()
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(False)
    reader.SetColorMode(False)
    reader.SetLayerMode(False)
    Interface_Static.SetCVal_s('xstep.cascade.unit', 'MM')
    if reader.ReadFile(str(args.input)) != IFSelect_RetDone:
        raise RuntimeError('STEP read failed')
    root_count = reader.Reader().NbRootsForTransfer()
    log(f'STEP read in {time.perf_counter() - tick:.1f}s; transferring {root_count} roots…')
    doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    if not reader.Transfer(doc):
        raise RuntimeError('XCAF STEP transfer failed')
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = TDF_LabelSequence()
    tool.GetFreeShapes(roots)
    transferred = roots.Length()
    builder, shape = BRep_Builder(), TopoDS_Compound()
    builder.MakeCompound(shape)
    leaves, surface_only_leaves, curve_only_leaves = 0, 0, 0

    def visit(label, parent):
        nonlocal leaves, surface_only_leaves, curve_only_leaves
        definition, world = label, parent
        if tool.IsReference_s(label):
            definition = TDF_Label()
            if not tool.GetReferredShape_s(label, definition):
                raise RuntimeError('Unresolved XCAF occurrence; refusing partial assembly')
            world = world.Multiplied(tool.GetLocation_s(label))
        if tool.IsAssembly_s(definition):
            children = TDF_LabelSequence()
            tool.GetComponents_s(definition, children, False)
            for i in range(1, children.Length() + 1):
                visit(children.Value(i), world)
        else:
            leaf = tool.GetShape_s(definition)
            if not leaf.IsNull():
                builder.Add(shape, leaf.Moved(world))
                leaves += 1
                if not TopExp_Explorer(leaf, TopAbs_SOLID).More():
                    if TopExp_Explorer(leaf, TopAbs_FACE).More():
                        surface_only_leaves += 1
                    else:
                        curve_only_leaves += 1

    for i in range(1, roots.Length() + 1):
        visit(roots.Value(i), TopLoc_Location())
    if not leaves:
        raise RuntimeError('STEP contains no leaf occurrences')
    report['timings_seconds']['read_transfer'] = round(time.perf_counter() - tick, 3)
    del reader
    gc.collect()
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    low, high = np.array(box.CornerMin().Coord()), np.array(box.CornerMax().Coord())
    # Orientation-independent estimate, so one mesh serves every orientation.
    # The actual projected chord error is recorded after fitting the full mesh.
    deflection = args.mesh_error * np.linalg.norm(high - low) / (HEIGHT - 2 * PAD)
    tick = time.perf_counter()
    mesher = BRepMesh_IncrementalMesh(shape, float(deflection), False, args.angular_deflection, False)
    if not mesher.IsDone():
        raise RuntimeError('Assembly meshing failed')
    report['timings_seconds']['tessellate'] = round(time.perf_counter() - tick, 3)
    tick = time.perf_counter()
    point_blocks, normal_blocks, triangle_blocks = [], [], []
    point_count, face_count, solid_count = 0, 0, 0
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solid_count += 1
        explorer.Next()
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    degenerate, retried, analytic = [], [], []
    while explorer.More():
        face_count += 1
        as_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face
        face = as_face(explorer.Current())
        location = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, location)
        if tri is None or not tri.NbTriangles():
            # Generic recovery, NOT a model-specific exclusion. Some imported
            # trimmed faces need a finer independent meshing pass.
            retry = BRepMesh_IncrementalMesh(face, float(deflection / 10), False,
                                            args.angular_deflection / 2, False)
            tri = BRep_Tool.Triangulation_s(face, location)
            retried.append(face_count)
            if tri is None or not tri.NbTriangles():
                properties = GProp_GProps()
                BRepGProp.SurfaceProperties_s(face, properties)
                area = abs(properties.Mass())
                record = {'face': face_count, 'area_mm2': area}
                # Zero-area trimming slivers have no rasterisable surface.
                # Record them, but NEVER ignore a finite-area meshing failure.
                if area <= np.finfo(float).eps * float(np.sum((high - low) ** 2)) * 32:
                    degenerate.append(record)
                else:
                    diagnostic = args.output_dir / 'meshing-diagnostics'
                    diagnostic.mkdir(exist_ok=True)
                    path = diagnostic / f'face-{face_count}.brep'
                    if not BRepTools.Write_s(face, str(path)):
                        raise RuntimeError(f'Cannot save analytic fallback face {face_count}')
                    face_box = Bnd_Box()
                    BRepBndLib.AddOptimal_s(face, face_box, False, False)
                    flo, fhi = face_box.CornerMin().Coord(), face_box.CornerMax().Coord()
                    corners = np.array([(x, y, z) for x in (flo[0], fhi[0])
                                        for y in (flo[1], fhi[1]) for z in (flo[2], fhi[2])], np.float32)
                    # Unindexed points only extend the fit to include this face.
                    point_blocks.append(corners)
                    normal_blocks.append(np.zeros_like(corners))
                    point_count += len(corners)
                    analytic.append({**record, 'brep': str(path), 'bounds_mm': [list(flo), list(fhi)],
                                     'valid_brep': bool(BRepCheck_Analyzer(face).IsValid()),
                                     'method': 'original trimmed face / exact pixel-ray intersection'})
                explorer.Next()
                continue
        BRepLib_ToolTriangulatedShape.ComputeNormals_s(face, tri)
        trsf = location.Transformation()
        points = np.array([tri.Node(i).Transformed(trsf).Coord() for i in range(1, tri.NbNodes() + 1)], np.float32)
        sign = -1 if face.Orientation() == TopAbs_REVERSED else 1
        normals = np.array([tri.Normal(i).Transformed(trsf).Coord() for i in range(1, tri.NbNodes() + 1)], np.float32) * sign
        triangles = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)], np.int64) - 1
        if sign < 0:
            triangles = triangles[:, ::-1]
        point_blocks.append(points)
        normal_blocks.append(normals)
        triangle_blocks.append(triangles + point_count)
        point_count += len(points)
        explorer.Next()
    if not point_blocks:
        raise RuntimeError('STEP contains no surface faces')
    arrays = (np.concatenate(point_blocks), np.concatenate(normal_blocks), np.concatenate(triangle_blocks))
    tick_features = time.perf_counter()
    feature_segments, feature_info = (np.empty((0, 2, 3), np.float32), {}) if args.contact_sheet else sample_cad_edges(shape, float(deflection / 8))
    arrays = (*arrays, feature_segments)
    report['timings_seconds']['sample_cad_edges'] = round(time.perf_counter() - tick_features, 3)
    del shape, mesher, point_blocks, normal_blocks, triangle_blocks
    gc.collect()
    report['timings_seconds']['extract_mesh'] = round(time.perf_counter() - tick, 3)
    report['mesh'] = {'roots': root_count, 'transferred_roots': transferred, 'leaf_occurrences': leaves,
                      'surface_only_occurrences': surface_only_leaves, 'curve_only_occurrences': curve_only_leaves,
                      'surface_body_occurrences': solid_count + surface_only_leaves,
                      'solid_occurrences': solid_count, 'face_occurrences': face_count,
                      'meshed_faces': face_count - len(degenerate) - len(analytic), 'zero_area_faces': degenerate,
                      'retried_faces': retried, 'analytic_faces': analytic,
                      'missing_faces': [], 'filtered_bodies': 0,
                      'cad_edges': feature_info,
                      'relocated_bodies': 0, 'triangles': len(arrays[2]), 'vertices': len(arrays[0]),
                      'deflection_mm': float(deflection), 'bounds_mm': [low.tolist(), high.tolist()]}
    if not args.no_cache:
        tick = time.perf_counter()
        np.savez_compressed(cache, points=arrays[0], normals=arrays[1], triangles=arrays[2], feature_segments=arrays[3])
        meta.write_text(json.dumps({'key': key, 'mesh': report['mesh']}, indent=2) + '\n')
        report['timings_seconds']['save_mesh_cache'] = round(time.perf_counter() - tick, 3)
    log(f'ALL {solid_count} solids / {face_count} faces: {len(arrays[2]):,} triangles; '
        f'{len(analytic)} exact ray fallback faces; zero-area faces: {len(degenerate)}; missing faces: 0')
    return (*arrays[:3], analytic, arrays[3])


def sample_cad_edges(shape, deflection):
    """All original non-seam edges, including coplanar displays and smooth grooves.

    This is not HLR. Visibility is evaluated later against the COMPLETE z-buffer.
    Size/name/length are never used to select edges or bodies.
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    as_edge = getattr(TopoDS, 'Edge_s', None) or TopoDS.Edge
    as_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face

    def key(edge):
        trsf = edge.Location().Transformation()
        return (edge.TShape(), tuple(round(trsf.Value(i, j), 9) for i in range(1, 4) for j in range(1, 5)))

    seams = set()
    faces = TopExp_Explorer(shape, TopAbs_FACE)
    while faces.More():
        face = as_face(faces.Current())
        edges = TopExp_Explorer(face, TopAbs_EDGE)
        while edges.More():
            edge = as_edge(edges.Current())
            if BRep_Tool.IsClosed_s(edge, face):
                seams.add(key(edge))
            edges.Next()
        faces.Next()
    edges = TopExp_Explorer(shape, TopAbs_EDGE)
    seen, blocks, degenerate = set(), [], 0
    while edges.More():
        edge = as_edge(edges.Current())
        identity = key(edge)
        edges.Next()
        if identity in seen or identity in seams:
            continue
        seen.add(identity)
        if BRep_Tool.Degenerated_s(edge):
            degenerate += 1
            continue
        curve = BRepAdaptor_Curve(edge)
        sample = GCPnts_QuasiUniformDeflection(curve, deflection)
        if not sample.IsDone() or sample.NbPoints() < 2:
            raise RuntimeError('CAD edge sampling failed; refusing silently incomplete features')
        points = np.array([sample.Value(i).Coord() for i in range(1, sample.NbPoints() + 1)], np.float32)
        blocks.append(np.stack((points[:-1], points[1:]), axis=1))
    return (np.concatenate(blocks) if blocks else np.empty((0, 2, 3), np.float32),
            {'unique_nonseam_edges': len(seen), 'periodic_seam_edges': len(seams),
             'degenerate_edges': degenerate, 'deflection_mm': deflection})


def visible_cad_edges(segments, depth, transform, scale, origin, supersample, tolerance_px):
    """Rasterise original CAD curves with visibility from the same surface buffer."""
    mask = np.zeros(depth.shape, bool)
    for start in range(0, len(segments), 8192):
        view = segments[start:start + 8192] @ transform.T
        pixel = (view[..., :2] * scale + origin) * supersample
        count = np.maximum(1, np.ceil(np.linalg.norm(pixel[:, 1] - pixel[:, 0], axis=1) * 1.5).astype(int)) + 1
        indices = np.repeat(np.arange(len(count)), count)
        offsets = np.repeat(np.cumsum(count) - count, count)
        t = (np.arange(len(indices)) - offsets) / (count[indices] - 1)
        points = view[indices, 0] + t[:, None] * (view[indices, 1] - view[indices, 0])
        xy = np.floor((points[:, :2] * scale + origin) * supersample).astype(int)
        valid = (xy[:, 0] >= 0) & (xy[:, 0] < depth.shape[1]) & (xy[:, 1] >= 0) & (xy[:, 1] < depth.shape[0])
        xy, points = xy[valid], points[valid]
        front = depth[xy[:, 1], xy[:, 0]]
        visible = points[:, 2] >= front - tolerance_px / scale
        xy = xy[visible]
        mask[xy[:, 1], xy[:, 0]] = True
    return mask


def render_analytic_faces(faces, depth, normals, transform, scale, origin, supersample):
    """Complete the same z-buffer using original trimmed B-reps when meshing fails.

    Only pixels inside a face's projected conservative bbox are tested; pixels
    already nearer than that entire bbox are skipped. This is an acceleration,
    NOT body filtering. Even invalid imported trim topology is kept unchanged
    and explicitly reported, rather than 'healed' by deleting its small wires.
    """
    if not faces:
        return []
    from OCP.BRep import BRep_Builder
    from OCP.BRepTools import BRepTools
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
    from OCP.TopoDS import TopoDS, TopoDS_Shape
    from OCP.gp import gp_Pnt, gp_Dir, gp_Lin, gp_Vec
    records = []
    as_face = getattr(TopoDS, 'Face_s', None) or TopoDS.Face
    direction = gp_Dir(*(-transform[2]))
    for record in faces:
        shape = TopoDS_Shape()
        if not BRepTools.Read_s(shape, record['brep'], BRep_Builder()):
            raise RuntimeError(f'Cannot read fallback face: {record["brep"]}')
        face = as_face(shape)
        surface = BRepAdaptor_Surface(face)
        intersector = IntCurvesFace_ShapeIntersector()
        intersector.Load(face, 1e-7)
        low, high = record['bounds_mm']
        corners = np.array([(x, y, z) for x in (low[0], high[0])
                            for y in (low[1], high[1]) for z in (low[2], high[2])]) @ transform.T
        pixel = (corners[:, :2] * scale + origin) * supersample
        lo = np.maximum(0, np.floor(pixel.min(axis=0)).astype(int) - 1)
        hi = np.minimum([depth.shape[1] - 1, depth.shape[0] - 1], np.ceil(pixel.max(axis=0)).astype(int) + 1)
        front = float(corners[:, 2].max() + 1)
        ray_length = float(np.ptp(corners[:, 2]) + 2)
        tested, hits, written = 0, 0, 0
        for y in range(int(lo[1]), int(hi[1]) + 1):
            for x in range(int(lo[0]), int(hi[0]) + 1):
                if depth[y, x] > front:
                    continue
                view = np.array((((x + .5) / supersample - origin[0]) / scale,
                                 ((y + .5) / supersample - origin[1]) / scale, front))
                start = view @ transform
                intersector.Perform(gp_Lin(gp_Pnt(*start), direction), 0, ray_length)
                tested += 1
                if not intersector.IsDone():
                    raise RuntimeError(f'Pixel-ray intersection failed on face {record["face"]}')
                for i in range(1, intersector.NbPnt() + 1):
                    hit = intersector.Pnt(i)
                    z = float(np.array(hit.Coord()) @ transform[2])
                    hits += 1
                    if z <= depth[y, x] + 1e-7:
                        continue
                    point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
                    surface.D1(intersector.UParameter(i), intersector.VParameter(i), point, du, dv)
                    normal = np.cross(du.Coord(), dv.Coord()) @ transform.T
                    norm = np.linalg.norm(normal)
                    if norm <= 1e-12:
                        raise RuntimeError(f'Undefined surface normal on face {record["face"]}')
                    normal /= norm
                    if normal[2] < 0:
                        normal *= -1
                    depth[y, x], normals[y, x] = z, normal
                    written += 1
        records.append({'face': record['face'], 'tested_pixels': tested, 'ray_hits': hits,
                        'zbuffer_writes': written, 'valid_brep': record['valid_brep']})
    return records


def render_buffers(mesh, mirror, rotation, supersample=4, width=WIDTH, height=HEIGHT, padding=PAD):
    """Unlit smooth CAD normals + linear orthographic depth, explicit headless EGL."""
    from vtkmodules.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray, vtk_to_numpy
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    from vtkmodules.vtkRenderingCore import vtkActor, vtkPolyDataMapper, vtkRenderer, vtkWindowToImageFilter
    from vtkmodules.vtkRenderingOpenGL2 import vtkEGLRenderWindow

    transform = camera() @ orientation_matrix(mirror, rotation)
    points = mesh[0] @ transform.T
    normals = mesh[1] @ transform.T
    fit_points = points
    if len(mesh) > 4 and len(mesh[4]):
        curves = mesh[4].reshape(-1, 3) @ transform.T
        fit_points = np.vstack((points.min(axis=0), points.max(axis=0),
                                curves.min(axis=0), curves.max(axis=0)))
        del curves
    scale, origin, bounds = fit_projection(fit_points, width, height, padding)
    # VTK camera looks along -Z with screen UP, unlike image buffer row order.
    points[:, 1] *= -1
    normals[:, 1] *= -1
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
    colors = np.rint((normals + 1) * 127.5).clip(0, 255).astype(np.uint8)
    vtk_points = vtkPoints()
    vtk_points.SetData(numpy_to_vtk(np.ascontiguousarray(points), deep=True))
    cells = vtkCellArray()
    cells.SetData(numpy_to_vtkIdTypeArray(np.arange(0, mesh[2].size + 1, 3, dtype=np.int64), deep=True),
                  numpy_to_vtkIdTypeArray(np.ascontiguousarray(mesh[2].ravel()), deep=True))
    data = vtkPolyData()
    data.SetPoints(vtk_points)
    data.SetPolys(cells)
    data.GetPointData().SetScalars(numpy_to_vtk(colors, deep=True))
    mapper = vtkPolyDataMapper()
    mapper.SetInputData(data)
    mapper.SetColorModeToDirectScalars()
    mapper.SetScalarModeToUsePointData()
    actor = vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().LightingOff()
    actor.GetProperty().BackfaceCullingOff()
    actor.GetProperty().FrontfaceCullingOff()
    renderer = vtkRenderer()
    renderer.SetBackground(0, 0, 0)
    renderer.AddActor(actor)
    window = vtkEGLRenderWindow()
    window.SetOffScreenRendering(1)
    window.SetMultiSamples(0)
    window.SetSize(width * supersample, height * supersample)
    window.AddRenderer(renderer)
    cam = renderer.GetActiveCamera()
    center = points.mean(axis=0)
    center[:2] = [(width / 2 - origin[0]) / scale, -(height / 2 - origin[1]) / scale]
    span = float(np.ptp(points[:, 2]))
    distance = max(span * 2, 1)
    cam.SetPosition(center[0], center[1], points[:, 2].max() + distance)
    cam.SetFocalPoint(center[0], center[1], center[2])
    cam.SetViewUp(0, 1, 0)
    cam.ParallelProjectionOn()
    cam.SetParallelScale(height / (2 * scale))
    near, far = distance * .5, distance + span + distance * .5
    cam.SetClippingRange(near, far)
    try:
        window.Render()
        capture = vtkWindowToImageFilter()
        capture.SetInput(window)
        capture.ReadFrontBufferOff()
        capture.SetInputBufferTypeToRGB()
        capture.Update()
        rgb = vtk_to_numpy(capture.GetOutput().GetPointData().GetScalars()).reshape(height * supersample, width * supersample, 3)[::-1].copy()
        capture.SetInputBufferTypeToZBuffer()
        capture.Modified()
        capture.Update()
        z = vtk_to_numpy(capture.GetOutput().GetPointData().GetScalars()).reshape(height * supersample, width * supersample)[::-1].copy()
    finally:
        window.Finalize()
    valid = z < 1
    if not valid.any():
        raise RuntimeError('Empty EGL render; refusing empty SVG')
    depth = cam.GetPosition()[2] - (near + z * (far - near))
    depth[~valid] = -np.inf
    normals = rgb.astype(np.float32) / 127.5 - 1
    normals[..., 1] *= -1
    normals /= np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-12)
    normals[normals[..., 2] < 0] *= -1  # Open/back-facing shells still contour consistently.
    normals[~valid] = 0
    fallback = render_analytic_faces(mesh[3], depth, normals, transform, scale, origin, supersample)
    return depth, normals, {'scale_px_per_mm': scale, 'origin': origin.tolist(),
                            'geometry_bounds_px': bounds.tolist(), 'backend': 'vtkEGLRenderWindow',
                            'supersample': supersample, 'buffer_size': [width * supersample, height * supersample],
                            'analytic_fallback': fallback}


def font(size):
    from PIL import ImageFont
    for path in ('/usr/share/fonts/inter/InterVariable.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def draw_chains(chains, supersample=2):
    from PIL import Image, ImageDraw
    image = Image.new('L', (WIDTH * supersample, HEIGHT * supersample), 0)
    draw = ImageDraw.Draw(image)
    width = max(1, round(STROKE * supersample))
    radius = width / 2
    for chain in chains:
        points = [(x * supersample, y * supersample) for x, y in chain]
        if len(points) > 1:
            draw.line(points, fill=255, width=width, joint='curve')
        for x, y in (points[0], points[-1]):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    return image


def contact_sheet(mesh, output):
    from PIL import Image, ImageDraw
    sheet = Image.new('RGB', (4 * 400, 4 * 300), '#f5f6f7')
    draw = ImageDraw.Draw(sheet)
    choices = []
    for i in range(16):
        mirror, rotation = ('none' if i < 8 else 'x'), (i % 8) * 45
        log(f'Contact sheet {i + 1}/16: --rotation {rotation} --mirror {mirror}')
        depth, normals, _ = render_buffers(mesh, mirror, rotation, 1, 380, 250, 12)
        valid = np.isfinite(depth)
        rgb = np.full((*valid.shape, 3), 245, np.uint8)
        shade = np.clip(110 + 70 * normals[..., 2] - 20 * normals[..., 0], 65, 205)
        rgb[valid] = shade[valid, None].astype(np.uint8)
        p = np.pad(valid, 1)
        boundary = valid & ~(p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:])
        rgb[boundary] = (75, 82, 88)
        x, y = (i % 4) * 400 + 10, (i // 4) * 300 + 40
        sheet.paste(Image.fromarray(rgb), (x, y))
        draw.text((x, y - 32), f'{i + 1:02d}   {rotation:03d}°   mirror {mirror}', font=font(18), fill=INK)
        choices.append({'number': i + 1, 'rotation': rotation, 'mirror': mirror})
    sheet.save(output / 'contact-sheet.png')
    (output / 'contact-sheet.json').write_text(json.dumps(choices, indent=2) + '\n')


def comparison_alignment(exact, projection, mirror, rotation):
    """Reject filtered/shifted/mismatched diagnostic baselines; align only fitting."""
    orientation = exact.get('orientation', {})
    if (exact.get('algorithm') != 'exact' or exact.get('excluded_bodies') or
            exact.get('suppressed_fasteners') or exact.get('shift_groups') or
            orientation.get('mirror') != mirror or
            not math.isfinite(orientation.get('rotation_degrees', float('inf'))) or
            abs((orientation.get('rotation_degrees', float('inf')) - rotation + 180) % 360 - 180) > 1e-8):
        raise ValueError('Comparison must be same-orientation exact HLR, with NO exclusions, shifts or fastener suppression')
    variants = exact.get('variants', {})
    if not variants or any(v.get('threshold_ratio') != 0 or v.get('kept_bodies') != exact.get('body_count')
                           for v in variants.values()):
        raise ValueError('Comparison must keep ALL bodies, with threshold 0')
    ratio = projection['scale_px_per_mm'] / exact['fit_scale_px_per_mm']
    offset = np.array(projection['origin']) - ratio * np.array(exact['fit_origin'])
    return float(ratio), offset.tolist()


def make_review(output, reference, comparison_svg=None, comparison_report=None, report=None):
    """Align analytic fitting, never match by eyeballing or deforming geometry."""
    from PIL import Image, ImageDraw, ImageOps
    import shutil
    import subprocess
    sheet = Image.new('RGB', (3 * 800, 660), '#f5f6f7')
    draw = ImageDraw.Draw(sheet)
    captions = ['Наш контур: вся STEP-сборка', 'Референс конструкторов',
                'Наложение на exact HLR без фильтров' if comparison_svg else 'Ракурсы различаются: НЕ доказательство совпадения']
    outline = Image.open(output / 'outline.png').convert('RGBA')
    sheet.paste(outline.resize((760, 500)), (20, 115), outline.resize((760, 500)))
    with Image.open(reference) as source:
        ref = ImageOps.contain(source.convert('RGBA'), (760, 520))
        sheet.paste(ref, (800 + (800 - ref.width) // 2, 110 + (520 - ref.height) // 2), ref)
    if comparison_svg:
        import xml.etree.ElementTree as ET
        if not shutil.which('rsvg-convert'):
            raise RuntimeError('--comparison-svg needs system rsvg-convert')
        exact_report = json.loads(comparison_report.read_text())
        if exact_report.get('source') != report['source']:
            raise ValueError('Comparison STEP source does not match this run')
        ratio, offset = comparison_alignment(exact_report, report['projection'],
                                              report['orientation']['mirror'], report['orientation']['rotation'])
        root = ET.fromstring(comparison_svg.read_text())
        group = ET.Element('{http://www.w3.org/2000/svg}g',
                           {'transform': f'translate({offset[0]} {offset[1]}) scale({ratio})'})
        for child in list(root):
            root.remove(child)
            group.append(child)
        root.append(group)
        aligned_svg = output / 'exact-unfiltered-aligned.svg'
        ET.ElementTree(root).write(aligned_svg, encoding='utf-8', xml_declaration=True)
        report['comparison'] = {'svg': str(comparison_svg), 'report': str(comparison_report),
                                 'fit_ratio': ratio, 'fit_offset': offset,
                                 'geometry_changes': 'none; only global 2D projection fit aligned'}
        target = output / 'exact-unfiltered-aligned.png'
        subprocess.run(['rsvg-convert', '--width', '1520', '--height', '1000',
                        '--output', str(target), str(aligned_svg)], check=True)
        exact = Image.open(target).convert('RGBA').resize((760, 500))
        overlay = Image.new('RGBA', (760, 500), 'white')
        gray = Image.new('RGBA', exact.size, '#aeb6bf')
        gray.putalpha(exact.getchannel('A'))
        overlay = Image.alpha_composite(overlay, gray)
        cyan = Image.new('RGBA', (760, 500), (0, 100, 175, 0))
        cyan.putalpha(outline.resize((760, 500)).getchannel('A').point(lambda a: round(a * .8)))
        overlay = Image.alpha_composite(overlay, cyan)
        sheet.paste(overlay, (1620, 115))
        draw.text((1620, 620), 'Серый: exact. Синий: новый контур (z-buffer + CAD).', font=font(16), fill=INK)
    else:
        sheet.paste(outline.resize((760, 500)), (1620, 115), outline.resize((760, 500)))
    for i, caption in enumerate(captions):
        draw.text((800 * i + 20, 24), caption, font=font(20), fill=INK)
    draw.text((820, 58), 'Исходный ракурс; компоновка STEP не изменялась.', font=font(16), fill=INK)
    sheet.save(output / 'outline-review.png')


def write_outline(mesh, args, report):
    from PIL import Image, ImageFilter
    tick = time.perf_counter()
    depth, normals, projection = render_buffers(mesh, args.mirror, args.rotation, args.supersample)
    report['projection'] = projection
    projection['mesh_chord_error_px'] = report['mesh']['deflection_mm'] * projection['scale_px_per_mm']
    report['timings_seconds']['render'] = round(time.perf_counter() - tick, 3)
    tick = time.perf_counter()
    masks = detect_edges(depth, normals, projection['scale_px_per_mm'], args.supersample,
                         args.crease_angle, args.depth_jump)
    raw = masks[0] | masks[1] | masks[2]
    transform = camera() @ orientation_matrix(args.mirror, args.rotation)
    edge_tolerance = max(args.edge_depth_tolerance, projection['mesh_chord_error_px'] * 1.25)
    cad_edges = visible_cad_edges(mesh[4], depth, transform, projection['scale_px_per_mm'],
                                  np.array(projection['origin']), args.supersample, edge_tolerance)
    raw |= cad_edges
    Image.fromarray(cad_edges).save(args.output_dir / 'cad-edges.png')
    projection['cad_edge_depth_tolerance_px'] = edge_tolerance
    for name, mask in zip(('silhouette', 'depth-edges', 'normal-edges'), masks):
        Image.fromarray(mask).save(args.output_dir / f'{name}.png')
    rgb = np.rint((normals + 1) * 127.5).clip(0, 255).astype(np.uint8)
    rgb[~np.isfinite(depth)] = 255
    Image.fromarray(rgb).resize((WIDTH * 2, HEIGHT * 2)).save(args.output_dir / 'normals.png')
    finite = np.isfinite(depth)
    shade = np.zeros(depth.shape, np.uint8)
    values = depth[finite]
    shade[finite] = np.rint(40 + 200 * (values - values.min()) / max(float(np.ptp(values)), 1e-8)).astype(np.uint8)
    Image.fromarray(shade).resize((WIDTH * 2, HEIGHT * 2)).save(args.output_dir / 'depth.png')
    del normals, depth, rgb, finite, shade
    skeleton = skeletonize(close_gaps(raw))
    Image.fromarray(skeleton).save(args.output_dir / 'skeleton.png')
    chains = trace_skeleton(skeleton, args.supersample)
    report['timings_seconds']['edges_thin_trace'] = round(time.perf_counter() - tick, 3)
    tick = time.perf_counter()
    # Never trade away components to meet a file budget; bound geometric error.
    tolerance = args.simplify
    while True:
        simplified = [simplify(chain, tolerance) for chain in chains]
        svg = svg_text(simplified, f'{args.input.stem} — контур всей STEP-сборки')
        if len(svg.encode()) <= args.max_svg_bytes or tolerance >= args.max_simplify:
            break
        tolerance = min(args.max_simplify, round(tolerance + .04, 3))
    (args.output_dir / 'outline.svg').write_text(svg, encoding='utf-8')
    mask = draw_chains(simplified, args.supersample)
    # Measured coverage is diagnostic, not proof that a STEP contains every part.
    covered = np.asarray(mask.filter(ImageFilter.MaxFilter(3))) > 0
    missing = raw & ~covered
    report['vector'] = {'chains': len(chains), 'source_skeleton_pixels': int(skeleton.sum()),
                        'points': sum(map(len, simplified)), 'simplification_px': tolerance,
                        'svg_bytes': len(svg.encode()), 'svg_budget_bytes': args.max_svg_bytes,
                        'within_budget': len(svg.encode()) <= args.max_svg_bytes,
                        'raw_edge_pixels': int(raw.sum()), 'uncovered_edge_pixels': int(missing.sum()),
                        'raw_edge_coverage': 1 - int(missing.sum()) / max(1, int(raw.sum())),
                        'coverage_tolerance_px': .5 * STROKE + 1 / args.supersample}
    audit = np.full((*raw.shape, 3), 255, np.uint8)
    audit[raw] = (160, 166, 171)
    audit[missing] = (230, 30, 30)
    Image.fromarray(audit).save(args.output_dir / 'vector-coverage.png')
    # Prefer the actual SVG raster for review. Pillow is a dependency-only fallback.
    import shutil
    import subprocess
    if shutil.which('rsvg-convert'):
        subprocess.run(['rsvg-convert', '--width', '1520', '--height', '1000', '--output',
                        str(args.output_dir / 'outline.png'), str(args.output_dir / 'outline.svg')], check=True)
    else:
        ink = Image.new('RGBA', mask.size, INK)
        ink.putalpha(mask)
        ink.resize((WIDTH * 2, HEIGHT * 2), Image.Resampling.LANCZOS).save(args.output_dir / 'outline.png')
    report['timings_seconds']['simplify_export'] = round(time.perf_counter() - tick, 3)
    log(f'SVG: {len(svg.encode()) / 1024:.1f} KiB; {len(chains)} chains; raw edge coverage {report["vector"]["raw_edge_coverage"]:.5%}')
    if not report['vector']['within_budget']:
        log('WARNING: SVG over budget; components retained. Increase --max-simplify or lower image detail globally.')
    if args.reference:
        make_review(args.output_dir, args.reference, args.comparison_svg, args.comparison_report, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--rotation', type=float, default=0)
    parser.add_argument('--mirror', choices=('none', 'x', 'y'), default='none')
    parser.add_argument('--contact-sheet', action='store_true', help='Only render 16 labelled coarse-mesh choices.')
    parser.add_argument('--supersample', type=int, choices=(4, 8), default=4)
    parser.add_argument('--mesh-error', type=float, default=.18, help='Chord-error target in canvas px, not a body filter.')
    parser.add_argument('--angular-deflection', type=float, default=.2, help='Radians.')
    parser.add_argument('--crease-angle', type=float, default=32, help='Degrees of normal discontinuity.')
    parser.add_argument('--depth-jump', type=float, default=.35, help='Tangent-plane depth residual, canvas px.')
    parser.add_argument('--edge-depth-tolerance', type=float, default=.45,
                        help='Z-buffer tolerance for original CAD curves, canvas px; at least the mesh chord error.')
    parser.add_argument('--simplify', type=float, default=.18, help='RDP error in canvas px.')
    parser.add_argument('--max-simplify', type=float, default=.5, help='Hard error limit for automatic SVG budget fitting (below half the stroke width).')
    parser.add_argument('--max-svg-bytes', type=int, default=300 * 1024)
    parser.add_argument('--no-cache', action='store_true')
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--comparison-svg', type=Path, help='Same-view unfiltered/unshifted exact HLR, for review only.')
    parser.add_argument('--comparison-report', type=Path, help='Matching step-hlr report.json, to validate and align fitting.')
    args = parser.parse_args()
    for path in (args.input, args.output_dir, args.reference, args.comparison_svg, args.comparison_report):
        if path is not None and not path.is_absolute():
            parser.error('All paths must be absolute; input directories are untrusted data only.')
    if args.input.suffix.lower() not in ('.step', '.stp'):
        parser.error('Input must be .step or .stp')
    if args.output_dir.resolve().is_relative_to(args.input.parent.resolve()):
        parser.error('Output must be outside the untrusted input directory.')
    if not math.isfinite(args.rotation):
        parser.error('--rotation must be finite')
    for name in ('mesh_error', 'angular_deflection', 'crease_angle', 'depth_jump', 'edge_depth_tolerance', 'simplify', 'max_simplify'):
        if not math.isfinite(getattr(args, name)) or getattr(args, name) <= 0:
            parser.error(f'--{name.replace("_", "-")} must be positive and finite')
    if args.crease_angle >= 180 or args.max_simplify < args.simplify or args.max_svg_bytes < 1:
        parser.error('Invalid crease angle, simplification range or SVG budget')
    if args.comparison_svg and not args.reference:
        parser.error('--comparison-svg requires --reference')
    if bool(args.comparison_svg) != bool(args.comparison_report):
        parser.error('--comparison-svg and --comparison-report must be supplied together')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    report = {'source': str(args.input), 'source_bytes': args.input.stat().st_size,
              'method': 'whole XCAF assembly EGL depth/normals + depth-tested CAD curves; exact pixel-ray fallback; skeleton SVG',
              'orientation': {'mirror': args.mirror, 'rotation': args.rotation, 'axes': 'original STEP; mirror then rotate'},
              'camera': {'azimuth': 55, 'elevation': 31}, 'canvas': [WIDTH, HEIGHT], 'padding': PAD,
              'ink': INK, 'stroke_width': STROKE, 'timings_seconds': {},
              'parameters': {k: v for k, v in vars(args).items() if not isinstance(v, Path)}}
    report['command'] = [sys.executable, '-I', str(Path(__file__).resolve()), *sys.argv[1:]]
    report['dependencies'] = {name: importlib.metadata.version(name) for name in ('cadquery-ocp', 'numpy', 'pillow', 'vtk')}
    try:
        if args.contact_sheet:
            args.mesh_error = max(1.2, args.mesh_error)
            args.angular_deflection = max(.45, args.angular_deflection)
        report['effective_mesh_parameters'] = {'error_target_px': args.mesh_error,
                                               'angular_deflection': args.angular_deflection}
        mesh = load_mesh(args, report)
        if args.contact_sheet:
            tick = time.perf_counter()
            contact_sheet(mesh, args.output_dir)
            report['timings_seconds']['contact_sheet'] = round(time.perf_counter() - tick, 3)
        else:
            write_outline(mesh, args, report)
        report['status'] = 'ok'
    except Exception as exc:
        report['status'] = 'failed'
        report['error'] = f'{type(exc).__name__}: {exc}'
        raise
    finally:
        report['total_seconds'] = round(time.perf_counter() - started, 3)
        report['peak_rss_mib'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
        target = 'contact-sheet-report.json' if args.contact_sheet else 'report.json'
        (args.output_dir / target).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        log(f'{report.get("status")}: {report["total_seconds"]}s; peak RSS {report["peak_rss_mib"]} MiB')


if __name__ == '__main__':
    main()
