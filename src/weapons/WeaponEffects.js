import * as THREE from '/node_modules/three/build/three.module.js';
import { DecalBatch, CELL, HOLE_CELL } from '../render/DecalAtlas.js';

/**
 * Gunplay VFX, built to read as real footage rather than "game sparks":
 *  - muzzle flash: star-shaped core + side prongs + short dynamic light,
 *    followed by a lingering grey muzzle-smoke wisp
 *  - impacts: material-aware (dirt plumes, concrete dust + chips, metal sparks),
 *    soft smoke puffs that expand, drift with the wind and fade
 *  - blood mist + droplets on hits
 *  - bullet-hole decals with a crater ring; casings bounce on the real terrain
 * All particles are pooled sprites/meshes with hard caps so sustained fire
 * never grows memory or draw calls without bound.
 */
function canvasTex(size, draw) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

// ── tileable value-noise fBm for photographic-looking particle textures ──
function hash2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, s, p) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const w = (i) => ((i % p) + p) % p;
    const a = hash2(w(xi), w(yi), s), b = hash2(w(xi + 1), w(yi), s), c = hash2(w(xi), w(yi + 1), s), d = hash2(w(xi + 1), w(yi + 1), s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s, oct = 5, base = 4) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) { sum += vnoise(x * base * f, y * base * f, s + o * 17, base * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return sum / norm;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Build an RGBA texture pixel by pixel: fn(u, v) -> [r, g, b, a] in 0..1. */
function pixelTex(size, fn) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const [r, g, b, a] = fn((x + 0.5) / size, (y + 0.5) / size);
        const i = (y * size + x) * 4;
        img.data[i] = r * 255; img.data[i + 1] = g * 255; img.data[i + 2] = b * 255; img.data[i + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

/** Billowy smoke/dust: fBm density, soft edge, lit from above (self-shadowed underside). */
function smokeTex(seed) {
    return pixelTex(128, (u, v) => {
        const dx = u - 0.5, dy = v - 0.5, d = Math.hypot(dx, dy) * 2;
        const n = fbm(u, v, seed, 5, 3);
        const warp = fbm(u + n * 0.3, v + n * 0.3, seed + 5, 4, 5);
        const dens = sstep(0.0, 0.55, (warp * 1.15 + 0.15) - d * d * 0.95) * sstep(1.0, 0.72, d);
        const light = 0.62 + 0.38 * (1 - v) + (n - 0.5) * 0.35;
        return [light, light, light, dens * 0.85];
    });
}

/** Muzzle flash seen head-on: 5-7 noisy petals around a white-hot core. */
function flashTex(seed) {
    const r = rng(seed * 31 + 7);
    const petals = [];
    const n = 5 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) petals.push({ a: (i / n) * Math.PI * 2 + (r() - 0.5) * 0.5, len: 0.55 + r() * 0.4, w: 6 + r() * 6 });
    return pixelTex(128, (u, v) => {
        const dx = u - 0.5, dy = v - 0.5, rad = Math.hypot(dx, dy) * 2, ang = Math.atan2(dy, dx);
        let reach = 0.18;
        for (const p of petals) {
            const c = Math.max(0, Math.cos(ang - p.a));
            reach = Math.max(reach, p.len * Math.pow(c, p.w));
        }
        reach *= 0.85 + 0.3 * fbm(u, v, seed, 3, 6);
        const k = sstep(reach, reach * 0.25, rad);
        const core = sstep(0.32, 0.0, rad);
        const heat = Math.min(1, core + k * 0.6);
        return [1, 0.55 + 0.45 * heat, 0.18 + 0.75 * core, Math.min(1, k * 0.95 + core)];
    });
}

/** Bullet hole decal per surface: crater, scorch / chipped rim and debris speckle. */
function holeTex(kind) {
    const seed = { dirt: 3, concrete: 5, metal: 9, wood: 13 }[kind] || 3;
    return pixelTex(64, (u, v) => {
        const dx = u - 0.5, dy = v - 0.5, d = Math.hypot(dx, dy) * 2, ang = Math.atan2(dy, dx);
        const n = fbm(u, v, seed, 4, 4);
        const jag = d + (n - 0.5) * 0.35;
        if (kind === 'metal') {
            const hole = sstep(0.2, 0.14, d);
            const rim = sstep(0.42, 0.22, jag) * (1 - hole);
            const c = 0.05 * hole + (0.55 + n * 0.3) * rim;
            return [c, c, c * 1.05, Math.max(hole, rim * 0.8)];
        }
        if (kind === 'wood') {
            const split = Math.pow(Math.abs(Math.cos(ang)), 18) * sstep(0.95, 0.2, d);
            const hole = sstep(0.24, 0.12, jag);
            const a = Math.max(hole, split * 0.8, sstep(0.55, 0.25, jag) * 0.35);
            return [0.12 + 0.15 * (1 - hole), 0.08 + 0.1 * (1 - hole), 0.05, a];
        }
        const hole = sstep(0.22, 0.12, jag);
        const ring = sstep(kind === 'dirt' ? 0.95 : 0.7, 0.25, jag) * (1 - hole);
        const speck = hash2(Math.floor(u * 64), Math.floor(v * 64), seed) > 0.86 ? sstep(0.95, 0.4, d) : 0;
        const tone = kind === 'dirt' ? 0.16 + n * 0.12 : 0.62 + n * 0.18;     // concrete chips lighter, soil darker
        const c = hole * 0.04 + (1 - hole) * tone;
        return [c, c * 0.97, c * 0.93, Math.max(hole, ring * (kind === 'dirt' ? 0.7 : 0.5), speck * 0.5)];
    });
}

/** Blood mist / spatter: clustered noisy blobs with satellite droplets. */
function bloodTex(seed) {
    const r = rng(seed);
    const drops = Array.from({ length: 10 }, () => ({ x: 0.5 + (r() - 0.5) * 0.8, y: 0.5 + (r() - 0.5) * 0.8, s: 0.02 + r() * 0.05 }));
    return pixelTex(96, (u, v) => {
        const d = Math.hypot(u - 0.5, v - 0.5) * 2;
        const n = fbm(u, v, seed, 5, 4);
        let a = sstep(0.62, 0.2, d + (n - 0.5) * 0.7);
        for (const p of drops) a = Math.max(a, sstep(p.s, p.s * 0.4, Math.hypot(u - p.x, v - p.y)));
        const dark = 0.55 + n * 0.45;
        return [0.42 * dark, 0.03 * dark, 0.02 * dark, a * 0.92];
    });
}

const TEX = {};
function textures() {
    if (TEX.smoke) return TEX;
    // soft, lumpy smoke puff
    TEX.smoke = canvasTex(128, (g, s) => {
        const r = rng(7);
        for (let i = 0; i < 26; i++) {
            const x = s / 2 + (r() - 0.5) * s * 0.45, y = s / 2 + (r() - 0.5) * s * 0.45, rad = s * (0.12 + r() * 0.2);
            const gr = g.createRadialGradient(x, y, 0, x, y, rad);
            gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = gr; g.fillRect(0, 0, s, s);
        }
    });
    // muzzle flash: hot core + 4-6 jagged prongs
    TEX.flash = canvasTex(128, (g, s) => {
        const r = rng(3);
        g.translate(s / 2, s / 2);
        for (let i = 0; i < 6; i++) {
            g.rotate((Math.PI * 2) / 6 + (r() - 0.5) * 0.4);
            const len = s * (0.3 + r() * 0.18);
            const gr = g.createLinearGradient(0, 0, len, 0);
            gr.addColorStop(0, 'rgba(255,245,220,1)'); gr.addColorStop(0.4, 'rgba(255,190,90,0.85)'); gr.addColorStop(1, 'rgba(255,120,30,0)');
            g.fillStyle = gr;
            g.beginPath(); g.moveTo(0, -s * 0.04); g.lineTo(len, 0); g.lineTo(0, s * 0.04); g.fill();
        }
        const core = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.18);
        core.addColorStop(0, 'rgba(255,255,240,1)'); core.addColorStop(0.5, 'rgba(255,210,120,0.9)'); core.addColorStop(1, 'rgba(255,140,40,0)');
        g.fillStyle = core; g.beginPath(); g.arc(0, 0, s * 0.18, 0, Math.PI * 2); g.fill();
    });
    // side flash (elongated cone seen from the side)
    TEX.prong = canvasTex(128, (g, s) => {
        const gr = g.createLinearGradient(0, 0, s, 0);
        gr.addColorStop(0, 'rgba(255,250,230,1)'); gr.addColorStop(0.35, 'rgba(255,190,90,0.8)'); gr.addColorStop(1, 'rgba(255,110,20,0)');
        g.fillStyle = gr; g.beginPath(); g.moveTo(0, s * 0.42); g.lineTo(s, s * 0.5); g.lineTo(0, s * 0.58); g.fill();
        g.beginPath(); g.moveTo(0, s * 0.46); g.lineTo(s * 0.7, s * 0.3); g.lineTo(s * 0.12, s * 0.5); g.fill();
        g.beginPath(); g.moveTo(0, s * 0.54); g.lineTo(s * 0.7, s * 0.7); g.lineTo(s * 0.12, s * 0.5); g.fill();
    });
    TEX.spark = canvasTex(32, (g, s) => {
        const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        gr.addColorStop(0, 'rgba(255,250,220,1)'); gr.addColorStop(0.3, 'rgba(255,190,80,0.9)'); gr.addColorStop(1, 'rgba(255,100,0,0)');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
    });
    // bullet hole: dark core, scorched ring, lighter chipped rim
    TEX.hole = canvasTex(64, (g, s) => {
        const r = rng(11), c = s / 2;
        const rim = g.createRadialGradient(c, c, s * 0.08, c, c, s * 0.48);
        rim.addColorStop(0, 'rgba(25,22,20,0.95)'); rim.addColorStop(0.35, 'rgba(60,55,50,0.6)'); rim.addColorStop(0.6, 'rgba(150,140,128,0.25)'); rim.addColorStop(1, 'rgba(150,140,128,0)');
        g.fillStyle = rim; g.fillRect(0, 0, s, s);
        for (let i = 0; i < 9; i++) { const a = r() * 6.28, d = s * (0.14 + r() * 0.2); g.fillStyle = 'rgba(30,26,24,0.6)'; g.fillRect(c + Math.cos(a) * d, c + Math.sin(a) * d, 2, 2); }
        g.fillStyle = 'rgba(8,7,6,1)'; g.beginPath(); g.arc(c, c, s * 0.08, 0, Math.PI * 2); g.fill();
    });
    TEX.blood = canvasTex(64, (g, s) => {
        const r = rng(5);
        for (let i = 0; i < 14; i++) {
            const x = s / 2 + (r() - 0.5) * s * 0.5, y = s / 2 + (r() - 0.5) * s * 0.5, rad = s * (0.08 + r() * 0.18);
            const gr = g.createRadialGradient(x, y, 0, x, y, rad);
            gr.addColorStop(0, 'rgba(120,10,8,0.55)'); gr.addColorStop(1, 'rgba(90,6,4,0)');
            g.fillStyle = gr; g.fillRect(0, 0, s, s);
        }
    });
    TEX.smokes = [1, 2, 3, 4].map(smokeTex);
    TEX.flashes = [1, 2, 3].map(flashTex);
    TEX.holes = { dirt: holeTex('dirt'), concrete: holeTex('concrete'), metal: holeTex('metal'), wood: holeTex('wood') };
    TEX.bloods = [5, 9, 14].map(bloodTex);
    TEX.smoke = TEX.smokes[0]; TEX.flash = TEX.flashes[0]; TEX.hole = TEX.holes.concrete; TEX.blood = TEX.bloods[0];
    return TEX;
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const SURF = {
    dirt: { smoke: 0x5e5040, chips: 0x4a3a2a, sparks: 0, puffs: 4, rise: 0.6, size: 0.55 },
    concrete: { smoke: 0x8a857d, chips: 0x8d8a83, sparks: 2, puffs: 3, rise: 0.4, size: 0.45 },
    metal: { smoke: 0x5a5a5a, chips: 0x555555, sparks: 9, puffs: 1, rise: 0.3, size: 0.3 },
    wood: { smoke: 0x6e604c, chips: 0x6b4f33, sparks: 0, puffs: 2, rise: 0.4, size: 0.4 }
};

/**
 * Every effect object is created ONCE, when the level starts, and recycled: fixed-size ring
 * buffers of tracers, casings, smoke/blood sprites, spark streaks, debris chips and decals.
 * Spawning writes into the oldest slot (exactly what the old "drop the oldest" caps did), so
 * firing never allocates meshes, materials or geometry and never triggers shader work or GC.
 */
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

class Ring {
    constructor(n, make) { this.items = []; for (let i = 0; i < n; i++) this.items.push(make(i)); this.next = 0; }
    take() { const it = this.items[this.next]; this.next = (this.next + 1) % this.items.length; return it; }
}

export class WeaponEffects {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.heightAt = null;             // set by WeaponManager so casings land on terrain
        this.quality = 1;                 // particle density multiplier (Extreme = 1.6)
        this.maxDecals = 60;
        this._flashTimer = 0;
        this.T = textures();
        this._shellGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.045, 6);
        this._shellMat = new THREE.MeshStandardMaterial({ color: 0xb08d3a, metalness: 0.9, roughness: 0.3 });
        this._chipGeo = new THREE.BoxGeometry(1, 1, 1);
        this._wind = new THREE.Vector3(0.35, 0, 0.15);
        this._camPos = new THREE.Vector3();
        // unit tracer streak, scaled per shot
        this._tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 4, 1, true);
        this._tracerGeo.translate(0, 0.5, 0); this._tracerGeo.rotateX(Math.PI / 2);
        const add = (o) => { o.visible = false; o.frustumCulled = false; scene.add(o); return o; };

        this.tracers = new Ring(40, () => ({
            mesh: add(new THREE.Mesh(this._tracerGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))),
            dir: new THREE.Vector3(), life: 0, maxLife: 1, speed: 0, travelled: 0, total: 0, on: false
        }));
        this.shells = new Ring(40, () => ({
            mesh: add(new THREE.Mesh(this._shellGeo, this._shellMat)), vel: new THREE.Vector3(), angVel: new THREE.Vector3(), life: 0, bounces: 0, on: false
        }));
        this.sprites = new Ring(260, () => ({
            o: add(new THREE.Sprite(new THREE.SpriteMaterial({ map: this.T.smoke, transparent: true, depthWrite: false, opacity: 0 }))),
            vel: new THREE.Vector3(), life: 0, max: 1, grav: 0, size0: 0, size1: 0, opacity: 0, smoke: false, grow: 0, spin: 0, on: false
        }));
        this.sparks = new Ring(40, () => {
            const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
            return { o: add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffc070, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }))),
                head: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, max: 0.5, on: false };
        });
        this.chips = new Ring(80, () => ({
            o: add(new THREE.Mesh(this._chipGeo, this._chipMat(0x8d8a83))), vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, on: false
        }));
        // bullet holes + blood: one instanced draw from the shared decal atlas, oldest recycled first
        this.decals = new DecalBatch(scene, 160, { ring: true });
        // NPC muzzle flashes: small sprite pool (no real-time lights: the glow is the sprite + bloom)
        this._npcFlashes = [];
        for (let i = 0; i < 6; i++) {
            const s = add(new THREE.Sprite(new THREE.SpriteMaterial({ map: this.T.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 })));
            this._npcFlashes.push({ s, life: 0 });
        }
        this._npcFlashIndex = 0;
    }

    /** Third-person muzzle flash + smoke for NPC shots. */
    npcMuzzleFlash(pos, dir) {
        if (!this._npcFlashes.length) return;
        const f = this._npcFlashes[this._npcFlashIndex++ % this._npcFlashes.length];
        f.s.position.copy(pos);
        f.s.scale.setScalar(0.35 + Math.random() * 0.25);
        f.s.material.rotation = Math.random() * Math.PI * 2;
        f.s.material.opacity = 1;
        f.s.material.map = pick(this.T.flashes);
        f.s.visible = true;
        f.life = 0.05;
        if (Math.random() < 0.5) this._puff(pos, 0x5e5c5a, 0.08, 0.4, 0.8 + Math.random() * 0.4, dir.x * 0.8, dir.y * 0.8 + 0.3, dir.z * 0.8, 0.14);
    }

    /** Dust burst where a body hits the ground. */
    bodyFall(pos, color = 0x7d6a52) {
        for (let i = 0; i < Math.round(5 * this.quality); i++) {
            const a = Math.random() * Math.PI * 2;
            _v1.set(pos.x + Math.cos(a) * 0.3, pos.y + 0.1, pos.z + Math.sin(a) * 0.3);
            this._puff(_v1, color, 0.25, 1.0 + Math.random() * 0.5, 1.2 + Math.random() * 0.8,
                Math.cos(a) * (0.8 + Math.random()), 0.3 + Math.random() * 0.4, Math.sin(a) * (0.8 + Math.random()), 0.32);
        }
    }

    /** Footstep dust kicked up by running NPCs on dry ground. */
    footDust(pos, color = 0x8a7656) {
        _v1.copy(pos); _v1.y += 0.08;
        this._puff(_v1, color, 0.12, 0.45, 0.7 + Math.random() * 0.4, (Math.random() - 0.5) * 0.4, 0.25 + Math.random() * 0.2, (Math.random() - 0.5) * 0.4, 0.2);
    }

    // ── muzzle (created once per weapon at equip time, not per shot) ─────
    createMuzzleFlash(parent, position) {
        const addS = (mat) => { const s = new THREE.Sprite(mat); s.position.copy(position); parent.add(s); return s; };
        const core = addS(new THREE.SpriteMaterial({ map: this.T.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
        const prongMat = new THREE.MeshBasicMaterial({ map: this.T.prong, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide });
        const prongs = new THREE.Group();
        this._prongGeo = this._prongGeo || new THREE.PlaneGeometry(0.34, 0.1);
        for (let i = 0; i < 2; i++) {
            const p = new THREE.Mesh(this._prongGeo, prongMat);
            p.position.z = -0.17; p.rotation.y = Math.PI / 2; p.rotation.x = i * Math.PI / 2;
            p.rotation.order = 'YXZ';
            prongs.add(p);
        }
        prongs.position.copy(position);
        parent.add(prongs);
        return { sprite: core, prongs, prongMat, muzzle: position.clone(), parent };
    }

    triggerMuzzleFlash(flash, suppressed = false) {
        if (!flash) return;
        const k = suppressed ? 0.35 : 1;
        const s = (0.16 + Math.random() * 0.08) * k;
        flash.sprite.material.opacity = 1;
        flash.sprite.material.map = pick(this.T.flashes);
        flash.sprite.scale.set(s, s, s);
        flash.sprite.material.rotation = Math.random() * Math.PI * 2;
        flash.prongMat.opacity = 0.9 * k;
        flash.prongs.scale.set(1, 0.8 + Math.random() * 0.5, 0.7 + Math.random() * 0.6);
        flash.prongs.rotation.z = Math.random() * Math.PI;
        this._activeFlash = flash;
        this._flashTimer = 0.045;
        // muzzle smoke wisp in world space
        flash.parent.localToWorld(_v1.copy(flash.muzzle));
        _v2.set(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(_q));
        _v1.addScaledVector(_v2, 0.05);
        this._puff(_v1, 0x5e5c5a, 0.05, 0.25, 0.9 + Math.random() * 0.4, _v2.x * 0.6, _v2.y * 0.6 + 0.25, _v2.z * 0.6, 0.18);
    }

    // ── tracer (thin, short-lived streak) ───────────────────────────────
    spawnTracer(from, to, { always = false, color = 0xffd9a0, width = 0.004, speed = 260 } = {}) {
        if (!always && Math.random() > 0.45) return;            // only some rounds are visible
        _v1.subVectors(to, from);
        const total = _v1.length();
        if (total < 1.6) return;
        const len = Math.min(total, 2.5);
        const t = this.tracers.take();
        t.dir.copy(_v1).normalize();
        t.mesh.material.color.setHex(color);
        t.mesh.material.opacity = 0.75;
        t.mesh.scale.set(width, width, len);
        t.mesh.position.copy(from).addScaledVector(t.dir, 1.5);
        t.mesh.lookAt(to);
        t.mesh.visible = true;
        t.life = t.maxLife = Math.max(0.06, total / speed);
        t.speed = speed; t.travelled = 1.5; t.total = total; t.on = true;
    }

    // ── casings ──────────────────────────────────────────────────────────
    spawnShell(worldPos, rightVec, template = null, upVec = null, backVec = null) {
        const sh = this.shells.take();
        sh.mesh.geometry = template ? template.geometry : this._shellGeo;
        sh.mesh.material = template ? template.material : this._shellMat;
        sh.mesh.position.copy(worldPos);
        sh.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        sh.vel.copy(rightVec).multiplyScalar(1.6 + Math.random());
        if (upVec) sh.vel.addScaledVector(upVec, 1.3 + Math.random() * 0.8); else sh.vel.y += 1.8 + Math.random();
        if (backVec) sh.vel.addScaledVector(backVec, 0.4 + Math.random() * 0.5);
        sh.angVel.set(Math.random() * 25, Math.random() * 25, Math.random() * 25);
        sh.life = 6; sh.bounces = 0; sh.on = true; sh.mesh.visible = true;
    }

    // ── impacts ──────────────────────────────────────────────────────────
    spawnImpact(point, normal, surface = 'dirt') {
        const S = SURF[surface] || SURF.dirt;
        const q = this.quality;
        const n = _n.copy(normal).normalize();
        // smoke / dust plume pushed out of the surface
        for (let i = 0; i < Math.round(S.puffs * q); i++) {
            const sp = 0.6 + Math.random() * 1.2;
            _v1.copy(point).addScaledVector(n, 0.04);
            this._puff(_v1, S.smoke, S.size * (0.45 + Math.random() * 0.35), S.size * (1.8 + Math.random() * 1.4), 1.1 + Math.random() * 1.3,
                n.x * sp + (Math.random() - 0.5) * 0.6, n.y * sp + Math.random() * S.rise, n.z * sp + (Math.random() - 0.5) * 0.6, 0.5);
        }
        // dirt kick: a fast vertical spray
        if (surface === 'dirt') {
            for (let i = 0; i < Math.round(3 * q); i++) {
                const sp = 2.5 + Math.random() * 2;
                this._puff(point, 0x5a4a38, 0.08, 0.35, 0.5 + Math.random() * 0.4,
                    n.x * sp + (Math.random() - 0.5), n.y * sp + 1.5 + Math.random() * 2, n.z * sp + (Math.random() - 0.5), 0.75, 9);
            }
        }
        // sparks: hot streaks stretched along their velocity (motion-blurred like real footage)
        for (let i = 0; i < Math.round(S.sparks * q); i++) {
            const p = this.sparks.take(), sp = 2 + Math.random() * 3;
            p.vel.set(n.x * sp + (Math.random() - 0.5) * 3, n.y * sp + Math.random() * 2.5, n.z * sp + (Math.random() - 0.5) * 3);
            p.head.copy(point);
            p.life = 0.2 + Math.random() * 0.3; p.max = 0.5; p.on = true; p.o.visible = true;
        }
        // debris chips
        const chipMat = this._chipMat(S.chips);
        for (let i = 0; i < Math.round((surface === 'metal' ? 1 : 4) * q); i++) {
            const c = this.chips.take(), s = 0.008 + Math.random() * 0.018, sp = 1.5 + Math.random() * 2.5;
            c.o.material = chipMat;
            c.o.scale.set(s, s * (0.5 + Math.random()), s);
            c.o.position.copy(point).addScaledVector(n, 0.02);
            c.vel.set(n.x * sp + (Math.random() - 0.5) * 2, n.y * sp + Math.random() * 2, n.z * sp + (Math.random() - 0.5) * 2);
            c.spin.set(Math.random() * 20, Math.random() * 20, 0);
            c.life = 1.5 + Math.random(); c.on = true; c.o.visible = true;
        }
        // decal
        // (atlas cells carry the chipped rim, so they are drawn ~2.5x the size of the hole itself)
        const ds = surface === 'dirt' ? 0.3 + Math.random() * 0.15 : surface === 'wood' ? 0.2 + Math.random() * 0.08 : surface === 'metal' ? 0.32 + Math.random() * 0.1 : 0.16 + Math.random() * 0.08;
        this.decals.add(point, n, ds, HOLE_CELL[surface] ?? CELL.holeConcrete);
    }

    /** Blood mist + droplets on an enemy hit. */
    spawnHitMarker(point) {
        for (let i = 0; i < Math.round(3 * this.quality); i++) {
            const p = this.sprites.take(), m = p.o.material;
            m.map = pick(this.T.bloods); m.color.setHex(0xffffff); m.opacity = 0.9; m.rotation = Math.random() * Math.PI * 2;
            p.o.scale.setScalar(0.12 + Math.random() * 0.1);
            p.o.position.copy(point);
            p.vel.set((Math.random() - 0.5) * 1.4, Math.random() * 0.8, (Math.random() - 0.5) * 1.4);
            p.life = 0.45 + Math.random() * 0.3; p.max = 0.75; p.grav = 2.5; p.grow = 1.8; p.smoke = false; p.on = true; p.o.visible = true;
        }
        const red = this._chipMat(0x5a0806);
        for (let i = 0; i < 4; i++) {
            const c = this.chips.take();
            c.o.material = red; c.o.scale.setScalar(0.012); c.o.position.copy(point);
            c.vel.set((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3); c.spin.set(0, 0, 0);
            c.life = 0.8; c.on = true; c.o.visible = true;
        }
        // spatter on the ground below / behind the hit
        if (this.heightAt) {
            _v1.set(point.x + (Math.random() - 0.5) * 0.8, 0, point.z + (Math.random() - 0.5) * 0.8);
            _v1.y = this.heightAt(_v1.x, _v1.z) + 0.01;
            this.decals.add(_v1, _v2.set(0, 1, 0), 0.45 + Math.random() * 0.4, Math.random() < 0.5 ? CELL.bloodA : CELL.bloodB, Math.random() * 6.28, 0.85);
        }
    }

    _chipMat(color) {
        this._chipMats = this._chipMats || {};
        return this._chipMats[color] || (this._chipMats[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
    }

    /** soft smoke/dust sprite that grows, drifts with the wind and fades (pooled) */
    _puff(pos, color, size0, size1, life, vx, vy, vz, opacity, grav = -0.15) {
        const p = this.sprites.take(), m = p.o.material;
        m.map = pick(this.T.smokes); m.color.setHex(color); m.opacity = 0; m.rotation = Math.random() * Math.PI * 2;
        p.o.scale.setScalar(size0);
        p.o.position.copy(pos);
        p.vel.set(vx, vy, vz);
        p.life = p.max = life; p.grav = grav; p.size0 = size0; p.size1 = size1; p.opacity = opacity;
        p.smoke = true; p.grow = 0; p.spin = (Math.random() - 0.5) * 0.8; p.on = true; p.o.visible = true;
    }

    update(dt) {
        if (this._flashTimer > 0 && this._activeFlash) {
            this._flashTimer -= dt;
            const f = this._activeFlash;
            if (this._flashTimer <= 0) { f.sprite.material.opacity = 0; f.prongMat.opacity = 0; }
        }
        for (const t of this.tracers.items) {
            if (!t.on) continue;
            t.life -= dt;
            t.mesh.position.addScaledVector(t.dir, t.speed * dt);
            t.travelled += t.speed * dt;
            t.mesh.material.opacity = Math.max(0, t.life / t.maxLife) * 0.75;
            if (t.life <= 0 || t.travelled > t.total) { t.on = false; t.mesh.visible = false; }
        }
        for (const f of this._npcFlashes) {
            if (f.life <= 0) continue;
            f.life -= dt;
            f.s.material.opacity = Math.max(0, f.life / 0.05);
            if (f.life <= 0) f.s.visible = false;
        }
        const hAt = this.heightAt;
        for (const sh of this.shells.items) {
            if (!sh.on) continue;
            sh.life -= dt;
            if (sh.bounces < 4) {
                sh.vel.y -= 9.8 * dt;
                sh.mesh.position.addScaledVector(sh.vel, dt);
                sh.mesh.rotation.x += sh.angVel.x * dt; sh.mesh.rotation.y += sh.angVel.y * dt; sh.mesh.rotation.z += sh.angVel.z * dt;
                const gy = (hAt ? hAt(sh.mesh.position.x, sh.mesh.position.z) : 0) + 0.008;
                if (sh.mesh.position.y < gy) {
                    sh.mesh.position.y = gy;
                    sh.vel.y *= -0.32; sh.vel.x *= 0.5; sh.vel.z *= 0.5;
                    sh.angVel.multiplyScalar(0.45);
                    sh.bounces++;
                    if (sh.bounces >= 4) sh.mesh.rotation.set(Math.PI / 2, sh.mesh.rotation.y, 0);   // lie flat
                }
            }
            if (sh.life <= 0) { sh.on = false; sh.mesh.visible = false; }
        }
        const camPos = this.camera.getWorldPosition(this._camPos);
        for (const p of this.sparks.items) {
            if (!p.on) continue;
            p.life -= dt;
            const k = Math.max(0, p.life / p.max);
            p.vel.y -= 9 * dt;
            const head = p.head.addScaledVector(p.vel, dt);
            const a = p.o.geometry.attributes.position;
            a.setXYZ(0, head.x, head.y, head.z);
            a.setXYZ(1, head.x - p.vel.x * 0.025, head.y - p.vel.y * 0.025, head.z - p.vel.z * 0.025);
            a.needsUpdate = true;
            p.o.material.opacity = k;
            p.o.material.color.setRGB(1, 0.55 + 0.4 * k, 0.2 + 0.5 * k * k);    // cools from white-yellow to orange
            if (p.life <= 0) { p.on = false; p.o.visible = false; }
        }
        for (const p of this.sprites.items) {
            if (!p.on) continue;
            p.life -= dt;
            const k = Math.max(0, p.life / p.max);
            p.vel.y -= p.grav * dt;
            if (p.smoke) {
                p.vel.multiplyScalar(1 - Math.min(1, dt * 2.2));
                p.o.position.addScaledVector(this._wind, dt);
                p.o.scale.setScalar(p.size1 + (p.size0 - p.size1) * k * k);
                // fade when the camera is inside the puff instead of filling the screen with a flat sprite
                const near = sstep(0.3, 1.4, p.o.position.distanceTo(camPos) / Math.max(0.2, p.o.scale.x));
                p.o.material.opacity = p.opacity * Math.min(1, (1 - k) * 8) * k * near;
                p.o.material.rotation += p.spin * dt;
            } else {
                p.o.material.opacity = k;
                if (p.grow) p.o.scale.multiplyScalar(1 + dt * p.grow);
            }
            p.o.position.addScaledVector(p.vel, dt);
            if (p.life <= 0) { p.on = false; p.o.visible = false; }
        }
        for (const c of this.chips.items) {
            if (!c.on) continue;
            c.life -= dt;
            c.vel.y -= 9.8 * dt;
            c.o.position.addScaledVector(c.vel, dt);
            c.o.rotation.x += c.spin.x * dt; c.o.rotation.y += c.spin.y * dt;
            const gy = hAt ? hAt(c.o.position.x, c.o.position.z) : 0;
            if (c.o.position.y < gy) { c.o.position.y = gy; c.vel.multiplyScalar(0.25); c.vel.y = Math.abs(c.vel.y) * 0.2; c.spin.multiplyScalar(0.3); }
            if (c.life <= 0) { c.on = false; c.o.visible = false; }
        }
    }

    /** Level teardown: release every pooled object and its per-object material. */
    clear() {
        const drop = (o) => { this.scene.remove(o); if (o.material && !(o.material === this._shellMat) && !Object.values(this._chipMats || {}).includes(o.material)) o.material.dispose(); };
        this.tracers.items.forEach(t => drop(t.mesh));
        this.shells.items.forEach(s => this.scene.remove(s.mesh));
        this.sprites.items.forEach(p => drop(p.o));
        this.sparks.items.forEach(p => { drop(p.o); p.o.geometry.dispose(); });
        this.chips.items.forEach(c => this.scene.remove(c.o));
        this.decals.dispose();
        this._npcFlashes.forEach(f => { this.scene.remove(f.s); f.s.material.dispose(); });
        this._npcFlashes = [];
        Object.values(this._chipMats || {}).forEach(m => m.dispose());
        this._chipMats = {};
        this._shellMat.dispose();
        [this._shellGeo, this._chipGeo, this._tracerGeo].forEach(g => g.dispose());
        if (this._prongGeo) this._prongGeo.dispose();

    }
}
