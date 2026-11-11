import * as THREE from 'three';
import { bakeImpostor } from './Impostors.js';
import { makePathFoliageMap } from './PathFoliage.js';

/**
 * Dense, fully GPU-driven ground foliage that FOLLOWS THE GROUND TEXTURE.
 *
 * A fixed pool of instances per layer (one draw call each) is scattered in
 * the vertex shader: world position = camera + wrap(seed - camera/area), so
 * the field is world-anchored, endless and costs zero CPU per frame.
 *
 * The vertex shader samples the same noise mask the terrain material uses to
 * blend dirt and grass, so each layer grows only where it belongs:
 *   grass   -> on the green patches (thins out toward bare soil)
 *   ferns   -> green patches and their edges
 *   cover   -> low broad-leaf plants in the lushest spots
 *   litter  -> dead leaves / twigs lying on the bare dirt
 */
function tuftGeometry({ blades, width, hMin, hMax, lean, spread, seedBase, flat = false, broad = false, rows = 3 }) {
    let s = seedBase >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const pos = [], col = [], nor = [], idx = [];
    for (let b = 0; b < blades; b++) {
        const yaw = rnd() * Math.PI * 2, c = Math.cos(yaw), sn = Math.sin(yaw);
        const rr = Math.sqrt(rnd()) * spread, ang = rnd() * Math.PI * 2;
        const ox = Math.cos(ang) * rr, oz = Math.sin(ang) * rr;
        const P = (lx, ly, lz) => [ox + lx * c - lz * sn, ly, oz + lx * sn + lz * c];
        const base = pos.length / 3;
        if (flat) {
            // a small leaf lying on the ground (slightly curled)
            const l = hMin + rnd() * (hMax - hMin), w = width * (0.7 + rnd() * 0.6);
            const y = 0.012 + rnd() * 0.02, g = 0.55 + rnd() * 0.45, tilt = (rnd() - 0.5) * 0.05;
            [[-w, y, -l], [w, y + tilt, -l], [-w, y + tilt, l], [w, y, l]].forEach(q => {
                pos.push(...P(q[0], q[1], q[2])); col.push(g, g, g); nor.push(0, 1, 0);
            });
            idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
            continue;
        }
        const h = hMin + rnd() * (hMax - hMin);
        const w = width * (0.8 + rnd() * 0.5);
        const ln = lean * (0.5 + rnd());
        const widths = broad ? [0.22, 1, 0.65] : [1, 0.78, 0.38];
        for (let row = 0; row < rows; row++) {
            const t = row * 0.7 / (rows - 1);
            const shade = 0.48 + t * 0.65;
            const normal = new THREE.Vector3(-sn * 0.35, 0.8, c * 0.35 - ln / h * t).normalize();
            for (const side of [-1, 1]) {
                pos.push(...P(side * w * widths[row], h * t, ln * t * t));
                col.push(shade * (side < 0 ? 0.92 : 1), shade, shade * 0.92);
                nor.push(normal.x, normal.y, normal.z);
            }
            if (row < rows - 1) {
                const start = base + row * 2;
                idx.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
            }
        }
        pos.push(...P(0, h, ln)); col.push(0.95, 1, 0.88); nor.push(0, 1, 0);
        idx.push(base + rows * 2 - 2, base + rows * 2 - 1, base + rows * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
}

function makeMaterial(shared, p) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
        map: p.map ?? null, alphaTest: p.map ? 0.35 : 0, alphaToCoverage: !!p.map,
        emissive: 0x07130f, emissiveIntensity: 0.02 });
    mat.userData.grassTier = p.map ? (p.directional ? 'multi-view' : 'billboard') : 'geometry';
    mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, shared, {
            uColA: { value: new THREE.Color(p.colA) },
            uColB: { value: new THREE.Color(p.colB) },
            uScale: { value: p.scale },
            uArea: { value: p.area },
            uMaxDist: { value: p.maxDist },
            uMinDist: { value: p.minDist ?? 0 },
            uWindAmp: { value: p.wind },
            uDen: { value: new THREE.Vector2(p.den[0], p.den[1]) },
            uMaskInv: { value: p.inv ? 1 : 0 }
        });
        shader.vertexShader = `
            uniform vec3 uCam; uniform float uTime, uScale, uArea, uMaxDist, uMinDist, uBound, uWindAmp, uGroundSize, uMaskInv;
            uniform vec3 uColA, uColB; uniform vec4 uMaskP; uniform vec2 uMaskT, uDen;
            uniform sampler2D uMask, uHF, uExclusion, uPathFlow; uniform float uHFSize, uHFN, uPathShift;
            vec2 grassAnchor(vec3 seed) {
                vec2 point = uCam.xz + (fract(seed.xz - uCam.xz / uArea) - 0.5) * uArea;
                vec4 path = texture2D(uPathFlow, point / (uBound * 2.0) + 0.5);
                if (uMaskInv < 0.5 && seed.y < 0.5 && path.b > 0.5) {
                    point += (path.rg * 255.0 - 128.0) * (uPathShift / 127.0);
                }
                return point;
            }
            float hfAt(vec2 p) {
                vec2 f = clamp((p / uHFSize + 0.5) * (uHFN - 1.0), 0.0, uHFN - 1.001);
                vec2 i = floor(f), t = f - i;
                float a = texture2D(uHF, (i + 0.5) / uHFN).r, b = texture2D(uHF, (i + vec2(1.0, 0.0) + 0.5) / uHFN).r;
                float c = texture2D(uHF, (i + vec2(0.0, 1.0) + 0.5) / uHFN).r, d = texture2D(uHF, (i + 1.5) / uHFN).r;
                return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
            }
            float ghash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
            vec2 gwp; float gfade; float gh1; float gh2;
        ` + shader.vertexShader
            .replace('#include <color_vertex>', `#include <color_vertex>
                vec3 gseed = instanceMatrix[3].xyz;
                gwp = grassAnchor(gseed);
                float gd = length(gwp - uCam.xz);
                gh1 = ghash(gseed * 91.7); gh2 = ghash(gseed.zxy * 37.3 + 5.1);
                gfade = 1.0 - smoothstep(uMaxDist * 0.72, uMaxDist, gd);
                if (uMinDist > 0.0) gfade *= smoothstep(uMinDist, uMinDist * 1.45, gd);
                float gm = max(abs(gwp.x), abs(gwp.y));
                gfade *= 1.0 - smoothstep(uBound - 14.0, uBound - 5.0, gm);
                gfade *= texture2D(uExclusion, gwp / (uBound * 2.0) + 0.5).r;
                // ground-texture driven density (same mask as the terrain shader)
                vec2 guv = vec2(gwp.x, -gwp.y) / uGroundSize + 0.5;
                float gmv = texture2D(uMask, guv * uMaskP.x).r * (1.0 - uMaskP.z)
                          + texture2D(uMask, guv * uMaskP.y + 0.3).g * uMaskP.z;
                float ggrass = smoothstep(uMaskT.x, uMaskT.y, gmv);
                float gden = mix(ggrass, 1.0 - ggrass, uMaskInv);
                float verge = texture2D(uPathFlow, gwp / (uBound * 2.0) + 0.5).a;
                gden = clamp(gden + verge * 0.32 * (1.0 - uMaskInv), 0.0, 1.0);
                gfade *= smoothstep(uDen.x, uDen.y, gden + (gh2 - 0.5) * 0.3);
                float gpatch = 0.5 + 0.5 * sin(gwp.x * 0.09 + 1.3) * sin(gwp.y * 0.11 + 0.4)
                             + 0.25 * sin(gwp.x * 0.31 + gwp.y * 0.27);
                vec3 gtint = mix(uColA, uColB, clamp(gpatch * 0.55 + (gh1 - 0.5) * 0.6 + (1.0 - gden) * 0.45, 0.0, 1.0));
                vColor.rgb *= gtint * vec3(0.5, 0.64, 0.4) * (0.24 + 0.1 * gh2);
            `)
            .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
                float normalYaw = ghash(instanceMatrix[3].zxy * 37.3 + 5.1) * 6.2832;
                float normalCos = cos(normalYaw), normalSin = sin(normalYaw);
                objectNormal.xz = vec2(objectNormal.x * normalCos - objectNormal.z * normalSin,
                                       objectNormal.x * normalSin + objectNormal.z * normalCos);
            `)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
                float gsc = gfade * uScale * (0.7 + 0.65 * gh1);
                vec3 gp = transformed;
                float gc = cos(gh2 * 6.2832), gs = sin(gh2 * 6.2832);
                gp.xz = vec2(gp.x * gc - gp.z * gs, gp.x * gs + gp.z * gc);
                gp.xz *= 0.85 + gh2 * 0.55;
                gp *= gsc;
                float gbend = gp.y * gp.y / max(uScale, 0.1);
                float gust = 0.65 + 0.35 * sin(uTime * 0.6 - gwp.x * 0.08 - gwp.y * 0.06);
                float gw = sin(uTime * 1.7 + gwp.x * 0.35 + gwp.y * 0.27 + gh1) * 0.16 * gust
                         + 0.045 * sin(uTime * (3.2 + gh2) + gh1 * 6.2832 + position.y * 4.0);
                gp.x += gbend * gw * uWindAmp;
                gp.z += gbend * gw * uWindAmp * 0.5;
                float groundHeight = gfade > 0.001 ? hfAt(gwp) - 0.02 : -100.0;
                transformed = vec3(gwp.x, groundHeight, gwp.y) + gp - gseed;
            `);
        if (p.map) {
            shader.vertexShader = shader.vertexShader
                .replace('#include <uv_vertex>', `#include <uv_vertex>
                    vec2 grassCenter = grassAnchor(instanceMatrix[3].xyz);
                    vec2 grassFacing = normalize(uCam.xz - grassCenter + vec2(0.00001));
                    float grassYaw = atan(grassFacing.x, grassFacing.y);
                    float grassFrame = mod(floor(grassYaw * 8.0 / 6.2831853 + 0.5), 8.0);
                    vMapUv.x = (vMapUv.x + grassFrame) / 8.0;
                `)
                .replace('float gc = cos(gh2 * 6.2832), gs = sin(gh2 * 6.2832);',
                    'float gc = grassFacing.y, gs = -grassFacing.x;');
        }
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
            'vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;');
    };
    mat.customProgramCacheKey = () => `grassField6-${!!p.map}-${!!p.directional}`;
    return mat;
}

/**
 * ctx: { group, bounds, detail, rand, groundMask } ; v: vegetation config
 * Returns { update(cam, dir), dispose() }
 */
export function buildGrassField(ctx, v, circles) {
    if (!v || !v.field) return null;
    const { group, bounds, detail, rand, groundMask: gm } = ctx;
    const f = v.field;
    const mul = (detail.fieldMul ?? 1) * (detail.groundDensity ?? 1);
    const exclusionSize = 256;
    const exclusionData = new Uint8Array(exclusionSize * exclusionSize);
    const segs = ctx.pathSegs || [];
    const pathFlow = makePathFoliageMap(bounds, segs);
    for (let iz = 0; iz < exclusionSize; iz++) for (let ix = 0; ix < exclusionSize; ix++) {
        const x = ((ix + 0.5) / exclusionSize - 0.5) * bounds * 2;
        const z = ((iz + 0.5) / exclusionSize - 0.5) * bounds * 2;
        let allowed = 1;
        for (const [cx, cz, radius] of circles) {
            allowed *= THREE.MathUtils.smoothstep(Math.hypot(x - cx, z - cz), radius * 0.85, radius);
            if (allowed === 0) break;
        }
        if (allowed > 0) for (const seg of segs) {
            const dx = seg.x2 - seg.x1, dz = seg.z2 - seg.z1;
            const along = THREE.MathUtils.clamp(((x - seg.x1) * dx + (z - seg.z1) * dz) / Math.max(dx * dx + dz * dz, 0.0001), 0, 1);
            const distance = Math.hypot(x - seg.x1 - along * dx, z - seg.z1 - along * dz);
            allowed *= THREE.MathUtils.smoothstep(seg.hw - 0.35, seg.hw + 0.85, distance);
            if (allowed === 0) break;
        }
        exclusionData[iz * exclusionSize + ix] = Math.round(allowed * 255);
    }
    const exclusion = new THREE.DataTexture(exclusionData, exclusionSize, exclusionSize, THREE.RedFormat);
    exclusion.minFilter = exclusion.magFilter = THREE.LinearFilter;
    exclusion.needsUpdate = true;
    const shared = {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBound: { value: bounds },
        uExclusion: { value: exclusion },
        uPathFlow: { value: pathFlow.texture },
        uPathShift: { value: pathFlow.maxShift },
        uMask: { value: gm.texture },
        uHF: { value: ctx.hf.texture },
        uHFSize: { value: ctx.hf.size },
        uHFN: { value: ctx.hf.N },
        uGroundSize: { value: gm.size },
        uMaskP: { value: new THREE.Vector4(gm.s1, gm.s2, gm.w2, 0) },
        uMaskT: { value: new THREE.Vector2(gm.lo, gm.hi) }
    };
    const layers = [], owned = [exclusion, pathFlow.texture];
    const mk = (count, geo, mat, ownsGeometry = true) => {
        owned.push(mat);
        if (ownsGeometry) owned.push(geo);
        if (count < 1) return;
        const mesh = new THREE.InstancedMesh(geo, mat, count);
        const m = new THREE.Matrix4();
        for (let i = 0; i < count; i++) {
            m.makeTranslation(rand(), (i % 2 + rand()) * 0.5, rand());
            mesh.setMatrixAt(i, m);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = mat.userData.grassTier === 'geometry';
        mesh.userData.environmentManaged = true;
        group.add(mesh);
        layers.push(mesh);
    };

    const area = (detail.fieldArea ?? 44);
    mk(Math.round((f.count ?? 12000) * mul),
        tuftGeometry({ blades: 5, width: 0.024, hMin: 0.06, hMax: 0.18, lean: 0.11, spread: 0.16, seedBase: 7 }),
        makeMaterial(shared, { colA: f.colA ?? 0x6f9a3a, colB: f.colB ?? 0xa7a44a, scale: 0.9, area, maxDist: area * 0.5, wind: 1.0, den: [0.22, 0.52] }));
    const distantGeometry = tuftGeometry({ blades: 6, width: 0.035, hMin: 0.25, hMax: 0.6, lean: 0.22, spread: 0.22, seedBase: 101 });
    const distantMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, color: f.colA ?? 0x6f9a3a });
    const grassImpostor = bakeImpostor(detail.renderer, [{ geometry: distantGeometry, material: distantMaterial }]);
    const distantCount = Math.round((f.distant ?? (f.count ?? 12000) * 1.1) * mul);
    if (grassImpostor) {
        owned.push(grassImpostor);
        const cardGeometry = grassImpostor.medium[0].geometry;
        cardGeometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(cardGeometry.attributes.position.count * 3).fill(1), 3));
        // impostor cards are single quads, so they can carry the meadow well past the blade field
        const farRange = Math.max(Math.min(detail.grassDist ?? 85, area * 1.3), area * 1.75);
        const cardParams = { colA: 0xffffff, colB: 0xc9cfa8, scale: 1.0, area: farRange * 2,
            wind: 0.8, den: [0.18, 0.5], map: grassImpostor.medium[0].material.map };
        mk(Math.round(distantCount * 0.65), grassImpostor.medium[0].geometry,
            makeMaterial(shared, { ...cardParams, directional: true, minDist: area * 0.28, maxDist: farRange * 0.75 }), false);
        mk(Math.round(distantCount * 0.35), grassImpostor.far[0].geometry,
            makeMaterial(shared, { ...cardParams, minDist: farRange * 0.5, maxDist: farRange }), false);
        distantGeometry.dispose(); distantMaterial.dispose();
    } else {
        distantMaterial.dispose();
        mk(distantCount, distantGeometry, makeMaterial(shared, { colA: f.colA ?? 0x6f9a3a, colB: f.colB ?? 0xa7a44a,
            scale: 1.0, area: area * 1.8, minDist: area * 0.28, maxDist: area * 0.86, wind: 0.8, den: [0.18, 0.5] }));
    }
    if (f.ferns) mk(Math.round(f.ferns * mul * 0.85),
        tuftGeometry({ blades: 5, width: 0.055, hMin: 0.105, hMax: 0.27, lean: 0.23, spread: 0.12, seedBase: 19, broad: true }),
        makeMaterial(shared, { colA: f.fernA ?? 0x4a7a32, colB: f.fernB ?? 0x7d8f3c, scale: 1.0, area: area * 0.9, maxDist: area * 0.42, wind: 0.6, den: [0.15, 0.45] }));
    if (f.cover) mk(Math.round(f.cover * mul * 0.7),
        tuftGeometry({ blades: 5, width: 0.095, hMin: 0.026, hMax: 0.082, lean: 0.14, spread: 0.12, seedBase: 43, broad: true }),
        makeMaterial(shared, { colA: f.coverA ?? 0x3c5c2c, colB: f.coverB ?? 0x62783a, scale: 1.0, area: area * 0.7, maxDist: area * 0.33, wind: 0.25, den: [0.5, 0.8] }));
    if (f.litter) mk(Math.round(f.litter * mul * 0.85),
        tuftGeometry({ blades: 4, width: 0.035, hMin: 0.04, hMax: 0.085, lean: 0, spread: 0.3, seedBase: 71, flat: true }),
        makeMaterial(shared, { colA: f.litterA ?? 0x6a4a2a, colB: f.litterB ?? 0xa07a3c, scale: 1.3, area: area * 0.7, maxDist: area * 0.33, wind: 0, den: [0.4, 0.7], inv: true }));

    let disposed = false;
    return {
        update: (cam) => { shared.uCam.value.copy(cam); shared.uTime.value = performance.now() * 0.001; },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            layers.forEach(m => { group.remove(m); m.dispose(); });
            new Set(owned).forEach(o => o.dispose());
            layers.length = 0;
            owned.length = 0;
        }
    };
}
