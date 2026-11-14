import * as THREE from '/node_modules/three/build/three.module.js';

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
    dirt: { smoke: 0x7d6a52, chips: 0x4a3a2a, sparks: 0, puffs: 4, rise: 0.6, size: 0.55 },
    concrete: { smoke: 0xb4afa6, chips: 0x8d8a83, sparks: 2, puffs: 3, rise: 0.4, size: 0.45 },
    metal: { smoke: 0x8c8c8c, chips: 0x555555, sparks: 9, puffs: 1, rise: 0.3, size: 0.3 },
    wood: { smoke: 0x9a8566, chips: 0x6b4f33, sparks: 0, puffs: 2, rise: 0.4, size: 0.4 }
};

export class WeaponEffects {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.heightAt = null;             // set by WeaponManager so casings land on terrain
        this.quality = 1;                 // particle density multiplier (Extreme = 1.6)
        this.decals = []; this.maxDecals = 60;
        this.tracers = []; this.shells = []; this.parts = []; this.chips = [];
        this._flashTimer = 0;
        this.T = textures();
        this._decalGeo = new THREE.PlaneGeometry(1, 1);
        this._shellGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.045, 6);
        this._shellMat = new THREE.MeshStandardMaterial({ color: 0xb08d3a, metalness: 0.9, roughness: 0.3 });
        this._chipGeo = new THREE.BoxGeometry(1, 1, 1);
        this._wind = new THREE.Vector3(0.35, 0, 0.15);
        // unit tracer streak, scaled per shot (no per-shot geometry allocation)
        this._tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 4, 1, true);
        this._tracerGeo.translate(0, 0.5, 0); this._tracerGeo.rotateX(Math.PI / 2);
        // NPC muzzle flashes: small sprite pool + one shared light that jumps to the latest shot
        this._npcFlashes = [];
        for (let i = 0; i < 6; i++) {
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.T.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
            s.visible = false;
            scene.add(s);
            this._npcFlashes.push({ s, life: 0 });
        }
        this._npcFlashIndex = 0;
        this._npcLight = new THREE.PointLight(0xffa850, 0, 7, 2);
        scene.add(this._npcLight);
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
        this._npcLight.position.copy(pos);
        this._npcLight.intensity = 3 + Math.random() * 1.5;
        this._npcLightLife = 0.06;
        if (Math.random() < 0.5) this._puff(pos.clone(), 0x9a9a98, 0.08, 0.4, 0.8 + Math.random() * 0.4, dir.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.3, 0)), 0.14);
    }

    /** Dust burst where a body hits the ground. */
    bodyFall(pos, color = 0x7d6a52) {
        for (let i = 0; i < Math.round(5 * this.quality); i++) {
            const a = Math.random() * Math.PI * 2;
            const v = new THREE.Vector3(Math.cos(a) * (0.8 + Math.random()), 0.3 + Math.random() * 0.4, Math.sin(a) * (0.8 + Math.random()));
            this._puff(pos.clone().add(new THREE.Vector3(Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3)), color, 0.25, 1.0 + Math.random() * 0.5, 1.2 + Math.random() * 0.8, v, 0.32);
        }
    }

    /** Footstep dust kicked up by running NPCs on dry ground. */
    footDust(pos, color = 0x8a7656) {
        if (this.parts.length > 200) return;
        const v = new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.25 + Math.random() * 0.2, (Math.random() - 0.5) * 0.4);
        this._puff(pos.clone().setY(pos.y + 0.08), color, 0.12, 0.45, 0.7 + Math.random() * 0.4, v, 0.2);
    }

    // ── muzzle ───────────────────────────────────────────────────────────
    createMuzzleFlash(parent, position) {
        const add = (mat) => { const s = new THREE.Sprite(mat); s.position.copy(position); parent.add(s); return s; };
        const core = add(new THREE.SpriteMaterial({ map: this.T.flash, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
        // two crossed planes along the barrel = side prongs visible from the shooter's eye
        const prongMat = new THREE.MeshBasicMaterial({ map: this.T.prong, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide });
        const prongs = new THREE.Group();
        for (let i = 0; i < 2; i++) {
            const p = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.1), prongMat);
            p.position.z = -0.17; p.rotation.y = Math.PI / 2; p.rotation.x = i * Math.PI / 2;
            p.rotation.order = 'YXZ';
            prongs.add(p);
        }
        prongs.position.copy(position);
        parent.add(prongs);
        const light = new THREE.PointLight(0xffb060, 0, 9, 2);
        light.position.copy(position);
        parent.add(light);
        return { sprite: core, prongs, prongMat, light, muzzle: position.clone(), parent };
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
        flash.light.intensity = (suppressed ? 0.8 : 5) * (0.8 + Math.random() * 0.4);
        this._activeFlash = flash;
        this._flashTimer = 0.045;
        // muzzle smoke wisp in world space
        const wp = flash.parent.localToWorld(flash.muzzle.clone());
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
        this._puff(wp.addScaledVector(fwd, 0.05), 0x9a9a98, 0.05, 0.25, 0.9 + Math.random() * 0.4, fwd.multiplyScalar(0.6).add(new THREE.Vector3(0, 0.25, 0)), 0.18);
    }

    // ── tracer (thin, short-lived streak) ───────────────────────────────
    spawnTracer(from, to, { always = false, color = 0xffd9a0, width = 0.004, speed = 260 } = {}) {
        if (!always && Math.random() > 0.45) return;            // only some rounds are visible
        const dir = new THREE.Vector3().subVectors(to, from);
        const total = dir.length();
        if (total < 1.6) return;
        const len = Math.min(total, 2.5);
        dir.normalize();
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
        const mesh = new THREE.Mesh(this._tracerGeo, mat);
        mesh.scale.set(width, width, len);
        mesh.position.copy(from).addScaledVector(dir, 1.5);
        mesh.lookAt(to);
        this.scene.add(mesh);
        const life = Math.max(0.06, total / speed);
        this.tracers.push({ mesh, life, maxLife: life, dir, speed, travelled: 1.5, total });
        if (this.tracers.length > 40) { const o = this.tracers.shift(); this.scene.remove(o.mesh); o.mesh.material.dispose(); }
    }

    // ── casings ──────────────────────────────────────────────────────────
    spawnShell(worldPos, rightVec, template = null, upVec = null, backVec = null) {
        const mesh = template ? new THREE.Mesh(template.geometry, template.material) : new THREE.Mesh(this._shellGeo, this._shellMat);
        mesh.position.copy(worldPos);
        mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        const vel = rightVec.clone().multiplyScalar(1.6 + Math.random())
            .add(upVec ? upVec.clone().multiplyScalar(1.3 + Math.random() * 0.8) : new THREE.Vector3(0, 1.8 + Math.random(), 0));
        if (backVec) vel.addScaledVector(backVec, 0.4 + Math.random() * 0.5);
        this.scene.add(mesh);
        this.shells.push({ mesh, vel, life: 6, bounces: 0, angVel: new THREE.Vector3(Math.random() * 25, Math.random() * 25, Math.random() * 25) });
        if (this.shells.length > 40) { const o = this.shells.shift(); this.scene.remove(o.mesh); }
    }

    // ── impacts ──────────────────────────────────────────────────────────
    spawnImpact(point, normal, surface = 'dirt') {
        const S = SURF[surface] || SURF.dirt;
        const q = this.quality;
        const n = normal.clone().normalize();
        // smoke / dust plume pushed out of the surface
        for (let i = 0; i < Math.round(S.puffs * q); i++) {
            const v = n.clone().multiplyScalar(0.6 + Math.random() * 1.2).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, Math.random() * S.rise, (Math.random() - 0.5) * 0.6));
            this._puff(point.clone().addScaledVector(n, 0.04), S.smoke, S.size * (0.3 + Math.random() * 0.3), S.size * (1.2 + Math.random()), 0.9 + Math.random() * 1.1, v, 0.5);
        }
        // dirt kick: a fast vertical spray
        if (surface === 'dirt') {
            for (let i = 0; i < Math.round(3 * q); i++) {
                const v = n.clone().multiplyScalar(2.5 + Math.random() * 2).add(new THREE.Vector3((Math.random() - 0.5), 1.5 + Math.random() * 2, (Math.random() - 0.5)));
                this._puff(point.clone(), 0x5a4a38, 0.08, 0.35, 0.5 + Math.random() * 0.4, v, 0.75, 9);
            }
        }
        // sparks: hot streaks stretched along their velocity (motion-blurred like real footage)
        for (let i = 0; i < Math.round(S.sparks * q); i++) {
            const v = n.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3));
            const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffc070, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
            line.frustumCulled = false;
            line.userData.head = point.clone();
            this.scene.add(line);
            this.parts.push({ o: line, vel: v, life: 0.2 + Math.random() * 0.3, max: 0.5, grav: 9, streak: true });
        }
        // debris chips
        const chipMat = this._chipMat(S.chips);
        for (let i = 0; i < Math.round((surface === 'metal' ? 1 : 4) * q); i++) {
            const m = new THREE.Mesh(this._chipGeo, chipMat);
            const s = 0.008 + Math.random() * 0.018;
            m.scale.set(s, s * (0.5 + Math.random()), s);
            m.position.copy(point).addScaledVector(n, 0.02);
            this.scene.add(m);
            const v = n.clone().multiplyScalar(1.5 + Math.random() * 2.5).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2));
            this.chips.push({ o: m, vel: v, life: 1.5 + Math.random(), spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, 0) });
        }
        if (this.chips.length > 80) this.chips.splice(0, this.chips.length - 80).forEach(c => this.scene.remove(c.o));
        // decal
        const decal = new THREE.Mesh(this._decalGeo, new THREE.MeshBasicMaterial({
            map: this.T.holes[surface] || this.T.holes.concrete, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4
        }));
        const ds = surface === 'dirt' ? 0.18 + Math.random() * 0.1 : surface === 'wood' ? 0.09 + Math.random() * 0.04 : 0.06 + Math.random() * 0.03;
        decal.scale.set(ds, ds, 1);
        decal.position.copy(point).addScaledVector(n, 0.01);
        decal.lookAt(point.clone().add(n));
        decal.rotateZ(Math.random() * Math.PI * 2);
        this.scene.add(decal);
        this.decals.push(decal);
        while (this.decals.length > this.maxDecals) { const o = this.decals.shift(); this.scene.remove(o); o.material.dispose(); }
    }

    /** Blood mist + droplets on an enemy hit. */
    spawnHitMarker(point) {
        for (let i = 0; i < Math.round(3 * this.quality); i++) {
            const v = new THREE.Vector3((Math.random() - 0.5) * 1.4, Math.random() * 0.8, (Math.random() - 0.5) * 1.4);
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pick(this.T.bloods), transparent: true, depthWrite: false, opacity: 0.9 }));
            s.material.rotation = Math.random() * Math.PI * 2;
            s.scale.setScalar(0.12 + Math.random() * 0.1);
            s.position.copy(point);
            this.scene.add(s);
            this.parts.push({ o: s, vel: v, life: 0.45 + Math.random() * 0.3, max: 0.75, grav: 2.5, grow: 1.8 });
        }
        for (let i = 0; i < 4; i++) {
            const m = new THREE.Mesh(this._chipGeo, this._chipMat(0x5a0806));
            m.scale.setScalar(0.012);
            m.position.copy(point);
            this.scene.add(m);
            this.chips.push({ o: m, vel: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3), life: 0.8, spin: new THREE.Vector3() });
        }
        // spatter on the ground below / behind the hit
        if (this.heightAt) {
            const gp = point.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8));
            gp.y = this.heightAt(gp.x, gp.z) + 0.015;
            const decal = new THREE.Mesh(this._decalGeo, new THREE.MeshBasicMaterial({
                map: pick(this.T.bloods), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.85
            }));
            const ds = 0.35 + Math.random() * 0.35;
            decal.scale.set(ds, ds, 1);
            decal.position.copy(gp);
            decal.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
            this.scene.add(decal);
            this.decals.push(decal);
            while (this.decals.length > this.maxDecals) { const o = this.decals.shift(); this.scene.remove(o); o.material.dispose(); }
        }
    }

    _chipMat(color) {
        this._chipMats = this._chipMats || {};
        return this._chipMats[color] || (this._chipMats[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.95 }));
    }

    /** soft smoke/dust sprite that grows, drifts with the wind and fades */
    _puff(pos, color, size0, size1, life, vel, opacity, grav = -0.15) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pick(this.T.smokes), color, transparent: true, depthWrite: false, opacity }));
        s.material.rotation = Math.random() * Math.PI * 2;
        s.scale.setScalar(size0);
        s.position.copy(pos);
        this.scene.add(s);
        this.parts.push({ o: s, vel, life, max: life, grav, size0, size1, opacity, smoke: true, spin: (Math.random() - 0.5) * 0.8 });
        if (this.parts.length > 260) { const o = this.parts.shift(); this.scene.remove(o.o); o.o.material.dispose(); }
    }

    update(dt) {
        if (this._flashTimer > 0 && this._activeFlash) {
            this._flashTimer -= dt;
            const f = this._activeFlash;
            if (this._flashTimer <= 0) { f.sprite.material.opacity = 0; f.prongMat.opacity = 0; f.light.intensity = 0; }
            else f.light.intensity *= 0.6;
        }
        for (let i = this.tracers.length - 1; i >= 0; i--) {
            const t = this.tracers[i];
            t.life -= dt;
            t.mesh.position.addScaledVector(t.dir, t.speed * dt);
            t.travelled += t.speed * dt;
            t.mesh.material.opacity = Math.max(0, t.life / t.maxLife) * 0.75;
            if (t.life <= 0 || t.travelled > t.total) {
                this.scene.remove(t.mesh); t.mesh.material.dispose(); this.tracers.splice(i, 1);
            }
        }
        for (const f of this._npcFlashes) {
            if (f.life <= 0) continue;
            f.life -= dt;
            f.s.material.opacity = Math.max(0, f.life / 0.05);
            if (f.life <= 0) f.s.visible = false;
        }
        if (this._npcLightLife > 0) {
            this._npcLightLife -= dt;
            this._npcLight.intensity = this._npcLightLife > 0 ? this._npcLight.intensity * 0.6 : 0;
        }
        const ground = (p) => (this.heightAt ? this.heightAt(p.x, p.z) : 0);
        for (let i = this.shells.length - 1; i >= 0; i--) {
            const sh = this.shells[i];
            sh.life -= dt;
            if (sh.bounces < 4) {
                sh.vel.y -= 9.8 * dt;
                sh.mesh.position.addScaledVector(sh.vel, dt);
                sh.mesh.rotation.x += sh.angVel.x * dt; sh.mesh.rotation.y += sh.angVel.y * dt; sh.mesh.rotation.z += sh.angVel.z * dt;
                const gy = ground(sh.mesh.position) + 0.008;
                if (sh.mesh.position.y < gy) {
                    sh.mesh.position.y = gy;
                    sh.vel.y *= -0.32; sh.vel.x *= 0.5; sh.vel.z *= 0.5;
                    sh.angVel.multiplyScalar(0.45);
                    sh.bounces++;
                    if (sh.bounces >= 4) sh.mesh.rotation.set(Math.PI / 2, sh.mesh.rotation.y, 0);   // lie flat
                }
            }
            if (sh.life <= 0) { this.scene.remove(sh.mesh); this.shells.splice(i, 1); }
        }
        const camPos = this.camera.getWorldPosition(this._camPos || (this._camPos = new THREE.Vector3()));
        for (let i = this.parts.length - 1; i >= 0; i--) {
            const p = this.parts[i];
            p.life -= dt;
            const k = Math.max(0, p.life / p.max);
            p.vel.y -= p.grav * dt;
            if (p.streak) {
                const head = p.o.userData.head.addScaledVector(p.vel, dt);
                const a = p.o.geometry.attributes.position;
                a.setXYZ(0, head.x, head.y, head.z);
                a.setXYZ(1, head.x - p.vel.x * 0.025, head.y - p.vel.y * 0.025, head.z - p.vel.z * 0.025);
                a.needsUpdate = true;
                p.o.material.opacity = k;
                p.o.material.color.setRGB(1, 0.55 + 0.4 * k, 0.2 + 0.5 * k * k);    // cools from white-yellow to orange
                if (p.life <= 0) { this.scene.remove(p.o); p.o.geometry.dispose(); p.o.material.dispose(); this.parts.splice(i, 1); }
                continue;
            }
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
            if (p.life <= 0) { this.scene.remove(p.o); p.o.material.dispose(); this.parts.splice(i, 1); }
        }
        for (let i = this.chips.length - 1; i >= 0; i--) {
            const c = this.chips[i];
            c.life -= dt;
            c.vel.y -= 9.8 * dt;
            c.o.position.addScaledVector(c.vel, dt);
            c.o.rotation.x += c.spin.x * dt; c.o.rotation.y += c.spin.y * dt;
            const gy = ground(c.o.position);
            if (c.o.position.y < gy) { c.o.position.y = gy; c.vel.multiplyScalar(0.25); c.vel.y = Math.abs(c.vel.y) * 0.2; c.spin.multiplyScalar(0.3); }
            if (c.life <= 0) { this.scene.remove(c.o); this.chips.splice(i, 1); }
        }
    }

    clear() {
        [...this.tracers, ...this.shells].forEach(o => this.scene.remove(o.mesh));
        [...this.parts, ...this.chips].forEach(o => this.scene.remove(o.o));
        this.decals.forEach(d => this.scene.remove(d));
        this.tracers = []; this.shells = []; this.parts = []; this.chips = []; this.decals = [];
        this._npcFlashes.forEach(f => { this.scene.remove(f.s); f.s.material.dispose(); });
        this._npcFlashes = [];
        this.scene.remove(this._npcLight);
    }
}
