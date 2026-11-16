// Fetch CC0 models from poly.pizza (Quaternius, Kenney and other CC0 authors) as GLB.
//   node tools/fetch-polypizza.mjs --list "military truck" "tank"        (print CC0 candidates only)
//   node tools/fetch-polypizza.mjs --get <slug>=<PublicID> ...           (download into public/assets/models/war/<slug>.glb)
// Only models whose licence reads "CC0 1.0" are ever downloaded. Credits go to public/assets/models/war/credits.json.
import fs from 'fs';
import path from 'path';

const UA = { 'User-Agent': 'Mozilla/5.0 (asset-fetch)' };
const OUT = path.resolve('public/assets/models/war');
const CREDITS = path.join(OUT, 'credits.json');

async function model(id) {
    const html = await (await fetch(`https://poly.pizza/m/${id}`, { headers: UA })).text();
    const m = html.match(/window\.__SERVER_APP_STATE__ =\s+(\{.*?\})<\/script>/s) || html.match(/window\.__SERVER_APP_STATE__ =\s+(\{.*)/);
    let meta = null;
    try {
        const raw = html.slice(html.indexOf('"model":{') + 8);
        let depth = 0, end = 0;
        for (let i = 0; i < raw.length; i++) { if (raw[i] === '{') depth++; else if (raw[i] === '}') { depth--; if (!depth) { end = i + 1; break; } } }
        meta = JSON.parse(raw.slice(0, end));
    } catch (e) { /* fall through */ }
    if (!meta) return null;
    const glb = (html.match(/https:\/\/static\.poly\.pizza\/[0-9a-f-]+\.glb(?!\.)/) || [])[0];
    return { id, title: meta.Title, author: meta.Creator && meta.Creator.Username, licence: meta.Licence, tris: meta.Tris, animated: meta.Animated, glb };
}

const args = process.argv.slice(2);
if (args[0] === '--list') {
    for (const q of args.slice(1)) {
        const html = await (await fetch(`https://poly.pizza/search/${encodeURIComponent(q)}`, { headers: UA })).text();
        const ids = [...new Set([...html.matchAll(/href="\/m\/([A-Za-z0-9_-]+)"/g)].map(x => x[1]))].slice(0, 14);
        console.log('##', q);
        for (const id of ids) {
            const d = await model(id).catch(() => null);
            if (d && /CC0/.test(d.licence || '')) console.log(`${d.id}  ${d.title}  by ${d.author}  ${d.tris} tris${d.animated ? ' ANIMATED' : ''}`);
        }
    }
} else if (args[0] === '--get') {
    fs.mkdirSync(OUT, { recursive: true });
    const credits = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : [];
    for (const spec of args.slice(1)) {
        const [slug, id] = spec.split('=');
        if (fs.existsSync(path.join(OUT, `${slug}.glb`))) { console.log('skip', slug); continue; }
        const d = await model(id);
        if (!d || !/CC0/.test(d.licence || '') || !d.glb) { console.warn('refused (not CC0 or no glb):', slug, d && d.licence); continue; }
        const res = await fetch(d.glb, { headers: UA });
        if (!res.ok) { console.warn('download failed', slug); continue; }
        fs.writeFileSync(path.join(OUT, `${slug}.glb`), Buffer.from(await res.arrayBuffer()));
        credits.push({ file: `${slug}.glb`, title: d.title, author: d.author, licence: d.licence, url: `https://poly.pizza/m/${id}` });
        console.log('ok', slug, '<-', d.title, 'by', d.author);
    }
    fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 1));
}
