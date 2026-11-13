#!/usr/bin/env python3
"""Sequential, isolated STEP-outline batch runner. No code from input is run.

  /home/foxqa/.cache/stroygaz-step-venv/bin/python -I \
    /home/foxqa/Projects/stroygaz/scripts/anatomy/step-outline-all.py \
    '/absolute/input/folder' --output-root /absolute/output/anatomy

Finds .step/.stp recursively, including uppercase extensions. Each input gets a
transliterated parent-folder slug, run.log, command.txt and report.json. Models
with colliding folder names get a deterministic relative-path hash suffix.
Subprocesses run sequentially in a trusted working directory with python -I;
wait4 measures wall time and peak RSS separately for each model (also on failure).
--timeout defaults to 1200 seconds PER MODEL, not for the whole batch.

--contact-sheet generates 16 orientation choices instead of the final SVG.
--orientations /absolute/choices.json optionally supplies ONLY rotation/mirror:
  {"ustanovka-prigotovleniya-i-dozirovaniya":{"rotation":350,"mirror":"x"}}
There are no built-in per-model geometry exceptions or assumed orientations.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time


def slugify(value):
    alphabet = dict(zip('абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
                        ('a', 'b', 'v', 'g', 'd', 'e', 'yo', 'zh', 'z', 'i', 'i', 'k',
                         'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'kh', 'ts',
                         'ch', 'sh', 'shch', '', 'y', '', 'e', 'yu', 'ya')))
    text = ''.join(alphabet.get(c, c) for c in value.lower())
    return re.sub(r'[^a-z0-9]+', '-', text).strip('-') or 'model'


def model_slugs(paths, root):
    counts = {}
    for path in paths:
        slug = slugify(path.parent.name)
        counts[slug] = counts.get(slug, 0) + 1
    result = {}
    for path in paths:
        slug = slugify(path.parent.name)
        if counts[slug] > 1:
            suffix = hashlib.sha256(str(path.relative_to(root)).encode()).hexdigest()[:10]
            slug += '--' + suffix
        result[path] = slug
    return result


def validate_orientations(data, slugs):
    if not isinstance(data, dict):
        raise ValueError('Orientations must be an object keyed by output slug')
    unknown = set(data) - set(slugs)
    if unknown:
        raise ValueError(f'Unknown orientation slugs: {sorted(unknown)}')
    for slug, choice in data.items():
        if not isinstance(choice, dict) or set(choice) - {'rotation', 'mirror'}:
            raise ValueError(f'{slug}: only rotation/mirror are accepted')
        rotation = choice.get('rotation', 0)
        if isinstance(rotation, bool) or not isinstance(rotation, (int, float)) or not math.isfinite(rotation):
            raise ValueError(f'{slug}: rotation must be finite')
        if choice.get('mirror', 'none') not in ('none', 'x', 'y'):
            raise ValueError(f'{slug}: invalid mirror')
    return data


def run_model(command, directory, timeout, log_name='run.log'):
    def expired(signum, frame):
        raise TimeoutError('Model exceeded wall-time limit')
    started = time.perf_counter()
    old_handler = signal.signal(signal.SIGALRM, expired)
    timed_out = False
    with (directory / log_name).open('w') as stream:
        process = subprocess.Popen(command, cwd=Path(__file__).resolve().parent,
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            signal.setitimer(signal.ITIMER_REAL, timeout)
            _, status, usage = os.wait4(process.pid, 0)
        except TimeoutError:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            _, status, usage = os.wait4(process.pid, 0)
        except KeyboardInterrupt:
            os.killpg(process.pid, signal.SIGKILL)
            os.wait4(process.pid, 0)
            process.returncode = -signal.SIGKILL
            raise
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)
        process.returncode = os.waitstatus_to_exitcode(status)
    return {'returncode': process.returncode, 'timed_out': timed_out,
            'wall_seconds': round(time.perf_counter() - started, 3),
            'peak_rss_mib': round(usage.ru_maxrss / 1024, 1)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('input_root', type=Path)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--orientations', type=Path)
    parser.add_argument('--contact-sheet', action='store_true')
    parser.add_argument('--supersample', type=int, choices=(4, 8), default=4)
    parser.add_argument('--timeout', type=float, default=1200)
    args = parser.parse_args()
    for path in (args.input_root, args.output_root, args.orientations):
        if path is not None and not path.is_absolute():
            parser.error('All paths must be absolute')
    if not args.input_root.is_dir():
        parser.error('Input root must be a directory')
    if args.output_root.resolve().is_relative_to(args.input_root.resolve()):
        parser.error('Output must be outside the untrusted input tree')
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('--timeout must be positive and finite')
    paths = sorted((p for p in args.input_root.rglob('*') if not p.is_symlink()
                    and p.is_file() and p.suffix.lower() in ('.step', '.stp')), key=str)
    if not paths:
        parser.error('No .step/.stp files found')
    slugs = model_slugs(paths, args.input_root)
    try:
        orientations = validate_orientations(json.loads(args.orientations.read_text())
                                             if args.orientations else {}, slugs.values())
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    args.output_root.mkdir(parents=True, exist_ok=True)
    records = []
    target = args.output_root / ('batch-contact-report.json' if args.contact_sheet else 'batch-report.json')
    for path in paths:
        slug = slugs[path]
        directory = args.output_root / slug
        directory.mkdir(parents=True, exist_ok=True)
        choice = orientations.get(slug, {})
        command = [sys.executable, '-I', str(Path(__file__).resolve().with_name('step-outline.py')),
                   str(path), '--output-dir', str(directory), '--supersample', str(args.supersample),
                   '--rotation', str(choice.get('rotation', 0)), '--mirror', choice.get('mirror', 'none')]
        if args.contact_sheet:
            command.append('--contact-sheet')
        command_name = 'contact-sheet-command.txt' if args.contact_sheet else 'command.txt'
        (directory / command_name).write_text(shlex.join(command) + '\n')
        print(f'{slug}: {path.stat().st_size / 1e6:.1f} MB', flush=True)
        metrics = run_model(command, directory, args.timeout,
                            'contact-sheet.log' if args.contact_sheet else 'run.log')
        records.append({'source': str(path), 'output': str(directory), 'slug': slug, **metrics})
        target.write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
        print(f'  exit={metrics["returncode"]}, {metrics["wall_seconds"]}s, RSS={metrics["peak_rss_mib"]} MiB', flush=True)
    return int(any(record['returncode'] != 0 for record in records))


if __name__ == '__main__':
    sys.exit(main())
