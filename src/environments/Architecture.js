import * as THREE from '/node_modules/three/build/three.module.js';
import { mergeGeometries } from '/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { TextureFactory } from '../utils/TextureFactory.js';

/**
 * AAA-style set dressing. Anything decorative (trim, frames, rails, posts,
 * rivets...) is collected into a Deco batch and merged into ONE mesh per
 * material, so detailed architecture costs a handful of draw calls instead of
 * hundreds. Gameplay pieces (walls, container bodies, tower cabins) stay as
 * individual meshes so bullets/AI rays and collisions still work on them.
 */
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

export class Deco {
    constructor(group, disposables) {
        this.group = group; this.disposables = disposables; this.map = new Map();
    }
    /** geo in local space; parent = Matrix4 of the owning object; pos/rot relative to it. */
    add(geo, mat, parent, pos = [0, 0, 0], rot = [0, 0, 0]) {
        _e.set(rot[0], rot[1], rot[2]);
        _q.setFromEuler(_e);
        _m.compose(_p.set(pos[0], pos[1], pos[2]), _q, _s);
        const mm = parent ? parent.clone().multiply(_m) : _m.clone();
        let g = geo.index ? geo.toNonIndexed() : geo.clone();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        g.applyMatrix4(mm);
        (this.map.get(mat) || this.map.set(mat, []).get(mat)).push(g);
    }
    box(w, h, d, mat, parent, pos, rot) { this.add(UNIT.box(w, h, d), mat, parent, pos, rot); }
    flush() {
        for (const [mat, list] of this.map) {
            const merged = mergeGeometries(list, false);
            list.forEach(g => g.dispose());
            if (!merged) continue;
            const mesh = new THREE.Mesh(merged, mat);
            mesh.castShadow = false; mesh.receiveShadow = true;   // trim is small; skip it in the shadow pass
            // level-wide batch: keep it out of the per-item scenery LOD (its bbox centre is the map centre)
            mesh.userData.environmentManaged = true;
            this.group.add(mesh);
            this.disposables.push(merged);
        }
        this.map.clear();
    }
}

const boxCache = new Map();
const UNIT = {
    box(w, h, d) {
        const k = `${w}|${h}|${d}`;
        if (!boxCache.has(k)) boxCache.set(k, new THREE.BoxGeometry(w, h, d));
        return boxCache.get(k);
    }
};

export function groupMatrix(x, y, z, yaw) {
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1));
}

function shared(lb) {
    if (lb._arch) return lb._arch;
    const metal = TextureFactory.metal(256, 1);   // structural steel: procedural (the rust photo reads as wood)
    const concrete = lb._photo('concrete_wall_004', () => TextureFactory.concrete(512, 1));
    const wood = lb._photo('wood_planks_grey', () => TextureFactory.wood(256, 1));
    const A = lb._arch = {
        steel: lb._pbr(metal, { color: 0x7a8086, metalness: 0.35, roughness: 0.55 }),
        darkSteel: lb._pbr(metal, { color: 0x4a4e54, metalness: 0.35, roughness: 0.6 }),
        galv: lb._pbr(metal, { color: 0x9aa0a6, metalness: 0.8, roughness: 0.4 }),
        concrete: lb._pbr(concrete, { color: 0xb8b6ae, roughness: 0.92 }),
        woodDark: lb._pbr(wood, { color: 0x8a6a48, roughness: 0.9 }),
        woodLight: lb._pbr(wood, { color: 0xc9b088, roughness: 0.9 }),
        rubber: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 }),
        bulb: new THREE.MeshBasicMaterial({ color: 0xfff0c0 }),
        trim: lb._pbr(concrete, { color: 0xd6d2c6, roughness: 0.9 }),
        roofRidge: lb._pbr(metal, { color: 0x6b4a38, metalness: 0.5, roughness: 0.6 })
    };
    lb.disposables.push(A.rubber, A.bulb);
    return A;
}

// ── Shipping container ───────────────────────────────────────────────────
const CONTAINER_COLORS = [0x3d5a47, 0x8a3b2a, 0x2f4a6b, 0x7a6a2c, 0x5c5f63, 0x9a4a22, 0x39513a];
export function container(lb, deco, x, z, yaw, color, stack = 1, y0 = 0) {
    const A = shared(lb);
    const W = 2.44, H = 2.59, L = 6.06;
    const corr = lb._photo('corrugated_iron_02', () => TextureFactory.corrugated(256, 1));
    const photoCorr = corr.metalness === undefined;   // photo sets carry no preset metalness
    const col = new THREE.Color(color ?? CONTAINER_COLORS[Math.floor(lb.rand() * CONTAINER_COLORS.length)]);
    col.multiplyScalar(1.6 + lb.rand() * 0.4);
    const side = lb._pbr(corr, { color: col, metalness: 0.45, roughness: 0.62 });
    const endMat = lb._pbr(lb._photo('rusty_metal_02', () => TextureFactory.metal(256, 1)), { color: col.clone().multiplyScalar(0.9), metalness: 0.5, roughness: 0.6 });
    const roofMat = lb._pbr(corr, { color: col.clone().multiplyScalar(0.85), metalness: 0.4, roughness: 0.7 });
    const floorMat = A.darkSteel;
    for (let k = 0; k < stack; k++) {
        const y = y0 + k * H;
        const geo = new THREE.BoxGeometry(W, H, L);
        const uv = geo.attributes.uv;
        // faces: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z
        for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
            const j = f * 4 + i; const u = uv.getX(j), v = uv.getY(j);
            if (photoCorr) uv.setXY(j, f < 2 ? u * L / 4.5 : f < 4 ? u * W / 4.5 : u * W / 4.5, f < 2 ? v * H / 4.5 : f < 4 ? v * L / 4.5 : v * H / 4.5);
            else if (f < 2) uv.setXY(j, u * 2.0, v); else if (f < 4) uv.setXY(j, u, v * 2.0);
        }
        const body = new THREE.Mesh(geo, [side, side, roofMat, floorMat, side, side]);
        body.position.set(x, y + H / 2, z);
        body.rotation.y = yaw;
        body.castShadow = body.receiveShadow = true;
        lb.group.add(body);
        lb.raycastables.push(body);
        body.updateMatrixWorld(true);
        lb.colliders.push(new THREE.Box3().setFromObject(body));
        lb.disposables.push(geo);

        const M = groupMatrix(x, y + H / 2, z, yaw);
        // corner posts, top/bottom rails
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
            deco.box(0.16, H + 0.04, 0.16, A.darkSteel, M, [sx * (W / 2), 0, sz * (L / 2)]);
        }
        for (const sx of [-1, 1]) {
            deco.box(0.1, 0.12, L, A.darkSteel, M, [sx * (W / 2 + 0.02), H / 2 - 0.02, 0]);
            deco.box(0.1, 0.14, L, A.darkSteel, M, [sx * (W / 2 + 0.02), -H / 2 + 0.07, 0]);
        }
        for (const sz of [-1, 1]) {
            deco.box(W, 0.12, 0.1, A.darkSteel, M, [0, H / 2 - 0.02, sz * (L / 2 + 0.02)]);
            deco.box(W, 0.14, 0.1, A.darkSteel, M, [0, -H / 2 + 0.07, sz * (L / 2 + 0.02)]);
        }
        // door end (+z): panel seam, 4 locking rods + cam handles, hinges
        const zd = L / 2 + 0.05;
        deco.box(0.05, H - 0.3, 0.04, A.darkSteel, M, [0, 0, zd]);
        for (const dx of [-0.85, -0.45, 0.45, 0.85]) {
            deco.add(new THREE.CylinderGeometry(0.022, 0.022, H - 0.35, 6), A.galv, M, [dx, 0, zd + 0.03]);
            deco.box(0.14, 0.05, 0.05, A.galv, M, [dx, -0.1, zd + 0.06]);
            deco.box(0.1, 0.1, 0.05, A.darkSteel, M, [dx, H / 2 - 0.2, zd + 0.03]);
            deco.box(0.1, 0.1, 0.05, A.darkSteel, M, [dx, -H / 2 + 0.2, zd + 0.03]);
        }
        deco.box(0.1, 0.32, 0.06, A.darkSteel, M, [-W / 2 + 0.12, 0.6, zd]);
        deco.box(0.1, 0.32, 0.06, A.darkSteel, M, [W / 2 - 0.12, 0.6, zd]);
    }
    lb.cover.push(new THREE.Vector3(x, 0, z));
}

// ── Watchtower on a steel/timber frame ───────────────────────────────────
export function tower(lb, deco, item, baseColor) {
    const A = shared(lb);
    const { x, z, w, d, h, rot = 0 } = item;
    const M = groupMatrix(x, 0, z, rot);
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = rot; lb.group.add(g);
    const legSz = 0.34;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(UNIT.box(legSz, h, legSz), A.steel);
        leg.position.set(sx * w / 2, h / 2, sz * d / 2);
        leg.castShadow = leg.receiveShadow = true; g.add(leg); lb.raycastables.push(leg);
    }
    g.updateMatrixWorld(true);
    g.children.forEach(c => lb.colliders.push(new THREE.Box3().setFromObject(c)));
    // X braces on every face + horizontal ring beams
    const bl = Math.hypot(w, h / 2.4), ba = Math.atan2(h / 2.4, w);
    for (let lvl = 0; lvl < 2; lvl++) {
        const yy = h * (0.25 + lvl * 0.45);
        for (const sz of [-1, 1]) {
            deco.box(bl, 0.1, 0.1, A.darkSteel, M, [0, yy, sz * d / 2], [0, 0, ba]);
            deco.box(bl, 0.1, 0.1, A.darkSteel, M, [0, yy, sz * d / 2], [0, 0, -ba]);
        }
        for (const sx of [-1, 1]) {
            deco.box(0.1, 0.1, bl, A.darkSteel, M, [sx * w / 2, yy, 0], [-ba, 0, 0]);
            deco.box(0.1, 0.1, bl, A.darkSteel, M, [sx * w / 2, yy, 0], [ba, 0, 0]);
        }
        deco.box(w + 0.2, 0.12, 0.12, A.darkSteel, M, [0, yy - h * 0.12, d / 2]);
        deco.box(w + 0.2, 0.12, 0.12, A.darkSteel, M, [0, yy - h * 0.12, -d / 2]);
    }
    // platform, cabin, glazing, pyramid roof, railing
    const plat = new THREE.Mesh(lb._box(w + 1.6, 0.28, d + 1.6, 2), A.woodDark);
    plat.position.set(0, h + 0.14, 0); plat.castShadow = plat.receiveShadow = true; g.add(plat); lb.raycastables.push(plat);
    const cabin = new THREE.Mesh(lb._box(w + 0.7, 1.9, d + 0.7, 2), A.woodLight);
    cabin.position.set(0, h + 0.28 + 0.95, 0); cabin.castShadow = cabin.receiveShadow = true; g.add(cabin); lb.raycastables.push(cabin);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(w + 0.74, 0.7, d + 0.74), lb._glass);
    glass.position.set(0, h + 1.45, 0); g.add(glass);
    const roof = new THREE.Mesh(new THREE.ConeGeometry((Math.max(w, d) + 1.8) * 0.72, 1.1, 4), A.roofRidge);
    roof.rotation.y = Math.PI / 4; roof.position.set(0, h + 2.18 + 0.55, 0); roof.castShadow = true; g.add(roof);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) deco.box(0.08, 0.9, 0.08, A.darkSteel, M, [sx * (w / 2 + 0.78), h + 0.7, sz * (d / 2 + 0.78)]);
    deco.box(w + 1.7, 0.07, 0.07, A.darkSteel, M, [0, h + 1.12, d / 2 + 0.78]);
    deco.box(w + 1.7, 0.07, 0.07, A.darkSteel, M, [0, h + 1.12, -d / 2 - 0.78]);
    deco.box(0.07, 0.07, d + 1.7, A.darkSteel, M, [w / 2 + 0.78, h + 1.12, 0]);
    deco.box(0.07, 0.07, d + 1.7, A.darkSteel, M, [-w / 2 - 0.78, h + 1.12, 0]);
    // ladder
    for (const lx of [-0.22, 0.22]) deco.box(0.06, h + 0.3, 0.06, A.galv, M, [lx, (h + 0.3) / 2, d / 2 + 0.3]);
    for (let r = 0.4; r < h; r += 0.35) deco.box(0.5, 0.04, 0.04, A.galv, M, [0, r, d / 2 + 0.3]);
    lb.cover.push(new THREE.Vector3(x + 3, 0, z));
}

// ── Building detail: plinth, door frame + leaf, window frames, ridge, chimney
export function buildingDetail(lb, deco, item) {
    const A = shared(lb);
    const { x, z, w, d, h, rot = 0 } = item;
    const M = groupMatrix(x, 0, z, rot);
    const doorW = 2.2, t = 0.4;
    // concrete plinth (skips door gap) + floor slab
    const ph = 0.5, pt = 0.56;
    deco.box(w + 0.3, ph, pt, A.concrete, M, [0, ph / 2, -d / 2]);
    deco.box(pt, ph, d + 0.3, A.concrete, M, [-w / 2, ph / 2, 0]);
    deco.box(pt, ph, d + 0.3, A.concrete, M, [w / 2, ph / 2, 0]);
    const seg = w / 2 - doorW / 2;
    deco.box(seg, ph, pt, A.concrete, M, [-(w / 4 + doorW / 4), ph / 2, d / 2]);
    deco.box(seg, ph, pt, A.concrete, M, [(w / 4 + doorW / 4), ph / 2, d / 2]);
    deco.box(w - 0.6, 0.12, d - 0.6, A.concrete, M, [0, 0.06, 0]);
    deco.box(doorW + 0.8, 0.14, 1.0, A.concrete, M, [0, 0.07, d / 2 + 0.6]);          // doorstep
    // door frame + ajar leaf
    for (const sx of [-1, 1]) deco.box(0.16, 2.3, 0.5, A.darkSteel, M, [sx * (doorW / 2 + 0.08), 1.15, d / 2]);
    deco.box(doorW + 0.32, 0.16, 0.5, A.darkSteel, M, [0, 2.28, d / 2]);
    deco.box(doorW * 0.48, 2.1, 0.07, A.woodDark, M, [-(doorW / 2) + 0.35, 1.07, d / 2 + 0.62], [0, 1.05, 0]);
    // corner pilasters + belt course
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) deco.box(0.5, h + 0.1, 0.5, A.trim, M, [sx * w / 2, h / 2, sz * d / 2]);
    for (const sz of [-1, 1]) deco.box(w + 0.5, 0.2, 0.5, A.trim, M, [0, h - 0.1, sz * d / 2]);
    for (const sx of [-1, 1]) deco.box(0.5, 0.2, d + 0.5, A.trim, M, [sx * w / 2, h - 0.1, 0]);
    // windows: frame, sill, muntins, shutters
    const wh = Math.min(1.3, h * 0.28), ww = 1.2, wy = Math.min(h - 0.9, 2.1);
    const win = (px, pz, ry) => {
        const P = (lx, ly, lz) => [px + Math.cos(ry) * lx + Math.sin(ry) * lz, wy + ly, pz - Math.sin(ry) * lx + Math.cos(ry) * lz];
        const rr = [0, ry, 0];
        deco.box(ww + 0.22, 0.1, 0.22, A.trim, M, P(0, wh / 2 + 0.05, 0.08), rr);
        deco.box(ww + 0.3, 0.1, 0.34, A.trim, M, P(0, -wh / 2 - 0.05, 0.12), rr);
        for (const sx of [-1, 1]) deco.box(0.1, wh + 0.1, 0.22, A.trim, M, P(sx * (ww / 2 + 0.05), 0, 0.08), rr);
        deco.box(0.05, wh, 0.05, A.darkSteel, M, P(0, 0, 0.06), rr);
        deco.box(ww, 0.05, 0.05, A.darkSteel, M, P(0, 0, 0.06), rr);
        for (const sx of [-1, 1]) deco.box(0.5, wh, 0.06, A.woodDark, M, P(sx * (ww / 2 + 0.34), 0, 0.12), [0, ry + sx * 0.5, 0]);
    };
    const nz = Math.max(1, Math.floor(d / 4.2));
    for (let i = 0; i < nz; i++) {
        const pz = -d / 2 + (i + 0.5) * (d / nz);
        win(-w / 2 - 0.2, pz, Math.PI / 2); win(w / 2 + 0.2, pz, Math.PI / 2);
    }
    const nx = Math.max(1, Math.floor(w / 4.5));
    for (let i = 0; i < nx; i++) win(-w / 2 + (i + 0.5) * (w / nx), -d / 2 - 0.2, 0);
    // roof ridge cap, chimney, vent pipe
    const rise = Math.min(2.2, w * 0.28);
    deco.box(0.3, 0.14, d + 1.4, A.roofRidge, M, [0, h + rise + 0.12, 0]);
    if (w > 9) {
        deco.box(0.9, 2.2, 0.9, A.trim, M, [w * 0.25, h + rise * 0.55 + 0.8, -d * 0.2]);
        deco.box(1.1, 0.16, 1.1, A.concrete, M, [w * 0.25, h + rise * 0.55 + 1.95, -d * 0.2]);
    }
    deco.add(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 8), A.galv, M, [-w * 0.2, h + rise * 0.6 + 0.4, d * 0.15]);
    // rain gutter + downspout
    deco.box(0.14, 0.14, d + 1.2, A.galv, M, [w / 2 + 0.55, h - 0.05, 0]);
    deco.box(0.14, 0.14, d + 1.2, A.galv, M, [-w / 2 - 0.55, h - 0.05, 0]);
    deco.add(new THREE.CylinderGeometry(0.06, 0.06, h, 6), A.galv, M, [w / 2 + 0.55, h / 2, d / 2 - 0.4]);
}

// ── Fences ───────────────────────────────────────────────────────────────
export function fence(lb, deco, f) {
    const A = shared(lb);
    const dx = f.x2 - f.x1, dz = f.z2 - f.z1, L = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz) - Math.PI / 2;
    const H = f.h ?? 2.3;
    const tex = TextureFactory.chainlink(128);
    const t2 = tex.clone(); t2.repeat.set(L / 0.9, H / 0.9); t2.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: t2, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.8, roughness: 0.45, color: 0xc4cad0 });
    lb.disposables.push(mat);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(L, H), mat);
    mesh.position.set((f.x1 + f.x2) / 2, H / 2, (f.z1 + f.z2) / 2);
    mesh.rotation.y = yaw;
    mesh.castShadow = true; mesh.receiveShadow = true;
    lb.group.add(mesh); lb.disposables.push(mesh.geometry);
    const M = groupMatrix(0, 0, 0, 0);
    const n = Math.max(1, Math.round(L / 3));
    for (let i = 0; i <= n; i++) {
        const px = f.x1 + dx * i / n, pz = f.z1 + dz * i / n;
        deco.add(new THREE.CylinderGeometry(0.06, 0.07, H + 0.2, 6), A.galv, M, [px, H / 2, pz]);
    }
    deco.add(new THREE.CylinderGeometry(0.035, 0.035, L, 6), A.galv, M, [(f.x1 + f.x2) / 2, H, (f.z1 + f.z2) / 2], [Math.PI / 2, yaw, 0]);
    // barbed-wire topper rail
    if (f.wire !== false) deco.add(new THREE.CylinderGeometry(0.015, 0.015, L, 4), A.darkSteel, M, [(f.x1 + f.x2) / 2, H + 0.22, (f.z1 + f.z2) / 2], [Math.PI / 2, yaw, 0]);
    // collider chunks (axis-aligned boxes stay small so diagonal fences are not huge)
    const chunks = Math.max(1, Math.round(L / 2));
    for (let i = 0; i < chunks; i++) {
        const cx = f.x1 + dx * (i + 0.5) / chunks, cz = f.z1 + dz * (i + 0.5) / chunks, r = 0.25 + Math.abs(L / chunks) * 0.45;
        lb.colliders.push(new THREE.Box3(new THREE.Vector3(cx - r, 0, cz - r), new THREE.Vector3(cx + r, H, cz + r)));
    }
}

// ── Props ────────────────────────────────────────────────────────────────
export function prop(lb, deco, p) {
    const A = shared(lb);
    const rot = p.rot || 0, M = groupMatrix(p.x, 0, p.z, rot);
    const solid = (w, h, d, cx = 0) => {
        lb.colliders.push(new THREE.Box3(new THREE.Vector3(p.x - Math.max(w, d) / 2 - 0.1 + cx * 0, 0, p.z - Math.max(w, d) / 2), new THREE.Vector3(p.x + Math.max(w, d) / 2 + 0.1, h, p.z + Math.max(w, d) / 2)));
        lb.cover.push(new THREE.Vector3(p.x, 0, p.z));
    };
    const hit = (geo, mat, pos, rotv = [0, 0, 0]) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(p.x, 0, p.z); m.position.add(new THREE.Vector3(...pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot));
        m.rotation.set(rotv[0], rotv[1] + rot, rotv[2]);
        m.castShadow = m.receiveShadow = true; lb.group.add(m); lb.raycastables.push(m);
        return m;
    };
    switch (p.type) {
        case 'jersey': {      // concrete road barrier, 3 m long
            for (let i = 0; i < (p.n || 1); i++) {
                const off = i * 3.1;
                deco.box(0.62, 0.24, 3, A.concrete, M, [0, 0.12, off]);
                deco.box(0.42, 0.45, 3, A.concrete, M, [0, 0.46, off]);
                deco.box(0.24, 0.35, 3, A.concrete, M, [0, 0.86, off]);
                lb.colliders.push(new THREE.Box3(new THREE.Vector3(p.x - 1.6, 0, p.z - 1.6 + off * 0), new THREE.Vector3(p.x + 1.6, 1.05, p.z + 1.6)));
            }
            lb.cover.push(new THREE.Vector3(p.x, 0, p.z)); break;
        }
        case 'hesco': {       // wire-mesh/geotextile blast wall
            const mat = lb._pbr(TextureFactory.burlap(256, 1), { color: 0xcdbd96 });
            const m = hit(lb._box(1.1, 1.3, 1.1, 1.1), mat, [0, 0.65, 0]);
            for (const y of [0.05, 0.65, 1.28]) deco.box(1.16, 0.04, 1.16, A.galv, M, [0, y, 0]);
            lb.colliders.push(new THREE.Box3().setFromObject(m)); lb.cover.push(new THREE.Vector3(p.x, 0, p.z)); break;
        }
        case 'tires': {
            const g = new THREE.TorusGeometry(0.34, 0.15, 8, 14);
            for (let i = 0; i < 4; i++) {
                const a = i * 2.1, rr = i === 3 ? 0 : 0.34;
                deco.add(g, A.rubber, M, [Math.cos(a) * rr, 0.15 + (i === 3 ? 0.3 : 0), Math.sin(a) * rr], [Math.PI / 2, 0, 0]);
            }
            solid(1.1, 0.6); break;
        }
        case 'pallet': {
            for (let i = 0; i < 5; i++) deco.box(1.2, 0.025, 0.14, A.woodLight, M, [0, 0.16, -0.5 + i * 0.25]);
            for (const z of [-0.45, 0, 0.45]) deco.box(1.2, 0.12, 0.08, A.woodDark, M, [0, 0.08, z]);
            break;
        }
        case 'lamp': {
            deco.add(new THREE.CylinderGeometry(0.07, 0.11, 5.2, 8), A.darkSteel, M, [0, 2.6, 0]);
            deco.box(1.0, 0.07, 0.07, A.darkSteel, M, [0.45, 5.15, 0]);
            deco.box(0.4, 0.12, 0.22, A.darkSteel, M, [0.9, 5.08, 0]);
            deco.box(0.34, 0.04, 0.18, A.bulb, M, [0.9, 5.0, 0]);
            break;
        }
        case 'log': {         // fallen tree trunk with a broken stub
            const len = p.len || 5.5, r = p.r || 0.32;
            const bark = lb._pbr(lb._photo('wood_planks_grey', () => TextureFactory.wood(256, 1)), { color: 0x6a5238, roughness: 0.98 });
            const geo = new THREE.CylinderGeometry(r * 0.85, r, len, 10);
            const m = hit(geo, bark, [0, r * 0.9, 0], [0, 0, Math.PI / 2]);
            lb.disposables.push(geo);
            deco.add(new THREE.CylinderGeometry(r * 0.18, r * 0.25, 0.8, 5), A.woodDark, M, [len * 0.18, r * 1.6, 0.15], [0.9, 0, 0.2]);
            for (let i = -1; i <= 1; i++) lb.world.addCircle(p.x + Math.cos(rot) * i * len * 0.38, p.z - Math.sin(rot) * i * len * 0.38, r * 0.9, 0, r * 2);
            lb.cover.push(new THREE.Vector3(p.x, 0, p.z)); break;
        }
        case 'stump': {
            const r = p.r || 0.4;
            deco.add(new THREE.CylinderGeometry(r * 0.8, r * 1.15, 0.55, 9), A.woodDark, M, [0, 0.27, 0]);
            deco.add(new THREE.CylinderGeometry(r * 0.7, r * 0.7, 0.03, 9), A.woodLight, M, [0, 0.55, 0]);
            lb.world.addCircle(p.x, p.z, r, 0, 0.6); break;
        }
        case 'rubble': {      // collapsed masonry pile
            let seed = Math.abs(Math.floor(p.x * 31 + p.z * 17)) + 7;
            const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const n = p.n || 9;
            for (let i = 0; i < n; i++) {
                const s = 0.25 + rnd() * 0.65, a = rnd() * 6.28, d = rnd() * 1.25;
                deco.box(s * (0.8 + rnd() * 0.8), s * (0.5 + rnd() * 0.6), s * (0.8 + rnd() * 0.8), rnd() < 0.7 ? A.concrete : A.woodDark, M,
                    [Math.cos(a) * d, s * 0.3 + (1.25 - d) * 0.25, Math.sin(a) * d], [rnd() * 0.8, rnd() * 6.28, rnd() * 0.8]);
            }
            for (let i = 0; i < 3; i++) deco.add(new THREE.CylinderGeometry(0.018, 0.018, 1.2 + rnd(), 4), A.darkSteel, M, [(rnd() - 0.5) * 1.6, 0.7, (rnd() - 0.5) * 1.6], [rnd() * 0.6, 0, rnd() * 0.6]);
            lb.world.addCircle(p.x, p.z, 1.15, 0, 0.9);
            lb.cover.push(new THREE.Vector3(p.x, 0, p.z)); break;
        }
        case 'campfire': {    // stone ring, charred logs, glowing embers
            for (let i = 0; i < 9; i++) {
                const a = i / 9 * 6.283;
                deco.add(new THREE.DodecahedronGeometry(0.16, 0), A.concrete, M, [Math.cos(a) * 0.62, 0.1, Math.sin(a) * 0.62], [a, a * 2, 0]);
            }
            deco.add(new THREE.CylinderGeometry(0.55, 0.55, 0.03, 12), A.rubber, M, [0, 0.02, 0]);
            for (let i = 0; i < 3; i++) deco.add(new THREE.CylinderGeometry(0.06, 0.07, 0.8, 6), A.rubber, M, [0, 0.12, 0], [Math.PI / 2, i * 1.05, 0.12]);
            if (!lb._ember) { lb._ember = new THREE.MeshBasicMaterial({ color: 0xe0601a }); lb.disposables.push(lb._ember); }
            deco.add(new THREE.SphereGeometry(0.12, 6, 4), lb._ember, M, [0.03, 0.08, 0]);
            lb.world.addCircle(p.x, p.z, 0.7, 0, 0.3); break;
        }
        case 'sign': {        // post-mounted warning sign
            deco.add(new THREE.CylinderGeometry(0.045, 0.045, 2.4, 6), A.galv, M, [0, 1.2, 0]);
            if (!lb._signMat) { lb._signMat = new THREE.MeshStandardMaterial({ color: 0xb23a2a, roughness: 0.6, metalness: 0.3 }); lb.disposables.push(lb._signMat); }
            deco.box(0.9, 0.6, 0.04, lb._signMat, M, [0, 2.0, 0.05]);
            deco.box(0.7, 0.1, 0.045, A.bulb, M, [0, 2.0, 0.07]);
            lb.world.addCircle(p.x, p.z, 0.1, 0, 2.4); break;
        }
        case 'pole': {        // utility pole with crossarm and insulators
            deco.add(new THREE.CylinderGeometry(0.13, 0.19, 8, 8), A.woodDark, M, [0, 4, 0]);
            deco.box(2.2, 0.14, 0.14, A.woodDark, M, [0, 7.4, 0]);
            for (const dx of [-0.9, 0, 0.9]) deco.add(new THREE.CylinderGeometry(0.04, 0.05, 0.2, 5), A.concrete, M, [dx, 7.58, 0]);
            lb.world.addCircle(p.x, p.z, 0.2, 0, 8); break;
        }
        case 'barbed': {      // coiled razor wire on stakes
            const len = p.len || 4;
            for (let i = 0; i < Math.round(len * 1.6); i++) deco.add(new THREE.TorusGeometry(0.38, 0.012, 4, 10), A.galv, M, [0, 0.4, -len / 2 + i * 0.6], [0, 0, 0]);
            for (const z of [-len / 2, 0, len / 2]) deco.add(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5), A.darkSteel, M, [0.0, 0.55, z]);
            lb.world.addCircle(p.x, p.z, 0.5, 0, 0.9); break;
        }
        case 'spool': {       // wooden cable drum
            deco.add(new THREE.CylinderGeometry(0.8, 0.8, 0.08, 14), A.woodLight, M, [0, 0.8, 0.45], [Math.PI / 2, 0, 0]);
            deco.add(new THREE.CylinderGeometry(0.8, 0.8, 0.08, 14), A.woodLight, M, [0, 0.8, -0.45], [Math.PI / 2, 0, 0]);
            deco.add(new THREE.CylinderGeometry(0.4, 0.4, 0.84, 12), A.darkSteel, M, [0, 0.8, 0], [Math.PI / 2, 0, 0]);
            lb.world.addCircle(p.x, p.z, 0.85, 0, 1.6); lb.cover.push(new THREE.Vector3(p.x, 0, p.z)); break;
        }
        case 'tent': {        // canvas military tent
            const len = p.len || 5, wd = 3.4, ht = 2.4;
            const shape = new THREE.Shape(); shape.moveTo(-wd / 2, 0); shape.lineTo(wd / 2, 0); shape.lineTo(0, ht); shape.closePath();
            const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
            geo.translate(0, 0, -len / 2);
            const mat = lb._pbr(TextureFactory.camo(256, 1), { color: 0x7a8060, roughness: 0.95 }); mat.side = THREE.DoubleSide;
            const m = hit(geo, mat, [0, 0, 0]); lb.disposables.push(geo);
            lb.colliders.push(new THREE.Box3().setFromObject(m)); lb.cover.push(new THREE.Vector3(p.x, 0, p.z));
            for (const z of [-len / 2, len / 2]) deco.add(new THREE.CylinderGeometry(0.04, 0.04, ht + 0.3, 5), A.woodDark, M, [0, ht / 2, z]);
            break;
        }
        case 'crates': {      // stacked crates + pallet
            const wood = lb._pbr(lb._photo('wood_planks_grey', () => TextureFactory.wood(256, 1)), { color: 0xd8c4a0 });
            const a = hit(lb._box(1.2, 1.2, 1.2, 1.2), wood, [0, 0.6, 0]);
            const b = hit(lb._box(1.0, 1.0, 1.0, 1.0), wood, [1.25, 0.5, 0.1], [0, 0.3, 0]);
            const c = hit(lb._box(0.9, 0.9, 0.9, 0.9), wood, [0.3, 1.65, 0], [0, -0.4, 0]);
            [a, b, c].forEach(m => lb.colliders.push(new THREE.Box3().setFromObject(m)));
            lb.cover.push(new THREE.Vector3(p.x, 0, p.z)); break;
        }
    }
}

// ── Dirt path (ragged-edged ribbon draped on the ground) ─────────────────
export function path(lb, pts, width, tileTex) {
    const left = [], right = [], uvs = [], idx = [];
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const nx = -tz, nz = tx;
        if (i > 0) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const wob = 1 + 0.18 * Math.sin(dist * 0.35 + i);
        const hw = width * 0.5 * wob;
        const y = lb.heightAt(pts[i][0], pts[i][1]) + 0.04;
        left.push([pts[i][0] + nx * hw, y, pts[i][1] + nz * hw]);
        right.push([pts[i][0] - nx * hw, y, pts[i][1] - nz * hw]);
        uvs.push(dist);
    }
    const pos = [], uv = [];
    for (let i = 0; i < pts.length; i++) {
        pos.push(...left[i], ...right[i]);
        uv.push(0, uvs[i] / 6, 1, uvs[i] / 6);
        if (i < pts.length - 1) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const tex = tileTex.clone(); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(1, 1); tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
        map: tex, alphaMap: null, transparent: true, depthWrite: false, roughness: 0.95, color: 0x9c9686,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    const a = TextureFactory.pathAlpha(128).clone(); a.needsUpdate = true;
    mat.alphaMap = a; mat.alphaMap.channel = 0;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true; mesh.renderOrder = 1;
    lb.group.add(mesh);
    lb.disposables.push(geo, mat);
}

export { CONTAINER_COLORS };
