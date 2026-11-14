import * as THREE from '/node_modules/three/build/three.module.js';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from '/node_modules/three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from '/node_modules/three/examples/jsm/loaders/KTX2Loader.js';
import { assetStream } from './AssetStream.js';

/**
 * Shared loaders. Textures ship as KTX2 (Basis ETC1S): ~4x smaller files AND
 * they stay GPU-compressed in VRAM (the browser transcodes to the GPU's native
 * BC7/ASTC/ETC format), with pre-baked mipmaps. Geometry may be Draco.
 */
let ktx2 = null, draco = null, rendererRef = null;

export function initLoaders(renderer) {
    if (ktx2) return;
    rendererRef = renderer;
    ktx2 = new KTX2Loader().setTranscoderPath('/assets/basis/').setWorkerLimit(2).detectSupport(renderer);
    draco = new DRACOLoader().setDecoderPath('/assets/draco/').setWorkerLimit(2);
}

export function getKTX2() { return ktx2; }

export function makeGLTFLoader() {
    const l = new GLTFLoader();
    if (draco) l.setDRACOLoader(draco);
    if (ktx2) l.setKTX2Loader(ktx2);
    const load = l.loadAsync.bind(l);
    l.loadAsync = (url, onProgress) => assetStream.request(`model:${url}`, () => load(url, onProgress), 5);
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
