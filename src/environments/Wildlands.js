import { LevelBuilder } from './LevelBuilder.js';
import { BIOMES } from './biomes.js';

/** Mission 01 — Missing Signal. Dense forest, rain, abandoned outpost. */
export function buildWildlands(scene) {
    return new LevelBuilder(scene).build(BIOMES.wildlands);
}
