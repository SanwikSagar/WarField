import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * CPU occlusion culling (software depth buffer, the same idea as masked/hierarchical occlusion
 * culling in big engines, kept tiny):
 *
 *   1. Occluders are the level's big solid boxes (buildings, walls, containers, rock faces) taken
 *      from its colliders, shrunk a little so they never claim more than they really cover.
 *   2. At up to 30 Hz they are rasterised, as real triangles with interpolated depth, into a
 *      128x72 float depth buffer seen from the current camera.
 *   3. Anything can then ask test(box): its screen rectangle is checked against the buffer, and it
 *      is hidden only if every pixel it could touch is covered by something NEARER than its own
 *      nearest point. Pixel-centre rasterisation under-covers and the rect is grown by a pixel, so
 *      the test errs on the side of drawing.
 *
 * Users: the instanced scenery LOD (every tree / prop / wreck instance) and the characters.
 */
const W = 128, H = 72;
const _vp = new THREE.Matrix4();
const C = new Float32Array(8 * 4);        // projected corners: x, y (pixels), z (ndc), w

export class OcclusionCuller {
    constructor() {
        this.depth = new Float32Array(W * H);
        this.occ = new Float32Array(0);      // 6 floats per occluder box
        this.n = 0;
        this.ready = false;
        this.acc = 1;
        this.enabled = true;
        this.camPos = new THREE.Vector3();
        this.stats = { occluders: 0, tested: 0, culled: 0 };
        this.gen = 0;                        // bumped when culling settings change: instanced LODs re-evaluate
    }

    /** colliders: Box3[]. Keeps the boxes big enough to hide something, shrinks them by `inset`. */
    setOccluders(colliders, inset = 0.3) {
        const list = [];
        for (const b of colliders || []) {
            const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
            if (sy < 2.2 || Math.max(sx, sz) < 3 || sx * sz < 6 || Math.max(sx, sz) > 160) continue;
            list.push(b.min.x + inset, b.min.y, b.min.z + inset, b.max.x - inset, b.max.y - inset, b.max.z - inset);
        }
        this.occ = Float32Array.from(list);
        this.meshes = [];
        this.n = list.length / 6;
        this.stats.occluders = this.n;
        this.ready = false;
        this.gen++;
    }

    clear() { this.n = 0; this.ready = false; this.meshes = []; }

    /** Static meshes culled every time the buffer is rebuilt (e.g. chunked set dressing). World AABB cached. */
    register(mesh) {
        if (!this.meshes) this.meshes = [];
        mesh.updateMatrixWorld(true);
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const b = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        this.meshes.push({ mesh, b: Float32Array.of(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z) });
    }

    _cullMeshes() {
        const list = this.meshes;
        if (!list || !list.length) return;
        let hidden = 0;
        for (let i = 0; i < list.length; i++) {
            const e = list[i], b = e.b;
            const v = !this.enabled || this.test(b[0], b[1], b[2], b[3], b[4], b[5]);
            e.mesh.visible = v;
            if (!v) hidden++;
        }
        this.stats.meshesHidden = hidden;
    }

    /** Rebuild the depth buffer for this camera (throttled to 30 Hz). */
    update(dt, camera) {
        this.acc += dt;
        if (!this.enabled || !this.n) {
            if (this.ready || this.stats.meshesHidden) { this.ready = false; this._cullMeshes(); }    // show everything again
            this.ready = false; return;
        }
        if (this.acc < 1 / 30 && this.ready) return;
        this.acc = 0;
        camera.updateMatrixWorld();
        _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.vp = _vp.elements;
        camera.getWorldPosition(this.camPos);
        this.near = camera.near;
        const D = this.depth; D.fill(Infinity);
        const o = this.occ, cx = this.camPos.x, cz = this.camPos.z;
        for (let i = 0; i < this.n; i++) {
            const k = i * 6;
            // far occluders hide little and cost the same: skip beyond 140 m
            const nx = Math.max(o[k] - cx, 0, cx - o[k + 3]), nz = Math.max(o[k + 2] - cz, 0, cz - o[k + 5]);
            if (nx * nx + nz * nz > 140 * 140) continue;
            // camera inside (or touching) the box: it would cover the whole screen wrongly
            if (nx === 0 && nz === 0) continue;
            if (!this._project(o[k], o[k + 1], o[k + 2], o[k + 3], o[k + 4], o[k + 5])) continue;   // crosses the near plane
            // 12 triangles (both windings are fine: the depth test keeps the nearest surface)
            for (let f = 0; f < 36; f += 3) this._tri(FACES[f], FACES[f + 1], FACES[f + 2]);
        }
        this.ready = true;
        this._cullMeshes();
    }

    /** project the 8 corners into C; false if any is behind the near plane */
    _project(x0, y0, z0, x1, y1, z1) {
        const e = this.vp;
        for (let c = 0; c < 8; c++) {
            const x = c & 1 ? x1 : x0, y = c & 2 ? y1 : y0, z = c & 4 ? z1 : z0;
            const w = e[3] * x + e[7] * y + e[11] * z + e[15];
            if (w < this.near * 1.05) return false;
            const px = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
            const py = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
            const pz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
            const j = c * 4;
            C[j] = (px * 0.5 + 0.5) * W; C[j + 1] = (0.5 - py * 0.5) * H; C[j + 2] = pz; C[j + 3] = w;
        }
        return true;
    }

    _tri(a, b, c) {
        const ax = C[a * 4], ay = C[a * 4 + 1], az = C[a * 4 + 2];
        const bx = C[b * 4], by = C[b * 4 + 1], bz = C[b * 4 + 2];
        const cx = C[c * 4], cy = C[c * 4 + 1], cz = C[c * 4 + 2];
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-6) return;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
        if (x0 > x1 || y0 > y1) return;
        const inv = 1 / area, D = this.depth;
        for (let y = y0; y <= y1; y++) {
            const py = y + 0.5;
            for (let x = x0; x <= x1; x++) {
                const px = x + 0.5;
                // barycentrics from edge functions (pixel centre must be strictly inside: under-coverage only)
                const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
                const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * az + w1 * bz + w2 * cz;
                const i = y * W + x;
                if (z < D[i]) D[i] = z;
            }
        }
    }

    /** true if the box may be visible (always true when the buffer is not ready). */
    test(x0, y0, z0, x1, y1, z1) {
        if (!this.ready) return true;
        this.stats.tested++;
        if (!this._project(x0, y0, z0, x1, y1, z1)) return true;            // touches the near plane: draw it
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
        for (let c = 0; c < 8; c++) {
            const j = c * 4;
            if (C[j] < minX) minX = C[j]; if (C[j] > maxX) maxX = C[j];
            if (C[j + 1] < minY) minY = C[j + 1]; if (C[j + 1] > maxY) maxY = C[j + 1];
            if (C[j + 2] < minZ) minZ = C[j + 2];
        }
        const rx0 = Math.max(0, Math.floor(minX) - 1), rx1 = Math.min(W - 1, Math.ceil(maxX) + 1);
        const ry0 = Math.max(0, Math.floor(minY) - 1), ry1 = Math.min(H - 1, Math.ceil(maxY) + 1);
        if (rx0 > rx1 || ry0 > ry1) return true;                             // off screen: frustum culling decides
        const D = this.depth;
        for (let y = ry0; y <= ry1; y++) {
            const row = y * W;
            for (let x = rx0; x <= rx1; x++) if (D[row + x] >= minZ) return true;   // a pixel where it could show through
        }
        this.stats.culled++;
        return false;
    }

    /** sphere convenience (characters) */
    testSphere(x, y, z, r) { return this.test(x - r, y - r, z - r, x + r, y + r, z + r); }
}

// corner index = (x?1:0) | (y?2:0) | (z?4:0)
const FACES = new Uint8Array([
    0, 2, 1, 1, 2, 3,     // z0
    4, 5, 6, 5, 7, 6,     // z1
    0, 1, 4, 1, 5, 4,     // y0
    2, 6, 3, 3, 6, 7,     // y1
    0, 4, 2, 2, 4, 6,     // x0
    1, 3, 5, 3, 7, 5      // x1
]);

/** shared instance (the level's culler) */
export const occlusion = new OcclusionCuller();

/** Horizontal view cone for per-instance frustum culling (set each frame by Game). */
export const viewCone = { cosHalf: -1, tanHalfV: 1, valid: false, enabled: true };
export function updateViewCone(camera) {
    const v = THREE.MathUtils.degToRad(camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(v) * camera.aspect);
    viewCone.halfH = hHalf; viewCone.cosHalf = Math.cos(Math.min(Math.PI, hHalf + 0.12)); viewCone.valid = viewCone.enabled;
}
