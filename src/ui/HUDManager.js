import { globalEvents } from '../core/EventManager.js';
import { saveManager } from '../save/SaveManager.js';

/**
 * Gameplay HUD (GDD 10.3). Subscribes to game events and updates the DOM:
 * ammo, health/armor, objectives, dynamic crosshair spread, hitmarkers,
 * subtitles, directional damage, squad status, compass, and reload progress.
 * Kept intentionally minimal on-screen — info appears when relevant.
 */
export class HUDManager {
    constructor() {
        this.el = {
            root: document.getElementById('hud'),
            ammoCurrent: document.getElementById('ammo-current'),
            ammoReserve: document.getElementById('ammo-reserve'),
            weaponName: document.getElementById('weapon-name'),
            weaponCategory: document.getElementById('weapon-category'),
            healthBar: document.getElementById('health-bar'),
            healthValue: document.getElementById('health-value'),
            armorBar: document.getElementById('armor-bar'),
            medkitCount: document.getElementById('medkit-count'),
            stance: document.getElementById('stance-indicator'),
            damageOverlay: document.getElementById('damage-overlay'),
            objText: document.getElementById('obj-text'),
            objList: document.getElementById('obj-list'),
            crosshair: document.getElementById('crosshair'),
            hitmarker: document.getElementById('hitmarker'),
            reloadIndicator: document.getElementById('reload-indicator'),
            reloadFill: document.getElementById('reload-fill'),
            subtitleBox: document.getElementById('subtitle-box'),
            subtitleSpeaker: document.getElementById('subtitle-speaker'),
            subtitleText: document.getElementById('subtitle-text'),
            interaction: document.getElementById('interaction-prompt'),
            interactionText: document.getElementById('interaction-text'),
            squadStatus: document.getElementById('squad-status'),
            damageDirection: document.getElementById('damage-direction'),
            compassStrip: document.getElementById('compass-strip'),
            intelCount: document.getElementById('intel-count')
        };
        this.subtitleTimer = 0;
        this.damageDirs = [];
        this._buildCompass();
        this._bind();
    }

    _bind() {
        globalEvents.on('weapon_update', (d) => this._onWeapon(d));
        globalEvents.on('player_damage', (d) => this._onDamage(d));
        globalEvents.on('player_heal', (d) => this._setHealth(d.current, d.max));
        globalEvents.on('player_health_regen', (d) => this._setHealth(d.current, d.max));
        globalEvents.on('armor_update', (d) => this._setArmor(d.current, d.max));
        globalEvents.on('medkit_used', (d) => { this.el.medkitCount.textContent = d.remaining; });
        globalEvents.on('player_death', () => this._onDeath());
        globalEvents.on('objective_update', (d) => this._onObjective(d));
        globalEvents.on('objective_complete', () => this._flashObjective());
        globalEvents.on('hitmarker', (d) => this._onHitmarker(d));
        globalEvents.on('reload_progress', (d) => this._onReload(d));
        globalEvents.on('reload_end', () => { this.el.reloadIndicator.classList.remove('active'); });
        globalEvents.on('dialogue', (d) => this._onDialogue(d));
        globalEvents.on('interaction_update', (d) => this._onInteraction(d));
        globalEvents.on('player_hit_direction', (d) => this._onDamageDirection(d));
        globalEvents.on('squad_update', (d) => this._onSquad(d));
        globalEvents.on('intel_collected', (d) => { this.el.intelCount.textContent = d.count; });
        globalEvents.on('spread_update', (d) => this._onSpread(d));
        globalEvents.on('stance_update', (d) => { this.el.stance.textContent = d.stance; });
    }

    show() { this.el.root.classList.remove('hidden'); }
    hide() { this.el.root.classList.add('hidden'); }

    _onWeapon(d) {
        this.el.weaponName.textContent = d.name;
        this.el.weaponCategory.textContent = d.category;
        this.el.ammoCurrent.textContent = d.current;
        this.el.ammoReserve.textContent = d.reserve;
        this.el.ammoCurrent.classList.toggle('low', d.current <= Math.ceil(d.magSize * 0.2));
        if (d.reloading) {
            this.el.reloadIndicator.classList.add('active');
            this.el.reloadFill.style.width = (d.reloadProgress * 100) + '%';
        }
    }

    _onReload(d) {
        this.el.reloadIndicator.classList.add('active');
        this.el.reloadFill.style.width = (d.progress * 100) + '%';
    }

    _setHealth(current, max) {
        const pct = (current / max) * 100;
        this.el.healthBar.style.width = pct + '%';
        this.el.healthValue.textContent = Math.ceil(current);
        this.el.healthBar.classList.toggle('low', pct < 35);
    }

    _setArmor(current, max) {
        this.el.armorBar.style.width = ((current / max) * 100) + '%';
    }

    _onDamage(d) {
        this._setHealth(d.current, d.max);
        this._setArmor(d.armor, 50);
        // Red flash overlay
        this.el.damageOverlay.classList.add('flash');
        setTimeout(() => this.el.damageOverlay.classList.remove('flash'), 90);
    }

    _onDeath() {
        this.el.objText.textContent = 'MISSION FAILED';
        this.el.objText.style.color = 'var(--danger)';
    }

    _onObjective(d) {
        this.el.objText.textContent = d.current;
        this.el.objText.style.color = '';
        this.el.objList.innerHTML = d.list.map(o =>
            `<div class="ol-item ${o.completed ? 'done' : ''}">${o.text}</div>`).join('');
    }

    _flashObjective() {
        this.el.objText.style.color = 'var(--health)';
        setTimeout(() => { this.el.objText.style.color = ''; }, 600);
    }

    _onHitmarker(d) {
        const hm = this.el.hitmarker;
        hm.classList.toggle('kill', !!d.kill);
        hm.classList.remove('show');
        void hm.offsetWidth; // reflow to restart animation
        hm.classList.add('show');
    }

    _onSpread(d) {
        this.el.crosshair.style.setProperty('--spread', d.spread + 'px');
        this.el.crosshair.classList.toggle('hidden-ch', d.hidden);
    }

    _onDialogue(d) {
        if (!saveManager.settings.subtitles) return;
        this.el.subtitleSpeaker.textContent = d.speaker;
        this.el.subtitleText.textContent = d.text;
        this.el.subtitleBox.classList.remove('hidden');
        const size = saveManager.settings.subtitleSize;
        this.el.subtitleBox.className = size !== 'medium' ? `size-${size}` : '';
        this.el.subtitleBox.classList.remove('hidden');
        this.subtitleTimer = Math.max(3.5, d.text.length * 0.07);
    }

    _onInteraction(d) {
        if (d.target) {
            this.el.interactionText.textContent = d.target;
            this.el.interaction.classList.remove('hidden');
        } else {
            this.el.interaction.classList.add('hidden');
        }
    }

    _onDamageDirection(d) {
        const angle = Math.atan2(d.dir.x, d.dir.z);
        const ind = document.createElement('div');
        ind.className = 'dd-indicator';
        ind.style.transform = `translate(-50%,-50%) rotate(${angle}rad) translateY(-70px)`;
        this.el.damageDirection.appendChild(ind);
        setTimeout(() => ind.remove(), 1000);
    }

    _onSquad(d) {
        this.el.squadStatus.innerHTML = d.members.map(m =>
            `<div class="squad-member ${m.alive ? '' : 'down'}"><span class="sm-dot"></span>${m.name}</div>`).join('');
    }

    _buildCompass() {
        const dirs = ['N', '15', '30', 'NE', '60', '75', 'E', '105', '120', 'SE', '150', '165', 'S', '195', '210', 'SW', '240', '255', 'W', '285', '300', 'NW', '330', '345'];
        // Duplicate for wrap-around
        const all = [...dirs, ...dirs];
        this.el.compassStrip.innerHTML = all.map(d =>
            `<span class="cp ${['N','E','S','W','NE','SE','SW','NW'].includes(d) ? 'cardinal' : ''}">${d}</span>`).join('');
        this.compassDirs = dirs;
    }

    updateCompass(yawRadians) {
        // Map yaw to 0-360 heading and scroll the strip
        let deg = (-yawRadians * 180 / Math.PI) % 360;
        if (deg < 0) deg += 360;
        const per = 42; // approx px per direction tick
        const offset = (deg / 360) * this.compassDirs.length * per;
        this.el.compassStrip.style.transform = `translateX(${110 - offset}px)`;
    }

    update(dt) {
        if (this.subtitleTimer > 0) {
            this.subtitleTimer -= dt;
            if (this.subtitleTimer <= 0) this.el.subtitleBox.classList.add('hidden');
        }
    }

    setIntel(count) { this.el.intelCount.textContent = count; }
}
