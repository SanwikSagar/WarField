// Download CC0 Poly Haven models (1k glTF + textures) into public/assets/models/props/<id>/.
//   node tools/fetch-polyhaven-models.mjs id1 id2 ...
import fs from 'fs';
import path from 'path';

const ids = process.argv.slice(2);
for (const id of ids) {
    const dir = path.resolve('public/assets/models/props', id);
    if (fs.existsSync(path.join(dir, `${id}_1k.gltf`))) { console.log('skip', id); continue; }
    const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
    const g = files?.gltf?.['1k']?.gltf;
    if (!g) { console.warn('no 1k gltf for', id); continue; }
    fs.mkdirSync(dir, { recursive: true });
    const get = async (url, rel) => {
        const out = path.join(dir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    };
    await get(g.url, `${id}_1k.gltf`);
    for (const [rel, f] of Object.entries(g.include || {})) await get(f.url, rel);
    console.log('ok', id, Object.keys(g.include || {}).length + 1, 'files');
}
