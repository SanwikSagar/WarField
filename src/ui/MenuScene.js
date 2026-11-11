import * as THREE from 'three';
import { TextureFactory } from '../utils/TextureFactory.js';
import { Weather } from '../environments/Weather.js';

/**
 * Cinematic main-menu backdrop (GDD 10.4 — "cinematic background featuring
 * one of the game's environments"). A moody Wildlands diorama: heavy rain,
 * drifting fog, silhouetted conifers, a low amber key light, and occasional
 * distant muzzle flashes. The camera drifts slowly on a fixed path so the
 * menu always has a living, atmospheric background. Rendered through the
 * same composer as gameplay for consistent grading.
 */
export class MenuScene {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);
        this.time = 0;
        this.flashes = [];
        this._build();
    }

    _build() {
        // Fog + background
        this.scene.background = new THREE.Color(0x0a0e14);
        this.scene.fog = new THREE.FogExp2(0x0e141c, 0.028);

        // Lighting: cold moonlight key + warm practical fill
        const hemi = new THREE.HemisphereLight(0x3a4a63, 0x0a0c10, 0.7);
        this.group.add(hemi);

        const moon = new THREE.DirectionalLight(0x8fa8cc, 1.4);
        moon.position.set(-40, 60, -30);
        moon.castShadow = true;
        moon.shadow.mapSize.set(1024, 1024);
        moon.shadow.camera.left = -60;
        moon.shadow.camera.right = 60;
        moon.shadow.camera.top = 60;
        moon.shadow.camera.bottom = -60;
        moon.shadow.bias = -0.001;
        this.group.add(moon);

        const warm = new THREE.PointLight(0xe8a33d, 2.5, 40, 2);
        warm.position.set(8, 4, -6);
        this.group.add(warm);
        this.warmLight = warm;

        // Wet ground
        const groundTex = TextureFactory.ground(512, 30);
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(300, 300),
            new THREE.MeshStandardMaterial({
                color: 0x1a2018, map: groundTex.map, normalMap: groundTex.normalMap,
                roughness: 0.55, metalness: 0.15  // wet sheen
            })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.group.add(ground);

        // Silhouetted conifer forest (instanced)
        this._buildForest();

        // Rain
        this._buildRain();

        // Distant tree-line fog plane for depth
        this._buildFogPlanes();

        // A wrecked vehicle silhouette for foreground interest
        this._buildWreck();

        // Camera drift path
        this.camRadius = 26;
        this.camHeight = 5;
    }

    _buildForest() {
        const count = 260;
        const trunkGeo = new THREE.CylinderGeometry(0.3, 0.5, 9, 5);
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x14181a, roughness: 1 });
        const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
        const leafGeo = new THREE.ConeGeometry(3.4, 7, 6);
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x11191a, roughness: 1, flatShading: true });
        const leaves = new THREE.InstancedMesh(leafGeo, leafMat, count * 2);
        trunks.castShadow = false;
        leaves.castShadow = false;

        const dummy = new THREE.Object3D();
        let li = 0;
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 18 + Math.random() * 90;
            const x = Math.cos(angle) * dist;
            const z = Math.sin(angle) * dist;
            const s = 0.7 + Math.random() * 1.1;
            dummy.position.set(x, 4.5 * s, z);
            dummy.rotation.set(0, Math.random() * Math.PI, 0);
            dummy.scale.set(s, s, s);
            dummy.updateMatrix();
            trunks.setMatrixAt(i, dummy.matrix);
            for (let l = 0; l < 2; l++) {
                dummy.position.set(x, (8 + l * 3.2) * s, z);
                dummy.scale.set(s * (1 - l * 0.25), s, s * (1 - l * 0.25));
                dummy.updateMatrix();
                leaves.setMatrixAt(li++, dummy.matrix);
            }
        }
        trunks.instanceMatrix.needsUpdate = true;
        leaves.instanceMatrix.needsUpdate = true;
        this.group.add(trunks, leaves);
    }

    _buildRain() {
        // GPU-driven streaks: no per-frame CPU work, one draw call.
        this.rain = new Weather({ kind: 'rain', count: 1100, speed: 24, color: 0xaebfd0, opacity: 0.4, streak: 1.0, area: 60, height: 36 });
        this.group.add(this.rain.object);
    }

    _buildFogPlanes() {
        const fogTex = TextureFactory.radialGradient(256, 'rgba(120,140,170,0.5)', 'rgba(120,140,170,0)');
        for (let i = 0; i < 6; i++) {
            const plane = new THREE.Mesh(
                new THREE.PlaneGeometry(80, 30),
                new THREE.MeshBasicMaterial({ map: fogTex, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending })
            );
            const a = (i / 6) * Math.PI * 2;
            plane.position.set(Math.cos(a) * 50, 8, Math.sin(a) * 50);
            plane.lookAt(0, 8, 0);
            this.group.add(plane);
        }
    }

    _buildWreck() {
        const g = new THREE.Group();
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a2d24, roughness: 0.8, metalness: 0.4 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7, metalness: 0.6 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1, 5), bodyMat);
        body.position.y = 1.1;
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 0.9, 1.8), bodyMat);
        cab.position.set(0, 1.9, 1.2);
        body.castShadow = cab.castShadow = true;
        const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 10);
        [[-1, 1.6], [1, 1.6], [-1, -1.5], [1, -1.5]].forEach(([wx, wz]) => {
            const w = new THREE.Mesh(wheelGeo, dark);
            w.rotation.z = Math.PI / 2;
            w.position.set(wx, 0.55, wz);
            g.add(w);
        });
        g.add(body, cab);
        g.position.set(10, 0, -4);
        g.rotation.y = -0.5;
        g.rotation.z = 0.06;
        this.group.add(g);
    }

    /** Trigger an occasional distant muzzle flash for atmosphere. */
    _spawnFlash() {
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 40;
        const pos = new THREE.Vector3(Math.cos(angle) * dist, 3 + Math.random() * 6, Math.sin(angle) * dist);
        const light = new THREE.PointLight(0xffaa55, 6, 50, 2);
        light.position.copy(pos);
        this.group.add(light);
        this.flashes.push({ light, life: 0.12 });
    }

    update(dt, camera) {
        this.time += dt;

        // Slow cinematic camera drift
        const a = this.time * 0.06;
        camera.position.set(
            Math.cos(a) * this.camRadius,
            this.camHeight + Math.sin(this.time * 0.3) * 0.6,
            Math.sin(a) * this.camRadius
        );
        camera.lookAt(0, 3.5, 0);

        // Rain (all motion is in the vertex shader)
        if (this.rain) this.rain.update(dt, camera.position);

        // Warm light flicker
        if (this.warmLight) this.warmLight.intensity = 2.2 + Math.sin(this.time * 3) * 0.4;

        // Random distant flashes
        if (Math.random() < dt * 0.4) this._spawnFlash();
        for (let i = this.flashes.length - 1; i >= 0; i--) {
            const f = this.flashes[i];
            f.life -= dt;
            f.light.intensity = Math.max(0, f.life / 0.12) * 6;
            if (f.life <= 0) { this.group.remove(f.light); this.flashes.splice(i, 1); }
        }
    }

    dispose() {
        this.scene.remove(this.group);
        this.group.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach(m => m.dispose());
            }
        });
    }
}
