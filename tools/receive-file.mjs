// Dev helper: accepts POST /save?name=<file> (data URL or raw body) on localhost:3999 and writes it to
// public/assets/<dir>/<file> (dir: vfx | ui/loading, default vfx). Used to save textures composed in the browser (public/_atlas_src/build.html).
// Run from tools/: node receive-file.mjs [count]   (exits after <count> saves, default 1)
const LIMIT = Number(process.argv[2]) || 1;
let saved = 0;
import http from 'http';
import fs from 'fs';
import path from 'path';

const DIRS = { vfx: path.resolve('../public/assets/vfx'), 'ui/loading': path.resolve('../public/assets/ui/loading') };
http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const name = path.basename(url.searchParams.get('name') || '');
    const OUT = DIRS[url.searchParams.get('dir') || 'vfx'];
    if (!OUT) { res.statusCode = 400; res.end('bad dir'); return; }
    fs.mkdirSync(OUT, { recursive: true });
    if (req.method !== 'POST' || !/^[\w.-]+\.(webp|png|jpg)$/.test(name)) { res.statusCode = 400; res.end('bad'); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        const m = body.match(/^data:[^;]+;base64,(.*)$/s);
        const buf = m ? Buffer.from(m[1], 'base64') : Buffer.concat(chunks);
        fs.writeFileSync(path.join(OUT, name), buf);
        res.end(`saved ${name} ${buf.length}`);
        console.log(`saved ${name} ${buf.length} bytes`);
        if (++saved >= LIMIT) setTimeout(() => process.exit(0), 100);
    });
}).listen(3999, '127.0.0.1', () => console.log('listening on 3999'));
