import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InstanceLOD } from '../src/environments/Foliage.js';
import { bakeImpostor } from '../src/environments/Impostors.js';
import { environmentPolicy } from '../src/environments/EnvironmentPolicy.js';
import { buildSceneryLOD, bindReflectionRange } from '../src/environments/SceneryLOD.js';
import { buildTerrainLOD } from '../src/environments/TerrainLOD.js';
import { Sky } from '../src/environments/Sky.js';
import { Weather } from '../src/environments/Weather.js';
import { BIOMES, MISSIONS } from '../src/environments/biomes.js';
import { relocatePathFoliage, makePathFoliageMap } from '../src/environments/PathFoliage.js';
import { buildGrassField } from '../src/environments/GrassField.js';
import { AssetStream } from '../src/environments/AssetStream.js';
import { createTextureStream } from '../src/environments/TextureStream.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { loadPhotoAssets, trimPhotoCache, getPhotoCacheStats } from '../src/environments/PhotoAssets.js';

const stream = new AssetStream(1), started = [];
let finishFirst;
const lowPriority = stream.request('background', () => { started.push('background'); return 2; }, 10);
const foreground = stream.request('foreground', () => {
    started.push('foreground');
    return new Promise(resolve => { finishFirst = resolve; });
}, 0);
assert.equal(stream.request('foreground', () => 99), foreground);
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(started, ['foreground']);
assert.equal(stream.getStats().active, 1);
finishFirst(1);
assert.deepEqual(await Promise.all([foreground, lowPriority]), [1, 2]);
await new Promise(resolve => setImmediate(resolve));
assert.equal(stream.jobs.size, 0);
await assert.rejects(stream.request('failure', () => { throw new Error('stream failure'); }), /stream failure/);
await new Promise(resolve => setImmediate(resolve));
assert.equal(await stream.request('failure', () => 3), 3);

const originalHDRLoad = RGBELoader.prototype.load;
let releasedHDRs = 0;
RGBELoader.prototype.load = (url, onLoad, onProgress, onError) => {
    if (url.includes('missing')) { onError(new Error('missing')); return; }
    const texture = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    texture.addEventListener('dispose', () => releasedHDRs++);
    onLoad(texture);
};
try {
    for (const hdr of ['first', 'second', 'third', 'fourth', 'missing-one', 'missing-two']) {
        await loadPhotoAssets([], hdr);
        trimPhotoCache();
        assert(getPhotoCacheStats().hdrs <= 2);
    }
    assert(releasedHDRs >= 3);
} finally { RGBELoader.prototype.load = originalHDRLoad; }

const path = [{ x1: -20, z1: 0, x2: 20, z2: 0, hw: 2 }];
let shifted = 0;
for (let candidate = 0; candidate < 100; candidate++) {
    const point = { x: 0, z: candidate % 2 ? 0.5 : -0.5 };
    const moved = relocatePathFoliage(point, path, candidate % 2 === 0);
    if (moved) { shifted++; assert(Math.abs(point.z) > 2); }
    else assert(Math.abs(point.z) < 2);
}
assert.equal(shifted, 50);
const openPoint = { x: 0, z: 4 };
assert.equal(relocatePathFoliage(openPoint, path, true), false);
assert.equal(openPoint.z, 4);
const pointPath = { x: 0, z: 0 };
assert(relocatePathFoliage(pointPath, [{ x1: 0, z1: 0, x2: 0, z2: 0, hw: 1 }], true));
assert(Number.isFinite(pointPath.x));
const pathMap = makePathFoliageMap(20, path, 64);
assert.equal(pathMap.texture.image.data.byteLength, 64 * 64 * 4);
pathMap.texture.dispose();

const maskTexture = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
const fieldGroup = new THREE.Group();
const field = buildGrassField({ group: fieldGroup, bounds: 20, detail: { fieldMul: 0.01 }, rand: () => 0.5,
    groundMask: { texture: maskTexture, size: 40, s1: 1, s2: 2, w2: 0.5, lo: 0.3, hi: 0.7 },
    hf: { texture: maskTexture, size: 40, N: 1 }, pathSegs: path }, { field: { count: 1000 } }, []);
const fieldShader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
fieldGroup.children[0].material.onBeforeCompile(fieldShader);
assert.equal(fieldGroup.children[0].geometry.index.count / 3, 25);
assert(fieldShader.vertexShader.includes('seed.y < 0.5'));
assert(fieldShader.vertexShader.includes('gwp = grassAnchor(gseed)'));
assert.equal(fieldShader.uniforms.uPathFlow.value.image.width, 256);
let fieldReleases = 0;
fieldShader.uniforms.uPathFlow.value.addEventListener('dispose', () => fieldReleases++);
field.dispose(); field.dispose();
assert.equal(fieldReleases, 1);
assert.equal(fieldGroup.children.length, 0);
maskTexture.dispose();

const geometry = new THREE.BoxGeometry(2, 5, 2);
const material = new THREE.MeshStandardMaterial();
const streamMap = new THREE.Texture(), streamNormal = new THREE.Texture();
streamMap.repeat.set(2, 3);
const detailMaterial = new THREE.MeshStandardMaterial({ map: streamMap });
const detailMesh = new THREE.Mesh(geometry, detailMaterial), detailGroup = new THREE.Group();
detailMesh.position.x = 100; detailGroup.add(detailMesh);
let detailRequests = 0;
const textureStream = createTextureStream(detailGroup, null, 20, { tex: { sample: { map: streamMap } } }, async () => {
    detailRequests++; return streamNormal;
});
textureStream.update(new THREE.Vector3(), null, 0.2);
assert.equal(detailRequests, 0);
detailMesh.position.x = 0; detailMesh.updateMatrixWorld(true);
textureStream.update(new THREE.Vector3(), null, 0.2);
await Promise.resolve();
assert.equal(detailRequests, 1);
assert.notEqual(detailMaterial.normalMap, streamNormal);
assert.deepEqual(detailMaterial.normalMap.repeat.toArray(), [2, 3]);
let detailDisposals = 0;
detailMaterial.normalMap.addEventListener('dispose', () => detailDisposals++);
textureStream.dispose(); textureStream.dispose();
assert.equal(detailDisposals, 1);
assert.equal(detailMaterial.normalMap, null);
let finishLateDetail;
const lateStream = createTextureStream(detailGroup, null, 20, { tex: { sample: { map: streamMap } } }, () => new Promise(resolve => { finishLateDetail = resolve; }));
lateStream.update(new THREE.Vector3(), null, 0.2);
lateStream.dispose(); finishLateDetail(streamNormal);
await Promise.resolve();
assert.equal(detailMaterial.normalMap, null);
detailMaterial.dispose(); streamMap.dispose(); streamNormal.dispose();
const item = x => ({ x, z: 0, variant: 0, m: Float32Array.from(new THREE.Matrix4().makeTranslation(x, 0, 0).elements), c: new Float32Array([1, 1, 1]) });
const group = new THREE.Group();
const lod = new InstanceLOD(group, [[[{ geometry, material }]]], [item(10), item(50)], { thresholds: [100], shadowDistance: 30 });
lod.update(new THREE.Vector3(), new THREE.Vector3(1, 0, 0));
assert.equal(group.children.find(mesh => mesh.castShadow).count, 1);
assert.equal(group.children.find(mesh => !mesh.castShadow).count, 1);
assert.equal(group.children.find(mesh => !mesh.castShadow).receiveShadow, false);
const versions = group.children.map(mesh => mesh.instanceMatrix.version);
for (let frame = 0; frame < 100; frame++) lod.update(new THREE.Vector3(), new THREE.Vector3(1, 0, 0));
assert.deepEqual(group.children.map(mesh => mesh.instanceMatrix.version), versions);
lod.update(new THREE.Vector3(1000, 0, 0), new THREE.Vector3(1, 0, 0));
assert(group.children.every(mesh => mesh.count === 0));
lod.dispose();

const sceneryGroup = new THREE.Group();
const near = new THREE.Mesh(geometry, material), far = near.clone();
near.castShadow = far.castShadow = true;
far.position.x = 80;
sceneryGroup.add(near, far);
const scenery = buildSceneryLOD({ group: sceneryGroup, detail: { propLod: [20, 50, 100, 150], shadowDistance: 30 } });
assert.equal(scenery.count, 2);
assert.equal(near.visible, false);
assert(new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1)).intersectObject(near).length > 0);
const reflections = bindReflectionRange(sceneryGroup, 38);
const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
material.onBeforeCompile(shader);
assert.equal(shader.uniforms.uReflectionRange.value, 38);
assert(shader.fragmentShader.includes('if (environmentReflectionFade > 0.001)'));
assert(shader.fragmentShader.includes('iblIrradiance += getIBLIrradiance'));
assert(!shader.fragmentShader.includes('irif'));
reflections.dispose();
assert(!material.userData.reflectionRangeBound);
scenery.dispose();
assert(near.visible);

const terrainGroup = new THREE.Group();
const terrainGeometry = new THREE.PlaneGeometry(200, 200, 32, 32);
const ground = new THREE.Mesh(terrainGeometry, material);
ground.rotation.x = -Math.PI / 2;
terrainGroup.add(ground);
const terrain = buildTerrainLOD(terrainGroup, ground, [20, 60]);
const patches = terrainGroup.children.filter(mesh => mesh !== ground);
const highTriangles = patches.reduce((sum, patch) => sum + patch.geometry.index.count / 3, 0);
assert.equal(highTriangles, 32 * 32 * 2);
terrain.update(new THREE.Vector3(1000, 0, 1000));
assert(patches.every(patch => patch.userData.terrainLod === 2));
assert(patches.every(patch => !patch.receiveShadow));
assert(patches.reduce((sum, patch) => sum + patch.geometry.index.count / 3, 0) < highTriangles);
assert(patches.every(patch => patch.geometry.attributes.position === terrainGeometry.attributes.position));
const border = new Set(patches[0].geometry.index.array);
for (let point = 0; point <= 4; point++) { assert(border.has(point)); assert(border.has(point * 33)); }
terrain.dispose();
assert(ground.visible);
terrainGeometry.dispose();

const shadowScene = new THREE.Scene();
shadowScene.add(near, far);
const sky = new Sky(shadowScene, {}, { shadowDistance: 30, shadowInterval: 0.1 });
shadowScene.updateMatrixWorld(true);
sky.follow(new THREE.Vector3());
sky.update(0.1);
assert(near.castShadow);
assert.equal(far.castShadow, false);
sky.sun.shadow.needsUpdate = false;
sky.update(0.02);
assert.equal(sky.sun.shadow.needsUpdate, false);
sky.update(0.08);
assert(sky.sun.shadow.needsUpdate);
sky.dispose();
assert(far.castShadow);

for (const kind of ['rain', 'snow', 'dust']) {
    const weather = new Weather({ kind, count: 10, speed: 2, opacity: 0.5, color: 0xffffff, range: 24 });
    assert.equal(weather.uniforms.uMaxDist.value, 24);
    assert(weather.object.material.vertexShader.includes('uCam.y +'));
    weather.dispose();
}
for (const mission of MISSIONS) assert(BIOMES[mission.biome].vegetation.count > 0);
for (const extent of [44, 52, 60, 68, 80]) {
    const policy = environmentPolicy({ shadowExtent: extent, fieldMul: 1 });
    assert(policy.propLod.every((distance, index, values) => index === 0 || distance > values[index - 1]));
    assert(policy.shadowDistance < extent);
    assert(policy.weatherDistance > 0);
    assert(policy.renderDistance <= 120);
    assert(policy.propLod.at(-1) <= policy.renderDistance);
    assert(policy.grassDist < 75);
    assert(policy.fogDensity >= 0.013);
    assert(1 - Math.exp(-Math.pow(policy.fogDensity * policy.renderDistance, 2)) > 0.93);
    assert(policy.foliageDensity > 1);
    assert.equal(policy.groundDensity, 0.95);
    assert.equal(policy.plantDensity, 1.15);
    assert.equal(policy.treeDensity, 1.75);
    assert(policy.reflectionDistance > 24);
    assert(policy.textureDetailDistance < policy.renderDistance);
}

const viewport = new THREE.Vector4(2, 3, 100, 80), scissor = viewport.clone(), clearColor = new THREE.Color(0x123456);
let currentTarget = null, scissorTest = false, clearAlpha = 0.25, captures = 0;
const renderer = {
    shadowMap: { enabled: true }, toneMapping: THREE.ACESFilmicToneMapping, autoClear: true,
    getRenderTarget: () => currentTarget, setRenderTarget: target => { currentTarget = target; },
    getViewport: target => target.copy(viewport), getScissor: target => target.copy(scissor),
    getScissorTest: () => scissorTest, setScissorTest: value => { scissorTest = value; },
    getClearColor: target => target.copy(clearColor), getClearAlpha: () => clearAlpha,
    setClearColor: (color, alpha) => { clearColor.set(color); clearAlpha = alpha; },
    setViewport: (left, top, width, height) => left.isVector4 ? viewport.copy(left) : viewport.set(left, top, width, height),
    setScissor: (left, top, width, height) => left.isVector4 ? scissor.copy(left) : scissor.set(left, top, width, height),
    clear: () => {}, render: () => { captures++; }
};
const impostor = bakeImpostor(renderer, [{ geometry, material }]);
assert.equal(captures, 8);
assert.equal(currentTarget, null);
assert.deepEqual(viewport.toArray(), [2, 3, 100, 80]);
assert.equal(clearAlpha, 0.25);
assert.equal(renderer.shadowMap.enabled, true);
assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
assert.equal(impostor.far[0].geometry.index.count, 6);
impostor.dispose();
renderer.render = () => { throw new Error('capture failure'); };
assert.throws(() => bakeImpostor(renderer, [{ geometry, material }]), /capture failure/);
assert.equal(currentTarget, null);
assert.equal(renderer.shadowMap.enabled, true);
geometry.dispose(); material.dispose();
console.log('PASS: streaming priority/deduplication, proximity detail, bounded caches, late-arrival cleanup, density, LOD, terrain, shadows, reflections and renderer-state restoration.');