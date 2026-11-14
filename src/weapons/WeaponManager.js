import * as THREE from '/node_modules/three/build/three.module.js';
import { Weapon } from './Weapon.js';
import { WEAPON_DATA, DEFAULT_LOADOUT } from './WeaponData.js';
import { WeaponEffects } from './WeaponEffects.js';
import { TextureFactory } from '../utils/TextureFactory.js';
import { globalEvents } from '../core/EventManager.js';
import { createWeaponModel, hasWeaponModel } from './WeaponModels.js';
import { FPArms } from './FPArms.js';

/**
 * Owns the player's loadout, the first-person viewmodels, and all gunplay
 * orchestration: hitscan firing, recoil, sway/bob, ADS, reload animation,
 * and weapon switching. Visual/audio feedback is delegated to WeaponEffects
 * and the AudioManager so this class stays focused on feel and state.
 *
 * deps: { cameraManager, audio, getRaycastables(), getEnemies(), onEnemyHit() }
 */
export class WeaponManager {
    constructor(camera, scene, deps = {}) {
        this.camera = camera;
        this.scene = scene;
        this.deps = deps;
        this.cameraManager = deps.cameraManager;
        this.audio = deps.audio;

        this.raycaster = new THREE.Raycaster();
        this.raycaster.far = 400;

        this.effects = new WeaponEffects(scene, camera);
        this.effects.heightAt = deps.heightAt || null;

        // Viewmodel rig parented to the camera so it follows the view.
        this.rig = new THREE.Group();
        this.camera.add(this.rig);
        this.hipPos = new THREE.Vector3(0.22, -0.2, -0.45);
        this.adsPos = new THREE.Vector3(0, -0.085, -0.3);
        this.rig.position.copy(this.hipPos);

        this.weapons = [];
        this.viewmodels = [];
        this.currentIndex = 0;

        // Sway / bob state
        this.swayPos = new THREE.Vector2();
        this.swayRot = new THREE.Vector2();
        this.bobTime = 0;
        this.recoilOffset = 0;    // visual kickback along -z
        this.switchTimer = 0;      // >0 while lowering/raising a weapon
        this.switchPhase = 'none'; // 'lower' | 'raise' | 'none'
        this.pendingIndex = -1;

        this.baseFov = 75;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.hitmarkerTimer = 0;
        this.arms = null;
        this._defaultHip = this.hipPos.clone();
        this._defaultAds = this.adsPos.clone();
        this.recoilRot = new THREE.Vector3();   // visual muzzle climb / roll on the viewmodel
        this.inspectT = -1;
        this.meleeT = -1;
        this._land = 0;
        this._crouch = 0;
        this._air = 0;
    }

    initialize(loadout = DEFAULT_LOADOUT) {
        if (!this.arms) { try { this.arms = FPArms.create(this.camera); } catch (e) { console.warn('FP arms unavailable:', e); } }
        this.clearLoadout();
        loadout.forEach(id => this.addWeapon(id));
        this.currentIndex = 0;
        this._showOnly(0);
        this.updateHUD();
    }

    clearLoadout() {
        this.viewmodels.forEach(vm => this.rig.remove(vm.group));
        this.weapons = [];
        this.viewmodels = [];
    }

    addWeapon(id) {
        const data = WEAPON_DATA[id];
        if (!data) return;
        const weapon = new Weapon(data);
        const vm = this._buildViewModel(data);
        this.rig.add(vm.group);
        vm.group.visible = false;
        this.weapons.push(weapon);
        this.viewmodels.push(vm);
    }

    get current() { return this.weapons[this.currentIndex]; }
    get currentViewModel() { return this.viewmodels[this.currentIndex]; }

    // ── VIEWMODEL CONSTRUCTION ────────────────────────────────────────────
    _buildViewModel(data) {
        if (data.modelId && hasWeaponModel(data.modelId)) return this._buildModelViewModel(data);
        const m = data.model;
        const group = new THREE.Group();
        const metalTex = TextureFactory.metal(128, 1);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: m.color, metalness: 0.75, roughness: 0.42, map: metalTex.map
        });
        const accentMat = new THREE.MeshStandardMaterial({
            color: m.accent, metalness: 0.6, roughness: 0.55
        });
        const polyMat = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, metalness: 0.2, roughness: 0.8 });

        const add = (geo, mat, x, y, z, rx = 0) => {
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(x, y, z);
            if (rx) mesh.rotation.x = rx;
            mesh.castShadow = false;
            group.add(mesh);
            return mesh;
        };

        const L = m.length;
        let muzzleZ = -L;
        const eject = new THREE.Object3D();

        if (m.type === 'rifle' || m.type === 'smg') {
            const short = m.type === 'smg';
            // Receiver
            add(new THREE.BoxGeometry(0.07, 0.1, L * 0.55), bodyMat, 0, 0, -L * 0.25);
            // Barrel
            const barrelLen = short ? L * 0.4 : L * 0.55;
            add(new THREE.CylinderGeometry(0.018, 0.02, barrelLen, 10), accentMat, 0, 0.01, -L * 0.5 - barrelLen / 2 + 0.05, Math.PI / 2);
            muzzleZ = -L * 0.5 - barrelLen + 0.06;
            // Handguard
            add(new THREE.BoxGeometry(0.065, 0.075, L * 0.34), polyMat, 0, 0, -L * 0.6);
            // Magazine
            add(new THREE.BoxGeometry(0.05, 0.16, 0.07), accentMat, 0, -0.11, -L * 0.22);
            // Stock
            add(new THREE.BoxGeometry(0.06, 0.09, L * 0.26), polyMat, 0, -0.01, L * 0.02);
            // Grip
            add(new THREE.BoxGeometry(0.05, 0.13, 0.06), polyMat, 0, -0.1, -L * 0.08, 0.25);
            // Iron sight / optic post
            add(new THREE.BoxGeometry(0.012, 0.035, 0.02), accentMat, 0, 0.065, -L * 0.45);
            add(new THREE.BoxGeometry(0.012, 0.03, 0.02), accentMat, 0, 0.06, -L * 0.12);
            eject.position.set(0.05, 0.0, -L * 0.28);
        } else if (m.type === 'shotgun') {
            add(new THREE.BoxGeometry(0.07, 0.09, L * 0.5), bodyMat, 0, 0, -L * 0.22);
            add(new THREE.CylinderGeometry(0.026, 0.026, L * 0.7, 10), accentMat, 0, 0.012, -L * 0.55, Math.PI / 2);
            muzzleZ = -L * 0.9;
            // Pump
            add(new THREE.BoxGeometry(0.06, 0.06, 0.14), polyMat, 0, -0.02, -L * 0.55);
            // Stock
            add(new THREE.BoxGeometry(0.06, 0.1, L * 0.3), polyMat, 0, -0.02, L * 0.05);
            add(new THREE.BoxGeometry(0.05, 0.12, 0.06), polyMat, 0, -0.09, -L * 0.1, 0.2);
            eject.position.set(0.05, 0.0, -L * 0.3);
        } else if (m.type === 'sniper') {
            add(new THREE.BoxGeometry(0.07, 0.1, L * 0.5), bodyMat, 0, 0, -L * 0.2);
            add(new THREE.CylinderGeometry(0.02, 0.024, L * 0.75, 10), accentMat, 0, 0.012, -L * 0.62, Math.PI / 2);
            muzzleZ = -L * 0.98;
            // Scope
            add(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 12), polyMat, 0, 0.085, -L * 0.3, Math.PI / 2);
            add(new THREE.CylinderGeometry(0.028, 0.028, 0.05, 12), accentMat, 0, 0.085, -L * 0.42, Math.PI / 2);
            // Bipod hint + stock
            add(new THREE.BoxGeometry(0.06, 0.1, L * 0.34), polyMat, 0, -0.01, L * 0.06);
            add(new THREE.BoxGeometry(0.05, 0.13, 0.06), polyMat, 0, -0.1, -L * 0.06, 0.2);
            eject.position.set(0.05, 0.0, -L * 0.25);
        } else { // pistol
            add(new THREE.BoxGeometry(0.055, 0.07, L * 0.9), bodyMat, 0, 0, -L * 0.4);
            add(new THREE.BoxGeometry(0.05, 0.13, 0.06), polyMat, 0, -0.09, -L * 0.12, 0.2);
            add(new THREE.BoxGeometry(0.045, 0.02, 0.05), accentMat, 0, 0.045, -L * 0.75);
            muzzleZ = -L * 0.92;
            eject.position.set(0.04, 0.02, -L * 0.4);
        }

        group.add(eject);
        const muzzle = new THREE.Object3D();
        muzzle.position.set(0, 0.012, muzzleZ);
        group.add(muzzle);

        // Muzzle flash sprite + light at the barrel tip
        const flash = this.effects.createMuzzleFlash(group, muzzle.position);

        // Scale the whole viewmodel down to sit naturally in view
        group.scale.setScalar(0.62);
        group.traverse(o => { if (o.isMesh) o.frustumCulled = false; });

        return { group, muzzle, eject, flash, baseScale: 0.62 };
    }

    _showOnly(index) {
        this.viewmodels.forEach((vm, i) => { vm.group.visible = i === index; });
        const vm = this.viewmodels[index];
        this.hipPos.copy(vm && vm.hip ? vm.hip : this._defaultHip);
        this.adsPos.copy(vm && vm.ads ? vm.ads : this._defaultAds);
        if (this.arms) this.arms.setVisible(!!(vm && vm.model));
    }

    // ── SWITCHING ─────────────────────────────────────────────────────────
    switchTo(index) {
        if (index === this.currentIndex || index < 0 || index >= this.weapons.length) return;
        if (this.switchPhase !== 'none') return;
        this.pendingIndex = index;
        this.switchPhase = 'lower';
        this.switchTimer = 0;
        this.current.cancelReload();
        if (this.audio) this.audio.playMechanical('clack');
    }
    switchNext(dir = 1) {
        const n = this.weapons.length;
        if (n < 2) return;
        this.switchTo((this.currentIndex + dir + n) % n);
    }

    // ── MAIN UPDATE ───────────────────────────────────────────────────────
    update(dt, input, movement, now) {
        const weapon = this.current;
        if (!weapon) return;

        const sprinting = movement.isSprinting();
        const wantsAds = input.isMouseDown('right') && !sprinting && this.switchPhase === 'none';
        const moving = movement.isMoving();
        this._movement = movement;
        const grounded = movement.isGrounded();

        // Handle switching animation before normal fire logic
        if (this.switchPhase !== 'none') {
            this._updateSwitch(dt);
        } else {
            // Fire
            const triggerHeld = weapon.data.auto ? input.isMouseDown('left') : input.justPressedMouse('left');
            if (triggerHeld && this.meleeT < 0 && weapon.canFire(now)) {
                this._fire(weapon, movement);
            } else if (input.justPressedMouse('left') && weapon.currentAmmo === 0 && !weapon.isReloading && this.meleeT < 0) {
                // dry fire: click, small jolt, then start reloading
                if (this.audio) this.audio.playMechanical('click');
                this.recoilRot.x += 0.012;
                if (weapon.startReload()) {
                    if (this.audio) this.audio.playMechanical('magOut');
                    globalEvents.emit('reload_start', { progress: 0 });
                }
            }
            if (input.justPressed('melee') && this.meleeT < 0 && !weapon.isReloading) {
                this.meleeT = 0;
                this._meleeDone = false;
                this.inspectT = -1;
                if (this.audio) this.audio.playMechanical('clack');
            }
            // Reload
            if (input.justPressed('reload') && !weapon.isReloading) {
                if (weapon.startReload()) {
                    if (this.audio) this.audio.playMechanical('magOut');
                    globalEvents.emit('reload_start', { progress: 0 });
                }
            }
            // Switch keys
            if (input.justPressed('weapon1')) this.switchTo(0);
            if (input.justPressed('weapon2')) this.switchTo(1);
            if (input.justPressed('weapon3') && this.weapons.length > 2) this.switchTo(2);
            const wheel = input.consumeWheel();
            if (wheel !== 0) this.switchNext(wheel > 0 ? 1 : -1);
            if (input.justPressed('inspect') && !weapon.isReloading && this.inspectT < 0) this.inspectT = 0;
        }
        if (this.inspectT >= 0) {
            this.inspectT += dt;
            if (this.inspectT > 3 || wantsAds || sprinting || weapon.isReloading || this.switchPhase !== 'none' || input.isMouseDown('left')) this.inspectT = -1;
        }
        if (this.meleeT >= 0) {
            this.meleeT += dt;
            if (!this._meleeDone && this.meleeT >= 0.16) { this._meleeDone = true; this._meleeHit(); }
            if (this.meleeT > 0.62) this.meleeT = -1;
        }

        // Reload state machine + animation
        if (weapon.isReloading) {
            const ev = weapon.updateReload(dt);
            if (ev === 'magOut' && this.audio) this.audio.playMechanical('magOut');
            else if (ev === 'magIn' && this.audio) this.audio.playMechanical('magIn');
            else if (ev === 'bolt' && this.audio) this.audio.playMechanical(this.currentViewModel && this.currentViewModel.kind === 'pistol' ? 'slide' : 'bolt');
            else if (ev === 'shell' && this.audio) this.audio.playMechanical('clack');
            else if (ev === 'done') {
                if (this.audio) this.audio.playMechanical('bolt');
                globalEvents.emit('reload_end');
                this.updateHUD();
            }
            globalEvents.emit('reload_progress', { progress: weapon.reloadProgress });
        }

        // Weapon logic update (ADS blend, recoil decay)
        weapon.update(dt, now, wantsAds, sprinting);
        this._updateAimSway(dt, weapon, input, movement, moving);

        // Drive camera FOV from ADS blend
        if (this.cameraManager) {
            const targetFov = THREE.MathUtils.lerp(this.baseFov, weapon.adsFov, weapon.ads);
            this.cameraManager.setTargetFOV(targetFov);
        }

        // Position/rotation of the viewmodel rig (sway, bob, ADS, recoil, reload)
        this._updateViewModel(dt, weapon, input, moving, grounded, sprinting);

        this.effects.update(dt);
        if (this.hitmarkerTimer > 0) this.hitmarkerTimer -= dt;
        this.updateHUD();
    }

    _updateSwitch(dt) {
        this.switchTimer += dt;
        const lowerTime = 0.16, raiseTime = 0.3;
        if (this.switchPhase === 'lower') {
            const k = Math.min(1, this.switchTimer / lowerTime);
            const e = k * k;
            this._switchDrop = e * 0.35;
            this.rig.rotation.set(e * 0.5, -e * 0.25, e * 0.6);
            if (k >= 1) {
                this.currentIndex = this.pendingIndex;
                this._showOnly(this.currentIndex);
                this.switchPhase = 'raise';
                this.switchTimer = 0;
                this.updateHUD();
            }
        } else if (this.switchPhase === 'raise') {
            // draw: swings up from the lower right with a little overshoot
            const k = Math.min(1, this.switchTimer / raiseTime);
            const e = 1 - Math.pow(1 - k, 3);
            const settle = Math.sin(k * Math.PI) * 0.08 * (1 - k);
            this._switchDrop = (1 - e) * 0.35;
            this.rig.rotation.set((1 - e) * 0.5 - settle, (1 - e) * -0.35, (1 - e) * 0.8 + settle);
            if (k >= 1) {
                this.switchPhase = 'none';
                this._switchDrop = 0;
                this.rig.rotation.set(0, 0, 0);
            }
        }
    }

    _updateViewModel(dt, weapon, input, moving, grounded, sprinting) {
        const vm = this.currentViewModel;
        if (!vm) return;

        // Mouse-look sway from look angular velocity (the raw mouse delta is already
        // consumed by PlayerMovement, and per-frame deltas would scale with frame time)
        const look = this._movement && this._movement.lastLook;
        const inv = dt > 0 ? 1 / dt : 0;
        const swayK = 1 - Math.exp(-dt * 8);
        const sx = look ? THREE.MathUtils.clamp(-look.x * inv * 0.012, -0.05, 0.05) : 0;
        const sy = look ? THREE.MathUtils.clamp(-look.y * inv * 0.012, -0.05, 0.05) : 0;
        this.swayPos.x += (sx - this.swayPos.x) * swayK;
        this.swayPos.y += (sy - this.swayPos.y) * swayK;

        // Walk/run bob, phase-locked to the footstep cycle with a slight lag behind the head
        const bobSpeed = sprinting ? 13 : moving ? 9 : 2;
        const bobAmount = (moving && grounded) ? (sprinting ? 0.022 : 0.013) : 0.004;
        if (this._movement && this._movement.bobTime !== undefined) this.bobTime = this._movement.bobTime - 0.6;
        else this.bobTime += dt * bobSpeed;
        const bobY = Math.sin(this.bobTime) * bobAmount;
        const bobX = Math.cos(this.bobTime * 0.5) * bobAmount * 0.6;

        // ADS vs hip position blend
        const ads = weapon.ads;
        const targetPos = new THREE.Vector3().lerpVectors(this.hipPos, this.adsPos, ads);
        // Sprint lowers the weapon
        const lower = weapon.sprintLower;
        targetPos.y -= lower * 0.1;
        targetPos.x -= lower * 0.08;
        targetPos.z += lower * 0.04;

        // Recoil kickback recovery
        this.recoilOffset *= Math.exp(-dt * 12);
        targetPos.z += this.recoilOffset;
        this.recoilRot.multiplyScalar(Math.exp(-dt * 14));

        // landing dip, airborne lift and crouch cant
        const mvState = this._movement;
        this._land = mvState && mvState.landDip ? mvState.landDip : 0;
        this._air += ((grounded ? 0 : 1) - this._air) * Math.min(1, dt * 6);
        this._crouch += ((mvState && mvState.crouchingFlag ? 1 : 0) - this._crouch) * Math.min(1, dt * 7);
        const landBounce = this._land;
        targetPos.y -= landBounce * 0.05 * (1 - ads * 0.6) - this._air * 0.015;
        targetPos.x -= this._crouch * 0.015 * (1 - ads);

        // weapon inspect: tilt the left side toward the eye, then roll to the top
        const insp = this._inspectPose();
        const mel = this._meleePose();
        for (const k in insp) insp[k] += mel[k];
        // rolls into the shoulder mid-way through raising to the sights
        const adsMid = Math.sin(Math.min(1, Math.max(0, ads)) * Math.PI);
        insp.rz += adsMid * 0.09;
        insp.py -= adsMid * 0.012;
        insp.ry += (vm.hipYaw || 0) * (1 - ads) * (1 - lower);
        insp.rz += (vm.hipRoll || 0) * (1 - ads) * (1 - lower);
        targetPos.x += insp.px; targetPos.y += insp.py; targetPos.z += insp.pz;

        // Reload dip animation
        const reloadDip = weapon.isReloading && !vm.model ? Math.sin(weapon.reloadProgress * Math.PI) : 0;
        targetPos.y -= reloadDip * 0.12;
        targetPos.z += reloadDip * 0.05;

        // smoothed base pose; every per-frame offset is layered on top so nothing
        // feeds back into the smoothing (that made the bob depend on frame time)
        const base = this._rigBase || (this._rigBase = targetPos.clone());
        base.lerp(targetPos, 1 - Math.pow(0.0001, dt));
        this.rig.position.copy(base);
        this.rig.position.x += this.swayPos.x + bobX * (1 - ads);
        this.rig.position.y += this.swayPos.y + bobY * (1 - ads) - (this._switchDrop || 0);

        // movement inertia: the gun lags behind strafing / forward motion
        const mv = this._mv || (this._mv = { x: 0, z: 0 });
        const vel = this._movement ? this._movement.velocity : null;
        if (vel) {
            const yaw = this._movement._lookYaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
            const lx = vel.x * c - vel.z * s, lz = vel.x * s + vel.z * c;     // camera-local
            mv.x += (THREE.MathUtils.clamp(lx, -8, 8) - mv.x) * Math.min(1, dt * 6);
            mv.z += (THREE.MathUtils.clamp(lz, -8, 8) - mv.z) * Math.min(1, dt * 6);
        }
        this.rig.position.x -= mv.x * 0.004 * (1 - ads * 0.8);
        this.rig.position.z += mv.z * 0.003 * (1 - ads * 0.8);
        // breathing sway (stronger at the hip, subtle when aiming)
        this._breath = (this._breath || 0) + dt;
        const br = Math.sin(this._breath * 1.6) * (0.0035 - ads * 0.0025);
        this.rig.position.y += br;
        this.rig.position.x += Math.sin(this._breath * 0.8) * (0.002 - ads * 0.0015);

        // Rotation: sway tilt + strafe roll + reload tilt + sprint carry (muzzle swung left/down)
        const sprintSwing = lower * (moving ? 1 : 0);
        const targetRotX = this.swayPos.y * 2.5 + reloadDip * 0.6 + lower * 0.32 + br * 2 - this._air * 0.06 + landBounce * 0.12 + Math.sin(this.bobTime) * 0.05 * sprintSwing;
        const targetRotY = this.swayPos.x * 2.5 + bobX * 0.5 + lower * 0.75 + Math.cos(this.bobTime * 0.5) * 0.08 * sprintSwing;
        const targetRotZ = this.swayPos.x * 1.5 + lower * 0.45 - mv.x * 0.012 * (1 - ads) + this._crouch * 0.12 * (1 - ads) + Math.sin(this.bobTime * 0.5) * 0.07 * sprintSwing;
        const damp = 1 - ads * 0.7;
        // recoil rotation rides on top of the smoothed pose, unsmoothed, so each shot snaps
        const lr = this._lastRecoilRot || (this._lastRecoilRot = new THREE.Vector3());
        vm.group.rotation.x -= lr.x; vm.group.rotation.y -= lr.y; vm.group.rotation.z -= lr.z;
        const rk = 1 - Math.exp(-dt * 10);
        vm.group.rotation.x = THREE.MathUtils.lerp(vm.group.rotation.x, targetRotX * damp + insp.rx, rk);
        vm.group.rotation.y = THREE.MathUtils.lerp(vm.group.rotation.y, targetRotY * damp + insp.ry, rk);
        vm.group.rotation.z = THREE.MathUtils.lerp(vm.group.rotation.z, targetRotZ * damp + insp.rz, rk);
        lr.set(this.recoilRot.x * (1 - ads * 0.65), this.recoilRot.y * (1 - ads * 0.5), this.recoilRot.z * (1 - ads * 0.5));
        vm.group.rotation.x += lr.x; vm.group.rotation.y += lr.y; vm.group.rotation.z += lr.z;
        if (vm.model) this._animateModel(dt, weapon, vm, sprinting);
    }

    /** Rifle-butt / pistol-whip bash: wind up, strike forward-left, recover. */
    _meleePose() {
        const t = this.meleeT;
        const p = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
        if (t < 0) return p;
        const sm = (a, b) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
        const wind = sm(0, 0.1) * (1 - sm(0.1, 0.18));
        const strike = sm(0.1, 0.18) * (1 - sm(0.26, 0.62));
        p.px = 0.04 * wind - 0.09 * strike;
        p.py = -0.02 * wind + 0.03 * strike;
        p.pz = 0.05 * wind - 0.16 * strike;
        p.rx = 0.1 * wind - 0.25 * strike;
        p.ry = -0.35 * wind + 0.7 * strike;
        p.rz = 0.25 * wind - 0.55 * strike;
        return p;
    }

    _meleeHit() {
        const enemies = this.deps.getEnemies ? this.deps.getEnemies() : [];
        const eye = this.camera.getWorldPosition(new THREE.Vector3());
        const fwd = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
        let best = null, bestD = 2.4;
        for (const e of enemies) {
            if (!e.isAlive) continue;
            const to = e.position.clone().sub(eye).setY(0);
            const d = to.length();
            if (d < bestD && to.normalize().dot(fwd) > 0.55) { best = e; bestD = d; }
        }
        if (this.cameraManager) this.cameraManager.addShake(best ? 0.3 : 0.12);
        if (!best) return;
        const point = best.position.clone().setY(best.position.y + 1.3);
        let killed = false;
        if (this.deps.onEnemyHit) killed = !!this.deps.onEnemyHit(best, 75, point, false);
        this.effects.spawnHitMarker(point);
        this.hitmarkerTimer = 0.15;
        globalEvents.emit('hitmarker', { kill: killed, headshot: false });
        if (this.audio) this.audio.playImpact(0.4, 'dirt');
    }

    /**
     * Breathing / fatigue / fear sway that actually moves the point of aim.
     * Shift while aiming (standing still) holds the breath for ~4 s; after that the
     * forced exhale makes the sway worse for a moment.
     */
    _updateAimSway(dt, weapon, input, movement, moving) {
        const ads = weapon.ads;
        const st = this._sway || (this._sway = { t: 0, breath: 1, holding: false, gasp: 0 });
        st.t += dt;
        const wantHold = ads > 0.6 && input.isDown('sprint') && !moving && st.breath > 0 && st.gasp <= 0;
        st.holding = wantHold;
        if (st.holding) { st.breath = Math.max(0, st.breath - dt / 4); if (st.breath === 0) st.gasp = 1.6; }
        else st.breath = Math.min(1, st.breath + dt / 3);
        st.gasp = Math.max(0, st.gasp - dt);
        const fatigue = 1 - (movement.stamina ?? 1);
        const fear = Math.min(1, this.suppression || 0);
        let amp = 0.0012 * (1 + fatigue * 3 + fear * 2.5) * (weapon.data.category === 'Sniper Rifle' ? 1.4 : 1);
        if (movement.crouchingFlag) amp *= 0.6;
        if (st.holding) amp *= 0.12;
        if (st.gasp > 0) amp *= 2.2;
        amp *= 0.35 + ads * 0.65;
        const rate = 1 + fatigue * 0.8 + fear * 0.6;
        const target = {
            yaw: (Math.sin(st.t * 0.55 * rate) + 0.35 * Math.sin(st.t * 1.7 * rate + 1.3)) * amp,
            pitch: (Math.sin(st.t * 1.1 * rate + 0.4) * 0.6 + 0.25 * Math.sin(st.t * 2.3 * rate)) * amp
        };
        const k = 1 - Math.exp(-dt * 6);
        if (this.cameraManager) {
            this.cameraManager.aimSwayYaw = (this.cameraManager.aimSwayYaw || 0) + (target.yaw - (this.cameraManager.aimSwayYaw || 0)) * k;
            this.cameraManager.aimSwayPitch = (this.cameraManager.aimSwayPitch || 0) + (target.pitch - (this.cameraManager.aimSwayPitch || 0)) * k;
        }
    }

    /** 3 s inspect: bring the gun in, show the ejection side, roll to show the top, return. */
    _inspectPose() {
        const t = this.inspectT;
        const p = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
        if (t < 0) return p;
        const sm = (a, b) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
        const inA = sm(0, 0.55) * (1 - sm(1.4, 1.9));
        const inB = sm(1.4, 1.9) * (1 - sm(2.4, 3));
        const drift = Math.sin(t * 2.3) * 0.03;
        p.px = -0.07 * inA - 0.05 * inB;
        p.py = 0.04 * inA + 0.03 * inB;
        p.pz = 0.06 * (inA + inB);
        p.rx = 0.15 * inA + 0.55 * inB + drift * 0.5;
        p.ry = 0.85 * inA + 0.25 * inB;
        p.rz = 0.55 * inA - 0.35 * inB + drift;
        return p;
    }

    // ── FIRING ────────────────────────────────────────────────────────────
    _fire(weapon, movement) {
        const now = performance.now() / 1000;
        const [recPitch, recYaw] = weapon.fire(now);
        const vm = this.currentViewModel;

        // Recoil + shake
        if (this.cameraManager) {
            this.cameraManager.addRecoil(recPitch, recYaw);
            this.cameraManager.addShake(weapon.data.shake * (weapon.ads > 0.5 ? 0.7 : 1));
        }
        this.recoilOffset = 0.06 * weapon.data.recoilKick;
        const rk = weapon.data.recoilKick || 1;
        this.recoilRot.x += 0.045 * rk;
        this.recoilRot.y += (Math.random() - 0.5) * 0.03 * rk;
        this.recoilRot.z += (Math.random() - 0.5) * 0.05 * rk;
        this.inspectT = -1;

        // Muzzle flash
        const suppressed = weapon.hasAttachment('muzzle');
        this.effects.triggerMuzzleFlash(vm.flash, suppressed);

        // Audio
        if (this.audio) {
            const snd = weapon.data.sound;
            this.audio.playGunshot({
                sample: snd.sample, rate: snd.rate,
                body: snd.body, crack: snd.crack, decay: snd.decay,
                gain: snd.gain * weapon.soundGainMultiplier
            });
        }

        // Eject a real casing from the ejection port
        const ejectWorld = new THREE.Vector3();
        vm.eject.getWorldPosition(ejectWorld);
        const cq = this.camera.getWorldQuaternion(new THREE.Quaternion());
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cq);
        this.effects.spawnShell(ejectWorld, right, vm.model ? vm.model.casing : null, new THREE.Vector3(0, 1, 0).applyQuaternion(cq), new THREE.Vector3(0, 0, 1).applyQuaternion(cq));
        if (vm.model) vm.fireT = 0;
        if (this.audio && this.audio.playShell) this.audio.playShell(0.18);

        // Hitscan: fire pellets (shotgun) or single round
        const pellets = weapon.pellets || 1;
        const muzzleWorld = new THREE.Vector3();
        vm.muzzle.getWorldPosition(muzzleWorld);

        for (let p = 0; p < pellets; p++) {
            this._fireRay(weapon, muzzleWorld, movement);
        }
        globalEvents.emit('weapon_fired', { weapon: weapon.name });
    }

    _fireRay(weapon, muzzleWorld, movement) {
        const spread = weapon.currentSpread * (movement.isMoving() ? 1.4 : 1) * (movement.isGrounded() ? 1 : 2.2);
        // Direction from camera with spread applied
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        if (spread > 0) {
            const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
            const up = new THREE.Vector3().crossVectors(right, dir).normalize();
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * spread;
            dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
        }

        this.raycaster.set(this.camera.getWorldPosition(new THREE.Vector3()), dir);
        this.raycaster.far = weapon.data.range;

        // Test enemies first (headshot via y-height check), then level geometry
        const enemies = this.deps.getEnemies ? this.deps.getEnemies() : [];
        let closestHit = null;
        let closestDist = Infinity;
        let hitEnemy = null;
        let isHeadshot = false;

        for (const enemy of enemies) {
            if (!enemy.isAlive || !enemy.hitMeshes) continue;
            const hits = this.raycaster.intersectObjects(enemy.hitMeshes, false);
            if (hits.length && hits[0].distance < closestDist) {
                closestDist = hits[0].distance;
                closestHit = hits[0];
                hitEnemy = enemy;
                // Headshot if the hit is in the upper ~18% of the capsule
                const localY = hits[0].point.y - enemy.position.y;
                isHeadshot = localY > enemy.height * 0.72;
            }
        }

        const raycastables = this.deps.getRaycastables ? this.deps.getRaycastables() : [];
        const worldHits = this.raycaster.intersectObjects(raycastables, false);
        if (worldHits.length && worldHits[0].distance < closestDist) {
            closestDist = worldHits[0].distance;
            closestHit = worldHits[0];
            hitEnemy = null;
        }

        // Trees and boulders live in the collision world (not the mesh list)
        const wld = this.deps.getWorld ? this.deps.getWorld() : null;
        if (wld) {
            const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
            const th = wld.rayHit(o.x, o.y, o.z, d.x, d.y, d.z, Math.min(closestDist, weapon.data.range));
            if (th < closestDist) {
                closestDist = th;
                closestHit = { point: o.clone().addScaledVector(d, th), distance: th, object: { material: { metalness: 0 } }, surface: 'wood' };
                hitEnemy = null;
            }
        }

        if (closestHit) {
            const point = closestHit.point;
            this.effects.spawnTracer(muzzleWorld, point);
            this._suppressAlong(enemies, hitEnemy, closestDist);
            if (hitEnemy) {
                // limbs soak less than the torso; head uses the weapon's headshot multiplier
                const localY = point.y - hitEnemy.position.y;
                const zone = isHeadshot ? weapon.data.headshotMult : localY < hitEnemy.height * 0.48 ? 0.65 : 1;
                const dmg = weapon.damage * zone;
                this.effects.spawnHitMarker(point);
                if (this.audio) this.audio.playImpact(isHeadshot ? 0.35 : 0.22, 'flesh');
                let killed = false;
                if (this.deps.onEnemyHit) killed = !!this.deps.onEnemyHit(hitEnemy, dmg, point, isHeadshot);
                this.hitmarkerTimer = 0.15;
                globalEvents.emit('hitmarker', { kill: killed, headshot: isHeadshot });
            } else {
                const normal = closestHit.face
                    ? closestHit.face.normal.clone().transformDirection(closestHit.object.matrixWorld)
                    : dir.clone().negate();
                const mat = closestHit.object.material;
                const surface = closestHit.surface || (mat && mat.visible === false ? 'dirt' : mat && mat.metalness > 0.4 ? 'metal' : /wood|bark/i.test(mat && mat.name || '') ? 'wood' : 'concrete');
                this.effects.spawnImpact(point, normal, surface);
                if (this.audio) this.audio.playImpact(0.25, surface);
            }
        } else {
            // No hit — tracer into the distance
            const far = muzzleWorld.clone().addScaledVector(dir, weapon.data.range);
            this.effects.spawnTracer(muzzleWorld, far);
            this._suppressAlong(enemies, null, weapon.data.range);
        }
    }

    /** Enemies the round passes close to (but doesn't hit) get suppressed. */
    _suppressAlong(enemies, hitEnemy, maxDist) {
        const ray = this.raycaster.ray;
        for (const e of enemies) {
            if (!e.isAlive || e === hitEnemy || !e.suppress) continue;
            const c = _tmpReach.copy(e.position); c.y += 1.2;
            const along = c.clone().sub(ray.origin).dot(ray.direction);
            if (along < 0 || along > maxDist + 2) continue;
            const miss = ray.distanceToPoint(c);
            if (miss < 2.5) e.suppress(1 - miss / 2.5);
        }
    }

    // ── REAL WEAPON MODEL VIEWMODELS ─────────────────────────────────────
    _buildModelViewModel(data) {
        const w = createWeaponModel(data.modelId, 'fp');
        const group = new THREE.Group();
        const holder = new THREE.Group();          // reload tilt / inspect pivot
        group.add(holder);
        holder.add(w.root);
        w.root.position.copy(w.points.sight).negate();   // sight line sits on the group origin
        // see-through glass / lenses
        w.materials.forEach(m => {
            if (/glass|lens|polycarbonate/i.test(m.name)) { m.transparent = true; m.opacity = 0.18; m.depthWrite = false; m.roughness = 0.05; }
            if (/emission|tritium/i.test(m.name)) { m.emissive = new THREE.Color(m.color || 0xff2020); m.emissiveIntensity = 1.5; }
            if (/reticle/i.test(m.name)) { m.transparent = true; m.alphaTest = 0.3; m.depthWrite = false; }
            // polymer/cerakote is satin, not glossy; keep reflections subtle so the gun sits in the scene's light
            if (m.envMapIntensity !== undefined && !m.transparent) {
                m.envMapIntensity = m.metalness > 0.3 ? 1.0 : 0.7;
                if (m.metalness <= 0.3) m.roughness = Math.max(m.roughness ?? 0.6, 0.62);
            }
        });
        const rel = (p) => p.clone().sub(w.points.sight);
        const muzzle = new THREE.Object3D(); muzzle.position.copy(rel(w.points.muzzle)); holder.add(muzzle);
        const eject = new THREE.Object3D(); eject.position.copy(rel(w.points.eject || w.points.grip)); holder.add(eject);
        const flash = this.effects.createMuzzleFlash(holder, muzzle.position);
        const pistol = w.kind === 'pistol';
        return {
            group, holder, muzzle, eject, flash, model: w, baseScale: 1, fireT: 10, kind: w.kind,
            hip: pistol ? new THREE.Vector3(0.1, -0.12, -0.37) : new THREE.Vector3(0.165, -0.175, -0.4),
            hipYaw: pistol ? 0.03 : 0.06, hipRoll: pistol ? 0 : -0.04,
            ads: new THREE.Vector3(0, 0, -(data.adsRelief || 0.22))
        };
    }

    /** bolt / slide cycling, magazine swap, charging handle, reload tilt, then arm IK */
    _animateModel(dt, weapon, vm, sprinting) {
        const w = vm.model, pistol = w.kind === 'pistol';
        const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
        vm.fireT += dt;
        const cycle = Math.min(weapon.data.fireRate * 0.85, pistol ? 0.085 : 0.075);
        let bolt = vm.fireT < cycle * 0.35 ? vm.fireT / (cycle * 0.35) : Math.max(0, 1 - (vm.fireT - cycle * 0.35) / (cycle * 0.65));
        if (pistol && weapon.currentAmmo === 0 && !weapon.isReloading) bolt = 1;          // slide locks back on empty

        // reload choreography driven by the weapon's reload progress (events at .3 magOut / .7 magIn / .95 bolt)
        const p = weapon.isReloading && !weapon.shellByShell ? weapon.reloadProgress : -1;
        let magDrop = 0, magVis = true, rack = 0, tilt = 0, handPhase = 'hold';
        if (p >= 0) {
            tilt = sm(0, 0.12, p) * (1 - sm(0.9, 1, p));
            if (p < 0.12) handPhase = 'toMag';
            else if (p < 0.36) { handPhase = 'onMag'; magDrop = sm(0.14, 0.32, p) * (pistol ? 5 : 3.6); magVis = p < 0.34 || !pistol; if (p > 0.34) magVis = false; }
            else if (p < 0.5) { handPhase = 'away'; magVis = false; }
            else if (p < 0.72) { handPhase = 'onMag'; magDrop = (1 - sm(0.5, 0.7, p)) * 4.5; }
            else if (p < 0.8) handPhase = pistol ? 'support' : 'toCharge';
            else if (p < 0.95) {
                handPhase = pistol ? 'slide' : 'charge';
                rack = Math.sin(sm(0.8, 0.95, p) * Math.PI);
                if (pistol) bolt = 1 - sm(0.84, 0.92, p);
            } else handPhase = 'return';
            if (pistol && p < 0.84 && weapon.currentAmmo === 0) bolt = Math.max(bolt, 1);
        }
        w.setBolt(Math.max(bolt, pistol ? 0 : rack));
        w.setCharging(rack);
        w.setMag(magDrop, magVis);

        // weapon tilt toward the support hand during reloads, canted while sprinting
        const hold = vm.holder;
        hold.rotation.z = THREE.MathUtils.lerp(hold.rotation.z, tilt * (pistol ? 0.3 : 0.32), Math.min(1, dt * 12));
        hold.rotation.x = THREE.MathUtils.lerp(hold.rotation.x, tilt * 0.3, Math.min(1, dt * 12));
        hold.rotation.y = THREE.MathUtils.lerp(hold.rotation.y, tilt * 0.12, Math.min(1, dt * 12));
        hold.position.x = THREE.MathUtils.lerp(hold.position.x, -tilt * 0.07, Math.min(1, dt * 12));
        hold.position.y = THREE.MathUtils.lerp(hold.position.y, tilt * 0.02, Math.min(1, dt * 12));

        // looking through an optic: hide its body, show the scope / red-dot overlay
        const scoped = !!w.optic && weapon.ads > 0.86 && p < 0;
        w.opticNodes.forEach(n => { n.visible = !scoped; });
        this._setScopeOverlay(scoped ? w.optic : null);
        if (this.arms) this.arms.setVisible(!scoped);

        if (!this.arms) return;
        // ── hand targets (world)
        vm.group.updateWorldMatrix(true, true);
        const wq = w.root.getWorldQuaternion(new THREE.Quaternion());
        const W = (p) => w.root.localToWorld(p.clone());
        const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize().applyQuaternion(wq);
        const right = { pos: W(w.points.grip), fingerDir: D(0, -0.45, -0.9), palmNormal: D(-1, 0, 0), curl: 1, trigger: vm.fireT < 0.07 ? 1 : 0 };
        let left;
        if (pistol) left = { pos: W(w.points.grip.clone().add(new THREE.Vector3(-0.03, -0.035, 0.0))), fingerDir: D(0.35, -0.55, -0.75), palmNormal: D(0.85, 0.35, 0), curl: 0.95 };
        else if (w.points.support && (weapon.data.modelId === 'ak74m' || weapon.data.modelId === 'urgi'))   // vertical foregrip
            left = { pos: W(w.points.support), fingerDir: D(0, -0.4, -0.9), palmNormal: D(1, 0, 0), curl: 1 };
        else left = { pos: W(w.points.support || w.points.grip.clone().add(new THREE.Vector3(0, 0, -0.25))), fingerDir: D(0.45, 0.05, -0.9), palmNormal: D(0, 1, 0), curl: 0.85 };

        // reload hand path
        if (p >= 0) {
            const magW = w.magWorld(new THREE.Vector3()) || W(w.points.magWell || w.points.grip);
            const onMag = { pos: magW.clone().add(D(0, -1, 0).multiplyScalar(0.05)), fingerDir: D(0.2, 0.1, -1), palmNormal: D(0.55, 0.8, 0), curl: 0.9 };
            const camQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
            const away = { pos: this.camera.localToWorld(new THREE.Vector3(-0.12, -0.55, -0.3)), fingerDir: new THREE.Vector3(0, 0, -1).applyQuaternion(camQ), palmNormal: new THREE.Vector3(1, 0, 0).applyQuaternion(camQ), curl: 0.8 };
            const ch = w.points.charging ? W(w.points.charging.clone().add(new THREE.Vector3(0, 0, rack * 0.1))) : W(w.points.sight);
            const charge = { pos: ch, fingerDir: D(0.3, -0.2, -1), palmNormal: w.kind === 'ak' ? D(-1, 0, 0) : D(0, -1, 0), curl: 0.8 };
            const slide = { pos: W(w.points.sight.clone().add(new THREE.Vector3(0, -0.01, 0.02 + rack * 0.03))), fingerDir: D(0.2, 0, -1), palmNormal: D(0, -1, 0), curl: 0.7 };
            const blend = (A, B, t) => ({ pos: A.pos.clone().lerp(B.pos, t), fingerDir: A.fingerDir.clone().lerp(B.fingerDir, t), palmNormal: A.palmNormal.clone().lerp(B.palmNormal, t), curl: A.curl + (B.curl - A.curl) * t });
            if (handPhase === 'toMag') left = blend(left, onMag, sm(0, 0.12, p));
            else if (handPhase === 'onMag') left = p < 0.36 ? onMag : blend(away, onMag, sm(0.5, 0.58, p));
            else if (handPhase === 'away') left = blend(onMag, away, sm(0.36, 0.44, p));
            else if (handPhase === 'toCharge') left = blend(onMag, charge, sm(0.72, 0.8, p));
            else if (handPhase === 'charge') left = charge;
            else if (handPhase === 'slide') left = slide;
            else if (handPhase === 'support') left = blend(onMag, left, sm(0.72, 0.8, p));
            else if (handPhase === 'return') left = blend(pistol ? slide : charge, left, sm(0.95, 1, p));
        }
        // keep the support hand within reach: slide it back along the gun toward the grip
        const sh = this.arms.shoulderWorld('Left', new THREE.Vector3());
        const maxReach = this.arms.reach('Left') * 0.94;
        if (left.pos.distanceTo(sh) > maxReach) {
            const from = left.pos.clone(), to = right.pos;
            let lo = 0, hi = 1;
            for (let i = 0; i < 10; i++) {
                const mid = (lo + hi) / 2;
                if (_tmpReach.lerpVectors(from, to, mid).distanceTo(sh) > maxReach) lo = mid; else hi = mid;
            }
            left.pos.lerpVectors(from, to, hi);
        }
        this.arms.solve(right, left);
    }

    /** Hide the first-person rig (cinematic cameras). */
    setViewModelVisible(v) {
        this.rig.visible = v;
        if (this.arms) this.arms.setVisible(v && !!(this.currentViewModel && this.currentViewModel.model));
    }

    /** DOM overlay for scopes (vignette + reticle) and red dots. */
    _setScopeOverlay(type) {
        if (this._scopeType === type) return;
        this._scopeType = type;
        let el = document.getElementById('scope-overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'scope-overlay';
            el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4;display:none;';
            document.body.appendChild(el);
        }
        if (!type) { el.style.display = 'none'; globalEvents.emit('spread_update', { spread: 8, hidden: false }); return; }
        const line = (css) => `<div style="position:absolute;background:rgba(10,10,10,.92);${css}"></div>`;
        if (type === 'dot') {
            el.innerHTML = '<div style="position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px;border-radius:50%;background:#ff3020;box-shadow:0 0 6px 2px rgba(255,40,20,.8)"></div>'
                + '<div style="position:absolute;left:50%;top:50%;width:30vmin;height:30vmin;transform:translate(-50%,-50%);border-radius:50%;box-shadow:0 0 0 2px rgba(20,20,20,.55), inset 0 0 40px rgba(0,0,0,.35)"></div>';
        } else {
            const r = type === 'scope' ? 38 : 42;
            el.innerHTML = `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, rgba(0,0,0,0) ${r - 1}vmin, rgba(0,0,0,.55) ${r}vmin, #050505 ${r + 1.5}vmin)"></div>`
                + `<div style="position:absolute;left:50%;top:50%;width:${2 * r}vmin;height:${2 * r}vmin;transform:translate(-50%,-50%);border-radius:50%;box-shadow:inset 0 0 6vmin rgba(0,0,0,.65)"></div>`
                + line('left:calc(50% - 0.5px);top:calc(50% + 2vmin);width:1px;height:' + (r - 2) + 'vmin')
                + line('left:calc(50% - ' + r + 'vmin);top:calc(50% - 0.5px);width:' + (r - 2) + 'vmin;height:1px')
                + line('left:calc(50% + 2vmin);top:calc(50% - 0.5px);width:' + (r - 2) + 'vmin;height:1px')
                + line('left:calc(50% - 2px);top:calc(50% + 8vmin);width:4px;height:' + (r - 8) + 'vmin')
                + line('left:calc(50% - ' + r + 'vmin);top:calc(50% - 2px);width:' + (r - 8) + 'vmin;height:4px')
                + line('left:calc(50% + 8vmin);top:calc(50% - 2px);width:' + (r - 8) + 'vmin;height:4px')
                + (type === 'scope'
                    ? [1, 2, 3, 4].map(i => line(`left:calc(50% - 4px);top:calc(50% + ${i * 2}vmin);width:8px;height:1px`)).join('')
                    : '<div style="position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px;border-radius:50%;background:#ff4020;box-shadow:0 0 5px 1px rgba(255,60,30,.9)"></div>');
        }
        el.style.display = 'block';
        globalEvents.emit('spread_update', { spread: 8, hidden: true });
    }

    setBaseFOV(fov) { this.baseFov = fov; }

    updateHUD() {
        const w = this.current;
        if (!w) return;
        globalEvents.emit('weapon_update', {
            name: w.name,
            category: w.category,
            current: w.currentAmmo,
            reserve: w.reserveAmmo,
            magSize: w.magSize,
            reloading: w.isReloading,
            reloadProgress: w.reloadProgress,
            hitmarker: this.hitmarkerTimer > 0
        });
    }

    getMuzzleWorldPosition() {
        const vm = this.currentViewModel;
        if (!vm) return this.camera.getWorldPosition(new THREE.Vector3());
        return vm.muzzle.getWorldPosition(new THREE.Vector3());
    }

    dispose() {
        this.effects.clear();
        this.clearLoadout();
        this.camera.remove(this.rig);
        if (this.arms) this.camera.remove(this.arms.root);
    }
}

const _tmpReach = new THREE.Vector3();
