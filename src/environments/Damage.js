import * as THREE from '/node_modules/three/build/three.module.js';
import { DecalBatch, CELL } from '../render/DecalAtlas.js';
import { getPhoto } from './PhotoAssets.js';

/**
 * War damage for every level, all of it batched:
 *   - ONE DecalBatch (one draw call, the shared decal atlas) for ground scorch, rubble, dust, oil,
 *     road cracks and tyre tracks, plus wall leaks, soot and bullet-hole clusters on buildings
 *   - ONE InstancedMesh of low-poly rubble chunks (36 triangles each) around craters, wrecks and
 *     building bases, textured with the CC0 rubble scan and colour-varied per instance
 * Everything is placed once at level build from data the level already has (colliders, craters,
 * war objects, fires); nothing updates per frame.
 */
const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();

export function buildDamage(lb, config) {
    const rnd = lb.rand, b = lb.bounds;
    const mobile = !!lb.detail.mobile;
    const decalMax = Math.round((config.damage?.decals ?? 420) * (mobile ? 0.5 : 1));
    const chunkMax = Math.round((config.damage?.chunks ?? 520) * (mobile ? 0.45 : 1));
    const decals = new DecalBatch(lb.group, decalMax, { ring: false });

    const groundNormal = (x, z) => {
        const e = 0.6, hx = lb.heightAt(x + e, z) - lb.heightAt(x - e, z), hz = lb.heightAt(x, z + e) - lb.heightAt(x, z - e);
        return _n.set(-hx, 2 * e, -hz).normalize();
    };
    const ground = (x, z, size, cell, alpha = 1, sy) => {
        if (Math.abs(x) > b + 20 || Math.abs(z) > b + 20) return;
        _p.set(x, lb.heightAt(x, z) + 0.01, z);
        decals.add(_p, groundNormal(x, z), size, cell, rnd() * 6.283, alpha, sy ?? size);
    };
    const pick = (...cells) => cells[Math.floor(rnd() * cells.length)];

    // ── rubble chunks ──
    const chunkGeo = new THREE.DodecahedronGeometry(1, 0);
    const P = getPhoto();
    const set = P && P.tex && (P.tex.rubble || P.tex.concrete_debris);
    const chunkMat = new THREE.MeshStandardMaterial({ map: set ? set.map : null, normalMap: set ? set.normalMap : null, color: set ? 0x9a948a : 0x5e5a54, roughness: 1, metalness: 0 });
    const chunks = new THREE.InstancedMesh(chunkGeo, chunkMat, Math.max(1, chunkMax));
    chunks.count = 0; chunks.receiveShadow = true; chunks.castShadow = false;
    chunks.userData.environmentManaged = true;
    const col = new THREE.Color();
    const chunk = (x, z, size) => {
        if (chunks.count >= chunkMax) return;
        const y = lb.heightAt(x, z);
        size *= 0.75;
        _p.set(x, y + size * 0.08, z);
        _q.setFromEuler(_e.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
        _s.set(size * (0.7 + rnd() * 0.6), size * (0.35 + rnd() * 0.35), size * (0.7 + rnd() * 0.6));
        _m.compose(_p, _q, _s);
        chunks.setMatrixAt(chunks.count, _m);
        const v = 0.36 + rnd() * 0.32;
        chunks.setColorAt(chunks.count, col.setRGB(v, v * (0.96 + rnd() * 0.05), v * (0.9 + rnd() * 0.08)));
        chunks.count++;
    };
    const ring = (cx, cz, r0, r1, n, fn) => { for (let i = 0; i < n; i++) { const a = rnd() * 6.283, d = r0 + rnd() * (r1 - r0); fn(cx + Math.cos(a) * d, cz + Math.sin(a) * d); } };

    // craters: soot halo, scattered rubble and dust, chunks thrown around the lip
    for (const c of config.war?.craters || []) {
        ground(c.x, c.z, c.r * 2.6, pick(CELL.scorchA, CELL.scorchB), 0.85);
        ring(c.x, c.z, c.r * 0.6, c.r * 1.8, 4, (x, z) => ground(x, z, 1.2 + rnd() * 1.6, pick(CELL.rubble, CELL.dust, CELL.burnt), 0.9));
        ring(c.x, c.z, c.r * 0.5, c.r * 1.7, 14 + Math.round(c.r * 3), (x, z) => chunk(x, z, 0.08 + rnd() * 0.22));
    }
    // fires and wrecks: scorch and oil under them, debris around
    for (const f of lb.war?.fires || []) {
        ground(f.x, f.z, 2.2 + f.size * 1.6, pick(CELL.scorchA, CELL.scorchB, CELL.burnt), 0.9);
        if (rnd() < 0.6) ground(f.x + (rnd() - 0.5) * 2, f.z + (rnd() - 0.5) * 2, 1.4 + rnd(), CELL.oil, 0.8);
        ring(f.x, f.z, 1, 3 + f.size, 6, (x, z) => chunk(x, z, 0.05 + rnd() * 0.12));
    }
    for (const o of config.war?.objects || []) {
        if (rnd() < 0.5) ground(o.x + (rnd() - 0.5) * 1.5, o.z + (rnd() - 0.5) * 1.5, 1.2 + rnd() * 1.2, pick(CELL.oil, CELL.dust), 0.75);
    }

    // buildings: rubble along their bases, leaks / soot / bullet pocks on their walls
    const tall = lb.colliders.filter(bx => bx.max.y - bx.min.y > 3.2 && (bx.max.x - bx.min.x) * (bx.max.z - bx.min.z) > 9
        && Math.abs((bx.min.x + bx.max.x) / 2) < b + 10 && Math.abs((bx.min.z + bx.max.z) / 2) < b + 10);
    const urban = config.urban ?? tall.length > 6;
    const faces = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const bx of tall) {
        const h = bx.max.y - bx.min.y;
        for (const [fx, fz] of faces) {
            if (rnd() < 0.35) continue;
            const along = fx ? bx.max.z - bx.min.z : bx.max.x - bx.min.x;
            const wx = fx > 0 ? bx.max.x : fx < 0 ? bx.min.x : 0, wz = fz > 0 ? bx.max.z : fz < 0 ? bx.min.z : 0;
            const point = (t, y) => fx ? _p.set(wx, y, bx.min.z + t * along) : _p.set(bx.min.x + t * along, y, wz);
            _n.set(fx, 0, fz);
            // grime / leak streaks running down from the roof line and window sills
            for (let k = 0; k < 1 + Math.floor(along / 9); k++) {
                if (rnd() < 0.45) continue;
                const sy = 2.5 + rnd() * Math.min(5, h * 0.4);
                point(0.1 + rnd() * 0.8, bx.min.y + h - sy * 0.5 - rnd() * 1.5);
                decals.add(_p, _n, 1.4 + rnd() * 1.6, CELL.leak, Math.PI + (rnd() - 0.5) * 0.1, 0.6 + rnd() * 0.3, sy);
            }
            // a burst of bullet pocks at chest height, or a soot plume above a blown window
            if (rnd() < 0.55) {
                const t0 = 0.15 + rnd() * 0.7, y0 = bx.min.y + 1 + rnd() * 1.6;
                for (let k = 0; k < 5 + Math.floor(rnd() * 8); k++) {
                    point(Math.min(0.98, Math.max(0.02, t0 + (rnd() - 0.5) * 2.2 / along)), y0 + (rnd() - 0.5) * 1.1);
                    decals.add(_p, _n, 0.12 + rnd() * 0.12, CELL.holeConcrete, rnd() * 6.28, 1);
                }
            } else if (rnd() < 0.4 && h > 5) {
                point(0.2 + rnd() * 0.6, bx.min.y + 3 + rnd() * (h - 5));
                decals.add(_p, _n, 2.2 + rnd() * 1.5, pick(CELL.scorchA, CELL.scorchB), Math.PI, 0.8, 3 + rnd() * 2);
            }
            // rubble, dust and broken bits at the foot of the wall
            for (let k = 0; k < 1 + Math.floor(along / 7); k++) {
                point(rnd(), 0);
                const ox = _p.x + fx * (0.6 + rnd() * 1.6), oz = _p.z + fz * (0.6 + rnd() * 1.6);
                if (rnd() < 0.7) ground(ox, oz, 1 + rnd() * 1.6, pick(CELL.rubble, CELL.dust), 0.85);
                ring(ox, oz, 0, 1.2, 3 + Math.floor(rnd() * 4), (x, z) => chunk(x, z, 0.05 + rnd() * 0.16));
            }
        }
    }
    // streets: cracks, tyre tracks, oil and dust; the countryside gets dirt and burnt patches instead
    const scatter = urban ? [[CELL.cracksA, 34, 1.6, 3.2], [CELL.cracksB, 30, 1.4, 3], [CELL.tire, 14, 1.8, 3], [CELL.oil, 14, 0.9, 2], [CELL.dust, 22, 1.2, 2.6]]
        : [[CELL.dust, 18, 1.5, 3], [CELL.burnt, 8, 1.5, 3], [CELL.rubble, 8, 1, 2]];
    for (const [cell, n, s0, s1] of scatter) {
        let placed = 0, guard = 0;
        while (placed < n && guard++ < n * 6) {
            const x = (rnd() * 2 - 1) * (b - 4), z = (rnd() * 2 - 1) * (b - 4);
            if (lb._isBlocked && lb._isBlocked(x, z, 0.5, true)) continue;
            const s = s0 + rnd() * (s1 - s0);
            ground(x, z, s, cell, 0.7 + rnd() * 0.3, cell === CELL.tire ? s * 0.45 : s);
            placed++;
        }
    }
    if (chunks.count) {
        chunks.instanceMatrix.needsUpdate = true;
        if (chunks.instanceColor) chunks.instanceColor.needsUpdate = true;
        lb.group.add(chunks);
    }
    return {
        decals: decals.n, chunks: chunks.count,
        update() {},                       // static: nothing ticks
        dispose() { decals.dispose(); lb.group.remove(chunks); chunks.dispose(); chunkGeo.dispose(); chunkMat.dispose(); }
    };
}
