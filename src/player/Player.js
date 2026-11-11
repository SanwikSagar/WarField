import * as THREE from 'three';
import { PlayerMovement } from './PlayerMovement.js';
import { PlayerHealth } from './PlayerHealth.js';
import { WeaponManager } from '../weapons/WeaponManager.js';
import { globalEvents } from '../core/EventManager.js';

/**
 * The player entity. Builds the look hierarchy (yaw -> pitch -> camera),
 * and owns movement, health, and the weapon manager. Everything gameplay
 * touches each frame is routed through update().
 */
export class Player {
    constructor(camera, scene, deps = {}) {
        this.camera = camera;
        this.scene = scene;
        this.deps = deps; // { cameraManager, audio, getRaycastables, getEnemies, onEnemyHit, colliders, difficulty }

        // Yaw (feet, world position) -> Pitch (eye height, look pitch) -> Camera
        this.yaw = new THREE.Object3D();
        this.pitch = new THREE.Object3D();
        this.pitch.position.y = 1.7;
        this.yaw.add(this.pitch);
        this.pitch.add(this.camera);
        this.scene.add(this.yaw);

        this.movement = new PlayerMovement(this.yaw, this.pitch, this.camera, deps.cameraManager);
        this.health = new PlayerHealth(deps.difficulty || 'regular');
        this.weapons = new WeaponManager(this.camera, this.scene, {
            cameraManager: deps.cameraManager,
            audio: deps.audio,
            getRaycastables: deps.getRaycastables,
            getEnemies: deps.getEnemies,
            onEnemyHit: deps.onEnemyHit,
            getWorld: deps.getWorld,
            heightAt: deps.heightAt
        });

        // Interaction
        this.interactTarget = null;
        this._raycaster = new THREE.Raycaster();
        this._tmpVec = new THREE.Vector3();

        globalEvents.on('medkit_use', () => this.health.useMedkit());
    }

    initialize(spawn, loadout) {
        if (spawn) this.yaw.position.copy(spawn);
        if (this.deps.colliders) this.movement.setColliders(this.deps.colliders);
        this.movement.bounds = this.deps.bounds || 200;
        this.movement.world = this.deps.world || null;
        this.movement.heightAt = this.deps.heightAt || null;
        this.weapons.initialize(loadout);
        this.weapons.setBaseFOV(this.deps.baseFov || 75);
    }

    update(dt, input, audio) {
        if (!this.health.isAlive) {
            // Death cam: slow sink + tilt
            this.pitch.position.y = THREE.MathUtils.lerp(this.pitch.position.y, 0.4, dt * 2);
            this.camera.rotation.z = THREE.MathUtils.lerp(this.camera.rotation.z, 0.5, dt * 2);
            return;
        }
        this.health.update(dt);
        this.movement.update(dt, input, audio);
        const now = performance.now() / 1000;
        this.weapons.update(dt, input, this.movement, now);
        this._updateInteraction(input);
        if (this.deps.cameraManager) this.deps.cameraManager.update(dt);
    }

    _updateInteraction(input) {
        // Simple forward-ray interaction prompt for objectives/pickups
        const interactables = this.deps.getInteractables ? this.deps.getInteractables() : [];
        if (!interactables.length) return;
        const origin = this.getEyePosition();
        const dir = this.movement.getLookDirection();
        this._raycaster.set(origin, dir);
        this._raycaster.far = 3.5;
        let found = null;
        for (const obj of interactables) {
            if (!obj.active) continue;
            const d = origin.distanceTo(obj.position);
            if (d < 3.5) { found = obj; break; }
        }
        this.interactTarget = found;
        globalEvents.emit('interaction_update', { target: found ? found.prompt : null });
        if (found && input.justPressed('interact') && found.onInteract) {
            found.onInteract();
        }
    }

    getEyePosition() {
        return this._tmpVec.copy(this.yaw.position).setY(this.yaw.position.y + this.movement.eyeHeight).clone();
    }
    getPosition() { return this.yaw.position; }
    getLookDirection() { return this.movement.getLookDirection(); }

    setLoadout(loadout) { this.weapons.initialize(loadout); }
}
