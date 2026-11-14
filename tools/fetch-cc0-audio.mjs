// Fetch CC0 sound effects from Freesound (search results filtered to "Creative Commons 0").
// Downloads the public HQ preview MP3s into public/assets/audio/sfx and appends to credits.json.
//   node tools/fetch-cc0-audio.mjs            (skips files that already exist)
import fs from 'fs';
import path from 'path';

const OUT = path.resolve('public/assets/audio/sfx');
const CREDITS = path.join(OUT, 'credits.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (asset-fetch)' };

// name -> [query, count, minDur, maxDur]
const WANT = {
    radio_on:        [['radio squelch', 'walkie talkie beep', 'radio click'], 2, 0.1, 2.5],
    radio_off:       [['walkie talkie', 'radio roger beep', 'radio squelch'], 2, 0.1, 2.5],
    radio_static:    [['radio static', 'white noise radio'], 1, 3, 40],
    ui_hover:        [['ui hover tick'], 1, 0.02, 0.4],
    ui_select:       [['ui click confirm'], 1, 0.03, 0.8],
    ui_back:         [['ui click', 'button click'], 1, 0.03, 0.8],
    whoosh:          [['cinematic whoosh transition'], 2, 0.4, 3],
    boom:            [['cinematic boom impact trailer'], 1, 1.5, 8],
    sting:           [['dark cinematic sting'], 1, 2, 12],
    amb_city:        [['war ambience', 'battle ambience', 'city ambience night'], 1, 30, 400],
    siren:           [['air raid siren distant'], 1, 6, 90],
    whiz:            [['bullet whizz', 'bullet flyby', 'bullet pass'], 2, 0.1, 3],
    impact_concrete: [['bullet impact', 'bullet hit wall', 'ricochet'], 1, 0.05, 2],
    step_concrete:   [['footsteps concrete', 'footstep', 'shoe step concrete'], 3, 0.05, 1.2],
    music_menu:      [['ambient piano melancholic', 'cinematic ambient music', 'sad ambient music loop'], 1, 40, 400],
    music_tension:   [['cinematic tension', 'suspense orchestral', 'war drums cinematic'], 1, 30, 400],
    thunder:         [['thunder', 'thunderclap', 'thunder rolling distant', 'thunderstorm thunder'], 4, 3, 30],
    bird:            [['forest birds', 'bird song', 'songbird'], 2, 4, 40],
    crow:            [['crow caw', 'crows', 'raven'], 2, 1.5, 15],
    wind_gust:       [['wind howl', 'wind blowing', 'strong wind'], 2, 4, 40],
    creak:           [['metal creak', 'rusty metal creak', 'door creak'], 2, 1, 10],
    distant_blast:   [['distant explosion', 'explosion far away', 'artillery distant'], 2, 2, 20],
    ir_hall:         [['hall impulse response', 'church impulse response', 'room impulse response outdoor', 'stairwell impulse response'], 1, 0.8, 8]
};

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function search(q, minD, maxD) {
    const f = `license:"Creative Commons 0" duration:[${minD} TO ${maxD}]`;
    const url = `https://freesound.org/search/?q=${encodeURIComponent(q)}&f=${encodeURIComponent(f)}&s=${encodeURIComponent('Downloads desc')}`;
    const html = await (await fetch(url, { headers: UA })).text();
    const out = [];
    const re = /data-similar-sounds-modal-url="\/people\/([^/]+)\/sounds\/(\d+)\/similar[\s\S]*?data-mp3="([^"]+)"[\s\S]*?data-title="([^"]*)"[\s\S]*?data-duration="([\d.]+)"/g;
    let m;
    while ((m = re.exec(html))) out.push({ author: decode(m[1]), id: m[2], mp3: m[3].replace('-lq.mp3', '-hq.mp3'), title: decode(m[4]), duration: +m[5] });
    return out;
}

const credits = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : [];
for (const [name, [queries, n, minD, maxD]] of Object.entries(WANT)) {
    const existing = fs.readdirSync(OUT).filter(f => f.startsWith(name + '_')).length;
    if (existing >= n) { console.log(`skip ${name}`); continue; }
    let results = [];
    for (const q of queries) {
        try { results.push(...(await search(q, minD, maxD)).filter(r => r.duration >= minD && r.duration <= maxD)); }
        catch (e) { console.warn(`search failed ${name}:`, e.message); }
    }
    const used = new Set(credits.map(c => c.id));
    let i = existing;
    for (const r of results) {
        if (i >= n) break;
        if (used.has(r.id)) continue;
        const file = `${name}_${i}.mp3`;
        const res = await fetch(r.mp3, { headers: UA });
        if (!res.ok) continue;
        fs.writeFileSync(path.join(OUT, file), Buffer.from(await res.arrayBuffer()));
        credits.push({ file, title: r.title, author: r.author, id: r.id, duration: r.duration, license: 'CC0', url: `https://freesound.org/people/${r.author}/sounds/${r.id}/` });
        console.log(`${file}  <-  "${r.title}" by ${r.author} (${r.duration.toFixed(1)}s)`);
        i++;
    }
    if (i < n) console.warn(`only found ${i}/${n} for ${name}`);
}
fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 1));
