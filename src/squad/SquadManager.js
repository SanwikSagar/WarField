import * as THREE from '/node_modules/three/build/three.module.js';
import { globalEvents } from '../core/EventManager.js';
import { createCharacter, hasCharacters } from '../core/CharacterFactory.js';

/**
 * Squad AI (GDD 5.6 / 11.8). Friendly operators that hold a formation
 * offset behind the player, follow when moving, engage visible enemies with
 * suppressive fire, and can be ordered to hold position. Each member is a
 * procedural humanoid reusing the soldier look but with allied colors.
 */
export class SquadManager {
    constructor(scene, deps = {}) {
        this.scene = scene;
        this.deps = deps; // { getPlayerPos, getEnemies, getRaycastables, audio }
        this.members = [];
        this.command = 'follow'; // 'follow' | 'hold'
        this._tmp = new THREE.Vector3();
        this.raycaster = new THREE.Raycaster();
    }

    addMember(name, spawn, formationOffset) {
        const m = new SquadMember(this.scene, name, this.deps);
        m.spawn(spawn.x, spawn.z);
        m.formationOffset = formationOffset;
        this.members.push(m);
        return m;
    }

    clear() {
        this.members.forEach(m => m.dispose());
        this.members = [];
    }

    setCommand(cmd) {
        this.command = cmd;
        globalEvents.emit('squad_command', { command: cmd });
    }

    update(dt, playerPos) {
        for (let i = 0; i < this.members.length; i++) {
            const m = this.members[i];
            const target = this.command === 'hold'
                ? m.holdPosition
                : this._formationPos(playerPos, m.formationOffset, i);
            m.update(dt, playerPos, target);
        }
    }

    _formationPos(playerPos, offset, index) {
        // Offset is in player-local space; rotate by player facing is not
        // tracked here, so we use a simple trailing formation behind player.
        return this._tmp.copy(playerPos).add(offset).clone();
    }

    /** Alert the squad to a gunshot so they react to contact. */
    hearSound(pos) {
        this.members.forEach(m => m.hearSound(pos));
    }

    /** Radio line from a squad member: they talk and turn to the player. */
    onDialogue(d) {
        const m = this.members.find(x => x.isAlive && x.name.toUpperCase() === String(d.speaker || '').toUpperCase());
        if (m) m.talk(String(d.text || '').length * 0.06 + 0.6);
    }

    getMember(name) { return this.members.find(m => m.name.toUpperCase() === name.toUpperCase()) || null; }

    get aliveCount() { return this.members.filter(m => m.isAlive).length; }
}

class SquadMember {
    constructor(scene, name, deps) {
        this.scene = scene;
        this.name = name;
        this.deps = deps;
        this.isAlive = true;
        this.health = 100;
        this.height = 1.8;
        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.speed = 3.6;
        this.formationOffset = new THREE.Vector3();
        this.holdPosition = new THREE.Vector3();
        this.fireCooldown = 0;
        this.mag = 30;
        this.reloadT = -1;
        this.targetEnemy = null;
        this.animTime = Math.random() * 10;
        this.facing = new THREE.Vector3(0, 0, -1);
        // FIX: this raycaster was missing (it only existed on SquadManager), so the
        // first time a squad member spotted an enemy _hasLOS threw every frame,
        // aborting the game loop before render -> the "game freezes" bug.
        this.raycaster = new THREE.Raycaster();
        this._losCache = new Map();
        this._buildModel();
    }

    _buildModel() {
        // Real character model (dark clothing = ally team)
        const kind = { Hayes: 'army1', Ethan: 'army1', Maya: 'soldier', Reyes: 'soldier' }[this.name] || 'army1';
        const ch = hasCharacters() ? createCharacter(kind, 'ally', this.name === 'Maya' ? 'm5scw' : 'urgi') : null;
        if (ch) {
            this.char = ch; this.group = ch.root; this.materials = ch.materials;
            this.scene.add(this.group);
            return;
        }
        this.group = new THREE.Group();
        const uniform = new THREE.MeshStandardMaterial({ color: 0x404a3a, roughness: 0.85 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x2c3128, roughness: 0.9 });
        const gear = new THREE.MeshStandardMaterial({ color: 0x22261f, roughness: 0.7, metalness: 0.2 });
        const mk = (geo, mat, x, y, z) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, y, z);
            m.castShadow = true; m.receiveShadow = true;
            this.group.add(m);
            return m;
        };
        this.legL = mk(new THREE.BoxGeometry(0.18, 0.85, 0.2), dark, -0.12, 0.42, 0);
        this.legR = mk(new THREE.BoxGeometry(0.18, 0.85, 0.2), dark, 0.12, 0.42, 0);
        mk(new THREE.BoxGeometry(0.52, 0.62, 0.3), uniform, 0, 1.16, 0);
        mk(new THREE.BoxGeometry(0.54, 0.34, 0.36), gear, 0, 1.2, 0);
        this.armR = mk(new THREE.BoxGeometry(0.14, 0.6, 0.16), uniform, 0.34, 1.16, 0);
        mk(new THREE.BoxGeometry(0.14, 0.6, 0.16), uniform, -0.34, 1.16, 0);
        mk(new THREE.BoxGeometry(0.24, 0.26, 0.24), new THREE.MeshStandardMaterial({ color: 0x6b5642, roughness: 0.8 }), 0, 1.62, 0);
        mk(new THREE.BoxGeometry(0.28, 0.14, 0.28), gear, 0, 1.72, 0);
        this.rifle = mk(new THREE.BoxGeometry(0.08, 0.1, 0.6), gear, 0.18, 1.2, 0.28);
        this.scene.add(this.group);
        this.materials = [uniform, dark, gear];
    }

    spawn(x, z) {
        this.position.set(x, this.deps.heightAt ? this.deps.heightAt(x, z) : 0, z);
        this.holdPosition.copy(this.position);
        this.group.position.copy(this.position);
    }

    hearSound(pos) {
        // Squad reacts to contact by readying weapons
        this.alerted = true;
    }

    talk(seconds) {
        this.talkTime = seconds;
        if (this.char && this.char.talk) this.char.talk(seconds);
    }

    update(dt, playerPos, targetPos) {
        if (!this.isAlive) return;
        this.animTime += dt;
        this.fireCooldown -= dt;

        // Acquire nearest visible enemy
        this.targetEnemy = this._acquireTarget();

        if (this.targetEnemy) {
            // Stop and engage
            this.velocity.set(0, 0, 0);
            this.facing.subVectors(this.targetEnemy.position, this.position).setY(0).normalize();
            this._shoot(dt);
        } else {
            // Move to formation/target position
            const dir = this._tmpVec(targetPos, this.position);
            const dist = dir.length();
            if (dist > 2.2) {
                dir.normalize();
                this.velocity.copy(dir).multiplyScalar(Math.min(this.speed, dist * 1.5));
                this.facing.lerp(dir, dt * 5).normalize();
            } else {
                this.velocity.multiplyScalar(0.8);
                // idle speaker turns to face the player
                if (this.talkTime > 0 && playerPos) {
                    const toP = this._tmpVec(playerPos, this.position);
                    if (toP.lengthSq() > 0.01) this.facing.lerp(toP.normalize(), Math.min(1, dt * 3)).normalize();
                }
            }
        }
        this.talkTime = Math.max(0, (this.talkTime || 0) - dt);
        this._playerPos = playerPos;
        if (this.reloadT >= 0) { this.reloadT += dt; if (this.reloadT >= 2.3) { this.reloadT = -1; this.mag = 30; } }

        const vel = this._vel || (this._vel = new THREE.Vector3());
        vel.lerp(this.velocity, 1 - Math.exp(-dt * 7));
        this.position.addScaledVector(vel, dt);
        this.position.y = this.deps.heightAt ? this.deps.heightAt(this.position.x, this.position.z) : 0;
        { const w = this.deps.getWorld ? this.deps.getWorld() : null; if (w) w.resolve(this.position, 0.45, 0.25, 1.7); }
        this.group.position.copy(this.position);
        const yaw = Math.atan2(this.facing.x, this.facing.z);
        if (this._yaw === undefined) this._yaw = yaw;
        const dy = Math.atan2(Math.sin(yaw - this._yaw), Math.cos(yaw - this._yaw));
        this._yaw += dy * (1 - Math.exp(-dt * 8));
        this.group.rotation.y = this._yaw;
        this._animate(dt);
    }

    _tmpVec(target, self) {
        return new THREE.Vector3().subVectors(target, self).setY(0);
    }

    _acquireTarget() {
        const enemies = this.deps.getEnemies ? this.deps.getEnemies() : [];
        let best = null, bestDist = 55;
        for (const e of enemies) {
            if (!e.isAlive) continue;
            const d = e.position.distanceTo(this.position);
            if (d < bestDist) {
                // Basic LOS check
                if (this._hasLOS(e)) { best = e; bestDist = d; }
            }
        }
        return best;
    }

    _hasLOS(enemy) {
        const raycastables = this.deps.getRaycastables ? this.deps.getRaycastables() : [];
        if (!raycastables.length) return true;
        // Throttle: LOS per enemy is re-evaluated at most ~4x per second.
        const now = performance.now();
        const cached = this._losCache.get(enemy);
        if (cached && now - cached.t < 250) return cached.v;
        const v = this._computeLOS(enemy, raycastables);
        this._losCache.set(enemy, { t: now, v });
        return v;
    }

    _computeLOS(enemy, raycastables) {
        const world = this.deps.getWorld ? this.deps.getWorld() : null;
        if (world) return !world.segmentBlocked(this.position.x, this.position.z, enemy.position.x, enemy.position.z, 1.4);
        const from = this.position.clone().setY(1.5);
        const to = enemy.position.clone().setY(1.2);
        const dir = to.clone().sub(from);
        const d = dir.length();
        dir.normalize();
        this.raycaster.set(from, dir);
        this.raycaster.far = d;
        return this.raycaster.intersectObjects(raycastables, false).length === 0;
    }

    _shoot(dt) {
        if (this.fireCooldown > 0 || !this.targetEnemy || this.reloadT >= 0) return;
        this.fireCooldown = 0.28;
        if (--this.mag <= 0) this.reloadT = 0;
        const muzzle = this.char && this.char.muzzleWorld ? this.char.muzzleWorld() : this.position.clone().setY(this.position.y + 1.3);
        const dist = muzzle.distanceTo(this.targetEnemy.position);
        if (this.deps.audio) {
            const hear = this._playerPos ? muzzle.distanceTo(this._playerPos) : dist;
            this.deps.audio.playGunshot({ body: 950, crack: 3600, decay: 0.2, gain: 0.35, dist: Math.min(1, hear / 35), delay: hear / 343 });
        }
        // Squad suppresses: chip damage so the player isn't doing everything
        const aim = this.targetEnemy.position.clone().setY(this.targetEnemy.position.y + 1.1 + (Math.random() - 0.5) * 0.6);
        const hit = this.targetEnemy.isAlive && Math.random() < 0.5;
        const fx = this.deps.getEffects ? this.deps.getEffects() : null;
        if (fx) {
            const dir = aim.clone().sub(muzzle).normalize();
            fx.npcMuzzleFlash(muzzle, dir);
            if (hit) { fx.spawnTracer(muzzle, aim, { width: 0.01, speed: 320 }); fx.spawnHitMarker(aim); }
            else {
                const miss = aim.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2));
                if (this.deps.heightAt) miss.y = this.deps.heightAt(miss.x, miss.z);
                fx.spawnTracer(muzzle, miss, { width: 0.01, speed: 320 });
                fx.spawnImpact(miss, new THREE.Vector3(0, 1, 0), 'dirt');
            }
        } else this._muzzleFlash(muzzle);
        if (hit) {
            const killed = this.targetEnemy.takeDamage(12, muzzle.clone(), false);
            if (killed) globalEvents.emit('squad_kill', { by: this.name });
        }
        if (this.char && this.char.kick) this.char.kick();
    }

    _muzzleFlash(pos) {
        if (!this._flash) {
            const c = document.createElement('canvas'); c.width = c.height = 64;
            const ctx = c.getContext('2d');
            const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(1, 'rgba(255,140,40,0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
            this._flash = new THREE.Sprite(new THREE.SpriteMaterial({
                map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending,
                transparent: true, depthWrite: false, opacity: 0
            }));
            this._flash.scale.set(0.45, 0.45, 0.45);
            this.scene.add(this._flash);
        }
        this._flash.position.copy(pos);
        this._flash.material.opacity = 1;
        this._flashTimer = 0.05;
    }

    _animate(dt) {
        if (this.char) {
            if (this._flashTimer > 0) { this._flashTimer -= dt; if (this._flashTimer <= 0 && this._flash) this._flash.material.opacity = 0; }
            let look;
            if (this._playerPos) {
                const dx = this._playerPos.x - this.position.x, dz = this._playerPos.z - this.position.z;
                if (dx * dx + dz * dz < 144) {
                    let rel = Math.atan2(dx, dz) - this.group.rotation.y;
                    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
                    if (Math.abs(rel) < 2) look = rel;
                }
            }
            const v = this._vel || this.velocity, sp = v.length();
            const ys = Math.sin(this._yaw || 0), yc = Math.cos(this._yaw || 0);
            this.char.update(dt, {
                speed: sp, aiming: !!this.targetEnemy && !(this.reloadT >= 0), dead: false, look,
                moveZ: sp > 0.05 ? (v.x * ys + v.z * yc) / sp : 1, moveX: sp > 0.05 ? (v.x * yc - v.z * ys) / sp : 0,
                reload: this.reloadT >= 0 ? this.reloadT / 2.3 : -1
            });
            return;
        }
        if (this._flashTimer > 0) {
            this._flashTimer -= dt;
            if (this._flashTimer <= 0 && this._flash) this._flash.material.opacity = 0;
        }
        const sp = this.velocity.length() / 3;
        const walk = Math.sin(this.animTime * 8) * 0.5 * Math.min(1, sp);
        if (this.legL) this.legL.rotation.x = walk;
        if (this.legR) this.legR.rotation.x = -walk;
        const aiming = !!this.targetEnemy;
        if (this.armR) this.armR.rotation.x = aiming ? -1.3 : walk * 0.6;
        if (this.rifle) this.rifle.rotation.x = aiming ? -0.3 : 0;
    }

    dispose() {
        this.scene.remove(this.group);
        if (this._flash) this.scene.remove(this._flash);
        if (this.char) { this.char.dispose(); return; }
        this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        this.materials.forEach(m => m.dispose());
    }
}
