import * as THREE from 'three';

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
            field: { count: 7500, litter: 2500, litterA: 0x7a6238, litterB: 0xb09860, colA: 0xa89a52, colB: 0x8a8a44, maskLo: 0.46, maskHi: 0.62 }, bushTint: { leaf: 0x9c9456, bark: 0x7a6a4a }
        },
        rocks: { count: 130, pebbles: 600, color: 0x9a8465, tint: 0xf0dcb8, bright: 2.3, minSize: 1.0, maxSize: 3.2, coverSize: 1.5 },
        perimeterRocks: { spacing: 7, min: 4, max: 8 },
        phProps: [
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
            field: { count: 5000, colA: 0xb5ad86, colB: 0x8c9478, maskLo: 0.5, maskHi: 0.66 }
        },
        rocks: { count: 120, pebbles: 500, color: 0x8a9098, tint: 0xe4ebf2, bright: 1.5, minSize: 0.9, maxSize: 3.0, coverSize: 1.4 },
        perimeterRocks: { spacing: 7, min: 4, max: 8 },
        phProps: [
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
        bounds: 92,
        rim: 5,
        photo: ['worn_asphalt', 'brick_wall_003', 'concrete_wall_004', 'corrugated_iron_02', 'rusty_metal_02', 'wood_planks_grey', 'gravel_floor_02'],
        hdr: { file: 'overcast_soil_puresky', bg: 0.85, sun: false },
        bump: 0.14,
        groundPhoto: 'worn_asphalt',
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
            field: { count: 3500, litter: 1600, colA: 0x68734b, colB: 0x8b8558, maskLo: 0.52, maskHi: 0.7 }
        },
        rocks: { count: 90, pebbles: 500, color: 0x6a6862, tint: 0xd8d4cc, bright: 1.8, minSize: 0.8, maxSize: 2.4, coverSize: 1.3 },
        perimeterRocks: { spacing: 10, min: 2.5, max: 4.5 },
        perimeterWall: { height: 8, color: 0x85837c },
        phProps: [
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
    }
};

/** Mission list (GDD 4.1) — maps each mission to a biome + metadata. */
export const MISSIONS = [
    { id: 1, code: '01', title: 'Missing Signal', biome: 'wildlands', region: 'Wildlands', length: '25 min', act: 'ACT I — THE DISAPPEARANCE',
      briefing: 'A reconnaissance team vanished near an abandoned outpost. Deploy with your squad, locate them, and recover their intelligence.',
      objectives: ['Reach the abandoned outpost', 'Recover the recon team recording', 'Fight to the extraction point'] },
    { id: 2, code: '02', title: 'Broken Convoy', biome: 'dustland', region: 'Dustland', length: '30 min', act: 'ACT II — THE ESCALATION',
      briefing: 'A military supply convoy is under attack in the desert. Survive the ambush and trace the stolen equipment to an industrial facility.',
      objectives: ['Investigate the destroyed convoy', 'Breach the industrial facility', "Recover Kane's authorization record"] },
    { id: 3, code: '03', title: 'Frozen Evidence', biome: 'frostland', region: 'Frostland', length: '30 min', act: 'ACT II — THE ESCALATION',
      briefing: 'Infiltrate an abandoned arctic research installation and recover classified records before the enemy destroys them.',
      objectives: ['Reach the research installation', 'Recover the classified records', 'Escape the facility assault'] },
    { id: 4, code: '04', title: 'Deadzone Entry', biome: 'deadzone', region: 'Deadzone', length: '25 min', act: 'ACT III — THE BLACKOUT',
      briefing: 'Enter the abandoned urban sector, fight through Kane\'s checkpoints, and locate the captured Hayes.',
      objectives: ['Push through the last checkpoint', 'Locate Hayes in the detention facility', 'Extract to the communications HQ'] },
    { id: 5, code: '05', title: 'Operation Blackout', biome: 'deadzone', region: 'Deadzone', length: '35 min', act: 'ACT III — THE BLACKOUT',
      briefing: 'Assault the communications HQ, defend Maya\'s broadcast, and stop Victor Kane before Varencia falls.',
      objectives: ['Breach the communications HQ', 'Defend the broadcast until upload completes', 'Confront Victor Kane'] },
    { id: 6, code: '06', title: 'City Under Fire', biome: 'deadzone', region: 'Veyra City', length: '20 min', act: 'EPILOGUE — AFTERSHOCK',
      briefing: 'Kane is in custody, but his loyalists have seized Veyra City. Push into the urban sector, evacuate trapped civilians, and secure the streets before the blackout becomes permanent.',
      objectives: ['Enter the Veyra City sector', 'Reach the trapped civilians', 'Extract through the southern checkpoint'],
      objectiveSpawns: [
          { id: 'city_entry', text: 'Enter the Veyra City sector', position: V3(0, 0, 12), radius: 12 },
          { id: 'civilians', text: 'Reach the trapped civilians', position: V3(-34, 0, 10), radius: 10 },
          { id: 'checkpoint', text: 'Extract through the southern checkpoint', position: V3(0, 0, 36), radius: 10 }
      ] }
];
