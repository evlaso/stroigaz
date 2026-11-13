#!/usr/bin/env python3
"""Pure numerical tests; NO OCC, VTK, EGL, STEP or GUI is imported/required.

/home/foxqa/.cache/stroygaz-step-venv/bin/python -I \
  /home/foxqa/Projects/stroygaz/scripts/anatomy/step-outline.test.py
"""
import importlib.util
import math
import re
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

import numpy as np


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


outline = load('step_outline', 'step-outline.py')
batch = load('step_outline_all', 'step-outline-all.py')


class CameraTests(unittest.TestCase):
    def test_site_axes(self):
        axes = outline.camera()
        np.testing.assert_allclose(axes @ axes.T, np.eye(3), atol=1e-14)
        self.assertLess(axes[1, 2], 0)  # STEP +Z goes up on the canvas.
        self.assertGreater(axes[2, 2], 0)

    def test_reflection_before_rotation(self):
        point = outline.orientation_matrix('x', 90) @ [1, 2, 3]
        np.testing.assert_allclose(point, [-2, -1, 3], atol=1e-14)
        self.assertAlmostEqual(np.linalg.det(outline.orientation_matrix('x', 350)), -1)

    def test_fit_site_padding(self):
        points = np.array([[0, 0, 0], [1440, 800, 10]])
        scale, origin, bounds = outline.fit_projection(points)
        self.assertEqual(scale, .5)
        np.testing.assert_allclose(bounds, [[20, 50], [740, 450]])


class EdgeTests(unittest.TestCase):
    def buffers(self):
        depth = np.full((12, 15), -np.inf, dtype=np.float32)
        depth[2:10, 3:12] = 20
        normals = np.zeros((*depth.shape, 3), np.float32)
        normals[..., 2] = 1
        return depth, normals

    def test_silhouette_and_no_flat_interior(self):
        depth, normals = self.buffers()
        silhouette, jump, crease = outline.detect_edges(depth, normals, 1, 4)
        self.assertEqual(silhouette.sum(), 2 * 8 + 2 * 9 - 4)
        self.assertFalse(jump.any())
        self.assertFalse(crease.any())
        self.assertTrue(np.all(np.isfinite(depth[silhouette])))

    def test_tilted_plane_not_depth_banding(self):
        y, x = np.mgrid[:20, :30]
        depth = 5 * x / 4 + 8 * y / 4
        normal = np.array([-5., -8., 1.])
        normal /= np.linalg.norm(normal)
        normals = np.broadcast_to(normal, (*depth.shape, 3))
        _, jump, crease = outline.detect_edges(depth, normals, 1, 4)
        self.assertFalse(jump.any())
        self.assertFalse(crease.any())

    def test_front_object_edge_is_not_hidden_by_rear(self):
        depth = np.zeros((20, 30), np.float32)
        depth[5:15, 8:22] = 100
        normals = np.zeros((*depth.shape, 3), np.float32)
        normals[..., 2] = 1
        _, jump, _ = outline.detect_edges(depth, normals, 1, 4)
        self.assertTrue(jump[5:15, 8].all())
        self.assertTrue(jump[5:15, 21].all())
        self.assertFalse(jump[:, 7].any())

    def test_normal_crease_at_equal_depth(self):
        depth = np.zeros((10, 10), np.float32)
        normals = np.zeros((*depth.shape, 3), np.float32)
        normals[:, :5, 2] = 1
        normals[:, 5:, 0] = math.sin(math.radians(50))
        normals[:, 5:, 2] = math.cos(math.radians(50))
        _, jump, crease = outline.detect_edges(depth, normals, 1, 4)
        self.assertFalse(jump.any())
        self.assertEqual(crease.sum(), 10)

    def test_small_visible_part_is_not_filtered(self):
        depth = np.full((10, 10), -np.inf, np.float32)
        depth[5, 5] = 1
        normals = np.zeros((*depth.shape, 3), np.float32)
        normals[..., 2] = 1
        masks = outline.detect_edges(depth, normals, 1, 4)
        raw = masks[0] | masks[1] | masks[2]
        skeleton = outline.skeletonize(outline.close_gaps(raw))
        self.assertTrue(skeleton[5, 5])
        self.assertEqual(len(outline.trace_skeleton(skeleton, 4)), 1)

    def test_coplanar_display_edges_preserved_but_hidden_edges_not(self):
        depth = np.zeros((20, 20), np.float32)
        segments = np.array([[[2, 5, 0], [18, 5, 0]], [[2, 10, -10], [18, 10, -10]]], np.float32)
        visible = outline.visible_cad_edges(segments, depth, np.eye(3), 1, np.zeros(2), 1, .45)
        self.assertTrue(visible[5, 2:19].all())
        self.assertFalse(visible[10].any())


class VectorTests(unittest.TestCase):
    def test_exact_overlay_aligns_only_global_fit(self):
        exact = {'algorithm': 'exact', 'body_count': 2, 'orientation': {'mirror': 'x', 'rotation_degrees': 350},
                 'variants': {'medium': {'threshold_ratio': 0, 'kept_bodies': 2}},
                 'fit_scale_px_per_mm': 1, 'fit_origin': [20, 40]}
        projection = {'scale_px_per_mm': 2, 'origin': [50, 100]}
        self.assertEqual(outline.comparison_alignment(exact, projection, 'x', 350), (2., [10., 20.]))
        for key, bad in (('shift_groups', [1]), ('excluded_bodies', [1]), ('algorithm', 'poly'),
                         ('suppressed_fasteners', [1])):
            with self.assertRaises(ValueError):
                outline.comparison_alignment({**exact, key: bad}, projection, 'x', 350)
        with self.assertRaises(ValueError):
            outline.comparison_alignment(exact, projection, 'none', 350)
        with self.assertRaises(ValueError):
            outline.comparison_alignment({**exact, 'variants': {'medium': {'threshold_ratio': .01, 'kept_bodies': 2}}},
                                         projection, 'x', 350)

    def test_morphology_never_removes_source_edges(self):
        mask = np.random.default_rng(17).random((40, 60)) < .1
        self.assertTrue(np.all(outline.close_gaps(mask)[mask]))

    def test_thin_keeps_disconnected_components(self):
        mask = np.zeros((40, 60), bool)
        mask[5:30, 10:14] = True
        mask[10, 50] = True
        skeleton = outline.skeletonize(mask)
        self.assertTrue(skeleton[10, 50])
        self.assertGreater(skeleton[5:30, 10:14].sum(), 10)
        np.testing.assert_array_equal(outline.skeletonize(skeleton), skeleton)

    def test_even_sized_tiny_components_do_not_vanish(self):
        for height in range(1, 9):
            for width in range(1, 9):
                mask = np.zeros((14, 14), bool)
                mask[2:2 + height, 2:2 + width] = True
                self.assertTrue(outline.skeletonize(mask).any(), (height, width))

    def test_closed_loop_and_isolated_point(self):
        mask = np.zeros((12, 12), bool)
        mask[2, 2:8] = mask[7, 2:8] = True
        mask[2:8, 2] = mask[2:8, 7] = True
        mask[10, 10] = True
        chains = outline.trace_skeleton(mask, 4)
        self.assertEqual(len(chains), 2)
        loop = max(chains, key=len)
        self.assertEqual(loop[0], loop[-1])
        self.assertEqual(len(loop), 21)

    def test_junction_does_not_disappear(self):
        mask = np.zeros((9, 9), bool)
        mask[4, 1:8] = True
        mask[1:8, 4] = True
        chains = outline.trace_skeleton(mask, 1)
        self.assertEqual(len(chains), 4)
        self.assertTrue(all((4.5, 4.5) in (c[0], c[-1]) for c in chains))

    def test_diagonal_staircase_has_no_shortcut_junctions(self):
        mask = np.zeros((6, 6), bool)
        for x, y in ((1, 1), (2, 1), (2, 2), (3, 2), (3, 3)):
            mask[y, x] = True
        chains = outline.trace_skeleton(mask, 1)
        self.assertEqual(len(chains), 1)
        self.assertEqual(len(chains[0]), 5)

    def test_simplify_preserves_circle(self):
        circle = [(math.cos(t), math.sin(t)) for t in np.linspace(0, 2 * math.pi, 101)]
        circle[-1] = circle[0]
        reduced = outline.simplify(circle, .05)
        self.assertGreater(len(reduced), 8)
        self.assertLess(len(reduced), 30)
        self.assertEqual(reduced[0], reduced[-1])

    def test_svg_site_style_and_dot(self):
        svg = outline.svg_text([[(1., 2.)], [(3., 4.), (20., 5.)]], '<unsafe & label>')
        root = ET.fromstring(svg)
        self.assertEqual(root.attrib['viewBox'], '0 0 760 500')
        self.assertEqual(root.attrib['width'], '760')
        group = root[0]
        self.assertEqual(group.attrib['stroke'], '#383e43')
        self.assertEqual(group.attrib['stroke-width'], '1.05')
        self.assertIn('l.001,0', group[0].attrib['d'])
        self.assertEqual(root.attrib['aria-label'], '<unsafe & label>')

    def test_relative_svg_compression_keeps_quantized_coordinates(self):
        points = [(300., 250.), (300.125, 250.125), (301., 250.25), (10., 20.), (300., 250.)]
        root = ET.fromstring(outline.svg_text([points], 'test'))
        path = root[0][0].attrib['d']
        self.assertIn('l', path)
        self.assertTrue(path.endswith('z'))
        current = np.zeros(2)
        reconstructed = []
        for command, x, y in re.findall(r'([MLl])(-?[\d.]+),(-?[\d.]+)', path):
            value = np.array([float(x), float(y)])
            current = current + value if command == 'l' else value
            reconstructed.append(current.copy())
        reconstructed.append(reconstructed[0])
        np.testing.assert_allclose(reconstructed, np.round(np.asarray(points) * 100) / 100, atol=1e-10)


class BatchTests(unittest.TestCase):
    def test_transliteration(self):
        self.assertEqual(batch.slugify('Установка приготовления и дозирования'),
                         'ustanovka-prigotovleniya-i-dozirovaniya')
        self.assertEqual(batch.slugify('Химическая промывка CIP'), 'khimicheskaya-promyvka-cip')
        self.assertEqual(batch.slugify('...'), 'model')

    def test_slug_collisions_deterministic(self):
        paths = [Path('/data/a/model.stp'), Path('/data/a/model2.STEP'), Path('/data/b/model.stp')]
        slugs = batch.model_slugs(paths, Path('/data'))
        self.assertEqual(len(set(slugs.values())), 3)
        self.assertEqual(slugs, batch.model_slugs(list(reversed(paths)), Path('/data')))

    def test_only_orientation_can_be_model_specific(self):
        self.assertEqual(batch.validate_orientations({'a': {'mirror': 'x', 'rotation': 350}}, ['a']),
                         {'a': {'mirror': 'x', 'rotation': 350}})
        for bad in ({'a': {'exclude': [12]}}, {'a': {'shift': [2, 3]}}, {'b': {}},
                    {'a': {'rotation': float('nan')}}, {'a': {'mirror': 'bad'}}):
            with self.assertRaises(ValueError):
                batch.validate_orientations(bad, ['a'])

    def test_no_cad_or_render_imports(self):
        self.assertFalse(any(name.startswith(('OCP', 'vtkmodules')) for name in sys.modules))

    def test_isolated_subprocess_metrics_and_failure(self):
        with tempfile.TemporaryDirectory(prefix='step-outline-test-') as directory:
            metrics = batch.run_model([sys.executable, '-I', '-c', 'print("ok")'], Path(directory), 5)
            self.assertEqual(metrics['returncode'], 0)
            self.assertFalse(metrics['timed_out'])
            self.assertGreater(metrics['peak_rss_mib'], 0)
            self.assertEqual((Path(directory) / 'run.log').read_text(), 'ok\n')
            metrics = batch.run_model([sys.executable, '-I', '-c', 'raise SystemExit(3)'], Path(directory), 5)
            self.assertEqual(metrics['returncode'], 3)

    def test_subprocess_timeout(self):
        with tempfile.TemporaryDirectory(prefix='step-outline-test-') as directory:
            metrics = batch.run_model([sys.executable, '-I', '-c', 'while True: pass'], Path(directory), .08)
            self.assertTrue(metrics['timed_out'])
            self.assertNotEqual(metrics['returncode'], 0)

    def test_relative_input_rejected_before_cad_import(self):
        result = subprocess.run([sys.executable, '-I', str(Path(outline.__file__)), 'model.step',
                                 '--output-dir', '/tmp/opencode/step-outline-test'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('absolute', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
