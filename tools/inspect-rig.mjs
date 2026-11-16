// Skins, joints, meshes and materials of a GLB (run from tools/: node inspect-rig.mjs <file>)
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
for (const f of process.argv.slice(2)) {
    const doc = await io.read(f), r = doc.getRoot();
    let t = 0; for (const m of r.listMeshes()) for (const p of m.listPrimitives()) { const i = p.getIndices(); t += (i ? i.getCount() : p.getAttribute('POSITION').getCount()) / 3; }
    const b = getBounds(r.listScenes()[0]);
    console.log('==', f, 'tris', Math.round(t), 'skins', r.listSkins().length, 'anims', r.listAnimations().map(a => a.getName()).join(',') || 'none',
        'size', b.max.map((v, i) => (v - b.min[i]).toFixed(2)).join('x'));
    const sk = r.listSkins()[0];
    if (sk) console.log('  joints:', sk.listJoints().slice(0, 30).map(j => j.getName()).join(' '));
    console.log('  materials:', r.listMaterials().map(m => m.getName() + (m.getBaseColorTexture() ? '[tex]' : '')).join(', '));
}
