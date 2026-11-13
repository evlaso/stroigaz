import * as THREE from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { EDGE_BIAS_PX, EDGE_LAYER, featureEdgeMaterial } from './outline-pass.ts';
import { creaseAngle, MODEL_EDGE } from './settings.ts';
import type { ShadingStyle } from './types.ts';

export interface ShadeOptions {
  shading: ShadingStyle;
  /** Outline crease threshold: mesh edges flatter than it are not drawn here either. */
  normalThreshold: number;
  background: string;
  /** No background: alpha = model coverage, premultiplied (PNG export only). */
  transparent: boolean;
  /** Output pixels per 1× pixel. */
  scale: number;
  /** Model units per 1× pixel. */
  unitsPerPixel: number;
}

export interface TracedImage {
  /** Linear radiance, black where camera rays miss the model. */
  texture: THREE.Texture;
}

/**
 * Studio view of the «Модель» mode, in linear HDR, composited onto the page background.
 *
 * 1. Beauty: PBR materials, studio environment, key light with a self-shadow map (no floor,
 *    no shadow on the background), MSAA, into a half-float target with a transparent
 *    background (alpha = model coverage).
 * 2. Feature edges (the same lines and hidden-line test as the outline) into a 1-px mask.
 * 3. GTAO (three/examples) over the model: crevices, joints, fasteners. The background
 *    has no depth, so it never darkens.
 * 4. Composite: ACES on the model only, AO, background × (1 − alpha), edges widened to
 *    0.75 px at 1×, sRGB. The background colour stays exact (white is 255, not ACES grey).
 *    Transparent (PNG export): no background, alpha = coverage (and edges), premultiplied output.
 *
 * With a path-traced image the composite takes the model radiance from the tracer;
 * coverage and edges still come from 1–2.
 */
export class ShadedPass {
  readonly beauty: THREE.WebGLRenderTarget;
  private mask: THREE.WebGLRenderTarget;
  private gtao?: GTAOPass;
  private edges: THREE.ShaderMaterial;
  private composite: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private texel = new THREE.Vector2(1, 1);
  private width = 1;
  private height = 1;
  private hasEdges = false;
  private hasOcclusion = false;
  private pdNoise = new THREE.DataTexture(new Uint8Array([40, 40, 40, 255]), 1, 1);

  constructor() {
    this.beauty = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: 4,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
    });
    this.mask = new THREE.WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: false });
    this.edges = featureEdgeMaterial(this.beauty.depthTexture!, this.texel);
    this.composite = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        beauty: { value: this.beauty.texture }, occlusion: { value: null }, edges: { value: this.mask.texture },
        traced: { value: null }, texel: { value: this.texel },
        useOcclusion: { value: 0 }, occlusionStrength: { value: 1 }, useEdges: { value: 0 }, useTrace: { value: 0 },
        edgeWidth: { value: 1 }, edgeRadius: { value: 0 }, edgeOpacity: { value: MODEL_EDGE.opacity },
        edgeColor: { value: new THREE.Color(MODEL_EDGE.color) }, background: { value: new THREE.Color() },
        exposure: { value: 1 }, transparent: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D beauty, occlusion, edges, traced;
        uniform vec2 texel;
        uniform float useOcclusion, occlusionStrength, useEdges, useTrace;
        uniform float edgeWidth, edgeRadius, edgeOpacity, exposure, transparent;
        uniform vec3 edgeColor, background;
        // three.js ACESFilmicToneMapping (Stephen Hill's fit), inlined: tone mapping must not
        // touch the background, so it runs here on the model only.
        vec3 RRTAndODTFit(vec3 v) {
          vec3 a = v * (v + .0245786) - .000090537;
          vec3 b = v * (.983729 * v + .4329510) + .238081;
          return a / b;
        }
        vec3 aces(vec3 color) {
          const mat3 inputMat = mat3(vec3(.59719, .07600, .02840), vec3(.35458, .90834, .13383), vec3(.04823, .01566, .83777));
          const mat3 outputMat = mat3(vec3(1.60475, -.10208, -.00327), vec3(-.53108, 1.10813, -.07276), vec3(-.07367, -.00605, 1.07602));
          color *= exposure / .6;
          return clamp(outputMat * RRTAndODTFit(inputMat * color), 0., 1.);
        }
        vec3 srgb(vec3 c) {
          return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c));
        }
        void main() {
          vec4 b = texture2D(beauty, vUv);
          // Model radiance after the curve, premultiplied by the raster coverage b.a.
          vec3 model;
          float ao = 1.;
          if (useTrace > .5) {
            // Radiance from the tracer (black background: premultiplied by its own coverage),
            // coverage from the raster pass at the same resolution.
            vec3 t = texture2D(traced, vUv).rgb;
            model = b.a > 0. ? aces(t / max(b.a, .05)) * b.a : vec3(0.);
          } else {
            // Premultiplied: un-premultiply before the curve so antialiased rims match.
            model = b.a > 0. ? aces(b.rgb / b.a) * b.a : vec3(0.);
            // Strength up to 1 blends the occlusion in, above 1 deepens it.
            if (useOcclusion > .5) ao = pow(mix(1., texture2D(occlusion, vUv).r, min(occlusionStrength, 1.)), max(occlusionStrength, 1.));
          }
          // Premultiplied linear colour and alpha: over the background, or alone (transparent).
          vec3 color;
          float alpha;
          if (transparent > .5) { color = model * ao; alpha = b.a; }
          else { color = (model + background * (1. - b.a)) * ao; alpha = 1.; }
          if (useEdges > .5) {
            // 1-px line mask widened to edgeWidth device pixels (thinner = fainter).
            float line = 0.;
            for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
              float w = clamp(edgeRadius + 1. - length(vec2(x, y)), 0., 1.);
              if (w > 0.) line = max(line, texture2D(edges, vUv + vec2(float(x), float(y)) * texel).r * w);
            }
            // Edges over the picture ("over" with premultiplied alpha; opaque — a plain mix).
            float e = line * min(edgeWidth, 1.) * edgeOpacity;
            color = color * (1. - e) + edgeColor * e;
            alpha = alpha * (1. - e) + e;
          }
          // sRGB of the straight colour, premultiplied again for the (premultiplied) canvas.
          vec3 straight = alpha > 0. ? color / alpha : vec3(0.);
          gl_FragColor = vec4(srgb(clamp(straight, 0., 1.)) * alpha, alpha);
        }
      `,
    });
    this.quad = new FullScreenQuad(this.composite);
    this.pdNoise.needsUpdate = true;
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height;
    this.beauty.setSize(width, height);
    this.mask.setSize(width, height);
    this.gtao?.setSize(width, height);
    this.texel.set(1 / width, 1 / height);
  }

  /** Rasterize the beauty, the edge mask and (optionally) ambient occlusion. */
  draw(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.OrthographicCamera, o: ShadeOptions, occlusion: boolean): void {
    const clear = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    const layers = camera.layers.mask, override = scene.overrideMaterial;
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.beauty);
      renderer.clear();
      renderer.render(scene, camera);

      this.hasEdges = o.shading.edges;
      if (this.hasEdges) {
        const frameWidth = camera.right - camera.left, depthRange = camera.far - camera.near;
        this.edges.uniforms.minAngle.value = creaseAngle(o.normalThreshold);
        this.edges.uniforms.bias.value = EDGE_BIAS_PX * frameWidth / this.width / depthRange;
        scene.overrideMaterial = this.edges;
        camera.layers.set(EDGE_LAYER);
        renderer.setRenderTarget(this.mask);
        renderer.clear();
        renderer.render(scene, camera);
        camera.layers.mask = layers;
        scene.overrideMaterial = override;
      }

      this.hasOcclusion = occlusion && o.shading.occlusion > 0;
      if (this.hasOcclusion) {
        if (!this.gtao) {
          this.gtao = new GTAOPass(scene, camera, this.width, this.height);
          this.gtao.output = GTAOPass.OUTPUT.Off;
          // STL / OBJ winding is not trusted: both sides, normal flipped to the viewer.
          this.gtao.normalMaterial.side = THREE.DoubleSide;
          // One fixed rotation of the denoise kernel for every pixel: a smooth result, no grain.
          this.gtao.pdMaterial.uniforms.tNoise.value = this.pdNoise;
        }
        // Radius in model units from 1× pixels: identical look at 1×, 2× and 4×.
        const radius = o.shading.occlusionRadius * o.unitsPerPixel;
        this.gtao.updateGtaoMaterial({ radius, thickness: radius, distanceExponent: 1, distanceFallOff: 1, scale: 2.5, samples: 16 });
        // A small edge-aware Poisson blur (≈ 1.5 px of the 1× frame) evens out the 4 × 4 GTAO noise.
        // A wider one, or one rotated randomly per pixel (the three.js default), turns the steep
        // AO gradient at a contact (shell on its base plate) into dark grain.
        this.gtao.updatePdMaterial({ radius: Math.min(Math.max(1.5 * o.scale, 2), 8), lumaPhi: 10, depthPhi: 2, normalPhi: 3, rings: 3, samples: 24 });
        this.gtao.render(renderer, null as unknown as THREE.WebGLRenderTarget, null as unknown as THREE.WebGLRenderTarget, 0, false);
      }
    } finally {
      camera.layers.mask = layers;
      scene.overrideMaterial = override;
      renderer.setClearColor(clear, clearAlpha);
      renderer.setRenderTarget(null);
    }
  }

  /** Composite the last draw() (and a traced image) onto the canvas. */
  present(renderer: THREE.WebGLRenderer, o: ShadeOptions, traced?: TracedImage): void {
    const u = this.composite.uniforms;
    u.background.value.set(o.background);
    u.transparent.value = o.transparent ? 1 : 0;
    u.useOcclusion.value = this.hasOcclusion && !traced ? 1 : 0;
    u.occlusion.value = this.gtao?.gtaoMap ?? null;
    u.occlusionStrength.value = o.shading.occlusion;
    u.useEdges.value = this.hasEdges ? 1 : 0;
    const width = MODEL_EDGE.width * o.scale;
    u.edgeWidth.value = width;
    u.edgeRadius.value = Math.max(0, (width - 1) / 2);
    u.useTrace.value = traced ? 1 : 0;
    u.traced.value = traced?.texture ?? null;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.beauty.dispose();
    this.mask.dispose();
    this.gtao?.dispose();
    this.pdNoise.dispose();
    this.edges.dispose();
    this.composite.dispose();
    this.quad.dispose();
  }
}
