import * as THREE from '/node_modules/three/build/three.module.js';
import { TextureFactory } from '../utils/TextureFactory.js';
import { groupMatrix } from './Architecture.js';

/**
 * Modular procedural city kit, in the spirit of Blender's Buildify node setup:
 * a building is a footprint extruded into storeys, and every storey is split
 * into window bays that pick from a small set of modules (glass, lit glass,
 * boarded, balcony, shopfront). Everything decorative goes through the shared
 * Deco batcher, so a whole street of apartment blocks is a handful of draw
 * calls. Only the building shell is a real mesh (collision + bullets + AI LOS).
 *
 * Seeded per building (x, z), so a layout always rebuilds identically.
 */

const STOREY = 3.2;
const BAY = 3.1;
const GROUND = 4.0;

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Real CC0 Poly Haven PBR sets (colour + normal + roughness, see public/assets/textures/city).
// [texture id, metres per tile, tint]
const APARTMENT_FACADES = [['red_brick_03', 2.2, 0xffffff], ['painted_plaster_wall', 3, 0xf2ece2], ['grey_plaster_02', 3, 0xffffff],
    ['yellow_plaster', 3, 0xf4efe6], ['red_brick_03', 2.2, 0xe8dcd0]];
const OFFICE_FACADES = [['concrete_tile_facade', 3, 0xffffff], ['rectangular_facade_tiles', 2.6, 0xf2f2f2], ['precast_concrete_wall', 3.2, 0xffffff]];
const FACADE_TINTS = [0xc9bfae, 0xb8a58d, 0xa7a9a6, 0xd2c6b2, 0x9c8d7c, 0xbfb5a8, 0x8f9496];
const AWNING_COLORS = [0x7a2c22, 0x284a5e, 0x3d5a3a, 0x8a6a22, 0x4b3f5c];

/** Box geometry with UVs scaled to world metres, added to the deco batch (so textures keep true scale). */
function tbox(lb, deco, w, h, d, tile, mat, M, pos, rot) {
    const g = lb._box(w, h, d, tile);
    deco.add(g, mat, M, pos, rot);
    g.dispose();
}

/**
 * Screen-space-free "baked" realism for flat building surfaces, added to a normal PBR material:
 * grime and damp darkening toward the ground (fake ambient occlusion where wall meets street),
 * soft vertical rain-streak weathering that breaks up texture tiling, and a gentle sun-bleached
 * top. Works for instanced meshes too, so the scenery LOD batches keep it.
 */
function weather(mat, { grime = 0.5, streak = 0.28 } = {}) {
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vCityPos;')
            .replace('#include <project_vertex>', `#include <project_vertex>
                vec4 cwp = vec4(transformed, 1.0);
                #ifdef USE_INSTANCING
                cwp = instanceMatrix * cwp;
                #endif
                vCityPos = (modelMatrix * cwp).xyz;`);
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                varying vec3 vCityPos;
                float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                float cNoise(vec2 p) {
                    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y);
                }`)
            .replace('#include <color_fragment>', `#include <color_fragment>
                {
                    float hh = vCityPos.y;
                    float base = mix(1.0 - ${grime.toFixed(2)}, 1.0, smoothstep(0.0, 4.5, hh));
                    float run = cNoise(vec2((vCityPos.x + vCityPos.z) * 1.7, hh * 0.07)) * 0.6 + cNoise(vec2((vCityPos.x - vCityPos.z) * 4.1, hh * 0.16)) * 0.4;
                    float streaks = mix(1.0 - ${streak.toFixed(2)}, 1.0, smoothstep(0.25, 0.8, run));
                    float blotch = 0.88 + 0.12 * cNoise(vCityPos.xz * 0.35 + hh * 0.2);
                    float bleach = 1.0 + 0.06 * smoothstep(8.0, 30.0, hh);
                    diffuseColor.rgb *= base * streaks * blotch * bleach;
                }`);
    };
    mat.customProgramCacheKey = () => `cityweather${grime}|${streak}`;
    return mat;
}

function kit(lb) {
    if (lb._cityKit) return lb._cityKit;
    const concrete = lb._photo('concrete_wall_004', () => TextureFactory.concrete(512, 1));
    const ph = (id, fb) => lb._photo(id, fb || (() => concrete));
    const metalTex = lb._photo('metal_plate', () => TextureFactory.metal(256, 1));
    // Window glass mirrors the sunset HDRI (metal reflectance = base colour, so it must NOT be near-black),
    // with a few variants so a facade never reads as a grid of identical black squares.
    const mkGlass = (color, rough, metal, env) => {
        const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: env });
        m.userData.ssrReflective = true;   // keep the glass settings through the level material calibration
        return m;
    };
    const glass = mkGlass(0x8fa6ba, 0.06, 0.95, 1.5);
    const glassDark = mkGlass(0x4a5b6a, 0.1, 0.9, 1.3);
    const glassWarm = new THREE.MeshStandardMaterial({ color: 0x6d5a48, roughness: 0.65, metalness: 0.1, emissive: 0x20140a, emissiveIntensity: 0.6 }); // drawn curtains
    glassWarm.userData.ssrReflective = true;
    const lit = new THREE.MeshStandardMaterial({ color: 0x2a2014, emissive: 0xffb866, emissiveIntensity: 1.25, roughness: 0.4 });
    const litCool = new THREE.MeshStandardMaterial({ color: 0x1a2228, emissive: 0x9fc4ff, emissiveIntensity: 0.9, roughness: 0.4 });
    const shop = new THREE.MeshStandardMaterial({ color: 0x3a4652, emissive: 0xffc890, emissiveIntensity: 0.1, roughness: 0.1, metalness: 0.92, envMapIntensity: 1.25 });
    shop.userData.ssrReflective = true;
    const K = lb._cityKit = {
        concrete, ph,
        trim: weather(lb._pbr(ph('concrete_floor_02'), { color: 0xe4e0d6 }), { grime: 0.35, streak: 0.2 }),
        darkTrim: weather(lb._pbr(ph('precast_concrete_wall'), { color: 0x9a968e }), { grime: 0.5, streak: 0.2 }),
        roof: lb._pbr(ph('concrete_floor_worn_001'), { color: 0xd8d4cc }),
        sidewalk: lb._pbr(ph('concrete_pavers_02'), { color: 0xe8e4dc }),
        curb: lb._pbr(ph('concrete_floor_02'), { color: 0xd0ccc4 }),
        steel: lb._pbr(metalTex, { color: 0xb8bcc0, metalness: 0.7, roughness: 0.5 }),
        rail: lb._pbr(metalTex, { color: 0x3a3d42, metalness: 0.75, roughness: 0.45 }),
        frame: new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.55, metalness: 0.4 }),
        board: lb._photo('wood_planks_grey', () => TextureFactory.wood(256, 1)),
        paint: new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.7 }),
        paintY: new THREE.MeshStandardMaterial({ color: 0xd8a83a, roughness: 0.7 }),
        soot: new THREE.MeshStandardMaterial({ color: 0x141312, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
        glass, glassDark, glassWarm, lit, litCool, shop,
        pipe: lb._pbr(metalTex, { color: 0x4b4f55, metalness: 0.6, roughness: 0.6 }),
        signs: [0xc2362b, 0x2d7a53, 0x2c5f9e, 0xd9a52a, 0xf2efe6].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, emissive: c, emissiveIntensity: 0.12 })),
        awnings: AWNING_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 })),
        facades: new Map()
    };
    K.boardMat = lb._pbr(K.board, { color: 0x8a7a64, roughness: 0.95 });
    lb.disposables.push(glass, glassDark, glassWarm, lit, litCool, shop, K.pipe, ...K.signs, K.frame, K.paint, K.paintY, K.soot, ...K.awnings);
    return K;
}

/** Facade material for a texture id (cached per id + tint). */
function facade(lb, K, [id, , tint]) {
    const key = id + '|' + tint;
    if (!K.facades.has(key)) K.facades.set(key, weather(lb._pbr(K.ph(id), { color: tint })));
    return K.facades.get(key);
}

function facadeMat(lb, K, tint) {
    const key = 'sky|' + tint;
    if (!K.facades.has(key)) K.facades.set(key, lb._pbr(K.ph('precast_concrete_wall'), { color: tint }));
    return K.facades.get(key);
}

/**
 * Multi-storey apartment / office block.
 * item: { x, z, w, d, h, rot?, style?: 'apartment'|'office'|'ruin', shops?: bool, seed? }
 */
export function block(lb, deco, item) {
    const K = kit(lb);
    const { x, z, w, d, rot = 0 } = item;
    const R = rng(item.seed ?? ((x * 73856093) ^ (z * 19349663)));
    const style = item.style || (R() < 0.5 ? 'apartment' : 'office');
    const floors = Math.max(2, Math.round((item.h - GROUND) / STOREY));
    const h = GROUND + floors * STOREY;
    const pool = style === 'office' ? OFFICE_FACADES : APARTMENT_FACADES;
    const fac = item.facade ? (pool.find(f => f[0] === item.facade) || pool[0]) : pool[Math.floor(R() * pool.length)];
    const wallMat = facade(lb, K, fac);

    // Shell: one solid mesh carries collision, bullets and AI line-of-sight.
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rot;
    const shell = new THREE.Mesh(lb._box(w, h, d, fac[1]), wallMat);
    shell.position.y = h / 2;
    lb._shadow(shell);
    group.add(shell);
    lb.group.add(group);
    group.updateMatrixWorld(true);
    lb.raycastables.push(shell);
    lb.colliders.push(new THREE.Box3().setFromObject(shell));
    for (const [cx, cz] of [[-w / 2 - 1.2, 0], [w / 2 + 1.2, 0], [0, -d / 2 - 1.2], [0, d / 2 + 1.2]]) {
        const c = new THREE.Vector3(cx, 0, cz).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot);
        lb.cover.push(new THREE.Vector3(x + c.x, 0, z + c.z));
    }

    const M = groupMatrix(x, 0, z, rot);
    const shops = item.shops ?? (style !== 'office' || R() < 0.6);

    // Ground floor base band + storey belt courses
    tbox(lb, deco, w + 0.24, GROUND, d + 0.24, 3.2, K.darkTrim, M, [0, GROUND / 2, 0]);
    tbox(lb, deco, w + 0.5, 0.28, d + 0.5, 2, K.trim, M, [0, GROUND, 0]);
    tbox(lb, deco, w - 0.2, 0.06, d - 0.2, 4, K.roof, M, [0, h + 0.02, 0]);              // roof membrane
    if (style === 'apartment') {
        for (let f = 2; f < floors; f += 2) deco.box(w + 0.16, 0.14, d + 0.16, K.trim, M, [0, GROUND + f * STOREY, 0]);
    } else {
        // every office floor gets a spandrel slab edge: strong horizontal shadow lines and depth
        for (let f = 1; f < floors; f++) deco.box(w + 0.2, 0.34, d + 0.2, K.darkTrim, M, [0, GROUND + f * STOREY - 0.17, 0]);
    }
    // drainpipes at the corners
    for (const sx of [-1, 1]) deco.add(new THREE.CylinderGeometry(0.07, 0.07, h, 6), K.pipe, M, [sx * (w / 2 + 0.13), h / 2, d / 2 + 0.13]);
    // Cornice + parapet
    for (const s of [-1, 1]) {
        tbox(lb, deco, w + 0.7, 0.35, 0.5, 2, K.trim, M, [0, h + 0.05, s * (d / 2 + 0.1)]);
        tbox(lb, deco, 0.5, 0.35, d + 0.7, 2, K.trim, M, [s * (w / 2 + 0.1), h + 0.05, 0]);
        tbox(lb, deco, w + 0.4, 0.9, 0.25, fac[1], wallMat, M, [0, h + 0.6, s * (d / 2 + 0.1)]);
        tbox(lb, deco, 0.25, 0.9, d + 0.4, fac[1], wallMat, M, [s * (w / 2 + 0.1), h + 0.6, 0]);
    }
    // Corner pilasters on offices give them a vertical rhythm
    if (style === 'office') {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) tbox(lb, deco, 0.6, h - GROUND, 0.6, 2, K.trim, M, [sx * w / 2, GROUND + (h - GROUND) / 2, sz * d / 2]);
    }

    // Facade modules, per face. Face local frame: u along the wall, n outward.
    const faces = [
        { len: w, off: d / 2, ang: 0 },
        { len: w, off: d / 2, ang: Math.PI },
        { len: d, off: w / 2, ang: Math.PI / 2 },
        { len: d, off: w / 2, ang: -Math.PI / 2 }
    ];
    const litChance = item.lit ?? 0.16;
    for (const face of faces) {
        const bays = Math.max(1, Math.floor(face.len / BAY));
        const bw = face.len / bays;
        const ca = Math.cos(face.ang), sa = Math.sin(face.ang);
        // local (u along face, v up, n out) -> group space
        const P = (u, v, n) => [u * ca + (face.off + n) * sa, v, -u * sa + (face.off + n) * ca];
        const rr = [0, face.ang, 0];
        const balconyCol = style === 'apartment' && R() < 0.5 ? Math.floor(R() * bays) : -1;

        for (let b = 0; b < bays; b++) {
            const u = -face.len / 2 + (b + 0.5) * bw;
            // ground floor: shopfront or entrance
            if (shops) {
                deco.box(bw * 0.82, 2.6, 0.1, K.shop, M, P(u, 1.7, 0.08), rr);
                deco.box(bw * 0.9, 0.18, 0.3, K.rail, M, P(u, 3.05, 0.14), rr);
                for (const sx of [-0.5, 0.5]) deco.box(0.08, 2.7, 0.16, K.rail, M, P(u + sx * bw * 0.82, 1.7, 0.1), rr);   // shopfront mullions
                deco.box(bw * 0.82, 0.08, 0.16, K.rail, M, P(u, 0.35, 0.1), rr);
                if (R() < 0.35) deco.box(bw * 0.7, 0.5, 0.1, K.signs[Math.floor(R() * K.signs.length)], M, P(u, 3.55, 0.12), rr);   // shop sign
                if (R() < 0.45) {
                    const aw = K.awnings[Math.floor(R() * K.awnings.length)];
                    deco.box(bw * 0.92, 0.08, 1.3, aw, M, P(u, 3.35, 0.7), rr);
                }
                if (R() < 0.2) deco.box(bw * 0.84, 2.7, 0.06, K.boardMat, M, P(u, 1.65, 0.16), rr);   // shuttered shop
            } else {
                deco.box(bw * 0.5, 1.5, 0.1, K.glass, M, P(u, 2.2, 0.08), rr);
            }
            // upper storeys
            for (let f = 0; f < floors; f++) {
                const v = GROUND + f * STOREY + STOREY * 0.52;
                const roll = R();
                const ww = style === 'office' ? bw * 0.8 : Math.min(1.5, bw * 0.5);
                const wh = style === 'office' ? STOREY * 0.62 : 1.55;
                let mat = K.glass;
                if (roll < litChance) mat = R() < 0.8 ? K.lit : K.litCool;
                else if (roll < litChance + 0.14) mat = K.glassWarm;           // curtains drawn
                else if (roll < litChance + 0.3) mat = K.glassDark;            // dark interior
                else if (roll > 0.97 && style !== 'office') mat = K.boardMat;  // boarded up
                deco.box(ww, wh, 0.08, mat, M, P(u, v, 0.02), rr);
                if (style === 'apartment' && R() < 0.12) deco.box(0.7, 0.5, 0.45, K.steel, M, P(u + 0.3, v - wh / 2 - 0.35, 0.3), rr);   // window AC unit
                if (style === 'office') {
                    for (const sx of [-1, 1]) deco.box(0.1, wh + 0.1, 0.14, K.frame, M, P(u + sx * (ww / 2 + 0.05), v, 0.06), rr);
                    deco.box(ww + 0.2, 0.1, 0.14, K.frame, M, P(u, v + wh / 2 + 0.05, 0.06), rr);
                    deco.box(ww + 0.2, 0.1, 0.14, K.frame, M, P(u, v - wh / 2 - 0.05, 0.06), rr);
                }
                if (style === 'apartment') {
                    for (const sx of [-1, 1]) deco.box(0.1, wh + 0.04, 0.2, K.frame, M, P(u + sx * (ww / 2 + 0.05), v, 0.09), rr);   // deep jambs: glass reads recessed
                    deco.box(0.05, wh, 0.1, K.frame, M, P(u, v, 0.07), rr);                                                   // mullion
                    deco.box(ww + 0.3, 0.12, 0.28, K.trim, M, P(u, v - wh / 2 - 0.06, 0.12), rr);   // sill
                    deco.box(ww + 0.2, 0.16, 0.14, K.trim, M, P(u, v + wh / 2 + 0.08, 0.06), rr);  // lintel
                    if (b === balconyCol && f % 1 === 0) {
                        deco.box(bw * 0.86, 0.16, 1.1, K.trim, M, P(u, v - wh / 2 - 0.2, 0.55), rr);
                        deco.box(bw * 0.86, 0.9, 0.05, K.rail, M, P(u, v - wh / 2 + 0.3, 1.08), rr);
                    }
                } else {
                    deco.box(0.12, wh + 0.2, 0.2, K.steel, M, P(u - ww / 2 - 0.06, v, 0.08), rr);       // mullion
                }
            }
        }
        // soot streaks / war damage on some faces
        if (R() < 0.35) {
            const u = (R() - 0.5) * face.len * 0.6;
            deco.box(1.4 + R() * 1.6, 2 + R() * 3, 0.02, K.soot, M, P(u, GROUND + R() * (h - GROUND - 4) + 2, 0.13), rr);
        }
    }

    // Rooftop clutter: AC units, water tank, antenna, stair housing
    const nAC = 1 + Math.floor(R() * 3);
    for (let i = 0; i < nAC; i++) {
        deco.box(1.4, 0.9, 1.0, K.steel, M, [(R() - 0.5) * (w - 3), h + 0.45, (R() - 0.5) * (d - 3)]);
    }
    deco.box(2.6, 2.4, 2.6, K.trim, M, [w * 0.22, h + 1.2, -d * 0.2]);
    if (R() < 0.6) {
        deco.add(new THREE.CylinderGeometry(1.0, 1.0, 1.8, 12), K.steel, M, [-w * 0.25, h + 1.9, d * 0.2]);
        for (const [ox, oz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) deco.box(0.1, 1, 0.1, K.rail, M, [-w * 0.25 + ox, h + 0.5, d * 0.2 + oz]);
    }
    if (R() < 0.4) deco.box(0.08, 5, 0.08, K.rail, M, [-w * 0.3, h + 2.5, -d * 0.3]);
}

/**
 * Street dressing: sidewalks with curbs around every block, lane markings,
 * crosswalks at intersections. cfg: { blocks: [...layout items], lanes: [{x1,z1,x2,z2}], crossings: [{x,z,rot}] }
 */
export function streets(lb, deco, cfg, layout) {
    const K = kit(lb);
    const walk = cfg.sidewalk ?? 2.6;
    for (const it of layout) {
        if (it.type !== 'block' && it.type !== 'building') continue;
        const M = groupMatrix(it.x, 0, it.z, it.rot || 0);
        const W = it.w + walk * 2, D = it.d + walk * 2;
        tbox(lb, deco, W, 0.12, D, 2.4, K.sidewalk, M, [0, 0.06, 0]);
        for (const s of [-1, 1]) {
            tbox(lb, deco, W + 0.3, 0.16, 0.3, 1.5, K.curb, M, [0, 0.08, s * (D / 2)]);
            tbox(lb, deco, 0.3, 0.16, D + 0.3, 1.5, K.curb, M, [s * (W / 2), 0.08, 0]);
        }
    }
    for (const l of cfg.lanes || []) {
        const dx = l.x2 - l.x1, dz = l.z2 - l.z1, len = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
        const n = Math.floor(len / 6);
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            const M = groupMatrix(l.x1 + dx * t, 0, l.z1 + dz * t, yaw);
            deco.box(0.18, 0.02, 3, l.yellow ? K.paintY : K.paint, M, [0, 0.025, 0]);
        }
    }
    for (const c of cfg.crossings || []) {
        const M = groupMatrix(c.x, 0, c.z, c.rot || 0);
        for (let i = -4; i <= 4; i++) deco.box(0.7, 0.02, 3.2, K.paint, M, [i * 1.3, 0.025, 0]);
    }
}

/**
 * Distant skyline outside the playable area: tall, cheap silhouettes with a
 * scatter of lit windows so the city reads as a city at dusk.
 */
export function skyline(lb, deco, cfg) {
    const K = kit(lb);
    const R = rng(cfg.seed ?? 77);
    const ring = cfg.radius ?? 120, count = cfg.count ?? 40;
    for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + R() * 0.08;
        const r = ring + R() * 40;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const w = 12 + R() * 18, d = 12 + R() * 18, h = 24 + R() * (cfg.maxHeight ?? 60);
        const M = groupMatrix(x, 0, z, Math.PI / 2 - a);   // local -z faces the arena
        const mat = facadeMat(lb, K, FACADE_TINTS[i % FACADE_TINTS.length]);
        // stepped silhouette: wide podium + slimmer tower (+ a crown on some)
        const tiers = [[w, d, h * 0.45], [w * 0.72, d * 0.72, h]];
        if (R() < 0.35) tiers.push([w * 0.4, d * 0.4, h * 1.15]);
        let y0 = 0;
        tiers.forEach(([tw, td, th], ti) => {
            tbox(lb, deco, tw, th - y0, td, 4, mat, M, [0, y0 + (th - y0) / 2, 0]);
            // window grid facing the arena: a dark glass band per floor, some floors lit
            const fl = Math.floor((th - y0) / 3.4);
            for (let f = 1; f < fl; f++) {
                const roll = R();
                const m2 = roll < 0.22 ? K.lit : roll < 0.3 ? K.litCool : roll < 0.45 ? K.glassWarm : K.glass;
                deco.box(tw * 0.9, 1.5, 0.12, m2, M, [0, y0 + f * 3.4, -td / 2 - 0.07]);
            }
            deco.box(tw + 0.6, 0.6, td + 0.6, K.darkTrim, M, [0, th + 0.1, 0]);
            y0 = th;
        });
        if (R() < 0.3) deco.box(0.3, 9, 0.3, K.rail, M, [0, y0 + 4.5, 0]);
    }
}
