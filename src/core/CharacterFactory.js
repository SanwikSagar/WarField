import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { makeGLTFLoader } from '../environments/AssetLoaders.js';
import { createWeaponModel, hasWeaponModel } from '../weapons/WeaponModels.js';

/**
 * Character system.
 *
 *  - soldier.glb : already has a Mixamo skeleton -> used as-is.
 *  - army1/army2 : static meshes -> an anatomical skeleton is generated and the
 *    mesh is skinned automatically (smooth distance-based weights with side /
 *    limb constraints), so they animate exactly like the rigged soldier.
 *
 * One procedural Animator drives every rig through the same named bones, using
 * rotations expressed in the character's own space (X = swing, Z = roll,
 * Y = twist) converted into each bone's local frame, so it works regardless of
 * how a given skeleton's local axes happen to be oriented.
 *
 * Teams: ALLIES wear dark clothing, ENEMIES lighter clothing (colour tint).
 */
const HEIGHT = 1.8;
const T = {};      // templates by name
const FLIP_FORWARD = { army1: true };
const PART_NAMES = ['hips', 'spine', 'chest', 'neck', 'head', 'uL', 'lL', 'fL', 'uR', 'lR', 'fR', 'aL', 'fAL', 'hL', 'aR', 'fAR', 'hR'];

export async function loadCharacters() {
    if (T.ready) return;
    const loader = makeGLTFLoader();
    for (const name of ['soldier', 'army1', 'army2']) {
        try {
            const gl = await loader.loadAsync(`/assets/models/characters/${name}.glb`);
            T[name] = name === 'soldier' ? prepSkinned(gl.scene) : prepStatic(gl.scene, name);
        } catch (e) { console.warn('Character failed to load:', name, e); }
    }
    T.ready = true;
}
export function hasCharacters() { return !!(T.soldier || T.army1 || T.army2); }

// ═══════════════════════════════════════════════════════════════════════
// Template preparation
// ═══════════════════════════════════════════════════════════════════════
function prepSkinned(scene) {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    return { type: 'skinned', scene, scale: HEIGHT / size.y, offsetY: -box.min.y, tpose: size.x / size.y > 0.5 };
}

function prepStatic(scene, name) {
    scene.updateMatrixWorld(true);
    const meshes = [];
    scene.traverse(o => { if (o.isMesh) meshes.push(o); });
    // world-space copies
    const parts = meshes.map(m => {
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        return { g, material: m.material };
    });
    const box = new THREE.Box3();
    parts.forEach(p => { p.g.computeBoundingBox(); box.union(p.g.boundingBox); });
    const size = box.getSize(new THREE.Vector3());

    // Both supplied static models face along +/-X. Pick the sign from the toes:
    // low vertices extend further forward than backward.
    let cx = 0, n = 0;
    parts.forEach(p => {
        const a = p.g.attributes.position;
        for (let i = 0; i < a.count; i++) {
            const y = (a.getY(i) - box.min.y) / size.y;
            if (y > 0.3 && y < 0.5) { cx += a.getX(i); n++; }
        }
    });
    cx = n ? cx / n : (box.min.x + box.max.x) / 2;
    let lo = Infinity, hi = -Infinity;
    parts.forEach(p => {
        const a = p.g.attributes.position;
        for (let i = 0; i < a.count; i++) {
            if ((a.getY(i) - box.min.y) / size.y < 0.05) { lo = Math.min(lo, a.getX(i)); hi = Math.max(hi, a.getX(i)); }
        }
    });
    let forwardPlusX = (hi - cx) > (cx - lo);
    if (FLIP_FORWARD[name]) forwardPlusX = !forwardPlusX;   // verified visually per model
    const cz = (box.min.z + box.max.z) / 2;
    const s = HEIGHT / size.y;
    const M = new THREE.Matrix4()
        .makeScale(s, s, s)
        .multiply(new THREE.Matrix4().makeRotationY(forwardPlusX ? -Math.PI / 2 : Math.PI / 2))
        .multiply(new THREE.Matrix4().makeTranslation(-cx, -box.min.y, -cz));
    parts.forEach(p => { p.g.applyMatrix4(M); p.g.computeBoundingBox(); p.g.computeBoundingSphere(); });

    const nb = new THREE.Box3();
    parts.forEach(p => nb.union(p.g.boundingBox));
    const tpose = (nb.max.x - nb.min.x) > 1.1;
    const joints = buildJoints(parts, tpose);
    parts.forEach(p => skinGeometry(p.g, joints, tpose));
    return { type: 'static', parts, joints, tpose, name };
}

function buildJoints(parts, tpose) {
    // hip half-width from the legs
    let sp = 0, np = 0, sn = 0, nn = 0;
    parts.forEach(p => {
        const a = p.g.attributes.position;
        for (let i = 0; i < a.count; i++) {
            const y = a.getY(i);
            if (y > 0.25 && y < 0.55) { const x = a.getX(i); if (x > 0) { sp += x; np++; } else { sn += x; nn++; } }
        }
    });
    const hx = THREE.MathUtils.clamp(((np ? sp / np : 0.1) + (nn ? -sn / nn : 0.1)) / 2, 0.07, 0.14);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const J = {
        hips: V(0, 0.95, 0), spine: V(0, 1.1, 0), chest: V(0, 1.3, 0), neck: V(0, 1.5, 0.01), head: V(0, 1.6, 0.02), headTop: V(0, 1.8, 0.02),
        shoulder: 0.2, hx
    };
    for (const [k, sgn] of [['L', 1], ['R', -1]]) {
        J['up' + k] = V(sgn * hx, 0.93, 0); J['knee' + k] = V(sgn * hx, 0.5, 0.0);
        J['ankle' + k] = V(sgn * hx, 0.09, 0); J['toe' + k] = V(sgn * hx, 0.03, 0.17);
        J['sh' + k] = V(sgn * 0.2, 1.45, 0);
        J['el' + k] = tpose ? V(sgn * 0.55, 1.45, 0) : V(sgn * 0.26, 1.15, 0.02);
        J['wr' + k] = tpose ? V(sgn * 0.85, 1.45, 0) : V(sgn * 0.27, 0.88, 0.04);
        J['he' + k] = tpose ? V(sgn * 1.0, 1.45, 0) : V(sgn * 0.27, 0.74, 0.05);
    }
    return J;
}

function distSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz + 1e-9)));
    const dx = p.x - (a.x + abx * t), dy = p.y - (a.y + aby * t), dz = p.z - (a.z + abz * t);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Smooth automatic skin weights from distance to bone segments. */
function skinGeometry(geo, J, tpose) {
    // segments: [boneIndex(PART_NAMES), a, b, side(+1 L, -1 R, 0 centre), kind]
    const idx = (n) => PART_NAMES.indexOf(n);
    const S = [
        [idx('hips'), J.hips, J.spine, 0, 'core'], [idx('hips'), J.upL, J.upR, 0, 'core'],
        [idx('spine'), J.spine, J.chest, 0, 'core'], [idx('chest'), J.chest, J.neck, 0, 'core'],
        [idx('chest'), J.chest, J.shL, 1, 'clav'], [idx('chest'), J.chest, J.shR, -1, 'clav'],
        [idx('neck'), J.neck, J.head, 0, 'core'], [idx('head'), J.head, J.headTop, 0, 'core'],
        [idx('uL'), J.upL, J.kneeL, 1, 'leg'], [idx('lL'), J.kneeL, J.ankleL, 1, 'leg'], [idx('fL'), J.ankleL, J.toeL, 1, 'leg'],
        [idx('uR'), J.upR, J.kneeR, -1, 'leg'], [idx('lR'), J.kneeR, J.ankleR, -1, 'leg'], [idx('fR'), J.ankleR, J.toeR, -1, 'leg'],
        [idx('aL'), J.shL, J.elL, 1, 'arm'], [idx('fAL'), J.elL, J.wrL, 1, 'arm'], [idx('hL'), J.wrL, J.heL, 1, 'arm'],
        [idx('aR'), J.shR, J.elR, -1, 'arm'], [idx('fAR'), J.elR, J.wrR, -1, 'arm'], [idx('hR'), J.wrR, J.heR, -1, 'arm']
    ];
    const pos = geo.attributes.position, n = pos.count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const p = new THREE.Vector3(), w = new Float32Array(PART_NAMES.length);
    for (let i = 0; i < n; i++) {
        p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        w.fill(0);
        for (const [bi, a, b, side, kind] of S) {
            const d = distSeg(p, a, b);
            let k = 1 / Math.pow(d + 0.025, 3);
            if (side !== 0) {
                const sameSide = (p.x * side) > -0.01;
                if (kind === 'leg') { if (!sameSide) k *= 0.03; }
                else if (kind === 'arm') {
                    if (!sameSide) k *= 0.03;
                    // A-pose: vertices inside the torso column belong to the torso, not the hanging arm
                    if (!tpose && Math.abs(p.x) < 0.17 && p.y > 0.9) k *= 0.15;
                    if (!tpose && Math.abs(p.x) > 0.2 && p.y > 0.7 && p.y < 1.5) k *= 3;
                }
            }
            w[bi] += k;
        }
        // keep the 4 strongest
        const order = Array.from(w.keys()).sort((x, y) => w[y] - w[x]).slice(0, 4);
        let sum = 0; order.forEach(o => { sum += w[o]; });
        for (let k = 0; k < 4; k++) { si[i * 4 + k] = order[k]; sw[i * 4 + k] = w[order[k]] / sum; }
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
}

// ═══════════════════════════════════════════════════════════════════════
// Instances
// ═══════════════════════════════════════════════════════════════════════
const TEAM_TINT = {
    // dark clothing for allies, lighter for enemies
    soldier: { ally: 0x777a72, enemy: 0xe6d9b8 },
    army1: { ally: 0xb4b4ae, enemy: 0xd8d4c8 },
    army2: { ally: 0x4a4d52, enemy: 0xf2f2ee }
};

/** kind: 'soldier' | 'army1' | 'army2'; team: 'ally' | 'enemy' */
export function createCharacter(kind, team, weaponId = null) {
    const tpl = T[kind];
    if (!tpl) return null;
    const root = new THREE.Group();
    let rig, materials = [];
    let model;

    if (tpl.type === 'skinned') {
        model = skeletonClone(tpl.scene);
        model.scale.setScalar(tpl.scale);
        model.position.y = tpl.offsetY * tpl.scale;
        root.add(model);
        root.updateMatrixWorld(true);
        rig = mapMixamo(model, root);
        rig.tpose = true;
    } else {
        model = new THREE.Group();
        const built = buildStaticRig(tpl);
        model.add(built.hips);
        root.add(model);
        root.updateMatrixWorld(true);
        const skeleton = new THREE.Skeleton(built.bones);
        tpl.parts.forEach(p => {
            const m = new THREE.SkinnedMesh(p.g, p.material);
            model.add(m);
            m.bind(skeleton, new THREE.Matrix4());
        });
        rig = captureRig(built.map, root);
        rig.tpose = tpl.tpose;
    }

    // per-instance materials, tinted by team
    const tint = new THREE.Color(TEAM_TINT[kind][team]);
    const seen = new Map();
    model.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        if (!seen.has(o.material)) {
            const m = o.material.clone();
            const faceMaterial = /face|skin|head/i.test(m.name || '');
            if (m.color) {
                if (team === 'enemy') m.color.lerp(tint, 0.0).multiply(tint);
                else m.color.multiply(tint);
                if (faceMaterial) m.color.lerp(new THREE.Color(0xb78d7b), 0.78);
            }
            m.roughness = Math.max(m.roughness ?? 0.9, 0.8);
            m.metalness = Math.min(m.metalness ?? 0, 0.1);
            if (m.emissive) m.emissive.setRGB(0, 0, 0);
            if (faceMaterial && m.emissive) {
                m.emissive.set(0x211711);
                m.emissiveIntensity = 0.08;
            }
            seen.set(o.material, m); materials.push(m);
        }
        o.material = seen.get(o.material);
    });

    // invisible hit proxies (raycaster ignores visibility): head + torso/legs
    const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), proxyMat);
    head.position.set(0, 1.66, 0.02); head.name = 'head'; head.visible = false;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 1.5, 8), proxyMat);
    body.position.set(0, 0.78, 0); body.name = 'body'; body.visible = false;
    root.add(head, body);

    const rifle = makeTPWeapon(weaponId) || makeRifle();
    root.add(rifle);

    const anim = new Animator(rig, rifle, tpl.type === 'skinned' ? tpl.scale : 1);
    return {
        root, rig, materials, hitMeshes: [head, body], head, body, rifle,
        update: (dt, state) => anim.update(dt, state),
        kick: () => { anim.kick = 1; },
        talk: (seconds) => { anim.talkT = Math.max(anim.talkT, seconds); },
        get talking() { return anim.talkT > 0; },
        muzzleWorld: (out = new THREE.Vector3()) => anim.muzzleWorld(out),
        dispose() { materials.forEach(m => m.dispose()); head.geometry.dispose(); body.geometry.dispose(); proxyMat.dispose(); }
    };
}

/**
 * First-person body: the rigged soldier, dark (ally) tint, whose bones are
 * driven by IK in FPArms. Returns { root, model, bones: {CleanName: Bone} }.
 */
export function createFPArmsModel() {
    const tpl = T.soldier;
    if (!tpl) return null;
    const model = skeletonClone(tpl.scene);
    model.scale.setScalar(tpl.scale);
    model.position.y = tpl.offsetY * tpl.scale;
    const root = new THREE.Group();
    root.add(model);
    const bones = {};
    model.traverse(o => {
        if (o.isBone) {
            const n = o.name.replace(/^.*?(?=(Hips|Spine|Neck|Head|Left|Right))/, '').replace(/_?\d+$/, '');
            if (!bones[n]) bones[n] = o;
        }
    });
    const tint = new THREE.Color(0x6f726b);
    const seen = new Map();
    model.traverse(o => {
        if (!o.isMesh) return;
        o.frustumCulled = false; o.castShadow = false; o.receiveShadow = true;
        if (!seen.has(o.material)) {
            const m = o.material.clone();
            if (m.color) m.color.multiply(tint);
            m.roughness = Math.max(m.roughness ?? 0.8, 0.75); m.metalness = 0;
            seen.set(o.material, m);
        }
        o.material = seen.get(o.material);
    });
    return { root, model, bones };
}

/** Real weapon model held by an NPC (muzzle +Z), grip at the old rifle's grip spot. */
function makeTPWeapon(id) {
    if (!id || !hasWeaponModel(id)) return null;
    const w = createWeaponModel(id, 'tp');
    const g = new THREE.Group();
    const grip = w.points.grip.clone(); grip.x = -grip.x; grip.z = -grip.z;   // canonical -> tp (rotated 180 deg)
    w.root.position.set(-grip.x, -grip.y - 0.085, -grip.z + 0.05);
    g.add(w.root);
    g.userData.weapon = w;
    g.userData.grip = new THREE.Vector3(0, -0.085, 0.05);
    if (w.points.support) {
        const s = w.points.support;
        g.userData.support = new THREE.Vector3(-s.x, s.y, -s.z).add(w.root.position);
    }
    const mz = w.points.muzzle;
    g.userData.muzzle = new THREE.Vector3(-mz.x, mz.y, -mz.z).add(w.root.position);
    if (w.points.magCenter) { const m = w.points.magCenter; g.userData.mag = new THREE.Vector3(-m.x, m.y, -m.z).add(w.root.position); }
    return g;
}

function makeRifle() {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f1c, roughness: 0.55, metalness: 0.55 });
    const furn = new THREE.MeshStandardMaterial({ color: 0x2c2a24, roughness: 0.8 });
    const add = (w, h, d, x, y, z, m = dark) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = true; g.add(b); };
    add(0.05, 0.085, 0.42, 0, 0, 0.06);        // receiver
    add(0.03, 0.03, 0.34, 0, 0.012, 0.42);      // barrel
    add(0.045, 0.06, 0.2, 0, -0.01, 0.3, furn); // handguard
    add(0.045, 0.1, 0.07, 0, -0.085, 0.05, furn); // grip/mag
    add(0.045, 0.1, 0.2, 0, -0.01, -0.22, furn);   // stock
    add(0.03, 0.04, 0.08, 0, 0.065, 0.06);      // sight
    g.userData.grip = new THREE.Vector3(0, -0.085, 0.05);
    g.userData.support = new THREE.Vector3(0, -0.04, 0.3);
    g.userData.muzzle = new THREE.Vector3(0, 0.012, 0.6);
    g.userData.mag = new THREE.Vector3(0, -0.1, 0.06);
    return g;
}

// ── static rig construction ─────────────────────────────────────────────
function buildStaticRig(tpl) {
    const J = tpl.joints;
    const mk = (name, parent, pos, parentPos) => {
        const b = new THREE.Bone(); b.name = name;
        b.position.copy(pos).sub(parentPos || new THREE.Vector3());
        if (parent) parent.add(b);
        return b;
    };
    const map = {}, bones = [];
    const push = (key, b) => { map[key] = b; bones[PART_NAMES.indexOf(key)] = b; return b; };
    const hips = push('hips', mk('Hips', null, J.hips));
    const spine = push('spine', mk('Spine', hips, J.spine, J.hips));
    const chest = push('chest', mk('Chest', spine, J.chest, J.spine));
    const neck = push('neck', mk('Neck', chest, J.neck, J.chest));
    push('head', mk('Head', neck, J.head, J.neck));
    for (const k of ['L', 'R']) {
        const up = push('u' + k, mk('UpLeg' + k, hips, J['up' + k], J.hips));
        const lo = push('l' + k, mk('Leg' + k, up, J['knee' + k], J['up' + k]));
        push('f' + k, mk('Foot' + k, lo, J['ankle' + k], J['knee' + k]));
        const ar = push('a' + k, mk('Arm' + k, chest, J['sh' + k], J.chest));
        const fa = push('fA' + k, mk('ForeArm' + k, ar, J['el' + k], J['sh' + k]));
        push('h' + k, mk('Hand' + k, fa, J['wr' + k], J['el' + k]));
    }
    hips.updateMatrixWorld(true);
    return { hips, bones, map };
}

// ── rig capture (rest local + rest-space quaternions) ───────────────────
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
function captureRig(map, root) {
    root.updateMatrixWorld(true);
    const rootInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const rig = { bones: {}, rest: {}, root };
    for (const k of PART_NAMES) {
        const b = map[k];
        if (!b) continue;
        const W = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootInv);
        rig.bones[k] = b;
        rig.rest[k] = { q: b.quaternion.clone(), W, Winv: W.clone().invert(), pos: b.position.clone() };
    }
    // how far the bind-pose upper arm already hangs below horizontal (T-pose 0, A-pose ~0.9)
    const sh = map.aL, el = map.fAL;
    if (sh && el) {
        const a = sh.getWorldPosition(new THREE.Vector3()), e = el.getWorldPosition(new THREE.Vector3());
        root.worldToLocal(a); root.worldToLocal(e);
        rig.armDrop = Math.atan2(a.y - e.y, Math.abs(e.x - a.x));
    }
    return rig;
}

const MIXAMO = {
    hips: 'Hips', spine: 'Spine', chest: 'Spine2', neck: 'Neck', head: 'Head',
    uL: 'LeftUpLeg', lL: 'LeftLeg', fL: 'LeftFoot', uR: 'RightUpLeg', lR: 'RightLeg', fR: 'RightFoot',
    aL: 'LeftArm', fAL: 'LeftForeArm', hL: 'LeftHand', aR: 'RightArm', fAR: 'RightForeArm', hR: 'RightHand'
};
function mapMixamo(model, root) {
    const byName = {};
    model.traverse(o => {
        if (!o.isBone) return;
        const clean = o.name.replace(/^.*?(?=(Hips|Spine|Neck|Head|Left|Right))/, '').replace(/_?\d+$/, '');
        if (!byName[clean]) byName[clean] = o;
    });
    const map = {};
    for (const [k, n] of Object.entries(MIXAMO)) map[k] = byName[n];
    return captureRig(map, root);
}

// ═══════════════════════════════════════════════════════════════════════
// Procedural animator
// ═══════════════════════════════════════════════════════════════════════
const E = new THREE.Euler();
const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;

class Animator {
    constructor(rig, rifle, posScale) {
        this.rig = rig; this.rifle = rifle; this.posScale = posScale;
        this.t = Math.random() * 20; this.phase = Math.random() * 6.28;
        this.amp = 0; this.aim = 0; this.dead = 0; this.flinch = 0; this.crouch = 0;
        this.lookYaw = 0; this.talkT = 0; this.talk = 0;
        this.hipsRest = rig.rest.hips ? rig.rest.hips.pos.clone() : new THREE.Vector3();
    }

    /** rotate bone by (x,y,z) euler in character space ('XYZ': Z roll applied first, then Y, then X) */
    rot(name, x, y, z) {
        const b = this.rig.bones[name];
        if (!b) return;
        const r = this.rig.rest[name];
        E.set(x, y, z, 'XYZ');
        _q.setFromEuler(E);
        _q2.copy(r.Winv).multiply(_q).multiply(r.W);       // D = W^-1 * R * W
        b.quaternion.copy(r.q).multiply(_q2);
    }

    update(dt, s) {
        dt = Math.min(dt, 0.05);
        this.t += dt;
        const k = (rate) => 1 - Math.exp(-rate * dt);
        const speed = s.speed || 0;
        this.amp += (clamp(speed / 3.2, 0, 1.15) - this.amp) * k(8);
        this.aim += ((s.aiming ? 1 : 0) - this.aim) * k(9);
        this.dead += ((s.dead ? 1 : 0) - this.dead) * k(6);
        this.crouch += ((s.crouch ? 1 : 0) - this.crouch) * k(6);
        if (s.hit) this.flinch = 1;
        this.kick = Math.max(0, (this.kick || 0) - dt * 9);
        this.flinch = Math.max(0, this.flinch - dt * 4);
        this.phase += dt * (speed * 4.0 + (speed > 0.1 ? 1.2 : 0));
        const ph = this.phase, A = this.amp, t = this.t;
        const live = 1 - this.dead, aim = this.aim, T = this.rig.tpose;
        const sw = Math.sin(ph), swR = Math.sin(ph + Math.PI);
        const bob = Math.abs(Math.sin(ph)) * 0.025 * A;

        // idle life
        const breath = Math.sin(t * 1.7) * 0.012;
        const sway = Math.sin(t * 0.55) * 0.03;
        const look = Math.sin(t * 0.35) * 0.35 + Math.sin(t * 0.9) * 0.1;

        // talking: syllable-rate nods, head tilt, look toward the listener, hand gestures
        this.talkT = Math.max(0, this.talkT - dt);
        this.talk += ((this.talkT > 0 ? 1 : 0) - this.talk) * k(5);
        this.lookYaw += (clamp(s.look || 0, -1.1, 1.1) - this.lookYaw) * k(4);
        const tk = this.talk * live * (1 - aim * 0.6);
        const syl = Math.max(0, Math.sin(t * 9.3)) * (0.5 + 0.5 * Math.sin(t * 2.1));
        const nod = (Math.sin(t * 5.2) * 0.04 + syl * 0.05) * tk;
        const tilt = Math.sin(t * 1.3) * 0.07 * tk;
        const gaze = this.lookYaw * Math.max(tk, s.look !== undefined ? 0.35 : 0) * (1 - A * 0.6);
        const gesture = tk * (1 - A) * (0.55 + 0.45 * Math.sin(t * 0.9));

        // ── hips / spine / head
        const lean = 0.05 + A * 0.08 + aim * 0.1 + this.crouch * 0.25 + this.flinch * 0.25 - this.kick * 0.06;
        this.rot('hips', 0.0, -sw * 0.1 * A, sway * 0.25 * (1 - A));
        this.rot('spine', lean * 0.5 + breath, sw * 0.12 * A * (1 - aim * 0.7) + aim * -0.25 + gaze * 0.12, -sway * 0.3 * (1 - A));
        this.rot('chest', lean * 0.5 + breath * 1.4 + syl * 0.015 * tk, sw * 0.1 * A * (1 - aim * 0.7) + aim * -0.12 + gaze * 0.15 + Math.sin(t * 1.7) * 0.05 * tk, 0);
        const idleLook = look * (1 - aim) * (1 - A) * (1 - tk);
        this.rot('neck', -lean * 0.3 + nod * 0.4, -sw * 0.05 * A + idleLook * 0.2 + aim * 0.15 + gaze * 0.3, tilt * 0.4);
        this.rot('head', -lean * 0.25 + aim * 0.05 + nod, look * 0.45 * (1 - aim) * (1 - A * 0.7) * (1 - tk) + aim * 0.2 + gaze * 0.45, tilt);
        const hb = this.rig.bones.hips;
        if (hb) {
            const sc = 1 / this.posScale;
            const shift = Math.sin(t * 0.55) * 0.025 * (1 - A) * live;     // idle weight shift between feet
            const limpDip = (this.limp || 0) * Math.max(0, Math.sin(ph + Math.PI)) * 0.045 * A;
            hb.position.set(this.hipsRest.x + shift * sc, this.hipsRest.y + (bob * 1 - this.crouch * 0.35 - limpDip) * sc, this.hipsRest.z);
        }

        // ── legs: swing along the travel direction (strafe / backpedal), knee flex, crouch folds them
        const stance = aim * 0.08;
        const mx = s.moveX ?? 0, mz = s.moveZ ?? 1;
        this.limp = (this.limp || 0) + ((s.limp ? 1 : 0) - (this.limp || 0)) * k(3);
        const legSwing = (p, side) => {
            const hurt = side === 'R' ? this.limp : 0;            // favour the wounded right leg
            const stride = -Math.sin(p) * 0.55 * A * (1 - hurt * 0.5);
            const th = stride * mz - this.crouch * 0.9 + (side === 'L' ? -0.04 : 0.04) * (1 - A);
            const knee = (0.08 + Math.max(0, Math.cos(p - 0.5)) * 0.95 * A * (0.55 + 0.45 * Math.abs(mz)) * (1 - hurt * 0.6)) + this.crouch * 1.5;
            const foot = Math.sin(p) * 0.25 * A * mz - this.crouch * 0.4;
            this.rot('u' + side, th * live + this.dead * (side === 'L' ? -0.4 : 0.35), 0, (side === 'L' ? -1 : 1) * stance - stride * mx * 0.7 * live);
            this.rot('l' + side, knee * live + this.dead * 0.6, 0, 0);
            this.rot('f' + side, foot * live, 0, 0);
        };
        legSwing(ph, 'L');
        legSwing(ph + Math.PI, 'R');

        // ── arms
        const roll = this.rig.armDrop !== undefined ? clamp(1.3 - this.rig.armDrop, 0, 1.3) : (T ? 1.25 : 0.0);   // lower arms to the sides
        const armPose = (side, p) => {
            const s = side === 'L' ? 1 : -1;
            const swing = Math.sin(p + Math.PI) * 0.6 * A;
            const relaxX = swing;
            const relaxEl = -(0.18 + Math.max(0, swing) * 0.6 + A * 0.25);
            // rifle-ready: support hand forward (L), trigger hand near chest (R)
            const aimX = side === 'L' ? -1.3 : -0.95;
            const aimY = side === 'L' ? -0.12 : 0.55;
            const aimEl = side === 'L' ? -0.6 : -1.5;
            // low-ready when moving without a target
            const ready = 0.25 * A * (1 - aim);
            const x = lerp(relaxX - ready * 1.1, aimX, aim);
            const y = lerp(0, side === 'L' ? -0.15 : 0.25, aim);
            const z = -s * roll * (1 - aim * 0.25) * 1 + lerp(0, s * 0.12, 1 - aim) * (T ? 0 : 1);
            const el = lerp(relaxEl - ready * 1.3, aimEl, aim);
            const flinch = this.flinch * 0.5 - this.kick * 0.12;
            // support hand comes off the rifle to gesture while talking
            const g = side === 'L' ? gesture : 0;
            const gx = -0.55 * g + Math.sin(t * 2.7) * 0.12 * g;
            const gel = -(0.75 + Math.sin(t * 3.7) * 0.3) * g;
            this.rot('a' + side, ((x + gx) * live) + this.dead * -0.2 - flinch, (y + 0.3 * g) * live, (z * live) + this.dead * -s * 0.25);
            this.rot('fA' + side, ((el + gel) * live) - this.dead * 0.3, (side === 'L' ? 0.0 : -0.3) * aim + 0.5 * g, 0);
            this.rot('h' + side, 0.1 * aim + Math.sin(t * 4.1) * 0.25 * g, 0, -0.4 * g);
        };
        armPose('L', ph);
        armPose('R', ph);

        // ── weapon follows the torso, low-ready when not aiming
        const rf = this.rifle;
        if (rf.parent !== this.rig.root) return;            // dropped on death
        const rl = s.reload >= 0 ? s.reload : -1;
        const rEnv = rl >= 0 ? Math.min(1, rl / 0.12, (1 - rl) / 0.12) : 0;
        const aimY = lerp(1.12, 1.38 - this.crouch * 0.35, aim);
        rf.position.set(lerp(-0.1, -0.09, aim), aimY + bob - this.crouch * 0.35, lerp(0.15, 0.14, aim));
        rf.position.z -= this.kick * 0.045;
        rf.position.y -= rEnv * 0.1;
        rf.rotation.set(lerp(0.5, -0.02, aim) - this.kick * 0.12 + Math.sin(ph) * 0.03 * A + rEnv * 0.3, lerp(0.45, 0.0, aim) + sw * 0.05 * A + rEnv * 0.35, rEnv * 0.55);
        rf.visible = true;

        // ── hands on the weapon (IK), the support hand lets go to gesture while talking
        if (live > 0.02 && rf.userData.grip) {
            this.rig.root.updateMatrixWorld(true);
            const grip = rf.localToWorld(_t1.copy(rf.userData.grip).add(_t2.set(0.0, -0.025, -0.06)));
            this._ik('R', grip, -1, live);
            const sup = rf.userData.support;
            const wL = live * (1 - clamp(gesture * 1.6, 0, 1));
            if (rEnv > 0 && rf.userData.mag) {
                // reload: strip the mag, reach to the vest pouch, seat the new mag, back to the handguard
                const magW = rf.localToWorld(_t9.copy(rf.userData.mag).add(_t2.set(0.02, -0.06, -0.02)));
                const pouch = this.rig.root.localToWorld(_t10.set(0.12, 1.0, 0.16));
                const supW = rf.localToWorld(_t11.copy(sup || rf.userData.mag).add(_t2.set(0.03, -0.05, -0.05)));
                const sm = (a, b) => { const x = clamp((rl - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
                const target = _t1.copy(supW).lerp(magW, sm(0.05, 0.2));
                target.lerp(pouch, sm(0.3, 0.45) * (1 - sm(0.55, 0.7)));
                target.lerp(supW, sm(0.82, 0.97));
                this._ik('L', target, 1, live);
            } else if (sup && wL > 0.01) this._ik('L', rf.localToWorld(_t1.copy(sup).add(_t2.set(0.03, -0.05, -0.05))), 1, wL);
        }
    }

    /** World-space muzzle point of the held weapon. */
    muzzleWorld(out) {
        const rf = this.rifle;
        rf.updateWorldMatrix(true, false);
        return rf.localToWorld(out.copy(rf.userData.muzzle || _t2.set(0, 0, 0.6)));
    }

    /** Two-bone IK in world space, blended over the FK pose by `weight`. side: 'L'|'R', s: +1 left / -1 right. */
    _ik(side, target, s, weight) {
        const A = this.rig.bones['a' + side], F = this.rig.bones['fA' + side], H = this.rig.bones['h' + side];
        if (!A || !F || !H) return;
        const len = this._armLen || (this._armLen = {});
        if (!len[side]) {
            const S = A.getWorldPosition(new THREE.Vector3()), E = F.getWorldPosition(new THREE.Vector3()), W = H.getWorldPosition(new THREE.Vector3());
            len[side] = [S.distanceTo(E), E.distanceTo(W)];
        }
        const [a, c] = len[side];
        const qa = _q3.copy(A.quaternion), qf = _q4.copy(F.quaternion);
        const S = A.getWorldPosition(_t3);
        const toT = _t4.copy(target).sub(S);
        const dist = clamp(toT.length(), Math.abs(a - c) + 1e-3, a + c - 1e-3);
        const dir = toT.normalize();
        const cosA = (a * a + dist * dist - c * c) / (2 * a * dist);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const rootQ = this.rig.root.getWorldQuaternion(_q5);
        const pole = _t5.set(s * 0.9, -1.3, -0.35).applyQuaternion(rootQ);
        pole.addScaledVector(dir, -pole.dot(dir)).normalize();
        const Edes = _t6.copy(S).addScaledVector(dir, a * cosA).addScaledVector(pole, a * sinA);
        const Tdes = _t7.copy(S).addScaledVector(dir, dist);
        aimBone(A, S, F.getWorldPosition(_t8), Edes);
        aimBone(F, F.getWorldPosition(_t3), H.getWorldPosition(_t8), Tdes);
        if (weight < 0.999) {
            A.quaternion.copy(qa.slerp(A.quaternion, weight));
            F.quaternion.copy(qf.slerp(F.quaternion, weight));
            A.updateMatrixWorld(true);
        }
    }
}

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3(), _t4 = new THREE.Vector3();
const _t5 = new THREE.Vector3(), _t6 = new THREE.Vector3(), _t7 = new THREE.Vector3(), _t8 = new THREE.Vector3();
const _t9 = new THREE.Vector3(), _t10 = new THREE.Vector3(), _t11 = new THREE.Vector3();
const _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion(), _q6 = new THREE.Quaternion(), _q7 = new THREE.Quaternion();

/** rotate `bone` so its child at `childPos` swings onto `target` (all world space). */
function aimBone(bone, from, childPos, target) {
    const v1 = childPos.clone().sub(from).normalize();
    const v2 = target.clone().sub(from).normalize();
    _q6.setFromUnitVectors(v1, v2);
    const wq = bone.getWorldQuaternion(_q7);
    const want = _q6.multiply(wq);
    const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.copy(pq.invert().multiply(want));
    bone.updateMatrixWorld(true);
}
