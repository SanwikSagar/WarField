// Offline LOD pre-processing (run from tools/: node simplify-props.mjs).
//
// Aggressive budgets (normal maps and the shaders carry the surface detail, geometry only the silhouette):
//   small / medium props (<= 4 m) and battlefield clutter  <= 500 triangles
//   large props (car cover, fences, seating, rock sets)    <= 2500
//   vehicles and structures                                <= 1500
//   the ruins block                                        <= 12000
//
//   props/<id>/<id>_1k.gltf  -> props/<id>/<id>_opt.gltf + .bin  (textures referenced, not copied)
//   props/<id>.glb           -> props/<id>_lod.glb               (Draco + KTX2 kept)
//   war/<id>.glb             -> war/<id>_lod.glb
// and writes public/assets/models/lod-manifest.json, which the game reads to pick the reduced files.
import fs from 'fs';
import path from 'path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, dedup, prune, compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

const ROOT = path.resolve('../public/assets/models');
const SMALL = 500, LARGE = 2500, VEHICLE = 1500, RUINS = 12000, SMALL_MAX_SIZE = 4.0;
const FOLIAGE = new Set(['fern_02', 'shrub_02', 'nettle_plant', 'dry_branches_medium_01']);
// battlefield models (arbitrary export scale, so classified by name): small/medium clutter and emplacements
const WAR_SMALL = new Set(['barrel2', 'sack_trench', 'sack_trench_small', 'tires', 'trashbags', 'trash_container',
    'wall_broken', 'wall_modular', 'turret_gun', 'cannon', 'rocks', 'barrel', 'crate_a', 'crate_b', 'bags', 'antenna', 'bricks',
    'barricade', 'barrier_large', 'exploding_barrel', 'propane', 'traffic_light', 'watchtower_small', 'debris_pile', 'bonfire']);
const WAR_BUDGET = { truck: VEHICLE, pickup: VEHICLE, pickup_armored: VEHICLE, suv: VEHICLE, police: VEHICLE, rover: VEHICLE, tank: VEHICLE,
    wagon: VEHICLE, hatchback: VEHICLE, sports: VEHICLE, helicopter: VEHICLE, barracks: VEHICLE, watchtower: VEHICLE, ruins: RUINS };

await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule()
});
const tris = (doc) => {
    let t = 0;
    for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
        const idx = p.getIndices();
        t += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    }
    return Math.round(t);
};
const maxSize = (doc) => {
    const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
    const b = getBounds(scene);
    return Math.max(...b.max.map((v, i) => v - b.min[i]));
};

async function reduce(file, budget, { flat = false } = {}) {
    let doc = await io.read(file);
    const before = tris(doc);
    if (before <= budget) return null;
    // error is relative to the mesh radius; small assets may move further because the normal map carries detail
    const errors = budget <= VEHICLE ? [0.03, 0.06, 0.12, 0.25, 0.5] : [0.01, 0.03, 0.06];
    let best = null;
    for (const error of errors) {
        doc = await io.read(file);
        // flat-shaded low-poly models: per-face normals keep every face separate, so nothing could collapse.
        // Drop them (the game shades these with flatShading, from screen-space derivatives).
        if (flat) for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
            const n = p.getAttribute('NORMAL'); if (n) { p.setAttribute('NORMAL', null); n.dispose(); }
        }
        const ratio = Math.max(0.01, Math.min(0.9, budget / before));
        await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error }), dedup(), prune());
        best = doc;
        if (tris(doc) <= budget) break;
    }
    // last resort for scans whose UV seams block edge collapse: topology-free ("sloppy") clustering,
    // spread over the primitives in proportion to their size. Seams may shift slightly; at <= 1k
    // triangles on a sub-metre prop that is not visible at play distance.
    const now = tris(best);
    if (budget <= VEHICLE && now > budget) {
        const keep = budget / now;
        for (const mesh of best.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
            const idx = p.getIndices(), pos = p.getAttribute('POSITION');
            if (!idx || !pos) continue;
            if (idx.getCount() <= 108) continue;           // tiny parts stay as they are
            const target = Math.min(idx.getCount(), Math.max(36, Math.floor(idx.getCount() * keep / 3) * 3));
            const [out] = MeshoptSimplifier.simplifySloppy(Uint32Array.from(idx.getArray()),
                Float32Array.from(pos.getArray()), 3, null, target, 1);
            idx.setArray(pos.getCount() > 65535 ? out : Uint16Array.from(out));
            compactPrimitive(p);
        }
        await best.transform(prune());
    }
    return { doc: best, before, after: tris(best) };
}

const manifest = { props: {}, war: {} };
const report = [];

// props: Poly Haven glTF folders and GLBs
const PROPS = path.join(ROOT, 'props');
for (const entry of fs.readdirSync(PROPS)) {
    const full = path.join(PROPS, entry);
    let id, src, kind;
    if (entry.endsWith('.glb')) {
        if (entry.includes('_lod')) continue;
        id = entry.slice(0, -4); src = full; kind = 'glb';
    } else if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, `${entry}_1k.gltf`))) {
        id = entry; src = path.join(full, `${entry}_1k.gltf`); kind = 'gltf';
    } else continue;
    if (FOLIAGE.has(id)) continue;
    const size = maxSize(await io.read(src));
    const budget = size <= SMALL_MAX_SIZE ? SMALL : LARGE;
    const r = await reduce(src, budget);
    if (!r) continue;
    if (kind === 'gltf') {
        for (const tex of r.doc.getRoot().listTextures()) {
            const uri = tex.getURI();
            if (uri && !uri.startsWith('textures/')) tex.setURI('textures/' + path.basename(uri));
        }
        const buf = r.doc.getRoot().listBuffers()[0];
        if (buf) buf.setURI(`${id}_opt.bin`);
        await io.write(path.join(full, `${id}_opt.gltf`), r.doc);
        manifest.props[id] = `/assets/models/props/${id}/${id}_opt.gltf`;
    } else {
        await io.write(path.join(PROPS, `${id}_lod.glb`), r.doc);
        manifest.props[id] = `/assets/models/props/${id}_lod.glb`;
    }
    report.push(`props/${id}: ${r.before} -> ${r.after} (${size.toFixed(1)} m, budget ${budget})`);
}

// battlefield clutter
const WAR = path.join(ROOT, 'war');
for (const id of [...WAR_SMALL, ...Object.keys(WAR_BUDGET)]) {
    const src = path.join(WAR, `${id}.glb`);
    if (!fs.existsSync(src)) continue;
    const r = await reduce(src, WAR_BUDGET[id] || SMALL, { flat: true });
    if (!r) continue;
    await io.write(path.join(WAR, `${id}_lod.glb`), r.doc);
    manifest.war[id] = `/assets/models/war/${id}_lod.glb`;
    report.push(`war/${id}: ${r.before} -> ${r.after}`);
}

fs.writeFileSync(path.join(ROOT, 'lod-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(report.join('\n'));
