import * as THREE from 'three';
import { getPhoto, requestPhotoDetail, trimPhotoCache } from './PhotoAssets.js';

export function createTextureStream(group, renderer, range = 20, photo = getPhoto(), loadDetail = requestPhotoDetail) {
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
    let elapsed = Infinity, disposed = false, loaded = 0;
    const isNear = (record, camera) => {
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
                if (point.distanceTo(camera) - sphere.radius * world.getMaxScaleOnAxis() < range) return true;
            }
        }
        return false;
    };
    trimPhotoCache();
    return {
        update: (camera, direction, dt = 0.016) => {
            if (disposed) return;
            elapsed += dt;
            if (elapsed < 0.2) return;
            elapsed = 0;
            for (const record of entries) {
                if (record.requested || !isNear(record, camera)) continue;
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
                break;
            }
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