import * as THREE from '/node_modules/three/build/three.module.js';
import { InstanceLOD } from '../environments/Foliage.js';

/**
 * Baked sun shadows: the shadow map is rendered ONCE per level, during loading, and never again.
 *
 *   - The sun's shadow camera is fixed over the whole play area (it no longer follows the player).
 *   - Every static opaque caster is welded into ONE combined, position-only mesh (one draw call),
 *     built from world-space copies of the source geometry and thrown away right after the bake.
 *   - Alpha-tested casters (leaves, chain-link fence) keep their own materials so cut-outs stay
 *     cut out; instanced scenery (trees, rocks, props) is drawn with every instance at once
 *     through temporary InstancedMeshes, so far objects cast exactly like near ones.
 *   - Afterwards renderer.shadowMap.autoUpdate is false and every castShadow flag is cleared:
 *     there is no shadow pass at run time at all. Receivers just sample the stored map.
 *   - Moving characters get soft contact blobs instead (BlobShadows).
 */
function chainVisible(o) {
    // a SceneryLOD source is hidden (it draws through instanced buckets) but is still the real caster
    let p = o.parent;
    while (p) { if (!p.visible) return false; p = p.parent; }
    return o.visible || !!o.userData.lodManaged;
}
const isCutout = (m) => m && (m.alphaTest > 0 || m.transparent || !!m.alphaMap || !!m.userData?.foliage);

export function bakeStaticShadows(gl, scene, camera, sun, { bounds = 90, mapSize = 2048 } = {}) {
    const t0 = performance.now();
    scene.updateMatrixWorld(true);

    // ── 1. fixed shadow frustum over the whole level ──
    const half = bounds + 30;
    const dir = new THREE.Vector3().copy(sun.position).sub(sun.target.position).normalize();
    sun.target.position.set(0, 0, 0);
    sun.position.copy(dir).multiplyScalar(half * 2.2);
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    const sc = sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = 1; sc.far = half * 4.6;
    sc.updateProjectionMatrix();
    const texel = (half * 2) / mapSize;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = Math.max(0.03, texel * 0.9);
    if (sun.shadow.mapSize.x !== mapSize) {
        sun.shadow.mapSize.set(mapSize, mapSize);
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }

    // ── 2. gather casters (and switch every run-time caster off for good) ──
    const merged = [], cutouts = [];
    const rebake = !!scene.userData.shadowBaked;
    scene.userData.shadowBaked = true;
    scene.traverse(o => {
        if (!o.isMesh) return;
        const casts = rebake ? o.userData.bakedCaster === true : o.castShadow;
        o.castShadow = false;
        if (casts) o.userData.bakedCaster = true;
        if (!casts || o.isSkinnedMesh || o.userData.environmentManaged || o.userData.dynamic || !chainVisible(o)) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (o.isInstancedMesh || mats.some(isCutout) || o.geometry.morphAttributes.position) cutouts.push(o);
        else merged.push(o);
    });

    const temp = [], owned = [];
    // ── 3. one combined caster mesh ──
    let vCount = 0, iCount = 0;
    for (const o of merged) {
        const g = o.geometry;
        vCount += g.attributes.position.count;
        iCount += g.index ? g.index.count : g.attributes.position.count;
    }
    if (vCount) {
        const pos = new Float32Array(vCount * 3);
        const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
        let vo = 0, io = 0;
        for (const o of merged) {
            const g = o.geometry, p = g.attributes.position, n = p.count, e = o.matrixWorld.elements;
            for (let i = 0; i < n; i++) {
                const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = (vo + i) * 3;
                pos[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
                pos[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
                pos[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
            }
            if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i++) idx[io++] = a[i] + vo; }
            else for (let i = 0; i < n; i++) idx[io++] = vo + i;
            vo += n;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        // double-sided in the depth pass so single-sided walls and roofs still block the sun
        const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
        const proxy = new THREE.Mesh(geo, mat);
        proxy.castShadow = true; proxy.frustumCulled = false;
        temp.push(proxy); owned.push(geo, mat);
    }

    // cut-out / instanced casters: temporary twins with their own materials (alpha-tested depth)
    for (const o of cutouts) {
        let twin;
        if (o.isInstancedMesh) {
            twin = new THREE.InstancedMesh(o.geometry, o.material, 1);
            twin.instanceMatrix = o.instanceMatrix; twin.count = o.count;
        } else twin = new THREE.Mesh(o.geometry, o.material);
        twin.matrixAutoUpdate = false; twin.matrix.copy(o.matrixWorld);
        twin.castShadow = true; twin.frustumCulled = false;
        temp.push(twin);
    }

    // instanced scenery: every instance at once, in its best geometric (non-card) tier
    for (const lod of InstanceLOD.live) temp.push(...lod.shadowBakeMeshes());

    // ── 4. render the shadow map once ──
    // A private scene holds only the sun and the casters, rendered into a 1x1 target. Its colour pass
    // draws everything with one invisible override material (one tiny program, no level-shader
    // compiles); the shadow pass ignores the override and uses each caster's own material, so
    // alpha-tested leaves and fences still cut out.
    const bakeScene = new THREE.Scene();
    const invisible = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    bakeScene.overrideMaterial = invisible;
    const sunParent = sun.parent, targetParent = sun.target.parent;
    bakeScene.add(sun); bakeScene.add(sun.target);
    temp.forEach(t => bakeScene.add(t));
    bakeScene.updateMatrixWorld(true);
    const eye = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1);
    gl.shadowMap.enabled = true;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    sun.castShadow = true;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    const prevTarget = gl.getRenderTarget(), prevAutoClear = gl.autoClear;
    const scratch = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    gl.setRenderTarget(scratch);
    try { gl.render(bakeScene, eye); }
    finally {
        gl.setRenderTarget(prevTarget); gl.autoClear = prevAutoClear;
        scratch.dispose(); invisible.dispose();
        (sunParent || scene).add(sun); (targetParent || scene).add(sun.target);
        sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
        temp.forEach(t => bakeScene.remove(t));
        owned.forEach(r => r.dispose());
        temp.forEach(t => { if (t.userData.bakeOwned) t.dispose(); });   // twins share live instance buffers: never dispose those
    }
    return { ms: Math.round(performance.now() - t0), merged: merged.length, combinedVertices: vCount, cutouts: cutouts.length, texel: +texel.toFixed(3) };
}
