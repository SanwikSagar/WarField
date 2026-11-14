import { globalEvents } from '../core/EventManager.js';
import { MISSIONS } from '../environments/biomes.js';
import { saveManager } from '../save/SaveManager.js';
import { SEASON, RECAPS, UPCOMING, formatRelease, latestEpisode, isNewEpisode, nextEpisode, countdownTo } from '../story/Story.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DIFFICULTIES = {
    recruit: 'Forgiving. Recommended for learning the campaign.',
    regular: 'Balanced challenge. The intended experience.',
    veteran: 'Enemies are sharper and hit harder.',
    realistic: 'Punishing. Every mistake counts.'
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Main menu + front-end navigation (GDD 10.2 / 10.4). Controls the cinematic
 * main menu, chapter selection, pre-mission briefing, and credits. Emits
 * high-level intents (startMission, openSettings, etc.) that Game acts on.
 * Mouse, keyboard (W/S/arrows, Enter, Esc) and gamepad (via UINav) all drive
 * the same code paths.
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
        this.menuItems = Array.from(document.querySelectorAll('#menu-nav .menu-item'));
        this.selectedMission = null;
        this.difficulty = saveManager.settings.difficulty || 'regular';
        this.returnTo = 'menu';        // where Back leaves Settings ('pause' when opened from the pause menu)
        this.briefingFrom = 'menu';    // where Back leaves the briefing

        this._bind();
        this._refreshContinue();
        this._renderFeature();
        setInterval(() => { if (this.currentScreen === 'menu') this._renderCountdown(); }, 30000);
        this.selectedIndex = this._firstEnabled();
        this.show('menu');
    }

    _sound(kind) { if (this.deps.audio) this.deps.audio.playUI(kind); }

    _bind() {
        this.menuItems.forEach((item, i) => {
            item.addEventListener('click', () => { if (!item.disabled) this._activate(item.dataset.action); });
            item.addEventListener('mouseenter', () => {
                if (item.disabled || this.selectedIndex === i) return;
                this.selectedIndex = i; this._highlight(); this._sound('hover');
            });
        });

        document.querySelectorAll('[data-back]').forEach(btn => {
            btn.addEventListener('click', () => { this.back(); this._sound('back'); });
        });

        document.querySelectorAll('#difficulty-options button').forEach(btn => {
            btn.addEventListener('click', () => { this._setDifficulty(btn.dataset.diff); this._sound('select'); });
        });
        this._setDifficulty(this.difficulty, true);

        document.getElementById('deploy-btn').addEventListener('click', () => this._deploySelected());
        document.getElementById('briefing-back').addEventListener('click', () => { this.back(); this._sound('back'); });
        document.getElementById('briefing-deploy').addEventListener('click', () => {
            if (this.selectedMission) this._startMission(this.selectedMission);
        });

        this._buildMissionList();
        document.getElementById('mf-play').addEventListener('click', () => this._playFeatured());
        document.getElementById('mf-play').addEventListener('mouseenter', () => this._sound('hover'));
        window.addEventListener('keydown', (e) => this._onKey(e));
    }

    // ── keyboard / gamepad ──────────────────────────────────────────────
    _onKey(e) {
        const screen = this.currentScreen;
        if (!screen || e.ctrlKey || e.altKey || e.metaKey) return;
        const c = e.code;
        const up = c === 'ArrowUp' || c === 'KeyW', down = c === 'ArrowDown' || c === 'KeyS';
        const left = c === 'ArrowLeft' || c === 'KeyA', right = c === 'ArrowRight' || c === 'KeyD';
        const ok = c === 'Enter' || c === 'NumpadEnter';
        const back = c === 'Escape';

        if (back && screen !== 'menu') {
            this.back(); this._sound('back');
            e.preventDefault(); e.stopImmediatePropagation();
            return;
        }

        if (screen === 'menu') {
            if (up) this._moveMenu(-1);
            else if (down) this._moveMenu(1);
            else if (ok || c === 'Space') {
                const item = this.menuItems[this.selectedIndex];
                if (item && !item.disabled) this._activate(item.dataset.action);
            } else return;
            e.preventDefault();
        } else if (screen === 'missions') {
            if (up) this._moveMission(-1);
            else if (down) this._moveMission(1);
            else if (left) this._shiftDifficulty(-1);
            else if (right) this._shiftDifficulty(1);
            else if (ok) this._deploySelected();
            else return;
            e.preventDefault();
        } else if (screen === 'briefing') {
            if (ok && this.selectedMission) this._startMission(this.selectedMission);
            else return;
            e.preventDefault();
        } else if (screen === 'credits' && ok) {
            this.back(); this._sound('back');
            e.preventDefault();
        }
    }

    back() {
        if (this.currentScreen === 'settings' && this.returnTo === 'pause') {
            this.returnTo = 'menu';
            this.hideAll();
            return;
        }
        this.returnTo = 'menu';
        if (this.currentScreen === 'briefing') this._enter(this.briefingFrom);
        else this.show('menu');
    }

    // ── main menu list ──────────────────────────────────────────────────
    _firstEnabled() {
        const i = this.menuItems.findIndex(it => !it.disabled);
        return i < 0 ? 0 : i;
    }

    _moveMenu(dir) {
        const n = this.menuItems.length;
        let i = this.selectedIndex;
        for (let step = 0; step < n; step++) {
            i = (i + dir + n) % n;
            if (!this.menuItems[i].disabled) break;
        }
        if (i !== this.selectedIndex) { this.selectedIndex = i; this._highlight(); this._sound('hover'); }
    }

    _highlight() {
        this.menuItems.forEach((it, i) => it.classList.toggle('selected', i === this.selectedIndex));
    }

    _refreshContinue() {
        const meta = document.getElementById('continue-meta');
        const cont = this.menuItems.find(i => i.dataset.action === 'continue');
        if (saveManager.hasSave) {
            const m = MISSIONS.find(x => x.id === saveManager.campaign.currentMission);
            meta.textContent = m ? `EPISODE ${m.code}  ·  ${m.title.toUpperCase()}` : '';
            cont.disabled = false;
        } else {
            meta.textContent = 'NO SAVE DATA';
            cont.disabled = true;
        }
        if (this.selectedIndex === undefined) return;
        if (this.menuItems[this.selectedIndex] && this.menuItems[this.selectedIndex].disabled) {
            this.selectedIndex = this._firstEnabled();
        }
    }

    // ── chapter select ──────────────────────────────────────────────────
    _buildMissionList() {
        const list = document.getElementById('mission-list');
        list.innerHTML = '';
        MISSIONS.forEach(m => {
            const unlocked = saveManager.isMissionUnlocked(m.id);
            const completed = saveManager.campaign.completedMissions.includes(m.id);
            const stats = saveManager.campaign.missionStats[m.id];
            const row = document.createElement('div');
            row.className = 'mission-row' + (unlocked ? '' : ' locked') + (completed ? ' completed' : '');
            row.dataset.id = m.id;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-disabled', String(!unlocked));
            const fresh = isNewEpisode(m);
            const state = !unlocked ? 'LOCKED' : completed ? 'COMPLETE' : fresh ? 'NEW' : 'AVAILABLE';
            const best = stats ? `${Math.floor(stats.time / 60)}:${String(stats.time % 60).padStart(2, '0')}  /  ${stats.accuracy}%` : '';
            row.dataset.biome = m.biome;
            if (fresh) row.classList.add('fresh');
            row.innerHTML = `
                <div class="mr-code"><span class="mr-art"></span>${m.code}</div>
                <div class="mr-info">
                    <h3>${esc(m.title)}${fresh ? '<span class="mr-new">NEW</span>' : ''}</h3>
                    <p>EPISODE ${m.code} &nbsp;/&nbsp; ${formatRelease(m.released)} &nbsp;/&nbsp; ${m.length.toUpperCase()}</p>
                </div>
                <div class="mr-right">
                    <div class="mr-status">${state}</div>
                    <div class="mr-region">${m.region.toUpperCase()}</div>
                    ${best ? `<div class="mr-best">${best}</div>` : ''}
                </div>`;
            if (unlocked) {
                row.addEventListener('click', () => { this._selectMission(m); this._sound('select'); });
                row.addEventListener('dblclick', () => this._deploySelected());
                row.addEventListener('mouseenter', () => this._sound('hover'));
            } else {
                row.title = `Complete episode ${String(m.id - 1).padStart(2, '0')} to unlock`;
            }
            list.appendChild(row);
        });
        UPCOMING.forEach(u => {
            const row = document.createElement('div');
            row.className = 'mission-row locked upcoming';
            row.setAttribute('aria-disabled', 'true');
            row.innerHTML = `
                <div class="mr-code"><span class="mr-art"></span>${u.code}</div>
                <div class="mr-info"><h3>${esc(u.title)}</h3><p>${esc(u.blurb)}</p></div>
                <div class="mr-right"><div class="mr-status">ARRIVES</div><div class="mr-region">${formatRelease(u.release)}</div></div>`;
            list.appendChild(row);
        });
        if (this.selectedMission) this._selectMission(this.selectedMission, true);
    }

    _selectMission(mission, quiet) {
        this.selectedMission = mission;
        document.querySelectorAll('.mission-row').forEach(r => {
            const on = Number(r.dataset.id) === mission.id;
            r.classList.toggle('selected', on);
            r.setAttribute('aria-selected', String(on));
            if (on && !quiet) r.scrollIntoView({ block: 'nearest' });
        });
    }

    _moveMission(dir) {
        const open = MISSIONS.filter(m => saveManager.isMissionUnlocked(m.id));
        if (!open.length) return;
        const i = open.findIndex(m => this.selectedMission && m.id === this.selectedMission.id);
        const next = open[clamp(i + dir, 0, open.length - 1)];
        if (next !== this.selectedMission) { this._selectMission(next); this._sound('hover'); }
    }

    _setDifficulty(diff, quiet) {
        if (!DIFFICULTIES[diff]) diff = 'regular';
        this.difficulty = diff;
        document.querySelectorAll('#difficulty-options button').forEach(b => {
            const on = b.dataset.diff === diff;
            b.classList.toggle('active', on);
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(on));
        });
        const desc = document.getElementById('difficulty-desc');
        if (desc) desc.textContent = DIFFICULTIES[diff];
        if (!quiet) saveManager.updateSetting('difficulty', diff);
    }

    _shiftDifficulty(dir) {
        const keys = Object.keys(DIFFICULTIES);
        const i = clamp(keys.indexOf(this.difficulty) + dir, 0, keys.length - 1);
        if (keys[i] !== this.difficulty) { this._setDifficulty(keys[i]); this._sound('hover'); }
    }

    // ── actions ─────────────────────────────────────────────────────────
    _activate(action) {
        this._sound('select');
        switch (action) {
            case 'continue':
                this.selectedMission = MISSIONS.find(m => m.id === saveManager.campaign.currentMission) || MISSIONS[0];
                this.briefingFrom = 'menu';
                this._showBriefing(this.selectedMission);
                break;
            case 'new':
                this.selectedMission = MISSIONS[0];
                this.briefingFrom = 'menu';
                this._showBriefing(MISSIONS[0]);
                break;
            case 'missions':
                this._enter('missions');
                break;
            case 'settings':
                this.returnTo = 'menu';
                this.show('settings');
                break;
            case 'credits':
                this.show('credits');
                break;
            case 'exit':
                if (this.deps.onExit) this.deps.onExit();
                break;
        }
    }

    /** Show a screen that needs preparation first (chapter list refresh + default selection). */
    _enter(screen) {
        if (screen === 'missions') {
            this._buildMissionList();
            const current = MISSIONS.find(m => m.id === saveManager.campaign.currentMission);
            const pick = (this.selectedMission && saveManager.isMissionUnlocked(this.selectedMission.id))
                ? this.selectedMission
                : (current && saveManager.isMissionUnlocked(current.id) ? current : MISSIONS[0]);
            this._selectMission(pick);
        }
        this.show(screen);
    }

    _deploySelected() {
        if (!this.selectedMission || !saveManager.isMissionUnlocked(this.selectedMission.id)) {
            this.selectedMission = MISSIONS.find(m => saveManager.isMissionUnlocked(m.id)) || MISSIONS[0];
        }
        this.briefingFrom = 'missions';
        this._showBriefing(this.selectedMission);
    }

    _showBriefing(mission) {
        document.getElementById('briefing-act').textContent = `SEASON ${SEASON.number}  ·  EPISODE ${mission.code}`;
        document.getElementById('briefing-code').textContent = `RELEASED ${formatRelease(mission.released)}`;
        const recap = RECAPS[mission.id];
        document.getElementById('briefing-recap').style.display = recap ? '' : 'none';
        document.getElementById('briefing-recap-text').textContent = recap || '';
        document.getElementById('briefing-title').textContent = mission.title;
        document.getElementById('briefing-region').textContent = `${mission.region.toUpperCase()}  /  ${mission.length.toUpperCase()}  /  ${this.difficulty.toUpperCase()}`;
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
            this._refreshContinue();
            this._highlight();
            globalEvents.emit('menu_show');
        } else if (screen === 'settings') {
            globalEvents.emit('open_settings');
        }
    }

    hideAll() {
        Object.values(this.screens).forEach(el => el && el.classList.add('hidden'));
        this.currentScreen = null;
    }

    // ── featured episode / countdown / season progress ─────────────────
    _renderFeature() {
        const ep = latestEpisode();
        const unlocked = saveManager.isMissionUnlocked(ep.id);
        const done = saveManager.campaign.completedMissions.includes(ep.id);
        document.getElementById('mf-art').dataset.biome = ep.biome;
        document.getElementById('mf-badge').textContent = isNewEpisode(ep) ? 'NEW EPISODE' : 'LATEST EPISODE';
        document.getElementById('mf-eyebrow').textContent = `EPISODE ${ep.code}  ·  ${ep.region.toUpperCase()}  ·  ${formatRelease(ep.released)}`;
        document.getElementById('mf-title').textContent = ep.title;
        document.getElementById('mf-text').textContent = ep.briefing;
        const cur = MISSIONS.find(m => m.id === saveManager.campaign.currentMission) || MISSIONS[0];
        document.getElementById('mf-play').innerHTML = (done ? 'REPLAY EPISODE' : unlocked ? 'PLAY EPISODE' : `CONTINUE STORY · EP ${cur.code}`) + ' <span>▸</span>';
        const total = MISSIONS.length;
        const n = saveManager.campaign.completedMissions.filter(id => MISSIONS.some(m => m.id === id)).length;
        document.getElementById('mfp-val').textContent = `${n} / ${total}`;
        document.getElementById('mfp-track').innerHTML = MISSIONS.map(m =>
            `<i class="${saveManager.campaign.completedMissions.includes(m.id) ? 'done' : ''}${m === ep ? ' latest' : ''}"></i>`).join('')
            + UPCOMING.map(() => '<i class="future"></i>').join('');
        const cm = document.getElementById('campaign-meta');
        if (cm) cm.textContent = `${total} EPISODES${isNewEpisode(ep) ? '  ·  NEW: ' + ep.title.toUpperCase() : ''}`;
        this._renderCountdown();
    }

    _renderCountdown() {
        const next = nextEpisode();
        const box = document.getElementById('mf-next');
        if (!next) { box.style.display = 'none'; return; }
        document.getElementById('mfn-title').textContent = `EP ${next.code} — ${next.title.toUpperCase()}`;
        const c = countdownTo(next.release);
        document.getElementById('mfn-count').innerHTML = c
            ? `<b>${c.days}</b>D <b>${String(c.hours).padStart(2, '0')}</b>H <b>${String(c.minutes).padStart(2, '0')}</b>M`
            : 'AVAILABLE NOW';
    }

    _playFeatured() {
        const ep = latestEpisode();
        this._sound('select');
        this.selectedMission = saveManager.isMissionUnlocked(ep.id)
            ? ep : (MISSIONS.find(m => m.id === saveManager.campaign.currentMission) || MISSIONS[0]);
        this.briefingFrom = 'menu';
        this._showBriefing(this.selectedMission);
    }

    /** Refresh dynamic bits when returning to the menu. */
    refresh() {
        this._renderFeature();
        this._refreshContinue();
        this._buildMissionList();
    }
}
