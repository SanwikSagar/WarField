import * as THREE from '/node_modules/three/build/three.module.js';
import { makeGLTFLoader } from './AssetLoaders.js';
import { weather } from './CityKit.js';
import { mergeByMaterial } from '../render/MeshMerge.js';
import { lodManifest } from './LodManifest.js';
import { vehicleMaterial } from './VehicleMaterials.js';

/**
 * CC0 vehicles and battlefield props (public/assets/models/war, from Poly Pizza:
 * Quaternius, Kenney, Kay Lousberg, iPoly3D, kazuma — see credits.json there).
 *
 * The raw models are low-poly with flat colours and arbitrary export scales, so this
 * module (a) normalises every model to real-world metres, origin at the centre of its
 * base, (b) re-materials it for a grounded look — rougher metal, per-model dirt and
 * streak weathering — and (c) can char it (burn 0..1) to make wrecks. Placement drapes
 * vehicles over the terrain (pitch/roll from four ground samples) and registers
 * colliders and AI cover.
 */
const SPEC = {
    truck: { length: 7.6, vehicle: true }, pickup: { length: 5.4, vehicle: true }, pickup_armored: { length: 5.6, vehicle: true },
    suv: { length: 4.8, vehicle: true }, police: { length: 4.8, vehicle: true }, rover: { length: 4.2, vehicle: true },
    tank: { length: 7.8, vehicle: true }, wagon: { length: 4.8, vehicle: true }, hatchback: { length: 4.0, vehicle: true },
    sports: { length: 4.6, vehicle: true }, helicopter: { length: 12.5, vehicle: true },
    sack_trench: { length: 6 }, sack_trench_small: { length: 4 }, bags: { length: 1.4, solid: false },
    watchtower: { height: 9 }, watchtower_small: { height: 6.5 }, tent: { length: 5.2 }, barracks: { length: 9 },
    barricade: { length: 3.2 }, barrier_large: { length: 3.4 }, traffic_barrier: { length: 2.2 }, barrier_single: { length: 1.8 },
    debris_pile: { length: 3.2, solid: false }, bricks: { length: 1.4, solid: false }, rocks: { length: 2.2 },
    cannon: { length: 3.6 }, turret_gun: { height: 1.8 }, antenna: { height: 9 }, transmission_tower: { height: 26 },
    bonfire: { length: 1.5, solid: false }, barrel: { height: 1.05 }, barrel2: { height: 1.05 }, exploding_barrel: { height: 1.1 },
    propane: { height: 1.2 }, pallet_broken: { length: 1.5, solid: false }, wall_broken: { length: 5 }, wall_modular: { length: 5 },
    dumpster: { length: 2.6 }, trash_container: { length: 2.4 }, trashbags: { length: 1.2, solid: false },
    traffic_light: { height: 5.2 }, street_light: { height: 7 }, tires: { length: 1.4, solid: false },
    crate_a: { height: 1.1 }, crate_b: { height: 1.1 },
    // box ambulance: the CC0 box truck in ambulance livery (white, red stripe, beacons, red cross panels)
    ambulance: { length: 6.6, vehicle: true, file: 'truck', livery: 'ambulance' }
};
export const WAR_SPEC = SPEC;

/** PBR scans used for craters and scorched ground. */
export const WAR_TEXTURES = ['burned_ground_01', 'rubble', 'concrete_debris'];

const T = {};
const loading = new Map();
const matCache = new Map();

export function warIds(config) {
    const w = config && config.war;
    if (!w) return [];
    const ids = new Set((w.objects || []).map(o => o.id));
    if ((w.craters || []).length) ['debris_pile', 'bricks', 'rocks', 'tires'].forEach(i => ids.add(i));
    return [...ids].filter(i => SPEC[i]);
}

export function loadWarModels(ids = []) {
    const L = makeGLTFLoader();
    return Promise.all(ids.map(id => {
        if (T[id]) return T[id];
        if (loading.has(id)) return loading.get(id);
        // small/medium clutter has an offline-reduced (<= 1000 tris) version in lod-manifest.json
        const file = (SPEC[id] && SPEC[id].file) || id;
        const p = lodManifest()
            .then(lod => (lod.war[file] ? L.loadAsync(lod.war[file]) : Promise.reject()))
            .catch(() => L.loadAsync(`/assets/models/war/${file}.glb`)).then(g => {
            const inner = new THREE.Group();
            inner.add(g.scene);
            inner.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(inner);
            const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
            g.scene.position.set(-c.x, -box.min.y, -c.z);     // origin = centre of the base
            g.scene.traverse(o => {
                if (!o.isMesh) return;
                o.castShadow = true; o.receiveShadow = true;
                if (!o.geometry.attributes.normal) {
                    o.geometry.computeVertexNormals();          // (only used by the baked AO terms; shading is flat)
                    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.flatShading = true; m.needsUpdate = true; });
                }
            });
            // static batching: one mesh per material (shared by every placed copy); the turret head must still rotate
            const scene = id === 'turret_gun' ? inner : mergeByMaterial(inner);
            if (scene !== inner) g.scene.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
            T[id] = { scene, size };
            return T[id];
        }, () => null).finally(() => loading.delete(id));
        loading.set(id, p);
        return p;
    }));
}

export function hasWar(id) { return !!T[id]; }
export function warSize(id) { return T[id] ? T[id].size : null; }

/** Grounded version of a source material; `burn` chars it (0 clean .. 1 burnt out). */
function treat(src, burn, dirt, rust = 0) {
    const key = `${src.uuid}|${Math.round(burn * 4)}|${dirt}|${rust}`;
    if (matCache.has(key)) return matCache.get(key);
    const m = src.clone();
    if (m.color) {
        // flat-colour models read as toys: knock back saturation and brightness slightly
        const hsl = {}; m.color.getHSL(hsl);
        m.color.setHSL(hsl.h, hsl.s * 0.78, hsl.l * 0.86);
        if (burn > 0) {
            m.color.lerp(new THREE.Color(0x2a1f18), burn * 0.88);       // charred, with a little rust showing
            m.color.multiplyScalar(1 - burn * 0.62);
        }
    }
    if ('roughness' in m) m.roughness = Math.max(m.roughness ?? 0.7, 0.62 + burn * 0.3);
    if ('metalness' in m) m.metalness = Math.min(m.metalness ?? 0, 0.3);
    m.envMapIntensity = 0.7;
    if (m.emissive && !src.userData.keepEmissive) m.emissive.setRGB(0, 0, 0);
    if (m.isMeshStandardMaterial) weather(m, { grime: 0.22 + dirt * 0.2 + burn * 0.15, streak: 0.18 + dirt * 0.14, rust });
    matCache.set(key, m);
    return m;
}

/**
 * Place a model. o: { rot, scale, burn, dirt, settle, tilt:[rx,rz], sink, solid, y }.
 * Returns { root, box, size, top } (top = world centre of the roof for attaching fire) or null.
 */
export function placeWar(lb, id, x, z, o = {}) {
    const tpl = T[id];
    if (!tpl) return null;
    const spec = SPEC[id] || {};
    const k = (spec.length ? spec.length / Math.max(tpl.size.x, tpl.size.z) : spec.height ? spec.height / tpl.size.y : 1) * (o.scale ?? 1);
    const root = new THREE.Group();
    const model = tpl.scene.clone(true);
    const burn = o.burn ?? 0, dirt = o.dirt ?? 0.5;
    // weathered orange-brown rust patches on anything metal; wrecks rust more
    const rust = spec.vehicle ? 0.35 + burn * 0.3 : /barrel|barrier|cannon|turret|tower|antenna|dumpster|trash|propane|barricade|light/.test(id) ? 0.32 : 0;
    model.traverse(m => {
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        // vehicles: real automotive finishes (paint / glass / rubber / trim / lamps), the rest: weathered props
        const military = /tank|armored|helicopter|rover/.test(id);
        const mk = spec.vehicle ? (s) => vehicleMaterial(s, { burn, dirt, military, livery: spec.livery }) : (s) => treat(s, burn, dirt, rust);
        m.material = Array.isArray(m.material) ? m.material.map(mk) : mk(m.material);
    });
    root.add(model);
    root.scale.setScalar(k);
    const halfL = tpl.size.z * k * 0.5, halfW = tpl.size.x * k * 0.5;
    const yaw = o.rot || 0;
    root.rotation.order = 'YXZ';
    root.rotation.y = yaw;
    let y = o.y ?? lb.heightAt(x, z);
    if ((o.settle ?? spec.vehicle) && o.y == null) {
        // drape over the terrain: sample ground under the four corners of the footprint
        const s = Math.sin(yaw), c = Math.cos(yaw);
        const at = (lx, lz) => lb.heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
        const f = at(0, halfL), b = at(0, -halfL), l = at(-halfW, 0), r = at(halfW, 0);
        y = (f + b + l + r) / 4;
        root.rotation.x = Math.atan2(b - f, halfL * 2) * 0.9;
        root.rotation.z = Math.atan2(l - r, halfW * 2) * 0.9;
    }
    if (o.tilt) { root.rotation.x += o.tilt[0]; root.rotation.z += o.tilt[1]; }
    root.position.set(x, y - (o.sink || 0), z);
    lb.group.add(root);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const top = box.getCenter(new THREE.Vector3()); top.y = box.min.y + (box.max.y - box.min.y) * 0.78;
    if ((o.solid ?? spec.solid ?? true) && box.max.y - box.min.y > 0.5) {
        lb.colliders.push(box.clone());
        lb.cover.push(new THREE.Vector3(x, 0, z));
    }
    if (lb.raycastables) model.traverse(m => { if (m.isMesh) lb.raycastables.push(m); });
    if (spec.livery === 'ambulance' && burn < 0.3) addAmbulanceDetails(lb, root, tpl.size, k);
    return { root, model, box, size: box.getSize(new THREE.Vector3()), top };
}

/** Red-cross panels on the box sides and rear, and two roof beacons that flash (AnimationSystem blinkers). */
let crossTex = null;
function addAmbulanceDetails(lb, root, size, k) {
    if (!crossTex) {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const x = c.getContext('2d');
        x.fillStyle = '#d9d6cf'; x.fillRect(0, 0, 128, 128);
        x.fillStyle = '#a3140f'; x.fillRect(46, 14, 36, 100); x.fillRect(14, 46, 100, 36);
        crossTex = new THREE.CanvasTexture(c); crossTex.colorSpace = THREE.SRGBColorSpace; crossTex.anisotropy = 4;
    }
    const mat = new THREE.MeshStandardMaterial({ map: crossTex, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2 });
    const geo = new THREE.PlaneGeometry(1, 1);
    lb.disposables.push(mat, geo);
    // model space (before the root scale k): length along z, origin at the base centre
    const L = size.z, Wd = size.x, Hh = size.y, s = 0.95 / k;
    const panel = (x, y, z, ry) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; m.scale.setScalar(s); root.add(m); return m; };
    const zBox = -L * 0.18, yBox = Hh * 0.6;
    panel(Wd / 2 + 0.02 / k, yBox, zBox, Math.PI / 2);
    panel(-Wd / 2 - 0.02 / k, yBox, zBox, -Math.PI / 2);
    root.updateMatrixWorld(true);
    // flashing beacons at both ends of the roof
    const wp = new THREE.Vector3();
    for (const z of [L * 0.42, -L * 0.42]) {
        wp.set(0, Hh + 0.05 / k, z); root.localToWorld(wp);
        if (lb.war && lb.war.blinkers) lb.war.blinkers.push({ x: wp.x, y: wp.y, z: wp.z });
    }
}

/** Footprint radius used to keep vegetation away from a placed model. */
export function warRadius(id, scale = 1) {
    const s = SPEC[id] || {};
    return ((s.length || s.height || 2) * 0.5 + 1.2) * scale;
}
