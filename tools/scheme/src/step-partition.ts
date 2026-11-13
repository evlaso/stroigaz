/**
 * ISO-10303-21 dependency pruning, not a CAD converter. OCCT still reads and
 * tessellates every surface. Keep all product / assembly relationships and
 * placements of selected products AND their ancestor assemblies in each
 * fragment, with only a subset of BREP representations / surface shells.
 * Presentation items are retained iff their target belongs to that subset.
 * Construction-only wireframes are omitted (occt-import-js does not mesh them).
 */
export interface StepIndex {
  header: string;
  records: (string | undefined)[];
  roots: number[];
  representations: number[];
  omit: number[];
  presentation: number[];
  styled: number[];
  atoms: number[];
  surfaceModels: number[];
}

function withoutComments(text: string): string {
  if (!text.includes('/*')) return text;
  let quoted = false, from = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Незакрытый комментарий STEP');
      parts.push(text.slice(from, i), ' ');
      from = end + 2; i = end + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.join('');
}

/** Skip quoted text, including doubled apostrophes and # references in names. */
export function references(text: string): number[] {
  const refs: number[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && text[i] === '#') {
      let end = i + 1;
      while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
      if (end > i + 1) refs.push(Number(text.slice(i + 1, end)));
      i = end - 1;
    }
  }
  return refs;
}

export function argumentsOf(record: string): string[] {
  const start = record.indexOf('(');
  const args: string[] = [];
  let at = start + 1, depth = 0, quoted = false;
  for (let i = at; i < record.length; i++) {
    const char = record[i];
    if (char === "'") {
      if (quoted && record[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (char === '(') depth++;
      if (char === ')') { if (!depth) { args.push(record.slice(at, i).trim()); return args; } depth--; }
      if (char === ',' && !depth) { args.push(record.slice(at, i).trim()); at = i + 1; }
    }
  }
  throw new Error('Некорректные аргументы STEP');
}

export function indexStep(text: string): StepIndex {
  text = withoutComments(text);
  // Part 21 exchange files only. Do not attempt to process zipped / binary STEP.
  const dataStart = /\bDATA\s*;/i.exec(text);
  if (!dataStart || !/ISO-10303-21\s*;/i.test(text.slice(0, 256))) throw new Error('Не найден текстовый раздел DATA в STEP');
  const records: (string | undefined)[] = [];
  const representations: number[] = [], omit: number[] = [], presentation: number[] = [], styled: number[] = [];
  let at = dataStart.index + dataStart[0].length, quoted = false, start = at, ended = false;
  for (; at < text.length; at++) {
    const char = text[at];
    if (char === "'") {
      if (quoted && text[at + 1] === "'") { at++; continue; }
      quoted = !quoted;
    } else if (!quoted && char === ';') {
      const line = text.slice(start, at).trim(); start = at + 1;
      if (/^ENDSEC$/i.test(line)) { ended = true; break; }
      const match = /^#(\d+)\s*=\s*([\s\S]*)$/.exec(line);
      if (!match) { if (line) throw new Error('Неподдерживаемая запись STEP DATA'); continue; }
      const id = Number(match[1]);
      // Bound sparse / malicious ids before allocating large index arrays.
      if (!Number.isSafeInteger(id) || id > 12_000_000 || records[id]) throw new Error('Некорректный или слишком большой ID сущности STEP');
      const body = match[2]; records[id] = body;
      if (/^(ADVANCED_BREP|FACETED_BREP|MANIFOLD_SURFACE|GEOMETRICALLY_BOUNDED_SURFACE|TESSELLATED)_SHAPE_REPRESENTATION\s*\(/.test(body)) representations.push(id);
      if (/^GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION\s*\(/.test(body)) omit.push(id);
      if (/^(MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION|DRAUGHTING_MODEL|INVISIBILITY|PRESENTATION_LAYER_ASSIGNMENT)\s*\(/.test(body)) presentation.push(id);
      if (/^(STYLED_ITEM|OVER_RIDING_STYLED_ITEM)\s*\(/.test(body)) styled.push(id);
    }
  }
  if (quoted || !ended) throw new Error('Незавершённый раздел DATA в STEP');
  const inbound = new Uint8Array(records.length);
  for (let id = 0; id < records.length; id++) {
    const body = records[id];
    if (!body) continue;
    for (const ref of references(body)) {
      if (!records[ref]) throw new Error(`Ссылка STEP #${ref} не найдена`);
      inbound[ref] = 1;
    }
  }
  const roots: number[] = [];
  for (let id = 0; id < records.length; id++) if (records[id] && !inbound[id]) roots.push(id);
  const atoms: number[] = [], surfaceModels: number[] = [];
  for (const id of representations) for (const item of references(argumentsOf(records[id]!)[1])) {
    const body = records[item]!;
    if (body.startsWith('AXIS2_PLACEMENT_3D')) continue;
    if (body.startsWith('SHELL_BASED_SURFACE_MODEL')) {
      surfaceModels.push(item);
      atoms.push(...references(argumentsOf(body)[1]));
    } else atoms.push(item);
  }
  return { header: text.slice(0, dataStart.index + dataStart[0].length), records, roots, representations, omit, presentation, styled,
    atoms: [...new Set(atoms)], surfaceModels: [...new Set(surfaceModels)] };
}

function visit(index: StepIndex, roots: number[], overrides = new Map<number, string>()): Uint8Array {
  const active = new Uint8Array(index.records.length);
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (active[id]) continue;
    active[id] = 1;
    const record = overrides.get(id) ?? index.records[id];
    if (!record) throw new Error(`Отсутствует STEP #${id}`);
    for (const ref of references(record)) if (!active[ref]) stack.push(ref);
  }
  return active;
}

export function stepFragment(index: StepIndex, selected: number[]): { text: string; entities: number } {
  const selectedSet = new Set(selected);
  const overrides = new Map<number, string>();
  const forbidden = new Set<number>(index.omit);
  const activeModels = new Set<number>();
  for (const id of index.surfaceModels) {
    const args = argumentsOf(index.records[id]!);
    const shells = references(args[1]).filter(id => selectedSet.has(id));
    if (shells.length) activeModels.add(id);
    args[1] = `(${shells.map(id => `#${id}`).join(',')})`;
    overrides.set(id, `SHELL_BASED_SURFACE_MODEL(${args.join(',')})`);
  }
  const activeReps: number[] = [];
  for (const id of [...index.representations, ...index.omit]) {
    const args = argumentsOf(index.records[id]!);
    if (args.length !== 3) throw new Error('Неподдерживаемое представление STEP');
    const items = index.omit.includes(id) ? [] : references(args[1]).filter(ref => selectedSet.has(ref) || activeModels.has(ref));
    if (items.length) {
      activeReps.push(id);
      // Placement items in a representation are metadata, not BREP atoms.
      const axes = references(args[1]).filter(ref => index.records[ref]?.startsWith('AXIS2_PLACEMENT_3D'));
      args[1] = `(${[...axes, ...items].map(ref => `#${ref}`).join(',')})`;
      overrides.set(id, `${index.records[id]!.slice(0, index.records[id]!.indexOf('('))}(${args.join(',')})`);
    } else {
      forbidden.add(id);
    }
  }
  const geometry = visit(index, activeReps, overrides);
  const disabledStyle = new Set<number>();
  for (const id of index.styled) {
    const args = argumentsOf(index.records[id]!);
    const target = references(args[2] ?? '')[0];
    if (!geometry[target]) disabledStyle.add(id);
  }
  for (const id of index.presentation) {
    const record = index.records[id]!;
    const args = argumentsOf(record);
    const itemArg = record.startsWith('INVISIBILITY') ? 0 : record.startsWith('PRESENTATION_LAYER_ASSIGNMENT') ? 2 : 1;
    const items = references(args[itemArg]).filter(ref => !disabledStyle.has(ref));
    args[itemArg] = `(${items.map(ref => `#${ref}`).join(',')})`;
    overrides.set(id, `${record.slice(0, record.indexOf('('))}(${args.join(',')})`);
    if (!items.length) forbidden.add(id);
  }
  disabledStyle.forEach(id => forbidden.add(id));
  // Preserve exactly the selected products AND their ancestor assemblies. A
  // placeholder/empty leaf can make OCCT throw Standard_NullObject, so prune
  // inactive assembly occurrences instead of inventing dummy geometry.
  const reps = new Set(activeReps), plainReps: number[] = [];
  const relations: [number, number][] = [], definitions: [number, number][] = [], occurrences: [number, number, number][] = [];
  for (let id = 0; id < index.records.length; id++) {
    const record = index.records[id]; if (!record) continue;
    if (/^SHAPE_REPRESENTATION\s*\(/.test(record)) plainReps.push(id);
    if (/^SHAPE_REPRESENTATION_RELATIONSHIP\s*\(/.test(record)) {
      const args = argumentsOf(record); relations.push([references(args[2])[0], references(args[3])[0]]);
    }
    if (/^SHAPE_DEFINITION_REPRESENTATION\s*\(/.test(record)) {
      const refs = references(record), pds = index.records[refs[0]]!;
      definitions.push([refs[1], references(pds).at(-1)!]);
    }
    if (/^NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/.test(record)) {
      const args = argumentsOf(record); occurrences.push([id, references(args[3])[0], references(args[4])[0]]);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of relations) if (!forbidden.has(a) && !forbidden.has(b) && (reps.has(a) || reps.has(b))) {
      if (!reps.has(a) || !reps.has(b)) changed = true;
      reps.add(a); reps.add(b);
    }
  }
  const products = new Set(definitions.filter(([rep]) => reps.has(rep)).map(([, pd]) => pd));
  changed = true;
  while (changed) {
    changed = false;
    for (const [, parent, child] of occurrences) if (products.has(child) && !products.has(parent)) { products.add(parent); changed = true; }
  }
  for (const [rep, pd] of definitions) if (products.has(pd)) reps.add(rep);
  for (const rep of plainReps) if (!reps.has(rep)) forbidden.add(rep);
  for (const [rep, pd] of definitions) if (!products.has(pd)) { forbidden.add(rep); forbidden.add(pd); }
  for (const [id, parent, child] of occurrences) if (!products.has(parent) || !products.has(child)) forbidden.add(id);
  const memo = new Uint8Array(index.records.length);
  const isForbidden = (id: number): boolean => {
    if (forbidden.has(id) || memo[id] === 3) return true;
    if (memo[id] === 1 || memo[id] === 2) return false;
    memo[id] = 1;
    const bad = references(overrides.get(id) ?? index.records[id]!).some(isForbidden);
    memo[id] = bad ? 3 : 2;
    return bad;
  };
  const active = visit(index, index.roots.filter(id => !isForbidden(id)), overrides);
  const output = [index.header, '\n'];
  let entities = 0;
  for (let id = 0; id < index.records.length; id++) if (active[id]) {
    if (disabledStyle.has(id)) throw new Error('Неподдерживаемая связь стилей STEP: безопасное разбиение невозможно');
    output.push(`#${id}=${overrides.get(id) ?? index.records[id]};\n`); entities++;
  }
  output.push('ENDSEC;\nEND-ISO-10303-21;\n');
  return { text: output.join(''), entities };
}

/** Pack independent solids/surface shells by source-entity bytes, not count. */
export function planFragments(index: StepIndex, budget = 6 * 1024 ** 2): number[][] {
  const batches: number[][] = [];
  let batch: number[] = [], bytes = 0;
  for (const id of index.atoms) {
    const visited = new Set<number>(), stack = [id];
    let size = 0;
    while (stack.length) {
      const n = stack.pop()!;
      if (visited.has(n)) continue;
      visited.add(n);
      const record = index.records[n]!;
      size += record.length + 16;
      for (const ref of references(record)) if (!visited.has(ref)) stack.push(ref);
    }
    if (bytes + size > budget && batch.length) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(id); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
