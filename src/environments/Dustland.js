import { LevelBuilder } from './LevelBuilder.js';
import { BIOMES } from './biomes.js';

/** Mission 02 — Broken Convoy. Desert settlement, dust, industrial facility. */
export function buildDustland(scene) {
    return new LevelBuilder(scene).build(BIOMES.dustland);
}
