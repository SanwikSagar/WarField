import { globalEvents } from '../core/EventManager.js';
import { saveManager, DEFAULT_SETTINGS } from '../save/SaveManager.js';

const TAB_KEYS = {
    graphics: ['quality', 'fov', 'filmGrain', 'screenShake', 'motionBlur'],
    audio: ['masterVolume', 'musicVolume', 'sfxVolume', 'ambienceVolume'],
    controls: ['sensitivity', 'invertY'],
    accessibility: ['subtitles', 'subtitleSize', 'showDamageNumbers']
};

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
            rows.push(`<div class="bindings" aria-label="Key bindings">${BINDINGS.map(([a, k]) =>
                `<div class="binding"><span>${a}</span><kbd class="keycap">${k}</kbd></div>`).join('')}</div>`);
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
