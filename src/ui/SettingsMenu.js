import { globalEvents } from '../core/EventManager.js';
import { saveManager } from '../save/SaveManager.js';

/**
 * Settings menu (GDD 10.5 / 12.5 / 14). Builds graphics, audio, controls, and
 * accessibility options dynamically from the saved settings, applies changes
 * live via events, and persists to LocalStorage.
 */
export class SettingsMenu {
    constructor(deps = {}) {
        this.deps = deps; // { audio }
        this.body = document.getElementById('settings-body');
        this.tabs = Array.from(document.querySelectorAll('#settings-tabs .stab'));
        this.activeTab = 'graphics';
        this._bind();
        this.render('graphics');

        globalEvents.on('open_settings', () => this.render(this.activeTab));
    }

    _bind() {
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this.tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.activeTab = tab.dataset.tab;
                this.render(this.activeTab);
                if (this.deps.audio) this.deps.audio.playUI('select');
            });
        });
    }

    render(tab) {
        const s = saveManager.settings;
        const rows = [];
        if (tab === 'graphics') {
            rows.push(this._seg('Graphics Quality', 'quality', ['low', 'medium', 'high', 'ultra', 'extreme'], s.quality, 'Affects shadows, tree/grass detail, resolution, bloom and anti-aliasing'));
            rows.push(this._slider('Field of View', 'fov', 60, 110, 1, s.fov, v => v + '°'));
            rows.push(this._toggle('Film Grain', 'filmGrain', s.filmGrain > 0.001, 'Subtle cinematic noise'));
            rows.push(this._slider('Screen Shake', 'screenShake', 0, 1.5, 0.05, s.screenShake, v => Math.round(v * 100) + '%'));
            rows.push(this._toggle('Motion Blur', 'motionBlur', s.motionBlur, 'Weapon and camera blur (experimental)'));
        } else if (tab === 'audio') {
            rows.push(this._slider('Master Volume', 'masterVolume', 0, 1, 0.05, s.masterVolume, v => Math.round(v * 100) + '%'));
            rows.push(this._slider('Music Volume', 'musicVolume', 0, 1, 0.05, s.musicVolume, v => Math.round(v * 100) + '%'));
            rows.push(this._slider('Effects Volume', 'sfxVolume', 0, 1, 0.05, s.sfxVolume, v => Math.round(v * 100) + '%'));
            rows.push(this._slider('Ambience Volume', 'ambienceVolume', 0, 1, 0.05, s.ambienceVolume, v => Math.round(v * 100) + '%'));
        } else if (tab === 'controls') {
            rows.push(this._slider('Mouse Sensitivity', 'sensitivity', 0.2, 3, 0.05, s.sensitivity, v => v.toFixed(2)));
            rows.push(this._toggle('Invert Y-Axis', 'invertY', s.invertY, 'Invert vertical look'));
        } else if (tab === 'accessibility') {
            rows.push(this._toggle('Subtitles', 'subtitles', s.subtitles, 'Show dialogue subtitles'));
            rows.push(this._seg('Subtitle Size', 'subtitleSize', ['small', 'medium', 'large'], s.subtitleSize, ''));
            rows.push(this._toggle('Damage Indicators', 'showDamageNumbers', s.showDamageNumbers, 'Directional damage markers'));
        }
        this.body.innerHTML = rows.join('');
        this._wireControls(tab);
    }

    _row(label, hint, controlHtml) {
        return `<div class="setting-row"><div><label>${label}</label>${hint ? `<div class="sr-hint">${hint}</div>` : ''}</div><div class="setting-control">${controlHtml}</div></div>`;
    }
    _slider(label, key, min, max, step, value, fmt) {
        return this._row(label, '', `<input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><span class="value-display" data-for="${key}">${fmt(value)}</span>`);
    }
    _toggle(label, key, value, hint) {
        return this._row(label, hint, `<div class="toggle ${value ? 'on' : ''}" data-toggle="${key}"></div>`);
    }
    _seg(label, key, options, value, hint) {
        const btns = options.map(o => `<button data-seg="${key}" data-val="${o}" class="${o === value ? 'active' : ''}">${o}</button>`).join('');
        return this._row(label, hint, `<div class="seg-control">${btns}</div>`);
    }

    _wireControls(tab) {
        const s = saveManager.settings;
        const fmts = {
            fov: v => v + '°',
            screenShake: v => Math.round(v * 100) + '%',
            masterVolume: v => Math.round(v * 100) + '%',
            musicVolume: v => Math.round(v * 100) + '%',
            sfxVolume: v => Math.round(v * 100) + '%',
            ambienceVolume: v => Math.round(v * 100) + '%',
            sensitivity: v => Number(v).toFixed(2)
        };

        this.body.querySelectorAll('input[type="range"]').forEach(input => {
            input.addEventListener('input', () => {
                const key = input.dataset.key;
                const val = parseFloat(input.value);
                s[key] = val;
                const disp = this.body.querySelector(`[data-for="${key}"]`);
                if (disp && fmts[key]) disp.textContent = fmts[key](val);
                globalEvents.emit('setting_changed', { key, value: val });
                this._apply(key, val);
            });
            input.addEventListener('change', () => saveManager.saveSettings());
        });

        this.body.querySelectorAll('[data-toggle]').forEach(t => {
            t.addEventListener('click', () => {
                const key = t.dataset.toggle;
                s[key] = !s[key];
                t.classList.toggle('on', s[key]);
                saveManager.saveSettings();
                globalEvents.emit('setting_changed', { key, value: s[key] });
                this._apply(key, s[key]);
            });
        });

        this.body.querySelectorAll('[data-seg]').forEach(b => {
            b.addEventListener('click', () => {
                const key = b.dataset.seg;
                this.body.querySelectorAll(`[data-seg="${key}"]`).forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                s[key] = b.dataset.val;
                saveManager.saveSettings();
                globalEvents.emit('setting_changed', { key, value: b.dataset.val });
                this._apply(key, b.dataset.val);
            });
        });
    }

    /** Push a setting change into the live game systems. */
    _apply(key, value) {
        if (this.deps.audio && key.endsWith('Volume')) {
            const bus = key.replace('Volume', '').replace('master', 'master').replace('sfx', 'sfx');
            this.deps.audio.setVolume(bus === 'master' ? 'master' : bus, value);
        }
        // Other keys are consumed by Game via the 'setting_changed' event.
    }
}
