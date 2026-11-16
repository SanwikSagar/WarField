import * as THREE from '/node_modules/three/build/three.module.js';
import { getPhoto, requestPhotoDetail, trimPhotoCache } from './PhotoAssets.js';

export function createTextureStream(group, renderer, range = 20, photo = getPhoto(), loadDetail = requestPhotoDetail, options = {}) {
    const names = new Map(), records = new Map();
    Object.entries(photo?.tex || {}).forEach(([name, set]) => { if (set?.map) names.set(set.map, name); });
    group.updateMatrixWorld(true);
    group.traverse(object => {
        if (!object.isMesh) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
            const name = names.get(material.map);
            if (!name || !material.isMeshStandardMaterial) continue;
            let record = records.get(material);
            if (!record) {
                record = { name, material, meshes: [], requested: false, original: material.normalMap, streamed: null };
                records.set(material, record);
            }
            record.meshes.push(object);
        }
    });
    const entries = [...records.values()];
    const point = new THREE.Vector3(), instance = new THREE.Matrix4(), world = new THREE.Matrix4();
    let elapsed = Infinity, elapsedTime = 0, disposed = false, loaded = 0;
    const interval = Math.max(0.05, options.interval ?? 0.2);
    const batch = Math.max(1, Math.floor(options.batch ?? 1));
    const unloadDelay = Math.max(interval, options.unloadDelay ?? 24);
    const distanceTo = (record, camera) => {
        let closest = Infinity;
        for (const mesh of record.meshes) {
            if (!mesh.visible || mesh.isInstancedMesh && !mesh.count) continue;
            if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
            const sphere = mesh.geometry.boundingSphere;
            const count = mesh.isInstancedMesh ? mesh.count : 1;
            for (let index = 0; index < count; index++) {
                if (mesh.isInstancedMesh) {
                    instance.fromArray(mesh.instanceMatrix.array, index * 16);
                    world.multiplyMatrices(mesh.matrixWorld, instance);
                } else world.copy(mesh.matrixWorld);
                point.copy(sphere.center).applyMatrix4(world);
                closest = Math.min(closest, point.distanceTo(camera) - sphere.radius * world.getMaxScaleOnAxis());
            }
        }
        return closest;
    };
    trimPhotoCache();
    return {
        update: (camera, direction, dt = 0.016) => {
            if (disposed) return;
            elapsed += dt;
            elapsedTime += dt;
            if (elapsed < interval) return;
            elapsed = 0;
            const now = elapsedTime;
            const nearby = [];
            for (const record of entries) {
                const distance = distanceTo(record, camera);
                if (distance < range) {
                    record.lastNearTime = now;
                    if (!record.requested) nearby.push({ record, distance });
                } else if (record.streamed && now - record.lastNearTime >= unloadDelay) {
                    record.material.normalMap = record.original;
                    record.material.needsUpdate = true;
                    record.streamed.dispose();
                    record.streamed = null;
                    record.requested = false;
                    loaded--;
                }
            }
            nearby.sort((a, b) => a.distance - b.distance);
            nearby.slice(0, batch).forEach(({ record }) => {
                record.requested = true;
                loadDetail(record.name).then(texture => {
                    if (disposed || !texture) return;
                    const normal = texture.clone();
                    const transform = record.original || record.material.map;
                    normal.repeat.copy(transform.repeat); normal.offset.copy(transform.offset);
                    normal.center.copy(transform.center); normal.rotation = transform.rotation;
                    normal.anisotropy = transform.anisotropy;
                    normal.needsUpdate = true;
                    record.streamed = normal;
                    record.material.normalMap = normal;
                    record.material.needsUpdate = true;
                    renderer?.initTexture(normal);
                    loaded++;
                }).catch(error => { console.warn('Texture detail stream skipped:', error); });
            });
        },
        getStats: () => ({ candidates: entries.length, requested: entries.filter(record => record.requested).length, loaded }),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const record of entries) {
                if (record.streamed) {
                    record.material.normalMap = record.original;
                    record.material.needsUpdate = true;
                    record.streamed.dispose();
                }
                record.meshes.length = 0;
            }
            entries.length = 0;
            records.clear(); names.clear();
        }
    };
}