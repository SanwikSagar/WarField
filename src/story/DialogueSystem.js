import { globalEvents } from '../core/EventManager.js';
import { saveManager } from '../save/SaveManager.js';
import { speakerInfo } from './Story.js';

/**
 * Single owner of every spoken line in the game (gameplay radio, cinematics,
 * pickups, system notices). Lines are queued and never overlap; each one
 * types on, holds for a reading-speed duration, then hands over to the next.
 * The clock only advances while Game calls update(), so pausing the game
 * freezes the conversation mid-line instead of letting it run off-screen.
 *
 * Emits `dialogue` ({ speaker, text, managed: true }) as each line starts so
 * squadmates animate and the cinematic camera can cut to the speaker. Any
 * other code that emits a bare `dialogue` event gets routed into the queue.
 */
const TYPE_RATE = 52;          // characters per second for the type-on
const GAP = 0.35;              // silence between lines
const MIN_HOLD = 2.2;

export class DialogueSystem {
    constructor({ audio } = {}) {
        this.audio = audio;
        this.queue = [];
        this.current = null;
        this.gap = 0;
        this.mode = 'hud';
        this._waiters = [];
        this._build();
        globalEvents.on('dialogue', (d) => { if (!d.managed) this.play([{ speaker: d.speaker, text: d.text, radio: d.radio }]); });
    }

    _build() {
        const el = document.createElement('div');
        el.id = 'dialogue';
        el.className = 'dlg';
        el.setAttribute('aria-live', 'polite');
        el.innerHTML = `
            <div class="dlg-card">
                <div class="dlg-badge"><span class="dlg-initials"></span><i class="dlg-wave"><b></b><b></b><b></b><b></b></i></div>
                <div class="dlg-body">
                    <div class="dlg-head"><span class="dlg-name"></span><span class="dlg-role"></span><span class="dlg-radio">RADIO</span></div>
                    <div class="dlg-text"></div>
                </div>
            </div>`;
        document.body.appendChild(el);
        this.el = el;
        this.nameEl = el.querySelector('.dlg-name');
        this.roleEl = el.querySelector('.dlg-role');
        this.textEl = el.querySelector('.dlg-text');
        this.initialsEl = el.querySelector('.dlg-initials');
    }

    /** Queue lines. Returns a promise that resolves once they have all been spoken (or cleared). */
    play(lines, { interrupt = false } = {}) {
        if (!lines || !lines.length) return Promise.resolve();
        if (interrupt) this.clear();
        this.queue.push(...lines.map(l => ({ ...l })));
        return new Promise(res => this._waiters.push({ res, last: this.queue[this.queue.length - 1] }));
    }

    say(speaker, text, opts = {}) { return this.play([{ speaker, text, ...opts }]); }

    clear() {
        this.queue = [];
        this.current = null;
        this.gap = 0;
        this.el.classList.remove('show', 'radio', 'typing');
        this._waiters.forEach(w => w.res());
        this._waiters = [];
    }

    get busy() { return !!this.current || this.queue.length > 0; }

    /** Seconds of dialogue still to come (for pacing cinematics). */
    remaining() {
        let t = this.current ? Math.max(0, this.current.dur - this.current.t) : 0;
        for (const l of this.queue) t += this._duration(l) + GAP;
        return t;
    }

    setMode(mode) {
        this.mode = mode;
        this.el.classList.toggle('cine', mode === 'cinematic');
    }

    setVisible(on) { this.el.style.visibility = on ? '' : 'hidden'; }

    _duration(line) {
        const n = String(line.text || '').length;
        return Math.max(MIN_HOLD, n / TYPE_RATE + 1.1 + n * 0.028) + (line.pause || 0);
    }

    _start(line) {
        const info = speakerInfo(line.speaker);
        line.t = 0;
        line.dur = this._duration(line);
        line.shown = 0;
        this.current = line;
        const subs = saveManager.settings.subtitles !== false;
        const size = saveManager.settings.subtitleSize || 'medium';
        this.el.dataset.size = size;
        this.el.style.setProperty('--spk', info.color);
        this.nameEl.textContent = info.name.toUpperCase();
        this.roleEl.textContent = info.role ? info.role.toUpperCase() : '';
        this.initialsEl.textContent = initials(info.name);
        this.textEl.textContent = '';
        this.el.classList.toggle('radio', !!line.radio);
        this.el.classList.add('typing');
        // restart the entrance animation
        this.el.classList.remove('show');
        void this.el.offsetWidth;
        if (subs) this.el.classList.add('show');
        if (this.audio && this.audio.playRadio) this.audio.playRadio(line.radio ? 'open' : 'chirp');
        globalEvents.emit('dialogue', { speaker: line.speaker, text: line.text, radio: !!line.radio, managed: true });
    }

    _finish() {
        const done = this.current;
        this.current = null;
        this.gap = GAP;
        this.el.classList.remove('typing');
        if (done && done.radio && this.audio && this.audio.playRadio) this.audio.playRadio('close');
        // resolve any waiter whose last line just finished
        this._waiters = this._waiters.filter(w => { if (w.last === done) { w.res(); return false; } return true; });
        if (!this.queue.length) this.el.classList.remove('show');
    }

    /** Skip the typing / current line (used by tap-to-advance in cinematics). */
    advance() {
        const c = this.current;
        if (!c) return;
        if (c.shown < c.text.length) { c.shown = c.text.length; this.textEl.textContent = c.text; c.t = Math.max(c.t, c.dur - 1.2); }
        else c.t = c.dur;
    }

    update(dt) {
        if (this.current) {
            const c = this.current;
            c.t += dt;
            const want = Math.min(c.text.length, Math.floor(c.t * TYPE_RATE));
            if (want !== c.shown) {
                c.shown = want;
                this.textEl.textContent = c.text.slice(0, want);
                if (want >= c.text.length) this.el.classList.remove('typing');
            }
            if (c.t >= c.dur) this._finish();
            return;
        }
        if (this.gap > 0) { this.gap -= dt; return; }
        if (this.queue.length) this._start(this.queue.shift());
    }
}

function initials(name) {
    const parts = String(name).replace(/^(Capt|Lt|Sgt|Gen)\.\s*/i, '').split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
