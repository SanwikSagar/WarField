import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Procedural PBR-style texture factory. Every surface is built from properly
 * TILEABLE multi-octave value noise (no visible seams), shaped into a height
 * field, then turned into an albedo map + tangent-space normal map. Albedo
 * textures are tagged sRGB so they are lit correctly (the old version left
 * them linear, which made everything look flat and muddy).
 *
 * API is unchanged: TextureFactory.<kind>(size, repeat) -> { map, normalMap,
 * roughness, ... } cached by key. Real photographic ground/rock/bark/leaf
 * textures are loaded separately by Foliage.js; these cover everything else
 * (concrete, sand, snow, asphalt, metal, wood, burlap, camo).
 */
const cache = new Map();
const MAX_ANISO = 8;

// ── seeded RNG so textures are identical every run ───────────────────────
function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        return (s >>> 0) / 4294967296;
    };
}

function makeCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
}

/** Tileable fractal value noise in [0,1], returned as Float32Array(size*size). */
function fbm(size, baseFreq, octaves, seed, gain = 0.5) {
    const out = new Float32Array(size * size);
    const rand = rng(seed);
    let amp = 1, norm = 0, freq = baseFreq;
    for (let o = 0; o < octaves; o++) {
        const f = Math.max(1, Math.round(freq));
        const lat = new Float32Array(f * f);
        for (let i = 0; i < lat.length; i++) lat[i] = rand();
        const step = f / size;
        for (let y = 0; y < size; y++) {
            const fy = y * step, y0 = Math.floor(fy), ty = fy - y0;
            const sy = ty * ty * (3 - 2 * ty);
            const ya = (y0 % f) * f, yb = ((y0 + 1) % f) * f;
            for (let x = 0; x < size; x++) {
                const fx = x * step, x0 = Math.floor(fx), tx = fx - x0;
                const sx = tx * tx * (3 - 2 * tx);
                const xa = x0 % f, xb = (x0 + 1) % f;
                const a = lat[ya + xa], b = lat[ya + xb], c = lat[yb + xa], d = lat[yb + xb];
                out[y * size + x] += amp * (a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy);
            }
        }
        norm += amp; amp *= gain; freq *= 2;
    }
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
}

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const lerp = (a, b, t) => a + (b - a) * t;

/** Build albedo canvas by calling colorFn(i, x, y) -> [r,g,b] (0..255). */
function paint(size, colorFn) {
    const c = makeCanvas(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            const col = colorFn(i, x, y);
            d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

/** Tangent-space normal map from a Float32 height field (tileable). */
function normalFromHeights(h, size, strength = 2.0) {
    const out = makeCanvas(size);
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
            const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
            const i = (y * size + x) * 4;
            d[i] = (dx * inv * 0.5 + 0.5) * 255;
            d[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
            d[i + 2] = (inv * 0.5 + 0.5) * 255;
            d[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return out;
}

function colorTex(canvas, repeat) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = MAX_ANISO;
    return t;
}
function dataTex(canvas, repeat) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = MAX_ANISO;
    return t;
}

function scalarTex(values, size, repeat, scale = 1, bias = 0) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < values.length; i++) {
        const v = Math.max(0, Math.min(1, values[i] * scale + bias)) * 255;
        d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return dataTex(canvas, repeat);
}

function finish(key, albedo, heights, size, repeat, normalStrength, extra = {}) {
    const set = {
        map: colorTex(albedo, repeat),
        normalMap: dataTex(normalFromHeights(heights, size, normalStrength), repeat),
        roughnessMap: scalarTex(heights, size, repeat, 0.42, 0.56),
        aoMap: scalarTex(heights, size, repeat, -0.3, 0.92),
        bumpMap: scalarTex(heights, size, repeat, 1, 0),
        bumpScale: 0.035,
        ...extra
    };
    cache.set(key, set);
    return set;
}
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

export const TextureFactory = {
    /** Dark forest-floor / mud fallback. */
    ground(size = 512, repeat = 40) {
        const key = `ground${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 4, 4, 11), mid = fbm(size, 16, 4, 12), hi = fbm(size, 64, 3, 13), leaf = fbm(size, 32, 2, 14);
        const h = new Float32Array(size * size);
        const dirtA = [66, 52, 38], dirtB = [92, 76, 54], moss = [56, 64, 38], litter = [110, 84, 50];
        const c = paint(size, (i) => {
            h[i] = mid[i] * 0.6 + hi[i] * 0.4;
            let col = mix3(dirtA, dirtB, lo[i]);
            col = mix3(col, moss, clamp01((mid[i] - 0.5) * 3) * 0.7);
            col = mix3(col, litter, clamp01((leaf[i] - 0.62) * 6) * 0.6);
            return mul3(col, 0.78 + hi[i] * 0.45);
        });
        return finish(key, c, h, size, repeat, 3.2, { roughness: 0.95 });
    },

    /** Sun-baked sand with ripples — Dustland. */
    sand(size = 512, repeat = 40) {
        const key = `sand${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 3, 4, 21), grain = fbm(size, 128, 2, 22), warp = fbm(size, 6, 3, 23);
        const h = new Float32Array(size * size);
        const a = [186, 160, 112], b = [212, 188, 140], dark = [150, 124, 86];
        const c = paint(size, (i, x, y) => {
            const ripple = Math.sin((y / size) * Math.PI * 2 * 14 + warp[i] * 14) * 0.5 + 0.5;
            h[i] = ripple * 0.5 + grain[i] * 0.5;
            let col = mix3(a, b, lo[i]);
            col = mix3(col, dark, (1 - ripple) * 0.28);
            return mul3(col, 0.86 + grain[i] * 0.3);
        });
        return finish(key, c, h, size, repeat, 1.6, { roughness: 1.0 });
    },

    /** Packed snow with wind crust — Frostland. */
    snow(size = 512, repeat = 40) {
        const key = `snow${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 4, 4, 31), grain = fbm(size, 96, 2, 32), mid = fbm(size, 18, 3, 33);
        const h = new Float32Array(size * size);
        const a = [226, 234, 242], b = [196, 210, 226], dirt = [150, 148, 140];
        const c = paint(size, (i) => {
            h[i] = lo[i] * 0.5 + mid[i] * 0.3 + grain[i] * 0.2;
            let col = mix3(a, b, clamp01((mid[i] - 0.4) * 2.2));
            col = mix3(col, dirt, clamp01((lo[i] - 0.68) * 4) * 0.25);
            const sparkle = grain[i] > 0.82 ? 14 : 0;
            return [col[0] + sparkle, col[1] + sparkle, col[2] + sparkle];
        });
        return finish(key, c, h, size, repeat, 1.0, { roughness: 0.65 });
    },

    /** Weathered concrete: aggregate, stains, pits, panel seams, cracks. */
    concrete(size = 512, repeat = 20) {
        const key = `concrete${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 3, 4, 41), mid = fbm(size, 14, 4, 42), hi = fbm(size, 90, 2, 43), stain = fbm(size, 5, 3, 44);
        const h = new Float32Array(size * size);
        const base = [128, 127, 123], dark = [88, 88, 86], stainC = [84, 80, 72];
        const r = rng(45);
        // Seams + cracks stamped into a mask
        const mask = new Float32Array(size * size);
        const panel = size / 2;
        for (let i = 0; i < size; i++) {
            for (let t = -1; t <= 1; t++) {
                mask[((i + size) % size) * size + ((Math.floor(panel) + t + size) % size)] = Math.max(0.5, 1 - Math.abs(t) * 0.45);
                mask[((Math.floor(panel) + t + size) % size) * size + i] = Math.max(0.5, 1 - Math.abs(t) * 0.45);
                mask[((i + size) % size) * size + ((0 + t + size) % size)] = Math.max(0.5, 1 - Math.abs(t) * 0.45);
                mask[((0 + t + size) % size) * size + i] = Math.max(0.5, 1 - Math.abs(t) * 0.45);
            }
        }
        for (let k = 0; k < 5; k++) {
            let x = r() * size, y = r() * size, ang = r() * Math.PI * 2;
            const len = 40 + r() * 90;
            for (let s = 0; s < len; s++) {
                ang += (r() - 0.5) * 0.7;
                x += Math.cos(ang) * 1.6; y += Math.sin(ang) * 1.6;
                const xi = ((Math.floor(x) % size) + size) % size, yi = ((Math.floor(y) % size) + size) % size;
                mask[yi * size + xi] = 1;
            }
        }
        const c = paint(size, (i) => {
            const pit = hi[i] > 0.74 ? 0.6 : 1;
            h[i] = (mid[i] * 0.5 + hi[i] * 0.3 + lo[i] * 0.2) - mask[i] * 0.55;
            let col = mix3(base, dark, clamp01((lo[i] - 0.45) * 2.2));
            col = mix3(col, stainC, clamp01((stain[i] - 0.55) * 3) * 0.55);
            col = mul3(col, (0.8 + mid[i] * 0.4 + hi[i] * 0.2) * pit);
            return mul3(col, 1 - mask[i] * 0.55);
        });
        return finish(key, c, h, size, repeat, 2.4, { roughness: 0.92 });
    },

    /** Cracked asphalt / urban ground — Deadzone. */
    asphalt(size = 512, repeat = 40) {
        const key = `asphalt${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 4, 4, 51), grain = fbm(size, 140, 2, 52), mid = fbm(size, 24, 3, 53);
        const h = new Float32Array(size * size);
        const r = rng(54);
        const crack = new Float32Array(size * size);
        for (let k = 0; k < 7; k++) {
            let x = r() * size, y = r() * size, ang = r() * Math.PI * 2;
            const len = 60 + r() * 140;
            for (let s = 0; s < len; s++) {
                ang += (r() - 0.5) * 0.6;
                x += Math.cos(ang) * 1.5; y += Math.sin(ang) * 1.5;
                const xi = ((Math.floor(x) % size) + size) % size, yi = ((Math.floor(y) % size) + size) % size;
                crack[yi * size + xi] = 1;
            }
        }
        const c = paint(size, (i) => {
            h[i] = mid[i] * 0.4 + grain[i] * 0.6 - crack[i] * 0.7;
            const v = 70 + lo[i] * 26 + grain[i] * 34 + (grain[i] > 0.8 ? 30 : 0);
            const col = [v, v, v + 2];
            return mul3(col, 1 - crack[i] * 0.7);
        });
        return finish(key, c, h, size, repeat, 2.2, { roughness: 0.88 });
    },

    /** Painted steel with chipped paint, rust and light brushing — props. */
    metal(size = 256, repeat = 2) {
        const key = `metal${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 4, 3, 61), grain = fbm(size, 64, 2, 62), rustN = fbm(size, 9, 4, 63);
        const h = new Float32Array(size * size);
        const steel = [86, 90, 94], rust = [118, 66, 36];
        const c = paint(size, (i, x, y) => {
            const streak = Math.sin(y * 0.9 + grain[i] * 6) * 0.5 + 0.5;
            h[i] = grain[i] * 0.5 + streak * 0.2 + rustN[i] * 0.3;
            let col = mul3(steel, 0.8 + lo[i] * 0.4 + streak * 0.08);
            col = mix3(col, rust, clamp01((rustN[i] - 0.58) * 4) * 0.7);
            return col;
        });
        return finish(key, c, h, size, repeat, 1.4, { metalness: 0.7, roughness: 0.5 });
    },

    /** Corrugated shipping-container / roof sheet with paint wear. */
    corrugated(size = 256, repeat = 1) {
        const key = `corr${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const lo = fbm(size, 3, 3, 71), grain = fbm(size, 5, 3, 72), wear = fbm(size, 7, 4, 73);
        const h = new Float32Array(size * size);
        const c = paint(size, (i, x) => {
            const rib = Math.sin((x / size) * Math.PI * 2 * 12) * 0.5 + 0.5;
            h[i] = rib * 0.95 + grain[i] * 0.05;
            let v = 0.7 + lo[i] * 0.35 + (rib - 0.5) * 0.25 + (grain[i] - 0.5) * 0.15;
            let col = [236 * v, 236 * v, 236 * v];            // near-white base, tinted by material colour
            const rusty = clamp01((wear[i] - 0.6) * 4);
            col = mix3(col, [150, 88, 52], rusty * 0.7);
            return col;
        });
        return finish(key, c, h, size, repeat, 2.0, { metalness: 0.45, roughness: 0.62 });
    },

    /** Wood planks with grain + nail rows (crates). */
    wood(size = 256, repeat = 1) {
        const key = `wood${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const h = new Float32Array(size * size);
        const r = rng(81);
        const planks = 4, ph = size / planks;
        const offs = Array.from({ length: planks }, () => r());
        const grainN = fbm(size, 24, 3, 82), big = fbm(size, 5, 3, 83);
        const c = paint(size, (i, x, y) => {
            const p = Math.floor(y / ph);
            const gx = (x / size) * 6 + offs[p] * 10;
            const ring = Math.sin(gx * 6 + grainN[i] * 8 + big[i] * 6) * 0.5 + 0.5;
            const edge = Math.min(y % ph, ph - (y % ph));
            const seam = edge < 2 ? 0.45 + edge * 0.27 : 1;
            h[i] = ring * 0.4 + grainN[i] * 0.3 - (edge < 2 ? 0.5 : 0);
            const base = mix3([96, 70, 42], [140, 104, 64], ring * 0.7 + big[i] * 0.3);
            return mul3(base, seam * (0.85 + grainN[i] * 0.25));
        });
        return finish(key, c, h, size, repeat, 2.0, { roughness: 0.85 });
    },

    /** Woven burlap (sandbags). */
    burlap(size = 256, repeat = 1) {
        const key = `burlap${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const n = fbm(size, 12, 3, 91), dirt = fbm(size, 5, 3, 92);
        const h = new Float32Array(size * size);
        const c = paint(size, (i, x, y) => {
            const wx = Math.sin(x * 0.62) * 0.5 + 0.5, wy = Math.sin(y * 0.62) * 0.5 + 0.5;
            const weave = wx * wy * 0.6 + (wx + wy) * 0.2;
            h[i] = weave + n[i] * 0.2;
            const base = mix3([138, 120, 84], [166, 148, 104], n[i]);
            return mul3(mix3(base, [96, 82, 58], clamp01((dirt[i] - 0.5) * 2) * 0.5), 0.72 + weave * 0.4);
        });
        return finish(key, c, h, size, repeat, 2.4, { roughness: 1.0 });
    },

    /** Digital/woodland camo for military vehicles. */
    camo(size = 256, repeat = 2) {
        const key = `camo${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const a = fbm(size, 4, 3, 101), b = fbm(size, 7, 3, 102), g = fbm(size, 70, 2, 103), wear = fbm(size, 10, 4, 104);
        const h = new Float32Array(size * size);
        const cols = [[72, 82, 54], [52, 60, 40], [96, 92, 64], [38, 42, 30]];
        const c = paint(size, (i) => {
            let col;
            if (a[i] > 0.58) col = cols[2]; else if (b[i] > 0.56) col = cols[1]; else if (a[i] < 0.34) col = cols[3]; else col = cols[0];
            h[i] = g[i] * 0.6 + a[i] * 0.2;
            col = mul3(col, 0.84 + g[i] * 0.34);
            return mix3(col, [110, 100, 82], clamp01((wear[i] - 0.66) * 4) * 0.5);
        });
        return finish(key, c, h, size, repeat, 1.2, { roughness: 0.82 });
    },

    /** Fired clay brick with mortar, per-brick tone and weathering. */
    brick(size = 512, repeat = 1) {
        const key = `brick${size}${repeat}`;
        if (cache.has(key)) return cache.get(key);
        const n = fbm(size, 24, 3, 301), lo = fbm(size, 4, 3, 302), stain = fbm(size, 6, 3, 303);
        const r = rng(304);
        const rows = 20, cols = 9, bh = size / rows, bw = size / cols, mortar = Math.max(2, size / 128);
        const tone = [];
        for (let j = 0; j < rows; j++) { tone[j] = []; for (let i = 0; i <= cols; i++) tone[j][i] = r(); }
        const h = new Float32Array(size * size);
        const c = paint(size, (idx, x, y) => {
            const j = Math.floor(y / bh), off = (j % 2) * bw / 2;
            const xx = (x + off) % size;
            const i = Math.floor(xx / bw);
            const fx = xx - i * bw, fy = y - j * bh;
            const isMortar = fx < mortar || fy < mortar * 0.8;
            h[idx] = isMortar ? 0.1 : 0.7 + n[idx] * 0.3;
            if (isMortar) return mul3([168, 160, 146], 0.8 + n[idx] * 0.3);
            const t = tone[j][i];
            let col = mix3([142, 74, 52], [176, 104, 72], t);
            col = mix3(col, [96, 60, 48], clamp01((lo[idx] - 0.55) * 3) * 0.5);
            col = mix3(col, [70, 66, 58], clamp01((stain[idx] - 0.62) * 4) * 0.5);
            return mul3(col, 0.82 + n[idx] * 0.36);
        });
        return finish(key, c, h, size, repeat, 2.6, { roughness: 0.9 });
    },

    /** Chain-link fence (alpha-tested diamond mesh). */
    chainlink(size = 128) {
        const key = `chain${size}`;
        if (cache.has(key)) return cache.get(key);
        const c = makeCanvas(size);
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = 'rgba(170,176,182,1)';
        ctx.lineWidth = 2.2;
        const s = size / 4;
        ctx.beginPath();
        for (let k = -4; k <= 8; k++) {
            ctx.moveTo(k * s, 0); ctx.lineTo(k * s + size, size);
            ctx.moveTo(k * s + size, 0); ctx.lineTo(k * s, size);
        }
        ctx.stroke();
        const t = new THREE.CanvasTexture(c);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        cache.set(key, t);
        return t;
    },

    /** Soft-edged strip alpha for dirt paths (opaque centre, ragged fade). */
    pathAlpha(size = 128) {
        const key = `pathA${size}`;
        if (cache.has(key)) return cache.get(key);
        const n = fbm(size, 8, 3, 311);
        const d = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const u = Math.abs(x / (size - 1) - 0.5) * 2;                  // 0 centre .. 1 edge
            const a = clamp01((1 - u + (n[y * size + x] - 0.5) * 0.55) * 2.4);
            const i = (y * size + x) * 4;
            d[i] = d[i + 1] = d[i + 2] = a * 255; d[i + 3] = 255;   // alphaMap reads green
        }
        const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = t.minFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        cache.set(key, t);
        return t;
    },

    /** Low-frequency 2-channel noise mask used to blend/de-tile ground layers. */
    mask(size = 256) {
        const key = `mask${size}`;
        if (cache.has(key)) return cache.get(key);
        const a = fbm(size, 4, 4, 201), b = fbm(size, 9, 4, 202), c = fbm(size, 14, 5, 203), e = fbm(size, 40, 3, 204);
        const d = new Uint8Array(size * size * 4);
        for (let i = 0; i < size * size; i++) {
            d[i * 4] = Math.min(255, a[i] * 255 * 1.15);
            d[i * 4 + 1] = Math.min(255, b[i] * 255 * 1.15);
            d[i * 4 + 2] = Math.min(255, c[i] * 255 * 1.15);
            d[i * 4 + 3] = Math.min(255, e[i] * 255 * 1.15);   // r macro, g mid, b fine, a very fine
        }
        const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = t.minFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        cache.set(key, t);
        return t;
    },

    /** Radial soft particle used for muzzle flash / smoke / fire sprites. */
    radialGradient(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
        const key = `radial${inner}${outer}${size}`;
        if (cache.has(key)) return cache.get(key);
        const c = makeCanvas(size);
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, inner);
        g.addColorStop(1, outer);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        cache.set(key, tex);
        return tex;
    }
};

export function setTextureAnisotropy(n) {
    cache.forEach(set => {
        if (set.isTexture) { set.anisotropy = n; return; }
        if (set.map) set.map.anisotropy = n;
        if (set.normalMap) set.normalMap.anisotropy = n;
    });
}
