import * as THREE from 'three';
import { makeGLTFLoader } from '../environments/AssetLoaders.js';

/**
 * Real weapon models (user supplied, Draco-compressed GLBs in
 * /assets/models/weapons). All source models share one convention:
 * muzzle toward +X, top +Y, right side +Z, 1 unit = 10 cm.
 *
 * Each template is converted to a CANONICAL frame used by the game:
 *   muzzle toward -Z (camera forward), +X = right side (ejection port), metres.
 * and annotated with:
 *   points: grip (right hand), support (left hand), sight (eye line), muzzle, eject, magWell
 *   parts : bolt / slide / charging handle / magazine nodes with their "back" and
 *           "down" directions in local space so they can be animated.
 */
const SPECS = {
    urgi: {
        file: 'urgi', kind: 'ar', boltTravel: 0.85,
        mag: /mag_empty/, hide: [/^55645(?!_ar15)/, /30rnd_mag_\(pmag\)(?!.*empty)/],
        bolt: [/bolt_carrier/], charging: /charging_handle/, grip: /pistol_grip/, support: /magpul_rvg/,
        sight: /vortex/, sightMode: 'optic', muzzle: /surefire|flash_hider/, eject: /dust_cover/, caseNode: /^55645_case/
    },
    m5scw: {
        file: 'm5scw', kind: 'ar', boltTravel: 0.85,
        mag: /mag_empty/, hide: [/^55645(?!_ar15)/, /30rnd_mag_\(pmag\)(?!.*empty)/],
        bolt: [/m5scw_bolt(?!_catch)/], charging: /charging_handle/, grip: /m5scw_grip/, support: /handguard/,
        sight: /iron_sights/, sightMode: 'iron', muzzle: /flash_hider/, eject: /dust_cover/, caseNode: /^55645_case/
    },
    uar10: {
        file: 'uar10', kind: 'ar', boltTravel: 0.95,
        mag: /mag_empty/, hide: [/^76251(?!_ar10)/, /20rnd_mag_\(pmag\)(?!.*empty)/],
        bolt: [/uar10_bolt(?!_release)/], charging: /charging_handle/, grip: /uar10_grip/, support: /handguard/,
        sight: /uar10_scope/, sightMode: 'optic', muzzle: /muzzle_device/, eject: /dust_cover/, caseNode: /^76251_case/
    },
    ak74m: {
        file: 'ak74m', kind: 'ak', boltTravel: 1.05,
        mag: /30rnd_mag_\(polymer\)(?!.*empty)/, hide: [/^54539/, /empty_mag/],
        bolt: [/bolt_carrier/], charging: /bolt_carrier/, grip: /pistol_grip/, support: /front_grip/,
        sight: /red_dot/, sightMode: 'optic', muzzle: /compensator/, eject: /dust_cover/, caseNode: /^54539_case/
    },
    g17: {
        file: 'g17', kind: 'pistol', boltTravel: 0.32,
        mag: /17rnd_empty_mag/, hide: [/^919/, /17rnd_mag(?!.*empty)/],
        bolt: [/slide$|g17g5mos_slide/, /g17g5mos_cover/], charging: /g17g5mos_slide/, grip: /g17g5_frame/, support: null,
        sight: /g17g5mos_slide/, sightMode: 'pistol', muzzle: /muzzle_nut/, eject: /g17g5mos_slide/, caseNode: /^919_case/
    }
};

const templates = {};
const tpTemplates = {};   // ~3k-tri versions for NPCs (normals rebuilt on load)
let loading = null;

export function loadWeaponModels() {
    if (loading) return loading;
    loading = (async () => {
        const L = makeGLTFLoader();
        await Promise.all(Object.entries(SPECS).map(async ([id, spec]) => {
            try {
                const gl = await L.loadAsync(`/assets/models/weapons/${spec.file}.glb`);
                templates[id] = prepare(gl.scene, spec);
            } catch (e) { console.warn('Weapon model failed:', id, e); }
            if (['urgi', 'm5scw', 'ak74m'].includes(id)) {
                try {
                    const lo = await L.loadAsync(`/assets/models/weapons/${spec.file}_tp.glb`);
                    lo.scene.traverse(o => { if (o.isMesh && !o.geometry.attributes.normal) o.geometry.computeVertexNormals(); });
                    tpTemplates[id] = prepare(lo.scene, spec);
                } catch (e) { /* fall back to the full model */ }
            }
        }));
    })();
    return loading;
}
export function hasWeaponModel(id) { return !!templates[id]; }

const clean = (n) => n.replace(/_\d+$/, '');
function findNodes(scene, re) {
    const out = [];
    if (!re) return out;
    scene.traverse(o => { if (!o.isMesh && o.children.some(c => c.isMesh) && re.test(clean(o.name))) out.push(o); });
    return out;
}

/** model space -> canonical (metres, muzzle -Z) */
const CANON = new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(new THREE.Matrix4().makeScale(0.1, 0.1, 0.1));

function prepare(scene, spec) {
    scene.updateMatrixWorld(true);
    const box = (o) => new THREE.Box3().setFromObject(o);
    // hide showcase rounds / spare magazines lying beside the gun
    spec.hide.forEach(re => findNodes(scene, re).forEach(n => { n.visible = false; }));
    let caseMesh = null;
    const caseNode = findNodes(scene, spec.caseNode)[0];
    if (caseNode) caseMesh = caseNode;

    const grip = findNodes(scene, spec.grip)[0];
    const support = findNodes(scene, spec.support)[0];
    const sight = findNodes(scene, spec.sight)[0];
    const muzzle = findNodes(scene, spec.muzzle)[0];
    const eject = findNodes(scene, spec.eject)[0];
    const mag = findNodes(scene, spec.mag)[0];
    const whole = new THREE.Box3();
    scene.traverse(o => { if (o.isMesh && isVisible(o)) whole.expandByObject(o); });

    const P = {};
    if (grip) { const b = box(grip); const c = b.getCenter(new THREE.Vector3()); P.grip = new THREE.Vector3(c.x + (spec.kind === 'pistol' ? -0.25 : 0.05), b.max.y - (b.max.y - b.min.y) * (spec.kind === 'pistol' ? 0.42 : 0.3), 0); }
    if (support) { const b = box(support); const c = b.getCenter(new THREE.Vector3()); P.support = support === grip ? null : new THREE.Vector3(spec.support.source.includes('handguard') ? c.x - (b.max.x - b.min.x) * 0.05 : c.x, spec.support.source.includes('handguard') ? b.min.y - 0.05 : c.y + 0.1, 0); }
    if (sight) {
        const b = box(sight); const c = b.getCenter(new THREE.Vector3());
        if (spec.sightMode === 'optic') P.sight = new THREE.Vector3(c.x, c.y + (b.max.y - b.min.y) * 0.12, 0);
        else if (spec.sightMode === 'iron') P.sight = new THREE.Vector3(c.x - 1.2, b.max.y - 0.04, 0);
        else P.sight = new THREE.Vector3(c.x - 0.6, b.max.y + 0.05, 0);
    } else P.sight = new THREE.Vector3(0, whole.max.y, 0);
    P.muzzle = muzzle ? new THREE.Vector3(box(muzzle).max.x, box(muzzle).getCenter(new THREE.Vector3()).y, 0) : new THREE.Vector3(whole.max.x, 0.2, 0);
    if (eject) { const c = box(eject).getCenter(new THREE.Vector3()); P.eject = new THREE.Vector3(c.x, c.y + 0.05, 0.25); }
    if (mag) { const b = box(mag); P.magWell = new THREE.Vector3(b.getCenter(new THREE.Vector3()).x, b.max.y - 0.2, 0); P.magCenter = b.getCenter(new THREE.Vector3()); }
    const ch = findNodes(scene, spec.charging)[0];
    if (ch) { const b = box(ch); P.charging = new THREE.Vector3(spec.kind === 'ak' ? b.min.x + 0.6 : b.min.x + 0.1, b.max.y, spec.kind === 'ak' ? 0.3 : 0); }

    const points = {};
    for (const [k, v] of Object.entries(P)) if (v) points[k] = v.clone().applyMatrix4(CANON);

    // casing template (in metres, unrotated)
    let casing = null;
    if (caseMesh) {
        const meshes = [];
        caseMesh.traverse(o => { if (o.isMesh) meshes.push(o); });
        if (meshes.length) {
            const g = meshes[0].geometry.clone().applyMatrix4(meshes[0].matrixWorld);
            g.computeBoundingBox(); const c = g.boundingBox.getCenter(new THREE.Vector3());
            g.translate(-c.x, -c.y, -c.z); g.scale(0.1, 0.1, 0.1);
            casing = { geometry: g, material: meshes[0].material };
        }
    }
    const length = (whole.max.x - whole.min.x) * 0.1;
    return { scene, spec, points, casing, length };
}

function isVisible(o) { let p = o; while (p) { if (!p.visible) return false; p = p.parent; } return true; }

/** Local-space vector for a model-space displacement of a node. */
function localDir(node, v) {
    const inv = new THREE.Matrix4().copy(node.parent.matrixWorld).invert();
    const m3 = new THREE.Matrix3().setFromMatrix4(inv);
    return v.clone().applyMatrix3(m3);
}

/**
 * Create an instance. mode 'fp' = canonical (muzzle -Z), 'tp' = muzzle +Z.
 * Returns { root, points, parts, casing, setBolt(t), setMag(down, hidden), setCharging(t), kind }
 */
export function createWeaponModel(id, mode = 'fp') {
    const tpl = (mode === 'tp' && tpTemplates[id]) || templates[id];
    if (!tpl) return null;
    const scene = tpl.scene.clone(true);
    scene.updateMatrixWorld(true);
    const spec = tpl.spec;
    // materials: per instance so tint/emissive can change; kill reflective black look
    const mats = new Map();
    scene.traverse(o => {
        if (!o.isMesh) return;
        if (!mats.has(o.material)) {
            const m = o.material.clone();
            if (m.metalness !== undefined) { m.metalness = Math.min(0.85, m.metalness); m.roughness = Math.max(0.32, m.roughness ?? 0.5); }
            if (m.envMapIntensity !== undefined) m.envMapIntensity = 1.0;
            mats.set(o.material, m);
        }
        o.material = mats.get(o.material);
        o.castShadow = mode === 'tp'; o.receiveShadow = true;
        o.frustumCulled = mode !== 'fp';
    });
    const inner = new THREE.Group();
    inner.add(scene);
    inner.matrixAutoUpdate = false;
    inner.matrix.copy(CANON);
    if (mode === 'tp') inner.matrix.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
    const root = new THREE.Group();
    root.add(inner);

    // animated parts (positions in their own parents' local space)
    const part = (re, deltaModel) => findNodes(scene, re).map(n => ({ node: n, base: n.position.clone(), dir: localDir(n, deltaModel) }));
    const back = new THREE.Vector3(-1, 0, 0);
    const bolts = spec.bolt.flatMap(re => part(re, back));
    const charging = spec.kind === 'ar' ? part(spec.charging, back) : [];
    const magNode = findNodes(scene, spec.mag)[0];
    const mag = magNode ? { node: magNode, base: magNode.position.clone(), down: localDir(magNode, new THREE.Vector3(0.15, -1, 0)) } : null;
    const travel = spec.boltTravel;

    return {
        id, root, kind: spec.kind, length: tpl.length, casing: tpl.casing, points: tpl.points, materials: [...mats.values()],
        /** t: 0 = closed, 1 = fully back */
        setBolt(t) { bolts.forEach(p => p.node.position.copy(p.base).addScaledVector(p.dir, t * travel)); },
        setCharging(t) { charging.forEach(p => p.node.position.copy(p.base).addScaledVector(p.dir, t * 1.0)); },
        /** d: units of model-space drop; hidden toggles visibility */
        setMag(d, visible = true) {
            if (!mag) return;
            mag.node.position.copy(mag.base).addScaledVector(mag.down, d);
            mag.node.visible = visible;
        },
        magWorld(target) { return mag ? mag.node.getWorldPosition(target) : null; },
        /** optic body nodes (hidden while looking through the scope overlay) */
        opticNodes: spec.sightMode === 'optic' ? findNodes(scene, spec.sight) : [],
        optic: spec.sightMode === 'optic' ? (spec.file === 'ak74m' ? 'dot' : spec.file === 'uar10' ? 'scope' : 'lpvo') : null
    };
}
