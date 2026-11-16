import * as THREE from '/node_modules/three/build/three.module.js';
import { mergeGeometries } from '/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { DecalBatch, CELL } from '../render/DecalAtlas.js';

/**
 * Bodies stay where they fall. Once a body has settled, its skinned meshes are baked into
 * static world-space geometry (the final pose, via SkinnedMesh.applyBoneTransform) and merged
 * with every other body that shares a look: all the dead in a level cost a handful of draw
 * calls, no skinning and no animation updates. A blood pool decal (shared atlas) goes under each.
 */
const _v = new THREE.Vector3();

export class CorpseBatch {
    constructor(scene) {
        this.scene = scene;
        this.groups = new Map();      // material key -> { material, geos: [], mesh }
        this.dirty = false;
        this.count = 0;
        this.decals = new DecalBatch(scene, 96, { ring: true });
    }

    _key(m) { return `${m.map ? m.map.uuid : '-'}|${m.color ? m.color.getHexString() : ''}|${m.type}`; }

    /** Bake every visible (skinned or rigid) mesh under root into the batch. root keeps existing; hide it yourself. */
    bake(root, { blood = true, bloodPos = null } = {}) {
        root.updateMatrixWorld(true);
        root.traverse(o => {
            if (!o.isMesh || !o.geometry || o.name === 'head' || o.name === 'body') return;
            for (let p = o; p; p = p.parent) if (!p.visible && p !== root) return;
            if (o.material && o.material.visible === false) return;
            const src = o.geometry, pos = src.attributes.position, n = pos.count;
            const out = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) {
                _v.fromBufferAttribute(pos, i);
                if (o.isSkinnedMesh) o.applyBoneTransform(i, _v);
                _v.applyMatrix4(o.matrixWorld);
                out[i * 3] = _v.x; out[i * 3 + 1] = _v.y; out[i * 3 + 2] = _v.z;
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(out, 3));
            if (src.attributes.uv) g.setAttribute('uv', src.attributes.uv.clone());
            else g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
            if (src.index) g.setIndex(src.index.clone());
            g.computeVertexNormals();
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            const mat = mats[0];
            const key = this._key(mat);
            let grp = this.groups.get(key);
            if (!grp) {
                const m = mat.clone();
                if (m.emissive) m.emissive.setRGB(0, 0, 0);
                if (m.color) { const hsl = {}; m.color.getHSL(hsl); m.color.setHSL(hsl.h, hsl.s * 0.7, hsl.l * 0.62); }
                if ('roughness' in m) m.roughness = Math.max(0.9, m.roughness ?? 0.9);
                m.userData = { ...m.userData, corpse: true };
                grp = { material: m, geos: [], mesh: null };
                this.groups.set(key, grp);
            }
            grp.geos.push(g);
        });
        if (blood) {
            const p = bloodPos || root.getWorldPosition(new THREE.Vector3());
            this.decals.add(_v.set(p.x + (Math.random() - 0.5) * 0.6, p.y + 0.01, p.z + (Math.random() - 0.5) * 0.6), new THREE.Vector3(0, 1, 0),
                1.1 + Math.random() * 0.8, Math.random() < 0.5 ? CELL.bloodA : CELL.bloodB, Math.random() * 6.28, 0.9);
        }
        this.count++;
        this.dirty = true;
    }

    /** merge pending bodies (call once per frame; cheap when nothing changed) */
    update() {
        if (!this.dirty) return;
        this.dirty = false;
        for (const grp of this.groups.values()) {
            if (!grp.geos.length) continue;
            // attributes must match for merging: keep position / normal / uv only
            const geos = grp.geos.map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g.index ? g : g; });
            const allIndexed = geos.every(g => g.index), noneIndexed = geos.every(g => !g.index);
            const list = allIndexed || noneIndexed ? geos : geos.map(g => (g.index ? g.toNonIndexed() : g));
            const merged = mergeGeometries(list, false);
            if (!merged) continue;
            merged.computeBoundingSphere();
            if (grp.mesh) { grp.mesh.geometry.dispose(); grp.mesh.geometry = merged; }
            else {
                grp.mesh = new THREE.Mesh(merged, grp.material);
                grp.mesh.receiveShadow = true;
                grp.mesh.userData.environmentManaged = true;
                this.scene.add(grp.mesh);
            }
            grp.geos = [merged.clone()];      // keep one merged source to append to next time
        }
    }

    dispose() {
        for (const grp of this.groups.values()) {
            if (grp.mesh) { this.scene.remove(grp.mesh); grp.mesh.geometry.dispose(); }
            grp.geos.forEach(g => g.dispose());
            grp.material.dispose();
        }
        this.groups.clear();
        this.decals.dispose();
    }
}
