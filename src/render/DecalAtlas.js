import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Every damage / debris decal in the game comes from ONE 1024x1024 WebP sprite atlas
 * (public/assets/vfx/decals.webp, 4x4 cells of 256 px, ~220 KB): bullet holes, blood,
 * scorch, cracks, leaks, tyre tracks, rubble / soot / dust splats and oil.
 * Sources: ambientCG + Poly Haven CC0 photos and hand-drawn cells (see CREDITS.md)
 * (tools/atlas-src/build.html composes it).
 *
 * A DecalBatch draws any number of decals as ONE InstancedMesh: the atlas cell and opacity
 * ride along as a per-instance attribute, so bullet holes, blood and level damage of every
 * kind cost a single draw call and share one texture and one shader program.
 */
export const CELL = {
    holeConcrete: 0, holeMetal: 1, holeWood: 2, holeDirt: 3, bloodA: 4, bloodB: 5, scorchA: 6, scorchB: 7,
    cracksA: 8, leak: 9, cracksB: 10, tire: 11, rubble: 12, burnt: 13, oil: 14, dust: 15
};
export const HOLE_CELL = { concrete: CELL.holeConcrete, metal: CELL.holeMetal, wood: CELL.holeWood, dirt: CELL.holeDirt };

let TEX = null;
export function decalTexture() {
    if (!TEX) {
        TEX = new THREE.TextureLoader().load('/assets/vfx/decals.webp');
        TEX.colorSpace = THREE.SRGBColorSpace;
        TEX.anisotropy = 4;
    }
    return TEX;
}

const Z = new THREE.Vector3(0, 0, 1), _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _n = new THREE.Vector3();

export class DecalBatch {
    /**
     * parent: scene or group. max: capacity. ring: oldest decals are recycled when full (impacts);
     * otherwise extra adds are ignored (static level damage).
     */
    constructor(parent, max, { ring = true, roughness = 0.92 } = {}) {
        this.parent = parent; this.max = max; this.ring = ring; this.n = 0; this.next = 0;
        const g = new THREE.PlaneGeometry(1, 1);
        this.cell = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('iCell', this.cell);
        this.geometry = g;
        const m = this.material = new THREE.MeshStandardMaterial({
            map: decalTexture(), transparent: true, depthWrite: false, roughness, metalness: 0,
            polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        });
        m.userData.noBake = true;
        m.onBeforeCompile = (shader) => {
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nattribute vec2 iCell;\nvarying float vDecalA;')
                .replace('#include <uv_vertex>', `#include <uv_vertex>
                    vec2 dCell = vec2(mod(iCell.x, 4.0), 3.0 - floor(iCell.x / 4.0));
                    vMapUv = (uv * 0.985 + 0.0075 + dCell) * 0.25;          // small inset: no bleeding from the neighbour cell
                    vDecalA = iCell.y;`);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nvarying float vDecalA;')
                .replace('#include <map_fragment>', '#include <map_fragment>\n    diffuseColor.a *= vDecalA;');
        };
        m.customProgramCacheKey = () => 'decalAtlas1';
        const mesh = this.mesh = new THREE.InstancedMesh(g, m, max);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0; mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.renderOrder = 1;
        mesh.userData.environmentManaged = true;
        parent.add(mesh);
    }

    /** pos/normal: world (or parent-local) space; size in metres; rot radians about the normal. */
    add(pos, normal, size, cell, rot = Math.random() * Math.PI * 2, alpha = 1, sizeY = size) {
        if (this.n >= this.max && !this.ring) return -1;
        const i = this.next;
        this.next = (this.next + 1) % this.max;
        if (this.n < this.max) this.n++;
        _n.copy(normal).normalize();
        _q.setFromUnitVectors(Z, _n);
        _r.setFromAxisAngle(Z, rot);
        _q.multiply(_r);
        _p.copy(pos).addScaledVector(_n, 0.012);
        _s.set(size, sizeY, 1);
        _m.compose(_p, _q, _s);
        this.mesh.setMatrixAt(i, _m);
        this.cell.setXY(i, cell, alpha);
        this.mesh.count = this.n;
        this.mesh.instanceMatrix.needsUpdate = true;
        this.cell.needsUpdate = true;
        return i;
    }

    clear() { this.n = 0; this.next = 0; this.mesh.count = 0; }

    dispose() {
        this.parent.remove(this.mesh);
        this.mesh.dispose(); this.geometry.dispose(); this.material.dispose();
    }
}
