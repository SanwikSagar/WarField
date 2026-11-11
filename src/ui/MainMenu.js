import { globalEvents } from '../core/EventManager.js';
import { MISSIONS } from '../environments/biomes.js';
import { saveManager } from '../save/SaveManager.js';

/**
 * Main menu + front-end navigation (GDD 10.2 / 10.4). Controls the cinematic
 * main menu, mission selection, pre-mission briefing, and credits. Emits
 * high-level intents (startMission, openSettings, etc.) that Game acts on.
 * Supports both mouse and keyboard (W/S + Enter) navigation.
 */
export class MainMenu {
    constructor(deps = {}) {
        this.deps = deps; // { audio, onStartMission, onOpenSettings, onExit }
        this.screens = {
            menu: document.getElementById('main-menu'),
            missions: document.getElementById('mission-select'),
            settings: document.getElementById('settings-screen'),
            credits: document.getElementById('credits-screen'),
            briefing: document.getElementById('briefing-screen')
        };
        this.currentScreen = 'menu';
        this.selectedIndex = 0;
        this.menuItems = Array.from(document.querySelectorAll('#menu-nav .menu-item'));
        this.selectedMission = null;
        this.difficulty = saveManager.settings.difficulty || 'regular';
        this.keyboardNav = true;

        this._bind();
        this._refreshContinue();
        this.show('menu');
    }

    _bind() {
        // Main menu clicks
        this.menuItems.forEach((item, i) => {
            item.addEventListener('click', () => this._activate(item.dataset.action));
            item.addEventListener('mouseenter', () => { this.selectedIndex = i; this._highlight(); if (this.deps.audio) this.deps.audio.playUI('hover'); });
        });

        // Panel back buttons
        document.querySelectorAll('[data-back]').forEach(btn => {
            btn.addEventListener('click', () => { this.show('menu'); if (this.deps.audio) this.deps.audio.playUI('back'); });
        });

        // Difficulty
        document.querySelectorAll('#difficulty-options button').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#difficulty-options button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.difficulty = btn.dataset.diff;
                saveManager.updateSetting('difficulty', this.difficulty);
                if (this.deps.audio) this.deps.audio.playUI('select');
            });
        });

        // Deploy from mission select
        document.getElementById('deploy-btn').addEventListener('click', () => this._deploySelected());

        // Briefing buttons
        document.getElementById('briefing-back').addEventListener('click', () => { this.show('missions'); });
        document.getElementById('briefing-deploy').addEventListener('click', () => {
            if (this.selectedMission) this._startMission(this.selectedMission);
        });

        // Build mission list
        this._buildMissionList();

        // Keyboard navigation
        window.addEventListener('keydown', (e) => this._onKey(e));
    }

    _onKey(e) {
        if (this.currentScreen !== 'menu') {
            if (e.code === 'Escape') { this.show('menu'); }
            return;
        }
        if (e.code === 'ArrowDown' || e.code === 'KeyS') {
            this.selectedIndex = (this.selectedIndex + 1) % this.menuItems.length;
            this._highlight(); if (this.deps.audio) this.deps.audio.playUI('hover');
        } else if (e.code === 'ArrowUp' || e.code === 'KeyW') {
            this.selectedIndex = (this.selectedIndex - 1 + this.menuItems.length) % this.menuItems.length;
            this._highlight(); if (this.deps.audio) this.deps.audio.playUI('hover');
        } else if (e.code === 'Enter' || e.code === 'Space') {
            const item = this.menuItems[this.selectedIndex];
            if (item) this._activate(item.dataset.action);
        }
    }

    _highlight() {
        this.menuItems.forEach((it, i) => it.classList.toggle('selected', i === this.selectedIndex));
    }

    _refreshContinue() {
        const meta = document.getElementById('continue-meta');
        const cont = this.menuItems.find(i => i.dataset.action === 'continue');
        if (saveManager.hasSave) {
            const m = MISSIONS.find(x => x.id === saveManager.campaign.currentMission);
            meta.textContent = m ? `MISSION ${m.code} — ${m.region.toUpperCase()}` : '';
            cont.disabled = false;
        } else {
            meta.textContent = 'NO SAVE DATA';
            cont.disabled = true;
        }
    }

    _buildMissionList() {
        const list = document.getElementById('mission-list');
        list.innerHTML = '';
        MISSIONS.forEach(m => {
            const unlocked = saveManager.isMissionUnlocked(m.id);
            const completed = saveManager.campaign.completedMissions.includes(m.id);
            const stats = saveManager.campaign.missionStats[m.id];
            const row = document.createElement('div');
            row.className = 'mission-row' + (unlocked ? '' : ' locked') + (completed ? ' completed' : '');
            row.innerHTML = `
                <div class="mr-code">${m.code}</div>
                <div class="mr-info">
                    <h3>${m.title}</h3>
                    <p>${m.act} &nbsp;//&nbsp; ${m.length}</p>
                </div>
                <div class="mr-right">
                    <div class="mr-status">${!unlocked ? '🔒 LOCKED' : completed ? '✓ COMPLETE' : 'AVAILABLE'}</div>
                    <div class="mr-region">${m.region.toUpperCase()}</div>
                    ${stats ? `<div class="mr-status" style="margin-top:4px">${Math.round(stats.time/60)}:${String(stats.time%60).padStart(2,'0')} • ${stats.accuracy}%</div>` : ''}
                </div>`;
            if (unlocked) {
                row.addEventListener('click', () => {
                    document.querySelectorAll('.mission-row').forEach(r => r.classList.remove('selected'));
                    row.classList.add('selected');
                    this.selectedMission = m;
                    if (this.deps.audio) this.deps.audio.playUI('select');
                });
                row.addEventListener('mouseenter', () => { if (this.deps.audio) this.deps.audio.playUI('hover'); });
            }
            list.appendChild(row);
        });
    }

    _activate(action) {
        if (this.deps.audio) this.deps.audio.playUI('select');
        switch (action) {
            case 'continue':
                this.selectedMission = MISSIONS.find(m => m.id === saveManager.campaign.currentMission) || MISSIONS[0];
                this._showBriefing(this.selectedMission);
                break;
            case 'new':
                this.selectedMission = MISSIONS[0];
                this._showBriefing(MISSIONS[0]);
                break;
            case 'missions':
                this._buildMissionList();
                this.show('missions');
                break;
            case 'settings':
                this.show('settings');
                globalEvents.emit('open_settings');
                break;
            case 'credits':
                this.show('credits');
                break;
            case 'exit':
                if (this.deps.onExit) this.deps.onExit();
                break;
        }
    }

    _deploySelected() {
        if (!this.selectedMission) {
            // Default to first unlocked
            this.selectedMission = MISSIONS.find(m => saveManager.isMissionUnlocked(m.id)) || MISSIONS[0];
        }
        this._showBriefing(this.selectedMission);
    }

    _showBriefing(mission) {
        document.getElementById('briefing-act').textContent = mission.act;
        document.getElementById('briefing-code').textContent = `MISSION ${mission.code}`;
        document.getElementById('briefing-title').textContent = mission.title;
        document.getElementById('briefing-region').textContent = `${mission.region.toUpperCase()} // ${mission.length.toUpperCase()}`;
        document.getElementById('briefing-text').textContent = mission.briefing;
        const objEl = document.getElementById('briefing-objectives');
        objEl.innerHTML = '<div class="bo-title">PRIMARY OBJECTIVES</div><ul>' +
            (mission.objectives || ['Complete the operation', 'Extract safely']).map(o => `<li>${o}</li>`).join('') +
            '</ul>';
        this.show('briefing');
    }

    _startMission(mission) {
        globalEvents.emit('menu_hide');
        if (this.deps.onStartMission) {
            this.deps.onStartMission(mission.id, this.difficulty);
        }
    }

    show(screen) {
        this.currentScreen = screen;
        Object.entries(this.screens).forEach(([key, el]) => {
            if (el) el.classList.toggle('hidden', key !== screen);
        });
        if (screen === 'menu') {
            this._highlight();
            globalEvents.emit('menu_show');
        }
    }

    hideAll() {
        Object.values(this.screens).forEach(el => el && el.classList.add('hidden'));
        this.currentScreen = null;
    }

    /** Refresh dynamic bits when returning to the menu. */
    refresh() {
        this._refreshContinue();
        this._buildMissionList();
    }
}
