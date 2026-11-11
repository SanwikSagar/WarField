import * as THREE from 'three';

/**
 * Owns the first-person camera and all camera-space effects:
 * base FOV, aim FOV, recoil kick, and trauma-based screen shake.
 * Kept separate from PlayerMovement so gunplay and traversal can
 * both drive the camera without fighting over the same transform.
 */
export class CameraManager {
    constructor() {
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.05,
            2000
        );

        this.baseFOV = 75;
        this.currentFOV = 75;
        this.targetFOV = 75;

        // Trauma model (0..1). Decays over time; shake scales with trauma^2.
        this.trauma = 0;
        this.shakeTime = 0;

        // Recoil is applied as an additive pitch/yaw offset that recovers smoothly.
        this.recoilPitch = 0;
        this.recoilYaw = 0;
        this.recoilPitchTarget = 0;
        this.recoilYawTarget = 0;

        this.shakeEnabled = true;
        this.shakeIntensity = 1.0;
    }

    getCamera() {
        return this.camera;
    }

    setFOV(fov) {
        this.baseFOV = fov;
    }

    /** Aim-down-sights FOV, lerped toward in update(). */
    setTargetFOV(fov) {
        this.targetFOV = fov;
    }

    /** Add screen shake. amount is trauma in 0..1. */
    addShake(amount) {
        if (!this.shakeEnabled) return;
        this.trauma = Math.min(1, this.trauma + amount);
    }

    /** Add a recoil kick (radians). Positive pitch kicks the view up. */
    addRecoil(pitch, yaw) {
        this.recoilPitchTarget += pitch;
        this.recoilYawTarget += yaw;
        // Clamp so sustained fire cannot flip the camera.
        this.recoilPitchTarget = THREE.MathUtils.clamp(this.recoilPitchTarget, -0.35, 0.35);
        this.recoilYawTarget = THREE.MathUtils.clamp(this.recoilYawTarget, -0.25, 0.25);
    }

    update(deltaTime) {
        // FOV smoothing (sprint adds a small kick on top of hip/ADS FOV)
        const kick = this.fovKick || 0;
        this.currentFOV = THREE.MathUtils.lerp(this.currentFOV, this.targetFOV + kick * THREE.MathUtils.clamp((this.targetFOV - 40) / 35, 0, 1), 1 - Math.pow(0.001, deltaTime));
        if (Math.abs(this.camera.fov - this.currentFOV) > 0.01) {
            this.camera.fov = this.currentFOV;
            this.camera.updateProjectionMatrix();
        }

        // Recoil recovery: spring back toward zero
        const recover = 1 - Math.pow(0.0015, deltaTime);
        this.recoilPitchTarget = THREE.MathUtils.lerp(this.recoilPitchTarget, 0, recover * 0.6);
        this.recoilYawTarget = THREE.MathUtils.lerp(this.recoilYawTarget, 0, recover * 0.6);
        this.recoilPitch = THREE.MathUtils.lerp(this.recoilPitch, this.recoilPitchTarget, 1 - Math.pow(0.0001, deltaTime));
        this.recoilYaw = THREE.MathUtils.lerp(this.recoilYaw, this.recoilYawTarget, 1 - Math.pow(0.0001, deltaTime));

        // Trauma decay
        this.trauma = Math.max(0, this.trauma - deltaTime * 1.6);
        this.shakeTime += deltaTime;
    }

    /**
     * Returns the current recoil + shake offset to be applied on top of the
     * player's look rotation each frame. Caller adds this to pitch/yaw.
     */
    getCameraOffset() {
        const shake = this.trauma * this.trauma * this.shakeIntensity;
        const t = this.shakeTime * 35;
        const shakePitch = shake * Math.sin(t * 1.3) * 0.02;
        const shakeYaw = shake * Math.sin(t * 1.7 + 1.0) * 0.02;
        const shakeRoll = shake * Math.sin(t * 2.1 + 2.0) * 0.015;
        return {
            pitch: this.recoilPitch + shakePitch + (this.aimSwayPitch || 0),
            yaw: this.recoilYaw + shakeYaw + (this.aimSwayYaw || 0),
            roll: shakeRoll
        };
    }

    resize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
    }
}
