import * as THREE from '/node_modules/three/build/three.module.js';
import { mergeGeometries } from '/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
import { TextureFactory } from '../utils/TextureFactory.js';
import { Sky } from './Sky.js';
import { CollisionWorld } from '../core/CollisionWorld.js';
import { placeProp, cullProps, hasProp, getPropTemplate } from './PropModels.js';
import { getPhoto, analyzeHDR, getPhotoCacheStats } from './PhotoAssets.js';
import { Weather } from './Weather.js';
import { buildGrassField } from './GrassField.js';
import { environmentPolicy } from './EnvironmentPolicy.js';
import { buildSceneryLOD, bindReflectionRange } from './SceneryLOD.js';
import { buildTerrainLOD } from './TerrainLOD.js';
import { createTextureStream } from './TextureStream.js';
import { assetStream } from './AssetStream.js';
import * as Arch from './Architecture.js';
import * as City from './CityKit.js';
import {
    buildForest, buildBushes, buildGrass, buildRocks, buildModelScatter, registerScatterModel,
    getFoliageAssets, updateWindTime
} from './Foliage.js';

/**
 * Procedural level builder. Assembles a complete, CONTAINED playable arena
 * from a biome config:
 *
 *   - Flat, fully walkable play area (+/- bounds) surrounded by a rising rim
 *     of hills, a dense EZ-Tree forest wall and a boulder wall, so the
 *     boundary reads as natural terrain instead of an invisible clamp.
 *   - Photo-textured ground (blended dirt/grass with anti-tiling) or
 *     procedural PBR textures for desert / snow / urban biomes.
 *   - EZ-Tree forest (LOD + wind), bushes, grass tufts, GLB rocks.
 *   - Structures with pitched roofs/windows, vehicles, props.
 *   - Ultra-light GPU weather.
 *
 * Returns the level data the rest of the game consumes (see bottom).
 */
export class LevelBuilder {
    constructor(scene) {
        this.scene = scene;
        this.rand = mulberry32(0x5eed1234);
    }

    build(config, detail = {}) {
        this.config = config;
        this.detail = {
            treeMul: detail.treeMul ?? 1.0,
            grassMul: detail.grassMul ?? 1.0,
            terrainSeg: detail.terrainSeg ?? 64,
            treeLod: detail.treeLod ?? [38, 80, 150],
            treeShadowLods: detail.treeShadowLods ?? [0, 1],
            lodCount: detail.lodCount ?? 3,
            grassDist: detail.grassDist ?? 70,
            shadowExtent: detail.shadowExtent ?? 55,
            fieldMul: detail.fieldMul ?? 1,
            bushNear: detail.bushNear ?? 18,
            fieldArea: detail.fieldArea ?? 44,
            renderer: detail.renderer || null
        };
        Object.assign(this.detail, environmentPolicy({ ...detail, ...this.detail, ...(config.view || {}) }));
        if (config.view && config.view.shadowExtent) this.detail.shadowExtent = config.view.shadowExtent;   // wide streets need longer shadows
        this.bounds = config.bounds || 90;
        this.group = new THREE.Group();
        this.raycastables = [];
        // Every collider pushed here is also registered in the spatial-grid world.
        this.world = new CollisionWorld(8);
        this.colliders = [];
        const world = this.world;
        this.colliders.push = function (...boxes) { boxes.forEach(b => world.addBox(b)); return Array.prototype.push.apply(this, boxes); };
        this.cover = [];
        this.blockers = [];
        this.scene.add(this.group);
        this.disposables = [];
        this.deco = new Arch.Deco(this.group, this.disposables);

        this.sky = new Sky(this.scene, config.sky, {
            renderer: this.detail.renderer, shadowExtent: this.detail.shadowExtent,
            shadowInterval: this.detail.shadowInterval, shadowDistance: this.detail.shadowDistance,
            fogDensity: Math.max(config.sky?.fogDensity ?? 0, this.detail.fogDensity),
            renderDistance: this.detail.renderDistance
        });

        const P = getPhoto();
        if (P && P.hdr && this.detail.renderer && config.hdr) {
            this.sky.applyHDR(P.hdr, analyzeHDR(P.hdr), { renderer: this.detail.renderer, bg: config.hdr.bg, useSun: config.hdr.sun, fogMul: config.hdr.fogMul });
        }

        this._collectBlockers(config);
        this._initGroundMask(config);
        this._buildHeightField(config);
        this._buildTerrain(config);

        const ctx = {
            group: this.group, rand: this.rand, bounds: this.bounds, detail: this.detail,
            heightAt: (x, z) => this.heightAt(x, z),
            isBlocked: (x, z, pad, structuresOnly) => this._isBlocked(x, z, pad, structuresOnly),
            colliders: this.colliders, cover: this.cover, world: this.world,
            grassAt: (x, z) => this.grassAt(x, z),
            wetAt: (x, z) => this.wetAt(x, z),
            hf: this.hf,
            groundMask: this.groundMask,
            pathSegs: this.pathSegs
        };
        this.systems = [];
        const push = (s) => { if (s) this.systems.push(s); return s; };
        // decoration / vegetation are optional: a failure there must not abort the mission
        const safe = (name, fn) => {
            try { return fn(); } catch (e) { console.error(`Level system "${name}" failed, continuing without it:`, e); return null; }
        };

        // Structures first so vegetation can route around them
        this._buildLayout(config);
        this._buildPerimeterWalls(config);
        this._buildVehicles(config);
        this._buildProps(config);
        (config.containers || []).forEach(c => Arch.container(this, this.deco, c.x, c.z, c.rot || 0, c.color, c.stack || 1));
        (config.fences || []).forEach(f => Arch.fence(this, this.deco, f));
        const pathSet = getPhoto() && getPhoto().tex.brown_mud_leaves_01;
        const dirtTex = pathSet ? pathSet.map : ((getFoliageAssets() && getFoliageAssets().textures.dirt) || TextureFactory.ground(512, 1).map);
        safe('paths', () => (config.paths || []).forEach(p => Arch.path(this, p.pts, p.width || 3.2, dirtTex)));
        this.deco.flush();
        safe('scanned props', () => this._placeScannedProps(config));

        safe('puddles', () => this._buildPuddles(config));
        safe('mist', () => this._buildMist(config));

        safe('rocks', () => push(buildRocks(ctx, config.rocks, config.perimeterRocks)));
        const forest = safe('forest', () => push(buildForest(ctx, config.vegetation)));
        if (forest && forest.items) safe('forest shade', () => this._bakeForestShade(forest.items));
        safe('bushes', () => push(buildBushes(ctx, config.vegetation)));
        safe('grass', () => push(buildGrass(ctx, config.vegetation)));
        const vm = config.vegetation && config.vegetation.models;
        if (vm) safe('model scatter', () => {
            push(buildModelScatter(ctx, 'fern', vm.fern, { height: [0.45, 0.9], minGrass: 0.3 }));
            push(buildModelScatter(ctx, 'reeds', vm.reeds, { height: [0.9, 1.5], wet: true }));
            // scanned Poly Haven undergrowth, instanced + density LOD (thousands, not dozens)
            const ph = [['ph_fern', 'fern_02', vm.phFern, [0.45, 0.85], 0.3], ['ph_shrub', 'shrub_02', vm.phShrub, [0.7, 1.4], 0.3],
                ['ph_nettle', 'nettle_plant', vm.phNettle, [0.5, 0.95], 0.35], ['ph_branch', 'dry_branches_medium_01', vm.phBranch, [0.25, 0.45], -1]];
            for (const [key, id, count, height, minGrass] of ph) {
                if (count && registerScatterModel(key, getPropTemplate(id))) safe(key, () => push(buildModelScatter(ctx, key, count, { height, minGrass })));
            }
        });
        safe('grass field', () => push(buildGrassField(ctx, config.vegetation, this._grassCircles(config))));
        safe('terrain LOD', () => push(buildTerrainLOD(this.group, this.ground, this.detail.terrainLod, this.detail.shadowDistance)));
        safe('scenery LOD', () => push(buildSceneryLOD(ctx, [this.ground, this.puddleMesh].filter(Boolean))));
        (this._propObjs || []).forEach(prop => { prop.o.userData.lodManaged = true; });
        this._calibrateLevelMaterials();
        this.disposables.push(bindReflectionRange(this.group, this.detail.reflectionDistance));
        this.textureStream = push(createTextureStream(this.group, this.detail.renderer, this.detail.textureDetailDistance));

        this.weather = config.weather && config.weather.count > 0 ? new Weather({
            ...config.weather, range: this.detail.weatherDistance, area: this.detail.weatherDistance * 2,
            count: Math.round(config.weather.count * Math.max(0.4, this.detail.grassMul))
        }) : null;
        if (this.weather) this.group.add(this.weather.object);
        if (config.motes) {
            this.motes = new Weather({ kind: 'dust', height: 12, ...config.motes,
                range: this.detail.weatherDistance, area: this.detail.weatherDistance * 2 });
            this.group.add(this.motes.object);
        }

        this._camPos = new THREE.Vector3();
        this._camDir = new THREE.Vector3();
        this._time = 0;

        return {
            group: this.group,
            raycastables: this.raycastables,
            colliders: this.colliders,
            world: this.world,
            cover: this.cover,
            spawns: config.spawns,
            sky: this.sky,
            bounds: this.bounds,
            exposure: config.sky?.exposure ?? 1.2,
            heightAt: (x, z) => this.heightAt(x, z),
            update: (dt, playerPos, camera) => this._update(dt, playerPos, camera),
            dispose: () => this._dispose(),
            ambience: config.ambience || 'wind',
            environmentPolicy: { ...this.detail, renderer: undefined },
            textureStream: this.textureStream,
            getStreamingStats: () => ({ requests: assetStream.getStats(), cache: getPhotoCacheStats(), detail: this.textureStream.getStats() })
        };
    }

    // ── terrain ──────────────────────────────────────────────────────────
    /** Rim of hills outside the arena (encloses the play area). */
    _rimAt(x, z) {
        const b = this.bounds;
        const edge = Math.max(Math.abs(x), Math.abs(z)) - (b - 10);
        if (edge <= 0) return 0;
        const t = Math.min(1, edge / 55);
        const s = t * t * (3 - 2 * t);
        const n = 0.62 + 0.38 * Math.sin(x * 0.043 + 1.3) * Math.cos(z * 0.051 + 0.4)
            + 0.18 * Math.sin(x * 0.11 + z * 0.09);
        return s * (this.config.rim ?? 12) * n;
    }

    /** Final ground height: bumpy terrain + puddle basins + rim (bilinear heightfield). */
    heightAt(x, z) {
        const hf = this.hf;
        if (!hf) return this._rimAt(x, z);
        const half = hf.size / 2, N = hf.N, d = hf.data;
        let fx = (x + half) / hf.step, fz = (z + half) / hf.step;
        fx = fx < 0 ? 0 : fx > N - 1.001 ? N - 1.001 : fx;
        fz = fz < 0 ? 0 : fz > N - 1.001 ? N - 1.001 : fz;
        const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
        const a = d[j * N + i], b = d[j * N + i + 1], c = d[(j + 1) * N + i], e = d[(j + 1) * N + i + 1];
        return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
    }

    _hash(i, j) { const n = Math.sin(i * 127.1 + j * 311.7 + this._seed * 17.3) * 43758.5453; return n - Math.floor(n); }
    /** smooth value noise in [-1,1] */
    _vn(x, z) {
        const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
        const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
        const a = this._hash(xi, zi), b = this._hash(xi + 1, zi), c = this._hash(xi, zi + 1), d = this._hash(xi + 1, zi + 1);
        return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
    }

    /** 0 next to structures/paths/spawns (flat), 1 in open ground (fully bumpy). */
    _flatFactor(x, z) {
        let f = 1;
        const sm = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
        for (const c of this.blockers) {
            if (c.kind === 'struct') {
                const dx = x - c.x, dz = z - c.z, cs = Math.cos(c.rot), sn = Math.sin(c.rot);
                const lx = Math.abs(dx * cs - dz * sn) - c.hw, lz = Math.abs(dx * sn + dz * cs) - c.hd;
                const d = lx > 0 && lz > 0 ? Math.hypot(lx, lz) : Math.max(lx, lz);
                f = Math.min(f, sm(0, 5, d));
            } else if (c.kind === 'pathseg') {
                const abx = c.x2 - c.x1, abz = c.z2 - c.z1;
                const t = Math.max(0, Math.min(1, ((x - c.x1) * abx + (z - c.z1) * abz) / (abx * abx + abz * abz)));
                const d = Math.hypot(x - (c.x1 + abx * t), z - (c.z1 + abz * t)) - c.hw;
                f = Math.min(f, 0.35 + 0.65 * sm(0, 4, d));
            } else if (c.kind === 'clear' && c.r >= 5) {
                f = Math.min(f, sm(0, 5, Math.hypot(x - c.x, z - c.z) - c.r));
            }
        }
        return f;
    }

    /** Builds the bumpy heightfield and digs irregular puddle basins into the hollows. */
    _buildHeightField(config) {
        const b = this.bounds, size = (b + 90) * 2;
        const N = Math.min(400, Math.ceil(size / 1.4));
        this._seed = config.seed ?? 3;
        const bump = config.bump ?? 0.6;
        this.hf = { size, N, step: size / (N - 1), data: new Float32Array(N * N) };
        const base = (x, z) => bump * (0.55 * this._vn(x / 26 + 1.7, z / 26 - 3.1) + 0.24 * this._vn(x / 9.5 + 3.1, z / 9.5 - 1.7) + 0.09 * this._vn(x / 3.4, z / 3.4));

        // puddle sites: the lowest spots of the open ground, spaced apart; some beside the path
        this.puddles = [];
        const want = config.puddles || 0;
        if (want) {
            const cand = [], rnd = this.rand, p = (config.paths || [])[0];
            for (let k = 0; k < 600; k++) {
                let x, z, bonus = 0;
                if (p && rnd() < 0.35) {
                    const s = Math.floor(rnd() * (p.pts.length - 1)), t = rnd(), a = p.pts[s], c = p.pts[s + 1];
                    x = a[0] + (c[0] - a[0]) * t + (rnd() - 0.5) * 3.2; z = a[1] + (c[1] - a[1]) * t + (rnd() - 0.5) * 3.2; bonus = -0.25;
                } else {
                    x = (rnd() * 2 - 1) * (b - 16); z = (rnd() * 2 - 1) * (b - 16);
                    if (this._isBlocked(x, z, 4)) continue;
                }
                cand.push({ x, z, h: base(x, z) + bonus });
            }
            cand.sort((a, c) => a.h - c.h);
            for (const c of cand) {
                if (this.puddles.length >= want) break;
                if (this.puddles.some(q => Math.hypot(q.x - c.x, q.z - c.z) < 9)) continue;
                const a = 1.2 + rnd() * 2.0;
                this.puddles.push({
                    x: c.x, z: c.z, a, b: a * (0.5 + rnd() * 0.45), ang: rnd() * Math.PI,
                    D: 0.14 + rnd() * 0.1, phi1: rnd() * 6.28, phi2: rnd() * 6.28, h: base(c.x, c.z) * this._flatFactor(c.x, c.z)
                });
            }
            this.puddles.forEach(q => { q.level = q.h - q.D * 0.45; });
        }
        this._puddleCircles = this.puddles.map(q => [q.x, q.z, Math.max(q.a, q.b) * 1.15]);

        const sm = (e0, e1, v) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
        const d = this.hf.data, half = size / 2;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const x = i * this.hf.step - half, z = j * this.hf.step - half;
            let h = base(x, z) * this._flatFactor(x, z);
            for (const q of this.puddles) {
                const dx = x - q.x, dz = z - q.z;
                const R = Math.max(q.a, q.b) * 3;
                if (dx * dx + dz * dz > R * R) continue;
                const cs = Math.cos(q.ang), sn = Math.sin(q.ang);
                const u = (dx * cs + dz * sn) / q.a, v = (-dx * sn + dz * cs) / q.b;
                const th = Math.atan2(v, u);
                const wob = 1 + 0.3 * Math.sin(3 * th + q.phi1) + 0.18 * Math.sin(5 * th + q.phi2);
                const dn = Math.hypot(u, v) / wob;
                h = h + (q.h - h) * (1 - sm(0.9, 2.3, dn));            // flatten the surroundings
                h -= q.D * (1 - sm(0.3, 1.0, dn));                      // dig the basin
            }
            d[j * N + i] = h + this._rimAt(x, z);
        }
        const tex = new THREE.DataTexture(d, N, N, THREE.RedFormat, THREE.FloatType);
        tex.minFilter = tex.magFilter = THREE.NearestFilter;
        tex.needsUpdate = true;
        this.hf.texture = tex;
    }

    /** 0..1 closeness to standing water (for reeds / wet ground). */
    wetAt(x, z) {
        let w = 0;
        for (const q of this.puddles || []) {
            const r = Math.max(q.a, q.b), d = Math.hypot(x - q.x, z - q.z);
            w = Math.max(w, 1 - d / (r * 3));
        }
        return Math.max(0, w);
    }

    /**
     * The noise mask that blends dirt/grass in the terrain shader is also
     * sampled on the CPU (bushes, tufts, pebbles) and on the GPU (grass field)
     * so every kind of foliage follows what the ground texture shows.
     */
    _initGroundMask(config) {
        const forest = config.groundKind === 'forest';
        const f = (config.vegetation && config.vegetation.field) || {};
        const tex = TextureFactory.mask(256);
        this.groundMask = {
            texture: tex, data: tex.image.data, n: tex.image.width,
            size: (this.bounds + 90) * 2,
            s1: forest ? 4 : 5, s2: 19, w2: forest ? 0.35 : 0,
            lo: forest ? 0.26 : (f.maskLo ?? 0.42), hi: forest ? 0.5 : (f.maskHi ?? 0.62)
        };
    }

    /** 0 = bare soil, 1 = fully grassy, at a world position. */
    grassAt(x, z) {
        const m = this.groundMask, n = m.n, d = m.data;
        const u = x / m.size + 0.5, v = -z / m.size + 0.5;
        const tap = (uu, vv, ch) => {
            const fx = ((uu % 1) + 1) % 1 * n - 0.5, fy = ((vv % 1) + 1) % 1 * n - 0.5;
            const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
            const at = (i, j) => d[((((j % n) + n) % n) * n + (((i % n) + n) % n)) * 4 + ch];
            return ((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty) / 255;
        };
        let val = tap(u * m.s1, v * m.s1, 0) * (1 - m.w2);
        if (m.w2 > 0) val += tap(u * m.s2 + 0.3, v * m.s2 + 0.3, 1) * m.w2;
        const t = Math.min(1, Math.max(0, (val - m.lo) / (m.hi - m.lo)));
        return t * t * (3 - 2 * t);
    }

    /** Darken the ground under and near trees and toward the rim: canopy shade baked into vertex colours. */
    _bakeForestShade(items) {
        const geo = this.ground.geometry, pos = geo.attributes.position, n = pos.count, b = this.bounds;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const x = pos.getX(i), z = -pos.getY(i);
            let dark = 0;
            for (let k = 0; k < items.length; k++) {
                const dx = x - items[k].x, dz = z - items[k].z, d2 = dx * dx + dz * dz;
                if (d2 < 120) { const w = 1 - Math.sqrt(d2) / 11; dark += w * w * 0.34; }
            }
            const m = Math.max(Math.abs(x), Math.abs(z));
            dark += Math.min(1, Math.max(0, (m - (b - 24)) / 30)) * 0.35;
            const v = 1 - Math.min(0.55, dark);
            col[i * 3] = v * 0.96; col[i * 3 + 1] = v; col[i * 3 + 2] = v * 0.98;
        }
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }

    /** Standing water: a flat glossy disc per basin; the terrain above the water line hides the rest, so the shore follows the ground exactly. */
    _buildPuddles(config) {
        if (!this.puddles || !this.puddles.length) return;
        // Water outline = the basin's waterline, solved analytically (dn ~0.66 of the
        // wobbly ellipse), so the shore is smooth and irregular instead of following
        // the coarse terrain triangles. Inner ring opaque, outer ring fades to 0.
        const pos = [], col = [], idx = [];
        const SEG = 56;
        for (const q of this.puddles) {
            const base = pos.length / 3, y = q.h - q.D * 0.42;
            pos.push(q.x, y, q.z); col.push(1, 1, 1, 0.92);
            const cs = Math.cos(q.ang), sn = Math.sin(q.ang);
            for (let k = 0; k < SEG; k++) {
                const th = k / SEG * Math.PI * 2;
                const wob = 1 + 0.3 * Math.sin(3 * th + q.phi1) + 0.18 * Math.sin(5 * th + q.phi2);
                for (const [rr, al] of [[0.56, 0.9], [0.74, 0.0]]) {
                    const u = Math.cos(th) * q.a * rr * wob, v = Math.sin(th) * q.b * rr * wob;
                    const x = q.x + u * cs - v * sn, z = q.z + u * sn + v * cs;
                    pos.push(x, Math.max(y, this.heightAt(x, z) + 0.012), z); col.push(1, 1, 1, al);
                }
            }
            for (let k = 0; k < SEG; k++) {
                const i0 = base + 1 + k * 2, i1 = base + 1 + ((k + 1) % SEG) * 2;
                idx.push(base, i1, i0, i0, i1, i1 + 1, i0, i1 + 1, i0 + 1);
            }
        }
        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        merged.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
        merged.setIndex(idx);
        merged.computeVertexNormals();
        const nrm = merged.attributes.normal;
        for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
        const mat = new THREE.MeshStandardMaterial({
            color: 0x1b2328, roughness: 0.03, metalness: 0, transparent: true, opacity: 1, vertexColors: true,
            envMapIntensity: 1.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
        });
        // rain ripples: animated concentric rings perturb the normal
        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = this._rippleTime = { value: 0 };
            shader.uniforms.uRippleRange = { value: this.detail.reflectionDistance };
            shader.vertexShader = 'varying vec3 vRipW;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vRipW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
            shader.fragmentShader = 'uniform float uTime, uRippleRange; varying vec3 vRipW;\nfloat rh(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }\n' + shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                float rippleFade = 1.0 - smoothstep(uRippleRange * 0.7, uRippleRange, length(vRipW - cameraPosition));
                if (rippleFade > 0.001) {
                vec2 rp = vRipW.xz * 2.2; vec2 rnd = vec2(0.0);
                for (int k = 0; k < 2; k++) {
                    vec2 cell = floor(rp + float(k) * 0.5), f = fract(rp + float(k) * 0.5) - 0.5;
                    float ph = fract(uTime * 0.9 + rh(cell));
                    vec2 c = f - (vec2(rh(cell + 3.1), rh(cell + 7.7)) - 0.5) * 0.5;
                    float d = length(c), ring = sin((d - ph * 0.5) * 60.0) * (1.0 - ph) * (1.0 - smoothstep(0.5 * ph, 0.5 * ph + 0.06, d));
                    rnd += normalize(c + 1e-4) * ring * 0.35;
                }
                normal = normalize(normal + (viewMatrix * vec4(rnd.x, 0.0, rnd.y, 0.0)).xyz * rippleFade);
                }`);
        };
        const mesh = new THREE.Mesh(merged, mat);
        mesh.receiveShadow = true; mesh.renderOrder = 2;
        mesh.userData.ssrReflective = true;
        this.puddleMesh = mesh;
        this.group.add(mesh);
        this.disposables.push(merged, mat);
    }

    /** Low drifting ground mist (a few big soft sprites; cheap but adds depth). */
    _buildMist(config) {
        const n = config.mist || 0;
        if (!n) return;
        const tex = TextureFactory.radialGradient(256, 'rgba(200,210,220,0.6)', 'rgba(200,210,220,0)');
        this.mist = [];
        for (let i = 0; i < n; i++) {
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.13, depthWrite: false, fog: false }));
            s.scale.set(38 + this.rand() * 22, 7 + this.rand() * 3, 1);
            s.position.set((this.rand() * 2 - 1) * this.bounds, 2.2 + this.rand() * 1.2, (this.rand() * 2 - 1) * this.bounds);
            s.userData.v = (this.rand() - 0.5) * 0.9;
            this.group.add(s);
            this.mist.push(s);
        }
    }

    /** Photo texture set if it was loaded, else the procedural fallback. */
    _photo(name, fallback) {
        const P = getPhoto();
        const t = P && P.tex && P.tex[name];
        return t || fallback();
    }

    /** Hand-placed + scattered CC0 scanned props (crates, drums, generator, stumps, ferns...). */
    _placeScannedProps(config) {
        for (const p of config.phProps || []) placeProp(this, p.id, p.x, p.z, p.rot || 0, p.s || 1);
        const rnd = this.rand, b = this.bounds;
        for (const sc of config.phScatter || []) {
            if (!hasProp(sc.id)) continue;
            const [s0, s1] = sc.scale || [0.85, 1.2];
            let n = 0, guard = 0;
            while (n < sc.count && guard++ < sc.count * 40) {
                const x = (rnd() * 2 - 1) * (b - 10), z = (rnd() * 2 - 1) * (b - 10);
                if (this._isBlocked(x, z, sc.pad ?? 2)) continue;
                if (sc.minGrass != null && this.grassAt(x, z) < sc.minGrass) continue;
                if (placeProp(this, sc.id, x, z, rnd() * 6.28, s0 + rnd() * (s1 - s0))) {
                    n++;
                    if (sc.block) this.blockers.push({ kind: 'struct', x, z, rot: 0, hw: sc.block, hd: sc.block });
                }
            }
        }
    }

    _buildTerrain(config) {
        const b = this.bounds;
        const size = (b + 90) * 2;
        const seg = this.detail.terrainSeg;
        const geo = new THREE.PlaneGeometry(size, size, seg, seg);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            pos.setZ(i, this.heightAt(pos.getX(i), -pos.getY(i)));
        }
        geo.computeVertexNormals();
        geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3));
        geo.setAttribute('uv2', geo.attributes.uv.clone());

        const mat = this._groundMaterial(config, size);
        mat.vertexColors = true;
        const ground = new THREE.Mesh(geo, mat);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.group.add(ground);
        this.ground = ground;

        // Gameplay ground = a 2-triangle invisible plane. Raycasting the
        // visual terrain mesh (thousands of tris) per AI/bullet ray was a
        // major hidden CPU cost; the arena is flat so this is exact.
        const pg = new THREE.PlaneGeometry((b + 20) * 2, (b + 20) * 2, 72, 72);
        const pp = pg.attributes.position;
        for (let i = 0; i < pp.count; i++) pp.setZ(i, this.heightAt(pp.getX(i), -pp.getY(i)));
        pg.computeVertexNormals();
        const pick = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ visible: false }));
        pick.rotation.x = -Math.PI / 2;
        pick.visible = false;
        this.group.add(pick);
        this.raycastables.push(pick);
    }

    /** Adds a second, coarser normal-map tap so close-up ground never looks flat or visibly tiled. */
    _detailNormal(shader) {
        shader.fragmentShader = shader.fragmentShader.replace(
            'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
            `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
             vec3 mapN2 = texture2D( normalMap, vNormalMapUv * 0.23 + vec2(0.17, 0.41) ).xyz * 2.0 - 1.0;
             vec3 mapN3 = texture2D( normalMap, vNormalMapUv * 3.1 + vec2(0.63, 0.29) ).xyz * 2.0 - 1.0;
             mapN.xy += mapN2.xy * 0.7 + mapN3.xy * 0.35;
             mapN = normalize(mapN);`);
    }

    _groundMaterial(config, size) {
        const assets = getFoliageAssets();
        const PH = getPhoto();
        const aniso = this.detail.renderer ? Math.min(16, this.detail.renderer.capabilities.getMaxAnisotropy()) : 8;
        const tile = config.groundTile || 4;
        const uTile = size / tile;
        const forest = config.groundKind === 'forest' && assets && assets.textures.grass && PH && PH.tex.forest_ground_04;
        const mask = TextureFactory.mask(256);
        const proc = () => TextureFactory.ground(512, 1).map;

        const baseSet = forest ? PH.tex.forest_ground_04 : (PH && PH.tex[config.groundPhoto]);
        const baseMap = baseSet ? baseSet.map : TextureFactory[config.groundTexture || 'ground'](1024, 1).map;
        let baseNrm = baseSet?.normalMap;
        const flatNormal = !!baseSet && !baseNrm;
        if (flatNormal) {
            baseNrm = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
            baseNrm.needsUpdate = true;
        } else if (!baseNrm) baseNrm = TextureFactory[config.groundTexture || 'ground'](1024, 1).normalMap;
        const gravel = (PH && PH.tex.gravel_floor_02 && PH.tex.gravel_floor_02.map) || proc();
        // urban maps swap the forest mud/leaf-litter layers for real concrete/asphalt scans (config.groundMud / groundLitter)
        const mud = (PH && PH.tex[config.groundMud || 'brown_mud_leaves_01'] && PH.tex[config.groundMud || 'brown_mud_leaves_01'].map) || proc();
        const litter = (PH && PH.tex[config.groundLitter || 'leaves_forest_ground'] && PH.tex[config.groundLitter || 'leaves_forest_ground'].map) || proc();
        const grass = forest ? assets.textures.grass : proc();
        [baseMap, gravel, mud, litter, grass].forEach(t => { if (t) t.anisotropy = aniso; });
        const nm = baseNrm.clone();
        if (flatNormal) baseNrm.dispose();
        nm.anisotropy = aniso; nm.repeat.set(uTile, uTile); nm.needsUpdate = true;
        this.disposables.push(nm);
        const detail = TextureFactory.ground(128, 1);

        const mat = new THREE.MeshStandardMaterial({
            map: baseMap, normalMap: nm, aoMap: detail.aoMap,
            bumpMap: detail.bumpMap, bumpScale: detail.bumpScale,
            color: new THREE.Color(config.groundTint ?? 0xffffff),
            roughness: 1.0, roughnessMap: null, metalness: 0, envMapIntensity: 0.0, aoMapIntensity: 0.72
        });
        mat.normalScale = new THREE.Vector2(0.38, 0.38);
        const pud = (this.puddles || []).slice(0, 24);
        mat.onBeforeCompile = (shader) => {
            this._detailNormal(shader);
            Object.assign(shader.uniforms, {
                uGrass: { value: grass }, uLitter: { value: litter }, uLayerB: { value: gravel }, uLayerC: { value: mud },
                uMask: { value: mask }, uTile: { value: uTile }, uGrassAmt: { value: config.grassPatch ?? 0.9 },
                uPud: { value: Array.from({ length: 24 }, (_, i) => pud[i] ? new THREE.Vector4(pud[i].x, pud[i].z, Math.max(pud[i].a, pud[i].b), 1) : new THREE.Vector4(1e5, 1e5, 1, 0)) },
                uPudN: { value: pud.length }
            });
            shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
            shader.fragmentShader = (forest ? '#define GROUND_FOREST\n' : '') + `
                varying vec3 vWPos;
                uniform sampler2D uGrass, uMask, uLitter, uLayerB, uLayerC;
                uniform float uTile, uGrassAmt, uPudN;
                uniform vec4 uPud[24];
                float gWet = 0.0;
            ` + shader.fragmentShader
                .replace('#include <map_fragment>', `
                vec2 tuv = vMapUv * uTile;
                // anti-tiling: low-frequency noise picks one of 8 random UV offsets per region and
                // blends neighbours by content, so the photo texture no longer repeats in a grid
                float tileK = texture2D(uMask, vMapUv * 2.3 + 0.13).r * 8.0;
                float tileI = floor(tileK), tileF = fract(tileK);
                vec2 offA = sin(vec2(3.0, 7.0) * tileI), offB = sin(vec2(3.0, 7.0) * (tileI + 1.0));
                vec2 tdx = dFdx(tuv), tdy = dFdy(tuv);
                vec4 cA = textureGrad(map, tuv + offA, tdx, tdy), cB = textureGrad(map, tuv + offB, tdx, tdy);
                vec4 dA = mix(cA, cB, smoothstep(0.2, 0.8, tileF - 0.1 * dot(cA - cB, vec4(1.0))));
                vec4 dB = texture2D(map, tuv * 0.31 + vec2(0.37, 0.11));
                vec4 base = mix(dA, dB, 0.4);
                float m1 = texture2D(uMask, vMapUv * 4.0).r;
                float m2 = texture2D(uMask, vMapUv * 19.0 + 0.3).g;
                float m3 = texture2D(uMask, vMapUv * 9.0 + 0.5).b;
                float m4 = texture2D(uMask, vMapUv * 43.0 + 0.2).a;
                // wet ground around puddles
                for (int i = 0; i < 24; i++) {
                    if (float(i) >= uPudN) break;
                    vec4 p = uPud[i];
                    gWet = max(gWet, 1.0 - smoothstep(p.z * 0.95, p.z * 1.35, length(vWPos.xz - p.xy)));
                }
                float gm = 0.0;
                #ifdef GROUND_FOREST
                    vec4 grassC = mix(texture2D(uGrass, tuv * 0.9), texture2D(uGrass, tuv * 0.23 + 0.5), 0.4);
                    gm = smoothstep(0.26, 0.5, m1 * 0.65 + m2 * 0.35 + (m4 - 0.5) * 0.14) * uGrassAmt;
                    base = mix(base, grassC, gm);
                    vec4 litC = texture2D(uLitter, tuv * 1.7);
                    float lm = smoothstep(0.5, 0.74, m2 + (litC.g - 0.3) * 0.25) * (1.0 - gm * 0.5);
                    base = mix(base, litC * 1.35, lm * 0.75);
                    // mud collects in hollows and around standing water
                    vec4 mudC = texture2D(uLayerC, tuv * 1.1);
                    float low = smoothstep(0.02, -0.26, vWPos.y);
                    float mm = clamp(low * 1.2 + gWet, 0.0, 1.0) * smoothstep(0.18, 0.55, m3 + (mudC.g - 0.25) * 0.3 + 0.2);
                    base = mix(base, mudC * 0.9, clamp(mm, 0.0, 1.0));
                    base.rgb *= mix(vec3(1.3, 1.12, 0.72), vec3(1.05, 1.03, 0.96), gWet * 0.7);
                #endif
                // stony / gravelly patches on rises and in natural noise blobs
                vec4 grvC = texture2D(uLayerB, tuv * 1.25);
                float hi = smoothstep(0.12, 0.5, vWPos.y);
                float gr = smoothstep(0.58, 0.78, m3 * 0.55 + m4 * 0.35 + hi * 0.45 - gm * 0.35 + (grvC.g - 0.35) * 0.2);
                base = mix(base, grvC, gr * 0.6);
                base.rgb *= mix(1.0, 0.72, gWet);
                diffuseColor *= base;
                diffuseColor.rgb *= 0.72 + 0.2 * texture2D(uMask, vMapUv * 1.7).g;`)
                .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.72, gWet);');
        };
        mat.customProgramCacheKey = () => 'groundMulti' + (forest ? 'F' : 'P');
        return mat;
    }

    // ── placement helpers ────────────────────────────────────────────────
    _collectBlockers(config) {
        const B = this.blockers;
        (config.layout || []).forEach(s => B.push({
            kind: 'struct', x: s.x, z: s.z, rot: s.rot || 0,
            hw: s.w / 2 + 2, hd: s.d / 2 + 2
        }));
        (config.vehicles || []).forEach(v => B.push({ kind: 'struct', x: v.x, z: v.z, rot: v.rot || 0, hw: 2.4, hd: 4.2 }));
        (config.containers || []).forEach(c => B.push({ kind: 'struct', x: c.x, z: c.z, rot: c.rot || 0, hw: 1.2, hd: 3.1 }));
        (config.props || []).forEach(p => B.push({
            kind: 'struct', x: p.x, z: p.z, rot: p.rot || 0,
            hw: p.type === 'container' ? 2 : 1.4, hd: p.type === 'container' ? 3.8 : 1.4
        }));
        this.pathSegs = [];
        (config.paths || []).forEach(p => {
            for (let i = 0; i < p.pts.length - 1; i++) {
                const seg = { kind: 'pathseg', x1: p.pts[i][0], z1: p.pts[i][1], x2: p.pts[i + 1][0], z2: p.pts[i + 1][1], hw: (p.width || 3.2) * 0.5 + 0.35 };
                B.push(seg); this.pathSegs.push(seg);
            }
        });
        const sp = config.spawns;
        if (sp) {
            B.push({ kind: 'clear', x: sp.player.x, z: sp.player.z, r: 9 });
            (sp.squad || []).forEach(s => B.push({ kind: 'clear', x: s.x, z: s.z, r: 5 }));
            (sp.enemies || []).forEach(e => {
                B.push({ kind: 'clear', x: e.x, z: e.z, r: 3.5 });
                (e.patrol || []).forEach(p => B.push({ kind: 'clear', x: p.x, z: p.z, r: 3 }));
            });
            (sp.objectives || []).forEach(o => B.push({ kind: 'clear', x: o.position.x, z: o.position.z, r: Math.max(5, o.radius * 0.6) }));
        }
    }

    /** Exclusion circles (x, z, r) the GPU grass shader keeps clear. */
    _grassCircles(config) {
        const out = [];
        for (const c of this.blockers) {
            if (c.kind !== 'struct') continue;
            const long = Math.max(c.hw, c.hd), short = Math.min(c.hw, c.hd), r = short + 0.4;
            const n = Math.max(1, Math.ceil((long - short) / Math.max(r * 0.9, 1)) + 1);
            const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
            for (let i = 0; i < n; i++) {
                const t = n === 1 ? 0 : (i / (n - 1) * 2 - 1) * (long - short);
                const lx = c.hw >= c.hd ? t : 0, lz = c.hw >= c.hd ? 0 : t;
                out.push([c.x + lx * cs + lz * sn, c.z - lx * sn + lz * cs, r]);
            }
        }
        for (const c of this._puddleCircles || []) out.push(c);
        return out;
    }

    _isBlocked(x, z, pad = 0, structuresOnly = false) {
        const B = this.blockers;
        for (let i = 0; i < B.length; i++) {
            const c = B[i];
            if (c.kind === 'pathseg') {
                const abx = c.x2 - c.x1, abz = c.z2 - c.z1;
                const t = Math.max(0, Math.min(1, ((x - c.x1) * abx + (z - c.z1) * abz) / (abx * abx + abz * abz)));
                const qx = x - (c.x1 + abx * t), qz = z - (c.z1 + abz * t);
                if (qx * qx + qz * qz < (c.hw + pad) * (c.hw + pad)) return true;
                continue;
            }
            const dx = x - c.x, dz = z - c.z;
            if (c.kind === 'clear') {
                if (structuresOnly) continue;
                const r = c.r + pad;
                if (dx * dx + dz * dz < r * r) return true;
            } else {
                const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
                const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
                if (Math.abs(lx) < c.hw + pad && Math.abs(lz) < c.hd + pad) return true;
            }
        }
        return false;
    }

    // ── material helpers ─────────────────────────────────────────────────
    _calibrateLevelMaterials() {
        this.group.traverse(object => {
            if (!object.isMesh) return;
            object.receiveShadow = true;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach(material => {
                if (!material) return;
                if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
                if (material.normalMap) material.normalMap.colorSpace = THREE.NoColorSpace;
                if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) return;
                material.flatShading = false;
                material.dithering = true;
                if (material.normalMap) material.normalScale.multiplyScalar(material.userData?.foliage ? 0.75 : 1);
                if (material.userData.ssrReflective) return;
                const metal = material.metalness ?? 0;
                const currentEnv = material.envMapIntensity ?? 1;
                material.envMapIntensity = metal > 0.35 ? Math.max(currentEnv, 0.7) : Math.min(currentEnv, 0.5);
                material.roughness = Math.max(material.roughness ?? 0.8, metal > 0.35 ? 0.35 : 0.72);
                material.needsUpdate = true;
            });
        });
    }

    _pbr(tex, opts = {}) {
        const detail = tex?.roughnessMap ? tex : TextureFactory.ground(128, 1);
        const m = new THREE.MeshStandardMaterial({
            color: opts.color ?? 0xffffff,
            map: tex ? tex.map : null,
            normalMap: tex ? tex.normalMap : null,
            roughnessMap: detail.roughnessMap, aoMap: detail.aoMap,
            bumpMap: tex?.normalMap ? null : detail.bumpMap, bumpScale: detail.bumpScale,
            roughness: opts.roughness ?? (tex && tex.roughness) ?? 0.85,
            metalness: opts.metalness ?? (tex && tex.metalness) ?? 0.0, aoMapIntensity: 0.68
        });
        if (opts.envMapIntensity != null) m.envMapIntensity = opts.envMapIntensity;
        this.disposables.push(m);
        return m;
    }

    /** Scale a box's UVs to world metres so textures never stretch. */
    _boxUV(geo, w, h, d, tile = 3) {
        const uv = geo.attributes.uv;
        const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
        for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
            const k = f * 4 + i;
            uv.setXY(k, uv.getX(k) * dims[f][0] / tile, uv.getY(k) * dims[f][1] / tile);
        }
        return geo;
    }

    _box(w, h, d, tile = 3) {
        return this._boxUV(new THREE.BoxGeometry(w, h, d), w, h, d, tile);
    }

    _shadow(mesh, cast = true) {
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        return mesh;
    }

    // ── structures ───────────────────────────────────────────────────────
    _buildLayout(config) {
        const concrete = this._photo('concrete_wall_004', () => TextureFactory.concrete(512, 1));
        const roofTex = this._photo('corrugated_iron_02', () => TextureFactory.corrugated(256, 1));
        this._glass = new THREE.MeshStandardMaterial({ color: 0x0f151b, roughness: 0.12, metalness: 0.85, envMapIntensity: 1.4 });
        this.disposables.push(this._glass);
        for (const item of config.layout || []) this._buildStructure(item, concrete, roofTex, config);
        if (config.streets) City.streets(this, this.deco, config.streets, config.layout || []);
        if (config.skyline) City.skyline(this, this.deco, config.skyline);
    }

    _buildStructure(item, concrete, roofTex, config) {
        const { x, z, w, d, h, type = 'building', rot = 0, color } = item;
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        group.rotation.y = rot;

        const baseColor = new THREE.Color(color ?? config.structureColor ?? 0x8a8a82);
        const brick = this._photo(config.buildingPhoto || 'brick_wall_003', () => TextureFactory.brick(512, 1));
        const wt = type === 'building' ? 2 : 3;   // metres per texture tile
        const wallMat = type === 'building'
            ? this._pbr(brick, { color: new THREE.Color(color ?? config.brickColor ?? 0xd2b4a2), roughness: 0.9 })
            : this._pbr(concrete, { color: baseColor, roughness: 0.92 });
        const addCollider = (m) => { m.updateMatrixWorld(true); this.colliders.push(new THREE.Box3().setFromObject(m)); };

        if (type === 'bunker' || type === 'building') {
            const t = 0.4;
            group.updateMatrixWorld(true);
            const mkWall = (wx, wz, ww, wd, wh = h, wy = h / 2) => {
                const m = new THREE.Mesh(this._box(ww, wh, wd, wt), wallMat);
                m.position.set(wx, wy, wz);
                this._shadow(m);
                group.add(m);
                this.raycastables.push(m);
                group.updateMatrixWorld(true);
                addCollider(m);
                return m;
            };
            mkWall(0, -d / 2, w, t);
            mkWall(-w / 2, 0, t, d);
            mkWall(w / 2, 0, t, d);
            const doorW = 2.2;
            mkWall(-(w / 4 + doorW / 4), d / 2, w / 2 - doorW / 2, t);
            mkWall((w / 4 + doorW / 4), d / 2, w / 2 - doorW / 2, t);
            const lintel = new THREE.Mesh(this._box(doorW, h - 2.2, t, wt), wallMat);
            lintel.position.set(0, 2.2 + (h - 2.2) / 2, d / 2);
            this._shadow(lintel);
            group.add(lintel);
            this.raycastables.push(lintel);

            if (type === 'building') {
                this._gableRoof(group, w, d, h, roofTex, wallMat, baseColor);
                Arch.buildingDetail(this, this.deco, item);
            } else {
                // bunker: flat reinforced slab with parapet
                const slab = new THREE.Mesh(this._box(w + 0.8, 0.45, d + 0.8, 3), wallMat);
                slab.position.set(0, h + 0.1, 0);
                this._shadow(slab);
                group.add(slab);
                this.raycastables.push(slab);
            }
            this.cover.push(new THREE.Vector3(x - w / 2 - 1, 0, z));
            this.cover.push(new THREE.Vector3(x + w / 2 + 1, 0, z));
        } else if (type === 'wall') {
            const m = new THREE.Mesh(this._box(w, h, d, 3), wallMat);
            m.position.set(0, h / 2, 0);
            this._shadow(m);
            group.add(m);
            this.raycastables.push(m);
            group.updateMatrixWorld(true);
            addCollider(m);
            this.cover.push(new THREE.Vector3(x, 0, z + d));
            this.cover.push(new THREE.Vector3(x, 0, z - d));
        } else if (type === 'tower') {
            Arch.tower(this, this.deco, item, baseColor);
        } else if (type === 'block') {
            City.block(this, this.deco, item);
            return;
        }
        this.group.add(group);
    }

    _gableRoof(group, w, d, h, roofTex, wallMat, baseColor) {
        const rise = Math.min(2.2, w * 0.28);
        const over = 0.6;
        const slopeLen = Math.hypot(w / 2 + over, rise);
        const ang = Math.atan2(rise, w / 2 + over);
        const roofMat = this._pbr(roofTex, {
            color: new THREE.Color(baseColor).multiplyScalar(0.62).lerp(new THREE.Color(0x7a4a30), 0.25), roughness: 0.65
        });
        for (const side of [-1, 1]) {
            const geo = this._box(slopeLen, 0.16, d + over * 2, 2);
            const slab = new THREE.Mesh(geo, roofMat);
            slab.rotation.z = -side * ang;
            slab.position.set(side * (w / 4 + over / 2), h + rise / 2 + 0.05, 0);
            this._shadow(slab);
            group.add(slab);
            this.raycastables.push(slab);
        }
        // triangular gable infill on both ends
        const shape = new THREE.Shape();
        shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, rise); shape.closePath();
        const tri = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false });
        for (const e of [-1, 1]) {
            const m = new THREE.Mesh(tri, wallMat);
            m.position.set(0, h, e * (d / 2) - 0.2);
            this._shadow(m);
            group.add(m);
        }
        this.disposables.push(tri);
    }

    _windows(group, w, d, h) {
        const wh = Math.min(1.3, h * 0.28), ww = 1.2, y = Math.min(h - 0.9, 2.1);
        const mk = (px, pz, ry) => {
            const g = new THREE.Mesh(new THREE.BoxGeometry(ww, wh, 0.08), this._glass);
            g.position.set(px, y, pz);
            g.rotation.y = ry;
            group.add(g);
            const frame = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.18, wh + 0.18, 0.06), this._frameMat || (this._frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2a27, roughness: 0.8 })));
            frame.position.copy(g.position); frame.rotation.y = ry;
            frame.translateZ(-0.03);
            group.add(frame);
        };
        const nz = Math.max(1, Math.floor(d / 4.2));
        for (let i = 0; i < nz; i++) {
            const pz = -d / 2 + (i + 0.5) * (d / nz);
            mk(-w / 2 - 0.2, pz, Math.PI / 2);
            mk(w / 2 + 0.2, pz, Math.PI / 2);
        }
        const nx = Math.max(1, Math.floor(w / 4.5));
        for (let i = 0; i < nx; i++) mk(-w / 2 + (i + 0.5) * (w / nx), -d / 2 - 0.2, 0);
    }

    /** Visible barrier ring for biomes with no forest (urban / desert). */
    _buildPerimeterWalls(config) {
        if (!config.perimeterWall) return;
        const cfg = config.perimeterWall;
        const b = this.bounds + 2;
        const tex = this._photo('concrete_wall_004', () => TextureFactory.concrete(512, 1));
        const mat = this._pbr(tex, { color: cfg.color ?? 0xb5b3ac, roughness: 0.92 });
        const segLen = 11, geos = [];
        const rnd = this.rand;
        for (let t = -b; t < b; t += segLen) {
            for (const [x, z, rot] of [[t + segLen / 2, -b, 0], [t + segLen / 2, b, 0], [-b, t + segLen / 2, Math.PI / 2], [b, t + segLen / 2, Math.PI / 2]]) {
                const hh = cfg.height * (0.7 + rnd() * 0.6);
                const g = this._box(segLen + 0.4, hh, 1.6, 3);
                g.rotateY(rot);
                g.translate(x, hh / 2 - 0.2, z);
                geos.push(g);
            }
        }
        const merged = mergeGeometries(geos, false);
        geos.forEach(g => g.dispose());
        const mesh = new THREE.Mesh(merged, mat);
        this._shadow(mesh);
        this.group.add(mesh);
        this.disposables.push(merged);
    }

    // ── vehicles & props ─────────────────────────────────────────────────
    _buildVehicles(config) {
        const camo = TextureFactory.camo(256, 1);
        const metal = TextureFactory.metal(256, 1);
        const tireTex = metal;
        const tire = this._pbr(tireTex, { color: 0x1c1c1e, metalness: 0.05, roughness: 0.95 });
        const dark = this._pbr(metal, { color: 0x2a2d31, metalness: 0.6, roughness: 0.55 });
        const glass = this._glass || new THREE.MeshStandardMaterial({ color: 0x10161c, roughness: 0.1, metalness: 0.8 });
        for (const v of config.vehicles || []) {
            const g = new THREE.Group();
            g.position.set(v.x, 0, v.z);
            g.rotation.y = v.rot || 0;
            const col = new THREE.Color(v.color || 0x5a6244);
            // real CC0 painted-steel scan (tinted to the vehicle colour), not the procedural camo
            const body = this._pbr(this._photo('rusty_metal_02', () => camo), { color: col.clone().multiplyScalar(1.9), roughness: 0.72, metalness: 0.3 });
            const add = (mesh, collide = true) => { this._shadow(mesh); g.add(mesh); if (collide) this.raycastables.push(mesh); return mesh; };

            // chassis, hood, cabin, windshield, bed + tarp ribs
            add(new THREE.Mesh(this._box(2.2, 0.9, 5.4, 2), body)).position.set(0, 1.0, 0);
            add(new THREE.Mesh(this._box(2.0, 0.7, 1.5, 2), body)).position.set(0, 1.55, 1.9);          // hood
            add(new THREE.Mesh(this._box(2.1, 1.25, 1.7, 2), body)).position.set(0, 2.25, 0.55);          // cabin
            const ws = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 0.06), glass);
            ws.position.set(0, 2.35, 1.42); ws.rotation.x = -0.28; add(ws, false);
            for (const sx of [-1.06, 1.06]) {
                const sw = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 1.1), glass);
                sw.position.set(sx, 2.35, 0.55); add(sw, false);
            }
            const bed = add(new THREE.Mesh(this._box(2.1, 0.5, 2.7, 2), dark)); bed.position.set(0, 1.55, -1.7);
            // canvas tarp: open half-cylinder arching over the bed
            const tarp = add(new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 2.6, 10, 1, true, -Math.PI / 2, Math.PI), body));
            tarp.rotation.x = -Math.PI / 2; tarp.position.set(0, 1.8, -1.7);
            const bumper = add(new THREE.Mesh(this._box(2.3, 0.3, 0.3, 2), dark)); bumper.position.set(0, 0.7, 2.75);
            const wheelGeo = new THREE.CylinderGeometry(0.58, 0.58, 0.42, 14);
            [[-1.05, 1.7], [1.05, 1.7], [-1.05, -1.6], [1.05, -1.6]].forEach(([wx, wz]) => {
                const wheel = add(new THREE.Mesh(wheelGeo, tire));
                wheel.rotation.z = Math.PI / 2; wheel.position.set(wx, 0.58, wz);
            });

            if (v.wrecked) {
                g.rotation.z = (this.rand() - 0.5) * 0.16;
                g.rotation.x = (this.rand() - 0.5) * 0.08;
                g.position.y = -0.12;
                body.color.multiplyScalar(0.8);        // sooty
                body.roughness = 0.95;
            }
            g.updateMatrixWorld(true);
            this.colliders.push(new THREE.Box3().setFromObject(g));
            this.cover.push(new THREE.Vector3(v.x + 1.8, 0, v.z));
            this.cover.push(new THREE.Vector3(v.x - 1.8, 0, v.z));
            this.group.add(g);
        }
    }

    _buildProps(config) {
        const wood = this._photo('wood_planks_grey', () => TextureFactory.wood(256, 1));
        const burlap = TextureFactory.burlap(256, 1);
        const corr = this._photo('corrugated_iron_02', () => TextureFactory.corrugated(256, 1));
        const crateMat = this._pbr(wood, { color: 0xd8c4a0 });
        const sandMat = this._pbr(burlap, { color: 0x9c9480 });
        const bagGeo = new THREE.CapsuleGeometry(0.26, 0.62, 3, 8);
        bagGeo.rotateZ(Math.PI / 2);
        bagGeo.scale(1, 0.85, 1.25);

        for (const p of config.props || []) {
            let obj;
            if (p.type === 'crate') {
                obj = new THREE.Mesh(this._box(1.2, 1.2, 1.2, 1.2), crateMat);
                obj.position.set(p.x, 0.6, p.z);
                obj.rotation.y = (p.x * 13.7) % 1;
            } else if (p.type === 'barrel') {
                const m = this._pbr(corr, { color: p.color || 0x7a3b2e, metalness: 0.55, roughness: 0.55 });
                obj = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 14), m);
                obj.position.set(p.x, 0.55, p.z);
            } else if (p.type === 'sandbag') {
                // stacked, staggered sandbag wall: 3 + 2 bags, merged to one mesh
                const parts = [];
                for (let row = 0; row < 3; row++) {
                    const n = row === 2 ? 2 : 3;
                    for (let i = 0; i < n; i++) {
                        const bg = bagGeo.clone();
                        bg.rotateY((this.rand() - 0.5) * 0.15);
                        bg.translate((i - (n - 1) / 2) * 0.95, 0.25 + row * 0.42, (this.rand() - 0.5) * 0.08);
                        parts.push(bg);
                    }
                }
                const merged = mergeGeometries(parts, false);
                parts.forEach(q => q.dispose());
                obj = new THREE.Mesh(merged, sandMat);
                obj.position.set(p.x, 0, p.z);
                obj.rotation.y = p.rot || 0;
                this.disposables.push(merged);
            } else if (p.type === 'container') {
                Arch.container(this, this.deco, p.x, p.z, p.rot || 0, p.color, p.stack || 1);
            } else if (['jersey', 'hesco', 'tires', 'pallet', 'lamp', 'tent', 'crates', 'log', 'stump', 'rubble', 'campfire', 'sign', 'pole', 'barbed', 'spool'].includes(p.type)) {
                Arch.prop(this, this.deco, p);
            }
            if (obj) {
                this._shadow(obj);
                this.group.add(obj);
                this.raycastables.push(obj);
                obj.updateMatrixWorld(true);
                this.colliders.push(new THREE.Box3().setFromObject(obj));
                this.cover.push(new THREE.Vector3(p.x, 0, p.z));
            }
        }
    }

    // ── per-frame ────────────────────────────────────────────────────────
    _update(dt, playerPos, camera) {
        this._time += dt;
        this.sky.update(dt);
        if (this._rippleTime) this._rippleTime.value += dt;
        updateWindTime(this._time);
        if (camera) {
            if (this._rangeCamera !== camera) {
                this._rangeCamera = camera;
                this._originalFars = this._originalFars || new Map();
                if (!this._originalFars.has(camera)) this._originalFars.set(camera, camera.far);
                camera.far = Math.min(this._originalFars.get(camera), this.detail.renderDistance + 8);
                camera.updateProjectionMatrix();
            }
            camera.getWorldPosition(this._camPos);
            camera.getWorldDirection(this._camDir);
        } else if (playerPos) {
            this._camPos.copy(playerPos).setY(1.7);
            this._camDir.set(0, 0, -1);
        }
        if (this.weather) this.weather.update(dt, this._camPos);
        cullProps(this, this._camPos);
        if (this.motes) this.motes.update(dt, this._camPos);
        if (this.mist) for (const m of this.mist) {
            m.position.x += m.userData.v * dt;
            if (m.position.x > this.bounds + 20) m.position.x = -this.bounds - 20;
            if (m.position.x < -this.bounds - 20) m.position.x = this.bounds + 20;
            const distance = Math.hypot(m.position.x - this._camPos.x, m.position.z - this._camPos.z);
            const range = this.detail.weatherDistance * 2;
            m.material.opacity = 0.13 * (1 - THREE.MathUtils.smoothstep(distance, range, range + m.scale.x * 0.5));
            m.visible = m.material.opacity > 0.001;
        }
        for (const s of this.systems) s.update(this._camPos, this._camDir, dt);
    }

    _dispose() {
        if (this._originalFars) {
            for (const [cam, far] of this._originalFars) { cam.far = far; cam.updateProjectionMatrix(); }
            this._originalFars = null;
            this._rangeCamera = null;
        }
        this.systems.forEach(s => s.dispose && s.dispose());
        this.systems = [];
        if (this.weather) this.weather.dispose();
        if (this.motes) this.motes.dispose();
        if (this.mist) this.mist.forEach(m => m.material.dispose());
        this.disposables.forEach(d => d.dispose && d.dispose());
        this.sky.dispose();
    }
}

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
