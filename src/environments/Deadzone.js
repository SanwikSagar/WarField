import { LevelBuilder } from './LevelBuilder.js';
import { BIOMES } from './biomes.js';

/** Missions 04 & 05 — Deadzone. Abandoned urban sector, communications HQ. */
export function buildDeadzone(scene) {
    return new LevelBuilder(scene).build(BIOMES.deadzone);
}
