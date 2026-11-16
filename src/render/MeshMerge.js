import * as THREE from '/node_modules/three/build/three.module.js';
import { mergeGeometries } from '/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Static batching at load time: collapse a multi-part model into ONE mesh per material,
 * with every part's transform baked into the vertices. A 30-part rifle becomes 2-4 draw
 * calls, and because the result is cached per model, every copy in the level shares the
 * same GPU buffers and materials (and the scenery LOD can GPU-instance the copies).
 *
 * Skinned meshes, invisible parts and anything `keep(mesh)` returns true for (parts that
 * must still move, e.g. a turret head) are left as separate meshes.
 */
const ATTRS = ['position', 'normal', 'uv', 'color'];

function prepare(geo, matrix, want) {
    const g = geo.clone();
    for (const name of Object.keys(g.attributes)) if (!want.has(name)) g.deleteAttribute(name);
    for (const name of want) {
        if (!g.attributes[name]) {
            const n = g.attributes.position.count, size = name === 'uv' ? 2 : 3;
            const arr = new Float32Array(n * size);
            if (name === 'color') arr.fill(1);
            g.setAttribute(name, new THREE.BufferAttribute(arr, size));
        }
    }
    // decoded/quantized sources mix storage types (int16, normalized, interleaved): merge as plain floats
    for (const name of want) {
        const a = g.attributes[name];
        if (a.array instanceof Float32Array && !a.normalized && !a.isInterleavedBufferAttribute) continue;
        const n = a.count, s = a.itemSize, arr = new Float32Array(n * s);
        const get = [a.getX, a.getY, a.getZ, a.getW];
        for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) arr[i * s + c] = get[c].call(a, i);
        g.setAttribute(name, new THREE.BufferAttribute(arr, s));
    }
    for (const k of Object.keys(g.morphAttributes)) delete g.morphAttributes[k];
    if (!g.index) {
        const n = g.attributes.position.count, idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.clearGroups();
    g.applyMatrix4(matrix);
    return g;
}

function visibleChain(o, root) {
    for (let p = o; p && p !== root; p = p.parent) if (!p.visible) return false;
    return true;
}

export function mergeByMaterial(root, { keep = null } = {}) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map();
    const kept = [];
    root.traverse(o => {
        if (!o.isMesh) return;
        if (o.isSkinnedMesh || (keep && keep(o)) || Array.isArray(o.material)) { if (visibleChain(o, root)) kept.push(o); return; }
        if (!visibleChain(o, root)) return;
        const local = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
        let b = buckets.get(o.material);
        if (!b) buckets.set(o.material, b = { parts: [], cast: false, receive: false });
        b.parts.push({ geo: o.geometry, local });
        b.cast = b.cast || o.castShadow; b.receive = b.receive || o.receiveShadow;
    });
    const out = new THREE.Group();
    out.name = root.name;
    for (const [mat, b] of buckets) {
        // only keep attributes every part has (colour only when the material actually uses it)
        const want = new Set(ATTRS.filter(a => a !== 'color' || mat.vertexColors));
        want.forEach(a => { if (a !== 'position' && a !== 'normal' && a !== 'uv' && !b.parts.every(p => p.geo.attributes[a])) want.delete(a); });
        if (!b.parts.every(p => p.geo.attributes.normal)) want.delete('normal');
        const geos = b.parts.map(p => prepare(p.geo, p.local, want));
        const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
        if (geos.length > 1) geos.forEach(g => g.dispose());
        if (!merged) continue;
        if (!want.has('normal')) merged.computeVertexNormals();
        merged.computeBoundingBox(); merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = b.cast; mesh.receiveShadow = b.receive;
        out.add(mesh);
    }
    for (const o of kept) {
        const c = o.clone();
        new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld).decompose(c.position, c.quaternion, c.scale);
        out.add(c);
    }
    return out;
}
