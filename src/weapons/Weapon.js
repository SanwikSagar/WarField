import { ATTACHMENTS } from './WeaponData.js';

/**
 * A single weapon instance: ammo, fire timing, reload state machine, recoil
 * pattern index, ADS state, and applied attachments. Pure logic — the
 * WeaponManager owns the viewmodel and effects.
 */
export class Weapon {
    constructor(data) {
        this.data = data;
        this.name = data.name;
        this.category = data.category;
        this.attachments = {};

        this.magSize = data.magSize;
        this.currentAmmo = data.magSize;
        this.reserveAmmo = data.reserve;

        this.fireRate = data.fireRate;
        this.damage = data.damage;
        this.pellets = data.pellets || 1;

        this.lastFireTime = -10;
        this.recoilIndex = 0;
        this.recoilResetTimer = 0;

        // Reload state machine: 'idle' | 'reloading' | 'chambering'
        this.state = 'idle';
        this.reloadTimer = 0;
        this.reloadDuration = 0;
        this.shellByShell = !!data.fullReloadTime;

        this.ads = 0;          // 0..1 aim-down-sights blend
        this.adsTarget = 0;
        this.sprintLower = 0;  // 0..1 lowered-while-sprinting blend
    }

    applyAttachment(id) {
        const att = ATTACHMENTS[id];
        if (!att) return;
        this.attachments[att.slot] = id;
        if (att.magBonus) {
            this.magSize = this.data.magSize + att.magBonus;
            this.currentAmmo += att.magBonus;
        }
    }
    hasAttachment(slot) { return !!this.attachments[slot]; }

    get effectiveDamage() { return this.damage; }
    get spreadHip() {
        return this.data.spreadHip * (this.hasAttachment('underbarrel') ? 0.92 : 1);
    }
    get spreadAds() {
        let s = this.data.spreadAds;
        if (this.hasAttachment('optic')) s *= ATTACHMENTS[this.attachments.optic].spreadAdsMult || 1;
        return s;
    }
    get currentSpread() {
        return this.spreadHip + (this.spreadAds - this.spreadHip) * this.ads;
    }
    get adsFov() {
        if (this.data.adsFovOverride) return this.data.adsFovOverride;
        let fov = this.data.adsFov;
        if (this.hasAttachment('optic')) fov += ATTACHMENTS[this.attachments.optic].adsFovBonus || 0;
        return fov;
    }
    get adsTime() {
        let t = this.data.adsTime;
        if (this.hasAttachment('underbarrel')) t *= ATTACHMENTS.foregrip.adsTimeMult;
        return t;
    }
    get recoilMultiplier() {
        let m = 1;
        if (this.hasAttachment('underbarrel')) m *= ATTACHMENTS.foregrip.recoilMult;
        if (this.hasAttachment('muzzle')) m *= ATTACHMENTS.suppressor.recoilMult;
        return m;
    }
    get soundGainMultiplier() {
        return this.hasAttachment('muzzle') ? ATTACHMENTS.suppressor.soundGain : 1;
    }

    get isReloading() { return this.state !== 'idle'; }
    get isAiming() { return this.ads > 0.6; }

    canFire(now) {
        return this.currentAmmo > 0 &&
               this.state === 'idle' &&
               (now - this.lastFireTime) >= this.fireRate;
    }

    /** Returns the recoil kick [pitch, yaw] for this shot and advances the pattern. */
    fire(now) {
        this.currentAmmo--;
        this.lastFireTime = now;
        const pattern = this.data.recoilPattern;
        const kick = pattern[this.recoilIndex % pattern.length];
        this.recoilIndex++;
        this.recoilResetTimer = 0.18;
        return [kick[0] * this.data.recoilKick * this.recoilMultiplier,
                kick[1] * this.data.recoilKick * this.recoilMultiplier];
    }

    /** Advance the recoil pattern back to start when the player stops firing. */
    decayRecoil(dt) {
        if (this.recoilResetTimer > 0) {
            this.recoilResetTimer -= dt;
        } else if (this.recoilIndex !== 0) {
            this.recoilIndex = 0;
        }
    }

    startReload() {
        if (this.state !== 'idle') return false;
        if (this.currentAmmo >= this.magSize || this.reserveAmmo <= 0) return false;
        this.state = 'reloading';
        this.reloadTimer = 0;
        this.reloadDuration = this.shellByShell
            ? Math.min(this.magSize - this.currentAmmo, this.reserveAmmo) * this.data.reloadTime
            : this.data.reloadTime;
        return true;
    }

    /**
     * Tick the reload state machine. Returns an event string the manager can
     * react to ('magOut', 'magIn', 'bolt', 'shell', 'done') or null.
     */
    updateReload(dt) {
        if (this.state === 'idle') return null;
        const prev = this.reloadTimer;
        this.reloadTimer += dt;
        let event = null;

        if (this.shellByShell) {
            const shellTime = this.data.reloadTime;
            const shellsBefore = Math.floor(prev / shellTime);
            const shellsAfter = Math.floor(this.reloadTimer / shellTime);
            if (shellsAfter > shellsBefore && this.currentAmmo < this.magSize && this.reserveAmmo > 0) {
                this.currentAmmo++;
                this.reserveAmmo--;
                event = 'shell';
            }
            if (this.reloadTimer >= this.reloadDuration) {
                this.state = 'idle';
                this.reloadTimer = 0;
                return 'done';
            }
            return event;
        }

        // Magazine reload: mag out at 30%, mag in at 70%, bolt at 95%
        const p = this.reloadTimer / this.reloadDuration;
        if (prev / this.reloadDuration < 0.3 && p >= 0.3) event = 'magOut';
        else if (prev / this.reloadDuration < 0.7 && p >= 0.7) event = 'magIn';
        else if (prev / this.reloadDuration < 0.95 && p >= 0.95) event = 'bolt';

        if (this.reloadTimer >= this.reloadDuration) {
            const needed = this.magSize - this.currentAmmo;
            const take = Math.min(needed, this.reserveAmmo);
            this.currentAmmo += take;
            this.reserveAmmo -= take;
            this.state = 'idle';
            this.reloadTimer = 0;
            return 'done';
        }
        return event;
    }

    cancelReload() {
        if (this.shellByShell && this.state === 'reloading') {
            // Keep shells already loaded, just stop
            this.state = 'idle';
            this.reloadTimer = 0;
        } else if (this.state === 'reloading') {
            this.state = 'idle';
            this.reloadTimer = 0;
        }
    }

    update(dt, now, wantsAds, sprinting) {
        this.decayRecoil(dt);
        // ADS blend toward target at the weapon's aim speed
        this.adsTarget = (wantsAds && !sprinting && this.state === 'idle') ? 1 : 0;
        const adsSpeed = 1 / Math.max(0.05, this.adsTime);
        const t = Math.min(1, adsSpeed * dt);
        this.ads += (this.adsTarget - this.ads) * t;
        // Sprint lower blend
        const lowerTarget = sprinting ? 1 : 0;
        this.sprintLower += (lowerTarget - this.sprintLower) * Math.min(1, dt * 10);
    }

    get reloadProgress() {
        return this.state === 'idle' ? 0 : Math.min(1, this.reloadTimer / this.reloadDuration);
    }
}
