/**
 * Static collision world: uniform-grid broadphase over axis-aligned boxes and
 * vertical cylinders (tree trunks, boulders). Everything that moves (player,
 * enemies, squad) queries it instead of looping over every collider or
 * raycasting against render meshes.
 *
 *   resolve()        push a circle out of overlapping solids (smooth sliding,
 *                    no sticking on corners, handles being embedded)
 *   segmentBlocked() cheap line-of-sight test in the XZ plane at a height
 *   rayHit()         bullet test against cylinders (trees / rocks)
 *
 * Cost per query is proportional to the few cells touched, not to the number
 * of colliders in the level.
 */
export class CollisionWorld {
    constructor(cell = 8) {
        this.cell = cell;
        this.items = [];
        this.grid = new Map();
        this._stamp = 1;
    }

    _key(cx, cz) { return (cx + 2048) * 4096 + (cz + 2048); }

    _insert(it) {
        const c = this.cell;
        const x0 = Math.floor(it.minx / c), x1 = Math.floor(it.maxx / c);
        const z0 = Math.floor(it.minz / c), z1 = Math.floor(it.maxz / c);
        for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
            const k = this._key(i, j);
            let list = this.grid.get(k);
            if (!list) this.grid.set(k, list = []);
            list.push(it);
        }
        this.items.push(it);
    }

    /** THREE.Box3 (world space) */
    addBox(b) {
        this._insert({ t: 0, minx: b.min.x, maxx: b.max.x, minz: b.min.z, maxz: b.max.z, miny: b.min.y, maxy: b.max.y, seen: 0 });
    }

    addCircle(x, z, r, y0 = 0, y1 = 6) {
        this._insert({ t: 1, x, z, r, minx: x - r, maxx: x + r, minz: z - r, maxz: z + r, miny: y0, maxy: y1, seen: 0 });
    }

    /**
     * Push a circle (pos.x/pos.z, radius) out of everything it overlaps within
     * the vertical span [y0,y1]. Mutates pos. Returns true if it moved.
     */
    resolve(pos, radius, y0, y1) {
        let moved = false;
        const c = this.cell;
        for (let pass = 0; pass < 3; pass++) {
            let hit = false;
            const stamp = this._stamp++;
            const cx0 = Math.floor((pos.x - radius) / c), cx1 = Math.floor((pos.x + radius) / c);
            const cz0 = Math.floor((pos.z - radius) / c), cz1 = Math.floor((pos.z + radius) / c);
            for (let i = cx0; i <= cx1; i++) for (let j = cz0; j <= cz1; j++) {
                const list = this.grid.get(this._key(i, j));
                if (!list) continue;
                for (let k = 0; k < list.length; k++) {
                    const it = list[k];
                    if (it.seen === stamp) continue;
                    it.seen = stamp;
                    if (it.maxy < y0 || it.miny > y1) continue;
                    if (it.t === 1) {
                        const dx = pos.x - it.x, dz = pos.z - it.z;
                        const rr = radius + it.r, d2 = dx * dx + dz * dz;
                        if (d2 >= rr * rr) continue;
                        const d = Math.sqrt(d2) || 1e-4;
                        const push = rr - d;
                        pos.x += (dx / d) * push; pos.z += (dz / d) * push;
                    } else {
                        const qx = Math.max(it.minx, Math.min(pos.x, it.maxx));
                        const qz = Math.max(it.minz, Math.min(pos.z, it.maxz));
                        const dx = pos.x - qx, dz = pos.z - qz, d2 = dx * dx + dz * dz;
                        if (d2 >= radius * radius) continue;
                        if (d2 > 1e-8) {
                            const d = Math.sqrt(d2), push = radius - d;
                            pos.x += (dx / d) * push; pos.z += (dz / d) * push;
                        } else {
                            // centre is inside the box: leave through the nearest face
                            const l = pos.x - it.minx, r = it.maxx - pos.x, f = pos.z - it.minz, b = it.maxz - pos.z;
                            const m = Math.min(l, r, f, b);
                            if (m === l) pos.x = it.minx - radius; else if (m === r) pos.x = it.maxx + radius;
                            else if (m === f) pos.z = it.minz - radius; else pos.z = it.maxz + radius;
                        }
                    }
                    hit = true;
                }
            }
            if (!hit) break;
            moved = true;
        }
        return moved;
    }

    /** True if the XZ segment a->b passes through any solid that spans height y. */
    segmentBlocked(ax, az, bx, bz, y = 1.3) {
        const c = this.cell, dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil(len / (c * 0.5)));
        const stamp = this._stamp++;
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const list = this.grid.get(this._key(Math.floor((ax + dx * t) / c), Math.floor((az + dz * t) / c)));
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
                const it = list[k];
                if (it.seen === stamp) continue;
                it.seen = stamp;
                if (it.maxy < y || it.miny > y) continue;
                if (it.t === 1) {
                    // distance from circle centre to segment
                    const fx = it.x - ax, fz = it.z - az;
                    const tt = len > 1e-6 ? Math.max(0, Math.min(1, (fx * dx + fz * dz) / (len * len))) : 0;
                    const px = ax + dx * tt - it.x, pz = az + dz * tt - it.z;
                    if (px * px + pz * pz < it.r * it.r) return true;
                } else if (segRect(ax, az, bx, bz, it)) return true;
            }
        }
        return false;
    }

    /**
     * 3D ray vs cylinders only (tree trunks / boulders): returns hit distance
     * or Infinity. Boxes are covered by the render-mesh raycast.
     */
    rayHit(ox, oy, oz, dx, dy, dz, maxDist) {
        const c = this.cell;
        const hl = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil((hl * maxDist) / (c * 0.5)));
        const stamp = this._stamp++;
        let best = Infinity;
        for (let s = 0; s <= steps; s++) {
            const t = (s / steps) * maxDist;
            const list = this.grid.get(this._key(Math.floor((ox + dx * t) / c), Math.floor((oz + dz * t) / c)));
            if (!list) continue;
            for (let k = 0; k < list.length; k++) {
                const it = list[k];
                if (it.t !== 1 || it.seen === stamp) continue;
                it.seen = stamp;
                if (hl < 1e-6) continue;
                const fx = ox - it.x, fz = oz - it.z;
                const a = dx * dx + dz * dz, b = 2 * (fx * dx + fz * dz), cc = fx * fx + fz * fz - it.r * it.r;
                const disc = b * b - 4 * a * cc;
                if (disc < 0) continue;
                const t0 = (-b - Math.sqrt(disc)) / (2 * a);
                if (t0 < 0 || t0 > maxDist || t0 >= best) continue;
                const y = oy + dy * t0;
                if (y >= it.miny && y <= it.maxy) best = t0;
            }
        }
        return best;
    }
}

function segRect(ax, az, bx, bz, r) {
    // Liang-Barsky clip of the segment against the rectangle
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dz = bz - az;
    const p = [-dx, dx, -dz, dz], q = [ax - r.minx, r.maxx - ax, az - r.minz, r.maxz - az];
    for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return false; continue; }
        const t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
}
