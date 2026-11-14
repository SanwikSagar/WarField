import * as THREE from '/node_modules/three/build/three.module.js';
import { mergeGeometries } from '/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from '/node_modules/three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { TextureFactory } from '../utils/TextureFactory.js';
import { Weather } from '../environments/Weather.js';
import { loadCharacters, createCharacter } from '../core/CharacterFactory.js';
import { loadWeaponModels } from '../weapons/WeaponModels.js';
import { loadPropModels, getPropTemplate } from '../environments/PropModels.js';
import { audio } from '../audio/AudioManager.js';
import { buildMenuForest, updateWindTime } from '../environments/Foliage.js';
import { RGBELoader } from '/node_modules/three/examples/jsm/loaders/RGBELoader.js';

/**
 * Cinematic main-menu backdrop (GDD 10.4): a rain-soaked forward camp at dusk,
 * framed from under a dripping canopy. A rigged soldier stands with his back to
 * the camera watching the camp while another patrols between the tents. Storm
 * clouds roll over misty ridges, lightning (with thunder) lights the valley,
 * a searchlight sweeps from the watchtower and sodium lamps smear across the
 * wet ground. The camera holds the composition with a slow handheld drift and
 * subtle mouse parallax. Everything is procedural apart from the characters,
 * weapons and a few scanned props.
 */

const CAM_POS = new THREE.Vector3(0, 1.26, 0);
const CAM_LOOK = new THREE.Vector3(0.2, 1.78, -10);
const CAM_FOV = 40;
const FOG_COLOR = 0x4a5868;
const SEAT_Y = 0.88;   // table top the hero sits on

const NOISE_GLSL = /* glsl */`
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.02 + vec2(3.1, 1.7); a *= 0.5; }
        return v;
    }
`;

const WORLD_VERT = /* glsl */`
    varying vec2 vUv;
    varying vec3 vWorld;
    void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
    }
`;

/** Rotate `bone` so its child at `childPos` swings onto `target` (world space). */
function aimBone(bone, from, childPos, target) {
    const v1 = childPos.clone().sub(from).normalize();
    const v2 = target.clone().sub(from).normalize();
    const want = new THREE.Quaternion().setFromUnitVectors(v1, v2).multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(want));
    bone.updateMatrixWorld(true);
}

export class MenuScene {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.time = 0;
        this.exposure = 1.18;
        this.shaders = [];          // materials with a uTime uniform
        this.flashMats = [];        // materials with a uFlash uniform
        this.glows = [];            // flickering light sprites
        this.blinkers = [];
        this.artillery = [];
        this.lightning = { next: 4 + Math.random() * 4, t: -1, pulses: [], dir: new THREE.Vector3(0.4, 0.35, -1).normalize() };
        this.mouse = new THREE.Vector2();
        this.parallax = new THREE.Vector2();
        this.hero = null;
        this.patrol = null;
        this.disposed = false;

        this._onPointer = (e) => {
            this.mouse.set(e.clientX / window.innerWidth * 2 - 1, e.clientY / window.innerHeight * 2 - 1);
        };
        window.addEventListener('pointermove', this._onPointer);

        this._buildAtmosphere();
        this._buildSky();
        this._buildMountains();
        this._buildMist();
        this._buildForest();
        this._buildGround();
        this._buildCamp();
        this._buildTruck(-3.7, -17.5, -0.3, true);
        this._buildTruck(-7.6, -24.5, 0.15, false);
        this._buildTower(17.5, -35);
        this._buildCanopy();
        this._buildForeground();
        this._buildRain();
        this._loadCharacters();
        this._loadProps();
    }

    // ── helpers ────────────────────────────────────────────────────────
    _shader(opts) {
        const mat = new THREE.ShaderMaterial({ vertexShader: WORLD_VERT, fog: false, ...opts });
        if (mat.uniforms.uTime) this.shaders.push(mat);
        if (mat.uniforms.uFlash) this.flashMats.push(mat);
        return mat;
    }

    _glow(color, size, pos, flicker = 0) {
        if (!this.glowTex) this.glowTex = TextureFactory.radialGradient(128, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this.glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false
        }));
        s.position.copy(pos);
        s.scale.setScalar(size);
        this.group.add(s);
        if (flicker) this.glows.push({ s, base: size, flicker, seed: Math.random() * 100 });
        return s;
    }

    /** Light smeared across wet ground from `base` toward the camera. */
    _streak(x, z, color, length, width, strength = 1) {
        const mat = this._shader({
            uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uStrength: { value: strength }, uSeed: { value: Math.random() * 50 } },
            fragmentShader: NOISE_GLSL + /* glsl */`
                uniform float uTime, uStrength, uSeed; uniform vec3 uColor;
                varying vec2 vUv;
                void main() {
                    float v = vUv.y;
                    float wob = (noise(vec2(v * 26.0 - uTime * 1.6, uSeed)) - 0.5) * 0.22;
                    float u = (vUv.x - 0.5 + wob * v) * 2.0;
                    float across = exp(-u * u * 5.0);
                    float along = smoothstep(0.0, 0.05, v) * pow(1.0 - v, 1.6);
                    float broken = 0.55 + 0.45 * noise(vec2(v * 60.0 - uTime * 3.0, vUv.x * 6.0 + uSeed));
                    gl_FragColor = vec4(uColor * across * along * broken * uStrength, 1.0);
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        const dx = CAM_POS.x - x, dz = CAM_POS.z - z;
        const len = Math.hypot(dx, dz);
        const L = Math.min(length, len * 0.9);
        m.rotation.order = 'YXZ';
        m.rotation.set(-Math.PI / 2, Math.atan2(-dx, -dz), 0);
        m.scale.set(width, L, 1);
        m.position.set(x + dx / len * L * 0.5, 0.025, z + dz / len * L * 0.5);
        m.renderOrder = 2;
        this.group.add(m);
        return m;
    }

    _box(w, h, d, mat, x, y, z, parent = this.group) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(x, y, z);
        parent.add(m);
        return m;
    }

    /** Thin beam between two points. */
    _strut(a, b, r, mat, parent = this.group) {
        const len = a.distanceTo(b);
        const m = new THREE.Mesh(new THREE.BoxGeometry(r, len, r), mat);
        m.position.copy(a).add(b).multiplyScalar(0.5);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        parent.add(m);
        return m;
    }

    // ── atmosphere & lights ────────────────────────────────────────────
    _buildAtmosphere() {
        this.scene.background = new THREE.Color(FOG_COLOR);
        this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0135);

        // overcast HDR as image-based light: wet ground, metal and canvas reflect the storm sky
        new RGBELoader().load('/assets/polyhaven/kloofendal_overcast_puresky_1k.hdr', (tex) => {
            if (this.disposed) { tex.dispose(); return; }
            tex.mapping = THREE.EquirectangularReflectionMapping;
            this.envTex = tex;
            this.scene.environment = tex;
            this.scene.environmentIntensity = 0.32;
        }, undefined, () => {});

        this.hemi = new THREE.HemisphereLight(0x8496ad, 0x2a2822, 1.1);
        this.group.add(this.hemi);

        // cold storm light from the sky behind the camp: rims the soldier
        this.moon = new THREE.DirectionalLight(0x9db3cf, 1.3);
        this.moon.position.set(-6, 14, -20);
        this.group.add(this.moon, this.moon.target);

        this.flashLight = new THREE.DirectionalLight(0xc6d6ff, 0);
        this.flashLight.position.set(8, 30, -40);
        this.group.add(this.flashLight, this.flashLight.target);

        // warm camp spill on the soldier's right side + soft fill from behind the camera
        this.campKey = new THREE.PointLight(0xff9a52, 26, 16, 2);
        this.campKey.position.set(3.6, 2.6, -6.5);
        this.group.add(this.campKey);
        const fill = new THREE.PointLight(0x8fa2c0, 9, 7, 2);
        fill.position.set(-0.6, 2.3, 0.4);
        // soft top light that separates the soldier's back from the dark canopy
        const heroTop = new THREE.PointLight(0xa9b6c8, 10, 5, 2);
        heroTop.position.set(0.9, 2.9, -0.9);
        this.group.add(heroTop);
        this.group.add(fill);
    }

    _buildSky() {
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 }, uFlash: { value: 0 },
                uTop: { value: new THREE.Color(0x222d3b) }, uHorizon: { value: new THREE.Color(0x6a7a8d) },
                uFlashDir: { value: this.lightning.dir }
            },
            vertexShader: /* glsl */`
                varying vec3 vDir;
                void main() {
                    vDir = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: NOISE_GLSL + /* glsl */`
                uniform float uTime, uFlash; uniform vec3 uTop, uHorizon, uFlashDir;
                varying vec3 vDir;
                void main() {
                    vec3 d = normalize(vDir);
                    float h = max(d.y, 0.0);
                    vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.5, h));
                    vec2 uv = d.xz / (d.y + 0.18) * 1.3;
                    vec2 drift = vec2(uTime * 0.018, uTime * 0.006);
                    float c1 = fbm(uv + drift);
                    float c2 = fbm(uv * 2.4 - drift * 1.8 + c1 * 1.5);
                    float dens = smoothstep(0.32, 0.82, c1 * 0.7 + c2 * 0.45);
                    vec3 under = uTop * 0.62;
                    vec3 edge = mix(uHorizon, vec3(0.62, 0.68, 0.76), 0.25);
                    vec3 cloud = mix(edge, under, dens);
                    col = mix(col, cloud, smoothstep(-0.02, 0.12, d.y) * 0.92);
                    float near = pow(max(dot(d, normalize(uFlashDir)), 0.0), 8.0);
                    float lit = 0.35 + near * 2.2;
                    col += vec3(0.6, 0.68, 0.9) * uFlash * lit * (0.35 + c2 * 0.9) * smoothstep(-0.05, 0.1, d.y);
                    gl_FragColor = vec4(col, 1.0);
                }`,
            side: THREE.BackSide, depthWrite: false, fog: false
        });
        this.shaders.push(mat); this.flashMats.push(mat);
        this.sky = new THREE.Mesh(new THREE.SphereGeometry(420, 48, 24), mat);
        this.sky.renderOrder = -10;
        this.group.add(this.sky);
    }

    _buildMountains() {
        const ridge = (a, seed) => {
            const f = [2.3, 5.1, 11.7, 23.9], w = [0.5, 0.28, 0.14, 0.06];
            let h = 0;
            for (let k = 0; k < 4; k++) h += w[k] * (1 - Math.abs(Math.sin(a * f[k] + seed * (k + 1) * 1.37)));
            return h;
        };
        const layers = [
            { dist: 230, base: 18, amp: 46, seed: 1.2, col: 0x56657a, mist: 0x75849a },
            { dist: 150, base: 10, amp: 30, seed: 4.7, col: 0x37455a, mist: 0x66768b },
            { dist: 95, base: 5, amp: 15, seed: 8.1, col: 0x232f3b, mist: 0x5a6a7d }
        ];
        layers.forEach(L => {
            const N = 220, pos = [], tAttr = [], idx = [];
            for (let i = 0; i <= N; i++) {
                const a = -1.7 + (i / N) * 3.4;
                const x = Math.sin(a) * L.dist, z = -Math.cos(a) * L.dist;
                const top = L.base + ridge(a, L.seed) * L.amp;
                pos.push(x, -4, z, x, top, z);
                tAttr.push(0, 1);
                if (i < N) { const b = i * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            geo.setAttribute('aT', new THREE.Float32BufferAttribute(tAttr, 1));
            geo.setIndex(idx);
            const mat = this._shader({
                uniforms: { uTime: { value: 0 }, uFlash: { value: 0 }, uCol: { value: new THREE.Color(L.col) }, uMist: { value: new THREE.Color(L.mist) } },
                vertexShader: /* glsl */`
                    attribute float aT; varying float vT; varying vec3 vWorld;
                    void main() { vT = aT; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
                fragmentShader: NOISE_GLSL + /* glsl */`
                    uniform float uTime, uFlash; uniform vec3 uCol, uMist;
                    varying float vT; varying vec3 vWorld;
                    void main() {
                        float y = vWorld.y;
                        float forest = 0.82 + 0.18 * noise(vWorld.xz * 0.35 + y * 0.6);
                        vec3 col = uCol * forest;
                        float m = fbm(vec2(vWorld.x * 0.012 + uTime * 0.012, y * 0.05 - uTime * 0.004));
                        float low = 1.0 - smoothstep(-2.0, 16.0, y);
                        col = mix(col, uMist, clamp(low * 0.85 + smoothstep(0.45, 0.85, m) * 0.55 * (1.0 - vT * 0.4), 0.0, 1.0));
                        col += vec3(0.32, 0.38, 0.5) * uFlash * (0.25 + 0.4 * smoothstep(0.0, 40.0, y));
                        gl_FragColor = vec4(col, 1.0);
                    }`
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.renderOrder = -5;
            this.group.add(mesh);
        });
    }

    _buildMist() {
        const banks = [
            { z: -175, y: 14, w: 520, h: 46, op: 0.55, speed: 0.008, col: 0x7c8b9e },
            { z: -118, y: 8, w: 380, h: 30, op: 0.5, speed: -0.012, col: 0x718196 },
            { z: -70, y: 4, w: 240, h: 18, op: 0.42, speed: 0.016, col: 0x66778a },
            { z: -42, y: 2.5, w: 140, h: 10, op: 0.3, speed: -0.022, col: 0x5f6f82 },
            { z: -24, y: 1.2, w: 80, h: 5, op: 0.22, speed: 0.03, col: 0x5a687a }
        ];
        banks.forEach((b, i) => {
            const mat = this._shader({
                uniforms: { uTime: { value: 0 }, uFlash: { value: 0 }, uColor: { value: new THREE.Color(b.col) }, uOp: { value: b.op }, uSpeed: { value: b.speed }, uSeed: { value: i * 17.3 } },
                fragmentShader: NOISE_GLSL + /* glsl */`
                    uniform float uTime, uFlash, uOp, uSpeed, uSeed; uniform vec3 uColor;
                    varying vec2 vUv;
                    void main() {
                        vec2 p = vec2(vUv.x * 7.0 + uTime * uSpeed * 6.0 + uSeed, vUv.y * 1.6);
                        float n = fbm(p + fbm(p * 1.7 - uTime * 0.02) * 0.8);
                        float vert = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
                        float side = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
                        float a = smoothstep(0.3, 0.75, n) * vert * side * uOp;
                        gl_FragColor = vec4(uColor * (1.0 + uFlash * 0.9), a);
                    }`,
                transparent: true, depthWrite: false
            });
            const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), mat);
            m.position.set(0, b.y, b.z);
            m.renderOrder = 1;
            this.group.add(m);
        });
    }

    /** EZ-Tree pines (same generator as the levels); cone silhouettes only if it fails to load. */
    async _buildForest() {
        const rnd = (a, b) => a + Math.random() * (b - a);
        const spots = [];
        const ok = (x, z) => !(x > -9 && x < 26 && z > -36);   // keep the camp clear
        const scatter = (n, x0, x1, z0, z1, h0, h1) => {
            for (let i = 0, g = 0; i < n && g < n * 20; g++) {
                const x = rnd(x0, x1), z = rnd(z0, z1);
                if (!ok(x, z)) continue;
                spots.push({ x, z, h: rnd(h0, h1) }); i++;
            }
        };
        scatter(12, -36, -12, -40, -56, 8, 12);      // grove behind the trucks
        scatter(10, 26, 48, -50, -66, 9, 13);         // behind the watchtower
        scatter(34, -90, 90, -62, -90, 9, 14);
        scatter(170, -170, 170, -100, -170, 10, 16);
        spots.push({ x: -12, z: -38, h: 10 }, { x: -8, z: -45, h: 11 }, { x: 30, z: -56, h: 12 }, { x: 36, z: -62, h: 12 });
        let forest = null;
        try {
            forest = await buildMenuForest(this.group, spots, {
                eye: CAM_POS, tint: { leaf: 0x2c4434, bark: 0x5a5046 }, variants: 3, lodDist: [45, 85]
            });
        } catch (e) { console.warn('Menu EZ-Tree forest failed:', e); }
        if (this.disposed) { if (forest) forest.dispose(); return; }
        if (forest) { this.forest = forest; return; }
        this._buildConeForest();
    }

    _buildConeForest() {
        const parts = [];
        const trunk = new THREE.CylinderGeometry(0.1, 0.2, 2.4, 5);
        trunk.translate(0, 1.2, 0);
        parts.push(trunk);
        for (let k = 0; k < 6; k++) {
            const r = 1.9 * (1 - k * 0.15);
            const cone = new THREE.ConeGeometry(r, 2.7 - k * 0.15, 7);
            cone.translate(0, 2.4 + k * 1.35, 0);
            parts.push(cone);
        }
        const geo = mergeGeometries(parts.map(g => g.toNonIndexed()));
        geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color: 0x18221d, roughness: 1, flatShading: true });
        const spots = [];
        const rnd = (a, b) => a + Math.random() * (b - a);
        for (let i = 0; i < 320; i++) spots.push([rnd(-100, 100), rnd(-55, -120), rnd(0.8, 1.4)]);
        for (let i = 0; i < 60; i++) spots.push([rnd(-40, -9), rnd(-30, -55), rnd(0.7, 1.2)]);
        for (let i = 0; i < 30; i++) spots.push([rnd(26, 50), rnd(-40, -60), rnd(0.8, 1.3)]);
        spots.push([-6.5, -32, 1.2], [-9, -36, 1.35], [-5.2, -40, 1.1], [26, -46, 1.4], [30, -50, 1.3]);
        const trees = new THREE.InstancedMesh(geo, mat, spots.length);
        const d = new THREE.Object3D();
        spots.forEach(([x, z, s], i) => {
            d.position.set(x, 0, z);
            d.rotation.set(0, Math.random() * 6.28, (Math.random() - 0.5) * 0.06);
            d.scale.set(s * rnd(0.85, 1.1), s * rnd(0.9, 1.25), s * rnd(0.85, 1.1));
            d.updateMatrix();
            trees.setMatrixAt(i, d.matrix);
        });
        trees.instanceMatrix.needsUpdate = true;
        this.group.add(trees);
    }

    _buildGround() {
        const tex = TextureFactory.ground(512, 34);
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(400, 400),
            new THREE.MeshStandardMaterial({
                color: 0x7a746a, map: tex.map, normalMap: tex.normalMap, normalScale: new THREE.Vector2(0.55, 0.55),
                roughness: 0.2, metalness: 0.1
            })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.userData.ssrReflective = true;
        this.group.add(ground);

        // rain ripples in the puddles
        const ripple = this._shader({
            uniforms: { uTime: { value: 0 }, uFlash: { value: 0 } },
            fragmentShader: NOISE_GLSL + /* glsl */`
                uniform float uTime, uFlash;
                varying vec3 vWorld;
                float rings(vec2 p) {
                    vec2 cell = floor(p), f = fract(p);
                    float acc = 0.0;
                    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
                        vec2 c = cell + vec2(float(i), float(j));
                        float h = hash(c);
                        vec2 ctr = vec2(hash(c + 3.1), hash(c + 7.7));
                        float t = fract(uTime * (0.8 + h * 0.6) + h * 7.0);
                        float d = length(f - vec2(float(i), float(j)) - ctr);
                        acc += smoothstep(0.03, 0.0, abs(d - t * 0.55)) * (1.0 - t) * (1.0 - t);
                    }
                    return acc;
                }
                void main() {
                    vec2 p = vWorld.xz;
                    float puddle = smoothstep(0.42, 0.62, fbm(p * 0.18));
                    float dist = length(vWorld - cameraPosition);
                    float fade = smoothstep(42.0, 6.0, dist);
                    float r = rings(p * 2.6) * puddle * fade;
                    vec3 col = vec3(0.55, 0.62, 0.72) * (0.35 + uFlash * 2.0);
                    gl_FragColor = vec4(col * r, 1.0);
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
        });
        const rip = new THREE.Mesh(new THREE.PlaneGeometry(70, 50), ripple);
        rip.rotation.x = -Math.PI / 2;
        rip.position.set(6, 0.02, -24);
        rip.renderOrder = 2;
        this.group.add(rip);
    }

    // ── camp ───────────────────────────────────────────────────────────
    _buildCamp() {
        const canvas = TextureFactory.burlap(256, 3);
        const tentMat = new THREE.MeshStandardMaterial({ color: 0xb4b6aa, map: canvas.map, normalMap: canvas.normalMap, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
        const tentDark = new THREE.MeshStandardMaterial({ color: 0x6a6e5e, map: canvas.map, roughness: 0.6, side: THREE.DoubleSide });
        if (!this.glowTex) this.glowTex = TextureFactory.radialGradient(128, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
        const interiorMat = new THREE.MeshBasicMaterial({ color: 0x3a2412, fog: true });
        const glowMat = new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0xd07a34, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2b28, roughness: 0.5, metalness: 0.6 });

        const tent = (x, z, yaw, w, d, h, openFront) => {
            const g = new THREE.Group();
            g.position.set(x, 0, z); g.rotation.y = yaw;
            const wallH = h * 0.55;
            // side walls + back
            this._box(0.05, wallH, d, tentDark, -w / 2, wallH / 2, 0, g);
            this._box(0.05, wallH, d, tentDark, w / 2, wallH / 2, 0, g);
            this._box(w, wallH, 0.05, tentDark, 0, wallH / 2, -d / 2, g);
            // sagging gable roof
            const shape = new THREE.Shape();
            shape.moveTo(-w / 2 - 0.25, wallH - 0.1); shape.lineTo(0, h); shape.lineTo(w / 2 + 0.25, wallH - 0.1);
            shape.lineTo(w / 2 + 0.2, wallH - 0.05); shape.lineTo(0, h - 0.06); shape.lineTo(-w / 2 - 0.2, wallH - 0.05);
            const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: d + 0.5, bevelEnabled: false }), tentMat);
            roof.position.z = -d / 2 - 0.25;
            g.add(roof);
            const gable = new THREE.Shape();
            gable.moveTo(-w / 2, wallH); gable.lineTo(0, h - 0.05); gable.lineTo(w / 2, wallH);
            const back = new THREE.Mesh(new THREE.ShapeGeometry(gable), tentDark);
            back.position.z = -d / 2; g.add(back);
            if (openFront) {
                // lit interior seen through the open flap
                const back = this._box(w * 0.8, wallH * 0.95, 0.02, interiorMat, 0, wallH * 0.48, -d / 2 + 0.12, g);
                back.material = interiorMat;
                const glow = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.9, wallH * 1.3), glowMat);
                glow.position.set(0, wallH * 0.42, -d / 2 + 0.2);
                g.add(glow);
                const flapL = this._box(w * 0.18, wallH, 0.04, tentDark, -w * 0.41, wallH / 2, d / 2, g);
                flapL.rotation.y = 0.5;
                const front = new THREE.Mesh(new THREE.ShapeGeometry(gable), tentDark);
                front.position.z = d / 2; g.add(front);
            } else {
                this._box(w, wallH, 0.05, tentDark, 0, wallH / 2, d / 2, g);
                const front = new THREE.Mesh(new THREE.ShapeGeometry(gable), tentDark);
                front.position.z = d / 2; g.add(front);
            }
            // tie-down poles
            [-1, 1].forEach(s => this._box(0.06, h + 0.3, 0.06, poleMat, 0, (h + 0.3) / 2, s * (d / 2 + 0.2), g));
            this.group.add(g);
            return g;
        };

        tent(9.0, -19.5, -0.55, 6.5, 5, 3.4, true);
        tent(15.0, -25, -0.5, 7, 5.5, 3.6, true);
        tent(22.5, -30, -0.45, 7.5, 6, 3.8, false);
        tent(5.0, -31, -0.2, 5.5, 4.5, 3.0, false);

        // interior glow spilling out of the tents
        const tl = new THREE.PointLight(0xffa04a, 16, 12, 2);
        tl.position.set(8.4, 1.6, -16.6);
        this.group.add(tl);
        const tl2 = new THREE.PointLight(0xff9a44, 16, 12, 2);
        tl2.position.set(14.3, 1.6, -21.7);
        this.group.add(tl2);
        this._glow(0xff9c4a, 1.6, new THREE.Vector3(8.4, 1.3, -16.9), 0.12);
        this._glow(0xff9c4a, 1.8, new THREE.Vector3(14.3, 1.4, -22.0), 0.12);
        this._streak(8.4, -16.7, 0xff9748, 9, 1.6, 0.35);
        this._streak(14.3, -21.8, 0xff9748, 12, 1.8, 0.3);

        // sodium lamp posts
        const lamp = (x, z, h, light) => {
            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, h, 6), poleMat);
            pole.position.set(x, h / 2, z);
            this.group.add(pole);
            this._box(0.5, 0.05, 0.05, poleMat, x - 0.22, h - 0.05, z);
            const head = this._box(0.22, 0.1, 0.16, poleMat, x - 0.42, h - 0.1, z);
            head.material = poleMat;
            const bulbPos = new THREE.Vector3(x - 0.42, h - 0.18, z);
            const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd6a0, fog: false }));
            bulb.position.copy(bulbPos);
            this.group.add(bulb);
            this._glow(0xffa95a, 0.45 + h * 0.05, bulbPos, 0.06);
            this._glow(0xffe0b0, 0.18, bulbPos);
            if (light) {
                const pl = new THREE.PointLight(0xffa04a, 40, 20, 2);
                pl.position.copy(bulbPos).y -= 0.2;
                this.group.add(pl);
            }
            this._streak(x - 0.42, z, 0xffa04a, h * 2.6, 0.9 + h * 0.08, 0.9);
        };
        lamp(4.6, -18.5, 4.6, true);
        lamp(11.2, -14.2, 3.6, true);
        lamp(10.5, -27.5, 7.0, false);
        lamp(-1.2, -24, 4.2, false);

        // stacked supply crates (procedural, replaced by scanned props where available)
        const wood = TextureFactory.wood(256, 1);
        const crateMat = new THREE.MeshStandardMaterial({ color: 0x5f6448, map: wood.map, normalMap: wood.normalMap, roughness: 0.45 });
        const crate = (x, y, z, s, yaw) => { const c = this._box(s * 1.2, s * 0.8, s * 0.8, crateMat, x, y + s * 0.4, z); c.rotation.y = yaw; };
        crate(15.5, 0, -15.5, 1.1, -0.4); crate(16.6, 0, -15.0, 1.1, -0.5); crate(16.0, 0.88, -15.3, 1.1, -0.45);
        crate(19.5, 0, -18.5, 1.2, -0.3); crate(20.8, 0, -18.0, 1.2, -0.35); crate(9.5, 0, -10.6, 0.8, 0.2);
        crate(-0.5, 0, -15.5, 0.9, 0.4); crate(0.4, 0, -15.8, 0.9, 0.3);
    }

    _buildTruck(x, z, yaw, lit) {
        const g = new THREE.Group();
        g.position.set(x, 0, z); g.rotation.y = yaw;
        const camo = TextureFactory.camo(256, 1);
        const body = new THREE.MeshStandardMaterial({ color: 0x5d6150, map: camo.map, roughness: 0.4, metalness: 0.3 });
        const canvas = new THREE.MeshStandardMaterial({ color: 0x4d4f3c, roughness: 0.6, metalness: 0.05 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x141513, roughness: 0.6, metalness: 0.4 });
        const glass = new THREE.MeshStandardMaterial({ color: 0x0c1014, roughness: 0.08, metalness: 0.9 });
        // chassis + bed + canvas cover (rear toward +Z)
        this._box(2.3, 0.35, 6.4, dark, 0, 0.8, 0, g);
        this._box(2.45, 0.6, 4.0, body, 0, 1.25, 1.0, g);
        const cover = new THREE.Mesh(new THREE.CylinderGeometry(1.22, 1.22, 4.0, 14, 1, false, -Math.PI / 2, Math.PI), canvas);
        cover.rotation.x = Math.PI / 2; cover.rotation.z = Math.PI / 2;
        cover.scale.set(1, 1, 0.75);
        cover.position.set(0, 1.55, 1.0);
        g.add(cover);
        this._box(2.42, 0.95, 4.0, canvas, 0, 2.0, 1.0, g);
        // cab
        this._box(2.35, 1.5, 1.9, body, 0, 1.85, -2.1, g);
        this._box(2.0, 0.6, 0.05, glass, 0, 2.2, -3.07, g);
        this._box(2.35, 0.8, 1.2, body, 0, 1.3, -3.5, g);
        // wheels
        const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.45, 14);
        [[-1.05, -2.6], [1.05, -2.6], [-1.05, 0.6], [1.05, 0.6], [-1.05, 2.0], [1.05, 2.0]].forEach(([wx, wz]) => {
            const w = new THREE.Mesh(wheelGeo, dark);
            w.rotation.z = Math.PI / 2;
            w.position.set(wx, 0.55, wz);
            g.add(w);
        });
        // rear bumper + tail lights
        this._box(2.5, 0.18, 0.15, dark, 0, 0.75, 3.15, g);
        const tailMat = new THREE.MeshBasicMaterial({ color: 0xff1c10, fog: false });
        [-0.95, 0.95].forEach(tx => this._box(0.2, 0.12, 0.04, tailMat, tx, 0.95, 3.22, g));
        this.group.add(g);
        g.updateMatrixWorld(true);
        if (lit) {
            [-0.95, 0.95].forEach(tx => {
                const p = g.localToWorld(new THREE.Vector3(tx, 0.95, 3.3));
                this._glow(0xff2a14, 0.32, p, 0.05);
                this._streak(p.x, p.z, 0xff2a14, 3.5, 0.45, 0.8);
            });
            const red = new THREE.PointLight(0xff2010, 1.5, 4, 2);
            red.position.copy(g.localToWorld(new THREE.Vector3(0, 1.0, 3.8)));
            this.group.add(red);
        }
    }

    _buildTower(x, z) {
        const g = new THREE.Group();
        g.position.set(x, 0, z);
        g.rotation.y = -0.35;
        const steel = new THREE.MeshStandardMaterial({ color: 0x2b2e2e, roughness: 0.55, metalness: 0.6 });
        const V = (a, b, c) => new THREE.Vector3(a, b, c);
        const H = 9;
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        const at = (c, y) => { const s = 1.7 - (y / H) * 0.5; return V(c[0] * s, y, c[1] * s); };
        corners.forEach(c => this._strut(at(c, 0), at(c, H + 2.6), 0.14, steel, g));
        const levels = [0, 3, 6, H];
        for (let l = 0; l < levels.length - 1; l++) {
            for (let i = 0; i < 4; i++) {
                const a = corners[i], b = corners[(i + 1) % 4];
                this._strut(at(a, levels[l]), at(b, levels[l + 1]), 0.07, steel, g);
                this._strut(at(b, levels[l]), at(a, levels[l + 1]), 0.07, steel, g);
                this._strut(at(a, levels[l + 1]), at(b, levels[l + 1]), 0.08, steel, g);
            }
        }
        // cabin
        const cab = new THREE.MeshStandardMaterial({ color: 0x3a3c36, roughness: 0.6, metalness: 0.3 });
        this._box(3.6, 0.2, 3.6, steel, 0, H, 0, g);
        this._box(3.6, 1.0, 0.06, cab, 0, H + 0.6, 1.78, g);
        this._box(3.6, 1.0, 0.06, cab, 0, H + 0.6, -1.78, g);
        this._box(0.06, 1.0, 3.6, cab, 1.78, H + 0.6, 0, g);
        this._box(0.06, 1.0, 3.6, cab, -1.78, H + 0.6, 0, g);
        this._box(4.1, 0.16, 4.1, cab, 0, H + 2.65, 0, g);
        const win = new THREE.MeshBasicMaterial({ color: 0xffb064, fog: true });
        this._box(2.2, 0.5, 0.04, win, 0, H + 1.5, 1.6, g);
        this._box(0.04, 0.5, 2.2, win, -1.6, H + 1.5, 0, g);
        // antennas + dish
        this._strut(V(1.4, H + 2.7, -1.2), V(1.4, H + 9.5, -1.2), 0.06, steel, g);
        this._strut(V(-1.2, H + 2.7, 1.2), V(-1.2, H + 7.0, 1.2), 0.05, steel, g);
        const dish = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.32), new THREE.MeshStandardMaterial({ color: 0x7d8284, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }));
        dish.position.set(0.6, H + 3.6, 0.4);
        dish.rotation.set(-1.0, 0.6, 0);
        g.add(dish);
        this._strut(V(0.6, H + 2.7, 0.4), V(0.6, H + 3.4, 0.4), 0.08, steel, g);
        this.group.add(g);
        g.updateMatrixWorld(true);

        // working lights
        const lampPos = g.localToWorld(V(-1.9, H + 2.3, 1.9));
        this._glow(0xffb26a, 1.6, lampPos, 0.05);
        this._glow(0xfff0d0, 0.35, lampPos);
        const tl = new THREE.PointLight(0xffa858, 50, 26, 2);
        tl.position.copy(lampPos);
        this.group.add(tl);
        this._streak(lampPos.x, lampPos.z, 0xffa24e, 22, 1.6, 0.55);
        const winPos = g.localToWorld(V(0, H + 1.5, 1.9));
        this._glow(0xff9e50, 2.2, winPos, 0.08);

        // blinking aviation light on the mast
        const top = g.localToWorld(V(1.4, H + 9.6, -1.2));
        this.blinkers.push(this._glow(0xff2a1a, 0.9, top));

        // sweeping searchlight
        const beamMat = this._shader({
            uniforms: { uTime: { value: 0 } },
            vertexShader: /* glsl */`
                varying float vAlong; varying vec3 vN; varying vec3 vView;
                void main() {
                    vAlong = clamp(position.z / 70.0, 0.0, 1.0);
                    vec4 w = modelMatrix * vec4(position, 1.0);
                    vN = normalize(mat3(modelMatrix) * normal);
                    vView = normalize(cameraPosition - w.xyz);
                    gl_Position = projectionMatrix * viewMatrix * w;
                }`,
            fragmentShader: NOISE_GLSL + /* glsl */`
                uniform float uTime;
                varying float vAlong; varying vec3 vN; varying vec3 vView;
                void main() {
                    float edge = pow(abs(dot(vN, vView)), 1.4);
                    float fall = pow(1.0 - vAlong, 2.2) * smoothstep(0.0, 0.02, vAlong);
                    float dust = 0.7 + 0.3 * noise(vec2(vAlong * 40.0 - uTime * 0.8, uTime * 0.3));
                    gl_FragColor = vec4(vec3(0.82, 0.88, 1.0) * edge * fall * dust * 0.16, 1.0);
                }`,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
        });
        const beamGeo = new THREE.CylinderGeometry(0.15, 7.5, 70, 32, 1, true);
        beamGeo.translate(0, -35, 0);
        beamGeo.rotateX(-Math.PI / 2);   // beam extends along local +Z so lookAt aims it
        this.beam = new THREE.Mesh(beamGeo, beamMat);
        this.beam.position.copy(g.localToWorld(V(1.8, H + 2.0, 1.4)));
        this.beam.renderOrder = 4;
        this.group.add(this.beam);
        this._glow(0xe6eeff, 1.2, this.beam.position);
        this.beamTarget = new THREE.Vector3();
    }

    _buildCanopy() {
        const E0 = new THREE.Vector3(3.6, 3.15, -1.1), E1 = new THREE.Vector3(-1.8, 3.25, -7.8);
        const off = new THREE.Vector3(-7.5, 0.55, 4.6);
        const B0 = E0.clone().add(off), B1 = E1.clone().add(off);
        const SU = 24, SV = 14;
        const geo = new THREE.PlaneGeometry(1, 1, SU, SV);
        this.canopyCorners = { E0, E1, B0, B1 };
        this.canopyGeo = geo;
        this._layoutCanopy(0);
        const burlap = TextureFactory.burlap(256, 4);
        const mat = new THREE.MeshStandardMaterial({ color: 0x3d3f35, map: burlap.map, normalMap: burlap.normalMap, roughness: 0.75, side: THREE.DoubleSide });
        this.canopy = new THREE.Mesh(geo, mat);
        this.group.add(this.canopy);

        const metal = new THREE.MeshStandardMaterial({ color: 0x3b3a33, roughness: 0.35, metalness: 0.7 });
        // front edge rail catches the camp light
        const edgeMid = this._strut(E0.clone().setY(E0.y - 0.08), E1.clone().setY(E1.y - 0.12), 0.09, metal);
        edgeMid.material = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.3, metalness: 0.6 });
        // support poles
        const pole = (top) => this._strut(new THREE.Vector3(top.x, 0, top.z), top, 0.1, metal);
        pole(E1.clone().setY(E1.y - 0.1));
        pole(new THREE.Vector3(-3.4, 3.4, -9.6));
        this._strut(new THREE.Vector3(-3.4, 3.35, -9.6), E1.clone().setY(E1.y - 0.1), 0.07, metal);
        this._strut(new THREE.Vector3(-1.2, 2.9, -4.2), new THREE.Vector3(-5.5, 3.5, -1.5), 0.08, metal);
    }

    /** Bilinear canopy surface with sag, plus a gusting flutter toward the free edge. */
    _layoutCanopy(t) {
        const { E0, E1, B0, B1 } = this.canopyCorners;
        const pos = this.canopyGeo.attributes.position;
        const SU = 24, SV = 14;
        const p = new THREE.Vector3(), q = new THREE.Vector3();
        const gust = 0.6 + 0.4 * Math.sin(t * 0.7) * Math.sin(t * 0.23);
        for (let j = 0; j <= SV; j++) {
            const v = j / SV;              // 0 = front edge, 1 = back
            for (let i = 0; i <= SU; i++) {
                const u = i / SU;
                p.copy(E0).lerp(E1, u);
                q.copy(B0).lerp(B1, u);
                p.lerp(q, v);
                const sag = Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.4 + 0.1)) * 0.28;
                const flutter = Math.sin(u * 9 - t * 3.1) * Math.sin(u * 3.0 + t * 1.3) * 0.045 * (1 - v) * gust;
                p.y -= sag - flutter;
                pos.setXYZ(j * (SU + 1) + i, p.x, p.y, p.z);
            }
        }
        pos.needsUpdate = true;
        this.canopyGeo.computeVertexNormals();
    }

    _buildForeground() {
        const wood = TextureFactory.wood(256, 2);
        const tableMat = new THREE.MeshStandardMaterial({ color: 0x4a4236, map: wood.map, normalMap: wood.normalMap, roughness: 0.35, metalness: 0.05 });
        const table = this._box(3.6, 0.06, 0.8, tableMat, 0.25, 0.85, -1.45);
        table.rotation.y = 0.03;

        // papers / map
        const paperMat = new THREE.MeshStandardMaterial({ color: 0x3e3d38, roughness: 0.8 });
        [[0.45, -1.3, 0.12], [0.75, -1.32, -0.18], [-0.55, -1.25, 0.3]].forEach(([x, z, r]) => {
            const p = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), paperMat);
            p.rotation.set(-Math.PI / 2, 0, r);
            p.position.set(x, 0.885, z);
            this.group.add(p);
        });

        // enamel mug + steam
        const mugMat = new THREE.MeshStandardMaterial({ color: 0x2a2f2e, roughness: 0.3, metalness: 0.4 });
        const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.044, 0.11, 18, 1, true), mugMat);
        mug.material.side = THREE.DoubleSide;
        mug.position.set(-0.75, 0.94, -1.4);
        this.group.add(mug);
        const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.045, 18), new THREE.MeshStandardMaterial({ color: 0x120a06, roughness: 0.1 }));
        coffee.rotation.x = -Math.PI / 2; coffee.position.set(-0.75, 0.975, -1.4);
        this.group.add(coffee);
        const handle = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.008, 8, 14, Math.PI), mugMat);
        handle.position.set(-0.7, 0.94, -1.4); handle.rotation.z = -Math.PI / 2;
        this.group.add(handle);
        if (!this.glowTex) this.glowTex = TextureFactory.radialGradient(128, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');
        this.steam = [];
        for (let i = 0; i < 7; i++) {
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xb9c2c8, transparent: true, opacity: 0, depthWrite: false }));
            s.userData.phase = i / 7;
            this.group.add(s);
            this.steam.push(s);
        }
        this.steamOrigin = new THREE.Vector3(-0.75, 0.99, -1.4);

        // hard cases
        const caseMat = new THREE.MeshStandardMaterial({ color: 0x252a24, roughness: 0.38, metalness: 0.2 });
        const latchMat = new THREE.MeshStandardMaterial({ color: 0x5b5d58, roughness: 0.3, metalness: 0.8 });
        const hardCase = (x, y, z, w, h, d, yaw) => {
            const g = new THREE.Group();
            const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, 0.035), caseMat);
            body.position.y = h / 2;
            g.add(body);
            this._box(w * 1.01, 0.025, d * 1.01, caseMat, 0, h * 0.62, 0, g);
            [-0.3, 0.3].forEach(s => this._box(0.07, 0.06, 0.02, latchMat, s * w, h * 0.62, d / 2 + 0.01, g));
            this._box(w * 0.3, 0.03, 0.05, latchMat, 0, h + 0.012, 0, g);
            g.position.set(x, y, z); g.rotation.y = yaw;
            this.group.add(g);
        };
        hardCase(-1.55, 0.88, -1.45, 0.95, 0.26, 0.5, 0.06);
        hardCase(-1.7, 1.14, -1.55, 0.6, 0.2, 0.42, -0.08);
        hardCase(1.55, 0.88, -1.3, 0.8, 0.2, 0.45, -0.1);
        hardCase(-2.2, 0, -3.0, 1.0, 0.55, 0.6, 0.3);
        hardCase(-2.0, 0.55, -3.1, 0.9, 0.45, 0.55, 0.25);
    }

    _buildRain() {
        // GPU-driven streaks; centred ahead of the camera so they fill the view
        this.rain = new Weather({ kind: 'rain', count: 2600, speed: 26, color: 0xb6c4d4, opacity: 0.3, streak: 0.9, area: 46, height: 28, wind: [2.4, 0.5] });
        this.rainNear = new Weather({ kind: 'rain', count: 260, speed: 20, color: 0xc4d0dc, opacity: 0.12, streak: 0.45, area: 8, height: 7, wind: [1.6, 0.3], range: 6 });
        this.group.add(this.rain.object, this.rainNear.object);
        this.rainFocus = new THREE.Vector3(2, 1.2, -16);
        this.rainNearFocus = new THREE.Vector3(1.2, 1.4, -4.2);
    }

    // ── characters & props (async) ─────────────────────────────────────
    async _loadCharacters() {
        try {
            await Promise.all([loadCharacters(), loadWeaponModels()]);
        } catch (e) { console.warn('Menu characters unavailable:', e); return; }
        if (this.disposed) return;
        const wet = (c) => c.materials.forEach(m => { m.roughness = 0.5; m.metalness = Math.max(m.metalness ?? 0, 0.08); });

        const hero = createCharacter('soldier', 'ally', 'ak74m');
        if (hero) {
            wet(hero);
            hero.materials.forEach(m => { if (m.color) m.color.lerp(new THREE.Color(0x9c9a86), 0.55); });
            // seated on the far edge of the table, legs over the side, facing the camp
            hero.root.position.set(0.12, 0, -1.62);
            hero.root.rotation.y = Math.PI - 0.32;
            this.group.add(hero.root);
            hero.root.updateMatrixWorld(true);
            const hips = hero.rig.bones.hips.getWorldPosition(new THREE.Vector3());
            hero.root.position.y = SEAT_Y + 0.1 - hips.y;
            this.hero = hero;
            this.pack = this._buildBackpack();
            this.packChest = hero.rig.bones.chest || hero.rig.bones.spine;
            // rifle propped against the table beside him: off the root, so the animator leaves the arms alone
            const rifle = hero.rifle;
            this.group.add(rifle);
            rifle.position.set(0.72, 0.5, -1.98);
            rifle.rotation.set(-Math.PI / 2 + 0.22, -0.4, -0.12, 'YXZ');
            rifle.updateMatrixWorld(true);
            this._initFingers();
            this.heroMind = { yaw: 0, yawGoal: 0, look: 0, lookGoal: 0, bow: 0.42, bowGoal: 0.42, next: 4 };
        }
        const guard = createCharacter('army2', 'ally', 'm5scw') || createCharacter('soldier', 'ally', 'm5scw');
        if (guard) {
            wet(guard);
            guard.root.position.set(3.0, 0, -11.8);
            this.group.add(guard.root);
            this.patrol = { c: guard, path: [new THREE.Vector3(2.4, 0, -11.6), new THREE.Vector3(6.4, 0, -12.8), new THREE.Vector3(5.2, 0, -14.6)], leg: 0, wait: 0, speed: 0, look: 0, lookGoal: 0 };
        }
        const sentry = createCharacter('army1', 'ally', 'ak74m');
        if (sentry) {
            wet(sentry);
            sentry.root.position.set(7.4, 0, -15.6);
            sentry.root.rotation.y = 0.2;
            this.group.add(sentry.root);
            this.sentry = sentry;
        }
    }

    /** Assault pack with pouches and a bedroll, carried on the hero's back. */
    _buildBackpack() {
        const g = new THREE.Group();
        const camo = TextureFactory.camo(256, 1);
        const cloth = new THREE.MeshStandardMaterial({ color: 0x6b6a52, map: camo.map, roughness: 0.55, metalness: 0.05 });
        const strap = new THREE.MeshStandardMaterial({ color: 0x24261f, roughness: 0.6 });
        const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
        add(new RoundedBoxGeometry(0.4, 0.5, 0.2, 3, 0.06), cloth, 0, 0, 0);
        add(new RoundedBoxGeometry(0.3, 0.2, 0.09, 3, 0.03), cloth, 0, -0.1, -0.13);
        add(new RoundedBoxGeometry(0.12, 0.26, 0.1, 3, 0.03), cloth, -0.24, -0.04, -0.02);
        add(new RoundedBoxGeometry(0.12, 0.26, 0.1, 3, 0.03), cloth, 0.24, -0.04, -0.02);
        const roll = add(new THREE.CylinderGeometry(0.075, 0.075, 0.46, 12), strap, 0, 0.3, -0.02);
        roll.rotation.z = Math.PI / 2;
        [-0.12, 0.12].forEach(x => add(new THREE.BoxGeometry(0.04, 0.52, 0.015), strap, x, 0.02, -0.11));
        g.scale.setScalar(0.66);
        this.group.add(g);
        return g;
    }

    _followBackpack() {
        if (!this.pack || !this.packChest) return;
        if (!this._packTmp) this._packTmp = { p: new THREE.Vector3(), o: new THREE.Vector3(), q: new THREE.Quaternion() };
        const { p, o, q } = this._packTmp;
        // chest frame in character axes: world rotation with the bind orientation removed
        const rest = this.hero.rig.rest[this.hero.rig.bones.chest ? 'chest' : 'spine'];
        this.packChest.getWorldQuaternion(q).multiply(rest.Winv);
        this.packChest.getWorldPosition(p);
        o.set(0, -0.17, -0.16).applyQuaternion(q);
        this.pack.position.copy(p).add(o);
        this.pack.quaternion.copy(q);
        this.pack.rotateX(-0.08);
        if (this.sling) {
            o.set(0.06, -0.08, -0.29).applyQuaternion(q);
            this.sling.position.copy(p).add(o);
            this.sling.quaternion.copy(q);
            this.sling.rotateZ(-0.26);
            this.sling.rotateX(Math.PI / 2 + 0.12);
            this.sling.rotateZ(Math.PI / 2);
        }
    }

    /** Two-bone arm IK in world space (mirrors the game's solver). s: +1 left, -1 right. */
    _armIK(side, s, target) {
        const rig = this.hero.rig;
        const A = rig.bones['a' + side], F = rig.bones['fA' + side], H = rig.bones['h' + side];
        if (!A || !F || !H) return;
        this._armLen = this._armLen || {};
        if (!this._armLen[side]) {
            const S0 = A.getWorldPosition(new THREE.Vector3()), E0 = F.getWorldPosition(new THREE.Vector3()), W0 = H.getWorldPosition(new THREE.Vector3());
            this._armLen[side] = [S0.distanceTo(E0), E0.distanceTo(W0)];
        }
        const [a, c] = this._armLen[side];
        const S = A.getWorldPosition(new THREE.Vector3());
        const toT = target.clone().sub(S);
        const dist = THREE.MathUtils.clamp(toT.length(), Math.abs(a - c) + 1e-3, a + c - 1e-3);
        const dir = toT.normalize();
        const cosA = (a * a + dist * dist - c * c) / (2 * a * dist);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const rootQ = this.hero.root.getWorldQuaternion(new THREE.Quaternion());
        const pole = new THREE.Vector3(s * 0.9, -0.6, -0.55).applyQuaternion(rootQ);
        pole.addScaledVector(dir, -pole.dot(dir)).normalize();
        const Edes = S.clone().addScaledVector(dir, a * cosA).addScaledVector(pole, a * sinA);
        const Tdes = S.clone().addScaledVector(dir, dist);
        aimBone(A, S, F.getWorldPosition(new THREE.Vector3()), Edes);
        aimBone(F, F.getWorldPosition(new THREE.Vector3()), H.getWorldPosition(new THREE.Vector3()), Tdes);
    }

    /** Collect finger chains and work out, per chain, which local axis curls the finger toward the palm. */
    _initFingers() {
        const chains = {};
        this.hero.root.traverse(o => {
            const m = o.isBone && /(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([1-4])/.exec(o.name);
            if (!m) return;
            (chains[m[1] + m[2]] = chains[m[1] + m[2]] || [])[Number(m[3]) - 1] = o;
        });
        const root = this.hero.root;
        const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(a => new THREE.Vector3(...a));
        const q = new THREE.Quaternion(), tip = new THREE.Vector3();
        this.fingers = [];
        root.updateMatrixWorld(true);
        for (const [key, bones] of Object.entries(chains)) {
            if (bones.length < 4 || bones.some(b => !b)) continue;
            const rest = bones.map(b => b.quaternion.clone());
            // T-pose palms face down, so the curling axis is the one that drops the fingertip most
            let best = axes[0], bestY = Infinity;
            for (const a of axes) {
                for (let i = 0; i < 3; i++) bones[i].quaternion.copy(rest[i]).multiply(q.setFromAxisAngle(a, 0.8));
                root.updateMatrixWorld(true);
                const y = bones[3].getWorldPosition(tip).y;
                if (y < bestY) { bestY = y; best = a; }
            }
            bones.forEach((b, i) => b.quaternion.copy(rest[i]));
            root.updateMatrixWorld(true);
            const finger = key.replace(/^(Left|Right)/, '');
            this.fingers.push({
                side: key.startsWith('Left') ? 0 : 1, finger, bones, rest, axis: best.clone(),
                // loose, staggered curl: index lightest, pinky tightest, thumb barely
                base: { Thumb: 0.12, Index: 0.3, Middle: 0.42, Ring: 0.5, Pinky: 0.58 }[finger],
                phase: Math.random() * 6.28
            });
        }
        this.fidget = { next: 5, t: -1, side: 1, kind: 0 };
    }

    /** Relaxed finger curl with breathing, slow independent drift and an occasional tap/rub fidget. */
    _animateHands(dt, t, breath) {
        if (!this.fingers || !this.fingers.length) return;
        const F = this.fidget;
        F.next -= dt;
        if (F.t < 0 && F.next <= 0) { F.t = 0; F.side = Math.random() < 0.7 ? 1 : 0; F.kind = Math.random() < 0.5 ? 0 : 1; }
        let env = 0;
        if (F.t >= 0) {
            F.t += dt;
            const dur = 2.6;
            env = Math.sin(Math.min(F.t / dur, 1) * Math.PI);
            if (F.t > dur) { F.t = -1; F.next = 6 + Math.random() * 8; }
        }
        const q = new THREE.Quaternion();
        for (const f of this.fingers) {
            const drift = Math.sin(t * 0.31 + f.phase) * 0.06 + Math.sin(t * 0.83 + f.phase * 2) * 0.03;
            let curl = f.base + drift + breath * 0.02 + (this.heroMind ? this.heroMind.clasp * 0.18 : 0);
            if (F.t >= 0 && f.side === F.side) {
                if (F.kind === 0 && (f.finger === 'Index' || f.finger === 'Middle')) {
                    // drumming fingers
                    const tap = Math.max(0, Math.sin(F.t * 7 + (f.finger === 'Middle' ? 0.9 : 0)));
                    curl -= env * tap * 0.28;
                } else if (F.kind === 1) {
                    // thumb rubs across the fingers while they close a little
                    if (f.finger === 'Thumb') curl += env * (0.25 + Math.sin(F.t * 3.2) * 0.2);
                    else curl += env * 0.08;
                }
            }
            for (let i = 0; i < 3; i++) {
                const k = (i === 0 ? 0.7 : i === 1 ? 1.0 : 0.75) * (f.finger === 'Thumb' ? 0.8 : 1);
                f.bones[i].quaternion.copy(f.rest[i]).multiply(q.setFromAxisAngle(f.axis, curl * k));
            }
        }
    }

    /** Set a bone to an (x, y, z) rotation in character space, same convention as the game's Animator. */    _pose(name, x, y, z) {
        const rig = this.hero.rig, b = rig.bones[name], r = rig.rest[name];
        if (!b || !r) return;
        if (!this._poseTmp) this._poseTmp = { e: new THREE.Euler(), q: new THREE.Quaternion(), d: new THREE.Quaternion() };
        const T = this._poseTmp;
        T.q.setFromEuler(T.e.set(x, y, z, 'XYZ'));
        T.d.copy(r.Winv).multiply(T.q).multiply(r.W);
        b.quaternion.copy(r.q).multiply(T.d);
    }

    /**
     * Seated hero: hunched forward with forearms on his knees, head bowed. Every
     * few seconds he slowly lifts his head to watch the camp, the tower or the
     * trucks, then sinks back. Breathing moves the chest and shoulders.
     */
    _updateHero(dt) {
        const M = this.heroMind, t = this.time;
        M.next -= dt;
        if (M.next <= 0) {
            const r = Math.random();
            if (r < 0.4) { M.bowGoal = 0.42; M.lookGoal = 0; M.yawGoal = 0; M.next = 5 + Math.random() * 4; }
            else if (r < 0.65) { M.bowGoal = -0.05; M.lookGoal = -0.5; M.yawGoal = -0.06; M.next = 4 + Math.random() * 3; }   // the tower
            else if (r < 0.85) { M.bowGoal = 0.02; M.lookGoal = 0.55; M.yawGoal = 0.06; M.next = 3 + Math.random() * 3; }    // the trucks
            else { M.bowGoal = 0.08; M.lookGoal = 0; M.yawGoal = 0; M.next = 4 + Math.random() * 3; }                          // straight ahead
        }
        const ease = (cur, goal, rate) => cur + (goal - cur) * (1 - Math.exp(-dt * rate));
        M.bow = ease(M.bow, M.bowGoal, 0.9);
        M.look = ease(M.look, M.lookGoal, 1.1);
        M.yaw = ease(M.yaw, M.yawGoal, 0.4);

        // let the animator run (keeps its internal state warm), then override into the seated pose
        this.hero.update(dt, { speed: 0 });
        const rig = this.hero.rig;
        if (rig.bones.hips && rig.rest.hips) rig.bones.hips.position.copy(rig.rest.hips.pos);

        const breath = Math.sin(t * 1.25) * 0.5 + 0.5;     // slow, heavy breathing
        const lift = 0.42 - M.bow;                          // 0 bowed .. ~0.45 head up
        const roll = rig.armDrop !== undefined ? THREE.MathUtils.clamp(1.3 - rig.armDrop, 0, 1.3) : 1.25;

        this._pose('hips', 0.0, M.yaw * 0.5, 0);
        this._pose('spine', 0.3 - lift * 0.25 + breath * 0.015, M.yaw + M.look * 0.06, 0.02);
        this._pose('chest', 0.22 - lift * 0.2 + breath * 0.03, M.look * 0.1, 0);
        this._pose('neck', M.bow * 0.45, M.look * 0.3, 0);
        this._pose('head', M.bow * 0.55 - 0.04, M.look * 0.5, Math.sin(t * 0.3) * 0.03);

        // legs hang over the table edge: thighs level, shins down, a lazy swing on one foot
        const swing = Math.sin(t * 0.7) * 0.05;
        this._pose('uL', -1.5, 0, 0.22);
        this._pose('lL', 1.45 + swing, 0, 0);
        this._pose('fL', 0.25, 0, 0);
        this._pose('uR', -1.45, 0, -0.22);
        this._pose('lR', 1.3, 0, 0);
        this._pose('fR', 0.3, 0, 0);

        // arms: IK onto the knees; bowed = hands clasped between them, head up = one hand resting on a thigh
        M.clasp = M.clasp === undefined ? 1 : M.clasp;
        M.clasp += ((M.bowGoal > 0.3 ? 1 : 0.25) - M.clasp) * (1 - Math.exp(-dt * 0.8));
        const root = this.hero.root;
        root.updateMatrixWorld(true);
        const rq = root.getWorldQuaternion(new THREE.Quaternion());
        const kneeL = rig.bones.lL.getWorldPosition(new THREE.Vector3());
        const kneeR = rig.bones.lR.getWorldPosition(new THREE.Vector3());
        const mid = kneeL.clone().add(kneeR).multiplyScalar(0.5);
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rq);
        const sway = Math.sin(t * 0.5) * 0.012 + breath * 0.006;
        [['L', 1, kneeL], ['R', -1, kneeR]].forEach(([side, s, knee]) => {
            const resting = knee.clone().add(new THREE.Vector3(0, 0.1 + sway, 0)).addScaledVector(fwd, -0.06);
            const clasped = mid.clone().add(new THREE.Vector3(0, 0.15 + sway, 0)).addScaledVector(fwd, 0.06);
            clasped.addScaledVector(knee.clone().sub(mid).setY(0), 0.14);
            // the far-side hand stays on the knee when he looks up; the other joins the clasp
            const c = side === 'L' ? M.clasp : Math.max(M.clasp, 0.55);
            this._armIK(side, s, resting.lerp(clasped, c));
        });
        // wrists drift on slow, unrelated rhythms so the hands never look frozen
        const n1 = Math.sin(t * 0.43) * 0.5 + Math.sin(t * 0.97 + 1.3) * 0.5;
        const n2 = Math.sin(t * 0.37 + 2.1) * 0.5 + Math.sin(t * 1.11) * 0.5;
        this._pose('hL', 0.45 + n1 * 0.06, n2 * 0.05, 0.1 + n2 * 0.05);
        this._pose('hR', 0.4 + n2 * 0.06, n1 * 0.05, -0.1 + n1 * 0.05);
        this._animateHands(dt, t, breath);

        this.hero.root.rotation.y = Math.PI - 0.32 + M.yaw * 0.3;
        this.hero.root.updateMatrixWorld(true);
    }

    async _loadProps() {
        const ids = ['wooden_military_crate', 'ammo_box', 'Barrel_01', 'metal_jerrycan_green', 'portable_generator'];
        try { await loadPropModels({ phProps: ids.map(id => ({ id })) }); } catch (e) { return; }
        if (this.disposed) return;
        const place = (id, x, z, yaw, s = 1, y = 0) => {
            const tpl = getPropTemplate(id);
            if (!tpl) return;
            const o = tpl.clone(true);
            o.position.set(x, y, z); o.rotation.y = yaw; o.scale.setScalar(s);
            this.group.add(o);
        };
        place('Barrel_01', 9.9, -11.6, 0.3); place('Barrel_01', 10.6, -11.9, 1.2);
        place('portable_generator', 5.6, -11.8, -0.6);
        place('wooden_military_crate', 2.6, -10.2, 0.4, 1.1); place('ammo_box', 3.1, -9.6, -0.2, 1.2);
        place('metal_jerrycan_green', -1.4, -9.5, 0.8); place('wooden_military_crate', -2.4, -8.2, -0.3, 1.2);
    }

    // ── events ─────────────────────────────────────────────────────────
    _strike() {
        const L = this.lightning;
        L.t = 0;
        L.pulses = [{ at: 0, k: 1 }, { at: 0.11 + Math.random() * 0.06, k: 0.55 }, { at: 0.28 + Math.random() * 0.12, k: 0.9 }];
        if (Math.random() < 0.4) L.pulses.push({ at: 0.55 + Math.random() * 0.2, k: 0.4 });
        L.dir.set(-0.6 + Math.random() * 1.4, 0.25 + Math.random() * 0.25, -1).normalize();
        L.next = 7 + Math.random() * 11;
        try {
            if (audio.ctx && audio.ctx.state === 'running') {
                audio.playThunder({ distance: 0.4 + Math.random() * 0.5, gain: 0.7 });   // recorded CC0 thunder, delayed after the flash
            }
        } catch (e) { /* audio is optional */ }
    }

    _spawnArtillery() {
        const a = -0.9 + Math.random() * 1.6;
        const d = 120 + Math.random() * 60;
        const p = new THREE.Vector3(Math.sin(a) * d, 6 + Math.random() * 10, -Math.cos(a) * d);
        const s = this._glow(0xffa257, 10 + Math.random() * 10, p);
        this.artillery.push({ s, life: 0.5, max: 0.5 });
    }

    update(dt, camera) {
        this.time += dt;
        const t = this.time;

        // camera: locked composition, slow handheld drift + mouse parallax
        if (camera.fov !== CAM_FOV) { camera.fov = CAM_FOV; camera.updateProjectionMatrix(); }
        const k = 1 - Math.exp(-dt * 2.2);
        this.parallax.x += (this.mouse.x - this.parallax.x) * k;
        this.parallax.y += (this.mouse.y - this.parallax.y) * k;
        camera.position.set(
            CAM_POS.x + Math.sin(t * 0.23) * 0.035 + Math.sin(t * 0.61) * 0.012 + this.parallax.x * 0.12,
            CAM_POS.y + Math.sin(t * 0.31) * 0.02 + Math.sin(t * 0.9) * 0.006 - this.parallax.y * 0.05,
            CAM_POS.z + Math.sin(t * 0.17) * 0.05
        );
        camera.lookAt(CAM_LOOK.x + Math.sin(t * 0.19) * 0.12 + this.parallax.x * 0.35, CAM_LOOK.y + Math.sin(t * 0.27) * 0.06 - this.parallax.y * 0.18, CAM_LOOK.z);
        this.sky.position.copy(camera.position);

        // lightning
        const L = this.lightning;
        L.next -= dt;
        if (L.next <= 0) this._strike();
        let flash = 0;
        if (L.t >= 0) {
            L.t += dt;
            for (const p of L.pulses) if (L.t >= p.at) flash += p.k * Math.exp(-(L.t - p.at) * 16);
            if (L.t > 1.6) L.t = -1;
        }
        flash = Math.min(flash, 1.4);
        this.flashLight.intensity = flash * 5;
        this.hemi.intensity = 1.1 + flash * 1.4;
        for (const m of this.flashMats) m.uniforms.uFlash.value = flash;
        for (const m of this.shaders) m.uniforms.uTime.value = t;

        // practical lights
        this.campKey.intensity = 26 + Math.sin(t * 2.3) * 1.5 + Math.sin(t * 7.1) * 0.8;
        for (const g of this.glows) {
            const f = 1 + (Math.sin(t * 11 + g.seed) * 0.5 + Math.sin(t * 23.7 + g.seed * 2) * 0.5) * g.flicker;
            g.s.scale.setScalar(g.base * f);
        }
        const blink = (t % 1.6) < 0.18 ? 1 : 0;
        for (const b of this.blinkers) b.material.opacity = blink;

        // searchlight sweep
        if (this.beam) {
            const yaw = -2.35 + Math.sin(t * 0.16) * 0.75;
            const pitch = 0.1 + Math.sin(t * 0.11 + 1.3) * 0.08;
            this.beamTarget.set(
                this.beam.position.x + Math.sin(yaw) * 50,
                this.beam.position.y + Math.sin(pitch) * 50,
                this.beam.position.z + Math.cos(yaw) * 50
            );
            this.beam.lookAt(this.beamTarget);
        }

        // distant artillery flashes over the ridges
        if (Math.random() < dt * 0.22) this._spawnArtillery();
        for (let i = this.artillery.length - 1; i >= 0; i--) {
            const a = this.artillery[i];
            a.life -= dt;
            a.s.material.opacity = Math.max(0, a.life / a.max) * 0.55;
            if (a.life <= 0) { this.group.remove(a.s); a.s.material.dispose(); this.artillery.splice(i, 1); }
        }

        // canopy flutter
        this._layoutCanopy(t);

        // steam
        for (const s of this.steam) {
            const p = (t * 0.22 + s.userData.phase) % 1;
            s.position.set(this.steamOrigin.x + Math.sin(t * 1.3 + p * 6) * 0.03 * p + p * 0.05, this.steamOrigin.y + p * 0.42, this.steamOrigin.z);
            s.scale.setScalar(0.05 + p * 0.22);
            s.material.opacity = Math.sin(p * Math.PI) * 0.14;
        }

        // characters
        if (this.hero) {
            this._updateHero(dt);
            this._followBackpack();
        }
        if (this.sentry) this.sentry.update(dt, { speed: 0, look: Math.sin(t * 0.2) * 0.8 });
        if (this.sentry && Math.random() < dt * 0.08) this.sentry.talk(2 + Math.random() * 2);
        if (this.patrol) this._updatePatrol(dt);

        updateWindTime(t);

        // rain
        this.rain.update(dt, this.rainFocus);
        this.rainNear.update(dt, this.rainNearFocus);
    }

    /**
     * Unhurried patrol: accelerate smoothly, turn on the spot before setting off,
     * slow down into each waypoint and pause to glance around. The game animator
     * expects run-speed input, so it is driven at a reduced rate whose step length
     * matches the ground speed (no foot skating).
     */
    _updatePatrol(dt) {
        const P = this.patrol, root = P.c.root;
        const WALK = 1.1;
        const target = P.path[P.leg];
        const dx = target.x - root.position.x, dz = target.z - root.position.z;
        const dist = Math.hypot(dx, dz);
        const yaw = Math.atan2(dx, dz);
        let diff = Math.atan2(Math.sin(yaw - root.rotation.y), Math.cos(yaw - root.rotation.y));

        let want = WALK;
        if (P.wait > 0) {
            P.wait -= dt; want = 0;
            P.look += (P.lookGoal - P.look) * (1 - Math.exp(-dt * 1.4));
            if (P.wait < 0.01) P.look = 0;
        } else {
            want = WALK * Math.min(1, 0.25 + dist * 0.5) * (Math.abs(diff) > 0.5 ? 0.25 : 1);   // ease into waypoints and turns
            if (dist < 0.12) {
                P.leg = (P.leg + 1) % P.path.length;
                P.wait = 3 + Math.random() * 3;
                P.lookGoal = (Math.random() - 0.5) * 1.6;
                want = 0;
            } else P.look += (0 - P.look) * (1 - Math.exp(-dt * 2));
        }
        P.speed += (want - P.speed) * (1 - Math.exp(-dt * (want > P.speed ? 1.6 : 3.2)));

        // limited turn rate (rad/s), slower while standing
        const maxTurn = (P.wait > 0 ? 0.9 : 2.0) * dt;
        if (P.wait <= 0 || Math.abs(diff) > 0.6) root.rotation.y += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
        diff = Math.atan2(Math.sin(yaw - root.rotation.y), Math.cos(yaw - root.rotation.y));
        if (P.wait <= 0 && P.speed > 0.02) {
            const step = Math.min(dist, P.speed * dt * Math.max(0, Math.cos(diff)));
            root.position.x += Math.sin(root.rotation.y) * step;
            root.position.z += Math.cos(root.rotation.y) * step;
        }
        const w = P.speed / WALK;
        P.c.update(dt * 0.57, { speed: 2.3 * w, look: P.look });
    }
    dispose() {
        this.disposed = true;
        window.removeEventListener('pointermove', this._onPointer);
        this.scene.remove(this.group);
        if (this.forest) { this.forest.dispose(); this.forest = null; }
        if (this.envTex) { this.scene.environment = null; this.envTex.dispose(); }
        [this.hero, this.patrol && this.patrol.c, this.sentry].forEach(c => c && c.dispose());
        this.group.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach(m => m.dispose());
            }
        });
    }
}
