import * as THREE from 'three';

export function relocatePathFoliage(point, segments, move, margin = 1.1) {
    let closest = Infinity, selected = null, px = 0, pz = 0;
    for (const segment of segments) {
        const dx = segment.x2 - segment.x1, dz = segment.z2 - segment.z1;
        const along = THREE.MathUtils.clamp(((point.x - segment.x1) * dx + (point.z - segment.z1) * dz) / Math.max(dx * dx + dz * dz, 0.0001), 0, 1);
        const x = segment.x1 + along * dx, z = segment.z1 + along * dz;
        const distance = Math.hypot(point.x - x, point.z - z);
        if (distance < closest) { closest = distance; selected = segment; px = x; pz = z; }
    }
    point.onPath = !!selected && closest < selected.hw;
    point.verge = selected && !point.onPath ? 1 - THREE.MathUtils.smoothstep(closest - selected.hw, 0.5, 3.5) : 0;
    if (!point.onPath || !move) return false;
    let nx = point.x - px, nz = point.z - pz;
    let length = Math.hypot(nx, nz);
    if (length < 0.0001) {
        nx = -(selected.z2 - selected.z1); nz = selected.x2 - selected.x1;
        length = Math.hypot(nx, nz);
        if (length < 0.0001) { nx = 1; nz = 0; length = 1; }
    }
    point.x = px + nx / length * (selected.hw + margin);
    point.z = pz + nz / length * (selected.hw + margin);
    return true;
}

export function makePathFoliageMap(bounds, segments, size = 256) {
    let maxShift = 2;
    for (const segment of segments) maxShift = Math.max(maxShift, segment.hw + 2);
    const data = new Uint8Array(size * size * 4);
    const point = { x: 0, z: 0, onPath: false, verge: 0 };
    for (let iz = 0; iz < size; iz++) for (let ix = 0; ix < size; ix++) {
        const x = ((ix + 0.5) / size - 0.5) * bounds * 2;
        const z = ((iz + 0.5) / size - 0.5) * bounds * 2;
        point.x = x; point.z = z;
        relocatePathFoliage(point, segments, true);
        const offset = (iz * size + ix) * 4;
        data[offset] = Math.round(128 + (point.x - x) / maxShift * 127);
        data[offset + 1] = Math.round(128 + (point.z - z) / maxShift * 127);
        data[offset + 2] = point.onPath ? 255 : 0;
        data[offset + 3] = Math.round(point.verge * 255);
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return { texture, maxShift };
}