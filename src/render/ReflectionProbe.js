import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * One-shot reflection probe. The level is rendered ONCE from a central point into a tiny
 * cubemap (6 small renders, at load), prefiltered with PMREM so roughness blurs it
 * correctly, and handed only to the materials that visibly reflect: window glass, shop
 * fronts, vehicle paint and wet ground. Glass then mirrors the actual street — buildings,
 * wrecks, the burning sky — instead of a generic HDRI, at zero per-frame cost.
 *
 * Materials opt in with `material.userData.probe = true`.
 */
export function buildReflectionProbe(renderer, scene, { position, size = 128, hide = [] } = {}) {
    const t0 = performance.now();
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(0.5, 400, rt);
    cam.position.copy(position);
    // camera-facing billboards (fire/smoke) would be wrong in a cubemap: leave them out
    const restore = hide.map(o => { const v = o.visible; o.visible = false; return () => { o.visible = v; }; });
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    cam.update(renderer, scene);
    renderer.shadowMap.autoUpdate = prevAuto;
    renderer.setRenderTarget(prevTarget);
    restore.forEach(f => f());

    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(rt.texture);
    pmrem.dispose();
    rt.dispose();

    let count = 0;
    scene.traverse(o => {
        if (!o.isMesh) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
            if (m && m.userData && m.userData.probe && m.envMap !== env.texture) { m.envMap = env.texture; m.needsUpdate = true; count++; }
        }
    });
    return { env, count, ms: performance.now() - t0, dispose() { env.dispose(); } };
}
