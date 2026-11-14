import * as THREE from '/node_modules/three/build/three.module.js';
import { RGBELoader } from '/node_modules/three/examples/jsm/loaders/RGBELoader.js';
import { loadKTX2 } from './AssetLoaders.js';
import { assetStream } from './AssetStream.js';

/**
 * Loader for the real photo-scanned CC0 assets in /assets/polyhaven
 * (textures + HDRI skies from Poly Haven, CC0 / public domain).
 * Each level loads only the handful of 1k maps and the one HDRI it needs.
 * Everything falls back to the procedural textures if a file is missing.
 */
const BASE = '/assets/polyhaven/';
const texCache = new Map();
let hdrCache = new Map();
let current = null;

async function loadTexSet(name) {
    if (texCache.has(name)) {
        const set = texCache.get(name);
        texCache.delete(name); texCache.set(name, set);
        return set;
    }
    const map = await loadKTX2(`/assets/ktx2/${name}_diff.ktx2`);
    if (map) map.colorSpace = THREE.SRGBColorSpace;
    const set = map ? { map, normalMap: null, normalPromise: null } : await loadJpgSet(name);
    texCache.set(name, set);
    return set;
}

/**
 * Full PBR set straight from Poly Haven's 1k JPGs (colour + GL normal + roughness)
 * in /assets/textures/city. Used for sets that haven't been run through the KTX2
 * compressor; the roughness/normal maps make them read noticeably more real.
 */
const jpgLoader = new THREE.TextureLoader();
function loadJpg(url, srgb) {
    return new Promise(resolve => jpgLoader.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        resolve(t);
    }, undefined, () => resolve(null)));
}
async function loadJpgSet(name) {
    const base = `/assets/textures/city/${name}`;
    const [map, normalMap, roughnessMap] = await Promise.all([
        loadJpg(`${base}_diff_1k.jpg`, true), loadJpg(`${base}_nor_gl_1k.jpg`, false), loadJpg(`${base}_rough_1k.jpg`, false)
    ]);
    if (!map) { normalMap?.dispose(); roughnessMap?.dispose(); return null; }
    return { map, normalMap, roughnessMap, roughness: 1, normalPromise: null, pbr: true };
}

function loadHDR(name) {
    if (hdrCache.has(name)) {
        const entry = hdrCache.get(name);
        hdrCache.delete(name); hdrCache.set(name, entry);
        return entry.promise;
    }
    const entry = { texture: null, promise: null, settled: false };
    entry.promise = assetStream.request(`hdr:${name}`, () => new Promise((resolve) => {
        new RGBELoader().load(`${BASE}${name}_1k.hdr`, (t) => {
            t.mapping = THREE.EquirectangularReflectionMapping;
            resolve(t);
        }, undefined, () => resolve(null));
    }), 1).then(texture => { entry.texture = texture; entry.settled = true; return texture; });
    hdrCache.set(name, entry);
    return entry.promise;
}

export async function loadPhotoAssets(names = [], hdrName = null) {
    const tex = {};
    const [hdr] = await Promise.all([
        hdrName ? loadHDR(hdrName) : Promise.resolve(null),
        Promise.all(names.map(async (n) => { tex[n] = await loadTexSet(n); }))
    ]);
    current = { tex, hdr, hdrName };
    return current;
}

export function getPhoto() { return current; }

export function requestPhotoDetail(name) {
    const set = texCache.get(name);
    if (!set) return Promise.resolve(null);
    if (set.normalMap) return Promise.resolve(set.normalMap);
    if (!set.normalPromise) set.normalPromise = loadKTX2(`/assets/ktx2/${name}_nor.ktx2`, { priority: 10 }).then(texture => {
        if (texCache.get(name) !== set) { texture?.dispose(); return null; }
        if (texture) texture.colorSpace = THREE.NoColorSpace;
        set.normalMap = texture;
        set.normalPromise = null;
        return texture;
    });
    return set.normalPromise;
}

export function trimPhotoCache(maxSets = 12, maxHDRs = 2) {
    const active = new Set(Object.keys(current?.tex || {}));
    for (const [name, set] of texCache) {
        if (texCache.size <= Math.max(maxSets, active.size)) break;
        if (active.has(name)) continue;
        set?.map.dispose(); set?.normalMap?.dispose();
        texCache.delete(name);
    }
    for (const [name, entry] of hdrCache) {
        if (hdrCache.size <= maxHDRs) break;
        if (!entry.settled || name === current?.hdrName) continue;
        entry.texture?.dispose(); hdrCache.delete(name);
    }
}

export function getPhotoCacheStats() {
    return { textureSets: texCache.size, hdrs: hdrCache.size,
        normalMaps: [...texCache.values()].filter(set => set?.normalMap).length };
}

/**
 * Reads the HDRI once: average horizon colour (so fog can match the sky) and
 * the sun direction (so shadows match the sky when a real sun is visible).
 */
export function analyzeHDR(tex) {
    const { data, width: w, height: h } = tex.image;
    const half = data instanceof Uint16Array;
    const rd = half ? (v) => THREE.DataUtils.fromHalfFloat(v) : (v) => v;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.floor(h * 0.46); y < Math.floor(h * 0.54); y++) {
        for (let x = 0; x < w; x += 4) {
            const i = (y * w + x) * 4;
            r += Math.min(3, rd(data[i])); g += Math.min(3, rd(data[i + 1])); b += Math.min(3, rd(data[i + 2])); n++;
        }
    }
    const horizon = new THREE.Color().setRGB(r / n, g / n, b / n, THREE.LinearSRGBColorSpace);
    let best = 0, bx = 0, by = 0;
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            const l = rd(data[i]) + rd(data[i + 1]) + rd(data[i + 2]);
            if (l > best) { best = l; bx = x; by = y; }
        }
    }
    let sun = null;
    const el = (0.5 - (by + 0.5) / h) * Math.PI;
    if (best > 60 && el > 0.15) {
        const phi = ((bx + 0.5) / w - 0.5) * Math.PI * 2;
        sun = new THREE.Vector3(Math.cos(phi) * Math.cos(el), Math.sin(el), Math.sin(phi) * Math.cos(el));
    }
    return { horizon, sun, peak: best };
}
