// Triangle count + size of every prop/war model (run from tools/: node inspect-models.mjs)
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/core';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
});
const roots = ['../public/assets/models/props', '../public/assets/models/war'];
const files = [];
for (const r of roots) for (const f of fs.readdirSync(r)) {
    const p = path.join(r, f);
    if (f.endsWith('.glb') && !f.includes('_lod')) files.push(p);
    else if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, `${f}_1k.gltf`))) files.push(path.join(p, `${f}_1k.gltf`));
}
for (const f of files) {
    const doc = await io.read(f);
    let t = 0;
    for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
        const idx = p.getIndices(); t += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    }
    const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
    const b = getBounds(scene); const s = b.max.map((v, i) => v - b.min[i]);
    console.log(`${path.basename(f).padEnd(40)} ${String(Math.round(t)).padStart(7)}  ${s.map(v => v.toFixed(2)).join(' x ')}`);
}
