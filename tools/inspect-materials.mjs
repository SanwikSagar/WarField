// List materials of a GLB (run from tools/: node inspect-materials.mjs <file>)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
});
for (const f of process.argv.slice(2)) {
    const doc = await io.read(f);
    console.log('==', f, 'textures:', doc.getRoot().listTextures().length);
    for (const m of doc.getRoot().listMaterials()) {
        const c = m.getBaseColorFactor().map(v => v.toFixed(2)).join(',');
        console.log(`  ${m.getName().padEnd(34)} col ${c}  met ${m.getMetallicFactor()} rough ${m.getRoughnessFactor()}  tex ${!!m.getBaseColorTexture()} nrm ${!!m.getNormalTexture()} mr ${!!m.getMetallicRoughnessTexture()}`);
    }
}
