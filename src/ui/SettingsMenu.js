import { globalEvents } from '../core/EventManager.js';
import { saveManager, DEFAULT_SETTINGS, SaveManager } from '../save/SaveManager.js';
import { cloud } from '../save/CloudSave.js';

const TAB_KEYS = {
    graphics: ['quality', 'fpsCap', 'fullscreen', 'fov', 'filmGrain', 'screenShake', 'motionBlur'],
    audio: ['masterVolume', 'musicVolume', 'sfxVolume', 'ambienceVolume'],
    controls: ['sensitivity', 'invertY', 'aimAssist', 'touchLook'],
    accessibility: ['subtitles', 'subtitleSize', 'showDamageNumbers'],
    profile: []
};

/** "just now", "3 min ago", "2 h ago" */
function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 15) return 'just now';
    if (s < 90) return Math.round(s) + ' s ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
}
const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BINDINGS = [
    ['Move', 'W A S D'], ['Sprint', 'Shift'], ['Crouch', 'Ctrl / C'], ['Jump', 'Space'],
    ['Fire', 'Left Mouse'], ['Aim', 'Right Mouse'], ['Reload', 'R'], ['Interact', 'E'],
    ['Weapons', '1 2 3 / Wheel'], ['Fire Mode', 'B'], ['Melee', 'V'], ['Inspect', 'F'],
    ['Free Camera', 'H'], ['Pause', 'Esc']
];

const pct = v => Math.round(v * 100) + '%';
const FORMATS = {
    fov: v => Math.round(v) + '°',
    screenShake: pct, masterVolume: pct, musicVolume: pct, sfxVolume: pct, ambienceVolume: pct,
    sensitivity: v => Number(v).toFixed(2)
};

/**
 * Settings menu (GDD 10.5 / 12.5 / 14). Builds graphics, audio, controls, and
 * accessibility options from the saved settings, applies changes live via
 * events, and persists to LocalStorage. Fully usable with mouse, keyboard
 * (Q/E tabs, arrows to move/adjust, Enter to toggle) and gamepad (via UINav).
 */
export class SettingsMenu {
    constructor(deps = {}) {
        this.deps = deps; // { audio }
        this.screen = document.getElementById('settings-screen');
        this.body = document.getElementById('settings-body');
        this.tabs = Array.from(document.querySelectorAll('#settings-tabs .stab'));
        this.activeTab = 'graphics';
        this._bind();
        this.render('graphics');

        globalEvents.on('open_settings', () => { this.render(this.activeTab); this._focusFirst(); });
        // the profile tab shows live sync status
        cloud.on(() => { if (this.activeTab === 'profile' && this.screen && !this.screen.classList.contains('hidden')) this.render('profile'); });
        globalEvents.on('save_applied', () => { if (this.activeTab === 'profile') this.render('profile'); });
        this._pfMsg = '';
    }

    _sound(kind) { if (this.deps.audio) this.deps.audio.playUI(kind); }

    _bind() {
        this.tabs.forEach(tab => {
            tab.setAttribute('role', 'tab');
            tab.addEventListener('click', () => { this._setTab(tab.dataset.tab); this._sound('select'); });
        });
        const reset = document.getElementById('settings-reset');
        if (reset) reset.addEventListener('click', () => this._resetTab());
        window.addEventListener('keydown', (e) => this._onKey(e));
    }

    _setTab(name) {
        this.activeTab = name;
        this.tabs.forEach(t => {
            const on = t.dataset.tab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', String(on));
        });
        this.render(name);
    }

    _isOpen() { return !this.screen.classList.contains('hidden'); }

    // ── keyboard / gamepad ──────────────────────────────────────────────
    _controls() {
        return Array.from(this.body.querySelectorAll('input[type="range"], .toggle, .seg-control'));
    }

    _focusFirst() {
        const first = this._controls()[0];
        if (first && this._isOpen()) first.focus({ preventScroll: true });
    }

    _onKey(e) {
        if (!this._isOpen() || e.ctrlKey || e.altKey || e.metaKey) return;
        const c = e.code;
        if (c === 'KeyQ' || c === 'KeyE') {
            const names = this.tabs.map(t => t.dataset.tab);
            const i = (names.indexOf(this.activeTab) + (c === 'KeyE' ? 1 : -1) + names.length) % names.length;
            this._setTab(names[i]); this._sound('hover');
            this._focusFirst();
            e.preventDefault();
            return;
        }
        if (c === 'KeyR' && !e.shiftKey) { this._resetTab(); e.preventDefault(); return; }

        const list = this._controls();
        const idx = list.indexOf(document.activeElement);
        if (c === 'ArrowDown' || c === 'ArrowUp' || c === 'KeyS' || c === 'KeyW') {
            const dir = (c === 'ArrowDown' || c === 'KeyS') ? 1 : -1;
            const next = idx < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, idx + dir));
            if (list[next]) {
                list[next].focus({ preventScroll: true });
                list[next].scrollIntoView({ block: 'nearest' });
                if (next !== idx) this._sound('hover');
            }
            e.preventDefault();
            return;
        }
        const el = list[idx];
        if (!el) return;
        const dx = (c === 'ArrowRight' || c === 'KeyD') ? 1 : (c === 'ArrowLeft' || c === 'KeyA') ? -1 : 0;
        if (dx) { this._adjust(el, dx, e.shiftKey); e.preventDefault(); }
        else if ((c === 'Enter' || c === 'NumpadEnter') && el.classList.contains('toggle')) { el.click(); e.preventDefault(); }
    }

    _adjust(el, dx, big) {
        if (el.matches('input[type="range"]')) {
            const step = parseFloat(el.step) || 1, min = parseFloat(el.min), max = parseFloat(el.max);
            const next = Math.max(min, Math.min(max, parseFloat(el.value) + dx * step * (big ? 5 : 1)));
            el.value = String(Math.round(next / step) * step);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.classList.contains('toggle')) {
            el.click();
        } else if (el.classList.contains('seg-control')) {
            const btns = Array.from(el.querySelectorAll('button'));
            const i = btns.findIndex(b => b.classList.contains('active'));
            const next = btns[Math.max(0, Math.min(btns.length - 1, i + dx))];
            if (next && next !== btns[i]) next.click();
        }
    }

    _resetTab() {
        const s = saveManager.settings;
        for (const key of TAB_KEYS[this.activeTab] || []) {
            s[key] = DEFAULT_SETTINGS[key];
            globalEvents.emit('setting_changed', { key, value: s[key] });
            this._apply(key, s[key]);
        }
        saveManager.saveSettings();
        this.render(this.activeTab);
        this._sound('select');
    }

    // ── rendering ───────────────────────────────────────────────────────
    render(tab) {
        const s = saveManager.settings;
        const rows = [];
        if (tab === 'graphics') {
            rows.push(this._seg('Graphics Quality', 'quality', ['low', 'medium', 'high', 'ultra', 'extreme'], s.quality, 'Shadows, tree and grass detail, resolution, bloom and anti-aliasing'));
            rows.push(this._seg('Frame Rate Limit', 'fpsCap', ['30', '60', 'unlimited'], String(s.fpsCap || '60'), 'Steady frame pacing: 30 for weaker GPUs, 60 for smooth play. Gameplay runs at the same speed either way'));
            rows.push(this._toggle('Fullscreen on Deploy', 'fullscreen', s.fullscreen ?? !!(window.matchMedia && matchMedia('(pointer: coarse)').matches), 'Go fullscreen when a mission starts (toggle any time from the pause menu)'));
            rows.push(this._slider('Field of View', 'fov', 60, 110, 1, s.fov, 'Wider sees more of the sides; narrower feels more focused'));
            rows.push(this._toggle('Film Grain', 'filmGrain', s.filmGrain > 0.001, 'Subtle cinematic noise'));
            rows.push(this._slider('Screen Shake', 'screenShake', 0, 1.5, 0.05, s.screenShake, 'Camera shake from explosions and hits'));
            rows.push(this._toggle('Motion Blur', 'motionBlur', s.motionBlur, 'Weapon and camera blur (experimental)'));
        } else if (tab === 'audio') {
            rows.push(this._slider('Master Volume', 'masterVolume', 0, 1, 0.05, s.masterVolume, ''));
            rows.push(this._slider('Music Volume', 'musicVolume', 0, 1, 0.05, s.musicVolume, ''));
            rows.push(this._slider('Effects Volume', 'sfxVolume', 0, 1, 0.05, s.sfxVolume, 'Weapons, footsteps and impacts'));
            rows.push(this._slider('Ambience Volume', 'ambienceVolume', 0, 1, 0.05, s.ambienceVolume, 'Rain, wind and environment'));
        } else if (tab === 'controls') {
            rows.push(this._slider('Mouse Sensitivity', 'sensitivity', 0.2, 3, 0.05, s.sensitivity, ''));
            rows.push(this._toggle('Invert Y-Axis', 'invertY', s.invertY, 'Invert vertical look'));
            rows.push(this._toggle('Aim Assist', 'aimAssist', s.aimAssist !== false, 'Aim slows over enemies and aiming down sights settles on the nearest target'));
            rows.push(this._slider('Touch Look Speed', 'touchLook', 0.3, 2.5, 0.05, s.touchLook ?? 1, 'Phones and tablets'));
            rows.push(`<div class="bindings" aria-label="Key bindings">${BINDINGS.map(([a, k]) =>
                `<div class="binding"><span>${a}</span><kbd class="keycap">${k}</kbd></div>`).join('')}</div>`);
        } else if (tab === 'profile') {
            rows.push(this._profileHtml());
        } else if (tab === 'accessibility') {
            rows.push(this._toggle('Subtitles', 'subtitles', s.subtitles, 'Show dialogue subtitles'));
            rows.push(this._seg('Subtitle Size', 'subtitleSize', ['small', 'medium', 'large'], s.subtitleSize, ''));
            rows.push(this._toggle('Damage Indicators', 'showDamageNumbers', s.showDamageNumbers, 'Directional damage markers'));
        }
        this.body.innerHTML = rows.join('');
        this.body.setAttribute('role', 'tabpanel');
        const reset = document.getElementById('settings-reset');
        if (reset) reset.hidden = !(TAB_KEYS[tab] && TAB_KEYS[tab].length);
        this._wireControls();
    }

    // ── profile: player ID, account, cloud save status, JSON backup ──
    _profileHtml() {
        const p = saveManager.player, pr = saveManager.progress, on = cloud.configured;
        const label = { off: 'Saved on this device', idle: 'Ready', connecting: 'Connecting…', syncing: 'Syncing…', offline: 'Offline, will sync when back online' }[cloud.status];
        const state = cloud.status === 'synced' ? `Synced ${ago(cloud.lastSync)}` : cloud.status === 'error' ? (cloud.error || 'Sync problem') : label;
        const btn = (act, text, cls = '') => `<button type="button" class="pf-btn ${cls}" data-act="${act}">${text}</button>`;
        const cloudBtns = on ? [
            cloud.signedIn ? btn('signout', 'Sign out') : btn('google', 'Sign in with Google', 'primary'),
            btn('sync', 'Sync now'), btn('deletecloud', 'Delete cloud save', 'danger')
        ].join('') : '';
        return `<div class="pf-card">
            <div class="pf-id"><div><div class="pf-k">PLAYER ID</div><div class="pf-v" id="pf-id">${esc(p.id)}</div></div>${btn('copy', 'Copy')}</div>
            <div class="pf-grid">
                <div><div class="pf-k">ACCOUNT</div><div class="pf-s">${esc(cloud.accountLabel)}</div></div>
                <div><div class="pf-k">PROGRESS</div><div class="pf-s">${pr.done} / ${pr.total} episodes · ${pr.intel} intel</div></div>
                <div><div class="pf-k">CLOUD SAVE</div><div class="pf-s"><span class="pf-pill ${cloud.status}"></span>${esc(state)}</div></div>
            </div>
            ${on ? '' : '<p class="pf-note">Cloud save is not set up in this build, so progress stays on this device. Export a backup below, or see FIREBASE_SETUP.md to turn on cloud sync.</p>'}
            ${on && !cloud.signedIn ? '<p class="pf-note">You are playing as a guest: your save is tied to this browser. Sign in with Google to keep it across devices.</p>' : ''}
            <div class="pf-row">${cloudBtns}</div>
            <div class="pf-row">${btn('export', 'Export save (.json)')}${btn('import', 'Import save…')}<input type="file" id="pf-file" accept=".json,application/json" hidden></div>
            <p class="pf-msg" id="pf-msg" role="status">${esc(this._pfMsg)}</p>
        </div>`;
    }

    async _profileAction(act) {
        const say = (t) => { this._pfMsg = t; const m = document.getElementById('pf-msg'); if (m) m.textContent = t; };
        try {
            if (act === 'copy') {
                await navigator.clipboard.writeText(saveManager.player.id);
                say('Player ID copied.');
            } else if (act === 'google') {
                say('Opening Google sign-in…'); await cloud.signInWithGoogle(); say('Signed in. Your progress is now tied to your Google account.');
            } else if (act === 'signout') {
                await cloud.signOut(); say('Signed out. You are a guest again on this browser.');
            } else if (act === 'sync') {
                await cloud.sync(); say(cloud.status === 'synced' ? 'Up to date.' : cloud.error);
            } else if (act === 'deletecloud') {
                if (!confirm('Delete your cloud save? Progress on this device is kept.')) return;
                await cloud.deleteCloudSave(); say('Cloud save deleted.');
            } else if (act === 'export') {
                const blob = new Blob([JSON.stringify(saveManager.snapshot(), null, 2)], { type: 'application/json' });
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
                a.download = `warfield-save-${saveManager.player.id}.json`; document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 2000); say('Save exported.');
            } else if (act === 'import') {
                document.getElementById('pf-file').click();
            }
        } catch (e) {
            const m = cloud.friendly(e); if (m) say(m);
        }
    }

    async _importFile(file) {
        if (!file) return;
        const say = (t) => { this._pfMsg = t; const m = document.getElementById('pf-msg'); if (m) m.textContent = t; };
        if (file.size > 512 * 1024) { say('That file is too large to be a Warfield save.'); return; }
        const snap = SaveManager.parseSnapshot(await file.text());
        if (!snap) { say('That file is not a Warfield save.'); return; }
        const res = saveManager.applySnapshot(snap);
        for (const key of res.changedSettings) globalEvents.emit('setting_changed', { key, value: saveManager.settings[key] });
        globalEvents.emit('save_applied', res);
        saveManager.saveCampaign();           // persists the merge and queues a cloud sync
        say(res.campaignChanged ? `Imported. Progress merged: ${saveManager.progress.done} / ${saveManager.progress.total} episodes.` : 'Imported. Nothing new in that file.');
        this.render('profile');
    }

    _row(label, hint, controlHtml, id) {
        return `<div class="setting-row"><div><label ${id ? `for="${id}"` : ''}>${label}</label>${hint ? `<div class="sr-hint">${hint}</div>` : ''}</div><div class="setting-control">${controlHtml}</div></div>`;
    }
    _slider(label, key, min, max, step, value, hint) {
        const fill = ((value - min) / (max - min)) * 100;
        return this._row(label, hint,
            `<input type="range" id="set-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--fill:${fill}%"><span class="value-display" data-for="${key}">${FORMATS[key](value)}</span>`, `set-${key}`);
    }
    _toggle(label, key, value, hint) {
        return this._row(label, hint, `<button type="button" class="toggle ${value ? 'on' : ''}" role="switch" aria-checked="${!!value}" aria-label="${label}" data-toggle="${key}"></button>`);
    }
    _seg(label, key, options, value, hint) {
        const btns = options.map(o => `<button type="button" tabindex="-1" data-seg="${key}" data-val="${o}" class="${o === value ? 'active' : ''}" aria-pressed="${o === value}">${o}</button>`).join('');
        return this._row(label, hint, `<div class="seg-control" role="radiogroup" tabindex="0" aria-label="${label}">${btns}</div>`);
    }

    _wireControls() {
        const s = saveManager.settings;

        this.body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { this._sound('select'); this._profileAction(b.dataset.act); }));
        const file = this.body.querySelector('#pf-file');
        if (file) file.addEventListener('change', () => { this._importFile(file.files[0]); file.value = ''; });

        this.body.querySelectorAll('input[type="range"]').forEach(input => {
            input.addEventListener('input', () => {
                const key = input.dataset.key;
                const val = parseFloat(input.value);
                s[key] = val;
                const fill = ((val - parseFloat(input.min)) / (parseFloat(input.max) - parseFloat(input.min))) * 100;
                input.style.setProperty('--fill', fill + '%');
                const disp = this.body.querySelector(`[data-for="${key}"]`);
                if (disp && FORMATS[key]) disp.textContent = FORMATS[key](val);
                globalEvents.emit('setting_changed', { key, value: val });
                this._apply(key, val);
            });
            input.addEventListener('change', () => {
                saveManager.saveSettings();
                if (input.dataset.key.endsWith('Volume')) this._sound('select');   // audible preview at the new level
            });
        });

        this.body.querySelectorAll('[data-toggle]').forEach(t => {
            t.addEventListener('click', () => {
                const key = t.dataset.toggle;
                s[key] = !s[key];
                t.classList.toggle('on', !!s[key]);
                t.setAttribute('aria-checked', String(!!s[key]));
                saveManager.saveSettings();
                globalEvents.emit('setting_changed', { key, value: s[key] });
                this._apply(key, s[key]);
                this._sound('select');
            });
        });

        this.body.querySelectorAll('[data-seg]').forEach(b => {
            b.addEventListener('click', () => {
                const key = b.dataset.seg;
                this.body.querySelectorAll(`[data-seg="${key}"]`).forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
                b.classList.add('active');
                b.setAttribute('aria-pressed', 'true');
                s[key] = b.dataset.val;
                saveManager.saveSettings();
                globalEvents.emit('setting_changed', { key, value: b.dataset.val });
                this._apply(key, b.dataset.val);
                this._sound('select');
            });
        });
    }

    /** Push a setting change into the live game systems. */
    _apply(key, value) {
        if (this.deps.audio && key.endsWith('Volume')) {
            const bus = key.replace('Volume', '');
            this.deps.audio.setVolume(bus, value);
        }
        // Other keys are consumed by Game via the 'setting_changed' event.
    }
}
