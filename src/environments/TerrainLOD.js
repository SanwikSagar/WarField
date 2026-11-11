import * as THREE from 'three';

export function buildTerrainLOD(group, ground, distances = [45, 100], shadowDistance = 50) {
    const source = ground.geometry;
    const segments = source.parameters.widthSegments;
    const row = segments + 1;
    const position = source.attributes.position;
    const patches = [], owned = [];
    ground.updateMatrixWorld(true);
    const tiles = Math.min(8, segments);
    for (let tz = 0; tz < tiles; tz++) for (let tx = 0; tx < tiles; tx++) {
        const left = Math.floor(tx * segments / tiles), right = Math.floor((tx + 1) * segments / tiles);
        const top = Math.floor(tz * segments / tiles), bottom = Math.floor((tz + 1) * segments / tiles);
        const box = new THREE.Box3();
        const point = new THREE.Vector3();
        for (let iz = top; iz <= bottom; iz++) for (let ix = left; ix <= right; ix++) {
            point.fromBufferAttribute(position, iz * row + ix); box.expandByPoint(point);
        }
        const geometries = [1, 2, 4].map(step => {
            const indices = [];
            for (let iz = top; iz < bottom; iz += step) for (let ix = left; ix < right; ix += step) {
                const endX = Math.min(ix + step, right), endZ = Math.min(iz + step, bottom);
                const a = iz * row + ix, b = endZ * row + ix, c = endZ * row + endX, d = iz * row + endX;
                if (step === 1 || endX - ix < 2 || endZ - iz < 2) {
                    indices.push(a, b, d, b, c, d);
                    continue;
                }
                const edge = [];
                const edgeStepLeft = ix === left ? 1 : endZ - iz;
                const edgeStepBottom = endZ === bottom ? 1 : endX - ix;
                const edgeStepRight = endX === right ? 1 : endZ - iz;
                const edgeStepTop = iz === top ? 1 : endX - ix;
                for (let z = iz; z < endZ; z += edgeStepLeft) edge.push(z * row + ix);
                for (let x = ix; x < endX; x += edgeStepBottom) edge.push(endZ * row + x);
                for (let z = endZ; z > iz; z -= edgeStepRight) edge.push(z * row + endX);
                for (let x = endX; x > ix; x -= edgeStepTop) edge.push(iz * row + x);
                const middle = Math.floor((iz + endZ) / 2) * row + Math.floor((ix + endX) / 2);
                for (let index = 0; index < edge.length; index++) indices.push(middle, edge[index], edge[(index + 1) % edge.length]);
            }
            const geometry = new THREE.BufferGeometry();
            Object.entries(source.attributes).forEach(([name, attribute]) => geometry.setAttribute(name, attribute));
            geometry.setIndex(indices);
            geometry.boundingBox = box.clone();
            geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
            owned.push(geometry);
            return geometry;
        });
        const mesh = new THREE.Mesh(geometries[0], ground.material);
        mesh.position.copy(ground.position); mesh.rotation.copy(ground.rotation); mesh.scale.copy(ground.scale);
        mesh.receiveShadow = true;
        mesh.userData.environmentManaged = true;
        mesh.userData.terrainLod = 0;
        group.add(mesh);
        patches.push({ mesh, geometries, center: box.getCenter(new THREE.Vector3()).applyMatrix4(ground.matrixWorld),
            box: box.clone().applyMatrix4(ground.matrixWorld) });
    }
    ground.visible = false;
    return {
        update: cam => {
            for (const patch of patches) {
                // nearest edge, not centre: ground under the player is always full resolution,
                // so grass and tree roots (placed on the full-res heightfield) never float or sink
                const b = patch.box;
                const dx = Math.max(b.min.x - cam.x, 0, cam.x - b.max.x), dz = Math.max(b.min.z - cam.z, 0, cam.z - b.max.z);
                const distance = Math.hypot(dx, dz);
                const tier = distance < distances[0] ? 0 : distance < distances[1] ? 1 : 2;
                patch.mesh.geometry = patch.geometries[tier];
                patch.mesh.userData.terrainLod = tier;
                patch.mesh.receiveShadow = distance < shadowDistance;
            }
        },
        dispose: () => {
            patches.forEach(patch => group.remove(patch.mesh));
            owned.forEach(geometry => geometry.dispose());
            ground.visible = true;
        }
    };
}