import { globalEvents } from '../core/EventManager.js';

/**
 * Pause menu (GDD 10.2). Shown on Escape during gameplay; offers resume,
 * settings, restart-checkpoint, and abort-to-menu. Displays live mission stats.
 */
export class PauseMenu {
    constructor(deps = {}) {
        this.deps = deps; // { onResume, onRestart, onAbort, onSettings }
        this.el = document.getElementById('pause-menu');
        this.visible = false;
        this._bind();
    }

    _bind() {
        this.el.querySelectorAll('[data-pause]').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.pause;
                if (this.deps.audio) this.deps.audio.playUI('select');
                if (action === 'resume') this.deps.onResume && this.deps.onResume();
                else if (action === 'settings') this.deps.onSettings && this.deps.onSettings();
                else if (action === 'restart') this.deps.onRestart && this.deps.onRestart();
                else if (action === 'abort') this.deps.onAbort && this.deps.onAbort();
            });
            btn.addEventListener('mouseenter', () => { if (this.deps.audio) this.deps.audio.playUI('hover'); });
        });
    }

    show(missionLabel, stats) {
        this.visible = true;
        this.el.classList.remove('hidden');
        document.getElementById('pause-mission').textContent = missionLabel || '';
        const statsEl = document.getElementById('pause-stats');
        if (stats) {
            statsEl.innerHTML =
                `ELAPSED &nbsp; ${Math.floor(stats.time / 60)}:${String(stats.time % 60).padStart(2, '0')}<br>` +
                `ELIMINATIONS &nbsp; ${stats.kills}<br>` +
                `ACCURACY &nbsp; ${stats.accuracy}%`;
        } else {
            statsEl.innerHTML = '';
        }
    }

    hide() {
        this.visible = false;
        this.el.classList.add('hidden');
    }
}
