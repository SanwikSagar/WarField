import * as THREE from '/node_modules/three/build/three.module.js';
import { Pass, FullScreenQuad } from '/node_modules/three/examples/jsm/postprocessing/Pass.js';

/**
 * Light-weight HDR bloom. Unlike UnrealBloomPass (5 mip levels × 2 blurs, all at large sizes)
 * this does ONE bright-pass that already downsamples to 1/4 resolution, then a separable
 * blur at 1/8. Three tiny full-screen draws; the grade pass widens the halo with a 5-tap
 * cross on the already-blurred result.
 *
 * It does not write to the composer's buffers: it only produces `this.texture`, which the
 * grade pass adds on top while it is already touching every pixel (so no extra full-res pass).
 * Works on the linear HDR scene, so only genuinely bright things glow — flames, lit windows,
 * sun glints, specular highlights — not the whole image.
 */
const QUAD_VERT = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const EXTRACT_FRAG = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uTexel;            // source texel size
    uniform float uThreshold, uKnee;
    varying vec2 vUv;
    vec3 prefilter(vec3 c) {
        float l = max(max(c.r, c.g), c.b);
        float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        soft = soft * soft / (4.0 * uKnee + 1e-4);
        float k = max(soft, l - uThreshold) / max(l, 1e-4);
        return c * k;
    }
    void main() {
        // 4 bilinear taps = a 4x4 box: stable downsample (no fireflies from single hot pixels)
        vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
        c = min(c * 0.25, vec3(24.0));
        gl_FragColor = vec4(prefilter(c), 1.0);
    }`;

const BLUR_FRAG = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2 uDir;              // texel-scaled direction
    varying vec2 vUv;
    void main() {
        // 9-tap gaussian expressed as 5 bilinear taps
        vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
        c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
        c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
        c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
        c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
        gl_FragColor = vec4(c, 1.0);
    }`;

export class LiteBloomPass extends Pass {
    constructor(width, height, { threshold = 1.15, knee = 0.8, radius = 1.0 } = {}) {
        super();
        this.needsSwap = false;
        this.radius = radius;
        const opts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
        this.rtA = new THREE.WebGLRenderTarget(8, 8, opts);   // 1/4
        this.rtB = new THREE.WebGLRenderTarget(8, 8, opts);   // 1/8
        this.rtC = new THREE.WebGLRenderTarget(8, 8, opts);   // 1/8 (final)
        this.extract = new THREE.ShaderMaterial({
            uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: threshold }, uKnee: { value: knee } },
            vertexShader: QUAD_VERT, fragmentShader: EXTRACT_FRAG, depthTest: false, depthWrite: false
        });
        this.blur = new THREE.ShaderMaterial({
            uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
            vertexShader: QUAD_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false
        });
        this.quad = new FullScreenQuad(this.extract);
        this.setSize(width, height);
    }

    /** Final bloom texture (1/8 resolution). */
    get texture() { return this.rtC.texture; }
    /** Texel size of the bloom texture in UV units (for the grade pass's halo taps). */
    get texel() { return new THREE.Vector2(1 / this.rtC.width, 1 / this.rtC.height); }

    setSize(width, height) {
        this.w = Math.max(1, width | 0); this.h = Math.max(1, height | 0);
        const s = (rt, d) => rt.setSize(Math.max(2, Math.floor(this.w / d)), Math.max(2, Math.floor(this.h / d)));
        s(this.rtA, 4); s(this.rtB, 8); s(this.rtC, 8);
    }

    get threshold() { return this.extract.uniforms.uThreshold.value; }
    set threshold(v) { this.extract.uniforms.uThreshold.value = v; }

    _draw(renderer, mat, target) {
        this.quad.material = mat;
        renderer.setRenderTarget(target);
        this.quad.render(renderer);
    }

    render(renderer, writeBuffer, readBuffer) {
        const prevAuto = renderer.autoClear;
        renderer.autoClear = false;
        const ex = this.extract.uniforms, bl = this.blur.uniforms;
        // 1) bright pass + downsample to 1/4
        ex.tSrc.value = readBuffer.texture;
        ex.uTexel.value.set(0.5 / readBuffer.width * 2.0, 0.5 / readBuffer.height * 2.0);
        this._draw(renderer, this.extract, this.rtA);
        // 2) 1/8: blur H, V
        const r = this.radius;
        bl.tSrc.value = this.rtA.texture; bl.uDir.value.set(r / this.rtA.width, 0);
        this._draw(renderer, this.blur, this.rtB);
        bl.tSrc.value = this.rtB.texture; bl.uDir.value.set(0, r / this.rtB.height);
        this._draw(renderer, this.blur, this.rtC);
        renderer.autoClear = prevAuto;
    }

    dispose() {
        [this.rtA, this.rtB, this.rtC].forEach(t => t.dispose());
        this.extract.dispose(); this.blur.dispose(); this.quad.dispose();
    }
}
