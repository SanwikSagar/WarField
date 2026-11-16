import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Realistic finishes for the weapon models. The source GLBs only carry flat colours
 * (metalness 0.5 / roughness 0.5 on everything), which reads as grey plastic and turns
 * white when it reflects the sky. Each source material is mapped by name to a real finish:
 *
 *   h-190 / receiver  hard-anodised / Cerakote black aluminium: satin, slightly metallic
 *   h-267             flat-dark-earth Cerakote
 *   stell / steel     parkerised (phosphated) steel: dark grey, matte metal
 *   polymer / resin   glass-filled nylon furniture: near-black, rough, fine stipple
 *   brass / copper    cartridge metal
 *
 * On top, one shared shader patch (object-space, no UVs needed) adds what makes real guns
 * read as real at arm's length:
 *   - fine grain: roughness and albedo vary over a few millimetres (stipple, bead-blast)
 *   - micro bump from the same noise (lights break up across flat faces)
 *   - edge wear: sharp edges (found from the screen-space change of the geometric normal)
 *     are rubbed through to bare, brighter, shinier metal on coated parts and scuffed on polymer
 *   - handling grime: a faint darker, smoother film low on the furniture
 * Everything is computed from uniforms and the model position: no textures, one program per finish.
 */
const FINISH = {
    anodized: { color: 0x0b0b0c, metalness: 0.22, roughness: 0.58, grain: 0.084, wear: 0.6, wearColor: 0x6d6f73, wearMetal: 0.95, wearRough: 0.28, bump: 0.25, env: 0.55 },
    fde: { color: 0x3f3426, metalness: 0.04, roughness: 0.74, grain: 0.072, wear: 0.5, wearColor: 0x6a6c70, wearMetal: 0.9, wearRough: 0.3, bump: 0.25, env: 0.45 },
    steel: { color: 0x1d1e20, metalness: 0.78, roughness: 0.44, grain: 0.108, wear: 0.5, wearColor: 0x8d9095, wearMetal: 1.0, wearRough: 0.22, bump: 0.3, env: 0.6 },
    polymer: { color: 0x121213, metalness: 0.0, roughness: 0.78, grain: 0.120, wear: 0.35, wearColor: 0x2c2c2d, wearMetal: 0.0, wearRough: 0.55, bump: 0.28, env: 0.35 },
    brass: { color: 0xb08a3c, metalness: 1.0, roughness: 0.33, grain: 0.060, wear: 0.0, wearColor: 0xb08a3c, wearMetal: 1, wearRough: 0.3, bump: 0.1, env: 0.8 },
    copper: { color: 0xa0552e, metalness: 1.0, roughness: 0.36, grain: 0.060, wear: 0.0, wearColor: 0xa0552e, wearMetal: 1, wearRough: 0.3, bump: 0.1, env: 0.8 }
};

function finishFor(name) {
    const n = (name || '').toLowerCase();
    if (/glass|lens|reticle|emission|tritium|polycarbonate/.test(n)) return null;   // optics / glow parts keep theirs
    if (/h-267/.test(n)) return 'fde';
    if (/h-190|anod|cerakote|alum/.test(n)) return 'anodized';
    if (/stell|steel|iron|spring|pin/.test(n)) return 'steel';
    if (/polymer|resin|rubber|plastic|nylon/.test(n)) return 'polymer';
    if (/brass/.test(n)) return 'brass';
    if (/copper/.test(n)) return 'copper';
    return 'anodized';
}

const PARS_V = /* glsl */`
    varying vec3 vGunPos;
    varying vec3 vGunN;`;
const MAIN_V = /* glsl */`
    vGunPos = position;
    vGunN = normalize(normal);`;
const PARS_F = /* glsl */`
    uniform vec3 uWearColor;
    uniform float uGrain, uWear, uWearMetal, uWearRough, uBump, uScale;
    varying vec3 vGunPos;
    varying vec3 vGunN;
    float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float gNoise(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(gHash(i), gHash(i + vec3(1,0,0)), f.x), mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x), mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }`;

function patchShader(shader, U) {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>' + PARS_V)
        .replace('#include <begin_vertex>', '#include <begin_vertex>' + MAIN_V);
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>' + PARS_F)
        // grain + wear mask, computed once and reused below
        .replace('#include <map_fragment>', `#include <map_fragment>
            vec3 gP = vGunPos * uScale;                                                // centimetres
            // ~4 mm grain, faded out once a cell gets smaller than a pixel (no sparkle / aliasing)
            float gAA = 1.0 - smoothstep(0.25, 0.8, length(fwidth(gP * 2.5)));
            float gFine = mix(0.5, gNoise(gP * 2.5) * 0.65 + gNoise(gP * 6.0) * 0.35, gAA);
            float gBlot = gNoise(gP * 0.12);                                           // finish variation over ~8 cm
            // screen-space change of the geometric normal = how sharp this edge is; worn only in patches
            float gEdge = clamp(length(fwidth(vGunN)) * 1.4 - 0.45, 0.0, 1.0);
            float gWear = uWear * smoothstep(0.4, 0.9, gEdge) * smoothstep(0.45, 0.75, gNoise(gP * 0.8));
            diffuseColor.rgb *= 1.0 + (gFine - 0.5) * uGrain + (gBlot - 0.5) * 0.12;
            diffuseColor.rgb = mix(diffuseColor.rgb, uWearColor, gWear);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
            roughnessFactor = clamp(roughnessFactor + (gFine - 0.5) * uGrain * 1.4 + (gBlot - 0.5) * 0.1, 0.05, 1.0);
            roughnessFactor = mix(roughnessFactor, uWearRough, gWear);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
            metalnessFactor = mix(metalnessFactor, uWearMetal, gWear);`)
        // micro bump from the grain: perturb the shading normal by the noise gradient (screen-space derivatives)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            {
                float gH = gFine * uBump * 0.0012;      // sub-millimetre relief
                vec3 gdx = dFdx(-vViewPosition), gdy = dFdy(-vViewPosition);
                vec3 gr1 = cross(gdy, normal), gr2 = cross(normal, gdx);
                float gDet = dot(gdx, gr1);
                vec3 gGrad = sign(gDet) * (dFdx(gH) * gr1 + dFdy(gH) * gr2);
                normal = normalize(abs(gDet) * normal - gGrad);
            }`);
}

const cache = new Map();   // one material per (source material, finish): shared by every instance

/** Realistic replacement for a weapon source material (same name, so name-based tweaks still apply). */
export function gunMaterial(src) {
    const key = finishFor(src.name);
    if (!key) {
        const m = src.clone();
        return m;
    }
    const F = FINISH[key];
    const m = new THREE.MeshStandardMaterial({
        name: src.name, color: F.color, metalness: F.metalness, roughness: F.roughness,
        envMapIntensity: F.env, side: src.side
    });
    if (src.map) m.map = src.map;
    const U = {
        uWearColor: { value: new THREE.Color(F.wearColor) }, uGrain: { value: F.grain }, uWear: { value: F.wear },
        uWearMetal: { value: F.wearMetal }, uWearRough: { value: F.wearRough }, uBump: { value: F.bump },
        uScale: { value: 10.0 }      // model units are 10 cm: x10 -> centimetres
    };
    m.onBeforeCompile = (shader) => patchShader(shader, U);
    m.customProgramCacheKey = () => 'gunfinish2';
    m.userData.gunFinish = key;
    return m;
}

export function gunMaterialShared(src) {
    let m = cache.get(src);
    if (!m) { m = gunMaterial(src); cache.set(src, m); }
    return m;
}
