import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Baked ambient occlusion, baked shadows and baked firelight for a whole level, in ONE
 * 512x512 RGBA texture computed on the CPU at load (a few ms) and read by every level
 * material with a single texture fetch. No screen-space passes, no extra scene renders.
 *
 *   R  ground-contact AO: how close a ground point is to solid geometry (scaled by its height)
 *   G  sun shadow: every collider's shadow swept along the real sun direction, softened.
 *      Used only beyond the range of the live shadow map, so far away the world still has
 *      shadows and depth for free while near the player the real shadows win.
 *   B  firelight: warm light pool around every fire, flickered by one uniform at runtime
 *
 * On top of that, materials get cheap analytic terms from their own height and normal:
 * wall bases darken toward the ground, downward-facing surfaces take less sky light, and
 * creases picked out by the normal map (via screen-space normal derivatives) get a little
 * cavity darkening. AO multiplies only the *indirect* light and the reflections, as real AO
 * would, with a small share on direct light so contact still reads in sunlight.
 */
const clamp = THREE.MathUtils.clamp;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

function boxBlur(a, N, r, passes = 1) {
    const t = new Float32Array(N * N);
    for (let p = 0; p < passes; p++) {
        for (let j = 0; j < N; j++) {                       // horizontal
            let acc = 0; const row = j * N;
            for (let i = -r; i <= r; i++) acc += a[row + clamp(i, 0, N - 1)];
            for (let i = 0; i < N; i++) {
                t[row + i] = acc / (2 * r + 1);
                acc += a[row + Math.min(N - 1, i + r + 1)] - a[row + Math.max(0, i - r)];
            }
        }
        for (let i = 0; i < N; i++) {                       // vertical
            let acc = 0;
            for (let j = -r; j <= r; j++) acc += t[clamp(j, 0, N - 1) * N + i];
            for (let j = 0; j < N; j++) {
                a[j * N + i] = acc / (2 * r + 1);
                acc += t[Math.min(N - 1, j + r + 1) * N + i] - t[Math.max(0, j - r) * N + i];
            }
        }
    }
}

/**
 * opts: { colliders:Box3[], bounds, sunDir:Vector3, shadow:0..1, ao:0..1.2, fires:[{x,z,size}], glow, wet, size }
 * Returns the shared uniform set that applyBaked() binds into materials.
 */
export function bakeLevelLighting(opts) {
    const t0 = performance.now();
    const { colliders = [], bounds = 90, sunDir = null, shadow = 0.45, ao = 0.8, fires = [], glow = 1, wet = 0, size = 512 } = opts;
    const B = bounds + 14, N = size, cell = (2 * B) / N;
    const A = new Float32Array(N * N).fill(1), S = new Float32Array(N * N).fill(1), G = new Float32Array(N * N);
    const toI = (v) => Math.floor((v + B) / cell);
    const boxes = colliders.filter(b => b.max.y - b.min.y > 0.35 && b.min.y < 3 && (b.max.x - b.min.x) < B * 1.6 && (b.max.z - b.min.z) < B * 1.6);

    // ── ambient occlusion: soft falloff from every solid, wider for taller solids ──
    for (const b of boxes) {
        const h = Math.min(30, b.max.y);
        const r = clamp(0.8 + h * 0.4, 1.1, 6);
        const i0 = Math.max(0, toI(b.min.x - r)), i1 = Math.min(N - 1, toI(b.max.x + r));
        const j0 = Math.max(0, toI(b.min.z - r)), j1 = Math.min(N - 1, toI(b.max.z + r));
        for (let j = j0; j <= j1; j++) {
            const z = -B + (j + 0.5) * cell, dz = Math.max(b.min.z - z, 0, z - b.max.z);
            for (let i = i0; i <= i1; i++) {
                const x = -B + (i + 0.5) * cell, dx = Math.max(b.min.x - x, 0, x - b.max.x);
                const d = Math.hypot(dx, dz);
                const occ = d === 0 ? 1 : Math.pow(1 - smooth(d / r), 1.6);
                const v = 1 - ao * 0.85 * occ;
                const k = j * N + i;
                if (v < A[k]) A[k] = v;
            }
        }
    }
    boxBlur(A, N, 1, 1);

    // ── baked sun shadows: sweep each footprint along the shadow direction ──
    if (sunDir && sunDir.y > 0.05 && shadow > 0.02) {
        const kx = -sunDir.x / sunDir.y, kz = -sunDir.z / sunDir.y;
        const kLen = Math.hypot(kx, kz);
        for (const b of boxes) {
            const h = Math.min(40, b.max.y);
            const steps = clamp(Math.ceil((h * kLen) / (cell * 1.5)), 1, 90);
            const i0 = toI(b.min.x), i1 = toI(b.max.x), j0 = toI(b.min.z), j1 = toI(b.max.z);
            for (let s = 0; s <= steps; s++) {
                const t = s / steps, ox = Math.round((kx * h * t) / cell), oz = Math.round((kz * h * t) / cell);
                const val = 1 - shadow * (1 - 0.4 * t);       // shadow thins toward its tip
                for (let j = Math.max(0, j0 + oz); j <= Math.min(N - 1, j1 + oz); j++) {
                    for (let i = Math.max(0, i0 + ox); i <= Math.min(N - 1, i1 + ox); i++) {
                        const k = j * N + i;
                        if (val < S[k]) S[k] = val;
                    }
                }
            }
        }
        boxBlur(S, N, 2, 2);
    }

    // ── firelight pools ──
    for (const f of fires) {
        const R = 5 + 4 * (f.size || 1), strength = Math.min(1.3, 0.45 + (f.size || 1) * 0.4);
        const i0 = Math.max(0, toI(f.x - R)), i1 = Math.min(N - 1, toI(f.x + R));
        const j0 = Math.max(0, toI(f.z - R)), j1 = Math.min(N - 1, toI(f.z + R));
        for (let j = j0; j <= j1; j++) {
            const z = -B + (j + 0.5) * cell;
            for (let i = i0; i <= i1; i++) {
                const x = -B + (i + 0.5) * cell;
                const d = Math.hypot(x - f.x, z - f.z) / R;
                if (d >= 1) continue;
                const g = Math.pow(1 - smooth(d), 2) * strength;
                const k = j * N + i;
                if (g > G[k]) G[k] = g;
            }
        }
    }

    const data = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) {
        data[k * 4] = Math.round(clamp(A[k], 0, 1) * 255);
        data[k * 4 + 1] = Math.round(clamp(S[k], 0, 1) * 255);
        data[k * 4 + 2] = Math.round(clamp(G[k], 0, 1) * 255);
        data[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;

    return {
        uniforms: {
            uBake: { value: tex },
            uBakeRect: { value: new THREE.Vector3(-B, -B, 2 * B) },
            uBakeCam: { value: new THREE.Vector3() },
            uBakeFade: { value: new THREE.Vector2(40, 60) },
            uBakeGlow: { value: glow },
            uBakeColor: { value: new THREE.Color(1.0, 0.5, 0.2) },
            uBakeFlick: { value: 1 },
            uBakeWet: { value: wet },
            uBakeCav: { value: 2.2 },
            uBakeTime: { value: 0 },
            uBakeCloud: { value: opts.cloud ?? 0 }
        },
        texture: tex,
        bakeMs: performance.now() - t0,
        dispose() { tex.dispose(); }
    };
}

const VERT_COMMON = `
    #include <common>
    varying vec3 vBkPos;
    varying vec3 vBkN;`;
const FRAG_COMMON = `
    #include <common>
    uniform sampler2D uBake;
    uniform vec3 uBakeRect, uBakeCam, uBakeColor;
    uniform vec2 uBakeFade;
    uniform float uBakeGlow, uBakeFlick, uBakeWet, uBakeCav, uBakeTime, uBakeCloud;
    varying vec3 vBkPos;
    varying vec3 vBkN;
    float bkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float bkNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(bkHash(i), bkHash(i + vec2(1.0, 0.0)), f.x), mix(bkHash(i + vec2(0.0, 1.0)), bkHash(i + vec2(1.0, 1.0)), f.x), f.y);
    }`;

/**
 * Bind the baked lighting into a MeshStandard/Physical material. Chains with any existing
 * onBeforeCompile (weathering, terrain splat, ...) instead of replacing it.
 */
export function applyBaked(material, U) {
    if (!material || material.userData.bakedLit) return;
    if (!(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) return;
    if (material.userData.foliage || material.userData.noBake) return;
    material.userData.bakedLit = true;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
        if (prev) prev.call(this, shader, renderer);
        Object.assign(shader.uniforms, U);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', VERT_COMMON)
            .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
                #ifndef FLAT_SHADED
                vBkN = normalize(mat3(modelMatrix) * objectNormal);
                #else
                vBkN = vec3(0.0, 1.0, 0.0);
                #endif`)
            .replace('#include <project_vertex>', `#include <project_vertex>
                vec4 bkp = vec4(transformed, 1.0);
                #ifdef USE_INSTANCING
                bkp = instanceMatrix * bkp;
                #endif
                vBkPos = (modelMatrix * bkp).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', FRAG_COMMON)
            // wet look: patches of lower roughness + darker colour on up-facing ground (levels with config.bake.wet)
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
                if (uBakeWet > 0.0 && vBkN.y > 0.8) {
                    float bkW = bkNoise(vBkPos.xz * 0.11) * 0.6 + bkNoise(vBkPos.xz * 0.55) * 0.4;
                    float bkWet = smoothstep(0.44, 0.72, bkW) * uBakeWet;
                    roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.36, bkWet);
                    diffuseColor.rgb *= mix(1.0, 0.7, bkWet);
                }`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                vec3 bkWN = inverseTransformDirection(normal, viewMatrix);
                vec2 bkUV = (vBkPos.xz - uBakeRect.xy) / uBakeRect.z;
                float bkIn = step(0.0, bkUV.x) * step(bkUV.x, 1.0) * step(0.0, bkUV.y) * step(bkUV.y, 1.0);
                vec4 bkT = texture2D(uBake, bkUV);
                float bkY = vBkPos.y;
                float bkNear = 1.0 - smoothstep(0.6, 3.5, bkY);
                float bkUp = smoothstep(0.55, 0.85, bkWN.y);
                float bkMap = mix(1.0, bkT.r, bkIn);
                float bkWall = mix(0.5, 1.0, smoothstep(0.0, 2.8, bkY));            // height AO: wall bases darken toward the ground
                float bkAO = mix(bkWall, mix(1.0, bkMap, bkNear), bkUp);
                bkAO *= mix(0.7, 1.0, bkWN.y * 0.5 + 0.5);                          // normal AO: undersides see less sky
                float bkCam = distance(vBkPos, uBakeCam);
                bkAO *= 1.0 - clamp(length(fwidth(bkWN)) * uBakeCav, 0.0, 0.4) * (1.0 - smoothstep(8.0, 28.0, bkCam));   // cavity AO from normal-map creases
                float bkSh = mix(1.0, mix(1.0, bkT.g, bkIn), smoothstep(uBakeFade.x, uBakeFade.y, bkCam) * (1.0 - smoothstep(1.2, 7.0, bkY)));
                // slow cloud shadows drifting over the ground (direct light only): the light is never perfectly steady outdoors
                float bkCl = 1.0 - uBakeCloud * smoothstep(0.46, 0.72, bkNoise(vBkPos.xz * 0.017 + vec2(uBakeTime * 0.55, uBakeTime * 0.21)) * 0.7 + bkNoise(vBkPos.xz * 0.05 - vec2(uBakeTime * 0.3, 0.0)) * 0.3);
                bkSh *= bkCl;
                vec3 bkGlow = uBakeColor * (bkT.b * bkIn * uBakeGlow * uBakeFlick * (1.0 - smoothstep(2.0, 14.0, bkY)));
                totalEmissiveRadiance += diffuseColor.rgb * bkGlow * (0.4 + 0.6 * max(bkWN.y, 0.0)) * 1.8;`)
            .replace('#include <aomap_fragment>', `#include <aomap_fragment>
                reflectedLight.indirectDiffuse *= bkAO;
                reflectedLight.indirectSpecular *= mix(1.0, bkAO, 0.85);
                reflectedLight.directDiffuse *= mix(1.0, bkAO, 0.25) * bkSh;
                reflectedLight.directSpecular *= bkSh;`);
    };
    const key = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => '';
    material.customProgramCacheKey = () => key() + '|baked1';
    material.needsUpdate = true;
}
