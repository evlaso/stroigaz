import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { creaseAngle, WIDTH } from './settings.ts';
import type { OutlineStyle } from './types.ts';
import { exteriorMask } from './exterior.ts';

/** Layer of the feature-edge lines: invisible to the shaded view, the G-buffer and picking. */
export const EDGE_LAYER = 1;
/** Feature-edge visibility tolerance in high-resolution pixels (on top of the local depth slope). */
export const EDGE_BIAS_PX = 1;
/**
 * The halo opens only across a real gap in depth, this many depth thresholds deep.
 * A bolt on a flange or a frame on a lid touches the part behind it: its edges meet
 * the outline (a T-junction), as in assembly instructions, instead of a dashed line.
 */
const HALO_DEPTH_FACTOR = 4;
/**
 * «Упрощение» (outline.simplify = spacing threshold S, px at 1×; 0 = off). Constants are px at 1×
 * too, so the screen and every export agree:
 * - a dense area: the share of line pixels in ±window means lines closer than S, a line is
 *   within S / 2, and the area survives an opening of ±open (bands of bolts stay as drawn);
 * - inside it the depth is closed over ±close (grating holes vanish) and only the drawn lines
 *   on a step of that closed depth deeper than `step` stay: plate edges, railings over the
 *   plate, one platform over another — not the bars;
 * - `fill` — the tone of the area, a fraction of the line colour.
 */
export const SIMPLIFY = { window: 6, close: 1, open: 2, step: 5, fill: 0.1 };
/**
 * «Внутри» (outline.innerWidth > 0): only silhouettes next to the background reachable from the
 * frame border keep the silhouette width; bars, gaps between them, parts over parts get innerWidth.
 * `passage` — px at 1×: the outer background is opened by this square, so it does not leak
 * into a railing panel through a crack between parts (exterior.ts).
 */
export const EXTERIOR = { passage: 1 };

/**
 * Feature edges (edges.ts) as 1 px lines with a hidden-line test against `depthTexture`.
 * Uniforms: `minAngle` (crease threshold, degrees) and `bias` (depth units). Shared by the
 * outline G-buffer and the edges over the shaded model.
 */
export function featureEdgeMaterial(depthTexture: THREE.DepthTexture, texel: THREE.Vector2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      depthBuffer: { value: depthTexture }, texel: { value: texel },
      minAngle: { value: 30 }, bias: { value: 0 },
    },
    vertexShader: `
      attribute float angle;
      uniform float minAngle;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        // Below the crease threshold: move the whole segment outside the clip volume.
        if (angle < minAngle) gl_Position = vec4(2., 2., 2., 1.);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D depthBuffer;
      uniform vec2 texel;
      uniform float bias;
      void main() {
        vec2 uv = gl_FragCoord.xy * texel;
        float d = texture2D(depthBuffer, uv).x;
        // Hidden-line test against the visible surface. The edge lies ON its faces,
        // but the pixel centre samples the face plane up to ~0.7 px away: allow
        // the local depth slope (one-sided, so a neighbouring crease or silhouette
        // does not inflate it) plus a constant of EDGE_BIAS_PX.
        float l = texture2D(depthBuffer, uv - vec2(texel.x, 0.)).x, r = texture2D(depthBuffer, uv + vec2(texel.x, 0.)).x;
        float b = texture2D(depthBuffer, uv - vec2(0., texel.y)).x, t = texture2D(depthBuffer, uv + vec2(0., texel.y)).x;
        float slope = max(min(abs(r - d), abs(d - l)), min(abs(t - d), abs(d - b)));
        if (gl_FragCoord.z > d + bias + 1.5 * slope) discard;
        gl_FragColor = vec4(1.);
      }
    `,
  });
}

/**
 * IKEA-style line drawing in four full-screen passes over a 4× G-buffer.
 *
 * 1. G-buffer: view-space normal (RGB), part id (A, 1–255, 0 = empty), depth.
 *    Feature edges (edges.ts) are drawn as 1 px lines with a hidden-line test.
 * 2. Classify every pixel against its four neighbours into one-pixel cores:
 *    R — silhouette, on the NEAR side of a depth step, of the model border, or of a
 *        boundary between two parts without a depth step (one side, by id);
 *    G — inner line: feature edge or normal crease;
 *    B — FAR side of a deep depth step (geometry an outline passes well in front of).
 * 3–4. Exact Euclidean distance to the nearest core of each class, in two separable
 *    passes (horizontal, then vertical in the composite). Silhouettes and inner lines
 *    get their own radius; inner lines on the far side of a silhouette (nearer to a
 *    B core than to an R core) are erased up to `haloGap` beyond the silhouette stroke.
 * With «Упрощение» (outline.simplify > 0) eight more passes between 2 and 3 replace the cores
 * inside dense areas (gratings, treads) by the outline of the closed depth, see SIMPLIFY.
 * With «Внутри» (outline.innerWidth > 0) the G-buffer coverage is read back, the outer background
 * is flooded on the CPU (exterior.ts) and one more pass before 3 moves the silhouette cores that
 * do not touch it to A, drawn with the inner silhouette radius.
 */
export class OutlinePass {
  readonly target: THREE.WebGLRenderTarget;
  /** Feature-edge lines; later reused for the horizontal distances (and the «Упрощение» passes). */
  private lines: THREE.WebGLRenderTarget;
  private classes: THREE.WebGLRenderTarget;
  /** «Упрощение» only: two more buffers for the dense area, the closed depth and the merged cores. */
  private dense?: { mask: THREE.WebGLRenderTarget; cores: THREE.WebGLRenderTarget };
  private densityRows: THREE.ShaderMaterial;
  private densityMask: THREE.ShaderMaterial;
  private morph: THREE.ShaderMaterial;
  private steps: THREE.ShaderMaterial;
  private merge: THREE.ShaderMaterial;
  private split: THREE.ShaderMaterial;
  /** «Внутри» only: the G-buffer readback and the outer background (exterior.ts) as a texture. */
  private exterior?: { pixels: Uint8Array; background: Uint8Array; texture: THREE.DataTexture; key: string };
  private gbuffer: THREE.ShaderMaterial;
  private edges: THREE.ShaderMaterial;
  private classify: THREE.ShaderMaterial;
  private spread: THREE.ShaderMaterial;
  private material: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  /** Shared by every pass: one G-buffer pixel in uv. */
  private texel: THREE.Vector2;

  constructor(width: number, height: number) {
    const options = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    this.target = new THREE.WebGLRenderTarget(width, height, { ...options, depthBuffer: true });
    this.target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    this.lines = new THREE.WebGLRenderTarget(width, height, options);
    this.classes = new THREE.WebGLRenderTarget(width, height, options);
    const texel = this.texel = new THREE.Vector2(1 / width, 1 / height);
    const quadVertex = `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }
    `;
    // Same normals as MeshNormalMaterial (DoubleSide), plus the part id of the drawn mesh.
    this.gbuffer = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { partId: { value: 1 } },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vNormal;
        uniform float partId;
        void main() {
          vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1. : -1.);
          gl_FragColor = vec4(n * .5 + .5, partId / 255.);
        }
      `,
    });
    // One override material for all meshes: upload the id per draw call.
    this.gbuffer.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
      this.gbuffer.uniforms.partId.value = object.userData.partId ?? 1;
      this.gbuffer.uniformsNeedUpdate = true;
    };
    this.edges = featureEdgeMaterial(this.target.depthTexture, texel);
    this.classify = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        normalBuffer: { value: this.target.texture }, depthBuffer: { value: this.target.depthTexture },
        lineBuffer: { value: this.lines.texture }, texel: { value: texel },
        worldToDepth: { value: new THREE.Vector2() }, depthThreshold: { value: 0.002 }, normalThreshold: { value: 0.32 },
        haloDepth: { value: 0.008 },
      },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D normalBuffer, depthBuffer, lineBuffer;
        uniform vec2 texel, worldToDepth;
        uniform float depthThreshold, normalThreshold, haloDepth;
        void main() {
          float d = texture2D(depthBuffer, vUv).x;
          float silhouette = 0., far = 0.;
          float inner = step(.5, texture2D(lineBuffer, vUv).r);
          if (d < .999999) {
            vec4 g = texture2D(normalBuffer, vUv);
            vec3 n = g.rgb * 2. - 1.;
            float id = floor(g.a * 255. + .5);
            float nz = (n.z < 0. ? -1. : 1.) * max(abs(n.z), .02);
            for (int i = 0; i < 4; i++) {
              vec2 offset = (i == 0 ? vec2(1., 0.) : i == 1 ? vec2(0., 1.) : i == 2 ? vec2(-1., 0.) : vec2(0., -1.)) * texel;
              float otherD = texture2D(depthBuffer, vUv + offset).x;
              if (otherD > .999999) { silhouette = 1.; continue; }
              vec4 otherG = texture2D(normalBuffer, vUv + offset);
              vec3 otherN = otherG.rgb * 2. - 1.;
              // A depth slope is NOT a depth discontinuity: extrapolate the tangent
              // plane from both ends (grazing cylinders), keep the sign of the step.
              float otherNz = (otherN.z < 0. ? -1. : 1.) * max(abs(otherN.z), .02);
              float a = otherD - d - dot(n.xy, offset * worldToDepth) / nz;
              float b = otherD - d - dot(otherN.xy, offset * worldToDepth) / otherNz;
              float jump = abs(a) < abs(b) ? a : b;
              float otherId = floor(otherG.a * 255. + .5);
              if (jump > depthThreshold) {
                // Near side of a step. Deep steps and steps onto another part are outlines;
                // a shallow step within one part (fins, grooves, a raised frame) is an inner line.
                if (jump > haloDepth || id != otherId) silhouette = 1.;
                else inner = 1.;
              }
              else if (jump < -depthThreshold) far = max(far, step(haloDepth, -jump));
              else {
                // Parts touching without a depth step: outline one side only.
                if (id > otherId) silhouette = 1.;
                // Creases: right / up neighbour only, so the core stays one pixel wide.
                if (i < 2 && length(n - otherN) > normalThreshold) inner = 1.;
              }
            }
          }
          gl_FragColor = vec4(silhouette, inner, far, 1.);
        }
      `,
    });
    // «Упрощение» (see SIMPLIFY). Depth travels between passes in two 8-bit channels, B + A / 255.
    const packDepth = `
      vec2 packDepth(float d) { float high = floor(d * 255.) / 255.; return vec2(high, (d - high) * 255.); }
      float unpackDepth(vec2 v) { return v.x + v.y / 255.; }
    `;
    // Line density, horizontal half: per row, the share of line cores (silhouette or inner) in
    // ±window and in ±near; BA — the nearest depth in ±close (the depth closing starts here).
    this.densityRows = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        classBuffer: { value: this.classes.texture }, depthBuffer: { value: this.target.depthTexture },
        texel: { value: texel }, window: { value: 24 }, near: { value: 2 }, close: { value: 4 },
      },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D classBuffer, depthBuffer;
        uniform vec2 texel;
        uniform int window, near, close;
        ${packDepth}
        void main() {
          float count = 0., lines = 0., nearest = 1.;
          for (int x = -window; x <= window; x++) {
            vec2 uv = vUv + vec2(float(x) * texel.x, 0.);
            vec2 core = step(.5, texture2D(classBuffer, uv).rg);
            float line = max(core.r, core.g);
            count += line;
            if (abs(x) <= near) lines += line;
            if (abs(x) <= close) nearest = min(nearest, texture2D(depthBuffer, uv).x);
          }
          gl_FragColor = vec4(count / float(2 * window + 1), lines / float(2 * near + 1), packDepth(nearest));
        }
      `,
    });
    // Vertical half. R — the dense area: lines in the window closer than the spacing threshold,
    // and a line within ±near (holes of a grating close up, the area ends at its last line, the
    // inside of a tube wider than the threshold stays out). BA — the nearest depth.
    this.densityMask = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        rowBuffer: { value: this.lines.texture }, texel: { value: texel },
        window: { value: 24 }, near: { value: 2 }, close: { value: 4 }, threshold: { value: 1 },
      },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D rowBuffer;
        uniform vec2 texel;
        uniform int window, near, close;
        uniform float threshold;
        ${packDepth}
        void main() {
          float count = 0., lines = 0., nearest = 1.;
          float rowLength = float(2 * window + 1), nearLength = float(2 * near + 1);
          for (int y = -window; y <= window; y++) {
            vec4 row = texture2D(rowBuffer, vUv + vec2(0., float(y) * texel.y));
            count += floor(row.r * rowLength + .5);
            if (abs(y) <= near) lines += floor(row.g * nearLength + .5);
            if (abs(y) <= close) nearest = min(nearest, unpackDepth(row.ba));
          }
          float dense = count >= threshold * rowLength * rowLength && lines > 0. ? 1. : 0.;
          gl_FragColor = vec4(dense, 0., packDepth(nearest));
        }
      `,
    });
    // Square morphology, one axis per pass. BA: the farthest of the nearest depths in ±close
    // ends the depth closing — grating holes are gone, larger shapes keep their edges. R: the
    // area eroded, then dilated, by ±open — bands narrower than that (a ring of bolts, a row
    // of rivets) are not simplified, platforms and treads are.
    this.morph = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { source: { value: null }, axis: { value: new THREE.Vector2() }, close: { value: 0 }, open: { value: 0 }, dilate: { value: 0 } },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D source;
        uniform vec2 axis;
        uniform int close, open;
        uniform float dilate;
        ${packDepth}
        void main() {
          float farthest = 0., area = 1. - dilate;
          int reach = close > open ? close : open;
          for (int i = -reach; i <= reach; i++) {
            vec4 v = texture2D(source, vUv + float(i) * axis);
            if (abs(i) <= close) farthest = max(farthest, unpackDepth(v.ba));
            if (abs(i) <= open) area = dilate > .5 ? max(area, v.r) : min(area, v.r);
          }
          gl_FragColor = vec4(area, 0., packDepth(farthest));
        }
      `,
    });
    // Steps of the closed depth. R — the near side of a step deeper than stepDepth beyond the
    // slope continued from the other side (plate edges, a railing over a grating, one platform
    // over another; a plane at any angle is no step). G — the area, A — the area over geometry.
    this.steps = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { closedBuffer: { value: null }, texel: { value: texel }, stepDepth: { value: 0 } },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D closedBuffer;
        uniform vec2 texel;
        uniform float stepDepth;
        ${packDepth}
        void main() {
          vec4 closed = texture2D(closedBuffer, vUv);
          float d = unpackDepth(closed.ba), edge = 0.;
          for (int i = 0; i < 4; i++) {
            vec2 offset = (i == 0 ? vec2(1., 0.) : i == 1 ? vec2(0., 1.) : i == 2 ? vec2(-1., 0.) : vec2(0., -1.)) * texel;
            float jump = unpackDepth(texture2D(closedBuffer, vUv + offset).ba) - d - (d - unpackDepth(texture2D(closedBuffer, vUv - offset).ba));
            if (jump > stepDepth) edge = 1.;
          }
          float area = step(.5, closed.r);
          gl_FragColor = vec4(edge, area, 0., area * step(d, .999999));
        }
      `,
    });
    // In the area only the drawn lines lying on a step of the closed depth (±1 px) stay, as
    // silhouettes: the exact outline of plates and of what stands over them, without the bars.
    // A — the fill.
    this.merge = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { classBuffer: { value: this.classes.texture }, stepBuffer: { value: null }, texel: { value: texel } },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D classBuffer, stepBuffer;
        uniform vec2 texel;
        void main() {
          vec4 cores = vec4(texture2D(classBuffer, vUv).rgb, 0.);
          vec4 here = texture2D(stepBuffer, vUv);
          if (here.g > .5) {
            float edge = 0.;
            for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++)
              edge = max(edge, texture2D(stepBuffer, vUv + vec2(float(x), float(y)) * texel).r);
            cores.rg = vec2(max(step(.5, cores.r), step(.5, cores.g)) * step(.5, edge), 0.);
            cores.a = here.a;
          }
          gl_FragColor = cores;
        }
      `,
    });
    // «Внутри»: a silhouette core stays in R only next to the outer background (a 4-neighbour
    // in the exterior mask); the rest — bars against inner gaps, parts over parts — moves to A.
    this.split = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { classBuffer: { value: null }, exteriorBuffer: { value: null }, texel: { value: texel } },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D classBuffer, exteriorBuffer;
        uniform vec2 texel;
        void main() {
          vec3 cores = step(.5, texture2D(classBuffer, vUv).rgb);
          float outer = 0.;
          for (int i = 0; i < 4; i++) {
            vec2 offset = (i == 0 ? vec2(1., 0.) : i == 1 ? vec2(0., 1.) : i == 2 ? vec2(-1., 0.) : vec2(0., -1.)) * texel;
            outer = max(outer, step(.5, texture2D(exteriorBuffer, vUv + offset).r));
          }
          gl_FragColor = vec4(cores.r * outer, cores.g, cores.b, cores.r * (1. - outer));
        }
      `,
    });
    // Horizontal pass: distance in pixels to the nearest core of each class (255 = none).
    // A — the inner silhouettes of «Внутри» (split > 0), otherwise 1.
    this.spread = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { classBuffer: { value: this.classes.texture }, texel: { value: texel }, reach: { value: 3 }, split: { value: 0 } },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D classBuffer;
        uniform vec2 texel;
        uniform int reach;
        uniform float split;
        void main() {
          vec4 best = vec4(255.);
          for (int x = -reach; x <= reach; x++) {
            vec4 core = step(.5, texture2D(classBuffer, vUv + vec2(float(x) * texel.x, 0.)));
            best = min(best, mix(vec4(255.), vec4(abs(float(x))), core));
          }
          gl_FragColor = vec4(best.rgb / 255., split > .5 ? best.a / 255. : 1.);
        }
      `,
    });
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        spreadBuffer: { value: this.lines.texture }, maskBuffer: { value: null }, fill: { value: 0 }, texel: { value: texel }, reach: { value: 3 },
        silhouetteRadius: { value: 4 }, edgeRadius: { value: 2 }, gap: { value: 0 }, innerRadius: { value: 0 }, split: { value: 0 },
        ink: { value: new THREE.Vector3() }, paper: { value: new THREE.Vector3() }, transparent: { value: 0 },
      },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D spreadBuffer, maskBuffer;
        uniform vec2 texel;
        uniform int reach;
        uniform float silhouetteRadius, edgeRadius, gap, transparent, fill, innerRadius, split;
        uniform vec3 ink, paper;
        void main() {
          // Vertical half of the exact Euclidean distance transform, per class.
          vec4 nearest = vec4(65025.);
          for (int y = -reach; y <= reach; y++) {
            float dy = float(y);
            vec4 dx = texture2D(spreadBuffer, vUv + vec2(0., dy * texel.y)) * 255.;
            nearest = min(nearest, dx * dx + dy * dy);
          }
          vec4 dist = sqrt(nearest);
          // Strokes cover the core plus the radius, with a one-pixel soft rim.
          float outline = clamp(silhouetteRadius + .5 - dist.r, 0., 1.);
          float inner = clamp(edgeRadius + .5 - dist.g, 0., 1.);
          // Halo: on the far side of a depth step (nearer to its far-side core than to
          // the outline core), inner lines stop gap pixels short of the outline stroke.
          if (split > .5) {
            // «Внутри»: silhouettes off the outer background (A) with their own radius and halo.
            outline = max(outline, clamp(innerRadius + .5 - dist.a, 0., 1.));
            float farSide = gap > 0. && dist.b < min(dist.r, dist.a) ? 1. : 0.;
            inner *= 1. - farSide * max(clamp(silhouetteRadius + gap + 1. - dist.r, 0., 1.), clamp(innerRadius + gap + 1. - dist.a, 0., 1.));
          } else {
            float farSide = gap > 0. && dist.b < dist.r ? 1. : 0.;
            inner *= 1. - farSide * clamp(silhouetteRadius + gap + 1. - dist.r, 0., 1.);
          }
          // Colors are explicitly sRGB values; this raw shader does not apply tone mapping.
          float line = max(outline, inner);
          // A merged dense area: a light tone of the ink under its contour.
          if (fill > 0.) line = max(line, fill * step(.5, texture2D(maskBuffer, vUv).a));
          // Transparent: the ink at the stroke coverage, premultiplied (the canvas is
          // premultiplied, drawImage averages premultiplied values): no paper in the rim.
          gl_FragColor = transparent > .5 ? vec4(ink * line, line) : vec4(mix(paper, ink, line), 1.);
        }
      `,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.quad);
  }

  /** G-buffer size: 760 × 500 × the supersampling scale passed to render(). */
  setSize(width: number, height: number): void {
    if (width === this.target.width && height === this.target.height) return;
    for (const target of [this.target, this.lines, this.classes]) target.setSize(width, height);
    if (this.dense) for (const target of [this.dense.mask, this.dense.cores]) target.setSize(width, height);
    this.texel.set(1 / width, 1 / height);
  }

  /**
   * `scale` — G-buffer pixels per 1× frame pixel; the drawing goes to `output` (the canvas by default).
   * `transparent` — lines on a transparent background (premultiplied), without the paper colour.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.OrthographicCamera, style: OutlineStyle, scale: number,
    output: THREE.WebGLRenderTarget | null = null, transparent = false): void {
    const u = this.material.uniforms, c = this.classify.uniforms;
    const toRGB = (value: string, target: THREE.Vector3) => {
      target.set(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255);
    };
    const frameWidth = camera.right - camera.left, depthRange = camera.far - camera.near;
    u.silhouetteRadius.value = style.silhouetteWidth * scale / 2;
    u.edgeRadius.value = style.edgeWidth * scale / 2;
    u.gap.value = style.haloGap * scale;
    const split = style.innerWidth > 0;
    u.innerRadius.value = style.innerWidth * scale / 2;
    u.split.value = this.spread.uniforms.split.value = split ? 1 : 0;
    // Both distance passes look this far: the outline stroke plus the halo, or the inner stroke.
    const reach = Math.ceil(Math.max(u.silhouetteRadius.value + u.gap.value + 1, u.edgeRadius.value + .5,
      split ? u.innerRadius.value + u.gap.value + 1 : 0));
    u.reach.value = this.spread.uniforms.reach.value = reach;
    // Depth threshold is a fraction of the frame width, i.e. of the fitted model size,
    // independent of file units and of how deep the model is along the view axis.
    c.depthThreshold.value = style.depthThreshold * frameWidth / depthRange;
    c.haloDepth.value = c.depthThreshold.value * HALO_DEPTH_FACTOR;
    c.normalThreshold.value = style.normalThreshold;
    c.worldToDepth.value.set(frameWidth / depthRange, (camera.top - camera.bottom) / depthRange);
    this.edges.uniforms.minAngle.value = creaseAngle(style.normalThreshold);
    this.edges.uniforms.bias.value = EDGE_BIAS_PX * frameWidth / this.target.width / depthRange;
    const simplify = style.simplify > 0;
    if (simplify && !this.dense) {
      const options = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
      const { width, height } = this.target;
      this.dense = { mask: new THREE.WebGLRenderTarget(width, height, options), cores: new THREE.WebGLRenderTarget(width, height, options) };
      this.merge.uniforms.stepBuffer.value = this.dense.mask.texture;
    }
    // Radii of «Упрощение» in G-buffer pixels.
    const px = (value: number) => Math.min(100, Math.max(1, Math.round(value * scale)));
    if (simplify) {
      const rows = this.densityRows.uniforms, mask = this.densityMask.uniforms;
      rows.window.value = mask.window.value = px(SIMPLIFY.window);
      rows.near.value = mask.near.value = px(style.simplify / 2);
      rows.close.value = mask.close.value = px(SIMPLIFY.close);
      // Lines spaced `simplify` px at 1× cover 1 / (simplify × scale) of the G-buffer pixels.
      mask.threshold.value = 1 / (style.simplify * scale);
      this.steps.uniforms.stepDepth.value = SIMPLIFY.step * frameWidth / WIDTH / depthRange;
    }
    // With «Упрощение» the merged cores are in `lines`, the distances go to `dense.cores`.
    // «Внутри» splits the cores into a free buffer first: `lines` (or `dense.mask`), and the
    // distances go to `classes` without «Упрощение».
    this.spread.uniforms.classBuffer.value = simplify ? (split ? this.dense!.mask.texture : this.lines.texture)
      : split ? this.lines.texture : this.classes.texture;
    u.spreadBuffer.value = simplify ? this.dense!.cores.texture : split ? this.classes.texture : this.lines.texture;
    u.maskBuffer.value = simplify ? this.lines.texture : null;
    u.fill.value = simplify ? SIMPLIFY.fill : 0;
    toRGB(style.lineColor, u.ink.value);
    toRGB(style.background, u.paper.value);
    u.transparent.value = transparent ? 1 : 0;
    const previousOverride = scene.overrideMaterial;
    const background = scene.background;
    const layers = camera.layers.mask;
    scene.background = null;
    const pass = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(this.scene, this.camera);
    };
    try {
      renderer.setClearColor(0x000000, 0);
      scene.overrideMaterial = this.gbuffer;
      camera.layers.set(0);
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, camera);
      if (split) this.findExterior(renderer, scene, camera, EXTERIOR.passage * scale);
      scene.overrideMaterial = this.edges;
      camera.layers.set(EDGE_LAYER);
      renderer.setRenderTarget(this.lines);
      renderer.clear();
      renderer.render(scene, camera);
      pass(this.classify, this.classes);
      if (simplify) {
        const { mask, cores } = this.dense!;
        const m = this.morph.uniforms;
        const close = px(SIMPLIFY.close), open = px(SIMPLIFY.open);
        const morph = (source: THREE.WebGLRenderTarget, target: THREE.WebGLRenderTarget, x: boolean, dilate: boolean) => {
          m.source.value = source.texture;
          m.axis.value.set(x ? this.texel.x : 0, x ? 0 : this.texel.y);
          m.close.value = dilate ? 0 : close;
          m.open.value = open;
          m.dilate.value = dilate ? 1 : 0;
          pass(this.morph, target);
        };
        pass(this.densityRows, this.lines);
        pass(this.densityMask, mask);
        morph(mask, cores, true, false);
        morph(cores, this.lines, false, false);
        morph(this.lines, mask, true, true);
        morph(mask, cores, false, true);
        this.steps.uniforms.closedBuffer.value = cores.texture;
        pass(this.steps, mask);
        pass(this.merge, this.lines);
        if (split) {
          this.split.uniforms.classBuffer.value = this.lines.texture;
          pass(this.split, mask);
        }
        pass(this.spread, cores);
      } else if (split) {
        this.split.uniforms.classBuffer.value = this.classes.texture;
        pass(this.split, this.lines);
        pass(this.spread, this.classes);
      } else pass(this.spread, this.lines);
      pass(this.material, output);
    } finally {
      camera.layers.mask = layers;
      this.quad.material = this.material;
      scene.overrideMaterial = previousOverride;
      scene.background = background;
      renderer.setRenderTarget(null);
    }
  }

  /**
   * Reads the G-buffer coverage (alpha 0 = empty) and uploads the outer background (exterior.ts).
   * The coverage depends only on the camera and the model: line widths and thresholds reuse it.
   */
  private findExterior(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, passage: number): void {
    const { width, height } = this.target;
    const n = width * height;
    const parts: unknown[] = [];
    scene.traverseVisible(object => { if (object instanceof THREE.Mesh) parts.push(object.uuid, ...object.matrixWorld.elements); });
    const key = [width, height, passage, ...camera.matrixWorldInverse.elements, ...camera.projectionMatrix.elements, ...parts].join();
    if (this.exterior?.key === key) return;
    if (!this.exterior || this.exterior.background.length !== n) {
      this.exterior?.texture.dispose();
      const texture = new THREE.DataTexture(new Uint8Array(n), width, height, THREE.RedFormat, THREE.UnsignedByteType);
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.unpackAlignment = 1;
      this.exterior = { pixels: new Uint8Array(n * 4), background: new Uint8Array(n), texture, key: '' };
      this.split.uniforms.exteriorBuffer.value = texture;
    }
    const { pixels, background, texture } = this.exterior;
    renderer.readRenderTargetPixels(this.target, 0, 0, width, height, pixels);
    for (let i = 0; i < n; i++) background[i] = pixels[i * 4 + 3] === 0 ? 1 : 0;
    texture.image.data = exteriorMask(background, width, height, passage);
    texture.needsUpdate = true;
    this.exterior.key = key;
  }

  dispose(): void {
    this.exterior?.texture.dispose();
    this.target.dispose();
    this.lines.dispose();
    this.classes.dispose();
    this.dense?.mask.dispose();
    this.dense?.cores.dispose();
    this.densityRows.dispose();
    this.densityMask.dispose();
    this.morph.dispose();
    this.steps.dispose();
    this.merge.dispose();
    this.split.dispose();
    this.gbuffer.dispose();
    this.edges.dispose();
    this.classify.dispose();
    this.spread.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

/**
 * Area-weighted downscale of a supersampled image (the outline) to the canvas: every output
 * pixel averages the source pixels it covers, with fractional weights at its borders —
 * the screen counterpart of the high-quality drawImage the PNG export uses.
 */
export class Downsample {
  private material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: { source: { value: null }, ratio: { value: new THREE.Vector2(1, 1) } },
    vertexShader: `
      void main() { gl_Position = vec4(position.xy, 0., 1.); }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D source;
      uniform vec2 ratio;
      // Up to 12 source pixels per output pixel along each axis (a 390 px phone canvas from 4×).
      const int TAPS = 13;
      void main() {
        vec2 p0 = (gl_FragCoord.xy - .5) * ratio, p1 = p0 + ratio;
        ivec2 size = textureSize(source, 0);
        vec3 sum = vec3(0.);
        float total = 0.;
        for (int j = 0; j < TAPS; j++) {
          float y = floor(p0.y) + float(j);
          if (y >= p1.y) break;
          float wy = min(p1.y, y + 1.) - max(p0.y, y);
          for (int i = 0; i < TAPS; i++) {
            float x = floor(p0.x) + float(i);
            if (x >= p1.x) break;
            float w = wy * (min(p1.x, x + 1.) - max(p0.x, x));
            sum += texelFetch(source, clamp(ivec2(x, y), ivec2(0), size - 1), 0).rgb * w;
            total += w;
          }
        }
        // Raw values in, raw values out: the outline already writes sRGB.
        gl_FragColor = vec4(sum / max(total, 1e-6), 1.);
      }
    `,
  });
  private quad = new FullScreenQuad(this.material);

  render(renderer: THREE.WebGLRenderer, source: THREE.WebGLRenderTarget, width: number, height: number): void {
    this.material.uniforms.source.value = source.texture;
    this.material.uniforms.ratio.value.set(source.width / width, source.height / height);
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
  }

  dispose(): void { this.material.dispose(); this.quad.dispose(); }
}
