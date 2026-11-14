import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Biome definitions. Each config fully describes one of Varencia's four
 * regions (GDD section 2.2 / 9.x): palette, terrain, vegetation, structures,
 * vehicles, props, weather, and mission spawn/objective data. The LevelBuilder
 * turns any of these into a playable level, so the four environments stay
 * visually distinct without duplicating build code.
 */

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

export const BIOMES = {
    // ── MISSION 01: MISSING SIGNAL ────────────────────────────────────────
    wildlands: {
        id: 'wildlands',
        name: 'Wildlands',
        grade: { saturation: 0.94, contrast: 1.12, vignette: 0.62 },
        bounds: 88,
        rim: 15,
        photo: ['forest_ground_04', 'leaves_forest_ground', 'brown_mud_leaves_01', 'brick_wall_003', 'concrete_wall_004', 'corrugated_iron_02', 'rusty_metal_02', 'wood_planks_grey', 'gravel_floor_02'],
        hdr: { file: 'kloofendal_overcast_puresky', bg: 0.78, sun: false },
        bump: 0.75,
        groundKind: 'forest',
        groundTile: 3,
        groundTint: 0x766d58,
        groundRoughness: 0.8,
        puddles: 12,
        mist: 9,
        grassPatch: 1.0,
        structureColor: 0x9a9888,
        ambience: 'rain',
        // Broken-cloud light with cool forest shade and warm directional highlights.
        sky: {
            top: 0x465b78, horizon: 0x8497aa, ground: 0x26343b,
            sunColor: 0xd8e6ff, sunIntensity: 2.45,
            sunPosition: new THREE.Vector3(-75, 85, 50),
            hemiSky: 0x9eb7d8, hemiGround: 0x35443f, hemiIntensity: 0.92,
            fogColor: 0x718493, fogDensity: 0.0082,
            cloud: 0.82, cloudColor: 0xd9e5f1, cloudShade: 0x5d6d82, envIntensity: 0.62, exposure: 1.0
        },
        vegetation: {
            count: 1400, ringShare: 0.62, groves: 11, backdrop: 2200,
            mix: [
                { species: 'pine', w: 0.56 }, { species: 'aspen', w: 0.16, variants: 2 },
                { species: 'oak', w: 0.22, variants: 2 }, { species: 'scrub', w: 0.06, variants: 2 }
            ],
            tint: { leaf: 0x557962, bark: 0x625e5a },
            bushTint: { leaf: 0x3c5a45, bark: 0x5c554e },
            grass: 0, bushes: 1500,
            models: { fern: 900, reeds: 320, phFern: 700, phShrub: 260, phNettle: 380, phBranch: 260 },
            field: { count: 60000, ferns: 13750, cover: 15000, litter: 13000, colA: 0x09170e, colB: 0x172619, fernA: 0x08160e, fernB: 0x152619 }
        },
        rocks: { count: 120, pebbles: 750, color: 0x77756e, tint: 0xffffff, minSize: 0.9, maxSize: 2.8, coverSize: 1.4 },
        perimeterRocks: { spacing: 7, min: 4, max: 8 },
        phProps: [
            { id: 'concrete_road_barrier', x: -22, z: -38, rot: 0.05 }, { id: 'concrete_road_barrier', x: -18.6, z: -38.3, rot: -0.05 }, { id: 'cement_bag', x: -21, z: -40.2, rot: 0.3 }, { id: 'cement_bag', x: -20.2, z: -40.4, rot: 1.4 }, { id: 'barrel_03', x: -14.2, z: -40.4, rot: 0 }, { id: 'barrel_03', x: -13.4, z: -39.8, rot: 1 }, { id: 'wooden_crate_01', x: -30, z: -52.4, rot: 0.3 }, { id: 'wooden_crate_02', x: -31.4, z: -52, rot: 1.1 }, { id: 'plastic_crate_01', x: -27.4, z: -58.4, rot: 0.5 }, { id: 'wooden_crate_01', x: -9.6, z: -38, rot: 0.6 }, { id: 'concrete_road_barrier', x: 6, z: 24, rot: 1.57 }, { id: 'concrete_road_barrier', x: 6.2, z: 27.4, rot: 1.57 }, { id: 'cement_bag', x: 7.4, z: 25.6, rot: 0.7 }, { id: 'barrel_03', x: -8, z: 22, rot: 0.2 },
            { id: 'old_military_crate', x: -34, z: -45, rot: 0.3 }, { id: 'ammo_box', x: -32.8, z: -44.4, rot: 1.1 },
            { id: 'ammo_box', x: -32.6, z: -45.3, rot: 0.2 }, { id: 'metal_jerrycan_green', x: -35.1, z: -44.2, rot: 0.6 },
            { id: 'metal_jerrycan_green', x: -35.5, z: -44.5, rot: 2.2 }, { id: 'Barrel_01', x: -36.6, z: -46 },
            { id: 'Barrel_01', x: -37.3, z: -45.4, rot: 1 }, { id: 'wooden_military_crate', x: -31, z: -46.5, rot: -0.4 },
            { id: 'old_military_crate', x: -12, z: -42, rot: 0.3 }, { id: 'ammo_box', x: -10.8, z: -41.4, rot: 1.1 },
            { id: 'ammo_box', x: -10.6, z: -42.3, rot: 0.2 }, { id: 'metal_jerrycan_green', x: -13.1, z: -41.2, rot: 0.6 },
            { id: 'metal_jerrycan_green', x: -13.5, z: -41.5, rot: 2.2 }, { id: 'Barrel_01', x: -14.6, z: -43 },
            { id: 'Barrel_01', x: -15.3, z: -42.4, rot: 1 }, { id: 'wooden_military_crate', x: -9, z: -43.5, rot: -0.4 },
            { id: 'portable_generator', x: -26, z: -61.5, rot: 0.2 }, { id: 'portable_searchlight', x: -19, z: -35.5, rot: 2.6 },
            { id: 'vintage_radio_transceiver', x: -31.6, z: -54.6, rot: 0.4 }, { id: 'medical_box', x: -29.4, z: -55.6, rot: 1.2 },
            { id: 'old_tyre', x: -37, z: -32, rot: 0.3 }, { id: 'old_tyre', x: -8, z: -36, rot: 1.9 }, { id: 'utility_box_01', x: -36.5, z: -51, rot: 0.2 },
            { id: 'stone_fire_pit', x: -36, z: -27 }, { id: 'stone_fire_pit', x: 10, z: -12 },
            { id: 'dead_tree_trunk', x: 26, z: 18, rot: 0.8 }, { id: 'dead_tree_trunk', x: -46, z: 12, rot: 2.3 }
        ],
        phScatter: [
            { id: 'tree_stump_01', count: 7, pad: 3, block: 1.2 }, { id: 'rock_moss_set_01', count: 5, pad: 4, block: 2 },
            { id: 'tree_stump_01', count: 6, pad: 3, block: 1.2 }, { id: 'dead_tree_trunk', count: 6, pad: 4, block: 2.5 }
        ],
        paths: [{ width: 3.4, pts: [[0, 44], [1, 30], [-3, 16], [-9, 2], [-15, -12], [-21, -25], [-26, -37], [-29, -47]] }],
        containers: [
            { x: -8, z: -40, rot: 1.45 }, { x: -8, z: -46.5, rot: 1.6, stack: 2 },
            { x: -52, z: -22, rot: 0.3 }
        ],
        fences: [
            { x1: -50, z1: -68, x2: -6, z2: -68 },
            { x1: -50, z1: -30, x2: -35, z2: -30 }, { x1: -17, z1: -30, x2: -6, z2: -30 }
        ],
        layout: [
            // Abandoned outpost compound (Phase 3)
            { type: 'building', x: -30, z: -55, w: 10, d: 8, h: 4, rot: 0.2 },
            { type: 'bunker', x: -14, z: -62, w: 7, d: 7, h: 3, rot: -0.1 },
            { type: 'building', x: -42, z: -40, w: 8, d: 10, h: 4.5, rot: 0.4 },
            { type: 'tower', x: -22, z: -38, w: 3, d: 3, h: 9 },
            { type: 'wall', x: -50, z: -52, w: 1.2, d: 26, h: 3, rot: 0.2 },
            { type: 'wall', x: -6, z: -50, w: 1.2, d: 22, h: 3, rot: -0.1 }
        ],
        vehicles: [
            { x: 12, z: -20, rot: 0.6, wrecked: true, color: 0x4a5237 },
            { x: -26, z: -30, rot: -0.4, wrecked: true, color: 0x4a5237 },
            { x: 20, z: -48, rot: 1.2, wrecked: false, color: 0x3f4632 }
        ],
        props: [
            { type: 'crate', x: -30, z: -48 }, { type: 'crate', x: -28, z: -47 },
            { type: 'barrel', x: -16, z: -56, color: 0x7a3b2e },
            { type: 'barrel', x: -15, z: -55, color: 0x5a5a3a },
            { type: 'sandbag', x: -22, z: -34, rot: 0.3 },
            { type: 'sandbag', x: -34, z: -44, rot: -0.5 },
            { type: 'container', x: -44, z: -58, rot: 0.2, color: 0x3f5d4a },
            { type: 'jersey', x: -26, z: -26, rot: 0.2, n: 2 }, { type: 'jersey', x: 12, z: -34, rot: 1.2 },
            { type: 'hesco', x: -20, z: -33 }, { type: 'hesco', x: -18.8, z: -33 },
            { type: 'tires', x: -36, z: -33 }, { type: 'tent', x: -38, z: -24, rot: 0.3 },
            { type: 'crates', x: -33, z: -51 }, { type: 'pallet', x: -26, z: -52 },
            { type: 'lamp', x: -24, z: -44 }, { type: 'lamp', x: -4, z: -2 },
            { type: 'log', x: 14, z: 10, rot: 0.7 }, { type: 'log', x: -22, z: 12, rot: 2.1, len: 6.5 }, { type: 'log', x: 30, z: -8, rot: 1.2 },
            { type: 'log', x: -40, z: 2, rot: 0.2, len: 4.5 }, { type: 'stump', x: 8, z: 14 }, { type: 'stump', x: -30, z: 22 },
            { type: 'stump', x: 24, z: -22 }, { type: 'stump', x: -14, z: -8 }, { type: 'rubble', x: -44, z: -46 }, { type: 'rubble', x: -8, z: -56 },
            { type: 'campfire', x: -36, z: -27 }, { type: 'campfire', x: 10, z: -12 }, { type: 'sign', x: 4.5, z: 36, rot: 0.3 }, { type: 'sign', x: -20, z: -22, rot: -0.4 },
            { type: 'pole', x: 5.5, z: 38 }, { type: 'pole', x: 3, z: 10 }, { type: 'pole', x: -11, z: -14 }, { type: 'pole', x: -23, z: -31 },
            { type: 'barbed', x: -46, z: -29, rot: 1.57, len: 5 }, { type: 'barbed', x: -4, z: -29, rot: 1.57, len: 5 }, { type: 'spool', x: -33, z: -47 },
            { type: 'barbed', x: -50, z: -66, rot: 0, len: 4 }, { type: 'spool', x: 4, z: -48 }
        ],
        weather: { kind: 'rain', count: 850, speed: 21, color: 0xd3dde6, opacity: 0.32, streak: 0.9 },
        spawns: {
            player: V3(0, 1.7, 30),
            squad: [
                { x: -3, z: 33, name: 'Hayes' },
                { x: 3, z: 33, name: 'Maya' },
                { x: 0, z: 36, name: 'Ethan' }
            ],
            enemies: [
                { x: -20, z: -30, patrol: [{ x: -20, z: -30 }, { x: -30, z: -45 }] },
                { x: -36, z: -48, patrol: [{ x: -36, z: -48 }, { x: -44, z: -38 }] },
                { x: -12, z: -56, patrol: [{ x: -12, z: -56 }, { x: -22, z: -60 }] },
                { x: 14, z: -24, patrol: [{ x: 14, z: -24 }, { x: 6, z: -34 }] },
                { x: -30, z: -34, patrol: [{ x: -30, z: -34 }, { x: -18, z: -40 }] },
                { x: 22, z: -50, patrol: [{ x: 22, z: -50 }, { x: 10, z: -55 }] }
            ],
            objectives: [
                { id: 'reach', text: 'Reach the abandoned outpost', position: V3(-28, 0, -50), radius: 12 },
                { id: 'evidence', text: 'Recover the recon team recording', position: V3(-30, 0, -55), radius: 6 },
                { id: 'extract', text: 'Fight to the extraction point', position: V3(0, 0, 34), radius: 8 }
            ]
        }
    },

    // ── MISSION 02: BROKEN CONVOY ─────────────────────────────────────────
    dustland: {
        id: 'dustland',
        name: 'Dustland',
        grade: { saturation: 1.02, contrast: 1.1, vignette: 0.5 },
        bounds: 100,
        rim: 11,
        photo: ['sand_01', 'brick_wall_003', 'concrete_wall_004', 'corrugated_iron_02', 'rusty_metal_02', 'wood_planks_grey', 'gravel_floor_02'],
        hdr: { file: 'kloofendal_43d_clear_puresky', bg: 0.8, sun: true },
        bump: 1.0,
        groundPhoto: 'sand_01',
        groundTexture: 'sand',
        groundTile: 3,
        groundTint: 0xc4b698,
        structureColor: 0xc4b08a,
        ambience: 'wind',
        sky: {
            top: 0x3f7cc2, horizon: 0xe0cfa8, ground: 0x6b5a3a,
            sunColor: 0xffe9c4, sunIntensity: 2.0,
            sunPosition: new THREE.Vector3(60, 140, 80),
            hemiSky: 0xa9c4e2, hemiGround: 0x8a7650, hemiIntensity: 1.3,
            fogColor: 0xcdb98e, fogDensity: 0.0040,
            cloud: 0.3, cloudColor: 0xffffff, cloudShade: 0xa9b4c2, envIntensity: 1.0, exposure: 0.95
        },
        vegetation: {
            count: 160, ringShare: 0.4, groves: 5, backdrop: 360,
            mix: [{ species: 'scrub', w: 1, variants: 2 }],
            tint: { leaf: 0xb2a65e, bark: 0xa08a68 },
            grass: 700, grassColor: 0xc2b070, bushes: 240,
            field: { bright: 9, count: 7500, litter: 0, litterA: 0x7a6238, litterB: 0xb09860, colA: 0xa89a52, colB: 0x8a8a44, maskLo: 0.46, maskHi: 0.62 }, bushTint: { leaf: 0x9c9456, bark: 0x7a6a4a }
        },
        rocks: { count: 130, pebbles: 600, color: 0x9a8465, tint: 0xf0dcb8, bright: 2.3, minSize: 1.0, maxSize: 3.2, coverSize: 1.5 },
        perimeterRocks: { spacing: 7, min: 4, max: 8 },
        phProps: [
            { id: 'barrel_03', x: 2, z: -10, rot: 0 }, { id: 'barrel_03', x: 2.8, z: -9.5, rot: 1.2 }, { id: 'concrete_road_barrier', x: -10, z: -8, rot: 0.4 }, { id: 'concrete_road_barrier', x: -7, z: -7, rot: 0.1 }, { id: 'wooden_crate_01', x: -8, z: -18, rot: 0.6 }, { id: 'wooden_crate_02', x: -9.4, z: -17.4, rot: 1.9 }, { id: 'cement_bag', x: -6.6, z: -19, rot: 0.2 }, { id: 'barrel_03', x: 40, z: -48, rot: 0.4 }, { id: 'wooden_crate_01', x: 48.4, z: -48, rot: 0.3 }, { id: 'plastic_crate_01', x: 49.6, z: -47.4, rot: 1.4 }, { id: 'concrete_road_barrier', x: 42, z: -44, rot: 1.57 }, { id: 'metal_trash_can', x: 36, z: -40, rot: 0 }, { id: 'trashbag', x: 36.8, z: -40.4, rot: 1 }, { id: 'fire_hydrant', x: 32, z: -36, rot: 0 },
            { id: 'old_military_crate', x: 36, z: -44, rot: 0.3 }, { id: 'ammo_box', x: 37.2, z: -43.4, rot: 1.1 },
            { id: 'ammo_box', x: 37.4, z: -44.3, rot: 0.2 }, { id: 'metal_jerrycan_green', x: 34.9, z: -43.2, rot: 0.6 },
            { id: 'metal_jerrycan_green', x: 34.5, z: -43.5, rot: 2.2 }, { id: 'Barrel_01', x: 33.4, z: -45 },
            { id: 'Barrel_01', x: 32.7, z: -44.4, rot: 1 }, { id: 'wooden_military_crate', x: 39, z: -45.5, rot: -0.4 },
            { id: 'portable_generator', x: 42, z: -41, rot: 1.2 }, { id: 'old_tyre', x: 30, z: -42 }, { id: 'utility_box_01', x: 38, z: -38 }
        ],
        containers: [
            { x: 56, z: -30, rot: 0, stack: 2 }, { x: 60.6, z: -30, rot: 0, stack: 1 }, { x: 56, z: -37, rot: 0.1 },
            { x: -24, z: -22, rot: 0.9 }, { x: 70, z: -46, rot: 1.57, stack: 2 }
        ],
        fences: [{ x1: 22, z1: -76, x2: 74, z2: -76 }, { x1: 74, z1: -76, x2: 74, z2: -52 }],
        layout: [
            // Industrial facility (Phase 4)
            { type: 'building', x: 40, z: -60, w: 16, d: 12, h: 7, rot: 0 },
            { type: 'building', x: 62, z: -58, w: 10, d: 10, h: 5, rot: 0.1 },
            { type: 'tower', x: 30, z: -70, w: 3, d: 3, h: 12 },
            { type: 'wall', x: 20, z: -55, w: 1.2, d: 30, h: 3.5 },
            { type: 'wall', x: 40, z: -40, w: 40, d: 1.2, h: 3.5 }
        ],
        vehicles: [
            { x: -10, z: -10, rot: 0.2, wrecked: true, color: 0x8a7a55 },
            { x: -4, z: -18, rot: -0.3, wrecked: true, color: 0x8a7a55 },
            { x: 4, z: -6, rot: 0.5, wrecked: true, color: 0x7a6a48 },
            { x: 30, z: -50, rot: 0, wrecked: false, color: 0x8a7a55 }
        ],
        props: [
            { type: 'container', x: 44, z: -48, rot: 0, color: 0xa5552f },
            { type: 'container', x: 50, z: -48, rot: 0, color: 0x3f5d4a },
            { type: 'crate', x: -8, z: -14 }, { type: 'crate', x: -6, z: -13 },
            { type: 'barrel', x: 36, z: -52, color: 0x7a3b2e },
            { type: 'sandbag', x: 0, z: -24, rot: 0.2 },
            { type: 'sandbag', x: 12, z: -20, rot: -0.4 },
            { type: 'jersey', x: 8, z: -2, rot: 0.3, n: 3 }, { type: 'tires', x: -14, z: -8 }, { type: 'tent', x: 14, z: -10, rot: 1.2 },
            { type: 'pallet', x: 38, z: -50 }, { type: 'crates', x: 34, z: -45 }, { type: 'lamp', x: 28, z: -48 }, { type: 'hesco', x: -2, z: -26 },
            { type: 'rubble', x: -20, z: -4 }, { type: 'rubble', x: 16, z: -30 }, { type: 'rubble', x: 52, z: -62 }, { type: 'log', x: 20, z: 20, rot: 0.4 },
            { type: 'pole', x: 6, z: 30 }, { type: 'pole', x: 4, z: 6 }, { type: 'pole', x: 2, z: -16 }, { type: 'sign', x: 8, z: 26 }, { type: 'campfire', x: 18, z: -12 }, { type: 'spool', x: 40, z: -44 }, { type: 'barbed', x: 24, z: -38, rot: 1.57, len: 6 }
        ],
        weather: { kind: 'dust', count: 220, speed: 1.5, color: 0xdcc9a0, size: 0.07, opacity: 0.14, drift: 6 },
        spawns: {
            player: V3(0, 1.7, 40),
            squad: [{ x: -3, z: 43, name: 'Hayes' }, { x: 3, z: 43, name: 'Maya' }, { x: 0, z: 46, name: 'Ethan' }],
            enemies: [
                { x: -6, z: 0, patrol: [{ x: -6, z: 0 }, { x: 6, z: -12 }] },
                { x: 10, z: -14, patrol: [{ x: 10, z: -14 }, { x: -2, z: -20 }] },
                { x: 24, z: -40, patrol: [{ x: 24, z: -40 }, { x: 36, z: -50 }] },
                { x: 44, z: -52, patrol: [{ x: 44, z: -52 }, { x: 54, z: -56 }] },
                { x: 30, z: -62, patrol: [{ x: 30, z: -62 }, { x: 42, z: -66 }] }
            ],
            objectives: [
                { id: 'convoy', text: 'Investigate the destroyed convoy', position: V3(-4, 0, -14), radius: 14 },
                { id: 'facility', text: 'Breach the industrial facility', position: V3(46, 0, -54), radius: 16 },
                { id: 'record', text: "Recover Kane's authorization record", position: V3(44, 0, -58), radius: 6 }
            ]
        }
    },

    // ── MISSION 03: FROZEN EVIDENCE ───────────────────────────────────────
    frostland: {
        id: 'frostland',
        name: 'Frostland',
        grade: { saturation: 0.86, contrast: 1.12, vignette: 0.55 },
        bounds: 90,
        rim: 17,
        photo: ['snow_02', 'brick_wall_003', 'concrete_wall_004', 'corrugated_iron_02', 'rusty_metal_02', 'wood_planks_grey', 'gravel_floor_02'],
        hdr: { file: 'snow_field_puresky', bg: 0.8, sun: false },
        bump: 0.7,
        groundPhoto: 'snow_02',
        groundTexture: 'snow',
        groundTile: 3,
        structureColor: 0xa4aeb8,
        ambience: 'snow',
        sky: {
            top: 0x7f95b0, horizon: 0xc6d1dc, ground: 0x8a949e,
            sunColor: 0xe8f0fa, sunIntensity: 2.1,
            sunPosition: new THREE.Vector3(90, 100, 60),
            hemiSky: 0xd0def0, hemiGround: 0x9aa4ae, hemiIntensity: 1.2,
            fogColor: 0xc6d1dc, fogDensity: 0.0082,
            cloud: 0.7, cloudColor: 0xf2f6fa, cloudShade: 0x9aa8b8, envIntensity: 0.9, exposure: 1.0
        },
        vegetation: {
            count: 760, ringShare: 0.65, groves: 8, backdrop: 1400,
            mix: [{ species: 'pine', w: 1 }],
            tint: { leaf: 0x86a396, bark: 0x6d6258 },
            grass: 0, bushes: 320, bushTint: { leaf: 0x93aa9c, bark: 0x6d6258 },
            field: { bright: 5, count: 5000, colA: 0xb5ad86, colB: 0x8c9478, maskLo: 0.5, maskHi: 0.66 }
        },
        rocks: { count: 120, pebbles: 500, color: 0x8a9098, tint: 0xe4ebf2, bright: 1.5, minSize: 0.9, maxSize: 3.0, coverSize: 1.4 },
        perimeterRocks: { spacing: 7, min: 4, max: 8 },
        phProps: [
            { id: 'barrel_03', x: -12, z: -42, rot: 0.3 }, { id: 'barrel_03', x: -11.2, z: -42.5, rot: 1.1 }, { id: 'wooden_crate_01', x: -17, z: -44, rot: 0.5 }, { id: 'wooden_crate_02', x: -18.4, z: -43.6, rot: 1.6 }, { id: 'concrete_road_barrier', x: -8, z: -38, rot: 1.2 }, { id: 'concrete_road_barrier', x: -6, z: -41, rot: 1.3 }, { id: 'cement_bag', x: -18.4, z: -48, rot: 0.4 }, { id: 'plastic_crate_01', x: -22, z: -46.5, rot: 0.2 }, { id: 'barrel_03', x: 6, z: 28, rot: 0.7 }, { id: 'concrete_road_barrier', x: -6, z: 30, rot: 1.5 },
            { id: 'old_military_crate', x: -6, z: -40, rot: 0.3 }, { id: 'ammo_box', x: -4.8, z: -39.4, rot: 1.1 },
            { id: 'ammo_box', x: -4.6, z: -40.3, rot: 0.2 }, { id: 'metal_jerrycan_green', x: -7.1, z: -39.2, rot: 0.6 },
            { id: 'metal_jerrycan_green', x: -7.5, z: -39.5, rot: 2.2 }, { id: 'Barrel_01', x: -8.6, z: -41 },
            { id: 'Barrel_01', x: -9.3, z: -40.4, rot: 1 }, { id: 'wooden_military_crate', x: -3, z: -41.5, rot: -0.4 },
            { id: 'portable_generator', x: 0, z: -37, rot: 1.2 }, { id: 'old_tyre', x: -12, z: -38 }, { id: 'utility_box_01', x: -4, z: -34 }
        ],
        containers: [{ x: 18, z: -36, rot: 0.2, stack: 2 }, { x: 22, z: -30, rot: 1.4 }, { x: -50, z: -26, rot: 0.5 }],
        fences: [{ x1: -50, z1: -64, x2: 14, z2: -66 }],
        layout: [
            // Research installation
            { type: 'building', x: -20, z: -50, w: 14, d: 12, h: 6, rot: 0 },
            { type: 'bunker', x: 4, z: -58, w: 9, d: 9, h: 4, rot: 0.2 },
            { type: 'building', x: -40, z: -40, w: 10, d: 8, h: 5, rot: -0.2 },
            { type: 'tower', x: -8, z: -38, w: 3, d: 3, h: 11 },
            { type: 'wall', x: -34, z: -56, w: 1.2, d: 24, h: 3 },
            { type: 'wall', x: 12, z: -50, w: 1.2, d: 26, h: 3 }
        ],
        vehicles: [
            { x: -14, z: -30, rot: 0.4, wrecked: true, color: 0x6a747e },
            { x: 10, z: -44, rot: -0.6, wrecked: false, color: 0x7a848e }
        ],
        props: [
            { type: 'crate', x: -22, z: -44 }, { type: 'crate', x: -20, z: -43 },
            { type: 'barrel', x: 2, z: -52, color: 0x5a6a7a },
            { type: 'container', x: -30, z: -50, rot: 0.1, color: 0x6a7a8a },
            { type: 'sandbag', x: -10, z: -34, rot: 0.2 },
            { type: 'jersey', x: -2, z: -28, rot: 0.1, n: 2 }, { type: 'hesco', x: -26, z: -34 }, { type: 'tent', x: 20, z: -48, rot: 0.6 },
            { type: 'lamp', x: -12, z: -46 }, { type: 'tires', x: -28, z: -30 },
            { type: 'log', x: 12, z: 6, rot: 1.0 }, { type: 'log', x: -24, z: 14, rot: 2.4 }, { type: 'stump', x: 16, z: -6 }, { type: 'rubble', x: 6, z: -40 },
            { type: 'pole', x: 4, z: 26 }, { type: 'pole', x: -8, z: -12 }, { type: 'sign', x: 6, z: 28 }, { type: 'campfire', x: 14, z: -44 }, { type: 'barbed', x: -34, z: -38, rot: 0, len: 6 }
        ],
        weather: { kind: 'snow', count: 1600, speed: 2.4, color: 0xffffff, size: 0.2, opacity: 0.9, drift: 3, sway: 0.9 },
        spawns: {
            player: V3(0, 1.7, 34),
            squad: [{ x: -3, z: 37, name: 'Maya' }, { x: 3, z: 37, name: 'Ethan' }],
            enemies: [
                { x: -10, z: -20, patrol: [{ x: -10, z: -20 }, { x: -18, z: -34 }] },
                { x: 8, z: -30, patrol: [{ x: 8, z: -30 }, { x: -2, z: -42 }] },
                { x: -24, z: -44, patrol: [{ x: -24, z: -44 }, { x: -34, z: -50 }] },
                { x: 0, z: -52, patrol: [{ x: 0, z: -52 }, { x: 8, z: -56 }] },
                { x: -18, z: -54, patrol: [{ x: -18, z: -54 }, { x: -8, z: -58 }] }
            ],
            objectives: [
                { id: 'approach', text: 'Reach the research installation', position: V3(-14, 0, -46), radius: 16 },
                { id: 'records', text: 'Recover the classified records', position: V3(-20, 0, -50), radius: 8 },
                { id: 'escape', text: 'Escape the facility assault', position: V3(0, 0, 36), radius: 10 }
            ]
        }
    },

    // ── MISSIONS 04 & 05: DEADZONE ────────────────────────────────────────
    deadzone: {
        id: 'deadzone',
        name: 'Deadzone',
        grade: { saturation: 0.9, contrast: 1.14, vignette: 0.6 },
        buildingPhoto: 'red_brick_03', brickColor: 0xe6dcd0,
        groundMud: 'concrete_floor_worn_001', groundLitter: 'asphalt_02',
        bounds: 92,
        rim: 5,
        photo: ['red_brick_03', 'concrete_tile_facade', 'concrete_floor_worn_001', 'asphalt_02', 'worn_asphalt', 'brick_wall_003', 'concrete_wall_004', 'corrugated_iron_02', 'rusty_metal_02', 'wood_planks_grey', 'gravel_floor_02'],
        hdr: { file: 'overcast_soil_puresky', bg: 0.85, sun: false },
        bump: 0.14,
        groundPhoto: 'asphalt_02',
        groundTexture: 'asphalt',
        groundTile: 3,
        structureColor: 0x8d8b84,
        ambience: 'wind',
        sky: {
            top: 0x58616e, horizon: 0x9b9890, ground: 0x2a2824,
            sunColor: 0xf2e6d2, sunIntensity: 1.9,
            sunPosition: new THREE.Vector3(70, 90, 50),
            hemiSky: 0xa8aeb8, hemiGround: 0x5a564c, hemiIntensity: 1.1,
            fogColor: 0x9a978f, fogDensity: 0.0075,
            cloud: 0.85, cloudColor: 0xc8c8c4, cloudShade: 0x7c7c7c, envIntensity: 0.8, exposure: 1.25
        },
        vegetation: {
            count: 140, ringShare: 0.7, backdrop: 150,
            mix: [{ species: 'scrub', w: 1, variants: 2 }],
            tint: { leaf: 0x767b4b, bark: 0x746b5c }, bushes: 180,
            field: { bright: 7, count: 3500, litter: 450, colA: 0x68734b, colB: 0x8b8558, maskLo: 0.52, maskHi: 0.7 }
        },
        rocks: { count: 90, pebbles: 500, color: 0x6a6862, tint: 0xd8d4cc, bright: 1.8, minSize: 0.8, maxSize: 2.4, coverSize: 1.3 },
        perimeterRocks: { spacing: 10, min: 2.5, max: 4.5 },
        perimeterWall: { height: 8, color: 0x85837c },
        phProps: [
            { id: 'concrete_road_barrier', x: -14, z: -36, rot: 0.05 }, { id: 'concrete_road_barrier', x: -10.6, z: -36.4, rot: -0.05 }, { id: 'covered_car', x: 22, z: -20, rot: 1.2 }, { id: 'covered_car', x: -26, z: -6, rot: 0.4 }, { id: 'fire_hydrant', x: -18, z: -20, rot: 0 }, { id: 'fire_hydrant', x: 16, z: -12, rot: 0 }, { id: 'metal_trash_can', x: -8, z: -26, rot: 0 }, { id: 'metal_trash_can', x: 10, z: -34, rot: 0.6 }, { id: 'metal_trash_can', x: -22, z: -14, rot: 1 }, { id: 'trashbag', x: -8.6, z: -26.4, rot: 0.3 }, { id: 'trashbag', x: 10.7, z: -33.6, rot: 1.2 }, { id: 'power_box_01', x: 24, z: -27, rot: 1.57 }, { id: 'utility_box_02', x: -28, z: -16, rot: 0 }, { id: 'wooden_crate_01', x: -33, z: -22, rot: 0.3 }, { id: 'wooden_crate_02', x: -34.4, z: -21.6, rot: 1.5 }, { id: 'barrel_03', x: -26, z: -22, rot: 0.4 }, { id: 'plastic_crate_01', x: -32, z: -23.4, rot: 0.8 }, { id: 'cement_bag', x: -13, z: -37.6, rot: 0.5 }, { id: 'concrete_road_barrier_02', x: 8, z: -52, rot: 0.2 },
            { id: 'old_military_crate', x: -12, z: -44, rot: 0.3 }, { id: 'ammo_box', x: -10.8, z: -43.4, rot: 1.1 },
            { id: 'ammo_box', x: -10.6, z: -44.3, rot: 0.2 }, { id: 'metal_jerrycan_green', x: -13.1, z: -43.2, rot: 0.6 },
            { id: 'metal_jerrycan_green', x: -13.5, z: -43.5, rot: 2.2 }, { id: 'Barrel_01', x: -14.6, z: -45 },
            { id: 'Barrel_01', x: -15.3, z: -44.4, rot: 1 }, { id: 'wooden_military_crate', x: -9, z: -45.5, rot: -0.4 },
            { id: 'portable_generator', x: -6, z: -41, rot: 1.2 }, { id: 'old_tyre', x: -18, z: -42 }, { id: 'utility_box_01', x: -10, z: -38 }
        ],
        containers: [
            { x: -44, z: -6, rot: 0.1, stack: 2 }, { x: -44, z: 1, rot: 0.1 }, { x: 40, z: -14, rot: 1.5, stack: 2 },
            { x: 44, z: -30, rot: 0.2 }, { x: -6, z: -30, rot: 1.57, stack: 1 }
        ],
        fences: [{ x1: -34, z1: -62, x2: -16, z2: -62 }, { x1: 16, z1: -62, x2: 34, z2: -62 }],
        layout: [
            // Urban blocks + HQ
            { type: 'building', x: -30, z: -30, w: 12, d: 12, h: 10, rot: 0 },
            { type: 'building', x: 20, z: -34, w: 14, d: 12, h: 12, rot: 0.1 },
            { type: 'building', x: -34, z: 10, w: 10, d: 14, h: 8, rot: -0.1 },
            { type: 'building', x: 26, z: 8, w: 12, d: 10, h: 9, rot: 0.2 },
            // Communications HQ (Mission 05 objective)
            { type: 'building', x: 0, z: -70, w: 20, d: 16, h: 14, rot: 0, color: 0x6a6862 },
            { type: 'tower', x: -14, z: -70, w: 4, d: 4, h: 20 },
            { type: 'tower', x: 14, z: -70, w: 4, d: 4, h: 20 },
            { type: 'wall', x: -10, z: -50, w: 30, d: 1.2, h: 4 },
            { type: 'wall', x: 14, z: -50, w: 1.2, d: 20, h: 4 }
        ],
        vehicles: [
            { x: -8, z: -10, rot: 0.8, wrecked: true, color: 0x5a5852 },
            { x: 6, z: -16, rot: -0.5, wrecked: true, color: 0x4a4842 },
            { x: -20, z: -48, rot: 0.2, wrecked: true, color: 0x5a5852 },
            { x: 18, z: -52, rot: -0.3, wrecked: false, color: 0x4a5237 }
        ],
        props: [
            { type: 'container', x: -24, z: -46, rot: 0.3, color: 0xa5552f },
            { type: 'crate', x: 0, z: -56 }, { type: 'crate', x: 2, z: -55 },
            { type: 'barrel', x: -12, z: -52, color: 0x7a3b2e },
            { type: 'barrel', x: 10, z: -48, color: 0x5a5a3a },
            { type: 'sandbag', x: -6, z: -44, rot: 0.1 },
            { type: 'sandbag', x: 8, z: -46, rot: -0.2 },
            { type: 'jersey', x: -16, z: -38, rot: 0.1, n: 3 }, { type: 'jersey', x: 12, z: -38, rot: -0.1, n: 2 },
            { type: 'hesco', x: -4, z: -40 }, { type: 'hesco', x: -2.8, z: -40 }, { type: 'tires', x: 4, z: -30 },
            { type: 'lamp', x: -18, z: -20 }, { type: 'lamp', x: 18, z: -20 }, { type: 'pallet', x: 24, z: -26 }, { type: 'crates', x: -26, z: -20 },
            { type: 'rubble', x: -10, z: -8 }, { type: 'rubble', x: 12, z: -12 }, { type: 'rubble', x: -38, z: -18 }, { type: 'rubble', x: 34, z: -22 },
            { type: 'rubble', x: 8, z: -60 }, { type: 'rubble', x: -22, z: 8 }, { type: 'rubble', x: 30, z: 14 },
            { type: 'pole', x: -20, z: 20 }, { type: 'pole', x: 18, z: 10 }, { type: 'pole', x: -4, z: -24 }, { type: 'sign', x: 0, z: 30 }, { type: 'sign', x: -14, z: -40 },
            { type: 'barbed', x: -10, z: -43, rot: 1.57, len: 6 }, { type: 'campfire', x: 22, z: -40 }, { type: 'spool', x: 28, z: -34 }
        ],
        weather: { kind: 'dust', count: 180, speed: 1.2, color: 0xb4ae9e, size: 0.07, opacity: 0.14, drift: 4 },
        spawns: {
            player: V3(0, 1.7, 40),
            squad: [{ x: -3, z: 43, name: 'Maya' }, { x: 3, z: 43, name: 'Ethan' }, { x: 0, z: 46, name: 'Hayes' }],
            enemies: [
                { x: -10, z: 0, patrol: [{ x: -10, z: 0 }, { x: -20, z: -20 }] },
                { x: 12, z: -6, patrol: [{ x: 12, z: -6 }, { x: 4, z: -22 }] },
                { x: -22, z: -40, patrol: [{ x: -22, z: -40 }, { x: -30, z: -50 }] },
                { x: 16, z: -44, patrol: [{ x: 16, z: -44 }, { x: 8, z: -54 }] },
                { x: -4, z: -58, patrol: [{ x: -4, z: -58 }, { x: 6, z: -64 }] },
                { x: 0, z: -66, patrol: [{ x: 0, z: -66 }, { x: -10, z: -70 }] }
            ],
            objectives: [
                { id: 'checkpoint', text: 'Push through the last checkpoint', position: V3(0, 0, -46), radius: 16 },
                { id: 'hq', text: 'Breach the communications HQ', position: V3(0, 0, -68), radius: 18 },
                { id: 'broadcast', text: 'Defend the broadcast until upload completes', position: V3(0, 0, -70), radius: 10 }
            ]
        }
    },

    // ── EPISODE 06: CITY UNDER FIRE ───────────────────────────────────────
    // Dense dusk-lit downtown built from the procedural CityKit: multi-storey
    // blocks with shopfronts and lit windows, sidewalks, lane markings and a
    // skyline ring beyond the perimeter.
    city: {
        id: 'city',
        name: 'Veyra City',
        grade: { saturation: 1.08, contrast: 1.1, vignette: 0.5 },
        bounds: 78,
        rim: 2,
        photo: ['asphalt_02', 'brick_wall_003', 'concrete_wall_004', 'corrugated_iron_02', 'rusty_metal_02', 'wood_planks_grey', 'gravel_floor_02',
            // CC0 Poly Haven PBR city set (public/assets/textures/city)
            'red_brick_03', 'painted_plaster_wall', 'grey_plaster_02', 'yellow_plaster', 'concrete_tile_facade',
            'rectangular_facade_tiles', 'precast_concrete_wall', 'concrete_pavers_02', 'concrete_floor_02', 'concrete_floor_worn_001', 'metal_plate'],
        hdr: { file: 'kloppenheim_06_puresky', bg: 0.8, sun: true, fogMul: 1.0 },
        groundTint: 0xffffff,
        groundMud: 'concrete_floor_worn_001', groundLitter: 'asphalt_02',
        bump: 0.05,
        groundPhoto: 'asphalt_02',
        groundTexture: 'asphalt',
        groundTile: 3,
        structureColor: 0x8d8b84,
        ambience: 'city',
        sky: {
            top: 0x3d4a66, horizon: 0xd99a6a, ground: 0x2a2420,
            sunColor: 0xffa458, sunIntensity: 3.2,
            sunPosition: new THREE.Vector3(-110, 38, 70),
            hemiSky: 0xc4b8c4, hemiGround: 0x6a5446, hemiIntensity: 1.3,
            fogColor: 0xb08a72, fogDensity: 0.0068,
            cloud: 0.6, cloudColor: 0xf0c8a8, cloudShade: 0x6a5a62, envIntensity: 1.1, exposure: 1.55
        },
        vegetation: {
            count: 0, ringShare: 0, backdrop: 0,
            mix: [{ species: 'scrub', w: 1, variants: 2 }],
            tint: { leaf: 0x6b7448, bark: 0x6a5f50 }, bushes: 0,
            field: { count: 120, litter: 0, colA: 0x5d6640, colB: 0x7d7650, maskLo: 0.6, maskHi: 0.78 }
        },
        rocks: { count: 0, pebbles: 0, color: 0x6a6862, tint: 0xd8d4cc, bright: 1.8, minSize: 0.6, maxSize: 1.4, coverSize: 1.1 },
        perimeterWall: { height: 9, color: 0x85837c },
        skyline: { radius: 128, count: 46, maxHeight: 72, seed: 6 },
        // open streets need to see the skyline: longer view range, thin dusk haze
        view: { renderDistance: 200, maxRenderDistance: 220, fogDensity: 0.0058, shadowDistance: 70, shadowExtent: 58 },
        streets: {
            sidewalk: 2.6,
            lanes: [
                { x1: 0, z1: 76, x2: 0, z2: -76, yellow: true },
                { x1: -76, z1: 30, x2: 76, z2: 30 },
                { x1: -76, z1: -14, x2: 76, z2: -14 }
            ],
            crossings: [{ x: 0, z: 38 }, { x: 0, z: 22 }, { x: 0, z: -6 }, { x: 0, z: -22 },
                { x: -14, z: 30, rot: Math.PI / 2 }, { x: 14, z: 30, rot: Math.PI / 2 },
                { x: -14, z: -14, rot: Math.PI / 2 }, { x: 14, z: -14, rot: Math.PI / 2 }]
        },
        phProps: [
            { id: 'covered_car', x: -3, z: 42, rot: 0.30 }, { id: 'covered_car', x: 5, z: 14, rot: -0.40 }, { id: 'covered_car', x: -28, z: 30, rot: 1.40 }, { id: 'covered_car', x: 30, z: -13, rot: 1.70 }, { id: 'covered_car', x: -2, z: -30, rot: 0.20 }, { id: 'covered_car', x: 13, z: -55, rot: 1.57 }, { id: 'covered_car', x: -14, z: 20, rot: 0.05 }, { id: 'covered_car', x: 15, z: 44, rot: 3.14 }, { id: 'covered_car', x: -16, z: -2, rot: 0.10 }, { id: 'covered_car', x: 17, z: -22, rot: 3.24 },
            { id: 'painted_wooden_bench', x: -11.4, z: 36, rot: 1.57 }, { id: 'painted_wooden_bench', x: 11.6, z: 6, rot: -1.57 }, { id: 'painted_wooden_bench', x: -11.4, z: -18, rot: 1.57 }, { id: 'wooden_crate_01', x: 7.5, z: -64.6, rot: 0.5 }, { id: 'wooden_crate_02', x: 6.2, z: -64.2, rot: 1.3 }, { id: 'plastic_crate_02', x: -5.4, z: -64.5, rot: 0.2 }, { id: 'modular_chainlink_fence', x: -24, z: -58, rot: 0 }, { id: 'modular_chainlink_fence', x: 24, z: -58, rot: 0 }, { id: 'street_lamp_02', x: -10.4, z: 62, rot: 1.57 }, { id: 'street_lamp_02', x: 10.8, z: 60, rot: -1.57 },
            { id: 'street_lamp_01', x: -10.2, z: 56, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: 47, rot: -1.5707963267948966 },
            { id: 'street_lamp_01', x: -10.2, z: 38, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: 29, rot: -1.5707963267948966 },
            { id: 'street_lamp_01', x: -10.2, z: 20, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: 11, rot: -1.5707963267948966 },
            { id: 'street_lamp_01', x: -10.2, z: 2, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: -7, rot: -1.5707963267948966 },
            { id: 'street_lamp_01', x: -10.2, z: -16, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: -25, rot: -1.5707963267948966 },
            { id: 'street_lamp_01', x: -10.2, z: -34, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: -43, rot: -1.5707963267948966 },
            { id: 'street_lamp_01', x: -10.2, z: -50, rot: 1.5707963267948966 },
            { id: 'street_lamp_01', x: 10.6, z: -59, rot: -1.5707963267948966 },
            { id: 'concrete_road_barrier', x: -10, z: -56, rot: 0 },
            { id: 'concrete_road_barrier', x: -6.5, z: -56, rot: 0 },
            { id: 'concrete_road_barrier', x: -3, z: -56, rot: 0 },
            { id: 'concrete_road_barrier', x: 3, z: -56, rot: 0 },
            { id: 'concrete_road_barrier', x: 6.5, z: -56, rot: 0 },
            { id: 'concrete_road_barrier', x: 10, z: -56, rot: 0 },
            { id: 'concrete_road_barrier_02', x: -14, z: -59, rot: 0.4 },
            { id: 'concrete_road_barrier_02', x: 14, z: -59, rot: -0.4 },
            { id: 'cement_bag', x: -8, z: -60, rot: 0.2 },
            { id: 'cement_bag', x: -7.3, z: -60.4, rot: 1.2 },
            { id: 'cement_bag', x: 8.2, z: -60.2, rot: 0.6 },
            { id: 'old_military_crate', x: -9, z: -64, rot: 0.3 },
            { id: 'ammo_box', x: -7.8, z: -63.4, rot: 1.1 },
            { id: 'metal_jerrycan_green', x: -10.1, z: -63.2, rot: 0.6 },
            { id: 'barrel_03', x: 9.6, z: -64, rot: 0 },
            { id: 'barrel_03', x: 10.4, z: -63.3, rot: 1 },
            { id: 'wooden_military_crate', x: 8, z: -66, rot: -0.4 },
            { id: 'portable_generator', x: -12, z: -67, rot: 1.2 },
            { id: 'portable_searchlight', x: 4, z: -58, rot: 3 },
            { id: 'concrete_road_barrier', x: -10, z: 25.5, rot: 1.2 },
            { id: 'concrete_road_barrier', x: -7, z: 27, rot: 1.2 },
            { id: 'concrete_road_barrier_02', x: 9, z: 27, rot: 1.4 },
            { id: 'concrete_road_barrier', x: -33, z: -18, rot: 0.2 },
            { id: 'concrete_road_barrier', x: -29.6, z: -18.4, rot: 0.1 },
            { id: 'medical_box', x: -41, z: -22.5, rot: 0.4 },
            { id: 'vintage_radio_transceiver', x: -38.5, z: -23, rot: 1.2 },
            { id: 'plastic_crate_01', x: -36, z: -23.5, rot: 0.3 },
            { id: 'plastic_crate_01', x: -36.2, z: -23.4, rot: 1.6 },
            { id: 'cardboard_box_01', x: -44, z: -23, rot: 0.7 },
            { id: 'covered_car', x: -12.5, z: 46, rot: 0.05 },
            { id: 'covered_car', x: 12.8, z: 30, rot: 3.241592653589793 },
            { id: 'covered_car', x: -12.4, z: -8, rot: 0 },
            { id: 'covered_car', x: 33, z: -14.5, rot: 1.62 },
            { id: 'fire_hydrant', x: -10.4, z: 44, rot: 0 },
            { id: 'fire_hydrant', x: 10.8, z: 14, rot: 0 },
            { id: 'fire_hydrant', x: -10.4, z: -22, rot: 0 },
            { id: 'fire_hydrant', x: 10.8, z: -44, rot: 0 },
            { id: 'fire_hydrant', x: -26, z: 31.8, rot: 0 },
            { id: 'fire_hydrant', x: 26, z: -15.8, rot: 0 },
            { id: 'metal_trash_can', x: -11, z: 60, rot: 0.3 },
            { id: 'metal_trash_can', x: 11.2, z: 52, rot: 1.2 },
            { id: 'metal_trash_can', x: -11, z: 4, rot: 2 },
            { id: 'metal_trash_can', x: 11.2, z: -10, rot: 0.4 },
            { id: 'metal_trash_can', x: -11, z: -40, rot: 1 },
            { id: 'metal_trash_can', x: -30, z: 18.6, rot: 0.2 },
            { id: 'metal_trash_can', x: 30, z: 18.6, rot: 2.2 },
            { id: 'metal_trash_can', x: 24, z: -42, rot: 0.6 },
            { id: 'trashbag', x: -11.6, z: 59, rot: 0.2 },
            { id: 'trashbag', x: -11.2, z: 61, rot: 2 },
            { id: 'trashbag', x: 11.6, z: 53, rot: 1 },
            { id: 'trashbag', x: -11.5, z: 3, rot: 0.4 },
            { id: 'trashbag', x: -31, z: 19, rot: 1.3 },
            { id: 'trashbag', x: 29, z: 19.4, rot: 0.7 },
            { id: 'trashbag', x: -42, z: -21.5, rot: 0.2 },
            { id: 'trashbag', x: -43, z: -22, rot: 2.4 },
            { id: 'power_box_01', x: -11.4, z: 30.8, rot: 0 },
            { id: 'power_box_01', x: 11.6, z: -26, rot: 3.141592653589793 },
            { id: 'power_box_01', x: -30, z: -15.6, rot: 1.5707963267948966 },
            { id: 'power_box_01', x: 30, z: 32, rot: 0 },
            { id: 'utility_box_02', x: -11.2, z: 26, rot: 0 },
            { id: 'utility_box_02', x: 11.4, z: 22, rot: 0 },
            { id: 'utility_box_02', x: -11.2, z: -12, rot: 0 },
            { id: 'utility_box_02', x: 11.4, z: -18, rot: 0 },
            { id: 'planter_box_01', x: -11, z: 50, rot: 0 },
            { id: 'planter_box_01', x: 11.4, z: 40, rot: 0 },
            { id: 'planter_box_01', x: -11, z: 10, rot: 0 },
            { id: 'planter_box_01', x: 11.4, z: -2, rot: 0 },
            { id: 'planter_box_01', x: -11, z: -28, rot: 0 },
            { id: 'planter_box_01', x: 11.4, z: -36, rot: 0 },
            { id: 'old_tyre', x: -18, z: 34, rot: 0 },
            { id: 'old_tyre', x: 26, z: 36, rot: 1.1 }
        ],
        layout: [
            // south row (start)
            { type: 'block', x: -21, z: 52, w: 18, d: 24, h: 14, style: 'apartment' },
            { type: 'block', x: 21, z: 50, w: 16, d: 22, h: 17, style: 'apartment' },
            { type: 'block', x: -45, z: 54, w: 18, d: 22, h: 20, style: 'office' },
            { type: 'block', x: 45, z: 52, w: 18, d: 24, h: 11, style: 'apartment' },
            // market district
            { type: 'block', x: -21, z: 8, w: 18, d: 22, h: 23, style: 'apartment' },
            { type: 'block', x: 21, z: 8, w: 18, d: 20, h: 26, style: 'office' },
            { type: 'block', x: -45, z: 6, w: 18, d: 20, h: 14, style: 'apartment' },
            { type: 'block', x: 45, z: 8, w: 16, d: 22, h: 18, style: 'office' },
            // west block: civilians shelter in the low brick hall
            { type: 'building', x: -40, z: -31, w: 12, d: 10, h: 5, rot: 0 },
            { type: 'block', x: -20, z: -33, w: 14, d: 18, h: 17, style: 'apartment' },
            { type: 'block', x: 22, z: -31, w: 18, d: 20, h: 20, style: 'office' },
            { type: 'block', x: 46, z: -33, w: 14, d: 18, h: 13, style: 'apartment' },
            // checkpoint plaza
            { type: 'block', x: -34, z: -66, w: 22, d: 12, h: 11, style: 'apartment' },
            { type: 'block', x: 34, z: -66, w: 22, d: 12, h: 15, style: 'office' },
            // north end closes the avenue: the checkpoint sits in front of a civic block
            { type: 'block', x: -12, z: -75.5, w: 22, d: 7, h: 18, style: 'office', shops: false },
            { type: 'block', x: 12, z: -75.5, w: 22, d: 7, h: 24, style: 'office', shops: false },
            { type: 'block', x: -56, z: -66, w: 14, d: 12, h: 14, style: 'apartment' },
            { type: 'block', x: 56, z: -66, w: 14, d: 12, h: 19, style: 'apartment' },
            // outer ring fills the skyline inside the wall
            { type: 'block', x: -68, z: 30, w: 14, d: 40, h: 22, style: 'office' },
            { type: 'block', x: 68, z: -10, w: 14, d: 48, h: 25, style: 'office' },
            { type: 'block', x: -68, z: -40, w: 14, d: 30, h: 16, style: 'apartment' },
            { type: 'block', x: 68, z: 46, w: 14, d: 28, h: 12, style: 'apartment' }
        ],
        vehicles: [],
        props: [
            { type: 'hesco', x: -2, z: -58 }, { type: 'hesco', x: 2, z: -58 },
            { type: 'sandbag', x: -8, z: -61.5, rot: 0.1 }, { type: 'sandbag', x: 8, z: -61.5, rot: -0.2 },
            { type: 'barbed', x: -16, z: -56, rot: 0, len: 6 }, { type: 'barbed', x: 16, z: -56, rot: 0, len: 6 },
            { type: 'sandbag', x: 9, z: 24.5, rot: 1.4 }, { type: 'sandbag', x: -46, z: -20, rot: 0 },
            { type: 'sign', x: 12, z: 62, rot: 0.3 }, { type: 'sign', x: -12, z: -52 }, { type: 'campfire', x: -36, z: -46 }
        ],
        weather: { kind: 'dust', count: 220, speed: 1.0, color: 0xd8b494, size: 0.06, opacity: 0.16, drift: 3 },
        spawns: {
            player: V3(0, 1.7, 64),
            squad: [{ x: -3, z: 67, name: 'Maya' }, { x: 3, z: 67, name: 'Ethan' }, { x: 0, z: 70, name: 'Reyes' }],
            enemies: [
                { x: -4, z: 30, patrol: [{ x: -4, z: 30 }, { x: -30, z: 27 }] },
                { x: 6, z: 20, patrol: [{ x: 6, z: 20 }, { x: 6, z: -4 }] },
                { x: 30, z: 28, patrol: [{ x: 30, z: 28 }, { x: 12, z: 32 }] },
                { x: -30, z: -12, patrol: [{ x: -30, z: -12 }, { x: -10, z: -14 }] },
                { x: 30, z: -15, patrol: [{ x: 30, z: -15 }, { x: 10, z: -12 }] },
                { x: -48, z: -18, patrol: [{ x: -48, z: -18 }, { x: -54, z: -10 }] },
                { x: 4, z: -40, patrol: [{ x: 4, z: -40 }, { x: -6, z: -48 }] },
                { x: -8, z: -62, patrol: [{ x: -8, z: -62 }, { x: -20, z: -56 }] },
                { x: 10, z: -66, patrol: [{ x: 10, z: -66 }, { x: 22, z: -54 }] }
            ],
            objectives: [
                { id: 'city_entry', text: 'Secure the Market Street intersection', position: V3(0, 0, 30), radius: 12 },
                { id: 'civilians', text: 'Reach the civilians in the west hall', position: V3(-40, 0, -22), radius: 7 },
                { id: 'checkpoint', text: 'Escort the civilians to the north checkpoint', position: V3(0, 0, -62), radius: 10 }
            ]
        }
    }
};

/**
 * Season 1 episode list. Every entry is one monthly episode: its biome, story
 * metadata (recap shown in the briefing, release month) and per-episode
 * overrides for the squad and objectives when two episodes share a map.
 * Upcoming episodes live in src/story/Story.js (UPCOMING) until they ship.
 */
export const MISSIONS = [
    { id: 1, code: '01', episode: 1, title: 'Missing Signal', biome: 'wildlands', region: 'Wildlands', length: '25 min', act: 'EPISODE 01', released: '2026-06-01',
      briefing: 'A reconnaissance team vanished near an abandoned outpost. Deploy with your squad, locate them, and recover their intelligence.',
      objectives: ['Reach the abandoned outpost', 'Recover the recon team recording', 'Fight to the extraction point'] },
    { id: 2, code: '02', episode: 2, title: 'Broken Convoy', biome: 'dustland', region: 'Dustland', length: '30 min', act: 'EPISODE 02', released: '2026-07-01',
      briefing: 'A military supply convoy is under attack in the desert. Survive the ambush and trace the stolen equipment to an industrial facility.',
      objectives: ['Investigate the destroyed convoy', 'Breach the industrial facility', "Recover Kane's authorization record"] },
    { id: 3, code: '03', episode: 3, title: 'Frozen Evidence', biome: 'frostland', region: 'Frostland', length: '30 min', act: 'EPISODE 03', released: '2026-08-01',
      briefing: 'Infiltrate an abandoned arctic research installation and recover classified records before the enemy destroys them. Hayes covers you from the ridge.',
      objectives: ['Reach the research installation', 'Recover the classified records', 'Escape the facility assault'] },
    { id: 4, code: '04', episode: 4, title: 'Deadzone Entry', biome: 'deadzone', region: 'Deadzone', length: '25 min', act: 'EPISODE 04', released: '2026-09-01',
      briefing: 'Enter the abandoned urban sector, fight through Kane\'s checkpoints, and pull Hayes out of the detention block before his execution.',
      objectives: ['Push through the last checkpoint', 'Locate Hayes in the detention block', 'Move on the communications HQ'],
      squad: [{ x: -3, z: 43, name: 'Maya' }, { x: 3, z: 43, name: 'Ethan' }],
      joins: { 1: { name: 'Hayes' } },
      objectiveSpawns: [
          { id: 'checkpoint', text: 'Push through the last checkpoint', position: V3(0, 0, -40), radius: 16 },
          { id: 'detention', text: 'Locate Hayes in the detention block', position: V3(-30, 0, -21), radius: 8 },
          { id: 'hq', text: 'Move on the communications HQ', position: V3(0, 0, -58), radius: 14 }
      ] },
    { id: 5, code: '05', episode: 5, title: 'Operation Blackout', biome: 'deadzone', region: 'Deadzone', length: '35 min', act: 'EPISODE 05', released: '2026-10-01',
      briefing: 'Assault the communications HQ, defend Maya\'s broadcast, and stop Victor Kane before Varencia goes dark.',
      objectives: ['Breach the communications HQ', 'Defend the broadcast until upload completes', 'Confront Victor Kane'],
      objectiveSpawns: [
          { id: 'hq', text: 'Breach the communications HQ', position: V3(0, 0, -60), radius: 16 },
          { id: 'broadcast', text: 'Defend the broadcast until upload completes', position: V3(0, 0, -68), radius: 10 },
          { id: 'kane', text: 'Confront Victor Kane', position: V3(14, 0, -66), radius: 8 }
      ] },
    { id: 6, code: '06', episode: 6, title: 'City Under Fire', biome: 'city', region: 'Veyra City', length: '20 min', act: 'EPISODE 06', released: '2026-11-01',
      briefing: 'Kane is in custody, but his loyalists have seized Veyra City. Link up with the City Guard, reach the civilians trapped in the west block, and escort them to the northern checkpoint.',
      objectives: ['Secure the Market Street intersection', 'Reach the civilians in the west hall', 'Escort the civilians to the north checkpoint'] }
];
