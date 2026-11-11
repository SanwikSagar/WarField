import { globalEvents } from '../core/EventManager.js';

/**
 * Mission complete screen (GDD 10.2). Shows performance stats and offers
 * replay/next-mission or return to menu.
 */
export class MissionComplete {
    constructor(deps = {}) {
        this.deps = deps; // { onNext, onMenu }
        this.el = document.getElementById('mission-complete');
        this._bind();
    }

    _bind() {
        document.getElementById('complete-next').addEventListener('click', () => {
            if (this.deps.audio) this.deps.audio.playUI('select');
            this.deps.onNext && this.onNext();
        });
        document.getElementById('complete-menu').addEventListener('click', () => {
            if (this.deps.audio) this.deps.audio.playUI('back');
            this.deps.onMenu && this.deps.onMenu();
        });
    }

    show(result) {
        this.result = result;
        document.getElementById('complete-title').textContent = result.title;
        const mins = Math.floor(result.time / 60);
        const secs = String(result.time % 60).padStart(2, '0');
        document.getElementById('complete-stats').innerHTML = `
            <div class="cs-item"><div class="cs-val">${result.kills}</div><div class="cs-label">ELIMINATIONS</div></div>
            <div class="cs-item"><div class="cs-val">${result.headshots}</div><div class="cs-label">HEADSHOTS</div></div>
            <div class="cs-item"><div class="cs-val">${result.accuracy}%</div><div class="cs-label">ACCURACY</div></div>
            <div class="cs-item"><div class="cs-val">${mins}:${secs}</div><div class="cs-label">TIME</div></div>`;
        const nextBtn = document.getElementById('complete-next');
        nextBtn.disabled = !result.nextMission;
        nextBtn.textContent = result.nextMission ? 'NEXT MISSION ▸' : 'CAMPAIGN COMPLETE';
        this.el.classList.remove('hidden');
    }

    hide() { this.el.classList.add('hidden'); }
}
