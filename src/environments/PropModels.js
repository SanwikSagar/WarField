import * as THREE from '/node_modules/three/build/three.module.js';
import { makeGLTFLoader } from './AssetLoaders.js';
import { TextureFactory } from '../utils/TextureFactory.js';

/**
 * CC0 scanned props from Poly Haven (KTX2 + Draco GLBs in /assets/models/props),
 * real-world scale in metres. Placed by hand (config.phProps) or scattered
 * (config.phScatter). Every instance shares geometry/materials with its
 * template and is distance-culled each frame.
 */
const IDS = ['ammo_box', 'old_military_crate', 'wooden_military_crate', 'metal_jerrycan_green', 'Barrel_01',
    'portable_generator', 'portable_searchlight', 'old_tyre', 'stone_fire_pit', 'tree_stump_01', 'dead_tree_trunk',
    'rock_moss_set_01', 'fern_02', 'shrub_02', 'nettle_plant', 'dry_branches_medium_01', 'vintage_radio_transceiver',
    'medical_box', 'utility_box_01'];
// solid props get colliders / count as cover; foliage does not
const SOLID = new Set(['ammo_box', 'old_military_crate', 'wooden_military_crate', 'Barrel_01', 'portable_generator',
    'portable_searchlight', 'old_tyre', 'stone_fire_pit', 'tree_stump_01', 'dead_tree_trunk', 'rock_moss_set_01', 'utility_box_01',
    // city street furniture
    'concrete_road_barrier', 'concrete_road_barrier_02', 'covered_car', 'fire_hydrant', 'metal_trash_can', 'street_lamp_01',
    'cement_bag', 'plastic_crate_01', 'power_box_01', 'utility_box_02', 'planter_box_01', 'barrel_03', 'cardboard_box_01',
    'wooden_crate_01', 'wooden_crate_02', 'plastic_crate_02', 'painted_wooden_bench', 'street_lamp_02']);
const FOLIAGE = new Set(['fern_02', 'shrub_02', 'nettle_plant', 'dry_branches_medium_01']);
const T = {};
const loading = new Map();
const detail = TextureFactory.ground(64, 2);
// one adjusted material per template material, so identical props batch into one LOD draw
const SHARED = new WeakMap();

export function loadPropModels(config = null) {
    const ids = config ? new Set([
        ...(config.phProps || []).map(prop => prop.id), ...(config.phScatter || []).map(prop => prop.id)
    ]) : new Set(IDS);
    const models = config?.vegetation?.models;
    if (models) {
        for (const [key, id] of [['phFern', 'fern_02'], ['phShrub', 'shrub_02'], ['phNettle', 'nettle_plant'], ['phBranch', 'dry_branches_medium_01']]) {
            if (models[key]) ids.add(id);
        }
    }
    const L = makeGLTFLoader();
    return Promise.all([...ids].map(id => {
        if (T[id]) return Promise.resolve(T[id]);
        if (loading.has(id)) return loading.get(id);
        // compressed GLB first, else the raw Poly Haven 1k glTF (tools/fetch-polyhaven-models.mjs)
        const promise = L.loadAsync(`/assets/models/props/${id}.glb`)
            .catch(() => L.loadAsync(`/assets/models/props/${id}/${id}_1k.gltf`)).then(g => {
        g.scene.traverse(o => {
            if (!o.isMesh) return;
            // some scans ship an alternate weathered variant beside the clean one
            if (/_aged/.test(o.name)) { o.visible = false; return; }
            o.castShadow = !FOLIAGE.has(id);
            o.receiveShadow = true;
            if (FOLIAGE.has(id) && o.material) {
                o.material.side = THREE.DoubleSide;
                if (o.material.map) { o.material.alphaTest = 0.4; o.material.alphaToCoverage = true; o.material.transparent = false; }
            }
        });
        T[id] = g.scene;
        return g.scene;
        }, () => null).finally(() => loading.delete(id));
        loading.set(id, promise);
        return promise;
    }));
}

export function hasProp(id) { return !!T[id]; }
export function getPropTemplate(id) { return T[id] || null; }

/** Place one prop; returns the Object3D (or null if the model is missing). */
export function placeProp(lb, id, x, z, rot = 0, scale = 1, y = null) {
    const tpl = T[id];
    if (!tpl) return null;
    const o = tpl.clone(true);
    o.position.set(x, y ?? lb.heightAt(x, z), z);
    o.rotation.y = rot;
    o.scale.setScalar(scale);
    if (!FOLIAGE.has(id)) {
        o.traverse(mesh => {
            if (!mesh.isMesh) return;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const mapped = materials.map(source => {
                if (SHARED.has(source)) return SHARED.get(source);
                const material = source.clone();
                if (material.color) material.color.multiplyScalar(0.96);
                if (!material.roughnessMap) material.roughnessMap = detail.roughnessMap;
                if (!material.aoMap) material.aoMap = detail.aoMap;
                if (!material.normalMap && !material.bumpMap) {
                    material.bumpMap = detail.bumpMap;
                    material.bumpScale = 0.025;
                }
                material.aoMapIntensity = Math.min(1, (material.aoMapIntensity ?? 1) * 0.7);
                material.needsUpdate = true;
                SHARED.set(source, material);
                return material;
            });
            // keep single materials single: an array on a group-less geometry renders nothing
            mesh.material = Array.isArray(mesh.material) ? mapped : mapped[0];
            if (mesh.geometry.attributes.uv && !mesh.geometry.attributes.uv2) {
                mesh.geometry.setAttribute('uv2', mesh.geometry.attributes.uv.clone());
            }
        });
    }
    lb.group.add(o);
    o.updateMatrixWorld(true);
    if (SOLID.has(id)) {
        const b = new THREE.Box3().setFromObject(o);
        if (b.max.y - b.min.y > 0.25) lb.colliders.push(b);
        lb.cover.push(new THREE.Vector3(x, 0, z));
    }
    (lb._propObjs || (lb._propObjs = [])).push({ o, cull: FOLIAGE.has(id) ? 35 : 85 });
    return o;
}

/** Distance culling (cheap: ~100 objects). */
export function cullProps(lb, cam) {
    const list = lb._propObjs;
    if (!list) return;
    for (const p of list) {
        if (p.o.userData.lodManaged) continue;
        const dx = p.o.position.x - cam.x, dz = p.o.position.z - cam.z;
        p.o.visible = dx * dx + dz * dz < p.cull * p.cull;
    }
}
