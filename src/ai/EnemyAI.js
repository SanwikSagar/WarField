import * as THREE from 'three';
import { globalEvents } from '../core/EventManager.js';
import { createCharacter, hasCharacters } from '../core/CharacterFactory.js';

/**
 * State-machine enemy soldier (GDD 5.5 / 11.7). States: PATROL, SUSPICIOUS,
 * SEARCHING, COMBAT, FLANKING, RETREATING, DEAD. Perception uses distance,
 * field of view, and a line-of-sight raycast against level geometry so AI
 * never has unfair knowledge of the player's position.
 *
 * Expensive perception runs on a staggered interval, not every frame, and
 * distant AI updates less often (GDD 12.3). The soldier is a procedural
 * humanoid with separate head/torso hit meshes so headshots register.
 */
export class EnemyAI {
    constructor(scene, deps = {}) {
        this.scene = scene;
        this.deps = deps;                 // { getPlayerPos, getRaycastables, getCover, audio, difficulty, onPlayerDamage }
        this.difficulty = deps.difficulty || 'regular';

        this.height = 1.8;
        this.radius = 0.45;
        this.isAlive = true;
        this.health = 100;
        this.maxHealth = 100;

        this.state = 'PATROL';
        this.stateTime = 0;
        this.speed = 2.2;
        this.visionRange = 45;
        this.visionFov = Math.cos(THREE.MathUtils.degToRad(70)); // ~140° cone
        this.hearingRange = 18;

        this.lastKnownPlayerPos = null;
        this.lastSeenTime = -10;
        this.patrolPoints = [];
        this.patrolIndex = 0;
        this.currentTarget = new THREE.Vector3();
        this.coverPoint = null;
        this.repathTimer = 0;

        // Combat tuning
        this.fireCooldown = 0;
        this.burstCount = 0;
        this.burstTimer = 0;
        this.reactionDelay = 0.35;
        this.accuracy = 0.5;
        this.applyDifficulty(this.difficulty);

        this.perceptionTimer = Math.random() * 0.2;
        this.perceptionInterval = 0.18;
        this.animTime = Math.random() * 10;
        this.hitFlash = 0;
        this.deathTimer = 0;
        this.alertedNearby = false;

        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.facing = new THREE.Vector3(0, 0, -1);
        this._vel = new THREE.Vector3();          // smoothed velocity actually applied (no instant direction flips)
        this._yaw = Math.PI;
        this.mag = 30;
        this.reloadT = -1;
        this._stepTimer = 0;
        this.suppressed = 0;

        this._buildModel();
        this.raycaster = new THREE.Raycaster();
        this._tmp = new THREE.Vector3();
    }

    applyDifficulty(diff) {
        const table = {
            recruit:  { health: 80,  accuracy: 0.3, damage: 6,  reaction: 0.55, fireRate: 0.5, aggression: 0.6 },
            regular:  { health: 100, accuracy: 0.5, damage: 10, reaction: 0.35, fireRate: 0.35, aggression: 0.8 },
            veteran:  { health: 120, accuracy: 0.68, damage: 15, reaction: 0.25, fireRate: 0.25, aggression: 0.95 },
            realistic:{ health: 140, accuracy: 0.82, damage: 24, reaction: 0.18, fireRate: 0.18, aggression: 1.0 }
        };
        const t = table[diff] || table.regular;
        this.maxHealth = t.health;
        this.health = t.health;
        this.accuracy = t.accuracy;
        this.damage = t.damage;
        this.reactionDelay = t.reaction;
        this.fireRate = t.fireRate;
        this.aggression = t.aggression;
    }

    _buildModel() {
        // Real character model (light clothing = enemy team); falls back to the blocky one
        const ch = hasCharacters() ? createCharacter(this.deps.characterKind || 'army2', 'enemy', 'ak74m') : null;
        if (ch) {
            this.char = ch;
            this.group = ch.root;
            this.head = ch.head; this.torso = ch.body;
            this.hitMeshes = ch.hitMeshes;
            this.hitMeshes.forEach(m => { m.userData.enemy = this; });
            this.materials = ch.materials;
            this.scene.add(this.group);
            return;
        }
        this.group = new THREE.Group();
        const uniform = new THREE.MeshStandardMaterial({ color: 0x3d4436, roughness: 0.85, metalness: 0.05 });
        const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d26, roughness: 0.9 });
        const skin = new THREE.MeshStandardMaterial({ color: 0x6b5642, roughness: 0.8 });
        const gear = new THREE.MeshStandardMaterial({ color: 0x1f211c, roughness: 0.7, metalness: 0.2 });

        const mk = (geo, mat, x, y, z, name) => {
            const m = new THREE.Mesh(geo, mat);
            m.position.set(x, y, z);
            m.castShadow = true;
            m.receiveShadow = true;
            m.name = name || '';
            this.group.add(m);
            return m;
        };

        // Legs (animated)
        this.legL = mk(new THREE.BoxGeometry(0.18, 0.85, 0.2), dark, -0.12, 0.42, 0);
        this.legR = mk(new THREE.BoxGeometry(0.18, 0.85, 0.2), dark, 0.12, 0.42, 0);
        // Torso
        this.torso = mk(new THREE.BoxGeometry(0.52, 0.62, 0.3), uniform, 0, 1.16, 0, 'body');
        // Vest / gear
        mk(new THREE.BoxGeometry(0.54, 0.34, 0.36), gear, 0, 1.2, 0.0);
        // Arms (animated)
        this.armL = mk(new THREE.BoxGeometry(0.14, 0.6, 0.16), uniform, -0.34, 1.16, 0);
        this.armR = mk(new THREE.BoxGeometry(0.14, 0.6, 0.16), uniform, 0.34, 1.16, 0);
        // Head
        this.head = mk(new THREE.BoxGeometry(0.24, 0.26, 0.24), skin, 0, 1.62, 0, 'head');
        // Helmet
        mk(new THREE.BoxGeometry(0.28, 0.14, 0.28), gear, 0, 1.72, 0);
        // Rifle held in front
        this.rifle = mk(new THREE.BoxGeometry(0.08, 0.1, 0.6), gear, 0.18, 1.2, 0.28);

        // Hit meshes for raycasting (head separate for headshots)
        this.hitMeshes = [this.head, this.torso];
        this.hitMeshes.forEach(m => m.userData.enemy = this);

        this.scene.add(this.group);
        this.materials = [uniform, dark, skin, gear];
    }

    spawn(x, z, patrol = []) {
        this.position.set(x, this.deps.heightAt ? this.deps.heightAt(x, z) : 0, z);
        this.group.position.copy(this.position);
        this.patrolPoints = patrol.length
            ? patrol.map(p => new THREE.Vector3(p.x, 0, p.z))
            : [new THREE.Vector3(x, 0, z)];
        this.currentTarget.copy(this.patrolPoints[0]);
    }

    /** Called when a gunshot or impact happens nearby — alerts the AI. */
    hearSound(worldPos, loudness = 1) {
        if (!this.isAlive) return;
        const dist = this.position.distanceTo(worldPos);
        if (dist < this.hearingRange * loudness) {
            if (this.state === 'PATROL' || this.state === 'SUSPICIOUS') {
                this._setState('SUSPICIOUS');
                this.lastKnownPlayerPos = worldPos.clone();
            }
        }
    }

    takeDamage(amount, point, isHeadshot) {
        if (!this.isAlive) return false;
        this.health -= amount;
        this.hitFlash = 0.12;
        this.lastKnownPlayerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos().clone() : null;
        this.lastSeenTime = this._now();

        // Getting shot always alerts and turns the AI toward the threat
        if (this.state !== 'COMBAT') this._setState('COMBAT');
        this.alertNearby();

        if (this.deps.audio) this.deps.audio.playGrunt(isHeadshot ? 0.5 : 0.3);

        if (this.health <= 0) {
            this.die(isHeadshot);
            return true;
        }
        // Flinch / seek cover under fire
        if (Math.random() < 0.4 && this.state === 'COMBAT') {
            this._setState('FLANKING');
        }
        return false;
    }

    /** Rounds snapping past: duck, lose accuracy, and look for cover. */
    suppress(amount = 1) {
        if (!this.isAlive) return;
        this.suppressed = Math.min(3, this.suppressed + amount * 1.5);
        if (this.state === 'PATROL' || this.state === 'SUSPICIOUS') {
            this.lastKnownPlayerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos().clone() : null;
            this._setState('SUSPICIOUS');
        } else if (this.state === 'COMBAT' && Math.random() < 0.2 * amount) {
            this._setState('FLANKING');
        }
    }

    die(isHeadshot) {
        this.isAlive = false;
        this._setState('DEAD');
        this.deathTimer = 0;
        // fall away from the shooter: backward if hit from the front, forward if from behind
        const pp = this.deps.getPlayerPos ? this.deps.getPlayerPos() : null;
        const fwd = new THREE.Vector3(Math.sin(this._yaw), 0, Math.cos(this._yaw));
        const fromFront = pp ? pp.clone().sub(this.position).setY(0).normalize().dot(fwd) > 0 : true;
        this._fall = { dir: fromFront ? -1 : 1, roll: (Math.random() - 0.5) * 0.6, landed: false, ground: this.position.y, delay: isHeadshot ? 0.05 : 0.18 + Math.random() * 0.12 };
        this._dropWeapon();
        const fx = this._fx();
        if (fx) fx.spawnHitMarker(this.position.clone().setY(this.position.y + (isHeadshot ? 1.62 : 1.25)));
        globalEvents.emit('enemy_killed', { headshot: isHeadshot, position: this.position.clone() });
        if (this.deps.audio) this.deps.audio.playGrunt(0.5);
    }

    _fx() { return this.deps.getEffects ? this.deps.getEffects() : null; }

    _dropWeapon() {
        const rf = this.char && this.char.rifle;
        if (!rf) return;
        this.scene.attach(rf);
        const side = new THREE.Vector3(Math.cos(this._yaw), 0, -Math.sin(this._yaw)).multiplyScalar((Math.random() - 0.5) * 2.4);
        this._drop = { o: rf, vel: side.add(new THREE.Vector3(0, 1.2 + Math.random(), 0)), spin: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8), rest: false };
    }

    alertNearby() {
        if (this.alertedNearby) return;
        this.alertedNearby = true;
        if (this.char && this.char.talk) this.char.talk(1.4);   // shouted callout
        globalEvents.emit('ai_alert', { position: this.position.clone(), source: this });
    }

    _setState(s) {
        if (this.state === s) return;
        this.state = s;
        this.stateTime = 0;
        this.fireCooldown = this.reactionDelay;
        this.burstCount = 0;
        if (s === 'COMBAT' || s === 'FLANKING') this._pickCover();
    }

    _now() { return performance.now() / 1000; }

    _pickCover() {
        const cover = this.deps.getCover ? this.deps.getCover() : [];
        const playerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos() : null;
        if (!cover.length || !playerPos) { this.coverPoint = null; return; }
        // Choose a cover point near self that breaks LOS from the player
        let best = null, bestScore = Infinity;
        for (const c of cover) {
            const dSelf = c.distanceTo(this.position);
            if (dSelf > 22) continue;
            const dPlayer = c.distanceTo(playerPos);
            const score = dSelf - dPlayer * 0.3;
            if (score < bestScore) { bestScore = score; best = c; }
        }
        this.coverPoint = best ? best.clone() : null;
    }

    _canSeePlayer() {
        const playerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos() : null;
        if (!playerPos) return false;
        const toPlayer = this._tmp.subVectors(playerPos, this.position);
        const dist = toPlayer.length();
        if (dist > this.visionRange) return false;
        toPlayer.normalize();

        // FOV check (ignore while already in combat — they know where you are)
        if (this.state !== 'COMBAT' && this.state !== 'FLANKING') {
            const dot = toPlayer.dot(this.facing);
            if (dot < this.visionFov) return false;
        }

        // Line of sight: grid-based test against walls, props AND trees
        const world = this.deps.getWorld ? this.deps.getWorld() : null;
        if (world) return !world.segmentBlocked(this.position.x, this.position.z, playerPos.x, playerPos.z, 1.4);
        const raycastables = this.deps.getRaycastables ? this.deps.getRaycastables() : [];
        const eyePos = this.position.clone().setY(1.6);
        const targetPos = playerPos.clone().setY(playerPos.y - 0.2);
        const dir = targetPos.sub(eyePos);
        const d = dir.length();
        dir.normalize();
        this.raycaster.set(eyePos, dir);
        this.raycaster.far = d;
        const hits = this.raycaster.intersectObjects(raycastables, false);
        return hits.length === 0;
    }

    update(dt) {
        if (this.state === 'DEAD') {
            this._updateDeath(dt);
            return;
        }
        if (!this.isAlive) return;

        this.stateTime += dt;
        this.animTime += dt;
        if (this.hitFlash > 0) this.hitFlash -= dt;
        this._applyHitFlash();

        // Enemy muzzle flash decay
        if (this._flashTimer > 0) {
            this._flashTimer -= dt;
            if (this._flashTimer <= 0 && this._flashSprite) this._flashSprite.material.opacity = 0;
        }

        // Staggered perception (GDD 12.3)
        this.perceptionTimer -= dt;
        let canSee = false;
        if (this.perceptionTimer <= 0) {
            this.perceptionTimer = this.perceptionInterval;
            canSee = this._canSeePlayer();
            if (canSee) {
                this.lastKnownPlayerPos = this.deps.getPlayerPos().clone();
                this.lastSeenTime = this._now();
            }
        } else {
            canSee = this._canSeePlayerCached();
        }
        this._visibleThisFrame = canSee;
        this.suppressed = Math.max(0, this.suppressed - dt);
        if (this.reloadT >= 0) {
            this.reloadT += dt;
            if (this.reloadT >= 2.4) { this.reloadT = -1; this.mag = 30; }
        }

        this._updateStateMachine(dt, canSee);
        this._applyMovement(dt);
        this._updateAnimation(dt);
        this.group.position.copy(this.position);
    }

    _canSeePlayerCached() {
        // Cheap version between full perception ticks: reuse last LOS result
        // if the player is roughly where we last saw them.
        if (!this.lastKnownPlayerPos) return false;
        const playerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos() : null;
        if (!playerPos) return false;
        const dist = this.position.distanceTo(playerPos);
        if (dist > this.visionRange) return false;
        if (this.state === 'COMBAT' || this.state === 'FLANKING') {
            return (this._now() - this.lastSeenTime) < 1.5;
        }
        return false;
    }

    _updateStateMachine(dt, canSee) {
        const playerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos() : null;
        const sinceSeen = this._now() - this.lastSeenTime;

        switch (this.state) {
            case 'PATROL': {
                if (canSee) { this._setState('COMBAT'); break; }
                // Move along patrol route
                const target = this.patrolPoints[this.patrolIndex];
                this.currentTarget.copy(target);
                if (this.position.distanceTo(target) < 1.5) {
                    this.patrolIndex = (this.patrolIndex + 1) % this.patrolPoints.length;
                }
                this.speed = 1.6;
                break;
            }
            case 'SUSPICIOUS': {
                if (canSee) { this._setState('COMBAT'); break; }
                if (this.lastKnownPlayerPos) this.currentTarget.copy(this.lastKnownPlayerPos);
                this.speed = 2.4;
                if (this.position.distanceTo(this.currentTarget) < 2 || this.stateTime > 6) {
                    this._setState(this.stateTime > 6 ? 'PATROL' : 'SEARCHING');
                }
                break;
            }
            case 'SEARCHING': {
                if (canSee) { this._setState('COMBAT'); break; }
                // Wander around last known position
                if (this.stateTime > 5 || this.position.distanceTo(this.currentTarget) < 1.5) {
                    const base = this.lastKnownPlayerPos || this.position;
                    this.currentTarget.set(
                        base.x + (Math.random() - 0.5) * 12,
                        0,
                        base.z + (Math.random() - 0.5) * 12
                    );
                    this.stateTime = 0;
                }
                this.speed = 2.2;
                if (this.stateTime > 12) this._setState('PATROL');
                break;
            }
            case 'COMBAT': {
                if (!canSee && sinceSeen > 4) { this._setState('SEARCHING'); break; }
                this.speed = 2.8;
                if (playerPos) this.currentTarget.copy(playerPos);
                // Maintain engagement distance, strafe, use cover
                this._combatBehavior(dt, canSee, playerPos);
                this._tryShoot(dt, canSee);
                break;
            }
            case 'FLANKING': {
                if (this.coverPoint) this.currentTarget.copy(this.coverPoint);
                this.speed = 3.4;
                if (this.position.distanceTo(this.currentTarget) < 2 || this.stateTime > 3.5) {
                    this._setState('COMBAT');
                }
                this._tryShoot(dt, canSee);
                break;
            }
            case 'RETREATING': {
                if (this.coverPoint) this.currentTarget.copy(this.coverPoint);
                this.speed = 3.2;
                if (this.stateTime > 3 || this.health > this.maxHealth * 0.4) this._setState('COMBAT');
                break;
            }
        }

        // Low health -> retreat
        if ((this.state === 'COMBAT') && this.health < this.maxHealth * 0.25 && Math.random() < 0.01) {
            this._pickCover();
            this._setState('RETREATING');
        }
    }

    _combatBehavior(dt, canSee, playerPos) {
        if (!playerPos) return;
        const toPlayer = this._tmp.subVectors(playerPos, this.position);
        const dist = toPlayer.length();
        const ideal = 12;
        // Move toward/away to hold ideal range, plus lateral strafe
        toPlayer.y = 0;
        toPlayer.normalize();
        const strafe = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x);
        const strafeDir = Math.sin(this.animTime * 0.7 + this.position.x) > 0 ? 1 : -1;

        this.velocity.set(0, 0, 0);
        if (dist > ideal + 3) this.velocity.addScaledVector(toPlayer, this.speed);
        else if (dist < ideal - 4) this.velocity.addScaledVector(toPlayer, -this.speed * 0.7);
        this.velocity.addScaledVector(strafe, strafeDir * this.speed * 0.6);

        // Face the player
        this.facing.copy(toPlayer).normalize();
    }

    _tryShoot(dt, canSee) {
        this.fireCooldown -= dt;
        if (this.reloadT >= 0) return;
        if (!canSee || this.fireCooldown > 0) return;
        const playerPos = this.deps.getPlayerPos ? this.deps.getPlayerPos() : null;
        if (!playerPos) return;

        // Burst fire
        this.burstCount++;
        this.fireCooldown = this.fireRate;
        this._shootAtPlayer(playerPos);
        if (--this.mag <= 0) { this.reloadT = 0; this.burstCount = 0; return; }

        if (this.burstCount >= 3 + Math.floor(this.aggression * 4)) {
            this.burstCount = 0;
            this.fireCooldown = 0.7 + Math.random() * 0.8 * (1.2 - this.aggression);
        }
    }

    _shootAtPlayer(playerPos) {
        const muzzle = this.char && this.char.muzzleWorld ? this.char.muzzleWorld() : this.position.clone().setY(this.position.y + 1.3);
        const ps = this.deps.getPlayerState ? this.deps.getPlayerState() : {};
        // aim centre of mass, not the eyes; crouching drops the target
        const aimPoint = playerPos.clone(); aimPoint.y -= ps.crouched ? 0.35 : 0.45;
        const dir = aimPoint.sub(muzzle).normalize();
        // Inaccuracy: skill, recoil climb through the burst, shooting on the move,
        // a moving / crouched target, wounds and incoming suppressive fire
        let spread = (1 - this.accuracy) * 0.12 + 0.006;
        spread *= 1 + this.burstCount * 0.12;
        if (this._vel.lengthSq() > 1) spread *= 1.5;
        if (ps.moving) spread *= ps.sprinting ? 1.6 : 1.25;
        if (this.health < this.maxHealth * 0.45) spread *= 1.3;
        if (this.suppressed > 0) spread *= 1.9;
        dir.x += (Math.random() - 0.5) * spread;
        dir.y += (Math.random() - 0.5) * spread - spread * 0.15 * this.burstCount;
        dir.z += (Math.random() - 0.5) * spread;
        dir.normalize();

        const dist = muzzle.distanceTo(playerPos);
        const pan = this.deps.getAudioPan ? this.deps.getAudioPan(this.position) : 0;
        if (this.deps.audio) {
            // the report arrives at the speed of sound (~343 m/s)
            this.deps.audio.playGunshot({ sample: 'ak', body: 1000, crack: 3800, decay: 0.22, gain: 0.55, dist: Math.min(1, dist / 40), pan, delay: dist / 343 });
        }
        // Muzzle flash on the enemy
        const fx = this._fx();
        if (fx) fx.npcMuzzleFlash(muzzle, dir); else this._enemyMuzzleFlash(muzzle);
        if (this.char && this.char.kick) this.char.kick();

        // Raycast: does it hit the player (or get blocked by geometry)?
        this.raycaster.set(muzzle, dir);
        this.raycaster.far = dist + 1;
        const raycastables = this.deps.getRaycastables ? this.deps.getRaycastables() : [];
        const worldHits = this.raycaster.intersectObjects(raycastables, false);
        let blockedDist = worldHits.length ? worldHits[0].distance : Infinity;
        const wld = this.deps.getWorld ? this.deps.getWorld() : null;
        if (wld) blockedDist = Math.min(blockedDist, wld.rayHit(muzzle.x, muzzle.y, muzzle.z, dir.x, dir.y, dir.z, dist + 1));

        // Player hit test (capsule approximated as a vertical segment)
        const toPlayer = playerPos.clone().sub(muzzle);
        toPlayer.y -= ps.crouched ? 0.35 : 0.5;
        const proj = toPlayer.dot(dir);
        let hitPlayer = false;
        if (proj > 0 && proj < blockedDist) {
            const closest = muzzle.clone().addScaledVector(dir, proj);
            const center = muzzle.clone().add(toPlayer);
            const off = closest.sub(center);
            // capsule: ~0.3 m wide, body height depends on stance
            const halfH = ps.crouched ? 0.45 : 0.8;
            const horiz = Math.hypot(off.x, off.z), vert = Math.max(0, Math.abs(off.y) - halfH);
            const perpDist = Math.hypot(horiz, vert);
            if (perpDist < 0.32) {
                hitPlayer = true;
                // Hit the player — scale damage by distance falloff
                const dmg = this.damage * (1 - Math.min(0.5, dist / 80));
                if (this.deps.onPlayerDamage) this.deps.onPlayerDamage(dmg, dir);
                globalEvents.emit('player_hit_direction', { dir: dir.clone() });
            } else if (perpDist < 2.5) {
                // supersonic crack of a round snapping past
                if (this.deps.audio && this.deps.audio.playBulletCrack) this.deps.audio.playBulletCrack(0.55 * (1 - perpDist / 2.5) + 0.15, pan);
                globalEvents.emit('near_miss', { amount: 1 - perpDist / 2.5 });
            }
        }
        if (fx) this._shotEffects(fx, muzzle, dir, dist, blockedDist, hitPlayer, playerPos);
    }

    /** Incoming fire the player can read: tracers, cover chipping, dirt kicks around them. */
    _shotEffects(fx, muzzle, dir, dist, blockedDist, hitPlayer, playerPos) {
        const tracerOpts = { always: Math.random() < 0.55, color: 0xffc070, width: 0.012, speed: 320 };
        if (blockedDist < dist && !hitPlayer) {
            const p = muzzle.clone().addScaledVector(dir, blockedDist);
            fx.spawnTracer(muzzle, p, tracerOpts);
            if (p.distanceTo(playerPos) < 25) fx.spawnImpact(p, dir.clone().negate(), 'concrete');
            return;
        }
        if (hitPlayer) { fx.spawnTracer(muzzle, muzzle.clone().addScaledVector(dir, dist - 1.2), tracerOpts); return; }
        // miss: the round flies past and kicks up dirt where it lands behind / beside the player
        const heightAt = this.deps.heightAt;
        let end = muzzle.clone().addScaledVector(dir, dist + 30);
        if (heightAt) {
            for (let t = dist * 0.6; t < dist + 30; t += 0.75) {
                const q = muzzle.clone().addScaledVector(dir, t);
                const gy = heightAt(q.x, q.z);
                if (q.y <= gy) { end = q.setY(gy); if (q.distanceTo(playerPos) < 20) fx.spawnImpact(end, new THREE.Vector3(0, 1, 0), 'dirt'); break; }
            }
        }
        fx.spawnTracer(muzzle, end, tracerOpts);
    }

    _enemyMuzzleFlash(pos) {
        if (!this._flashSprite) {
            const tex = new THREE.CanvasTexture(this._makeFlashCanvas());
            this._flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: tex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0
            }));
            this._flashSprite.scale.set(0.5, 0.5, 0.5);
            this.scene.add(this._flashSprite);
        }
        this._flashSprite.position.copy(pos);
        this._flashSprite.material.opacity = 1;
        this._flashTimer = 0.05;
    }

    _makeFlashCanvas() {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, 'rgba(255,240,200,1)');
        g.addColorStop(1, 'rgba(255,140,40,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        return c;
    }

    _applyMovement(dt) {
        if (this.state === 'COMBAT') {
            // velocity already set by _combatBehavior
        } else {
            const dir = this.currentTarget.clone().sub(this.position);
            dir.y = 0;
            const dist = dir.length();
            if (dist > 0.5) {
                dir.normalize();
                this.velocity.copy(dir).multiplyScalar(this.speed);
                this.facing.lerp(dir, dt * 6).normalize();
            } else {
                this.velocity.set(0, 0, 0);
            }
        }

        // Simple obstacle avoidance: raycast forward, steer if blocked
        if (this.velocity.lengthSq() > 0.01) {
            const moveDir = this.velocity.clone().normalize();
            const wld = this.deps.getWorld ? this.deps.getWorld() : null;
            const blocked = wld
                ? wld.segmentBlocked(this.position.x, this.position.z, this.position.x + moveDir.x * 1.6, this.position.z + moveDir.z * 1.6, 0.9)
                : false;
            if (blocked) {
                // Strafe around the obstacle
                const perp = new THREE.Vector3(-moveDir.z, 0, moveDir.x);
                this.velocity.copy(perp).multiplyScalar(this.speed * (this.position.x % 2 > 0 ? 1 : -1));
            }
        }

        // smoothed velocity: direction changes ease in instead of snapping (no foot skating)
        if (this.health < this.maxHealth * 0.45) this.velocity.multiplyScalar(0.68);    // wounded: limping
        this._vel.lerp(this.velocity, 1 - Math.exp(-dt * 7));
        this.position.addScaledVector(this._vel, dt);
        this.position.y = this.deps.heightAt ? this.deps.heightAt(this.position.x, this.position.z) : 0;
        { const w = this.deps.getWorld ? this.deps.getWorld() : null; if (w) w.resolve(this.position, 0.45, 0.25, 1.7); }
        // Clamp to level bounds
        const bounds = this.deps.bounds || 200;
        this.position.x = THREE.MathUtils.clamp(this.position.x, -bounds, bounds);
        this.position.z = THREE.MathUtils.clamp(this.position.z, -bounds, bounds);

        // turn toward the facing direction at a human rate
        const yaw = Math.atan2(this.facing.x, this.facing.z);
        let dy = yaw - this._yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this._yaw += dy * (1 - Math.exp(-dt * 9));
        this.group.rotation.y = this._yaw;

        // footstep dust on dry ground
        const sp = this._vel.length();
        if (this.deps.dusty && sp > 2.4) {
            this._stepTimer -= dt;
            if (this._stepTimer <= 0) { this._stepTimer = 0.32; const fx = this._fx(); if (fx) fx.footDust(this.position); }
        }
    }

    _updateAnimation(dt) {
        if (this.char) {
            const aiming = this.state === 'COMBAT' || this.state === 'FLANKING';
            const hit = this.hitFlash > 0.1 && !this._hitSent; this._hitSent = this.hitFlash > 0.1;
            const v = this._vel, sp = v.length();
            const s = Math.sin(this._yaw), c = Math.cos(this._yaw);
            const moveZ = sp > 0.05 ? (v.x * s + v.z * c) / sp : 1;
            const moveX = sp > 0.05 ? (v.x * c - v.z * s) / sp : 0;
            this.char.update(dt, { speed: sp, aiming: aiming && this.reloadT < 0, dead: false, hit, moveX, moveZ, reload: this.reloadT >= 0 ? this.reloadT / 2.4 : -1,
                crouch: this.suppressed > 0.8 && sp < 1.5, limp: this.health < this.maxHealth * 0.45 });
            return;
        }
        const speedFactor = this.velocity.length() / 3;
        const walk = Math.sin(this.animTime * 8) * 0.5 * Math.min(1, speedFactor);
        if (this.legL) this.legL.rotation.x = walk;
        if (this.legR) this.legR.rotation.x = -walk;
        if (this.armL) this.armL.rotation.x = -walk * 0.6;
        // Aim rifle toward facing when in combat
        const aiming = (this.state === 'COMBAT' || this.state === 'FLANKING');
        if (this.armR) this.armR.rotation.x = aiming ? -1.3 : walk * 0.6;
        if (this.rifle) this.rifle.rotation.x = aiming ? -0.3 : 0;
    }

    _applyHitFlash() {
        const flash = this.hitFlash > 0 ? this.hitFlash / 0.12 : 0;
        this.materials.forEach(m => {
            if (!m.emissive) return;
            m.emissive.setRGB(flash * 0.6, 0, 0);
        });
    }

    _updateDeath(dt) {
        this.deathTimer += dt;
        if (this.char) this.char.update(dt, { speed: 0, aiming: false, dead: true });
        if (this._flashSprite) this._flashSprite.material.opacity = 0;
        const f = this._fall || { dir: -1, roll: 0, ground: this.position.y, delay: 0.2 };
        // knees give first, then the body topples under gravity with a small bounce on impact
        const t = Math.max(0, this.deathTimer - f.delay);
        const fallT = 0.55;
        let k = Math.min(1, (t / fallT) * (t / fallT));
        if (t > fallT) k = 1 - Math.abs(Math.sin((t - fallT) * 9)) * Math.exp(-(t - fallT) * 7) * 0.06;
        if (!f.landed && t >= fallT) {
            f.landed = true;
            const fx = this._fx();
            if (fx) fx.bodyFall(this.position.clone().add(new THREE.Vector3(Math.sin(this._yaw), 0, Math.cos(this._yaw)).multiplyScalar(f.dir * 0.9)), this.deps.dusty ? 0x9a8462 : 0x6e604c);
            if (this.deps.audio && this.deps.audio.playImpact) this.deps.audio.playImpact(0.18, 'dirt');
        }
        const buckle = Math.min(1, this.deathTimer / Math.max(0.05, f.delay));
        this.group.rotation.set(f.dir * k * Math.PI * 0.47, this._yaw, f.roll * k, 'YXZ');
        // sink a little as the knees fold, rest on the ground (not world y=0), then slowly settle in after a while
        const sink = this.deathTimer > 12 ? Math.min(1, (this.deathTimer - 12) / 2.5) * 0.6 : 0;
        this.group.position.set(this.position.x, f.ground - buckle * 0.12 * (1 - k) - k * 0.08 - sink, this.position.z);
        this._updateDrop(dt);
        if (this.deathTimer > 14.5) this.group.visible = false;
    }

    _updateDrop(dt) {
        const d = this._drop;
        if (!d || d.rest) return;
        d.vel.y -= 9.8 * dt;
        d.o.position.addScaledVector(d.vel, dt);
        d.o.rotation.x += d.spin.x * dt; d.o.rotation.y += d.spin.y * dt; d.o.rotation.z += d.spin.z * dt;
        const gy = (this.deps.heightAt ? this.deps.heightAt(d.o.position.x, d.o.position.z) : 0) + 0.04;
        if (d.o.position.y <= gy) {
            d.o.position.y = gy;
            if (Math.abs(d.vel.y) < 1.2) { d.rest = true; d.o.rotation.set(0, d.o.rotation.y, Math.PI / 2); return; }
            d.vel.y *= -0.3; d.vel.x *= 0.5; d.vel.z *= 0.5; d.spin.multiplyScalar(0.4);
        }
    }

    dispose() {
        this.scene.remove(this.group);
        if (this._drop) this.scene.remove(this._drop.o);
        if (this._flashSprite) this.scene.remove(this._flashSprite);
        if (this.char) { this.char.dispose(); return; }
        this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        this.materials.forEach(m => m.dispose());
    }
}
