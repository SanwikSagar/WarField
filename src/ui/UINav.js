/**
 * Menu input bridge. Translates gamepad input into the same keyboard events the
 * menus already handle (so every screen supports pad, keyboard and mouse), and
 * tracks the last-used device on <body data-input="kbm|pad"> so key hints show
 * the right glyphs.
 *
 * Only active while a menu screen is open; gameplay input is untouched. Every
 * synthetic keydown is followed by a keyup so the gameplay InputManager never
 * sees a stuck key.
 */
const PAD_KEYS = {
    12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight',
    0: 'Enter', 1: 'Escape', 4: 'KeyQ', 5: 'KeyE'
};
const FIRST_REPEAT = 0.38, REPEAT = 0.11, STICK = 0.6;

export class UINav {
    constructor() {
        this.device = 'kbm';
        this.held = new Map();      // code -> seconds until next repeat
        this.last = performance.now();
        this._setDevice('kbm');
        const kbm = (e) => { if (e.isTrusted) this._setDevice('kbm'); };
        window.addEventListener('keydown', kbm, true);
        window.addEventListener('mousemove', kbm, true);
        window.addEventListener('pointerdown', kbm, true);
        this._tick = this._tick.bind(this);
        requestAnimationFrame(this._tick);
    }

    _setDevice(d) {
        if (this.device === d && document.body.dataset.input === d) return;
        this.device = d;
        document.body.dataset.input = d;
    }

    _menuOpen() {
        return !!document.querySelector('.screen:not(.hidden)');
    }

    _fire(code) {
        const init = { code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code, bubbles: true, cancelable: true };
        window.dispatchEvent(new KeyboardEvent('keydown', init));
        window.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    _tick(now) {
        requestAnimationFrame(this._tick);
        const dt = Math.min((now - this.last) / 1000, 0.1);
        this.last = now;
        if (!navigator.getGamepads) return;
        const pads = navigator.getGamepads();
        const pad = pads && Array.from(pads).find(p => p && p.connected);
        if (!pad) { this.held.clear(); return; }

        const down = new Set();
        for (const [i, code] of Object.entries(PAD_KEYS)) {
            if (pad.buttons[i] && pad.buttons[i].pressed) down.add(code);
        }
        const [ax, ay] = [pad.axes[0] || 0, pad.axes[1] || 0];
        if (ay < -STICK) down.add('ArrowUp'); else if (ay > STICK) down.add('ArrowDown');
        if (ax < -STICK) down.add('ArrowLeft'); else if (ax > STICK) down.add('ArrowRight');

        if (down.size) this._setDevice('pad');
        const open = this._menuOpen();
        for (const code of [...this.held.keys()]) if (!down.has(code)) this.held.delete(code);
        for (const code of down) {
            if (!this.held.has(code)) {
                this.held.set(code, FIRST_REPEAT);
                if (open) this._fire(code);
            } else if (code.startsWith('Arrow')) {
                const t = this.held.get(code) - dt;
                if (t <= 0) { this.held.set(code, REPEAT); if (open) this._fire(code); }
                else this.held.set(code, t);
            }
        }
    }
}
