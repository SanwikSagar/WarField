/**
 * Touch controls for phones and tablets. Everything is translated into the SAME input state the
 * keyboard and mouse write (InputManager keys / mouseButtons / mouseMovement / wheel), so no
 * gameplay code knows or cares where input came from.
 *
 *   left half      floating stick: appears where the thumb lands; pushed fully forward = sprint
 *   right side     drag anywhere to look (fire and aim buttons also steer while held)
 *   FIRE           hold to shoot (a second FIRE on the left for two-thumb play)
 *   AIM            toggles aiming down sights
 *   JUMP / CROUCH (toggle) / RELOAD / SWAP (next weapon) / USE (appears near intel) / pause
 * All listeners are passive-free touch handlers on dedicated elements; nothing allocates per move.
 */
export class TouchControls {
    constructor(input, { onPause, getLookScale } = {}) {
        this.input = input; this.onPause = onPause; this.getLookScale = getLookScale || (() => 1);
        const ui = this.el = document.createElement('div');
        ui.id = 'touch-ui';
        ui.innerHTML = `
            <div class="t-stick"></div><div class="t-look"></div>
            <div class="t-base"></div><div class="t-knob"></div>
            <div class="t-btn t-fire" data-b="fire">FIRE</div>
            <div class="t-btn t-fire2" data-b="fire">FIRE</div>
            <div class="t-btn t-ads" data-b="ads">AIM</div>
            <div class="t-btn t-jump" data-b="jump">JUMP</div>
            <div class="t-btn t-crouch" data-b="crouch">CROUCH</div>
            <div class="t-btn t-reload" data-b="reload">RELOAD</div>
            <div class="t-btn t-swap" data-b="swap">SWAP</div>
            <div class="t-btn t-use" data-b="use">USE</div>
            <div class="t-btn t-sprint" data-b="sprint">SPRINT</div>
            <div class="t-btn t-pause" data-b="pause">II</div>`;
        document.body.appendChild(ui);
        document.body.classList.add('touch');
        this.base = ui.querySelector('.t-base'); this.knob = ui.querySelector('.t-knob');
        this.stickId = null; this.sx = 0; this.sy = 0; this.vx = 0; this.vy = 0; this.fullFor = 0;
        this.looks = new Map();           // touch id -> last x/y (look area and steering buttons)
        this.ads = false; this.crouch = false; this.sprintToggle = false;
        this._bind();
    }

    _bind() {
        const stick = this.el.querySelector('.t-stick'), look = this.el.querySelector('.t-look');
        const opt = { passive: false };
        stick.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const t = e.changedTouches[0];
            if (this.stickId !== null) return;
            this.stickId = t.identifier; this.sx = t.clientX; this.sy = t.clientY; this.vx = this.vy = 0;
            this.base.style.left = this.knob.style.left = `${this.sx}px`;
            this.base.style.top = this.knob.style.top = `${this.sy}px`;
            this.el.classList.add('stick-on');
        }, opt);
        const move = (e) => {
            for (const t of e.changedTouches) {
                if (t.identifier === this.stickId) {
                    e.preventDefault();
                    let dx = t.clientX - this.sx, dy = t.clientY - this.sy;
                    const d = Math.hypot(dx, dy), R = 56;
                    if (d > R) { dx *= R / d; dy *= R / d; }
                    this.vx = dx / R; this.vy = dy / R;
                    this.knob.style.left = `${this.sx + dx}px`; this.knob.style.top = `${this.sy + dy}px`;
                    this._applyStick();
                } else if (this.looks.has(t.identifier)) {
                    e.preventDefault();
                    const p = this.looks.get(t.identifier);
                    if (p.btn && !p.steer) continue;           // jump / reload / swap don't steer
                    const k = 2.4 * this.getLookScale();
                    this.input.mouseMovement.x += (t.clientX - p.x) * k;
                    this.input.mouseMovement.y += (t.clientY - p.y) * k;
                    p.x = t.clientX; p.y = t.clientY;
                }
            }
        };
        const end = (e) => {
            for (const t of e.changedTouches) {
                if (t.identifier === this.stickId) {
                    this.stickId = null; this.vx = this.vy = 0; this.el.classList.remove('stick-on'); this._applyStick();
                }
                const p = this.looks.get(t.identifier);
                if (p) { this.looks.delete(t.identifier); if (p.btn) this._release(p.btn, p.el); }
            }
        };
        window.addEventListener('touchmove', move, opt);
        window.addEventListener('touchend', end);
        window.addEventListener('touchcancel', end);
        look.addEventListener('touchstart', (e) => {
            e.preventDefault();
            for (const t of e.changedTouches) this.looks.set(t.identifier, { x: t.clientX, y: t.clientY, btn: null });
        }, opt);
        this.el.querySelectorAll('.t-btn').forEach(el => {
            el.addEventListener('touchstart', (e) => {
                e.preventDefault(); e.stopPropagation();
                const t = e.changedTouches[0], b = el.dataset.b;
                // fire / aim buttons keep steering while held, like a real thumb on glass
                this.looks.set(t.identifier, { x: t.clientX, y: t.clientY, btn: b, el, steer: b === 'fire' || b === 'ads' });
                this._press(b, el);
            }, opt);
        });
    }

    _applyStick() {
        const k = this.input.keys, dz = 0.28;
        k.KeyW = this.vy < -dz; k.KeyS = this.vy > dz; k.KeyA = this.vx < -dz; k.KeyD = this.vx > dz;
    }

    _press(b, el) {
        const k = this.input.keys, m = this.input.mouseButtons;
        switch (b) {
            case 'fire': m.left = true; el.classList.add('on'); break;
            case 'ads': this.ads = !this.ads; m.right = this.ads; el.classList.toggle('on', this.ads); break;
            case 'jump': k.Space = true; el.classList.add('on'); break;
            case 'crouch': this.crouch = !this.crouch; k.KeyC = this.crouch; el.classList.toggle('on', this.crouch); break;
            case 'reload': k.KeyR = true; el.classList.add('on'); break;
            case 'swap': this.input.wheel += 1; el.classList.add('on'); break;
            case 'use': k.KeyE = true; el.classList.add('on'); break;
            case 'sprint': this.sprintToggle = !this.sprintToggle; el.classList.toggle('on', this.sprintToggle); break;
            case 'pause': if (this.onPause) this.onPause(); break;
        }
    }

    _release(b, el) {
        const k = this.input.keys, m = this.input.mouseButtons;
        if (b === 'fire') { m.left = this.el.querySelectorAll('.t-fire.on, .t-fire2.on').length > 1; el.classList.remove('on'); if (!m.left) this.el.querySelectorAll('.t-fire, .t-fire2').forEach(x => x.classList.remove('on')); }
        else if (b === 'jump') { k.Space = false; el.classList.remove('on'); }
        else if (b === 'reload') { k.KeyR = false; el.classList.remove('on'); }
        else if (b === 'use') { k.KeyE = false; el.classList.remove('on'); }
        else if (b === 'swap') el.classList.remove('on');
    }

    /** per frame: auto-sprint, the contextual USE button, reset ADS when the game drops it */
    update(dt, { canUse = false, aiming = null } = {}) {
        const forward = this.vy < -0.92 && Math.abs(this.vx) < 0.45;
        this.fullFor = forward ? this.fullFor + dt : 0;
        this.input.keys.ShiftLeft = this.sprintToggle ? this.vy < -0.3 : this.fullFor > 0.25;
        if (this.sprintToggle && this.vy >= -0.3 && this.stickId === null) { /* keep toggle until used */ }
        this.el.classList.toggle('can-use', canUse);
        if (aiming === false && this.ads && this.input.keys.ShiftLeft) {      // sprinting cancels aim
            this.ads = false; this.input.mouseButtons.right = false;
            const a = this.el.querySelector('.t-ads'); if (a) a.classList.remove('on');
        }
    }

    /** release everything (pause, menus, death) so no input sticks */
    reset() {
        const k = this.input.keys, m = this.input.mouseButtons;
        ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyR', 'KeyE', 'ShiftLeft', 'KeyC'].forEach(c => { k[c] = false; });
        m.left = m.right = false;
        this.ads = this.crouch = this.sprintToggle = false; this.stickId = null; this.looks.clear();
        this.el.classList.remove('stick-on');
        this.el.querySelectorAll('.t-btn.on').forEach(x => x.classList.remove('on'));
    }
}
