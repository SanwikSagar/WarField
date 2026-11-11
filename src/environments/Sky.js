import * as THREE from 'three';

/**
 * Procedural sky dome + sun/hemisphere lighting rig.
 *  - Gradient sky with soft fbm clouds, a sun disc/glow, and a horizon that is
 *    blended into the scene fog colour so the world never has a hard edge.
 *  - The dome is also baked once into a PMREM environment map so PBR
 *    materials (metal, wet ground, vehicles) get realistic sky reflections and
 *    ambient light for free - the single biggest "looks real" upgrade.
 */
export class Sky {
    constructor(scene, palette = {}, opts = {}) {
        this.scene = scene;
        const p = {
            top: new THREE.Color(palette.top ?? 0x4a6a9a),
            horizon: new THREE.Color(palette.horizon ?? 0xa9b8c8),
            ground: new THREE.Color(palette.ground ?? 0x3a3a34),
            sunColor: new THREE.Color(palette.sunColor ?? 0xfff2d8),
            sunIntensity: palette.sunIntensity ?? 2.4,
            sunPosition: palette.sunPosition ?? new THREE.Vector3(120, 90, 60),
            hemiSky: new THREE.Color(palette.hemiSky ?? 0xa8bcd8),
            hemiGround: new THREE.Color(palette.hemiGround ?? 0x55503f),
            hemiIntensity: palette.hemiIntensity ?? 1.0,
            fogColor: new THREE.Color(palette.fogColor ?? 0xa9b8c8),
            fogDensity: opts.fogDensity ?? palette.fogDensity ?? 0.01,
            cloud: palette.cloud ?? 0.55,
            cloudColor: new THREE.Color(palette.cloudColor ?? 0xe6ebf0),
            cloudShade: new THREE.Color(palette.cloudShade ?? 0x8b97a6),
            envIntensity: palette.envIntensity ?? 0.7,
            shadowSize: opts.shadowExtent ?? 60
        };
        this.palette = p;
        this.time = 0;
        this.shadowInterval = opts.shadowInterval ?? 0.066;
        this.shadowDistance = opts.shadowDistance ?? p.shadowSize * 0.85;
        this.shadowElapsed = Infinity;
        this.shadowFocus = new THREE.Vector3();
        this.hasShadowFocus = false;

        this._buildDome(p);
        if (opts.renderDistance) this.dome.scale.setScalar(Math.min(1, opts.renderDistance * 0.92 / 900));
        this._buildLights(p);
        scene.fog = new THREE.FogExp2(p.fogColor.getHex(), p.fogDensity);
        if (opts.renderer) this._bakeEnvironment(opts.renderer, p);
    }

    _buildDome(p) {
        const geo = new THREE.SphereGeometry(900, 32, 20);
        this.uniforms = {
            uTop: { value: p.top },
            uHorizon: { value: p.horizon },
            uGround: { value: p.ground },
            uFog: { value: p.fogColor },
            uSunDir: { value: p.sunPosition.clone().normalize() },
            uSunColor: { value: p.sunColor },
            uCloud: { value: p.cloud },
            uCloudColor: { value: p.cloudColor },
            uCloudShade: { value: p.cloudShade },
            uTime: { value: 0 }
        };
        this.domeMaterial = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,
            uniforms: this.uniforms,
            vertexShader: /* glsl */`
                varying vec3 vDir;
                void main() {
                    vDir = normalize(position);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uTop, uHorizon, uGround, uFog, uSunDir, uSunColor, uCloudColor, uCloudShade;
                uniform float uCloud, uTime;
                varying vec3 vDir;

                float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                float vnoise(vec2 p) {
                    vec2 i = floor(p), f = fract(p);
                    f = f * f * (3.0 - 2.0 * f);
                    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
                }
                float fbm(vec2 p) {
                    float a = 0.5, s = 0.0;
                    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
                    return s;
                }

                void main() {
                    vec3 d = normalize(vDir);
                    float h = d.y;
                    vec3 col;
                    if (h > 0.0) col = mix(uHorizon, uTop, pow(h, 0.55));
                    else col = mix(uHorizon, uGround, pow(-h, 0.5));

                    // Clouds on a flat layer above the viewer
                    if (h > 0.0) {
                        vec2 cuv = d.xz / (h + 0.22) * 1.35 + vec2(uTime * 0.004, uTime * 0.0015);
                        float n = fbm(cuv);
                        float cov = smoothstep(1.0 - uCloud * 0.85, 1.0 - uCloud * 0.85 + 0.35, n);
                        float sunSide = clamp(dot(d, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0);
                        vec3 cc = mix(uCloudShade, uCloudColor, 0.35 + 0.65 * sunSide * (1.0 - n * 0.4));
                        col = mix(col, cc, cov * smoothstep(0.0, 0.18, h));
                    }

                    float sun = max(dot(d, normalize(uSunDir)), 0.0);
                    col += uSunColor * pow(sun, 700.0) * 3.0;      // disc
                    col += uSunColor * pow(sun, 24.0) * 0.45;      // glow
                    col += uSunColor * pow(sun, 4.0) * 0.10;

                    // Blend the horizon into the fog colour so there is no seam
                    col = mix(uFog, col, smoothstep(-0.02, 0.28, h));
                    gl_FragColor = vec4(col, 1.0);
                }
            `
        });
        this.dome = new THREE.Mesh(geo, this.domeMaterial);
        this.dome.frustumCulled = false;
        this.dome.renderOrder = -10;
        this.scene.add(this.dome);
    }

    _buildLights(p) {
        this.hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity);
        this.scene.add(this.hemi);

        this.sun = new THREE.DirectionalLight(p.sunColor, p.sunIntensity);
        this.sun.position.copy(p.sunPosition);
        this.sun.castShadow = true;
        this.sun.shadow.autoUpdate = false;
        this.sun.shadow.needsUpdate = true;
        this.sun.shadow.mapSize.set(2048, 2048);
        const d = p.shadowSize;
        this.sun.shadow.camera.left = -d;
        this.sun.shadow.camera.right = d;
        this.sun.shadow.camera.top = d;
        this.sun.shadow.camera.bottom = -d;
        const sunDistance = p.sunPosition.length();
        this.sun.shadow.camera.near = Math.max(1, sunDistance - d - 35);
        this.sun.shadow.camera.far = sunDistance + d + 35;
        this.sun.shadow.bias = -0.0005;
        this.sun.shadow.normalBias = 0.04;
        this.scene.add(this.sun);
        this.scene.add(this.sun.target);

        // Cool bounce fill from the opposite side so shadowed faces keep form
        this.fill = new THREE.DirectionalLight(0x9fb4d0, 0.45);
        this.fill.position.set(-80, 50, -40);
        this.scene.add(this.fill);
    }

    _bakeEnvironment(renderer, p) {
        try {
            const envScene = new THREE.Scene();
            envScene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 32, 20), this.domeMaterial));
            const pm = new THREE.PMREMGenerator(renderer);
            this.envTarget = pm.fromScene(envScene, 0, 1, 2000);
            pm.dispose();
            this.scene.environment = this.envTarget.texture;
            this.scene.environmentIntensity = p.envIntensity;
        } catch (e) {
            console.warn('Environment bake skipped:', e);
        }
    }

    /** Replace the procedural dome by a real photographic HDRI sky + matching IBL, fog and sun. */
    applyHDR(hdr, info, opts) {
        this.hdrActive = true;
        const bg = opts.bg ?? 0.8;
        this.scene.background = hdr;
        this.scene.backgroundIntensity = bg;
        this.dome.visible = false;
        try {
            const pm = new THREE.PMREMGenerator(opts.renderer);
            if (this.envTarget) this.envTarget.dispose();
            this.envTarget = pm.fromEquirectangular(hdr);
            pm.dispose();
            this.scene.environment = this.envTarget.texture;
            this.scene.environmentIntensity = this.palette.envIntensity;
        } catch (e) { console.warn('HDRI environment failed:', e); }
        // fog fades into the actual sky colour at the horizon
        const fog = info.horizon.clone().multiplyScalar(bg * (opts.fogMul ?? 1));
        this.palette.fogColor.copy(fog);
        if (this.scene.fog) this.scene.fog.color.copy(fog);
        if (opts.useSun && info.sun) {
            this.palette.sunPosition.copy(info.sun).multiplyScalar(170);
            this.sun.position.copy(this.palette.sunPosition);
        }
    }

    update(dt) {
        this.time += dt;
        this.uniforms.uTime.value = this.time;
        this.shadowElapsed += dt;
        if (this.shadowElapsed >= this.shadowInterval) {
            this.shadowElapsed = 0;
            this.sun.shadow.needsUpdate = true;
            if (this.hasShadowFocus) this.scene.traverseVisible(object => {
                if (!object.isMesh || object.userData.environmentManaged) return;
                if (object.userData.shadowSource === undefined) object.userData.shadowSource = object.castShadow;
                if (!object.userData.shadowSource) return;
                const matrix = object.matrixWorld.elements;
                object.castShadow = (matrix[12] - this.shadowFocus.x) ** 2 + (matrix[14] - this.shadowFocus.z) ** 2 < this.shadowDistance ** 2;
            });
        }
    }

    /** Keep the sun's shadow frustum centred on the player. */
    follow(targetPos) {
        if (!this.sun || !targetPos) return;
        this.shadowFocus.copy(targetPos);
        this.hasShadowFocus = true;
        this.dome.position.copy(targetPos);
        if (!this.sun.shadow.needsUpdate) return;
        const texel = this.palette.shadowSize * 2 / this.sun.shadow.mapSize.x;
        this.sun.target.position.set(Math.round(targetPos.x / texel) * texel, targetPos.y, Math.round(targetPos.z / texel) * texel);
        this.sun.position.copy(this.sun.target.position).add(this.palette.sunPosition);
        this.sun.target.updateMatrixWorld();
    }

    setShadowMapSize(size) {
        if (this.sun) {
            this.sun.shadow.mapSize.set(size, size);
            this.sun.shadow.needsUpdate = true;
            if (this.sun.shadow.map) {
                this.sun.shadow.map.dispose();
                this.sun.shadow.map = null;
            }
        }
    }

    dispose() {
        this.scene.traverse(object => {
            if (object.userData.shadowSource === undefined) return;
            object.castShadow = object.userData.shadowSource;
            delete object.userData.shadowSource;
        });
        this.scene.remove(this.dome, this.hemi, this.sun, this.sun.target, this.fill);
        this.dome.geometry.dispose();
        this.domeMaterial.dispose();
        if (this.hdrActive) this.scene.background = null;
        if (this.envTarget) { this.envTarget.dispose(); this.scene.environment = null; }
        this.scene.fog = null;
    }
}
