import { encodeToKTX2 } from 'ktx2-encoder';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const PUB = 'E:/WarField/public/assets';
const imageDecoder = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const flipDecoder = async (buffer) => {
    const { data, info } = await sharp(buffer).flip().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const quiet = (fn) => { const l = console.log; console.log = () => {}; return fn().finally(() => { console.log = l; }); };

const mode = process.argv[2];

if (mode === 'tex') {
    fs.mkdirSync(`${PUB}/ktx2`, { recursive: true });
    const jobs = [];
    const poly = `${PUB}/polyhaven`;
    for (const f of fs.readdirSync(poly)) {
        if (!f.endsWith('.jpg')) continue;
        const normal = f.includes('_nor_');
        jobs.push({ src: `${poly}/${f}`, dst: `${PUB}/ktx2/${f.replace('_1k.jpg', '').replace('_diff', '_diff').replace('.jpg', '')}.ktx2`, normal });
    }
    jobs.push({ src: `${PUB}/textures/grass.jpg`, dst: `${PUB}/ktx2/ez_grass.ktx2`, normal: false });
    let before = 0, after = 0;
    for (const j of jobs) {
        const src = fs.readFileSync(j.src);
        const out = await quiet(() => encodeToKTX2(new Uint8Array(src), {
            isUASTC: false, generateMipmap: true, isSetKTX2SRGBTransferFunc: !j.normal, isNormalMap: j.normal,
            qualityLevel: j.normal ? 180 : 150, imageDecoder: flipDecoder
        }));
        fs.writeFileSync(j.dst, out);
        before += src.length; after += out.length;
        process.stdout.write(`${path.basename(j.dst)} ${(src.length / 1024) | 0}KB -> ${(out.length / 1024) | 0}KB\n`);
    }
    console.log(`TOTAL ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
}

if (mode === 'glb') {
    // args: in out maxSize
    const [, , , inp, outp, maxs] = process.argv;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.read(inp);
    const size = parseInt(maxs || '1024');
    await doc.transform(dedup(), prune(), textureCompress({ encoder: sharp, resize: [size, size], targetFormat: 'png' }));
    await quiet(() => doc.transform(ktx2({ isUASTC: false, qualityLevel: 150, generateMipmap: true, imageDecoder })));
    fs.mkdirSync(path.dirname(outp), { recursive: true });
    await io.write(outp, doc);
    console.log(path.basename(outp), (fs.statSync(inp).size / 1024) | 0, 'KB ->', (fs.statSync(outp).size / 1024) | 0, 'KB');
}
