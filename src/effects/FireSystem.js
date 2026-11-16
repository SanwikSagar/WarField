import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Fire, smoke, embers and explosions rendered from real CC0 sprite flipbooks
 * (public/assets/vfx — volumetric renders from the OpenGameArt "25 special effects
 * rendered with blender" pack, CC0).
 *
 * Built for zero garbage per frame: every layer is a fixed-size struct-of-arrays pool
 * (Float32Arrays allocated once at level start), particles are spawned by writing into
 * free slots and killed by swapping the last live slot in. One instanced draw call per
 * flipbook layer plus one Points call for embers; the animation frame is picked from the
 * particle's age in the vertex shader. Scene fog applies so distant fires sit in the haze.
 */
const VERT = /* glsl */`
    attribute vec3 iPos;
    attribute vec4 iData;               // x age 0..1, y size, z seed, w alpha
    uniform float uCols, uRows, uF0, uF1, uRotate;
    uniform vec3 uRight, uUp;
    varying vec2 vUv;
    varying float vAlpha;
    #include <fog_pars_vertex>
    void main() {
        float f = floor(mix(uF0, uF1, clamp(iData.x, 0.0, 0.999)));
        float col = mod(f, uCols), row = floor(f / uCols);
        vUv = (vec2(col, uRows - 1.0 - row) + uv) / vec2(uCols, uRows);
        float a = iData.z * 6.2831 * uRotate;
        vec2 p = vec2(position.x * cos(a) - position.y * sin(a), position.x * sin(a) + position.y * cos(a));
        vec3 world = iPos + (uRight * p.x + uUp * p.y) * iData.y;
        vAlpha = iData.w;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
    }`;
const FRAG = /* glsl */`
    uniform sampler2D uMap;
    uniform vec3 uTint;
    uniform float uGain, uAlphaGain;
    varying vec2 vUv;
    varying float vAlpha;
    #include <fog_pars_fragment>
    void main() {
        vec4 t = texture2D(uMap, vUv);
        gl_FragColor = vec4(t.rgb * uTint * uGain, clamp(t.a * uAlphaGain, 0.0, 1.0) * vAlpha);
        if (gl_FragColor.a < 0.003) discard;
        #include <fog_fragment>
    }`;

const loader = new THREE.TextureLoader();
const texCache = new Map();
function atlas(name) {
    if (!texCache.has(name)) {
        const t = loader.load(`/assets/vfx/${name}.png`);
        t.colorSpace = THREE.SRGBColorSpace;
        t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
        texCache.set(name, t);
    }
    return texCache.get(name);
}

const rnd = (a, b) => a + Math.random() * (b - a);
const sstep = (a, b, x) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
// alpha envelopes by id (no closures stored per particle)
const ALPHA_FIRE = 0, ALPHA_SMOKE = 1, ALPHA_BLAST = 2;
function alphaOf(type, u) {
    if (type === ALPHA_FIRE) return sstep(0, 0.12, u) * (1 - sstep(0.55, 1, u));
    if (type === ALPHA_SMOKE) return sstep(0, 0.1, u) * (1 - sstep(0.35, 1, u));
    return sstep(0, 0.05, u) * (1 - sstep(0.5, 1, u));
}

/** Pooled flipbook layer: struct-of-arrays, fixed capacity, swap-remove, no allocation after construction. */
class Layer {
    constructor(scene, { map, cols, rows, frames = [0, 1], max = 400, additive = true, tint = 0xffffff, gain = 1, alphaGain = 1, rotate = 0, sort = false }) {
        this.max = max; this.sort = sort; this.n = 0;
        this.P = new Float32Array(max * 3); this.V = new Float32Array(max * 3);
        this.T = new Float32Array(max); this.L = new Float32Array(max);
        this.S0 = new Float32Array(max); this.S1 = new Float32Array(max); this.SEED = new Float32Array(max);
        this.K = new Float32Array(max); this.BUOY = new Float32Array(max); this.DRAG = new Float32Array(max);
        this.A = new Uint8Array(max);
        if (sort) { this.order = new Uint16Array(max); this.dist = new Float32Array(max); }
        const geo = new THREE.InstancedBufferGeometry();
        const q = new THREE.PlaneGeometry(1, 1);
        geo.index = q.index; geo.attributes.position = q.attributes.position; geo.attributes.uv = q.attributes.uv;
        this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.data = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('iPos', this.pos); geo.setAttribute('iData', this.data);
        geo.instanceCount = 0;
        this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
            uMap: { value: atlas(map) }, uCols: { value: cols }, uRows: { value: rows }, uF0: { value: frames[0] }, uF1: { value: frames[1] },
            uRotate: { value: rotate }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
            uTint: { value: new THREE.Color(tint) }, uGain: { value: gain }, uAlphaGain: { value: alphaGain }
        }]);
        this.uniforms.uMap.value = atlas(map);   // UniformsUtils.merge clones textures; keep the shared one
        this.material = new THREE.ShaderMaterial({
            uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true, transparent: true, depthWrite: false,
            blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide
        });
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 8 : 7;
        this.mesh.userData.environmentManaged = true;   // keep it out of the scenery LOD / shadow culling
        scene.add(this.mesh);
    }

    spawn(px, py, pz, vx, vy, vz, t, life, s0, s1, k, buoy, drag, alpha) {
        if (this.n >= this.max) return;
        const i = this.n++, i3 = i * 3;
        this.P[i3] = px; this.P[i3 + 1] = py; this.P[i3 + 2] = pz;
        this.V[i3] = vx; this.V[i3 + 1] = vy; this.V[i3 + 2] = vz;
        this.T[i] = t; this.L[i] = life; this.S0[i] = s0; this.S1[i] = s1; this.SEED[i] = Math.random();
        this.K[i] = k; this.BUOY[i] = buoy; this.DRAG[i] = drag; this.A[i] = alpha;
    }

    _kill(i) {
        const j = --this.n;
        if (i === j) return;
        const i3 = i * 3, j3 = j * 3;
        this.P[i3] = this.P[j3]; this.P[i3 + 1] = this.P[j3 + 1]; this.P[i3 + 2] = this.P[j3 + 2];
        this.V[i3] = this.V[j3]; this.V[i3 + 1] = this.V[j3 + 1]; this.V[i3 + 2] = this.V[j3 + 2];
        this.T[i] = this.T[j]; this.L[i] = this.L[j]; this.S0[i] = this.S0[j]; this.S1[i] = this.S1[j]; this.SEED[i] = this.SEED[j];
        this.K[i] = this.K[j]; this.BUOY[i] = this.BUOY[j]; this.DRAG[i] = this.DRAG[j]; this.A[i] = this.A[j];
    }

    /** billboard axes follow the camera every rendered frame (cheap), so turning stays smooth */
    orient(camera) {
        this.uniforms.uRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
        this.uniforms.uUp.value.setFromMatrixColumn(camera.matrixWorld, 1);
    }

    update(dt, camera) {
        this.orient(camera);
        const P = this.P, V = this.V, T = this.T, L = this.L;
        for (let i = this.n - 1; i >= 0; i--) {
            T[i] += dt;
            if (T[i] >= L[i]) { this._kill(i); continue; }
            const i3 = i * 3, damp = Math.max(0, 1 - this.DRAG[i] * dt);
            V[i3 + 1] += this.BUOY[i] * dt;
            V[i3] *= damp; V[i3 + 1] *= damp; V[i3 + 2] *= damp;
            P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
        }
        const n = this.n, pa = this.pos.array, da = this.data.array;
        let order = null;
        if (this.sort && n > 1) {
            // back-to-front for alpha-blended smoke; typed-array sort, no allocation
            const c = camera.position, D = this.dist; order = this.order;
            for (let i = 0; i < n; i++) {
                const i3 = i * 3, dx = P[i3] - c.x, dy = P[i3 + 1] - c.y, dz = P[i3 + 2] - c.z;
                D[i] = dx * dx + dy * dy + dz * dz; order[i] = i;
            }
            const view = order.subarray(0, n);
            view.sort((a, b) => D[b] - D[a]);
        }
        for (let o = 0; o < n; o++) {
            const i = order ? order[o] : o, i3 = i * 3, u = T[i] / L[i];
            pa[o * 3] = P[i3]; pa[o * 3 + 1] = P[i3 + 1]; pa[o * 3 + 2] = P[i3 + 2];
            da[o * 4] = u; da[o * 4 + 1] = this.S0[i] + (this.S1[i] - this.S0[i]) * u; da[o * 4 + 2] = this.SEED[i];
            da[o * 4 + 3] = (T[i] < 0 ? 0 : alphaOf(this.A[i], u)) * this.K[i];
        }
        if (n) { this.pos.needsUpdate = this.data.needsUpdate = true; }
        this.mesh.geometry.instanceCount = n;
    }
    get count() { return this.n; }
    dispose(scene) { scene.remove(this.mesh); this.mesh.geometry.dispose(); this.material.dispose(); }
}

export class FireSystem {
    constructor(scene, { audio = null, lights = 2 } = {}) {
        this.scene = scene; this.audio = audio;
        this.fires = []; this.columns = [];
        this.time = 0;
        this.wind = new THREE.Vector3(0.6, 0, 0.25);
        this.flame = new Layer(scene, { map: 'flame_fire', cols: 6, rows: 5, frames: [3, 28], max: 700, additive: true, gain: 1.35, alphaGain: 1.4 });
        this.smoke = new Layer(scene, { map: 'smoke_grey', cols: 6, rows: 5, frames: [2, 26], max: 500, additive: false, tint: 0x3d3731, alphaGain: 2.5, rotate: 1, sort: true });
        this.blast = new Layer(scene, { map: 'explosion_fire', cols: 6, rows: 5, frames: [0, 29], max: 40, additive: true, gain: 1.6, alphaGain: 1.5, rotate: 1 });
        this.blastSmoke = new Layer(scene, { map: 'smoke_grey', cols: 6, rows: 5, frames: [4, 28], max: 120, additive: false, tint: 0x403a33, alphaGain: 2.5, rotate: 1, sort: true });
        this.layers = [this.flame, this.smoke, this.blast, this.blastSmoke];
        // no real-time lights: fire glow on the world comes from the baked firelight (BakedLighting, B channel)
        this.lights = [];
        this._initSparks(scene);
    }

    /** Glowing embers lifted off every fire by the wind (one Points draw call, pooled). */
    _initSparks(scene) {
        const max = this.maxSparks = 240;
        this.sn = 0;
        this.sP = new Float32Array(max * 3); this.sV = new Float32Array(max * 3);
        this.sT = new Float32Array(max); this.sL = new Float32Array(max); this.sS = new Float32Array(max); this.sSeed = new Float32Array(max);
        const geo = new THREE.BufferGeometry();
        this.sparkPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
        this.sparkData = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', this.sparkPos); geo.setAttribute('aData', this.sparkData);
        geo.setDrawRange(0, 0);
        this.sparkMat = new THREE.ShaderMaterial({
            uniforms: { uScale: { value: 500 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            vertexShader: `attribute vec3 aData; uniform float uScale; varying float vA; varying float vT;
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    float fl = 0.55 + 0.45 * sin(aData.z * 40.0 + aData.x * 34.0);
                    vA = (1.0 - aData.x) * fl; vT = aData.x;
                    gl_PointSize = clamp(aData.y * uScale / max(-mv.z, 0.1), 1.0, 7.0);
                }`,
            fragmentShader: `varying float vA; varying float vT;
                void main() {
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float a = smoothstep(1.0, 0.0, d);
                    vec3 c = mix(vec3(1.0, 0.78, 0.32), vec3(1.0, 0.22, 0.04), vT);
                    gl_FragColor = vec4(c * a * vA * 2.2, a * vA);
                }`
        });
        this.sparkMesh = new THREE.Points(geo, this.sparkMat);
        this.sparkMesh.frustumCulled = false; this.sparkMesh.renderOrder = 9; this.sparkMesh.userData.environmentManaged = true;
        scene.add(this.sparkMesh);
    }

    _updateSparks(dt, camera) {
        const cam = camera.position, w = this.wind, max = this.maxSparks;
        const P = this.sP, V = this.sV, T = this.sT, L = this.sL, S = this.sS, SD = this.sSeed;
        for (let f = 0; f < this.fires.length; f++) {
            const F = this.fires[f];
            if (!F.on || F.pos.distanceToSquared(cam) > 70 * 70) continue;
            const root = Math.sqrt(F.size);
            F.accE += dt * 2.6 * root;
            while (F.accE >= 1 && this.sn < max) {
                F.accE -= 1;
                const i = this.sn++, i3 = i * 3;
                P[i3] = F.pos.x + rnd(-0.3, 0.3) * F.size; P[i3 + 1] = F.pos.y + F.size * 0.4; P[i3 + 2] = F.pos.z + rnd(-0.3, 0.3) * F.size;
                V[i3] = w.x * 0.9 + rnd(-0.7, 0.7); V[i3 + 1] = rnd(1.6, 3.8) * root; V[i3 + 2] = w.z * 0.9 + rnd(-0.7, 0.7);
                T[i] = 0; L[i] = rnd(1.1, 2.8); S[i] = rnd(0.025, 0.06); SD[i] = Math.random();
            }
            if (F.accE > 2) F.accE = 2;
        }
        const pa = this.sparkPos.array, da = this.sparkData.array, k = dt * 0.9;
        for (let i = this.sn - 1; i >= 0; i--) {
            T[i] += dt;
            if (T[i] >= L[i]) {
                const j = --this.sn;
                if (i !== j) {
                    const i3 = i * 3, j3 = j * 3;
                    P[i3] = P[j3]; P[i3 + 1] = P[j3 + 1]; P[i3 + 2] = P[j3 + 2];
                    V[i3] = V[j3]; V[i3 + 1] = V[j3 + 1]; V[i3 + 2] = V[j3 + 2];
                    T[i] = T[j]; L[i] = L[j]; S[i] = S[j]; SD[i] = SD[j];
                }
                continue;
            }
            const i3 = i * 3;
            V[i3 + 1] += 0.35 * dt; V[i3] += (w.x * 0.8 - V[i3]) * k; V[i3 + 2] += (w.z * 0.8 - V[i3 + 2]) * k;
            P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
        }
        for (let i = 0; i < this.sn; i++) {
            const i3 = i * 3;
            pa[i3] = P[i3]; pa[i3 + 1] = P[i3 + 1]; pa[i3 + 2] = P[i3 + 2];
            da[i3] = T[i] / L[i]; da[i3 + 1] = S[i]; da[i3 + 2] = SD[i];
        }
        if (this.sn) this.sparkPos.needsUpdate = this.sparkData.needsUpdate = true;
        this.sparkMesh.geometry.setDrawRange(0, this.sn);
        this.sparkMat.uniforms.uScale.value = (window.innerHeight * 0.5) * (camera.projectionMatrix ? camera.projectionMatrix.elements[5] : 1.7);
    }

    get sparks() { return { length: this.sn }; }

    /** A burning spot (wreck, barrel, window, campfire). size ~1 = barrel, 2 = car engine, 4 = building. */
    addFire({ x, y, z, size = 1, smoke = 1, light = true, sound = true }) {
        const f = { pos: new THREE.Vector3(x, y, z), size, smoke, light, sound, acc: Math.random(), accS: Math.random(), accE: 0, phase: Math.random() * 10, on: true, d: 0 };
        this.fires.push(f);
        return f;
    }

    /** Tall distant smoke plume (burning districts on the skyline). */
    addColumn({ x, y = 0, z, width = 14, rate = 1.6, life = 16, rise = 3.2 }) {
        const c = { pos: new THREE.Vector3(x, y, z), width, rate, life, rise, acc: Math.random() };
        this.columns.push(c);
        return c;
    }

    /** One-shot explosion: fireball + shock smoke. scale ~1 = grenade, 3 = vehicle. */
    explode(pos, scale = 1, flash = true) {
        const n = Math.round(4 + scale * 3);
        for (let i = 0; i < n; i++) {
            const d = rnd(0.3, 1) * scale;
            this.blast.spawn(pos.x + rnd(-1, 1) * d, pos.y + rnd(0, 1) * d * 0.8, pos.z + rnd(-1, 1) * d,
                rnd(-1, 1) * scale, rnd(0.5, 2) * scale, rnd(-1, 1) * scale,
                -rnd(0, 0.15), rnd(0.9, 1.3), scale * rnd(1.6, 2.4), scale * rnd(3.4, 5), 1, 1, 1.2, ALPHA_BLAST);
        }
        for (let i = 0; i < n + 4; i++) {
            this.blastSmoke.spawn(pos.x + rnd(-1, 1) * scale, pos.y + rnd(0, 1.5) * scale, pos.z + rnd(-1, 1) * scale,
                rnd(-1, 1) * scale * 0.6, rnd(1, 2.5) * scale, rnd(-1, 1) * scale * 0.6,
                -rnd(0, 0.3), rnd(6, 10), scale * 3, scale * rnd(9, 15), 0.8, 0.4, 0.5, ALPHA_SMOKE);
        }
    }

    update(dt, camera) {
        // ambient particles simulate at a fixed 30 Hz (half the CPU and buffer uploads at 60 fps);
        // in between, only the billboard orientation is refreshed
        this._acc = (this._acc || 0) + Math.min(dt, 0.1);
        if (this._acc < 1 / 30) { for (let i = 0; i < this.layers.length; i++) this.layers[i].orient(camera); return; }
        dt = Math.min(this._acc, 0.1); this._acc = 0;
        this.time += dt;
        const cam = camera.position, w = this.wind;
        for (let fi = 0; fi < this.fires.length; fi++) {
            const f = this.fires[fi];
            if (!f.on) continue;
            const dist2 = f.pos.distanceToSquared(cam);
            if (dist2 > 140 * 140) continue;
            const lod = dist2 > 60 * 60 ? 0.45 : 1;            // thinner far fires
            f.acc += dt * 16 * f.size * lod;
            while (f.acc >= 1) {
                f.acc -= 1;
                const r = 0.22 * f.size;
                this.flame.spawn(f.pos.x + rnd(-r, r), f.pos.y, f.pos.z + rnd(-r, r),
                    w.x * 0.25 + rnd(-0.25, 0.25), rnd(0.7, 1.3) * f.size, w.z * 0.25 + rnd(-0.25, 0.25),
                    0, rnd(0.8, 1.3), f.size * rnd(0.9, 1.2), f.size * rnd(1.6, 2.1), 1, 0.4, 0.3, ALPHA_FIRE);
            }
            if (f.smoke > 0) {
                f.accS += dt * 2.4 * f.smoke * f.size * lod;
                while (f.accS >= 1) {
                    f.accS -= 1;
                    this.smoke.spawn(f.pos.x + rnd(-0.3, 0.3) * f.size, f.pos.y + f.size * 1.1, f.pos.z + rnd(-0.3, 0.3) * f.size,
                        w.x + rnd(-0.3, 0.3), rnd(1.3, 2.2), w.z + rnd(-0.3, 0.3),
                        0, rnd(8, 12), f.size * 2.4, f.size * rnd(10, 14), 0.7, 0.06, 0.1, ALPHA_SMOKE);
                }
            }
        }
        for (let ci = 0; ci < this.columns.length; ci++) {
            const c = this.columns[ci];
            c.acc += dt * c.rate;
            while (c.acc >= 1) {
                c.acc -= 1;
                this.smoke.spawn(c.pos.x + rnd(-1, 1) * c.width * 0.15, c.pos.y, c.pos.z + rnd(-1, 1) * c.width * 0.15,
                    w.x * 1.6, c.rise * rnd(0.8, 1.2), w.z * 1.6,
                    0, c.life, c.width * 0.9, c.width * 3.4, 0.75, 0, 0.02, ALPHA_SMOKE);
            }
        }
        for (let i = 0; i < this.layers.length; i++) this.layers[i].update(dt, camera);
        this._updateSparks(dt, camera);
        this._updateSound(cam);
    }

    _updateSound(cam) {
        if (!this.audio || !this.audio.setFireLoop) return;
        let best = null, bd = 28 * 28;
        for (let i = 0; i < this.fires.length; i++) {
            const f = this.fires[i];
            if (!f.on || !f.sound) continue;
            const d = f.pos.distanceToSquared(cam);
            if (d < bd) { bd = d; best = f; }
        }
        this.audio.setFireLoop(best ? best.pos : null, best ? best.size : 0);
    }

    dispose() {
        this.layers.forEach(l => l.dispose(this.scene));
        this.scene.remove(this.sparkMesh); this.sparkMesh.geometry.dispose(); this.sparkMat.dispose();
        if (this.audio && this.audio.setFireLoop) this.audio.setFireLoop(null, 0);
        this.fires.length = this.columns.length = 0;
    }
}
