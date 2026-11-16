// Offline LOD for the character models (run from tools/: node simplify-characters.mjs).
// Writes characters/<name>_lod.glb next to each source. Skinned meshes keep their joints/weights
// (meshoptimizer collapses edges, vertex attributes are carried through), so the rig still works.
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, dedup, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

const DIR = path.resolve('../public/assets/models/characters');
const BUDGET = { army1: 4500, army2: 4500, soldier: 5500 };
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(), 'draco3d.encoder': await draco3d.createEncoderModule()
});
const tris = (doc) => { let t = 0; for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const i = p.getIndices(); t += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; } return Math.round(t); };
for (const [name, budget] of Object.entries(BUDGET)) {
    const src = path.join(DIR, `${name}.glb`);
    let best = null, before = 0;
    for (const error of [0.01, 0.02, 0.04]) {
        const doc = await io.read(src);
        before = tris(doc);
        await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(0.9, budget / before), error }), dedup(), prune());
        best = doc;
        if (tris(doc) <= budget * 1.1) break;
    }
    await io.write(path.join(DIR, `${name}_lod.glb`), best);
    console.log(`${name}: ${before} -> ${tris(best)}`);
}
