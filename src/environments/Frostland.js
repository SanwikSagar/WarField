import { LevelBuilder } from './LevelBuilder.js';
import { BIOMES } from './biomes.js';

/** Mission 03 — Frozen Evidence. Arctic installation, blizzard, low visibility. */
export function buildFrostland(scene) {
    return new LevelBuilder(scene).build(BIOMES.frostland);
}
