/**
 * The background reachable from outside the frame («внешний фон»), for the outer contour.
 *
 * `background[i]` — 1 where nothing is drawn. The background is opened by a square of
 * ±`passage` px (eroded, flooded from the frame border, dilated back and clipped to the
 * background): the flood does not leak through cracks narrower than 2 × passage + 1 px
 * between parts, and a gap between bars that does not reach the frame stays inside.
 * Returns 255 for the outer background, 0 elsewhere (geometry, inner gaps).
 * Row order does not matter (the border is symmetric), so GL readback rows go as they are.
 */
export function exteriorMask(background: Uint8Array, width: number, height: number, passage: number): Uint8Array {
  const n = width * height;
  const r = Math.max(0, Math.round(passage));
  let open = background;
  if (r > 0) {
    // Erosion of the background = dilation of the geometry; beyond the frame is background.
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) solid[i] = background[i] ? 0 : 1;
    const grown = dilate(solid, width, height, r);
    open = new Uint8Array(n);
    for (let i = 0; i < n; i++) open[i] = grown[i] ? 0 : 1;
  }
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (i: number) => { if (open[i] && !outside[i]) { outside[i] = 1; stack[top++] = i; } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (top > 0) {
    const i = stack[--top], x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < n - width) push(i + width);
  }
  const reached = r > 0 ? dilate(outside, width, height, r) : outside;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = reached[i] && background[i] ? 255 : 0;
  return mask;
}

/** Square dilation of a 0/1 mask by ±r, separable, with running counts; beyond the frame is 0. */
function dilate(source: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const rows = new Uint8Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(r, width); x++) count += source[row + x];
    for (let x = 0; x < width; x++) {
      if (x + r < width) count += source[row + x + r];
      if (x - r - 1 >= 0) count -= source[row + x - r - 1];
      rows[row + x] = count > 0 ? 1 : 0;
    }
  }
  const result = new Uint8Array(source.length);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, height); y++) count += rows[y * width + x];
    for (let y = 0; y < height; y++) {
      if (y + r < height) count += rows[(y + r) * width + x];
      if (y - r - 1 >= 0) count -= rows[(y - r - 1) * width + x];
      result[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return result;
}
