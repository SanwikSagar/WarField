import { globalEvents } from '../core/EventManager.js';

/**
 * Player health + armor with delayed regeneration (GDD 5.4). Damage emits
 * events the HUD and renderer react to (red pulse, vignette). Medkits are a
 * limited consumable resource; regen only restores health, not armor.
 */
export class PlayerHealth {
    constructor(difficulty = 'regular') {
        this.maxHealth = 100;
        this.currentHealth = 100;
        this.maxArmor = 50;
        this.currentArmor = 0;
        this.isAlive = true;
        this.medkits = 3;

        this.regenDelay = 5.0;     // seconds after last damage before regen
        this.regenRate = 18;       // hp/sec
        this.timeSinceDamage = 999;
        this.lastDamageDir = null;

        this.setDifficulty(difficulty);
    }

    setDifficulty(diff) {
        const table = {
            recruit:   { regenDelay: 3.5, regenRate: 30, medkits: 5, enemyDamageMult: 0.6 },
            regular:   { regenDelay: 5.0, regenRate: 18, medkits: 3, enemyDamageMult: 1.0 },
            veteran:   { regenDelay: 7.0, regenRate: 10, medkits: 2, enemyDamageMult: 1.5 },
            realistic: { regenDelay: 999, regenRate: 0,  medkits: 1, enemyDamageMult: 2.2 }
        };
        const t = table[diff] || table.regular;
        this.regenDelay = t.regenDelay;
        this.regenRate = t.regenRate;
        this.medkits = t.medkits;
        this.enemyDamageMult = t.enemyDamageMult;
    }

    takeDamage(amount, direction = null) {
        if (!this.isAlive) return;
        amount *= this.enemyDamageMult || 1;
        this.timeSinceDamage = 0;
        this.lastDamageDir = direction;

        // Armor absorbs first
        if (this.currentArmor > 0) {
            const absorbed = Math.min(this.currentArmor, amount * 0.6);
            this.currentArmor -= absorbed;
            amount -= absorbed;
        }
        this.currentHealth = Math.max(0, this.currentHealth - amount);

        globalEvents.emit('player_damage', {
            current: this.currentHealth,
            max: this.maxHealth,
            armor: this.currentArmor,
            amount,
            direction
        });

        if (this.currentHealth <= 0) this.die();
    }

    heal(amount) {
        if (!this.isAlive) return;
        this.currentHealth = Math.min(this.maxHealth, this.currentHealth + amount);
        globalEvents.emit('player_heal', { current: this.currentHealth, max: this.maxHealth });
    }

    useMedkit() {
        if (!this.isAlive || this.medkits <= 0 || this.currentHealth >= this.maxHealth) return false;
        this.medkits--;
        this.heal(55);
        globalEvents.emit('medkit_used', { remaining: this.medkits });
        return true;
    }

    addArmor(amount) {
        this.currentArmor = Math.min(this.maxArmor, this.currentArmor + amount);
        globalEvents.emit('armor_update', { current: this.currentArmor, max: this.maxArmor });
    }

    die() {
        if (!this.isAlive) return;
        this.isAlive = false;
        globalEvents.emit('player_death');
    }

    respawn() {
        this.isAlive = true;
        this.currentHealth = this.maxHealth;
        this.currentArmor = 0;
        this.timeSinceDamage = 999;
        globalEvents.emit('player_respawn', { current: this.currentHealth, max: this.maxHealth });
    }

    update(dt) {
        if (!this.isAlive) return;
        this.timeSinceDamage += dt;
        if (this.regenRate > 0 && this.timeSinceDamage > this.regenDelay && this.currentHealth < this.maxHealth) {
            const before = this.currentHealth;
            this.currentHealth = Math.min(this.maxHealth, this.currentHealth + this.regenRate * dt);
            if (Math.floor(this.currentHealth) !== Math.floor(before)) {
                globalEvents.emit('player_health_regen', { current: this.currentHealth, max: this.maxHealth });
            }
        }
    }

    get healthPct() { return this.currentHealth / this.maxHealth; }
    get isLow() { return this.healthPct < 0.35; }
}
