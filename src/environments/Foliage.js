import * as THREE from '/node_modules/three/build/three.module.js';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '/node_modules/three/examples/jsm/loaders/DRACOLoader.js';
import { makeGLTFLoader, loadKTX2 } from './AssetLoaders.js';
import { mergeGeometries } from '/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { bakeImpostor } from './Impostors.js';
import { relocatePathFoliage } from './PathFoliage.js';

/**
 * Realistic-but-cheap foliage for the web.
 *
 *  - Trees come from EZ-Tree (procedural trees with real bark + leaf textures).
 *    A handful of variants x 3 levels of detail are generated once at level
 *    load, then every tree in the level is just an INSTANCE of one of them.
 *  - Each frame a tiny loop assigns every tree to a LOD bucket by distance
 *    (and drops trees behind the camera / beyond the fog), so only a few
 *    thousand triangles of trees are ever submitted: near trees are detailed,
 *    far ones are 10x cheaper. Whole forest = ~20 draw calls.
 *  - Grass, bushes and rocks use the same instancing; grass is chunked so
 *    frustum + distance culling work. Wind is done in the vertex shader.
 */

// ── asset loading (lazy: EZ-Tree is a big chunk, only fetched on mission start)
let EZ = null;
let assets = null;
let loading = null;

export function loadFoliageAssets() {
    if (assets) return Promise.resolve(assets);
    if (loading) return loading;
    loading = (async () => {
        const out = { rocks: [], grass: null, textures: {} };
        try { EZ = await import('@dgreenheck/ez-tree'); } catch (e) { console.warn('EZ-Tree failed to load:', e); }

        const gltf = makeGLTFLoader();   // Draco + KTX2 aware
        const model = (url) => gltf.loadAsync(url).then(g => g.scene, () => null);

        const [r1, r2, r3, fern, reeds, grassTex] = await Promise.all([
            model('/assets/models/environments/rock1.glb'),
            model('/assets/models/environments/rock2.glb'),
            model('/assets/models/environments/rock3.glb'),
            model('/assets/models/foliage/fern.glb'),
            model('/assets/models/foliage/reeds.glb'),
            loadKTX2('/assets/ktx2/ez_grass.ktx2')
        ]);
        out.models = {};
        if (fern) out.models.fern = prepScatterModel(fern);
        if (reeds) out.models.reeds = prepScatterModel(reeds);
        const dirt = null, dirtN = null;
        const g = null;
        [r1, r2, r3].forEach(scene => {
            const m = scene && firstMesh(scene);
            if (m) out.rocks.push(normalizeGeometry(m.geometry.clone(), 'rock'), m.material);
        });
        if (g) {
            const m = firstMesh(g);
            if (m) out.grass = { geometry: normalizeGeometry(m.geometry.clone(), 'height'), map: m.material.map };
        }
        out.textures = { dirt, dirtN, grass: grassTex };
        assets = out;
        return out;
    })();
    return loading;
}

function firstMesh(root) {
    let found = null;
    root.traverse(o => { if (!found && o.isMesh) found = o; });
    return found;
}

/** Re-centre a model so its base sits on y=0 and scale it to unit size. */
function normalizeGeometry(geo, mode) {
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    const size = new THREE.Vector3(); b.getSize(size);
    const k = mode === 'height' ? 1 / Math.max(size.y, 1e-4) : 1 / Math.max(size.x, size.y, size.z, 1e-4);
    geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    geo.scale(k, k, k);
    geo.computeBoundingSphere();
    return geo;
}

// ── wind (shared uniform, injected into foliage materials) ───────────────
const wind = { uTime: { value: 0 } };

function addWind(material, { amp, invH = 1, power = 2 }) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        if (prev) prev(shader, renderer);
        shader.uniforms.uTime = wind.uTime;
        shader.uniforms.uAmp = { value: amp };
        shader.uniforms.uInvH = { value: invH };
        shader.vertexShader = 'uniform float uTime; uniform float uAmp; uniform float uInvH;\n' +
            shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
            #ifdef USE_INSTANCING
                float wph = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
            #else
                float wph = 0.0;
            #endif
            float wsw = pow(clamp(position.y * uInvH, 0.0, 1.5), ${power.toFixed(1)});
            transformed.x += (sin(uTime * 1.3 + wph) + 0.25 * sin(uTime * 3.1 + wph * 1.7)) * uAmp * wsw;
            transformed.z += cos(uTime * 1.1 + wph * 1.3) * uAmp * 0.7 * wsw;`);
    };
    material.customProgramCacheKey = () => 'wind' + amp + power;
}

// ── tree species ─────────────────────────────────────────────────────────
// heights are in metres; the generated tree is rescaled to hit them.
const SPECIES = {
    pine:  { presets: ['Pine Small', 'Pine Medium'], height: [15, 21], leaf: 0x3f6636, bark: 0x7d6a58, trunkR: 0.5 },
    aspen: { presets: ['Aspen Small'], height: [11, 15], leaf: 0x66883a, bark: 0xffffff, trunkR: 0.35 },
    oak:   { presets: ['Oak Small'], height: [9, 13], leaf: 0x4f6c36, bark: 0x8c7a66, trunkR: 0.55 },
    scrub: { presets: ['Ash Small'], height: [5, 8], leaf: 0x9a8f4c, bark: 0xa08c6c, trunkR: 0.3 },
    bush:  { presets: ['Bush 1'], height: [1.0, 1.7], leaf: 0xa8c66a, bark: 0x6b5a45, trunkR: 0.1 }
};

// Per-LOD simplification of a generated tree.
// seg = max radial segments, sec = section multiplier, child = branch-count
// multiplier. Tuned so a pine is ~4k tris near, ~1.2k mid, ~0.5k far.
const LOD_TUNE = [
    { seg: 4, sec: 0.5, child: 0.7, leaves: 1.3, leafSize: 1.7 },
    { seg: 3, sec: 0.4, child: 0.42, leaves: 0.68, leafSize: 2.2 },
    { seg: 3, sec: 0.3, child: 0.25, leaves: 0.24, leafSize: 2.7 }
];

function generateTree(presetName, seed, lod, speciesCfg, tintOverride) {
    const t = new EZ.Tree();
    t.loadPreset(presetName);
    const o = t.options;
    o.seed = seed;
    const tune = LOD_TUNE[lod];
    for (let k = 0; k < 4; k++) {
        if (o.branch.segments[k] != null) o.branch.segments[k] = Math.max(3, Math.min(o.branch.segments[k], tune.seg));
        if (o.branch.sections[k] != null) o.branch.sections[k] = Math.max(3, Math.round(o.branch.sections[k] * tune.sec));
        if (k < 3 && o.branch.children[k] != null) o.branch.children[k] = Math.max(1, Math.round(o.branch.children[k] * tune.child));
    }
    o.leaves.count = Math.max(2, Math.round(o.leaves.count * tune.leaves));
    o.leaves.size *= tune.leafSize;
    o.leaves.tint = (tintOverride?.leaf ?? speciesCfg.leaf);
    o.bark.tint = (tintOverride?.bark ?? speciesCfg.bark);
    o.bark.flatShading = false;
    t.generate();
    roundLeafNormals(t.leavesMesh.geometry);
    return t;
}

/** Replace per-quad leaf normals with normals radiating from the crown. */
function roundLeafNormals(geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox, cy = (bb.min.y + bb.max.y) * 0.5;
    const cx = (bb.min.x + bb.max.x) * 0.5, cz = (bb.min.z + bb.max.z) * 0.5;
    const p = geo.attributes.position, n = geo.attributes.normal;
    if (!n) return;
    for (let i = 0; i < p.count; i++) {
        let x = p.getX(i) - cx, y = (p.getY(i) - cy) * 0.35, z = p.getZ(i) - cz;
        let l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
        y += 0.65;
        l = Math.hypot(x, y, z) || 1;
        n.setXYZ(i, x / l, y / l, z / l);
    }
    n.needsUpdate = true;
}

function makeTreeMaterials(sample, speciesCfg, tint) {
    const b = sample.branchesMesh.material, l = sample.leavesMesh.material;
    const bark = new THREE.MeshStandardMaterial({
        map: b.map, normalMap: b.normalMap, aoMap: b.aoMap,
        color: new THREE.Color(tint?.bark ?? speciesCfg.bark),
        roughness: 0.95, metalness: 0
    });
    const leaf = new THREE.MeshLambertMaterial({
        map: l.map, color: new THREE.Color(tint?.leaf ?? speciesCfg.leaf),
        side: THREE.DoubleSide, alphaTest: 0.25, alphaToCoverage: true
    });
    // Leaf cards get smooth "canopy" normals (see roundLeafNormals) and are lit
    // identically from both sides, so crowns shade like soft volumes instead
    // of flickering dark/bright quads.
    leaf.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
            'vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;');
    };
    // Leaves are thin: light scatters through them. A little self-illumination
    // stops the canopy from going black under overcast skies.
    leaf.emissive = new THREE.Color(tint?.leaf ?? speciesCfg.leaf)
        .lerp(new THREE.Color(0xb7d0bc), 0.45).multiplyScalar(0.08);
    leaf.emissiveMap = l.map;
    return { bark, leaf };
}

// ── generic LOD instancer ────────────────────────────────────────────────
export class InstanceLOD {
    /**
     * variants[v][lod] = array of {geometry, material} parts.
     * items[i] = { x, z, variant, m: Float32Array(16), c: Float32Array(3) }
     */
    constructor(parent, variants, items, { thresholds, shadowLods = [0], backCull = 8, shadowDistance = 40 }) {
        this.items = items;
        this.thresholds2 = thresholds.map(t => t * t);
        this.maxD2 = this.thresholds2[this.thresholds2.length - 1];
        this.backCull = backCull;
        this.shadowDistance2 = shadowDistance * shadowDistance;
        this.lastCam = new THREE.Vector2(Infinity, Infinity);
        this.lastDir = new THREE.Vector2(Infinity, Infinity);
        this.buckets = []; // [variant][lod] = { n, meshes[] }
        this.all = [];
        this.activeBuckets = [];
        this.impostorCameras = new Set();
        const caps = new Array(variants.length).fill(0);
        items.forEach(it => caps[it.variant]++);
        variants.forEach((lods, v) => {
            this.buckets[v] = lods.map((parts, l) => {
                const casts = shadowLods.includes(l);
                const split = casts && thresholds[l] > shadowDistance;
                const createBucket = castShadow => {
                    const meshes = parts.map(p => {
                        const mesh = new THREE.InstancedMesh(p.geometry, p.material, Math.max(1, caps[v]));
                        mesh.setColorAt(0, new THREE.Color(1, 1, 1));
                        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
                        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
                        mesh.castShadow = castShadow;
                        mesh.receiveShadow = !p.material.userData?.impostor && (castShadow || thresholds[l] <= shadowDistance);
                        mesh.userData.environmentManaged = true;
                        mesh.userData.lodTier = p.label ?? p.material.userData?.impostor ?? `geometry-${l}`;
                        if (p.material.userData?.impostorCamera) this.impostorCameras.add(p.material.userData.impostorCamera);
                        mesh.frustumCulled = false;
                        mesh.count = 0;
                        mesh.visible = false;
                        parent.add(mesh);
                        this.all.push(mesh);
                        return mesh;
                    });
                    const bucket = { n: 0, meshes };
                    this.activeBuckets.push(bucket);
                    return bucket;
                };
                const bucket = createBucket(casts && !split);
                if (split) bucket.shadow = createBucket(true);
                return bucket;
            });
        });
    }

    update(cam, dir) {
        for (const uniform of this.impostorCameras) uniform.value.copy(cam);
        const th = this.thresholds2, items = this.items, nL = th.length;
        const cx = cam.x, cz = cam.z, dx0 = dir.x, dz0 = dir.z, br = this.backCull;
        if ((cx - this.lastCam.x) ** 2 + (cz - this.lastCam.y) ** 2 < 0.0625 &&
            (dx0 - this.lastDir.x) ** 2 + (dz0 - this.lastDir.y) ** 2 < 0.0001) return;
        this.lastCam.set(cx, cz);
        this.lastDir.set(dx0, dz0);
        for (const bucket of this.activeBuckets) bucket.n = 0;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const dx = it.x - cx, dz = it.z - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 > this.maxD2) continue;
            if (d2 > Math.max(400, this.shadowDistance2) && dx * dx0 + dz * dz0 < -br) continue;
            let lod = 0;
            while (lod < nL - 1 && d2 > th[lod]) lod++;
            let bucket = this.buckets[it.variant][lod];
            if (!bucket) continue;
            if (bucket.shadow && d2 < this.shadowDistance2) bucket = bucket.shadow;
            const idx = bucket.n++;
            for (let p = 0; p < bucket.meshes.length; p++) {
                const m = bucket.meshes[p];
                m.instanceMatrix.array.set(it.m, idx * 16);
                m.instanceColor.array.set(it.c, idx * 3);
            }
        }
        for (const b of this.activeBuckets) {
            for (const m of b.meshes) {
                m.count = b.n;
                // empty buckets still cost a full program/uniform setup (and a shadow pass) per frame
                m.visible = b.n > 0;
                if (b.n) {
                    m.instanceMatrix.clearUpdateRanges();
                    m.instanceMatrix.addUpdateRange(0, b.n * 16);
                    m.instanceColor.clearUpdateRanges();
                    m.instanceColor.addUpdateRange(0, b.n * 3);
                    m.instanceMatrix.needsUpdate = true;
                    m.instanceColor.needsUpdate = true;
                }
            }
        }
    }

    dispose() {
        this.all.forEach(m => { m.parent && m.parent.remove(m); m.dispose(); });
    }
}

const _o = new THREE.Object3D();
function makeItem(x, y, z, rotY, sx, sy, sz, variant, color) {
    _o.position.set(x, y, z);
    _o.rotation.set(0, rotY, 0);
    _o.scale.set(sx, sy, sz);
    _o.updateMatrix();
    return {
        x, z, variant,
        m: Float32Array.from(_o.matrix.elements),
        c: Float32Array.from([color.r, color.g, color.b])
    };
}

/** Spatial-hash helper to keep scattered objects from overlapping. */
class SpacingGrid {
    constructor(cell = 4) { this.cell = cell; this.map = new Map(); }
    key(x, z) { return Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell); }
    ok(x, z, minD) {
        const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
        const r = Math.ceil(minD / this.cell);
        for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
            const arr = this.map.get((cx + i) + ',' + (cz + j));
            if (!arr) continue;
            for (const p of arr) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minD * minD) return false;
        }
        return true;
    }
    add(x, z) {
        const k = this.key(x, z);
        (this.map.get(k) || this.map.set(k, []).get(k)).push({ x, z });
    }
}

// ── public builders ──────────────────────────────────────────────────────
/**
 * ctx: { group, rand, bounds, detail, heightAt, isBlocked, colliders, cover }
 * Returns { update(camPos, camDir), dispose() } or null.
 */
export function buildForest(ctx, v) {
    if (!EZ || !v || !v.count) return null;
    const { group, rand, bounds: b, detail, heightAt, isBlocked, world } = ctx;
    const mix = v.mix || [{ species: 'pine', w: 1 }];
    const tint = v.tint || null;

    // 1) generate variants x LOD
    const variantDefs = [];   // flat list: { species, preset, seed }
    mix.forEach(m => {
        const sp = SPECIES[m.species];
        const n = m.variants || (m.species === 'pine' ? 2 : 1);
        for (let i = 0; i < n; i++) {
            variantDefs.push({ species: m.species, cfg: sp, preset: sp.presets[i % sp.presets.length], seed: 100 + variantDefs.length * 37, w: m.w / n });
        }
    });
    const lodCount = Math.max(3, detail.lodCount ?? 3);
    const variants = [];
    const heights = [];
    const impostors = [];
    for (const def of variantDefs) {
        const lods = [];
        let sample = null;
        for (let l = 0; l < lodCount; l++) {
            const tree = generateTree(def.preset, def.seed, l, def.cfg, tint);
            const mats = sample ? sample : makeTreeMaterials(tree, def.cfg, tint);
            if (!sample) {
                sample = mats;
                addWind(mats.bark, { amp: 0.9, invH: 1 / 45, power: 2 });
                addWind(mats.leaf, { amp: 1.4, invH: 1 / 45, power: 1.6 });
            }
            tree.branchesMesh.geometry.computeBoundingBox();
            const parts = [
                { geometry: tree.branchesMesh.geometry, material: sample.bark },
                { geometry: tree.leavesMesh.geometry, material: sample.leaf }
            ];
            if (l === 0) {
                const bb = new THREE.Box3().union(tree.branchesMesh.geometry.boundingBox);
                tree.leavesMesh.geometry.computeBoundingBox();
                bb.union(tree.leavesMesh.geometry.boundingBox);
                heights.push({ h: bb.max.y, r: tree.options.branch.radius[0] });
            }
            lods.push(parts);
        }
        const impostor = bakeImpostor(detail.renderer, lods[0], { resolution: detail.impostorResolution ?? 128 });
        if (impostor) {
            lods.push(impostor.medium, impostor.far);
            impostors.push(impostor);
        }
        variants.push(lods);
    }

    // 2) scatter
    const total = Math.round(v.count * detail.treeMul * (detail.treeDensity ?? 1));
    const ringShare = v.ringShare ?? 0.7;
    const ringN = Math.round(total * ringShare), inN = total - ringN;
    const grid = new SpacingGrid(4);
    const items = [];
    const totalW = variantDefs.reduce((s, d) => s + d.w, 0);
    const pickVariant = () => {
        let r = rand() * totalW;
        for (let i = 0; i < variantDefs.length; i++) { r -= variantDefs[i].w; if (r <= 0) return i; }
        return 0;
    };
    const col = new THREE.Color();
    const place = (x, z, ringTree) => {
        const vi = pickVariant();
        const def = variantDefs[vi];
        const [h0, h1] = def.cfg.height;
        const hMeters = (h0 + rand() * (h1 - h0)) * (ringTree ? 1.1 : 1);
        const s = hMeters / heights[vi].h;
        const t = 0.8 + rand() * 0.35;
        col.setRGB(t * (0.95 + rand() * 0.1), t, t * (0.9 + rand() * 0.15));
        const y = heightAt(x, z) - 0.15;
        items.push(makeItem(x, y, z, rand() * Math.PI * 2, s * (0.92 + rand() * 0.16), s, s * (0.92 + rand() * 0.16), vi, col));
        grid.add(x, z);
        const m = Math.max(Math.abs(x), Math.abs(z));
        if (m < b + 1) {
            const r = Math.max(0.3, heights[vi].r * s * 0.85);
            world.addCircle(x, z, r, 0, 7);
        }
    };

    // perimeter forest wall (also the visual + physical boundary of the arena)
    const bandIn = b - 14, bandOut = b + 46;
    let placed = 0, guard = 0;
    while (placed < ringN && guard++ < ringN * 40) {
        const x = (rand() * 2 - 1) * bandOut, z = (rand() * 2 - 1) * bandOut;
        const m = Math.max(Math.abs(x), Math.abs(z));
        if (m < bandIn || m > bandOut) continue;
        // density falls off towards the arena interior and far outside
        const inner = (m - bandIn) / 14;
        if (inner < 1 && rand() > inner * 0.9 + 0.15) continue;
        if (isBlocked(x, z, 2)) continue;
        if (!grid.ok(x, z, 3.0)) continue;
        place(x, z, true); placed++;
    }
    // interior scatter
    const groves = v.groves ? Array.from({ length: v.groves }, () => ({
        x: (rand() * 2 - 1) * (b - 24), z: (rand() * 2 - 1) * (b - 24)
    })) : [];
    placed = 0; guard = 0;
    while (placed < inN && guard++ < inN * 40) {
        let x, z;
        if (groves.length && rand() < 0.72) {
            const grove = groves[Math.floor(rand() * groves.length)];
            const angle = rand() * Math.PI * 2, radius = Math.sqrt(rand()) * 18;
            x = grove.x + Math.cos(angle) * radius;
            z = grove.z + Math.sin(angle) * radius;
        } else {
            x = (rand() * 2 - 1) * (b - 12); z = (rand() * 2 - 1) * (b - 12);
        }
        if (isBlocked(x, z, 3.5)) continue;
        if (!grid.ok(x, z, 4.5)) continue;
        place(x, z, false); placed++;
    }

    const backdropN = Math.round((v.backdrop ?? v.count * 0.6) * detail.treeMul * (detail.treeDensity ?? 1));
    placed = 0; guard = 0;
    while (placed < backdropN && guard++ < backdropN * 20) {
        const x = (rand() * 2 - 1) * (b + 88), z = (rand() * 2 - 1) * (b + 88);
        if (Math.max(Math.abs(x), Math.abs(z)) < b + 50 || !grid.ok(x, z, 5)) continue;
        place(x, z, true); placed++;
    }

    const treeThresholds = impostors.length
        ? [detail.treeLod[0], detail.treeLod[1], detail.treeLod[2] * 0.55, detail.treeLod[2] * 0.8, detail.treeLod[2]]
        : detail.treeLod;
    const inst = new InstanceLOD(group, variants, items, {
        thresholds: treeThresholds,
        shadowLods: detail.treeShadowLods, shadowDistance: detail.shadowDistance, backCull: 28
    });
    const geoms = [];
    variants.forEach(l => l.slice(0, lodCount).forEach(parts => parts.forEach(p => geoms.push(p.geometry))));
    return {
        update: (cam, dir) => inst.update(cam, dir),
        count: items.length, items,
        dispose: () => {
            inst.dispose(); geoms.forEach(g => g.dispose()); impostors.forEach(i => i.dispose());
            new Set(variants.flatMap(l => l.slice(0, lodCount).flatMap(parts => parts.map(p => p.material)))).forEach(m => m.dispose());
        }
    };
}

/**
 * Static-camera EZ-Tree forest for the menu backdrop. spots: [{ x, z, h }] with
 * h in metres. LOD is chosen once from the distance to `eye`; every
 * variant/LOD pair is one InstancedMesh per part, swaying in the shared wind.
 */
export async function buildMenuForest(parent, spots, { eye = new THREE.Vector3(), tint = null, variants = 3, lodDist = [30, 75] } = {}) {
    if (!EZ) {
        try { EZ = await import('@dgreenheck/ez-tree'); } catch (e) { console.warn('EZ-Tree failed to load:', e); return null; }
    }
    const cfg = SPECIES.pine;
    const lodOf = (s) => { const d = Math.hypot(s.x - eye.x, s.z - eye.z); return d < lodDist[0] ? 0 : d < lodDist[1] ? 1 : 2; };
    const buckets = new Map();
    spots.forEach((s, i) => {
        const key = `${i % variants}:${lodOf(s)}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(s);
    });
    const mats = [], geoms = [], meshes = [];
    const variantMats = [], heights = [];
    const d = new THREE.Object3D(), col = new THREE.Color();
    for (const [key, list] of buckets) {
        const [vi, lod] = key.split(':').map(Number);
        const tree = generateTree(cfg.presets[vi % cfg.presets.length], 211 + vi * 53, lod, cfg, tint);
        if (!variantMats[vi]) {
            const m = makeTreeMaterials(tree, cfg, tint);
            addWind(m.bark, { amp: 0.9, invH: 1 / 45, power: 2 });
            addWind(m.leaf, { amp: 1.4, invH: 1 / 45, power: 1.6 });
            variantMats[vi] = m; mats.push(m.bark, m.leaf);
            const bb = new THREE.Box3();
            tree.branchesMesh.geometry.computeBoundingBox(); tree.leavesMesh.geometry.computeBoundingBox();
            bb.union(tree.branchesMesh.geometry.boundingBox).union(tree.leavesMesh.geometry.boundingBox);
            heights[vi] = Math.max(bb.max.y, 1);
        }
        const m = variantMats[vi];
        [[tree.branchesMesh.geometry, m.bark], [tree.leavesMesh.geometry, m.leaf]].forEach(([geo, mat]) => {
            const im = new THREE.InstancedMesh(geo, mat, list.length);
            list.forEach((s, i) => {
                const k = s.h / heights[vi];
                const r = Math.sin(s.x * 12.9 + s.z * 78.2) * 43758.5453;
                const rf = r - Math.floor(r);
                d.position.set(s.x, -0.15, s.z);
                d.rotation.set(0, rf * Math.PI * 2, 0);
                d.scale.set(k * (0.92 + rf * 0.16), k, k * (1.08 - rf * 0.16));
                d.updateMatrix();
                im.setMatrixAt(i, d.matrix);
                const t = 0.82 + rf * 0.3;
                im.setColorAt(i, col.setRGB(t * 0.97, t, t * 0.95));
            });
            im.instanceMatrix.needsUpdate = true;
            if (im.instanceColor) im.instanceColor.needsUpdate = true;
            im.frustumCulled = false;
            parent.add(im);
            meshes.push(im); geoms.push(geo);
        });
    }
    return {
        meshes,
        dispose() { meshes.forEach(m => { m.parent && m.parent.remove(m); m.dispose(); }); geoms.forEach(g => g.dispose()); mats.forEach(m => m.dispose()); }
    };
}

/** Undergrowth: small EZ-Tree bushes, near-only LOD. */
export function buildBushes(ctx, v) {
    if (!EZ || !v || !v.bushes) return null;
    const { group, rand, bounds: b, detail, heightAt, isBlocked, grassAt } = ctx;
    const sp = SPECIES.bush;
    const tint = v.bushTint || { leaf: v.tint?.leaf ?? sp.leaf, bark: sp.bark };
    const lods = [], heights = [];
    const impostors = [];
    let sample = null;
    const defs = [['Bush 1', 11], ['Bush 2', 29], ['Bush 3', 47], ['Bush 1', 63]];
    const variants = defs.map(([preset, seed]) => {
        const l = [];
        for (let li = 0; li < 2; li++) {
            const t = new EZ.Tree();
            t.loadPreset(preset);
            t.options.seed = seed;
            const o = t.options;
            o.leaves.count = Math.max(2, Math.round(o.leaves.count * (li === 0 ? 1.0 : 0.55)));
            o.leaves.size *= li === 0 ? 2.0 : 2.7;
            o.leaves.tint = tint.leaf;
            o.branch.levels = li === 0 ? 2 : 1;
            for (let q = 0; q < 4; q++) {
                if (o.branch.segments[q] != null) o.branch.segments[q] = 3;
                if (o.branch.sections[q] != null) o.branch.sections[q] = 3;
            }
            if (li === 0) { o.branch.children[0] = 3; o.branch.children[1] = 3; }
            t.generate();
            roundLeafNormals(t.leavesMesh.geometry);
            if (!sample) {
                sample = makeTreeMaterials(t, sp, tint);
                addWind(sample.leaf, { amp: 0.06, invH: 1 / 1.2, power: 1.2 });
            }
            if (li === 0) {
                t.branchesMesh.geometry.computeBoundingBox(); t.leavesMesh.geometry.computeBoundingBox();
                const bb = t.branchesMesh.geometry.boundingBox.clone().union(t.leavesMesh.geometry.boundingBox);
                heights.push(Math.max(0.3, bb.max.y));
            }
            l.push([
                { geometry: t.branchesMesh.geometry, material: sample.bark },
                { geometry: t.leavesMesh.geometry, material: sample.leaf }
            ]);
        }
        const impostor = bakeImpostor(detail.renderer, l[0], { resolution: detail.impostorResolution ?? 128 });
        if (impostor) { l.push(impostor.medium, impostor.far); impostors.push(impostor); }
        return l;
    });
    // bushes are tiny: shrink wind scale since geometry is in tree units
    const items = [];
    const col = new THREE.Color();
    const n = Math.round(v.bushes * Math.max(0.8, detail.grassMul) * (detail.foliageDensity ?? 1));
    // Thickets: bushes grow in clumps on the green parts of the ground
    // texture, with a big shrub in the middle and smaller ones around it.
    const addBush = (x, z, h) => {
        if (isBlocked(x, z, 1.5)) return false;
        if (Math.max(Math.abs(x), Math.abs(z)) > b + 12) return false;
        const vi = Math.floor(rand() * variants.length);
        const s = h / heights[vi];
        const t = 0.72 + rand() * 0.42;
        col.setRGB(t * (0.92 + rand() * 0.16), t, t * (0.82 + rand() * 0.2));
        items.push(makeItem(x, heightAt(x, z) - 0.05, z, rand() * 6.28, s * (0.9 + rand() * 0.3), s, s * (0.9 + rand() * 0.3), vi, col));
        return true;
    };
    let guard = 0;
    while (items.length < n && guard++ < n * 30) {
        const x = (rand() * 2 - 1) * (b + 10), z = (rand() * 2 - 1) * (b + 10);
        const gval = grassAt(x, z);
        if (gval < 0.35 && rand() < 0.9) continue;
        if (!addBush(x, z, 1.1 + rand() * 1.2)) continue;
        const extra = rand() < 0.65 ? 2 + Math.floor(rand() * 4) : 0;
        for (let k = 0; k < extra && items.length < n; k++) {
            const ang = rand() * 6.28, d = 0.9 + rand() * 2.6;
            addBush(x + Math.cos(ang) * d, z + Math.sin(ang) * d, 0.45 + rand() * 0.9);
        }
    }
    const near = detail.bushNear ?? 20;
    const range = detail.grassDist ?? 85;
    const inst = new InstanceLOD(group, variants, items, {
        thresholds: impostors.length ? [near, Math.min(near * 1.6, range * 0.5), range * 0.72, range] : [near, range],
        shadowLods: [0], shadowDistance: detail.shadowDistance, backCull: 3
    });
    const geoms = [];
    variants.forEach(l => l.slice(0, 2).forEach(parts => parts.forEach(p => geoms.push(p.geometry))));
    return { update: (c, d) => inst.update(c, d), dispose: () => {
        inst.dispose(); geoms.forEach(g => g.dispose()); impostors.forEach(i => i.dispose());
        sample.bark.dispose(); sample.leaf.dispose();
    } };
}

/** Chunked instanced grass (GLB tuft with real alpha texture). */
export function buildGrass(ctx, v) {
    if (!assets || !assets.grass || !v || !v.grass) return null;
    const { group, rand, bounds: b, detail, heightAt, isBlocked, grassAt } = ctx;
    const G = 4, span = (b + 12) * 2, cell = span / G;
    const mat = new THREE.MeshLambertMaterial({
        map: assets.grass.map, color: new THREE.Color(v.grassColor ?? 0x6f8f45).multiply(new THREE.Color(0.58, 0.78, 0.56)),
        alphaTest: 0.4, side: THREE.DoubleSide, alphaToCoverage: true
    });
    addWind(mat, { amp: 0.16, invH: 1, power: 1.5 });
    const chunks = [];
    const total = Math.round(v.grass * detail.grassMul);
    const per = Math.max(1, Math.round(total / (G * G)));
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (let gx = 0; gx < G; gx++) for (let gz = 0; gz < G; gz++) {
        const x0 = -span / 2 + gx * cell, z0 = -span / 2 + gz * cell;
        const mesh = new THREE.InstancedMesh(assets.grass.geometry, mat, per);
        let n = 0, guard = 0;
        while (n < per && guard++ < per * 6) {
            const x = x0 + rand() * cell, z = z0 + rand() * cell;
            if (isBlocked(x, z, 0.5, true)) continue;
            if (grassAt(x, z) < 0.45) continue;                 // tufts only on the green patches
            const s = 0.42 + rand() * 0.6;
            dummy.position.set(x, heightAt(x, z) - 0.02, z);
            dummy.rotation.set(0, rand() * 6.28, 0);
            dummy.scale.set(s * (1.1 + rand() * 0.5), s, s * (1.1 + rand() * 0.5));
            dummy.updateMatrix();
            mesh.setMatrixAt(n, dummy.matrix);
            const t = 0.9 + rand() * 0.4;
            col.setRGB(t * (0.9 + rand() * 0.2), t, t * (0.75 + rand() * 0.3));
            mesh.setColorAt(n, col);
            n++;
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        group.add(mesh);
        chunks.push({ mesh, cx: x0 + cell / 2, cz: z0 + cell / 2 });
    }
    const R = (detail.grassDist ?? 70) + cell * 0.7;
    return {
        update: (cam) => {
            for (const c of chunks) {
                const dx = c.cx - cam.x, dz = c.cz - cam.z;
                c.mesh.visible = dx * dx + dz * dz < R * R;
            }
        },
        dispose: () => { chunks.forEach(c => { group.remove(c.mesh); c.mesh.dispose(); }); mat.dispose(); assets.grass.geometry.dispose(); assets.grass = null; }
    };
}

/**
 * Rocks: real textured GLB boulders for gameplay cover + a boulder wall that
 * helps enclose the play area. Falls back to displaced icospheres if the
 * models can't be loaded.
 */
export function buildRocks(ctx, r, perimeter) {
    const { group, rand, bounds: b, detail, heightAt, isBlocked, world, cover, grassAt } = ctx;
    if (!r) return null;
    const useGLB = assets && assets.rocks.length >= 2;
    const baseGeos = [], mats = [];
    if (useGLB) {
        for (let i = 0; i < assets.rocks.length; i += 2) { baseGeos.push(assets.rocks[i]); mats.push(assets.rocks[i + 1]); }
    } else {
        const g = new THREE.IcosahedronGeometry(0.5, 2);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) {
            const n = 0.8 + 0.4 * Math.abs(Math.sin(p.getX(i) * 7.1) * Math.cos(p.getY(i) * 6.3 + p.getZ(i) * 5.2));
            p.setXYZ(i, p.getX(i) * n, p.getY(i) * n * 0.8, p.getZ(i) * n);
        }
        g.computeVertexNormals(); g.translate(0, 0.35, 0);
        baseGeos.push(g); mats.push(new THREE.MeshStandardMaterial({ color: r.color, roughness: 0.95 }));
    }
    const farGeo = new THREE.DodecahedronGeometry(0.55, 1);
    farGeo.translate(0, 0.3, 0);
    const farMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(r.color).multiplyScalar(0.9), roughness: 1, flatShading: true });
    const impostors = [];
    const variants = baseGeos.map((g, i) => {
        const parts = [{ geometry: g, material: mats[i] }];
        const impostor = bakeImpostor(detail.renderer, parts, { resolution: detail.impostorResolution ?? 128 });
        if (impostor) { impostors.push(impostor); return [parts, impostor.medium, impostor.far]; }
        return [parts, [{ geometry: farGeo, material: farMat }]];
    });

    // Pebbles / small stones: cheap 80-tri stones using the same rock texture.
    const pebbleGeo = new THREE.DodecahedronGeometry(0.5, 1);
    { const p = pebbleGeo.attributes.position;
      for (let i = 0; i < p.count; i++) { const k = 0.82 + 0.3 * Math.abs(Math.sin(p.getX(i) * 9.1 + p.getZ(i) * 7.3)); p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.6, p.getZ(i) * k); }
      pebbleGeo.computeVertexNormals(); pebbleGeo.translate(0, 0.12, 0); }
    const pebbleVariant = variants.length;
    variants.push([[{ geometry: pebbleGeo, material: mats[0] }], [], ...(impostors.length ? [[]] : [])]);
    const items = [];
    const tint = new THREE.Color(r.tint ?? 0xffffff).multiplyScalar(r.bright ?? 1);
    const col = new THREE.Color();
    const addRock = (x, z, size, collide, isCover) => {
        const vi = Math.floor(rand() * (variants.length - 1));
        const t = 0.8 + rand() * 0.35;
        col.copy(tint).multiplyScalar(t);
        const sy = size * (0.6 + rand() * 0.45);
        items.push(makeItem(x, heightAt(x, z) - sy * 0.12, z, rand() * 6.28, size, sy, size * (0.85 + rand() * 0.3), vi, col));
        if (collide) {
            world.addCircle(x, z, size * 0.46, 0, size * 0.9);
        }
        if (isCover) cover.push(new THREE.Vector3(x, 0, z));
    };

    const n = Math.round(r.count * Math.max(0.5, detail.treeMul));
    let guard = 0, placed = 0;
    while (placed < n && guard++ < n * 20) {
        const x = (rand() * 2 - 1) * (b - 8), z = (rand() * 2 - 1) * (b - 8);
        if (isBlocked(x, z, 2)) continue;
        const size = (r.minSize + rand() * (r.maxSize - r.minSize)) * 1.5;
        addRock(x, z, size, size > r.coverSize * 1.5, size > r.coverSize * 1.5);
        placed++;
    }
    // pebble scatter: clustered around boulders (70%) + random
    const bigRocks = items.slice();
    const npb = Math.round((r.pebbles ?? 0) * Math.max(0.5, detail.treeMul));
    for (let i = 0; i < npb; i++) {
        let x, z;
        if (bigRocks.length && rand() < 0.7) {
            const base = bigRocks[Math.floor(rand() * bigRocks.length)];
            const a = rand() * 6.28, d = 0.8 + rand() * 3;
            x = base.x + Math.cos(a) * d; z = base.z + Math.sin(a) * d;
        } else { x = (rand() * 2 - 1) * (b - 8); z = (rand() * 2 - 1) * (b - 8); }
        if (isBlocked(x, z, 0.5, true)) continue;
        if (grassAt(x, z) > 0.6 && rand() < 0.75) continue;   // stones show on bare soil
        const s = 0.1 + rand() * rand() * 0.45;
        const t = 0.75 + rand() * 0.5;
        col.copy(tint).multiplyScalar(t);
        items.push(makeItem(x, heightAt(x, z) - s * 0.1, z, rand() * 6.28, s * (1 + rand() * 0.6), s, s * (0.8 + rand() * 0.6), pebbleVariant, col));
    }

    // boulder wall around the arena edge
    if (perimeter) {
        const step = perimeter.spacing ?? 6;
        const ring = [];
        for (let t = -b; t <= b; t += step) {
            ring.push([t, -b], [t, b], [-b, t], [b, t]);
        }
        for (const [x0, z0] of ring) {
            const x = x0 + (rand() - 0.5) * 3, z = z0 + (rand() - 0.5) * 3;
            const size = (perimeter.min ?? 3.5) + rand() * ((perimeter.max ?? 7) - (perimeter.min ?? 3.5));
            addRock(x, z, size, false, false);
        }
    }

    const propLod = detail.propLod ?? [40, 70, 110, 200];
    const inst = new InstanceLOD(group, variants, items, {
        thresholds: impostors.length ? [propLod[0], propLod[2], propLod[3]] : [(detail.rockNear ?? 55), 170],
        shadowLods: [0], shadowDistance: detail.shadowDistance, backCull: 8
    });
    return {
        update: (c, d) => inst.update(c, d),
        dispose: () => { inst.dispose(); impostors.forEach(i => i.dispose()); farGeo.dispose(); farMat.dispose(); pebbleGeo.dispose(); if (!useGLB) { baseGeos.forEach(g => g.dispose()); mats.forEach(m => m.dispose()); } }
    };
}

/** Normalise a GLB (all meshes) to unit height, base on y=0, centred on x/z. */
function prepScatterModel(scene) {
    scene.updateMatrixWorld(true);
    const meshes = [];
    scene.traverse(o => { if (o.isMesh) meshes.push(o); });
    const box = new THREE.Box3();
    const geos = meshes.map(m => { const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld); g.computeBoundingBox(); box.union(g.boundingBox); return g; });
    const size = box.getSize(new THREE.Vector3());
    const k = 1 / Math.max(size.y, 1e-4);
    const M = new THREE.Matrix4().makeScale(k, k, k).multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
    const parts = geos.map((g, i) => {
        g.applyMatrix4(M); g.computeBoundingSphere();
        const mat = meshes[i].material.clone();
        mat.side = THREE.DoubleSide;
        if (mat.map) { mat.alphaTest = 0.4; mat.alphaToCoverage = true; mat.transparent = false; mat.depthWrite = true; }
        if (mat.color) mat.color.multiply(new THREE.Color(0.58, 0.8, 0.58));
        mat.roughness = 0.9; mat.metalness = 0;
        if (mat.envMapIntensity !== undefined) mat.envMapIntensity = 0.6;
        addWind(mat, { amp: 0.1, invH: 1, power: 1.6 });
        return { geometry: g, material: mat };
    });
    const batches = new Map();
    parts.forEach((part, index) => {
        const attributes = Object.entries(part.geometry.attributes).sort(([left], [right]) => left.localeCompare(right))
            .map(([name, attr]) => `${name}:${attr.itemSize}:${attr.normalized}:${attr.array.constructor.name}`).join('|');
        const key = `${meshes[index].material.uuid}:${!!part.geometry.index}:${attributes}`;
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push(part);
    });
    const mergedParts = [];
    for (const batch of batches.values()) {
        const geometry = batch.length > 1 ? mergeGeometries(batch.map(part => part.geometry), false) : null;
        if (!geometry) { mergedParts.push(...batch); continue; }
        geometry.computeBoundingSphere();
        mergedParts.push({ geometry, material: batch[0].material });
        batch.forEach((part, index) => {
            part.geometry.dispose();
            if (index > 0) part.material.dispose();
        });
    }
    return { parts: mergedParts, aspect: (size.x + size.z) / 2 / size.y };
}

/**
 * Chunked instanced scatter of a GLB (fern / reeds): frustum + distance culled,
 * placed on the green patches of the ground texture.
 *   v.models = { fern: count, reeds: count }, config in v.modelCfg
 */
export function buildModelScatter(ctx, key, count, cfg = {}) {
    if (!assets || !assets.models || !assets.models[key] || !count) return null;
    const { group, rand, bounds: b, detail, heightAt, isBlocked, grassAt, wetAt } = ctx;
    const def = assets.models[key];
    if (detail.renderer) {
        const items = [], color = new THREE.Color();
        const total = Math.round(count * detail.grassMul * (detail.foliageDensity ?? 1) * (detail.plantDensity ?? 1));
        const [h0, h1] = cfg.height || [0.5, 0.95];
        const point = { x: 0, z: 0 };
        let attempts = 0, pathCandidates = 0;
        while (items.length < total && attempts++ < total * 30) {
            point.x = (rand() * 2 - 1) * (b - 6); point.z = (rand() * 2 - 1) * (b - 6);
            relocatePathFoliage(point, ctx.pathSegs || [], false);
            if (point.onPath && pathCandidates++ % 2 === 0) relocatePathFoliage(point, ctx.pathSegs || [], true);
            const x = point.x, z = point.z;
            if (isBlocked(x, z, 0.6, true)) continue;
            const grass = grassAt(x, z), wet = wetAt ? wetAt(x, z) : 0;
            if (cfg.wet ? wet < 0.25 && rand() > 0.05 : grass < (cfg.minGrass ?? 0.3)) continue;
            const height = (h0 + rand() * (h1 - h0)) * (cfg.wet ? 1 + wet * 0.5 : 1);
            const tint = 0.55 + rand() * 0.3;
            color.setRGB(tint * (0.92 + rand() * 0.16), tint, tint * (0.8 + rand() * 0.25));
            items.push(makeItem(x, heightAt(x, z) - 0.02, z, rand() * 6.28,
                height * (0.9 + rand() * 0.5), height, height * (0.9 + rand() * 0.5), 0, color));
        }
        const impostor = bakeImpostor(detail.renderer, def.parts, { resolution: detail.impostorResolution ?? 128 });
        const inst = new InstanceLOD(group, [[def.parts, impostor.medium, impostor.far]], items, {
            thresholds: detail.plantLod ?? [16, 38, detail.grassDist ?? 85],
            shadowLods: detail.fieldMul >= 1 ? [0] : [], shadowDistance: detail.shadowDistance, backCull: 3
        });
        return { update: (cam, dir) => inst.update(cam, dir), dispose: () => { inst.dispose(); impostor.dispose(); } };
    }
    const G = 4, span = (b + 10) * 2, cell = span / G;
    const per = Math.max(1, Math.round(count * detail.grassMul / (G * G)));
    const chunks = [];
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const [h0, h1] = cfg.height || [0.5, 0.95];
    for (let gx = 0; gx < G; gx++) for (let gz = 0; gz < G; gz++) {
        const x0 = -span / 2 + gx * cell, z0 = -span / 2 + gz * cell;
        const mats = [];
        let n = 0, guard = 0;
        const entries = [];
        while (n < per && guard++ < per * 12) {
            const x = x0 + rand() * cell, z = z0 + rand() * cell;
            if (Math.max(Math.abs(x), Math.abs(z)) > b - 6) continue;
            if (isBlocked(x, z, 0.6, true)) continue;
            const gv = grassAt(x, z), wv = wetAt ? wetAt(x, z) : 0;
            if (cfg.wet) { if (wv < 0.25 && rand() > 0.05) continue; }
            else if (gv < (cfg.minGrass ?? 0.3)) continue;
            const s = (h0 + rand() * (h1 - h0)) * (cfg.wet ? 1 + wv * 0.5 : 1);
            dummy.position.set(x, heightAt(x, z) - 0.02, z);
            dummy.rotation.set(0, rand() * 6.28, 0);
            dummy.scale.set(s * (0.9 + rand() * 0.5), s, s * (0.9 + rand() * 0.5));
            dummy.updateMatrix();
            const t = 0.75 + rand() * 0.45;
            col.setRGB(t * (0.92 + rand() * 0.16), t, t * (0.8 + rand() * 0.25));
            entries.push([dummy.matrix.clone(), col.clone()]);
            n++;
        }
        if (!n) continue;
        const meshes = def.parts.map(p => {
            const m = new THREE.InstancedMesh(p.geometry, p.material, n);
            entries.forEach(([mat4, c], i) => { m.setMatrixAt(i, mat4); m.setColorAt(i, c); });
            m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
            m.computeBoundingSphere();
            m.castShadow = false; m.receiveShadow = true;
            group.add(m);
            return m;
        });
        chunks.push({ meshes, n, cx: x0 + cell / 2, cz: z0 + cell / 2 });
    }
    const Rf = (detail.grassDist ?? 70) + cell * 0.7, R2 = Rf * Rf, N2 = (Rf * 0.55) ** 2;
    return {
        update: (cam) => {
            for (const c of chunks) {
                const dx = c.cx - cam.x, dz = c.cz - cam.z, d2 = dx * dx + dz * dz;
                const cnt = d2 > R2 ? 0 : d2 < N2 ? c.n : Math.ceil(c.n * 0.35);   // LOD by density
                c.meshes.forEach(m => { m.visible = cnt > 0; m.count = cnt; });
            }
        },
        dispose: () => { chunks.forEach(c => c.meshes.forEach(m => { group.remove(m); m.dispose(); })); def.parts.forEach(p => { p.geometry.dispose(); p.material.dispose(); }); }
    };
}

export function getFoliageAssets() { return assets; }

/** Register an extra GLB (e.g. Poly Haven plant) for chunked instanced scatter. */
export function registerScatterModel(key, scene) {
    if (!assets || !scene) return false;
    assets.models = assets.models || {};
    if (!assets.models[key]) assets.models[key] = prepScatterModel(scene.clone(true));
    return true;
}
export function updateWindTime(t) { wind.uTime.value = t; }
