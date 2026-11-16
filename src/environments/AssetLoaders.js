import * as THREE from '/node_modules/three/build/three.module.js';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '/node_modules/three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from '/node_modules/three/examples/jsm/loaders/KTX2Loader.js';
import { assetStream } from './AssetStream.js';
import { assetUrl } from '../utils/assetUrl.js';

/**
 * Shared loaders. Textures ship as KTX2 (Basis ETC1S): ~4x smaller files AND
 * they stay GPU-compressed in VRAM (the browser transcodes to the GPU's native
 * BC7/ASTC/ETC format), with pre-baked mipmaps. Geometry may be Draco.
 */
let ktx2 = null, draco = null, rendererRef = null;

export function initLoaders(renderer) {
    if (ktx2) return;
    rendererRef = renderer;
    ktx2 = new KTX2Loader().setTranscoderPath(assetUrl('/assets/basis/')).setWorkerLimit(2).detectSupport(renderer);
    draco = new DRACOLoader().setDecoderPath(assetUrl('/assets/draco/')).setWorkerLimit(2);
}

export function getKTX2() { return ktx2; }

/**
 * KHR_materials_transmission glass (Poly Haven scans ship it on lamp / generator / searchlight lenses)
 * makes three.js render the whole opaque scene a SECOND time into a transmission buffer whenever one
 * such surface is on screen (~20 ms per frame measured on integrated graphics). A tinted, glossy,
 * alpha-blended standard material looks the same at game distances, so every loaded model gets one.
 */
function stripTransmission(gltf) {
    const swap = new Map();
    gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        const fix = (m) => {
            if (!m || !m.isMeshPhysicalMaterial || !(m.transmission > 0)) return m;
            if (!swap.has(m)) {
                const s = new THREE.MeshStandardMaterial({
                    name: m.name, color: m.color, map: m.map, normalMap: m.normalMap, roughness: Math.min(m.roughness, 0.15),
                    metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.2, side: m.side
                });
                swap.set(m, s); m.dispose();
            }
            return swap.get(m);
        };
        o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
    });
    return gltf;
}

export function makeGLTFLoader() {
    const l = new GLTFLoader();
    if (draco) l.setDRACOLoader(draco);
    if (ktx2) l.setKTX2Loader(ktx2);
    const load = l.loadAsync.bind(l);
    l.loadAsync = (url, onProgress) => assetStream.request(`model:${url}`, () => load(url, onProgress).then(stripTransmission), 5);
    return l;
}

/** Load a .ktx2 texture (repeat-wrapped). Resolves null on failure. */
export function loadKTX2(url, { anisotropy = 8, priority = 0 } = {}) {
    return assetStream.request(`texture:${url}`, () => new Promise((resolve) => {
        if (!ktx2) return resolve(null);
        ktx2.load(url, (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = anisotropy;
            resolve(t);
        }, undefined, () => resolve(null));
    }), priority);
}
