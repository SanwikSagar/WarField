import * as THREE from '/node_modules/three/build/three.module.js';
import { BIOMES } from '../environments/biomes.js';

/**
 * Owns the THREE.Scene and the currently-loaded level. Loading a biome
 * builds the procedural environment and exposes everything gameplay needs:
 * collision boxes, raycast targets, AI cover points, spawn data, the sky
 * rig, and a per-frame weather update hook.
 */
export class SceneManager {
    constructor() {
        this.scene = new THREE.Scene();
        this.level = null;
    }

    initialize() {
        // Base scene; the Sky rig sets background/fog per biome on load.
        this.scene.background = new THREE.Color(0x0a0c10);
    }

    /** Build and return a level for the given biome id. */
    async loadLevel(biomeId, detail = {}) {
        this.clearLevel();
        const { LevelBuilder } = await import('../environments/LevelBuilder.js');
        const config = BIOMES[biomeId] || BIOMES.wildlands;
        this.level = new LevelBuilder(this.scene).build(config, detail);
        if (!this.level.sky.hdrActive) this.scene.background = this.level.sky.palette.fogColor;
        return this.level;
    }

    clearLevel() {
        if (this.level) {
            if (this.level.dispose) this.level.dispose();   // sky, weather, foliage systems
            this.scene.remove(this.level.group);
            this.level.group.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                    mats.forEach(m => m.dispose());
                }
            });
            this.scene.fog = null;
            this.scene.environment = null;
        }
        this.level = null;
    }

    getScene() { return this.scene; }
    getLevel() { return this.level; }
    getColliders() { return this.level ? this.level.colliders : []; }
    getRaycastables() { return this.level ? this.level.raycastables : []; }
    getCover() { return this.level ? this.level.cover : []; }
    getSpawns() { return this.level ? this.level.spawns : null; }

    update(deltaTime, playerPos, camera) {
        if (!this.level) return;
        this.level.update(deltaTime, playerPos, camera);
        if (this.level.sky) this.level.sky.follow(playerPos);
    }
}
