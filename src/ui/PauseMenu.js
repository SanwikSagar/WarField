import { globalEvents } from '../core/EventManager.js';

/**
 * Pause menu (GDD 10.2). Shown on Escape during gameplay; offers resume,
 * settings, restart-checkpoint, and abort-to-menu. Displays live mission stats.
 * Navigable with mouse, W/S/arrows + Enter, Esc to resume, and gamepad (UINav).
 */
export class PauseMenu {
    constructor(deps = {}) {
        this.deps = deps; // { onResume, onRestart, onAbort, onSettings }
        this.el = document.getElementById('pause-menu');
        this.items = Array.from(this.el.querySelectorAll('[data-pause]'));
        this.index = 0;
        this.visible = false;
        this._bind();
    }

    _sound(kind) { if (this.deps.audio) this.deps.audio.playUI(kind); }

    _bind() {
        this.items.forEach((btn, i) => {
            btn.addEventListener('click', () => this._activate(btn.dataset.pause));
            btn.addEventListener('mouseenter', () => { if (this.index !== i) { this._select(i); this._sound('hover'); } });
        });
        window.addEventListener('keydown', (e) => this._onKey(e));
    }

    _activate(action) {
        this._sound(action === 'resume' ? 'back' : 'select');
        if (action === 'resume') this.deps.onResume && this.deps.onResume();
        else if (action === 'settings') this.deps.onSettings && this.deps.onSettings();
        else if (action === 'restart') this.deps.onRestart && this.deps.onRestart();
        else if (action === 'abort') this.deps.onAbort && this.deps.onAbort();
    }

    _select(i) {
        this.index = i;
        this.items.forEach((b, n) => b.classList.toggle('selected', n === i));
    }

    /** True while another screen (settings) is layered over the pause menu. */
    _covered() {
        const s = document.getElementById('settings-screen');
        return !!s && !s.classList.contains('hidden');
    }

    _onKey(e) {
        if (!this.visible || this._covered() || e.ctrlKey || e.altKey || e.metaKey) return;
        const c = e.code, n = this.items.length;
        if (c === 'ArrowDown' || c === 'KeyS') { this._select((this.index + 1) % n); this._sound('hover'); }
        else if (c === 'ArrowUp' || c === 'KeyW') { this._select((this.index - 1 + n) % n); this._sound('hover'); }
        else if (c === 'Enter' || c === 'NumpadEnter') this._activate(this.items[this.index].dataset.pause);
        else if (c === 'Escape') this._activate('resume');
        else return;
        e.preventDefault();
    }

    show(missionLabel, stats) {
        this.visible = true;
        this.el.classList.remove('hidden');
        document.getElementById('pause-mission').textContent = missionLabel || '';
        const statsEl = document.getElementById('pause-stats');
        if (stats) {
            const t = `${Math.floor(stats.time / 60)}:${String(stats.time % 60).padStart(2, '0')}`;
            statsEl.innerHTML =
                `<div><span>ELAPSED</span><b>${t}</b></div>` +
                `<div><span>ELIMINATIONS</span><b>${stats.kills}</b></div>` +
                `<div><span>ACCURACY</span><b>${stats.accuracy}%</b></div>`;
        } else {
            statsEl.innerHTML = '';
        }
        this._select(0);
    }

    hide() {
        this.visible = false;
        this.el.classList.add('hidden');
    }
}
