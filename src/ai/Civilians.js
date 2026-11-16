import * as THREE from '/node_modules/three/build/three.module.js';
import { clone as skeletonClone } from '/node_modules/three/examples/jsm/utils/SkeletonUtils.js';
import { makeGLTFLoader } from '../environments/AssetLoaders.js';
import { globalEvents } from '../core/EventManager.js';
import { createCharacter } from '../core/CharacterFactory.js';
import { animation } from '../animation/AnimationSystem.js';
import { occlusion } from '../render/Occlusion.js';
import { assetUrl } from '../utils/assetUrl.js';

/**
 * Civilians, medics and the dead.
 *
 * Live civilians are CC0 Quaternius characters (public/assets/models/civilians) animated with their
 * own keyframed clips through one AnimationMixer each (cross-faded): huddled survivors, a survivor
 * waving for help, medics at the ambulance, people fleeing down the far streets, and, once the
 * player reaches them, survivors who follow the player to the checkpoint.
 * Clothing is re-tinted from a small shared palette (worn, dusty colours; shared materials).
 * Hidden civilians (frustum + occlusion) are not drawn and only animate twice a second.
 *
 * Bodies (civilians and soldiers) are posed once (the Death clip's last frame, or the soldier rig's
 * death pose lying on the ground), baked into the static CorpseBatch and the poser is thrown away.
 */
const MODELS = { man: { file: 'civ_man', height: 1.78 }, woman: { file: 'civ_woman', height: 1.68 }, man2: { file: 'civ_man2', height: 1.76 } };
const T = {};
const loading = new Map();

const clipName = (n) => n.replace(/^.*\|/, '').replace(/^(Female|Man)_/, '');

export function loadCivilians(keys = Object.keys(MODELS)) {
    const L = makeGLTFLoader();
    return Promise.all([...new Set(keys)].filter(key => MODELS[key]).map(key => {
        if (T[key]) return Promise.resolve(T[key]);
        if (loading.has(key)) return loading.get(key);
        const m = MODELS[key];
        const promise = L.loadAsync(assetUrl(`/assets/models/civilians/${m.file}.glb`))
            .then(g => {
                g.scene.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(g.scene);
                const clips = {};
                for (const c of g.animations) clips[clipName(c.name)] = c;
                T[key] = { scene: g.scene, clips, scale: m.height / Math.max(0.1, box.max.y - box.min.y), offsetY: -box.min.y };
                return T[key];
            })
            .catch(e => { console.warn('Civilian model failed:', key, e); return null; })
            .finally(() => loading.delete(key));
        loading.set(key, promise);
        return promise;
    }));
}

export function trimCivilianModels(keys = []) {
    const keep = new Set(keys.filter(key => MODELS[key]));
    const removed = [];
    for (const key of Object.keys(MODELS)) {
        if (keep.has(key) || !T[key]) continue;
        removed.push(T[key].scene);
        delete T[key];
    }

    const retainedGeometries = new Set();
    const retainedMaterials = new Set();
    const retainedTextures = new Set();
    for (const key of Object.keys(MODELS)) {
        if (!T[key]) continue;
        T[key].scene.traverse(o => {
            if (!o.isMesh) return;
            retainedGeometries.add(o.geometry);
            for (const material of (Array.isArray(o.material) ? o.material : [o.material])) {
                retainedMaterials.add(material);
                collectTextures(material, retainedTextures);
            }
        });
    }

    const removedGeometries = new Set();
    const removedMaterials = new Set();
    const removedTextures = new Set();
    for (const scene of removed) {
        scene.traverse(o => {
            if (!o.isMesh) return;
            removedGeometries.add(o.geometry);
            for (const material of (Array.isArray(o.material) ? o.material : [o.material])) {
                removedMaterials.add(material);
                collectTextures(material, removedTextures);
            }
            removedGeometries.forEach(geometry => {
                if (!retainedGeometries.has(geometry)) geometry.dispose();
            });
        });
    }
    removedMaterials.forEach(material => {
        if (!retainedMaterials.has(material)) material.dispose();
    });
    removedTextures.forEach(texture => {
        if (!retainedTextures.has(texture)) texture.dispose();
    });

    const retainedIds = new Set([...retainedMaterials].map(material => material.uuid));
    for (const [key, material] of matCache) {
        if (retainedIds.has(key.split('|')[0])) continue;
        material.dispose();
        matCache.delete(key);
    }
}

function collectTextures(material, textures) {
    for (const value of Object.values(material)) {
        if (value && value.isTexture) textures.add(value);
    }
}

// worn, dusty clothing palette (linear-ish albedo, below the global albedo cap)
const PALETTE = [0x5a5f66, 0x6b5a48, 0x3e4a5c, 0x7a6f5e, 0x4e5a48, 0x6a4038, 0x8a8478, 0x2e3440, 0x705848, 0x5c6470];
const MEDIC = { top: 0xb8b4ac, bottom: 0x2a3446 };
const CLOTH = /shirt|pants|white|red|light|blue|brown|shoes|socks/i;
const matCache = new Map();
function clothMat(src, color) {
    const key = `${src.uuid}|${color}`;
    if (!matCache.has(key)) {
        const m = src.clone();
        if (m.color) {
            if (CLOTH.test(src.name) && color != null) m.color.setHex(color);
            else { const hsl = {}; m.color.getHSL(hsl); m.color.setHSL(hsl.h, hsl.s * 0.75, hsl.l * 0.85); }     // skin / hair: less toy-like
        }
        m.roughness = Math.max(0.82, m.roughness ?? 0.9); m.metalness = 0;
        matCache.set(key, m);
    }
    return matCache.get(key);
}

class Civilian {
    constructor(key, { medic = false, tint = 0 } = {}) {
        const tpl = T[key];
        this.key = key;
        this.root = new THREE.Group();
        const model = this.model = skeletonClone(tpl.scene);
        model.scale.setScalar(tpl.scale);
        model.position.y = tpl.offsetY * tpl.scale;
        this.root.add(model);
        const top = medic ? MEDIC.top : PALETTE[tint % PALETTE.length], bottom = medic ? MEDIC.bottom : PALETTE[(tint * 3 + 4) % PALETTE.length];
        model.traverse(o => {
            if (!o.isMesh) return;
            o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true;
            const pick = (m) => clothMat(m, /pants|shoes|socks|brown/i.test(m.name) ? bottom : top);
            o.material = Array.isArray(o.material) ? o.material.map(pick) : pick(o.material);
        });
        this.mixer = new THREE.AnimationMixer(model);
        this.clips = tpl.clips;
        this.current = null; this.acc = 0;
        this.mode = 'idle'; this.speed = 0; this.path = null; this.pi = 0;
        this.group = this.root;                 // for blob shadows
        this.dead = false;
    }

    has(name) { return !!this.clips[name]; }

    play(name, { fade = 0.35, once = false, timeScale = 1, offset = Math.random() } = {}) {
        const clip = this.clips[name] || this.clips.Idle || Object.values(this.clips)[0];
        if (!clip) return;
        const a = this.mixer.clipAction(clip);
        if (this.current === a) return;
        a.reset(); a.setEffectiveTimeScale(timeScale);
        a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = once;
        if (!once) a.time = offset * clip.duration;
        a.play();
        if (this.current) this.current.crossFadeTo(a, fade, false);
        this.current = a;
    }

    dispose(scene) {
        scene.remove(this.root);
        this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
        this.model.traverse(o => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose(); });
    }
}

const _sph = new THREE.Vector3(), _fr = new THREE.Frustum(), _pm = new THREE.Matrix4(), _s = new THREE.Sphere();

export class Civilians {
    /** scene, level (colliders/heightAt/war), mission, config (BIOMES entry), getPlayerPos */
    constructor(scene, level, mission, config, getPlayerPos) {
        this.scene = scene; this.level = level; this.heightAt = level.heightAt || (() => 0);
        this.getPlayerPos = getPlayerPos;
        this.list = [];
        this.rand = mulberry(1000 + (mission.id | 0) * 77);
        this.disposed = false;
        if (!Object.keys(T).length) return;
        this._spawnBodies(mission, config);
        if (mission.biome === 'city') this._spawnCity();
        globalEvents.on('objective_complete', (d) => this._onObjective(d));
        this.missionId = mission.id;
    }

    // ── helpers ──
    _free(x, z, pad = 0.6) {
        for (let t = 0; t < 14; t++) {
            const px = x + (t ? (this.rand() - 0.5) * t * 0.9 : 0), pz = z + (t ? (this.rand() - 0.5) * t * 0.9 : 0);
            if (!(this.level.colliders || []).some(b => px > b.min.x - pad && px < b.max.x + pad && pz > b.min.z - pad && pz < b.max.z + pad && b.max.y - b.min.y > 0.4)) return [px, pz];
        }
        return null;
    }
    _add(key, x, z, yaw, opts = {}) {
        if (!T[key]) key = T.man2 ? 'man2' : T.woman ? 'woman' : 'man';
        if (!T[key]) return null;
        const c = new Civilian(key, opts);
        c.root.position.set(x, this.heightAt(x, z), z);
        c.root.rotation.y = yaw;
        this.scene.add(c.root);
        this.list.push(c);
        animation.blobExtra.push(c);
        return c;
    }

    // ── the dead ──
    _spawnBodies(mission, config) {
        if (!animation.corpses || mission.id === 1) return;            // episode 1: "no bodies" is the point of the story
        const war = config.war || {};
        const anchors = [...(war.objects || []).map(o => [o.x, o.z, 2.4]), ...(war.craters || []).map(c => [c.x, c.z, c.r + 1])];
        if (!anchors.length) return;
        const urban = mission.biome === 'city' || mission.biome === 'deadzone';
        const nCiv = mission.biome === 'city' ? 9 : mission.biome === 'deadzone' ? 4 : 0;
        const nSol = mission.biome === 'city' ? 4 : 6;
        const spot = () => {
            const a = anchors[Math.floor(this.rand() * anchors.length)], ang = this.rand() * 6.283, d = a[2] + this.rand() * 2.5;
            return this._free(a[0] + Math.cos(ang) * d, a[1] + Math.sin(ang) * d);
        };
        for (let i = 0; i < nCiv && urban; i++) {
            const p = spot(); if (!p) continue;
            const keys = Object.keys(T);
            const c = new Civilian(keys[i % keys.length], { tint: i + 3 });
            c.root.position.set(p[0], this.heightAt(p[0], p[1]), p[1]); c.root.rotation.y = this.rand() * 6.283;
            this.scene.add(c.root);
            const clip = c.clips.Death;
            if (clip) {
                const a = c.mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
                c.mixer.update(clip.duration - 0.01);
            }
            c.root.updateMatrixWorld(true);
            animation.corpses.bake(c.root, { blood: this.rand() < 0.75 });
            c.dispose(this.scene);
        }
        for (let i = 0; i < nSol; i++) {
            const p = spot(); if (!p) continue;
            const ch = createCharacter(i % 2 ? 'soldier' : 'army2', 'enemy', null);
            if (!ch) break;
            ch.root.remove(ch.rifle);
            for (let k = 0; k < 40; k++) ch.update(0.05, { speed: 0, aiming: false, dead: true });
            const dir = this.rand() < 0.5 ? -1 : 1;
            ch.root.position.set(p[0], this.heightAt(p[0], p[1]) - 0.08, p[1]);
            ch.root.rotation.set(dir * Math.PI * 0.47, this.rand() * 6.283, (this.rand() - 0.5) * 0.5, 'YXZ');
            this.scene.add(ch.root);
            ch.root.updateMatrixWorld(true);
            animation.corpses.bake(ch.root, { blood: true });
            this.scene.remove(ch.root);
            ch.dispose();
        }
    }

    // ── Veyra City: survivors in the west hall, medics at the ambulance, people fleeing ──
    _spawnCity() {
        const R = this.rand;
        // west hall survivors (objective 2 at -40,-22): a huddled ring and one waving for help
        this.survivors = [];
        const keys = ['woman', 'man2', 'woman', 'man2', 'man2', 'woman'];
        keys.forEach((k, i) => {
            const a = (i / keys.length) * 6.283 + R() * 0.3, r = 1.6 + R() * 0.8;
            const p = this._free(-40 + Math.cos(a) * r, -22 + Math.sin(a) * r, 0.2); if (!p) return;
            const c = this._add(k, p[0], p[1], Math.atan2(-Math.cos(a), -Math.sin(a)) + (R() - 0.5) * 0.6, { tint: i });
            if (!c) return;
            c.mode = 'cower'; c.play(c.has('Sitting') ? 'Sitting' : 'Idle', { timeScale: 0.8 + R() * 0.3 });
            c.slot = i; this.survivors.push(c);
        });
        const w = this._add('man', -37.5, -24.5, 0.6, { tint: 7 });
        if (w) { w.mode = 'wave'; w.play(w.has('Wave') ? 'Wave' : 'Idle'); w.slot = keys.length; this.survivors.push(w); }
        // medics at the ambulance (9,-67) treating a casualty
        const m1 = this._add('man', 4.8, -64.6, 2.2, { medic: true });
        if (m1) { m1.mode = 'medic'; m1.play(m1.has('Interact') ? 'Interact' : 'Idle'); }
        const m2 = this._add('man2', 6.2, -62.8, 3.4, { medic: true });
        if (m2) { m2.mode = 'medic'; m2.play('Idle'); }
        const hurt = this._add('woman', 4.2, -63.2, -0.9, { tint: 5 });
        if (hurt) { hurt.mode = 'cower'; hurt.play(hurt.has('Sitting') ? 'Sitting' : 'Idle', { timeScale: 0.6 }); }
        // people fleeing down the far streets (loop while out of sight)
        const lanes = [[[-62, -15.5], [62, -15.5]], [[58, -12.8], [-58, -12.8]], [[1.8, -36], [1.8, -76]], [[-62, -16.6], [62, -16.6]]];
        lanes.forEach((ln, i) => {
            const c = this._add(['man2', 'woman', 'man', 'woman'][i], ln[0][0], ln[0][1], 0, { tint: i + 2 });
            if (!c) return;
            c.mode = 'flee'; c.path = ln; c.pi = 1; c.speed = 4.2 + R() * 1.2;
            const t = R();
            c.root.position.x = ln[0][0] + (ln[1][0] - ln[0][0]) * t; c.root.position.z = ln[0][1] + (ln[1][1] - ln[0][1]) * t;
            c.play('Run', { timeScale: c.speed / 4.6 });
        });
    }

    _onObjective(d) {
        if (this.disposed || this.missionId !== 6 || !this.survivors) return;
        if (d.index === 1) for (const c of this.survivors) { c.mode = 'follow'; }        // reached them: they come with you
        if (d.index === 2) for (const c of this.survivors) {                           // checkpoint: gather by the ambulance
            c.mode = 'goto'; c.goal = new THREE.Vector3(2 + (c.slot % 3) * 1.4, 0, -60 - Math.floor(c.slot / 3) * 1.4);
        }
    }

    update(dt, camera) {
        if (!this.list.length) return;
        camera.updateMatrixWorld();
        _fr.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        const cam = camera.getWorldPosition(_sph.set(0, 0, 0)).clone();
        const player = this.getPlayerPos ? this.getPlayerPos() : cam;
        for (const c of this.list) {
            const p = c.root.position;
            // ── behaviour
            if (c.mode === 'flee') {
                const [a, b] = c.path, tx = b[0], tz = b[1];
                const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
                if (d < 1) { p.x = a[0]; p.z = a[1]; }                             // loop (the far end is off in the haze)
                else { p.x += dx / d * c.speed * dt; p.z += dz / d * c.speed * dt; c.root.rotation.y = Math.atan2(dx, dz); }
                p.y = this.heightAt(p.x, p.z);
            } else if (c.mode === 'follow' || c.mode === 'goto') {
                // trail the player in a loose file, walking when close and running to catch up
                let gx, gz;
                if (c.mode === 'goto') { gx = c.goal.x; gz = c.goal.z; }
                else {
                    const ang = (c.slot / 7) * Math.PI - Math.PI / 2;
                    gx = player.x + Math.sin(ang) * (2.5 + (c.slot % 2)); gz = player.z + 3 + Math.cos(ang) * 1.5 + (c.slot % 3);
                }
                const dx = gx - p.x, dz = gz - p.z, d = Math.hypot(dx, dz);
                const want = d < 0.8 ? 0 : d < 6 ? 1.5 : 4.2;
                c.speed += (want - c.speed) * Math.min(1, dt * 3);
                if (c.speed > 0.1) {
                    p.x += dx / Math.max(d, 0.01) * c.speed * dt; p.z += dz / Math.max(d, 0.01) * c.speed * dt;
                    const yaw = Math.atan2(dx, dz); let dy = yaw - c.root.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
                    c.root.rotation.y += dy * Math.min(1, dt * 6);
                }
                p.y = this.heightAt(p.x, p.z);
                const clip = c.speed > 2.6 ? 'Run' : c.speed > 0.4 ? 'Walk' : (c.mode === 'goto' && c.has('Sitting') ? 'Sitting' : 'Idle');
                c.play(clip, { timeScale: clip === 'Run' ? c.speed / 4.6 : clip === 'Walk' ? Math.max(0.6, c.speed / 1.5) : 1 });
            }
            // ── culling: frustum + occlusion; hidden ones are not drawn and animate at 2 Hz
            const d2 = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
            _s.center.set(p.x, p.y + 0.9, p.z); _s.radius = 1.2;
            const seen = d2 < 9 || (d2 < 75 * 75 && _fr.intersectsSphere(_s) && occlusion.testSphere(p.x, p.y + 0.9, p.z, 1.0));
            c.root.visible = seen;
            c.acc += dt;
            const interval = !seen ? 0.5 : d2 > 60 * 60 ? 0.1 : d2 > 30 * 30 ? 0.05 : 0;
            if (c.acc >= interval) { c.mixer.update(c.acc); c.acc = 0; }
        }
    }

    dispose() {
        this.disposed = true;
        for (const c of this.list) c.dispose(this.scene);
        this.list = [];
        if (animation.blobExtra) animation.blobExtra.length = 0;
    }
}

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
