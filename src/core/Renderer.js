import * as THREE from '/node_modules/three/build/three.module.js';
import { EffectComposer } from '/node_modules/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/node_modules/three/examples/jsm/postprocessing/RenderPass.js';
import { LiteBloomPass } from '../render/LiteBloomPass.js';
import { Platform } from './Platform.js';
import { ShaderPass } from '/node_modules/three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from '/node_modules/three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from '/node_modules/three/examples/jsm/postprocessing/GTAOPass.js';
import { SSRPass } from '/node_modules/three/examples/jsm/postprocessing/SSRPass.js';

/**
 * Final color-grade / lens pass applied after bloom.
 * Adds vignette, film grain, saturation & contrast control, subtle
 * chromatic aberration at the frame edges, and a damage desaturation hook.
 */
const GradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uVignette: { value: 0.55 },
        uGrain: { value: 0.018 },
        uSaturation: { value: 1.1 },
        uContrast: { value: 1.05 },
        uAberration: { value: 0.0003 },
        uDamage: { value: 0.0 },  // 0..1 red pulse when the player is hurt
        uSuppress: { value: 0.0 }, // 0..1 incoming-fire stress: tunnel vision, desaturation, edge blur
        uSunUV: { value: new THREE.Vector2(0.5, 0.5) }, uShaft: { value: 0 },
        tBloom: { value: null }, uBloomOff: { value: new THREE.Vector2(0.01, 0.01) }, uBloom: { value: 0.5 },
        uSharpen: { value: 0.2 }, uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uTintS: { value: new THREE.Vector3(1, 1, 1) }, uTintH: { value: new THREE.Vector3(1, 1, 1) }   // split-tone for shadows / highlights
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime, uVignette, uGrain, uSaturation, uContrast, uAberration, uDamage, uSuppress, uBloom, uSharpen;
        uniform sampler2D tBloom;
        uniform vec2 uTexel, uBloomOff, uSunUV;
        uniform float uShaft;
        uniform vec3 uTintS, uTintH;
        varying vec2 vUv;

        float rand(vec2 co) {
            return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            vec2 uv = vUv;
            vec2 center = uv - 0.5;
            float dist = length(center);

            // Chromatic aberration, stronger toward edges (and under fire)
            float ab = (uAberration + uSuppress * 0.012) * dist;
            vec4 col;
            col.r = texture2D(tDiffuse, uv + center * ab).r;
            col.g = texture2D(tDiffuse, uv).g;
            col.b = texture2D(tDiffuse, uv - center * ab).b;
            col.a = 1.0;
            if (uSuppress > 0.01) {
                // cheap edge blur: 4 taps whose radius grows toward the frame edge
                float r = uSuppress * smoothstep(0.15, 0.6, dist) * 0.006;
                vec3 blur = texture2D(tDiffuse, uv + vec2(r, r)).rgb + texture2D(tDiffuse, uv + vec2(-r, r)).rgb
                          + texture2D(tDiffuse, uv + vec2(r, -r)).rgb + texture2D(tDiffuse, uv + vec2(-r, -r)).rgb;
                col.rgb = mix(col.rgb, blur * 0.25, min(1.0, uSuppress * 1.5) * smoothstep(0.15, 0.6, dist));
            }

            // Unsharp mask (HDR-safe, clamped): wins back detail lost to dynamic resolution
            if (uSharpen > 0.001) {
                vec3 bl = (texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb
                         + texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb + texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb) * 0.25;
                col.rgb += clamp(col.rgb - bl, -0.25, 0.25) * uSharpen;
            }
            // Bloom from the light-weight HDR pass (tight + wide halo), added while we already touch every pixel
            vec3 bloomSum = texture2D(tBloom, uv).rgb * 0.4
                + (texture2D(tBloom, uv + vec2(uBloomOff.x, 0.0)).rgb + texture2D(tBloom, uv - vec2(uBloomOff.x, 0.0)).rgb
                 + texture2D(tBloom, uv + vec2(0.0, uBloomOff.y)).rgb + texture2D(tBloom, uv - vec2(0.0, uBloomOff.y)).rgb) * 0.15;
            col.rgb += bloomSum * uBloom;
            // Sun shafts: radial smear of the bright pass toward the sun. Buildings and trees are dark in that
            // pass, so they occlude the beams for free. Skipped entirely when the sun is off screen.
            if (uShaft > 0.001) {
                vec2 sd = uSunUV - uv;
                float j = rand(uv * (uTime + 1.7));
                vec3 sh = vec3(0.0);
                for (int i = 0; i < 12; i++) {
                    float t = (float(i) + j) / 12.0;
                    sh += texture2D(tBloom, uv + sd * t * 0.9).rgb * (1.0 - t);
                }
                col.rgb += sh / 12.0 * uShaft * vec3(1.0, 0.82, 0.58) * (1.0 - smoothstep(0.2, 1.3, length(sd)) * 0.6);
            }

            // Soft highlight shoulder (before contrast, which would otherwise push whites into flat clipped patches)
            float hl = max(col.r, max(col.g, col.b));
            if (hl > 0.75) col.rgb *= (0.75 + (hl - 0.75) / (1.0 + (hl - 0.75) * 1.4)) / hl;

            // Saturation
            float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
            col.rgb = mix(vec3(luma), col.rgb, uSaturation * (1.0 - uSuppress * 0.45));

            // Contrast around mid-gray
            col.rgb = (col.rgb - 0.5) * uContrast + 0.5;

            // Split-tone: cool/warm shadows vs highlights (per-level look)
            col.rgb *= mix(uTintS, uTintH, smoothstep(0.05, 0.85, dot(col.rgb, vec3(0.299, 0.587, 0.114))));

            // Damage pulse: red edges + slight desaturation
            float dmg = uDamage;
            col.rgb = mix(col.rgb, vec3(luma * 0.6 + 0.4, luma * 0.15, luma * 0.15), dmg * smoothstep(0.2, 0.75, dist));

            // Vignette
            float vig = smoothstep(0.85 - uSuppress * 0.25, 0.25 - uSuppress * 0.1, dist);
            col.rgb *= mix(1.0, vig, min(1.0, uVignette + uSuppress * 0.4));

            // Film grain
            float g = rand(uv * uTime) - 0.5;
            col.rgb += g * uGrain;

            gl_FragColor = vec4(col.rgb, 1.0);
        }
    `
};

const dpr = Math.min(window.devicePixelRatio || 1, 2);
// post-process strength per tier: lower tiers render fewer pixels, so sharpen more and bloom a touch less
const POST = {
    low: { bloom: 0.34, sharpen: 0.32 }, medium: { bloom: 0.4, sharpen: 0.26 }, high: { bloom: 0.45, sharpen: 0.18 },
    ultra: { bloom: 0.5, sharpen: 0.12 }, extreme: { bloom: 0.5, sharpen: 0.1 }
};
/** Phones / tablets: whatever preset is chosen, cap the expensive parts (fill rate, vegetation, post). */
const MOBILE = {
    mobile: true, pixelRatio: Math.min(dpr, 1.0), msaa: 2, ssr: false, ao: false, shadowType: THREE.PCFShadowMap,
    loadHDR: false, textureDetailDistance: 8, textureStreamInterval: 0.65, textureStreamBatch: 1, textureUnloadDelay: 10,
    grassMul: 0.35, treeMul: 0.5, terrainSeg: 110, treeLod: [26, 60, 140], treeShadowLods: [0], grassDist: 48,
    fieldMul: 0.12, fieldArea: 28, bushNear: 10, fx: 0.6, propLod: [18, 40, 80, 160], impostorResolution: 64
};
const QUALITY = {
    low:    { pixelRatio: 1.0,  shadow: 1024, bloom: false, ssr: false, msaa: 0, shadowType: THREE.PCFShadowMap,     loadHDR: false, textureDetailDistance: 9,  textureStreamInterval: 0.55, textureStreamBatch: 1, textureUnloadDelay: 12, grassMul: 0.55, treeMul: 0.6,  terrainSeg: 150,  treeLod: [34, 78, 185],  treeShadowLods: [0],       lodCount: 3, grassDist: 70, shadowExtent: 44, fieldMul: 0.25, fieldArea: 40, bushNear: 12 },
    medium: { pixelRatio: 1.0,  shadow: 1024, bloom: true, ssr: false, msaa: 2, shadowType: THREE.PCFShadowMap,     loadHDR: false, textureDetailDistance: 14, textureStreamInterval: 0.38, textureStreamBatch: 1, textureUnloadDelay: 18, grassMul: 0.8,  treeMul: 0.85, terrainSeg: 170, treeLod: [40, 92, 210],  treeShadowLods: [0, 1],    lodCount: 3, grassDist: 85, shadowExtent: 52, fieldMul: 0.55, fieldArea: 46 },
    high:   { pixelRatio: Math.min(dpr, 1.5), shadow: 2048, bloom: true, ssr: true, msaa: 2, shadowType: THREE.PCFSoftShadowMap, loadHDR: true, textureDetailDistance: 22, textureStreamInterval: 0.24, textureStreamBatch: 1, textureUnloadDelay: 24, grassMul: 1.0, treeMul: 1.0, terrainSeg: 200, treeLod: [46, 105, 235], treeShadowLods: [0, 1], lodCount: 3, grassDist: 105, shadowExtent: 60, fieldMul: 1.0, fieldArea: 54, bushNear: 24 },
    extreme: { pixelRatio: dpr, shadow: 4096, bloom: true, ssr: true, msaa: 4, ao: true, shadowType: THREE.PCFSoftShadowMap, loadHDR: true, textureDetailDistance: 34, textureStreamInterval: 0.12, textureStreamBatch: 3, textureUnloadDelay: 40, grassMul: 1.7, treeMul: 1.5, terrainSeg: 300, treeLod: [62, 140, 300], treeShadowLods: [0, 1, 2], lodCount: 3, grassDist: 150, shadowExtent: 80, fieldMul: 2.1, fieldArea: 74, bushNear: 45, fx: 1.6 },
    ultra:  { pixelRatio: dpr,  shadow: 4096, bloom: true,  ssr: true, msaa: 4, shadowType: THREE.PCFSoftShadowMap, loadHDR: true, textureDetailDistance: 28, textureStreamInterval: 0.16, textureStreamBatch: 2, textureUnloadDelay: 32, grassMul: 1.3,  treeMul: 1.15, terrainSeg: 240, treeLod: [52, 118, 260], treeShadowLods: [0, 1],    lodCount: 3, grassDist: 125, shadowExtent: 68, fieldMul: 1.4, fieldArea: 62, bushNear: 30 }
};

/**
 * Identify weak / integrated GPUs so we can pick a sane default quality and
 * avoid the "freezes when I move" failure mode on low fill-rate hardware.
 * Returns 'low' | 'medium' | 'high'.
 */
export function detectGPUTier() {
    let rendererStr = '';
    try {
        const c = document.createElement('canvas');
        // ask for the same GPU the game will render on (hybrid laptops otherwise report the integrated one)
        const opts = { powerPreference: 'high-performance' };
        const gl = c.getContext('webgl2', opts) || c.getContext('webgl', opts);
        if (gl) {
            rendererStr = gl.getParameter(gl.RENDERER) || '';
        }
    } catch (e) { /* ignore */ }
    const s = rendererStr.toLowerCase();
    const weak = ['intel', 'uhd', 'hd graphics', 'iris', 'mali', 'adreno', 'powervr',
                  'apple m1', 'swiftshader', 'llvmpipe', 'software', 'radeon graphics',
                  'vega 3', 'vega 6', 'geforce mx', 'gtx 16', 'rx 5', 'integrated'];
    const isWeak = weak.some(k => s.includes(k)) && !s.includes('rtx') && !s.includes('arc');
    if (!s) return 'medium';         // unknown: be conservative
    if (isWeak) return 'low';
    return 'high';
}

export class Renderer {
    constructor() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: false, // SMAA handles AA in the composer
            powerPreference: 'high-performance',
            stencil: false
        });
        this.composer = null;
        this.passes = {};
        this.quality = 'high';
        this.clock = new THREE.Clock();

        // Adaptive resolution: on weak GPUs, shrink the render scale when the
        // frame time spikes so motion stays smooth instead of stalling.
        this.adaptive = true;
        this._frameEMA = 16;
        this._adaptiveScale = 1.0;
        this._resizeQueued = false;
    }

    initialize(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.32;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.domElement.id = 'game-canvas';
        document.body.appendChild(this.renderer.domElement);

        this.applyQuality(this.quality);
        this._buildComposer();

        window.addEventListener('resize', () => this.resize());
    }

    applyQuality(name) {
        this.quality = QUALITY[name] ? name : 'high';
        const q = Platform.mobile ? { ...QUALITY[this.quality], ...MOBILE, bloom: QUALITY[this.quality].bloom } : QUALITY[this.quality];
        Platform.tier = this.quality;
        this.renderer.setPixelRatio(q.pixelRatio);
        this.renderer.shadowMap.type = q.shadowType;
        this.settings = q;
        // Reset adaptive scaling whenever quality changes explicitly.
        this._adaptiveScale = 1.0;
        this._frameEMA = 16;
        if (this.composer) this._buildComposer();
    }

    /** Current quality preset (grassMul/treeMul/castTreeShadow etc.). */
    getSettings() { return this.settings || QUALITY.high; }

    _buildComposer() {
        const q = this.settings;
        const w = window.innerWidth, h = window.innerHeight;
        if (this.composer) {
            Object.values(this.passes).forEach(p => p.dispose && p.dispose());
            this.composer.dispose();
        }
        // MSAA render target: cheap, clean edges without a post AA pass.
        const rt = new THREE.WebGLRenderTarget(w * q.pixelRatio, h * q.pixelRatio, {
            type: THREE.HalfFloatType, samples: q.msaa
        });
        this.composer = new EffectComposer(this.renderer, rt);
        this.composer.setPixelRatio(q.pixelRatio);
        this.composer.setSize(w, h);
        this.passes = {};

        this.passes.render = new RenderPass(this.scene, this.camera);
        this.composer.addPass(this.passes.render);

        if (q.ao) {
            // ground-truth ambient occlusion: contact darkening under foliage, props, walls
            const ao = new GTAOPass(this.scene, this.camera, w, h);
            ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12 });
            ao.blendIntensity = 0.85;
            this.passes.ao = ao;
            this.composer.addPass(ao);
        }

        if (q.ssr) {
            const ssr = new SSRPass({
                renderer: this.renderer, scene: this.scene, camera: this.camera, selects: [],
                width: Math.max(1, Math.floor(w * q.pixelRatio * 0.5)),
                height: Math.max(1, Math.floor(h * q.pixelRatio * 0.5))
            });
            ssr.maxDistance = 32;
            ssr.thickness = 0.12;
            ssr.opacity = 0.62;
            ssr.blur = true;
            ssr.distanceAttenuation = true;
            ssr.fresnel = true;
            this.passes.ssr = ssr;
            this.composer.addPass(ssr);
            this._updateSSRSelects(this.scene);
        }

        // light-weight bloom on every tier (see LiteBloomPass): ~5 tiny draws, no extra full-res pass
        const bloom = new LiteBloomPass(w * q.pixelRatio, h * q.pixelRatio, { threshold: 1.15, knee: 0.8 });
        this.passes.bloom = bloom;
        this.composer.addPass(bloom);

        this.passes.grade = new ShaderPass(GradeShader);
        this.passes.grade.uniforms.tBloom.value = bloom.texture;
        this.composer.addPass(this.passes.grade);
        this._applyPost();

        this.passes.output = new OutputPass();
        this.composer.addPass(this.passes.output);
    }

    /** Tier defaults for bloom/sharpen; per-level grade multiplies on top (see setGrade). */
    _applyPost() {
        const u = this.passes.grade && this.passes.grade.uniforms;
        if (!u) return;
        const t = POST[this.quality] || POST.high, g = this._grade || {};
        u.uBloom.value = t.bloom * (g.bloom ?? 1);
        u.uSharpen.value = t.sharpen * (g.sharpen ?? 1);
        const pr = this.composer._pixelRatio || 1;
        const w = (this.composer._width || window.innerWidth) * pr, h = (this.composer._height || window.innerHeight) * pr;
        u.uTexel.value.set(1 / w, 1 / h);
        if (this.passes.bloom) u.uBloomOff.value.copy(this.passes.bloom.texel).multiplyScalar(2.5);
    }

    /** World-space direction of the sun (null = no shafts) and shaft strength. */
    setSun(dir, strength = 0) {
        this._sunDir = dir ? dir.clone().normalize() : null;
        this._shaft = strength;
        if (!dir && this.passes.grade) this.passes.grade.uniforms.uShaft.value = 0;
    }

    _updateSun() {
        const u = this.passes.grade && this.passes.grade.uniforms;
        if (!u || !this._sunDir || !this._shaft || !this.camera) { if (u) u.uShaft.value = 0; return; }
        const cam = this.camera;
        this._sv = this._sv || new THREE.Vector3(); this._cd = this._cd || new THREE.Vector3(); this._cp = this._cp || new THREE.Vector3();
        cam.getWorldPosition(this._cp); cam.getWorldDirection(this._cd);
        const facing = this._cd.dot(this._sunDir);
        if (facing < 0.05) { u.uShaft.value = 0; return; }
        this._sv.copy(this._cp).addScaledVector(this._sunDir, 800).project(cam);
        u.uSunUV.value.set(this._sv.x * 0.5 + 0.5, this._sv.y * 0.5 + 0.5);
        const edge = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(this._sv.x), Math.abs(this._sv.y)), 0.9, 1.7);
        u.uShaft.value = this._shaft * THREE.MathUtils.smoothstep(facing, 0.05, 0.5) * edge;
    }

    /** Exposed so gameplay can drive the damage red-pulse. */
    setDamage(amount) {
        if (this.passes.grade) this.passes.grade.uniforms.uDamage.value = amount;
    }

    setSuppression(amount) {
        if (this.passes.grade) this.passes.grade.uniforms.uSuppress.value = amount;
    }

    /**
     * Swap the scene/camera the composer renders. Used to switch between the
     * cinematic menu backdrop and the gameplay level without rebuilding the
     * post-processing chain. Scene-dependent passes (RenderPass, SSAO) are
     * retargeted; the rest of the chain is scene-agnostic.
     */
    setScene(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        // loading hitches must not count against the next scene's frame budget
        this._frames = 0; this._missed = 0; this._lastFrame = 0; this._lastAdapt = performance.now();
        if (this.passes.render) {
            this.passes.render.scene = scene;
            this.passes.render.camera = camera;
        }
        if (this.passes.ao) { this.passes.ao.scene = scene; this.passes.ao.camera = camera; }
        if (this.passes.ssr) {
            this.passes.ssr.scene = scene; this.passes.ssr.camera = camera;
            this._updateSSRSelects(scene);
        }
    }

    _updateSSRSelects(scene) {
        if (!this.passes.ssr || !scene) return;
        const selects = [];
        scene.traverse(object => {
            if (!object.isMesh) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            if (object.userData.ssrReflective || materials.some(material =>
                material?.isMeshStandardMaterial && (material.metalness > 0.22 || material.roughness < 0.42))) selects.push(object);
        });
        this.passes.ssr.selects = selects;
    }

    setExposure(v) { this.renderer.toneMappingExposure = v; }

    /** Per-level colour grade: { saturation, contrast, vignette }. Omitted fields return to the defaults. */
    setGrade(g = {}) {
        const u = this.passes.grade && this.passes.grade.uniforms;
        if (!u) return;
        this._grade = g;
        u.uTintS.value.set(...(g.tintShadow || [1, 1, 1]));
        u.uTintH.value.set(...(g.tintHigh || [1, 1, 1]));
        this._applyPost();
        u.uSaturation.value = g.saturation ?? 1.1;
        u.uContrast.value = g.contrast ?? 1.05;
        u.uVignette.value = g.vignette ?? 0.55;
    }

    setGrain(amount) {
        if (this.passes.grade) this.passes.grade.uniforms.uGrain.value = amount;
    }

    resize() {
        const w = window.innerWidth, h = window.innerHeight;
        this.renderer.setSize(w, h);
        if (this.composer) { this.composer.setSize(w, h); this._applyPost(); }
        if (this.camera) {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
    }

    render() {
        if (this.passes.grade) this.passes.grade.uniforms.uTime.value = this.clock.getElapsedTime();
        this._updateSun();
        this.composer.render();
        this._adaptResolution();
    }

    /**
     * Dynamic resolution scaling driven by REAL frame-to-frame time (the old
     * version timed only the CPU submit call, so it never saw GPU stalls, and
     * it resized render targets every 500ms which itself caused hitches).
     * Now: slow, hysteretic, and bounded - only drops when frames are
     * consistently slow and recovers gradually when there is headroom.
     */
    _adaptResolution() {
        if (!this.adaptive) return;
        const now = performance.now();
        if (this._lastFrame) {
            const dt = Math.min(now - this._lastFrame, 100);
            this._frameEMA = this._frameEMA * 0.95 + dt * 0.05;
            // vsync quantises a slow frame to a whole extra refresh, so judge by missed
            // frames rather than the average: 10% of frames at 33 ms reads as stutter
            this._frames = (this._frames || 0) + 1;
            if (dt > (this.targetFrameMs || 16.7) * 1.35) this._missed = (this._missed || 0) + 1;
        }
        this._lastFrame = now;
        if (now - (this._lastAdapt || 0) < 2000 || (this._frames || 0) < 60) return;
        const missRate = (this._missed || 0) / this._frames;
        let target = this._adaptiveScale;
        const tgt = this.targetFrameMs || 16.7;
        if ((missRate > 0.04 || this._frameEMA > tgt * 1.8) && this._adaptiveScale > 0.6) target = Math.max(0.6, this._adaptiveScale - 0.1);
        else if (missRate < 0.005 && this._frameEMA < tgt * 1.05 && this._adaptiveScale < 1.0 && now - (this._lastDrop || 0) > 8000) target = Math.min(1.0, this._adaptiveScale + 0.05);
        this._frames = 0; this._missed = 0;
        this._lastAdapt = now;
        if (Math.abs(target - this._adaptiveScale) > 0.001) {
            if (target < this._adaptiveScale) this._lastDrop = now;
            this._adaptiveScale = target;
            const q = this.settings || QUALITY[this.quality];
            const pr = q.pixelRatio * this._adaptiveScale;
            this.renderer.setPixelRatio(pr);
            if (this.composer) { this.composer.setPixelRatio(pr); this._applyPost(); }
        }
    }

    getDomElement() { return this.renderer.domElement; }
}
