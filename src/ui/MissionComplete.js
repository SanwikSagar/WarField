import { globalEvents } from '../core/EventManager.js';

/**
 * Mission complete screen (GDD 10.2). Shows performance stats (counting up) and
 * offers next-mission or return to menu. Enter continues, Esc returns to menu.
 */
export class MissionComplete {
    constructor(deps = {}) {
        this.deps = deps; // { onNext, onMenu }
        this.el = document.getElementById('mission-complete');
        this.visible = false;
        this._raf = 0;
        this._bind();
    }

    _sound(kind) { if (this.deps.audio) this.deps.audio.playUI(kind); }

    _next() {
        const btn = document.getElementById('complete-next');
        if (btn.disabled) { this._menu(); return; }
        this._sound('select');
        if (this.deps.onNext) this.deps.onNext();
    }

    _menu() {
        this._sound('back');
        if (this.deps.onMenu) this.deps.onMenu();
    }

    _bind() {
        document.getElementById('complete-next').addEventListener('click', () => this._next());
        document.getElementById('complete-menu').addEventListener('click', () => this._menu());
        window.addEventListener('keydown', (e) => {
            if (!this.visible || e.ctrlKey || e.altKey || e.metaKey) return;
            if (e.code === 'Enter' || e.code === 'NumpadEnter') this._next();
            else if (e.code === 'Escape') this._menu();
            else return;
            e.preventDefault();
        });
    }

    show(result) {
        this.result = result;
        this.visible = true;
        document.getElementById('complete-title').textContent = result.title;
        const eyebrow = this.el.querySelector('.complete-eyebrow');
        if (eyebrow) eyebrow.textContent = result.episode ? `EPISODE ${String(result.episode).padStart(2, '0')} COMPLETE` : 'MISSION COMPLETE';
        let teaser = this.el.querySelector('.complete-teaser');
        if (!teaser) {
            teaser = document.createElement('div');
            teaser.className = 'complete-teaser';
            this.el.querySelector('.complete-stats').after(teaser);
        }
        teaser.innerHTML = result.teaser ? `
            <div class="tz-label">NEXT EPISODE</div>
            <div class="tz-title">EPISODE ${result.teaser.code} — ${result.teaser.title.toUpperCase()}</div>
            <div class="tz-blurb">${result.teaser.blurb}</div>
            <div class="tz-date">ARRIVES ${result.teaser.when}</div>` : '';
        teaser.style.display = result.teaser ? '' : 'none';
        const mins = Math.floor(result.time / 60);
        const secs = String(result.time % 60).padStart(2, '0');
        document.getElementById('complete-stats').innerHTML = `
            <div class="cs-item"><div class="cs-val" data-count="${result.kills}">0</div><div class="cs-label">ELIMINATIONS</div></div>
            <div class="cs-item"><div class="cs-val" data-count="${result.headshots}">0</div><div class="cs-label">HEADSHOTS</div></div>
            <div class="cs-item"><div class="cs-val" data-count="${result.accuracy}" data-suffix="%">0%</div><div class="cs-label">ACCURACY</div></div>
            <div class="cs-item"><div class="cs-val">${mins}:${secs}</div><div class="cs-label">TIME</div></div>`;
        const nextBtn = document.getElementById('complete-next');
        nextBtn.disabled = !result.nextMission;
        nextBtn.textContent = result.nextMission ? 'NEXT EPISODE ▸' : 'SEASON CONTINUES SOON';
        this.el.classList.remove('hidden');
        this._countUp();
        (nextBtn.disabled ? document.getElementById('complete-menu') : nextBtn).focus({ preventScroll: true });
    }

    _countUp() {
        cancelAnimationFrame(this._raf);
        const nodes = Array.from(this.el.querySelectorAll('[data-count]'));
        const start = performance.now(), dur = 900;
        const step = (now) => {
            const t = Math.min(1, (now - start) / dur);
            const e = 1 - Math.pow(1 - t, 3);
            nodes.forEach(n => { n.textContent = Math.round(Number(n.dataset.count) * e) + (n.dataset.suffix || ''); });
            if (t < 1) this._raf = requestAnimationFrame(step);
        };
        this._raf = requestAnimationFrame(step);
    }

    hide() {
        this.visible = false;
        cancelAnimationFrame(this._raf);
        this.el.classList.add('hidden');
    }
}
