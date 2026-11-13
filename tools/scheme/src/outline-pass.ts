import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { creaseAngle } from './settings.ts';
import type { OutlineStyle } from './types.ts';

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
 */
export class OutlinePass {
  readonly target: THREE.WebGLRenderTarget;
  /** Feature-edge lines; later reused for the horizontal distances. */
  private lines: THREE.WebGLRenderTarget;
  private classes: THREE.WebGLRenderTarget;
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
    // Horizontal pass: distance in pixels to the nearest core of each class (255 = none).
    this.spread = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: { classBuffer: { value: this.classes.texture }, texel: { value: texel }, reach: { value: 3 } },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D classBuffer;
        uniform vec2 texel;
        uniform int reach;
        void main() {
          vec3 best = vec3(255.);
          for (int x = -reach; x <= reach; x++) {
            vec3 core = step(.5, texture2D(classBuffer, vUv + vec2(float(x) * texel.x, 0.)).rgb);
            best = min(best, mix(vec3(255.), vec3(abs(float(x))), core));
          }
          gl_FragColor = vec4(best / 255., 1.);
        }
      `,
    });
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        spreadBuffer: { value: this.lines.texture }, texel: { value: texel }, reach: { value: 3 },
        silhouetteRadius: { value: 4 }, edgeRadius: { value: 2 }, gap: { value: 0 },
        ink: { value: new THREE.Vector3() }, paper: { value: new THREE.Vector3() }, transparent: { value: 0 },
      },
      vertexShader: quadVertex,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D spreadBuffer;
        uniform vec2 texel;
        uniform int reach;
        uniform float silhouetteRadius, edgeRadius, gap, transparent;
        uniform vec3 ink, paper;
        void main() {
          // Vertical half of the exact Euclidean distance transform, per class.
          vec3 nearest = vec3(65025.);
          for (int y = -reach; y <= reach; y++) {
            float dy = float(y);
            vec3 dx = texture2D(spreadBuffer, vUv + vec2(0., dy * texel.y)).rgb * 255.;
            nearest = min(nearest, dx * dx + dy * dy);
          }
          vec3 dist = sqrt(nearest);
          // Strokes cover the core plus the radius, with a one-pixel soft rim.
          float outline = clamp(silhouetteRadius + .5 - dist.r, 0., 1.);
          float inner = clamp(edgeRadius + .5 - dist.g, 0., 1.);
          // Halo: on the far side of a depth step (nearer to its far-side core than to
          // the outline core), inner lines stop gap pixels short of the outline stroke.
          float farSide = gap > 0. && dist.b < dist.r ? 1. : 0.;
          inner *= 1. - farSide * clamp(silhouetteRadius + gap + 1. - dist.r, 0., 1.);
          // Colors are explicitly sRGB values; this raw shader does not apply tone mapping.
          float line = max(outline, inner);
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
    // Both distance passes look this far: the outline stroke plus the halo, or the inner stroke.
    const reach = Math.ceil(Math.max(u.silhouetteRadius.value + u.gap.value + 1, u.edgeRadius.value + .5));
    u.reach.value = this.spread.uniforms.reach.value = reach;
    // Depth threshold is a fraction of the frame width, i.e. of the fitted model size,
    // independent of file units and of how deep the model is along the view axis.
    c.depthThreshold.value = style.depthThreshold * frameWidth / depthRange;
    c.haloDepth.value = c.depthThreshold.value * HALO_DEPTH_FACTOR;
    c.normalThreshold.value = style.normalThreshold;
    c.worldToDepth.value.set(frameWidth / depthRange, (camera.top - camera.bottom) / depthRange);
    this.edges.uniforms.minAngle.value = creaseAngle(style.normalThreshold);
    this.edges.uniforms.bias.value = EDGE_BIAS_PX * frameWidth / this.target.width / depthRange;
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
      scene.overrideMaterial = this.edges;
      camera.layers.set(EDGE_LAYER);
      renderer.setRenderTarget(this.lines);
      renderer.clear();
      renderer.render(scene, camera);
      pass(this.classify, this.classes);
      pass(this.spread, this.lines);
      pass(this.material, output);
    } finally {
      camera.layers.mask = layers;
      this.quad.material = this.material;
      scene.overrideMaterial = previousOverride;
      scene.background = background;
      renderer.setRenderTarget(null);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.lines.dispose();
    this.classes.dispose();
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
