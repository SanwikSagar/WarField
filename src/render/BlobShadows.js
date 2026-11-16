import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Soft contact shadows for moving characters, now that nothing casts a real-time shadow.
 * One InstancedMesh (one draw call for every soldier), one shared 64px gradient texture made
 * once per session, matrices written into the existing buffer each frame (no allocation).
 */
let TEX = null;
function blobTexture() {
    if (TEX) return TEX;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(0,0,0,0.62)'); g.addColorStop(0.45, 'rgba(0,0,0,0.42)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    TEX = new THREE.CanvasTexture(c);
    return TEX;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _yaw = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

export class BlobShadows {
    constructor(scene, max = 64) {
        this.scene = scene;
        this.geometry = new THREE.PlaneGeometry(1, 1);
        this.material = new THREE.MeshBasicMaterial({
            map: blobTexture(), transparent: true, depthWrite: false, fog: true,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, max);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
        this.mesh.userData.environmentManaged = true;
        scene.add(this.mesh);
    }

    /** groups: iterable of { group, dead } — the feet-level root of every character. */
    update(entries, camPos, extra = null) {
        const mesh = this.mesh, max = mesh.instanceMatrix.count;
        let n = 0;
        for (const e of extra ? [entries, extra] : [entries]) for (const e2 of e) n = this._one(e2, camPos, n, max);
        mesh.count = n;
        if (n) { mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, n * 16); mesh.instanceMatrix.needsUpdate = true; }
    }

    _one(e, camPos, n, max) {
        const mesh = this.mesh;
        {
            if (n >= max) return n;
            const g = e.group;
            if (!g || !g.visible) return n;
            const dx = g.position.x - camPos.x, dz = g.position.z - camPos.z;
            if (dx * dx + dz * dz > 70 * 70) return n;           // invisible that far away anyway
            _p.set(g.position.x, g.position.y + 0.03, g.position.z);
            // a body lying down leaves a longer, darker patch along its facing
            _yaw.setFromAxisAngle(_up, g.rotation.y);
            _q.copy(_yaw).multiply(FLAT);
            if (e.dead) _s.set(0.9, 1.9, 1); else _s.set(0.95, 0.95, 1);
            _m.compose(_p, _q, _s);
            mesh.setMatrixAt(n++, _m);
        }
        return n;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.dispose(); this.geometry.dispose(); this.material.dispose();
    }
}
