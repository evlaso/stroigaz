#!/usr/bin/env python3
"""python -I scripts/anatomy/step-hlr.test.py (OCP integration uses step-venv)."""
import importlib.util
import argparse
import json
import math
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

SCRIPT = Path(__file__).with_name('step-hlr.py')
M = runpy.run_path(str(SCRIPT))


def transform(point, mirror, angle):
    return tuple(sum(a * b for a, b in zip(point, row))
                 for row in M['orientation_matrix'](mirror, angle))


class Contours(unittest.TestCase):
    def test_reflect_before_rotation_in_original_step_axes(self):
        for actual, expected in zip(transform((2, 3, 4), 'x', 90), (-3, -2, 4)):
            self.assertAlmostEqual(actual, expected)
        for actual, expected in zip(transform((2, 3, 4), 'y', 90), (3, 2, 4)):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(transform((2, 3, 4), 'none', 0), (2, 3, 4))

    def test_mirror_equivalence_and_periodicity(self):
        for angle in range(0, 360, 5):
            for point in ((1, 0, 0), (0, 1, 0), (32, -98, 61)):
                x = transform(point, 'x', angle)
                y = transform(point, 'y', angle + 180)
                for a, b, c in zip(x, y, transform(point, 'x', angle + 360)):
                    self.assertAlmostEqual(a, b)
                    self.assertAlmostEqual(a, c)

    def test_selected_side_front_and_front_edge(self):
        # Front is STEP +Y; at x/350 it projects left/down. Width from
        # +X to -X slopes down/right; the -X wall faces the camera.
        right, down, toward = M['camera']()
        front = transform((0, 1, 0), 'x', 350)
        screen = M['project'](front)
        self.assertLess(screen[0], 0)
        self.assertGreater(screen[1], 0)
        edge = M['project'](transform((-1, 0, 0), 'x', 350))
        self.assertTrue(all(v > 0 for v in edge))
        side = transform((-1, 0, 0), 'x', 350)
        self.assertGreater(sum(a * b for a, b in zip(side, toward)), 0)

    def test_camera_unchanged(self):
        a, e = map(math.radians, (55, 31))
        point = (16, -23, 42)
        expected = (point[0] * math.sin(a) - point[1] * math.cos(a),
                    (point[0] * math.cos(a) + point[1] * math.sin(a)) * math.sin(e)
                    - point[2] * math.cos(e))
        for actual, target in zip(M['project'](point), expected):
            self.assertAlmostEqual(actual, target)

    def test_exclusion_is_exact_not_substring(self):
        record = {'id': 'root/part/solid:1', 'name': 'Профиль 1026.2'}
        self.assertTrue(M['excluded_body'](record, [record['id']], []))
        self.assertTrue(M['excluded_body'](record, [], [record['name']]))
        self.assertFalse(M['excluded_body'](record, ['part'], ['Профиль']))

    def test_standard_hardware_is_distinct_from_functional_union_nuts(self):
        for name in ('Болт М6-6gx30 ГОСТ 7798', 'Гайка М16x1,5-6H ГОСТ 5915',
                     'Шайба A.8.37 ГОСТ 11371', 'Шпилька М10-6gx65', 'Винт М4',
                     ' BOLT ', 'Washer M6', 'NUT'):
            self.assertTrue(M['standard_fastener'](name), name)
        for name in ('Гайка ПВХ DN25', 'NTVKD020V', 'ENDIV020', 'COMPOUND', 'SOLID',
                     'Крышка стакана', '1', 'Boltless cap'):
            self.assertFalse(M['standard_fastener'](name), name)

    def test_shift_parser_rejects_nonfinite_and_bad_vectors(self):
        self.assertEqual(M['parse_shift']('name=with=equals=-3.5,20'), ('name=with=equals', (-3.5, 20)))
        for value in ('id=nan,0', 'id=0,inf', '=1,2', 'id=1', 'id=1,2,3', 'id=oops,0'):
            with self.assertRaises(argparse.ArgumentTypeError):
                M['parse_shift'](value)

    def test_shift_group_moves_descendants_and_whole_accessory_subtrees(self):
        def node(identifier, box, name=''):
            return dict(id=identifier, label=identifier.rsplit('/', 1)[-1], name=name,
                        occurrence_name='', bounds=box)
        nodes = [node('root', (0, 0, 0, 100, 100, 200)),
                 node('root/a', (0, 0, 0, 10, 10, 20), 'tank'),
                 node('root/a/lid', (2, 2, 20, 8, 8, 22)),
                 node('root/b', (30, 0, 0, 40, 10, 20), 'tank'),
                 # Accessory straddles the XY envelope; its child is outside it.
                 node('root/drive', (8, 2, 20, 15, 8, 50)),
                 node('root/drive/handle', (12, 2, 45, 15, 8, 50)),
                 node('root/link', (5, 2, 21, 35, 8, 22)),
                 node('root/panel', (60, 0, 0, 100, 10, 100))]
        def bodies():
            return [dict(id=n['id'] + '/solid:1', bounds=n['bounds']) for n in nodes[1:]]
        requests = [('a', (100, 200)), ('root/b', (-10, 0))]
        inventory = bodies()
        groups, shared = M['shift_groups'](nodes, inventory, requests)
        self.assertEqual(groups[0]['accessory_roots'], ['root/drive'])
        for record in (inventory[0], inventory[1], inventory[3], inventory[4]):
            self.assertEqual(record['shift_mm'], [100, 200, 0])
            self.assertEqual(record['shifted_bounds'][2], record['bounds'][2])
            self.assertEqual(record['shifted_bounds'][0], record['bounds'][0] + 100)
        self.assertEqual(shared, ['root/link/solid:1'])
        self.assertNotIn('shift_mm', inventory[-1])
        reverse = bodies()
        M['shift_groups'](nodes, reverse, requests[::-1])
        self.assertEqual(reverse, inventory)
        for invalid in ([('tank', (0, 0))], [('missing', (0, 0))], requests + [('a', (0, 0))],
                        [('root', (0, 0)), ('a', (0, 0))]):
            with self.assertRaises(ValueError):
                M['shift_groups'](nodes, bodies(), invalid)

    def test_stitch_preserves_circle_and_junction_removes_noise(self):
        circle = [(10 * math.cos(i * math.tau / 120), 10 * math.sin(i * math.tau / 120))
                  for i in range(121)]
        chains, _ = M['stitch']([[a, b] for a, b in zip(circle, circle[1:])]
                               + [[(100, 0), (100.4, 0)]], minimum=2)
        self.assertEqual(len(chains), 1)
        self.assertEqual(chains[0][0], chains[0][-1])
        chains, _ = M['stitch']([[(0, 0), (5, 0)], [(5, 0), (10, 0)], [(5, 0), (5, 5)]])
        self.assertEqual(len(chains), 3)

    def test_subtree_shift_does_not_capture_nearby_panel(self):
        def node(identifier, box):
            return dict(id=identifier, label=identifier, name=identifier,
                        occurrence_name='', bounds=box)
        nodes = [node('root', (0, 0, 0, 100, 100, 200)),
                 node('root/tank', (0, 0, 0, 10, 10, 20)),
                 node('root/support', (20, 0, 0, 30, 10, 50)),
                 node('root/support/clamp', (20, 0, 40, 30, 10, 50)),
                 node('root/panel', (25, 0, 0, 100, 10, 100))]
        records = [dict(id=n['id'] + '/solid:1', bounds=n['bounds']) for n in nodes[1:]]
        groups, shared = M['shift_groups'](nodes, records, [('root/tank', (15, 5))],
                                         [('root/support', (15, 5))])
        self.assertEqual([r.get('shift_mm') for r in records], [[15, 5, 0]] * 3 + [None])
        self.assertEqual(groups[1]['accessory_roots'], [])
        self.assertEqual(shared, [])
        with self.assertRaises(ValueError):
            M['shift_groups'](nodes, records, [('root/tank', (1, 0))],
                              [('root/tank', (2, 0))])

    def test_full_shift_captures_roof_accessories_outside_tank_ancestry_and_z(self):
        def node(identifier, box):
            return dict(id=identifier, label=identifier, name=identifier,
                        occurrence_name='', bounds=box)
        nodes = [node('root', (0, 0, 0, 100, 100, 200)),
                 node('root/tank', (0, 0, 0, 10, 10, 20)),
                 node('root/tank/neck', (2, 2, 19, 4, 4, 22)),
                 node('root/funnel', (1, 1, 20, 5, 5, 30)),
                 node('root/drive', (6, 6, 21, 9, 9, 45)),
                 node('root/panel', (20, 20, 0, 100, 30, 100))]
        def bodies():
            return [dict(id=n['id'] + '/solid:1', bounds=n['bounds']) for n in nodes[1:]]
        request = [('root/tank', (475, 900))]
        full, subtree = bodies(), bodies()
        groups, _ = M['shift_groups'](nodes, full, request)
        M['shift_groups'](nodes, subtree, [], request)
        self.assertEqual(groups[0]['accessory_roots'], ['root/funnel', 'root/drive'])
        self.assertEqual([b.get('shift_mm') for b in full], [[475, 900, 0]] * 4 + [None])
        self.assertEqual([b.get('shift_mm') for b in subtree], [[475, 900, 0]] * 2 + [None] * 3)

    def test_svg_contract(self):
        root = ET.fromstring(M['svg_text']([[(20, 20), (740, 480)]], 'A < B & C'))
        self.assertEqual(root.attrib['viewBox'], '0 0 760 500')
        self.assertEqual(root.attrib['aria-label'], 'A < B & C')
        self.assertEqual(root[0].attrib['stroke'], '#383e43')
        self.assertEqual(root[0].attrib['stroke-width'], '1.05')


@unittest.skipUnless(importlib.util.find_spec('OCP'), 'Run in step-venv for OCC integration')
class Occurrences(unittest.TestCase):
    def test_lower_threshold_keeps_functional_parts_without_standard_hardware(self):
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.STEPCAFControl import STEPCAFControl_Writer
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopLoc import TopLoc_Location
        from OCP.XCAFDoc import XCAFDoc_DocumentTool
        from OCP.gp import gp_Trsf, gp_Vec

        doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
        tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        root = tool.NewShape()
        for i, (name, dimensions) in enumerate((('Tank', (100, 100, 1000)),
                                              ('SOLID', (25, 25, 25)),
                                              ('Гайка ПВХ DN25', (32, 32, 20)),
                                              ('Болт М6-6gx30 ГОСТ 7798', (40, 10, 10)),
                                              ('Шайба A.6.37 ГОСТ 11371', (12, 12, 2)))):
            part = tool.AddShape(BRepPrimAPI_MakeBox(*dimensions).Shape(), False)
            TDataStd_Name.Set_s(part, TCollection_ExtendedString(name, True))
            location = gp_Trsf()
            location.SetTranslation(gp_Vec(i*150, 0, 0))
            tool.AddComponent(root, part, TopLoc_Location(location))
        tool.UpdateAssemblies()
        with tempfile.TemporaryDirectory(prefix='hlr-details-', dir='/tmp/opencode') as directory:
            folder = Path(directory)
            source = folder / 'details.step'
            writer = STEPCAFControl_Writer()
            self.assertTrue(writer.Transfer(doc))
            writer.Write(str(source))
            for name, options in (('old', []), ('fixed', ['--thresholds', '.06', '.015', '.01',
                                                        '--suppress-fasteners'])):
                output = folder / name
                result = subprocess.run([sys.executable, '-I', str(SCRIPT), str(source),
                                         '--output-dir', str(output), '--no-png', '--variants', 'medium',
                                         *options], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                report = json.loads((output / 'dosing-hlr-report.json').read_text())
                inventory = json.loads((output / 'dosing-hlr-inventory.json').read_text())
                names = {b['id']: b['name'] for b in inventory['bodies']}
                kept = {names[identifier] for identifier in report['variants']['medium']['kept_body_ids']}
                self.assertEqual(kept, {'Tank', 'SOLID', 'Гайка ПВХ DN25'} if name == 'fixed' else
                                 {'Tank', 'Болт М6-6gx30 ГОСТ 7798'})
                self.assertEqual(len(report['suppressed_fasteners']), 2 if name == 'fixed' else 0)
                self.assertEqual(report['excluded_bodies'], [])

    def test_front_edges_are_not_cut_by_rear_body(self):
        """Exercise the real CLI/camera, including overlapping screen bounds."""
        from OCP.BRep import BRep_Builder
        from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
        from OCP.TopoDS import TopoDS_Compound
        from OCP.gp import gp_Pnt, gp_Trsf

        right, down, toward = M['camera']()
        orientation = gp_Trsf()
        orientation.SetValues(*(v for i in range(3)
                                for v in (right[i], down[i], toward[i], 0)))
        builder, assembly = BRep_Builder(), TopoDS_Compound()
        builder.MakeCompound(assembly)
        for x, y, z in ((-100, -80, 20), (-50, -40, -50)):
            box = BRepPrimAPI_MakeBox(gp_Pnt(x, y, z), 150, 100, 20).Shape()
            builder.Add(assembly, BRepBuilderAPI_Transform(box, orientation, True).Shape())
        with tempfile.TemporaryDirectory(prefix='hlr-visibility-', dir='/tmp/opencode') as directory:
            folder = Path(directory)
            writer = STEPControl_Writer()
            writer.Transfer(assembly, STEPControl_AsIs)
            source = folder / 'overlap.step'
            writer.Write(str(source))
            for algorithm in ('poly', 'exact'):
                output = folder / algorithm
                result = subprocess.run([sys.executable, '-I', str(SCRIPT), str(source),
                                         '--output-dir', str(output), '--no-png', '--variants', 'medium',
                                         '--mirror', 'none', '--rotation', '0', '--algorithm', algorithm],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                report = json.loads((output / 'dosing-hlr-report.json').read_text())
                svg = ET.parse(output / 'dosing-hlr-medium.svg').getroot()
                chains = []
                for path in svg.iter('{http://www.w3.org/2000/svg}path'):
                    for chain in path.attrib['d'].split('M')[1:]:
                        chains.append([tuple(map(float, pair.split(','))) for pair in chain.split('L')])

                def distance(point):
                    px, py = [o + v * report['fit_scale_px_per_mm']
                              for o, v in zip(report['fit_origin'], point)]
                    distances = []
                    for chain in chains:
                        for (ax, ay), (bx, by) in zip(chain, chain[1:]):
                            dx, dy = bx - ax, by - ay
                            t = max(0, min(1, ((px - ax)*dx + (py - ay)*dy) / (dx*dx + dy*dy)))
                            distances.append(math.hypot(px - ax - t*dx, py - ay - t*dy))
                    return min(distances)

                self.assertLess(distance((0, 20)), .05, algorithm)  # Front edge stays whole.
                self.assertGreater(distance((-50, 0)), 5, algorithm)  # Rear edge is hidden.
                self.assertLess(distance((-50, 40)), .05, algorithm)  # Rear edge reappears below.

    def test_named_repeated_occurrences_filter_and_poly_exact(self):
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
        from OCP.STEPCAFControl import STEPCAFControl_Writer
        from OCP.TCollection import TCollection_ExtendedString
        from OCP.TDataStd import TDataStd_Name
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopLoc import TopLoc_Location
        from OCP.XCAFDoc import XCAFDoc_DocumentTool
        from OCP.gp import gp_Trsf, gp_Vec

        with tempfile.TemporaryDirectory(prefix='hlr-tests-', dir='/tmp/opencode') as folder:
            folder = Path(folder)
            doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
            tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
            part = tool.AddShape(BRepPrimAPI_MakeBox(100, 120, 300).Shape(), False)
            TDataStd_Name.Set_s(part, TCollection_ExtendedString('Repeated box'))
            root = tool.NewShape()
            for x in (0, 250):
                location = gp_Trsf()
                location.SetTranslation(gp_Vec(x, 0, 0))
                tool.AddComponent(root, part, TopLoc_Location(location))
            tool.UpdateAssemblies()
            writer = STEPCAFControl_Writer()
            self.assertTrue(writer.Transfer(doc))
            source = folder / 'fixture.step'
            writer.Write(str(source))

            def run(name, *args, check=True):
                result = subprocess.run([sys.executable, '-I', str(SCRIPT), str(source),
                                         '--output-dir', str(folder / name), '--no-png',
                                         '--variants', 'medium', '--rotation', '0', '--mirror', 'none',
                                         *args], capture_output=True, text=True)
                if check:
                    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                return result

            run('inventory', '--inventory-only')
            inv = json.loads((folder / 'inventory/dosing-hlr-inventory.json').read_text())
            self.assertEqual(len(inv['bodies']), 2)
            ids = [record['id'] for record in inv['bodies']]
            self.assertEqual(len(set(ids)), 2)
            self.assertEqual({record['name'] for record in inv['bodies']}, {'Repeated box'})
            run('poly')
            run('exact', '--algorithm', 'exact')
            self.assertEqual((folder / 'poly/dosing-hlr-medium.svg').read_text(),
                             (folder / 'exact/dosing-hlr-medium.svg').read_text())
            run('excluded', '--exclude-body', ids[0])
            report = json.loads((folder / 'excluded/dosing-hlr-report.json').read_text())
            self.assertEqual(report['body_count'], 2)
            self.assertEqual(report['variants']['medium']['kept_bodies'], 1)
            self.assertEqual(report['excluded_bodies'][0]['id'], ids[0])
            run('name', '--exclude-name', 'Repeated box', '--inventory-only')
            self.assertEqual(len(json.loads((folder / 'name/dosing-hlr-inventory.json').read_text())['excluded']), 2)
            self.assertNotEqual(run('invalid', '--exclude-body', 'missing', check=False).returncode, 0)
            first_occurrence = ids[0].rsplit('/solid:', 1)[0]
            run('shifted', '--shift', first_occurrence + '=40,-25', '--mirror', 'x', '--rotation', '350')
            shifted = json.loads((folder / 'shifted/dosing-hlr-inventory.json').read_text())
            a, b = shifted['bodies']
            self.assertEqual(a['shift_mm'], [40, -25, 0])
            self.assertNotIn('shift_mm', b)
            for i, value in enumerate(a['shifted_bounds']):
                self.assertAlmostEqual(value, a['bounds'][i] + (40, -25, 0)[i % 3])
            self.assertEqual(len(shifted['shift_groups'][0]['members']), 1)
            run('subtree', '--shift-subtree', first_occurrence + '=40,-25', '--mirror', 'x', '--rotation', '350')
            subtree = json.loads((folder / 'subtree/dosing-hlr-inventory.json').read_text())
            self.assertEqual(subtree['bodies'], shifted['bodies'])
            self.assertEqual((folder / 'subtree/dosing-hlr-medium.svg').read_text(),
                             (folder / 'shifted/dosing-hlr-medium.svg').read_text())
            run('padding', '--padding', '6')
            padded = json.loads((folder / 'padding/dosing-hlr-report.json').read_text())
            normal = json.loads((folder / 'poly/dosing-hlr-report.json').read_text())
            self.assertEqual(padded['padding'], 6)
            self.assertGreater(padded['fit_scale_px_per_mm'], normal['fit_scale_px_per_mm'])
            for value in ('-1', '250', 'nan', 'inf'):
                self.assertNotEqual(run('bad-padding', '--padding', value, check=False).returncode, 0)
            # Poly and exact see the same translated B-reps, not SVG-only offsets.
            run('shift-exact', '--shift', first_occurrence + '=40,-25',
                '--mirror', 'x', '--rotation', '350', '--algorithm', 'exact')
            self.assertEqual((folder / 'shifted/dosing-hlr-medium.svg').read_text(),
                             (folder / 'shift-exact/dosing-hlr-medium.svg').read_text())
            self.assertNotEqual(run('ambiguous', '--shift', 'Repeated box=1,2', check=False).returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
