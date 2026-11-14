import * as THREE from '/node_modules/three/build/three.module.js';
import { EffectComposer } from '/node_modules/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/node_modules/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js';
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
        uSuppress: { value: 0.0 } // 0..1 incoming-fire stress: tunnel vision, desaturation, edge blur
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
        uniform float uTime, uVignette, uGrain, uSaturation, uContrast, uAberration, uDamage, uSuppress;
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

            // Saturation
            float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
            col.rgb = mix(vec3(luma), col.rgb, uSaturation * (1.0 - uSuppress * 0.45));

            // Contrast around mid-gray
            col.rgb = (col.rgb - 0.5) * uContrast + 0.5;

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
const QUALITY = {
    low:    { pixelRatio: 1.0,  shadow: 1024, bloom: false, ssr: false, msaa: 2, shadowType: THREE.PCFShadowMap,     grassMul: 0.55, treeMul: 0.6,  terrainSeg: 150,  treeLod: [34, 78, 185],  treeShadowLods: [0],       lodCount: 3, grassDist: 70, shadowExtent: 44, fieldMul: 0.25, fieldArea: 40, bushNear: 12 },
    medium: { pixelRatio: 1.0,  shadow: 1024, bloom: true, ssr: false, msaa: 4, shadowType: THREE.PCFShadowMap,     grassMul: 0.8,  treeMul: 0.85, terrainSeg: 170, treeLod: [40, 92, 210],  treeShadowLods: [0, 1],    lodCount: 3, grassDist: 85, shadowExtent: 52, fieldMul: 0.55, fieldArea: 46 },
    high:   { pixelRatio: Math.min(dpr, 1.5), shadow: 2048, bloom: true, ssr: true, msaa: 4, shadowType: THREE.PCFSoftShadowMap, grassMul: 1.0, treeMul: 1.0, terrainSeg: 200, treeLod: [46, 105, 235], treeShadowLods: [0, 1], lodCount: 3, grassDist: 105, shadowExtent: 60, fieldMul: 1.0, fieldArea: 54, bushNear: 24 },
    extreme: { pixelRatio: dpr, shadow: 4096, bloom: true, ssr: true, msaa: 4, ao: true, shadowType: THREE.PCFSoftShadowMap, grassMul: 1.7, treeMul: 1.5, terrainSeg: 300, treeLod: [62, 140, 300], treeShadowLods: [0, 1, 2], lodCount: 3, grassDist: 150, shadowExtent: 80, fieldMul: 2.1, fieldArea: 74, bushNear: 45, fx: 1.6 },
    ultra:  { pixelRatio: dpr,  shadow: 4096, bloom: true,  ssr: true, msaa: 4, shadowType: THREE.PCFSoftShadowMap, grassMul: 1.3,  treeMul: 1.15, terrainSeg: 240, treeLod: [52, 118, 260], treeShadowLods: [0, 1],    lodCount: 3, grassDist: 125, shadowExtent: 68, fieldMul: 1.4, fieldArea: 62, bushNear: 30 }
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
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            if (dbg) rendererStr = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
            const loseCtx = gl.getExtension('WEBGL_lose_context');
            if (loseCtx) loseCtx.loseContext();
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
        const q = QUALITY[this.quality];
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

        if (q.bloom) {
            const bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.28, 0.6, 0.92);
            this.passes.bloom = bloom;
            this.composer.addPass(bloom);
        }

        this.passes.grade = new ShaderPass(GradeShader);
        this.composer.addPass(this.passes.grade);

        this.passes.output = new OutputPass();
        this.composer.addPass(this.passes.output);
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
        if (this.composer) this.composer.setSize(w, h);
        if (this.camera) {
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
        }
    }

    render() {
        if (this.passes.grade) this.passes.grade.uniforms.uTime.value = this.clock.getElapsedTime();
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
            if (dt > 22) this._missed = (this._missed || 0) + 1;
        }
        this._lastFrame = now;
        if (now - (this._lastAdapt || 0) < 2000 || (this._frames || 0) < 60) return;
        const missRate = (this._missed || 0) / this._frames;
        let target = this._adaptiveScale;
        if ((missRate > 0.04 || this._frameEMA > 30) && this._adaptiveScale > 0.6) target = Math.max(0.6, this._adaptiveScale - 0.1);
        else if (missRate < 0.005 && this._frameEMA < 17.5 && this._adaptiveScale < 1.0 && now - (this._lastDrop || 0) > 8000) target = Math.min(1.0, this._adaptiveScale + 0.05);
        this._frames = 0; this._missed = 0;
        this._lastAdapt = now;
        if (Math.abs(target - this._adaptiveScale) > 0.001) {
            if (target < this._adaptiveScale) this._lastDrop = now;
            this._adaptiveScale = target;
            const q = this.settings || QUALITY[this.quality];
            const pr = q.pixelRatio * this._adaptiveScale;
            this.renderer.setPixelRatio(pr);
            if (this.composer) this.composer.setPixelRatio(pr);
        }
    }

    getDomElement() { return this.renderer.domElement; }
}
