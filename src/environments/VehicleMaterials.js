import * as THREE from '/node_modules/three/build/three.module.js';
import { Platform } from '../core/Platform.js';

/**
 * Realistic finishes for the low-poly CC0 vehicles (Poly Pizza: flat colours named White, Windows,
 * Black, Grey, Headlights, TailLights... or a small colour atlas). Each part gets a real material:
 *
 *   body paint   clear-coated automotive paint (Physical clearcoat on rich tiers), reflects the
 *                level probe; military hulls are matte
 *   glass        dark tinted, smooth, strongly reflective (reads as glass from any angle)
 *   rubber/black tyres, bumpers, seals: dark, rough
 *   trim/grey    painted metal / plastic trim
 *   lights       lens: smooth, slightly translucent-looking, faint glow on tail lights
 *
 * One shared shader patch adds what sells a real car standing in a war zone, all procedural
 * (no textures, no UVs needed):
 *   - mud / road dirt splashed up the lower body, heavier behind the wheels
 *   - dust settled on upward-facing panels (roof, bonnet)
 *   - chipped paint and scratches showing primer / bare metal
 *   - burnt vehicles: soot, blistered paint and rust instead
 */
const KIND = [
    [/window|glass|windshield/i, 'glass'],
    [/tail|brake/i, 'tail'],
    [/headlight|whitelight|light/i, 'lamp'],
    [/blue/i, 'beacon'],
    [/black|tire|tyre|rubber|wheel/i, 'rubber'],
    [/grey|gray|chrome|metal|trim/i, 'trim']
];
const kindOf = (name) => { for (const [re, k] of KIND) if (re.test(name || '')) return k; return 'paint'; };

const PARS_V = `varying vec3 vVW; varying vec3 vVN; varying float vVH;`;
const MAIN_V = `
    vec4 vvw = modelMatrix * vec4(transformed, 1.0);
    vVW = vvw.xyz;
    vVH = vvw.y - modelMatrix[3].y;                 // height above the vehicle's base
    vVN = normalize(mat3(modelMatrix) * objectNormal);`;
const PARS_F = `
    varying vec3 vVW; varying vec3 vVN; varying float vVH;
    uniform float uMud, uDust, uChip, uBurn, uLivery;
    float vHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float vNoise(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(vHash(i), vHash(i + vec3(1,0,0)), f.x), mix(vHash(i + vec3(0,1,0)), vHash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(vHash(i + vec3(0,0,1)), vHash(i + vec3(1,0,1)), f.x), mix(vHash(i + vec3(0,1,1)), vHash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }`;
const COLOR_F = `
    {
        float n1 = vNoise(vVW * 2.3), n2 = vNoise(vVW * 9.0), n3 = vNoise(vVW * 0.6);
        #ifdef USE_MAP
        { float lm = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(vec3(lm), diffuseColor.rgb, 0.68) * 0.88; }
        #endif
        // ambulance livery: painted (coloured / light) atlas texels go white, a red band runs round the box
        if (uLivery > 0.5) {
            vec3 c0 = diffuseColor.rgb;
            float lum = dot(c0, vec3(0.299, 0.587, 0.114));
            float sat = max(max(c0.r, c0.g), c0.b) - min(min(c0.r, c0.g), c0.b);
            float painted = clamp(smoothstep(0.015, 0.04, sat) + step(0.3, lum), 0.0, 1.0);      // any tinted texel (body browns) or light panel; greys / blacks (trim, tyres, glass) stay
            vec3 body = vec3(0.6, 0.6, 0.58);
            float band = step(0.95, vVH) * (1.0 - step(1.22, vVH));
            body = mix(body, vec3(0.42, 0.03, 0.02), band);
            diffuseColor.rgb = mix(c0, body, painted);
        }
        // road dirt splashed up the lower body (ragged top edge)
        float mudLine = 0.55 + 0.35 * n3 + 0.15 * n1;
        float mud = uMud * (1.0 - smoothstep(mudLine - 0.25, mudLine + 0.1, vVH)) * (0.6 + 0.4 * n2);
        // dust on roof / bonnet
        float dust = uDust * smoothstep(0.55, 0.9, vVN.y) * smoothstep(0.35, 0.75, n1 * 0.7 + n2 * 0.3);
        // paint chips and scratches revealing grey primer / metal
        float chip = uChip * smoothstep(0.78, 0.86, n2 * 0.8 + n1 * 0.2) * step(0.2, vVH);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.19, 0.18), chip);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.12, 0.08), clamp(mud, 0.0, 0.85));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.38, 0.32), clamp(dust, 0.0, 0.7));
        // burnt: soot that is thickest up high, rust blooming through
        float soot = uBurn * (0.55 + 0.45 * smoothstep(0.3, 1.8, vVH)) * (0.7 + 0.3 * n1);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.035, 0.03, 0.028), vec3(0.24, 0.10, 0.04), smoothstep(0.5, 0.8, n3)), clamp(soot, 0.0, 0.95));
        vVehicleRough = clamp(mud * 0.8 + dust * 0.7 + chip * 0.4 + soot, 0.0, 1.0);
    }`;

function patch(m, U) {
    m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, U);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\n' + PARS_V)
            .replace('#include <project_vertex>', '#include <project_vertex>\n' + MAIN_V);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\n' + PARS_F)
            .replace('#include <color_fragment>', '#include <color_fragment>\nfloat vVehicleRough = 0.0;\n' + COLOR_F)
            .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, vVehicleRough);')
            .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - vVehicleRough;');
    };
    m.customProgramCacheKey = () => 'vehicle1';
}

const cache = new Map();

/** Replacement material for one vehicle part. burn 0..1, military = matte paint. */
export function vehicleMaterial(src, { burn = 0, military = false, dirt = 0.5, livery = null } = {}) {
    const kind = kindOf(src.name);
    const key = `${src.uuid}|${kind}|${Math.round(burn * 4)}|${military}|${Math.round(dirt * 4)}|${Platform.rich}|${livery}`;
    if (cache.has(key)) return cache.get(key);
    const base = src.color ? src.color.clone() : new THREE.Color(1, 1, 1);
    const hsl = {}; base.getHSL(hsl);
    const rich = Platform.rich && !military && burn < 0.3;
    let m;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    switch (kind) {
        case 'glass':
            m = std({ color: burn > 0.4 ? 0x050505 : 0x0e1216, roughness: burn > 0.4 ? 0.8 : 0.04, metalness: 0.55, envMapIntensity: 1.4 });
            break;
        case 'rubber':
            m = std({ color: 0x141414, roughness: 0.9, metalness: 0 });
            break;
        case 'trim':
            m = std({ color: base.clone().multiplyScalar(0.8), roughness: 0.45, metalness: 0.55, envMapIntensity: 0.8 });
            break;
        case 'lamp':
            m = std({ color: 0xc9c3b4, roughness: 0.12, metalness: 0.3, envMapIntensity: 1.2 });
            break;
        case 'tail':
            m = std({ color: 0x4a0806, roughness: 0.15, metalness: 0.1, emissive: 0x6a0805, emissiveIntensity: burn > 0.3 ? 0 : 0.25 });
            break;
        case 'beacon':
            m = std({ color: 0x0a1a5a, roughness: 0.15, metalness: 0.1, emissive: 0x1030c0, emissiveIntensity: burn > 0.3 ? 0 : 0.4 });
            break;
        default: {
            // paint: slightly desaturated, never pure white; textured atlases keep their map
            const c = base.clone(); c.setHSL(hsl.h, hsl.s * 0.7, Math.min(hsl.l, 0.5) * (military ? 0.8 : 0.9));
            const o = { color: c, map: src.map || null, roughness: military ? 0.72 : 0.38, metalness: military ? 0.15 : 0.4, envMapIntensity: military ? 0.5 : 1.0 };
            m = rich ? new THREE.MeshPhysicalMaterial({ ...o, clearcoat: 0.9, clearcoatRoughness: 0.12 }) : std(o);
        }
    }
    m.name = src.name;
    if (src.flatShading) m.flatShading = true;          // reduced low-poly models ship without normals
    if (burn > 0 && kind !== 'glass') { m.roughness = Math.min(1, m.roughness + burn * 0.5); m.metalness *= 1 - burn * 0.6; }
    const U = {
        uMud: { value: kind === 'glass' || kind === 'lamp' || kind === 'tail' ? 0.25 : 0.55 + dirt * 0.35 },
        uDust: { value: kind === 'glass' ? 0.35 : 0.5 + dirt * 0.3 },
        uChip: { value: kind === 'paint' ? 0.5 + dirt * 0.4 : 0 },
        uBurn: { value: kind === 'glass' ? burn * 0.6 : burn },
        uLivery: { value: livery === 'ambulance' && kind === 'paint' && burn < 0.5 ? 1 : 0 }
    };
    if (livery === 'ambulance') { U.uMud.value *= 0.5; U.uChip.value *= 0.4; }       // kept cleaner than the wrecks
    patch(m, U);
    m.userData.probe = true;          // reflects the level's one-shot cubemap
    m.userData.vehicle = kind;
    cache.set(key, m);
    return m;
}

export function trimVehicleMaterials(sourceMaterialIds = []) {
    const keep = new Set(sourceMaterialIds);
    for (const [key, material] of cache) {
        if (keep.has(key.split('|')[0])) continue;
        material.dispose();
        cache.delete(key);
    }
}
