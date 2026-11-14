import * as THREE from '/node_modules/three/build/three.module.js';
import { SimplifyModifier } from '/node_modules/three/examples/jsm/modifiers/SimplifyModifier.js';
import { InstanceLOD } from './Foliage.js';
import { bakeImpostor } from './Impostors.js';

export function buildSceneryLOD(ctx, excluded = []) {
    const { group, detail } = ctx;
    group.updateMatrixWorld(true);
    const inverse = group.matrixWorld.clone().invert();
    const sources = [], definitions = [], variants = [], items = [], owned = [];
    const batches = new Map(), reduced = new Map();
    const modifier = new SimplifyModifier();
    const matrix = new THREE.Matrix4(), instance = new THREE.Matrix4(), color = new THREE.Color();
    const center = new THREE.Vector3(), worldBox = new THREE.Box3();
    group.traverseVisible(object => {
        if (object.isMesh && !object.isSkinnedMesh && !object.userData.environmentManaged && !excluded.includes(object)) sources.push(object);
    });
    for (const source of sources) {
        source.geometry.computeBoundingBox();
        const materials = Array.isArray(source.material) ? source.material : [source.material];
        const base = inverse.clone().multiply(source.matrixWorld);
        const count = source.isInstancedMesh ? source.count : 1;
        for (let index = 0; index < count; index++) {
            if (source.isInstancedMesh) { source.getMatrixAt(index, instance); matrix.multiplyMatrices(base, instance); }
            else matrix.copy(base);
            worldBox.copy(source.geometry.boundingBox).applyMatrix4(matrix);
            const upright = Math.abs(matrix.elements[5]) / Math.max(Math.hypot(matrix.elements[4], matrix.elements[5], matrix.elements[6]), 0.001) > 0.98;
            const cardSuitable = upright && source.geometry.attributes.position.count > 150 &&
                worldBox.max.y - worldBox.min.y > 0.35 &&
                Math.max(worldBox.max.x - worldBox.min.x, worldBox.max.z - worldBox.min.z) < 20 &&
                materials.every(m => !m.transparent);
            const key = `${source.geometry.uuid}:${materials.map(m => m.uuid).join(',')}:${source.castShadow}:${cardSuitable}`;
            let variant = batches.get(key);
            if (variant === undefined) {
                variant = variants.length;
                batches.set(key, variant);
                let low = reduced.get(source.geometry);
                if (!low) {
                    const vertices = source.geometry.attributes.position.count;
                    if (vertices > 150 && vertices < 1600 && materials.length === 1 && !Object.keys(source.geometry.morphAttributes).length) {
                        low = modifier.modify(source.geometry, Math.floor(vertices * 0.45));
                        low.computeBoundingSphere();
                        owned.push(low);
                    } else low = source.geometry;
                    reduced.set(source.geometry, low);
                }
                const highParts = [{ geometry: source.geometry, material: source.material, label: 'full' }];
                const lowParts = [{ geometry: low, material: source.material, label: 'reduced' }];
                const impostor = cardSuitable ? bakeImpostor(detail.renderer, highParts, {
                    resolution: Math.min(detail.impostorResolution ?? 128, detail.fieldMul >= 1 ? 128 : 64), preserveViews: true
                }) : null;
                if (impostor) owned.push(impostor);
                variants.push([highParts, lowParts, impostor?.medium ?? lowParts, impostor?.far ?? lowParts]);
                definitions.push({ casts: source.castShadow });
            }
            center.copy(source.geometry.boundingBox.getCenter(new THREE.Vector3())).applyMatrix4(matrix);
            color.setRGB(1, 1, 1);
            if (source.isInstancedMesh && source.instanceColor) source.getColorAt(index, color);
            items.push({ x: center.x, z: center.z, variant,
                m: Float32Array.from(matrix.elements), c: Float32Array.from([color.r, color.g, color.b]) });
        }
        source.visible = false;
        source.userData.lodManaged = true;
    }
    const inst = new InstanceLOD(group, variants, items, {
        thresholds: detail.propLod ?? [28, 65, 110, 220], shadowLods: [0, 1], shadowDistance: detail.shadowDistance, backCull: 15
    });
    inst.buckets.forEach((lods, variant) => {
        if (!definitions[variant].casts) for (const bucket of lods) {
            bucket.meshes.forEach(mesh => { mesh.castShadow = false; });
            bucket.shadow?.meshes.forEach(mesh => { mesh.castShadow = false; });
        }
    });
    return {
        update: (cam, dir) => inst.update(cam, dir), count: items.length,
        dispose: () => {
            inst.dispose(); owned.forEach(resource => resource.dispose());
            sources.forEach(source => { source.visible = true; delete source.userData.lodManaged; });
        }
    };
}

export function bindReflectionRange(group, distance) {
    const materials = new Set();
    group.traverse(object => {
        if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => {
            if (material.isMeshStandardMaterial) materials.add(material);
        });
    });
    const restore = [];
    for (const material of materials) {
        if (material.userData.reflectionRangeBound) continue;
        const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey;
        const baseKey = previousKey.call(material);
        material.userData.reflectionRangeBound = true;
        material.onBeforeCompile = (shader, renderer) => {
            previous.call(material, shader, renderer);
            shader.uniforms.uReflectionRange = { value: distance };
            shader.vertexShader = 'varying vec3 vEnvironmentWorld;\n' + shader.vertexShader
                .replace('#include <project_vertex>', `
                    vec4 environmentPosition = vec4(transformed, 1.0);
                    #ifdef USE_INSTANCING
                        environmentPosition = instanceMatrix * environmentPosition;
                    #endif
                    vEnvironmentWorld = (modelMatrix * environmentPosition).xyz;
                    #include <project_vertex>
                `);
            const maps = THREE.ShaderChunk.lights_fragment_maps.replace(/\b(radiance|clearcoatRadiance) \+= ([^;]+);/g,
                'if (environmentReflectionFade > 0.001) $1 += $2 * environmentReflectionFade;');
            shader.fragmentShader = 'uniform float uReflectionRange; varying vec3 vEnvironmentWorld;\n' + shader.fragmentShader
                .replace('#include <lights_fragment_maps>', `
                    float environmentReflectionFade = 1.0 - smoothstep(uReflectionRange * 0.7, uReflectionRange, length(vEnvironmentWorld - cameraPosition));
                    ${maps}
                `);
        };
        material.customProgramCacheKey = () => `${baseKey}-reflection-range`;
        material.needsUpdate = true;
        restore.push(() => {
            material.onBeforeCompile = previous;
            material.customProgramCacheKey = previousKey;
            delete material.userData.reflectionRangeBound;
            material.needsUpdate = true;
        });
    }
    return { dispose: () => restore.forEach(reset => reset()) };
}