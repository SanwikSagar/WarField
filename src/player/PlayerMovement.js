import * as THREE from 'three';
import { globalEvents } from '../core/EventManager.js';

/**
 * First-person movement physics (GDD 5.1 / 11.5). Handles mouse look,
 * walk/run/sprint, crouch, slide, jump, gravity, head-bob, footstep timing,
 * and AABB collision + sliding against level geometry.
 *
 * Hierarchy: yaw (feet, world pos) -> pitch (eye height, look pitch)
 *            -> camera (recoil/shake offset + head-bob applied here).
 */
export class PlayerMovement {
    constructor(yaw, pitch, camera, cameraManager) {
        this.yaw = yaw;
        this.pitch = pitch;
        this.camera = camera;
        this.cameraManager = cameraManager;
        this.colliders = [];

        this.velocity = new THREE.Vector3();
        this.inputDir = new THREE.Vector3();

        // Tuning
        this.walkSpeed = 3.4;
        this.runSpeed = 5.2;
        this.sprintSpeed = 7.6;
        this.crouchSpeed = 1.7;
        this.slideSpeed = 11;
        this.gravity = -22;
        this.jumpForce = 7.2;
        this.accel = 12;
        this.airControl = 2.5;
        this.groundFriction = 11;

        this.standHeight = 1.7;
        this.crouchHeight = 1.0;
        this.eyeHeight = this.standHeight;
        this.radius = 0.4;

        this.isGroundedFlag = true;
        this.movingFlag = false;
        this.sprintingFlag = false;
        this.crouchingFlag = false;
        this.slidingFlag = false;
        this.slideTimer = 0;

        this.bobTime = 0;
        this.stepCycle = 0;
        this.lastStep = 0;
        this.surface = 'dirt';
        this.landDip = 0;
        this._roll = 0;
        this._dipPitch = 0;
        this.stamina = 1;
        this.exhausted = false;
        this._restT = 0;

        this._lookYaw = 0;
        this._lookPitch = 0;
        this._tmpBox = new THREE.Box3();
        this._tmpVec = new THREE.Vector3();
        this._tmpMin = new THREE.Vector3();
        this._tmpMax = new THREE.Vector3();
        this._yAxis = new THREE.Vector3(0, 1, 0);
        this.sensitivityScale = 1.0;
    }

    setColliders(colliders) { this.colliders = colliders; }
    setSurface(surface) { this.surface = surface; }

    update(dt, input, audio) {
        this._updateLook(dt, input);
        this._updateStance(dt, input, audio);
        this._updateMovement(dt, input);
        this._applyGravityAndJump(dt, input);
        this._resolveCollisions(dt);
        this._updateHeadBob(dt, input, audio);
        this._applyCameraOffset();
    }

    _updateLook(dt, input) {
        const m = input.consumeMouseMovement();
        this.lastLook = m;
        const sens = this.sensitivityScale;
        // Reduce sensitivity while aiming for precision
        const adsScale = 1.0;
        this._lookYaw -= m.x * sens * adsScale;
        this._lookPitch -= m.y * sens * adsScale;
        const limit = Math.PI / 2 - 0.02;
        this._lookPitch = THREE.MathUtils.clamp(this._lookPitch, -limit, limit);
        this.yaw.rotation.y = this._lookYaw;
        this.pitch.rotation.x = this._lookPitch;
    }

    _updateStance(dt, input, audio) {
        // Crouch (hold)
        const wantCrouch = input.isDown('crouch');
        // Slide: sprint + crouch while moving on ground
        if (wantCrouch && this.sprintingFlag && this.isGroundedFlag && !this.slidingFlag && !this.crouchingFlag) {
            this.slidingFlag = true;
            this.slideTimer = 0.85;
            if (audio) audio.playFootstep(this.surface, 0.4);
        }
        if (this.slidingFlag) {
            this.slideTimer -= dt;
            if (this.slideTimer <= 0 || !this.isGroundedFlag) this.slidingFlag = false;
        }
        this.crouchingFlag = (wantCrouch || this.slidingFlag) && !this.sprintingFlag;
        if (this.slidingFlag) this.crouchingFlag = true;

        // Smooth eye height
        const targetHeight = this.crouchingFlag ? this.crouchHeight : this.standHeight;
        this.eyeHeight = THREE.MathUtils.lerp(this.eyeHeight, targetHeight, 1 - Math.pow(0.0001, dt));
        this.pitch.position.y = this.eyeHeight;
    }

    _updateMovement(dt, input) {
        // Gather input direction (local space)
        const f = Number(input.isDown('forward')) - Number(input.isDown('back'));
        const r = Number(input.isDown('right')) - Number(input.isDown('left'));
        this.inputDir.set(r, 0, -f);
        const hasInput = this.inputDir.lengthSq() > 0;
        if (hasInput) this.inputDir.normalize();

        // Sprint only while moving forward and not aiming/crouching; limited by stamina
        const wantSprint = input.isDown('sprint') && f > 0 && !this.crouchingFlag && !this.exhausted;
        this.sprintingFlag = wantSprint && hasInput && !this.slidingFlag;
        if (this.sprintingFlag) { this.stamina = Math.max(0, this.stamina - dt / 7); this._restT = 0; }
        else {
            this._restT += dt;
            if (this._restT > 0.8) this.stamina = Math.min(1, this.stamina + dt / (hasInput ? 7 : 4.5));
        }
        if (this.stamina <= 0.02) this.exhausted = true;
        else if (this.exhausted && this.stamina > 0.35) this.exhausted = false;

        let speed;
        if (this.slidingFlag) speed = this.slideSpeed * (this.slideTimer / 0.85);
        else if (this.crouchingFlag) speed = this.crouchSpeed;
        else if (this.sprintingFlag) speed = this.sprintSpeed;
        else if (hasInput) speed = input.isDown('sprint') ? this.runSpeed : this.walkSpeed;
        else speed = 0;

        // Convert to world direction using yaw
        const wishDir = this._tmpVec.copy(this.inputDir).applyAxisAngle(this._yAxis, this._lookYaw);
        if (this.slidingFlag) {
            // Slide keeps momentum in the current facing direction
            wishDir.set(Math.sin(this._lookYaw), 0, Math.cos(this._lookYaw)).negate();
        }

        const targetVel = wishDir.clone().multiplyScalar(speed);
        const control = this.isGroundedFlag ? this.accel : this.airControl;
        this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetVel.x, Math.min(1, control * dt));
        this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, targetVel.z, Math.min(1, control * dt));

        // Ground friction when no input
        if (this.isGroundedFlag && !hasInput && !this.slidingFlag) {
            const fr = Math.max(0, 1 - this.groundFriction * dt);
            this.velocity.x *= fr;
            this.velocity.z *= fr;
        }

        this.movingFlag = (this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z) > 0.4;
    }

    _applyGravityAndJump(dt, input) {
        if (input.justPressed('jump') && this.isGroundedFlag && !this.crouchingFlag) {
            this.velocity.y = this.jumpForce;
            this.isGroundedFlag = false;
        }
        this.velocity.y += this.gravity * dt;
        if (this.slidingFlag) this.velocity.y = Math.max(this.velocity.y, -2);
    }

    _resolveCollisions(dt) {
        const pos = this.yaw.position;
        // Horizontal move with per-axis collision + sliding
        const dx = this.velocity.x * dt;
        const dz = this.velocity.z * dt;

        if (this.world) {
            // Grid broadphase + circle push-out: slides along walls/trunks,
            // never sticks on corners, cost independent of collider count.
            const ox = pos.x, oz = pos.z;
            pos.x += dx; pos.z += dz;
            if (this.world.resolve(pos, this.radius, pos.y + 0.3, pos.y + this.eyeHeight) && dt > 0) {
                this.velocity.x = (pos.x - ox) / dt;
                this.velocity.z = (pos.z - oz) / dt;
            }
        } else {
            // X axis
            pos.x += dx;
            if (this._collides(pos)) { pos.x -= dx; this.velocity.x = 0; }
            // Z axis
            pos.z += dz;
            if (this._collides(pos)) { pos.z -= dz; this.velocity.z = 0; }
        }

        // Vertical (ground follows the bumpy heightfield)
        const gy = this.heightAt ? this.heightAt(pos.x, pos.z) : 0;
        const wasGrounded = this.isGroundedFlag;
        pos.y += this.velocity.y * dt;
        if (wasGrounded && this.velocity.y <= 0 && pos.y - gy < 0.3 && pos.y > gy) pos.y = gy;   // stick to slopes going down
        if (pos.y <= gy) {
            pos.y = gy;
            if (this.velocity.y < -8) {
                // Fall damage / landing thump
                globalEvents.emit('player_land', { impact: -this.velocity.y });
            }
            if (!wasGrounded && this.velocity.y < -3) this.landDip = Math.min(1, Math.max(this.landDip, -this.velocity.y / 14));
            this.velocity.y = 0;
            this.isGroundedFlag = true;
        } else {
            this.isGroundedFlag = false;
        }

        // Clamp to level bounds
        const b = this.bounds || 200;
        pos.x = THREE.MathUtils.clamp(pos.x, -b, b);
        pos.z = THREE.MathUtils.clamp(pos.z, -b, b);
    }

    /** AABB overlap test for the player capsule at a given feet position. */
    _collides(feetPos) {
        if (!this.colliders.length) return false;
        const min = this._tmpMin.set(feetPos.x - this.radius, feetPos.y + 0.1, feetPos.z - this.radius);
        const max = this._tmpMax.set(feetPos.x + this.radius, feetPos.y + this.eyeHeight, feetPos.z + this.radius);
        this._tmpBox.set(min, max);
        for (let i = 0; i < this.colliders.length; i++) {
            const c = this.colliders[i];
            if (c.max.y < feetPos.y + 0.3) continue; // step over low obstacles
            if (c.min.y > feetPos.y + this.eyeHeight) continue; // above head
            if (this._tmpBox.intersectsBox(c)) return true;
        }
        return false;
    }

    _updateHeadBob(dt, input, audio) {
        const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        const bobFreq = this.sprintingFlag ? 13 : this.crouchingFlag ? 6 : 9;
        const bobAmp = this.isGroundedFlag
            ? (this.sprintingFlag ? 0.055 : this.crouchingFlag ? 0.02 : horizontalSpeed > 0.5 ? 0.038 : 0.006)
            : 0.004;

        if (horizontalSpeed > 0.5 && this.isGroundedFlag) {
            this.bobTime += dt * bobFreq;
            // Footstep audio on each cycle crossing
            this.stepCycle += dt * bobFreq;
            if (this.stepCycle - this.lastStep > Math.PI) {
                this.lastStep = this.stepCycle;
                if (audio) audio.playFootstep(this.surface, this.sprintingFlag ? 0.4 : 0.28);
                globalEvents.emit('footstep', { position: this.yaw.position.clone(), sprinting: this.sprintingFlag });
            }
        } else {
            this.bobTime += dt * 2;
        }

        const bobY = Math.sin(this.bobTime) * bobAmp;
        const bobX = Math.cos(this.bobTime * 0.5) * bobAmp * 0.5;
        this.landDip = Math.max(0, this.landDip - dt * 2.6);
        const dip = Math.sin(Math.min(1, this.landDip) * Math.PI * 0.5) * 0.09 * this.landDip;
        this.camera.position.y = bobY - dip;
        this.camera.position.x = bobX;

        // strafe lean + sprint sway roll, eased so it reads as head motion, not tilt snapping
        const c = Math.cos(this._lookYaw), s = Math.sin(this._lookYaw);
        const strafe = this.velocity.x * c - this.velocity.z * s;
        const sprintRoll = this.sprintingFlag && this.isGroundedFlag ? Math.sin(this.bobTime * 0.5) * 0.012 : 0;
        const targetRoll = THREE.MathUtils.clamp(-strafe * 0.0045, -0.03, 0.03) + sprintRoll + (this.slidingFlag ? 0.06 : 0);
        this._roll += (targetRoll - this._roll) * Math.min(1, dt * 6);
        this._dipPitch = -dip * 0.35;

        // Sprint FOV kick + camera roll
        if (this.cameraManager) {
            const sprintFov = this.sprintingFlag ? 4 : 0;
            this.cameraManager.fovKick = sprintFov;
        }
        this._bobX = bobX;
        this._bobY = bobY;
    }

    _applyCameraOffset() {
        if (!this.cameraManager) return;
        const off = this.cameraManager.getCameraOffset();
        this.camera.rotation.x = off.pitch + this._dipPitch;
        this.camera.rotation.y = off.yaw;
        this.camera.rotation.z = off.roll + this._roll;
    }

    getPosition() { return this.yaw.position; }
    getEyePosition() {
        return this._tmpVec.copy(this.yaw.position).setY(this.yaw.position.y + this.eyeHeight).clone();
    }
    getLookDirection() {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        return dir;
    }
    isMoving() { return this.movingFlag; }
    isSprinting() { return this.sprintingFlag; }
    isCrouching() { return this.crouchingFlag; }
    isSliding() { return this.slidingFlag; }
    isGrounded() { return this.isGroundedFlag; }
    getSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }

    teleport(x, y, z) {
        this.yaw.position.set(x, y, z);
        this.velocity.set(0, 0, 0);
    }
}
