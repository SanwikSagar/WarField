import * as THREE from '/node_modules/three/build/three.module.js';

export function bakeImpostor(renderer, parts, { resolution = 128, views = 8, preserveViews = false } = {}) {
    if (!renderer || !parts.length) return null;
    const scene = new THREE.Scene();
    const box = new THREE.Box3();
    parts.forEach(part => {
        part.geometry.computeBoundingBox();
        box.union(part.geometry.boundingBox);
        scene.add(new THREE.Mesh(part.geometry, part.material));
    });
    // Pivot on the instance origin (trunk / stem base), not the bbox centre, so the
    // card never slides sideways when the view frame or LOD tier changes.
    const center = new THREE.Vector3(0, (box.min.y + box.max.y) / 2, 0);
    const size = box.getSize(new THREE.Vector3());
    const reach = Math.hypot(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)), Math.max(Math.abs(box.min.z), Math.abs(box.max.z)));
    const width = Math.max(reach * 2, 0.1) * 1.04;
    const height = Math.max(size.y, 0.1) * 1.04;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6d7855, 2));
    const sun = new THREE.DirectionalLight(0xfff4de, 1.5);
    sun.position.set(-30, 60, 40);
    scene.add(sun);
    const target = new THREE.WebGLRenderTarget(resolution * views, resolution, { depthBuffer: true });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, width * 4 + height * 2);
    const previous = {
        target: renderer.getRenderTarget(), viewport: renderer.getViewport(new THREE.Vector4()),
        scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
        clearColor: renderer.getClearColor(new THREE.Color()), clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear, shadows: renderer.shadowMap.enabled, toneMapping: renderer.toneMapping
    };
    try {
        renderer.shadowMap.enabled = false;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.autoClear = false;
        renderer.setRenderTarget(target);
        renderer.setScissorTest(false);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.setScissorTest(true);
        for (let view = 0; view < views; view++) {
            const angle = view * Math.PI * 2 / views;
            camera.position.set(center.x + Math.sin(angle) * (width + height), center.y, center.z + Math.cos(angle) * (width + height));
            camera.lookAt(center);
            renderer.setViewport(view * resolution, 0, resolution, resolution);
            renderer.setScissor(view * resolution, 0, resolution, resolution);
            renderer.render(scene, camera);
        }
    } catch (error) {
        target.dispose();
        throw error;
    } finally {
        renderer.setRenderTarget(previous.target);
        renderer.setViewport(previous.viewport);
        renderer.setScissor(previous.scissor);
        renderer.setScissorTest(previous.scissorTest);
        renderer.setClearColor(previous.clearColor, previous.clearAlpha);
        renderer.autoClear = previous.autoClear;
        renderer.shadowMap.enabled = previous.shadows;
        renderer.toneMapping = previous.toneMapping;
    }
    const geometry = new THREE.PlaneGeometry(width, height);
    geometry.translate(0, center.y, 0);
    const cameraUniform = { value: new THREE.Vector3() };
    const makeMaterial = directional => {
        const material = new THREE.MeshBasicMaterial({
            map: target.texture, side: THREE.DoubleSide, alphaTest: 0.35, alphaToCoverage: true, fog: true
        });
        material.userData.impostorCamera = cameraUniform;
        material.userData.impostor = directional ? 'multi-view' : 'billboard';
        material.onBeforeCompile = shader => {
            shader.uniforms.uImpostorCam = cameraUniform;
            shader.uniforms.uImpostorOrigin = { value: new THREE.Vector3(center.x, 0, center.z) };
            shader.vertexShader = 'uniform vec3 uImpostorCam, uImpostorOrigin;\n' + shader.vertexShader
                .replace('#include <uv_vertex>', `#include <uv_vertex>
                    vec3 cardCenter = (modelMatrix * instanceMatrix * vec4(uImpostorOrigin, 1.0)).xyz;
                    vec2 cardFacing = normalize(uImpostorCam.xz - cardCenter.xz + vec2(0.00001));
                    float cardYaw = atan(cardFacing.x, cardFacing.y);
                    float treeYaw = atan(-instanceMatrix[0].z, instanceMatrix[0].x);
                    float cardFrame = mod(floor((cardYaw - treeYaw) * ${views.toFixed(1)} / 6.2831853 + 0.5), ${views.toFixed(1)});
                    vMapUv.x = (vMapUv.x + cardFrame) / ${views.toFixed(1)};
                `)
                .replace('#include <project_vertex>', `
                    vec3 cardScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
                    vec3 cardRight = vec3(cardFacing.y, 0.0, -cardFacing.x);
                    vec3 cardWorld = cardCenter + cardRight * transformed.x * cardScale.x + vec3(0.0, transformed.y * cardScale.y, 0.0);
                    vec4 mvPosition = viewMatrix * vec4(cardWorld, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                `);
        };
        material.customProgramCacheKey = () => `impostor-${views}-${directional}-${preserveViews}`;
        return material;
    };
    const medium = makeMaterial(true), far = makeMaterial(false);
    return {
        medium: [{ geometry, material: medium }], far: [{ geometry, material: far }],
        dispose: () => { geometry.dispose(); medium.dispose(); far.dispose(); target.dispose(); }
    };
}