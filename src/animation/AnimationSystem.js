import * as THREE from '/node_modules/three/build/three.module.js';
import { BlobShadows } from '../render/BlobShadows.js';
import { occlusion } from '../render/Occlusion.js';
import { CorpseBatch } from '../effects/Corpses.js';
import { FireSystem } from '../effects/FireSystem.js';

/**
 * Central animation system. One object owns every moving thing in a level and is
 * ticked once per frame from Game, so all five levels animate the same way:
 *
 *  Characters   Soldiers (enemy + squad) register their rig here. The system feeds each
 *               one the same derived motion data — speed, acceleration, turn rate and
 *               ground slope — so every gait leans into turns, braces on slopes and
 *               pushes off when accelerating, and triggers footsteps in time with the
 *               stride phase. Distant characters update at a lower rate (LOD).
 *  World        Fire, smoke and explosions (FireSystem), scanning gun turrets, blinking
 *               tower beacons, drifting wind, and distant artillery strikes with the
 *               flash and the rumble kept in sync (light first, sound after the delay).
 *
 * Owners keep deciding *what* a character does (AI, squad logic); this decides *how*
 * it moves.
 */
const _cam = new THREE.Vector3();
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();
const _camProxy = { position: _cam, matrixWorld: null, projectionMatrix: null };
const clamp = THREE.MathUtils.clamp;
const rnd = (a, b) => a + Math.random() * (b - a);

export class AnimationSystem {
    constructor() {
        this.actors = new Map();
        this.fire = null;
        this.turrets = [];
        this.blinkers = [];
        this.time = 0;
        this.scene = null;
        this._stepsThisFrame = 0;
    }

    /** Called once after the level is built and before any character is created. */
    beginLevel({ scene, level, audio, heightAt, surface = 'dirt', lights = 2 }) {
        this.endLevel();
        this.scene = scene; this.audio = audio; this.heightAt = heightAt; this.surface = surface;
        this.bounds = level.bounds || 90;
        this.fire = new FireSystem(scene, { audio, lights });
        this.blobs = new BlobShadows(scene);          // characters' contact shadows (no real-time shadow pass)
        this.corpses = new CorpseBatch(scene);        // the dead stay, baked into a few static draws
        this.blobExtra = [];                          // civilians etc. that want a contact shadow too
        const war = level.war;
        if (war) {
            war.fires.forEach(f => this.fire.addFire({ x: f.x, y: f.y, z: f.z, size: f.size, smoke: f.smoke }));
            war.columns.forEach(c => this.fire.addColumn({ x: c.x, y: heightAt ? heightAt(c.x, c.z) : 0, z: c.z, width: c.width }));
            this.turrets = war.turrets.slice();
            if (war.blinkers.length) this._makeBlinkers(war.blinkers);
            this._blast = war.blasts ? { min: war.blasts[0], max: war.blasts[1], t: rnd(6, war.blasts[0]) } : null;
        }
    }

    endLevel() {
        if (this.fire) { this.fire.dispose(); this.fire = null; }
        if (this.blobs) { this.blobs.dispose(); this.blobs = null; }
        if (this.corpses) { this.corpses.dispose(); this.corpses = null; }
        this.blobExtra = [];
        this.blinkers.forEach(b => { if (b.sprite.parent) b.sprite.parent.remove(b.sprite); b.sprite.material.dispose(); });
        if (this._blinkTex) { this._blinkTex.dispose(); this._blinkTex = null; }
        this.blinkers = []; this.turrets = []; this.actors.clear(); this._blast = null;
    }

    // ── characters ─────────────────────────────────────────────────────
    /** char = createCharacter() result, group = the Object3D that moves, getState = () => anim state. */
    addActor(char, { group, getState }) {
        if (this.heightAt && 'groundAt' in char) char.groundAt = this.heightAt;      // foot IK on the real terrain
        this.actors.set(char, { char, group, getState, acc: 0, prevSpeed: 0, prevYaw: group.rotation.y, lastStep: 0, wasMoving: false });
    }
    removeActor(char) { this.actors.delete(char); }

    _updateActors(dt, camPos, camera) {
        this._stepsThisFrame = 0;
        if (camera && camera.projectionMatrix) _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        let culled = 0;
        for (const a of this.actors.values()) {
            const g = a.group;
            const d2 = g.position.distanceToSquared(camPos);
            a.acc += dt;
            // frustum + occlusion culling: hidden soldiers are not drawn, and only re-posed twice a second
            _sph.center.set(g.position.x, g.position.y + 0.95, g.position.z); _sph.radius = 1.25;
            const seen = !camera || d2 < 4 * 4 || (_frustum.intersectsSphere(_sph) && occlusion.testSphere(_sph.center.x, _sph.center.y, _sph.center.z, 1.0));
            if (g.userData.cullVisible !== seen) { g.userData.cullVisible = seen; g.visible = seen && !g.userData.hidden; }
            if (!seen) culled++;
            const interval = !seen ? 0.5 : d2 > 85 * 85 ? 0.1 : d2 > 42 * 42 ? 0.045 : 0;   // far soldiers animate at a lower rate
            if (a.acc < interval) continue;
            const step = a.acc; a.acc = 0;
            const s = a.getState() || {};
            a.dead = !!s.dead;
            s.ik = seen && d2 < 28 * 28;                    // foot IK only where you can see the feet
            // motion derived once, here, so every actor of every level uses identical data
            const speed = s.speed || 0;
            let dy = g.rotation.y - a.prevYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
            s.turn = clamp(dy / step, -5, 5);
            s.accel = clamp((speed - a.prevSpeed) / step, -8, 8);
            a.prevYaw = g.rotation.y; a.prevSpeed = speed;
            if (this.heightAt && !s.dead && speed > 0.2) {
                const yaw = g.rotation.y, fx = Math.sin(yaw) * 0.7, fz = Math.cos(yaw) * 0.7;
                s.slope = clamp((this.heightAt(g.position.x + fx, g.position.z + fz) - this.heightAt(g.position.x - fx, g.position.z - fz)) / 1.4, -0.8, 0.8);
            } else s.slope = 0;
            a.char.update(step, s);
            // footsteps land with the stride (each half cycle is one foot strike)
            if (!s.dead && speed > 0.7 && a.char.phase !== undefined) {
                const k = Math.floor(a.char.phase / Math.PI);
                if (k !== a.lastStep) {
                    a.lastStep = k;
                    if (d2 < 30 * 30 && this._stepsThisFrame < 3 && this.audio && this.audio.playFootstep) {
                        this._stepsThisFrame++;
                        const att = 1 - Math.sqrt(d2) / 30;
                        this.audio.playFootstep(this.surface, 0.3 * att * att * clamp(speed / 3, 0.5, 1.2));
                    }
                }
            }
        }
    }

    // ── world ──────────────────────────────────────────────────────────
    _makeBlinkers(list) {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, 'rgba(255,60,40,1)'); g.addColorStop(0.25, 'rgba(255,40,30,0.7)'); g.addColorStop(1, 'rgba(255,30,20,0)');
        x.fillStyle = g; x.fillRect(0, 0, 64, 64);
        const tex = this._blinkTex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
        list.forEach((p, i) => {
            const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
            const sprite = new THREE.Sprite(m);
            sprite.position.set(p.x, p.y, p.z); sprite.scale.setScalar(1.6);
            sprite.userData.environmentManaged = true;
            this.scene.add(sprite);
            this.blinkers.push({ sprite, phase: i * 0.7 });
        });
    }

    _distantBlast(camPos) {
        const a = Math.random() * Math.PI * 2, R = this.bounds + rnd(25, 60);
        const pos = new THREE.Vector3(Math.cos(a) * R, rnd(3, 22), Math.sin(a) * R);
        const scale = rnd(5, 9);
        this.fire.explode(pos, scale, false);
        if (this.audio && this.audio._playSample) {
            const dist = pos.distanceTo(camPos);
            this.audio._playSample('distant_blast', { gain: rnd(0.55, 0.85), rate: rnd(0.9, 1.05), dist: 0.85, reverb: 0.7, delay: clamp(dist / 120, 0.4, 2.2), bus: 'ambience' });
            this.audio._duckAmbience && this.audio._duckAmbience(0.7, 1.2);
        }
    }

    /** Per-frame tick. camera = whichever camera is rendering (gameplay or cinematic). */
    update(dt, camera) {
        dt = Math.min(dt, 0.05);
        this.time += dt;
        // the gameplay camera is parented under the player rig: use its world position, not its local one
        camera.updateWorldMatrix(true, false);
        const camPos = camera.getWorldPosition(_cam);
        _camProxy.matrixWorld = camera.matrixWorld;
        _camProxy.projectionMatrix = camera.projectionMatrix;
        this._updateActors(dt, camPos, camera);
        if (this.blobs) this.blobs.update(this.actors.values(), camPos, this.blobExtra);
        if (this.corpses) this.corpses.update();
        if (!this.fire) return;
        const t = this.time;
        this.fire.wind.set(0.7 + 0.5 * Math.sin(t * 0.11), 0, 0.25 + 0.3 * Math.sin(t * 0.07 + 1));
        this.fire.update(dt, _camProxy);
        for (const tr of this.turrets) tr.node.rotation.y = Math.sin(t * 0.32 + tr.phase) * 0.9;
        for (const b of this.blinkers) {
            const on = ((t * 0.8 + b.phase) % 2) < 0.18;
            b.sprite.material.opacity += ((on ? 1 : 0.06) - b.sprite.material.opacity) * Math.min(1, dt * 18);
        }
        if (this._blast) {
            this._blast.t -= dt;
            if (this._blast.t <= 0) { this._distantBlast(camPos); this._blast.t = rnd(this._blast.min, this._blast.max); }
        }
        if (this.audio && this.audio.setListener) this.audio.setListener(camera);
    }
}

export const animation = new AnimationSystem();
