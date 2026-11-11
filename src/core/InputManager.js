/**
 * Centralized input. Maps raw keys/buttons to named actions and tracks
 * edge transitions (justPressed / justReleased) so gameplay code never has
 * to poll raw key state or guess whether an action fired this frame.
 */
export class InputManager {
    constructor() {
        this.keys = {};
        this.prevKeys = {};
        this.mouseButtons = { left: false, right: false, middle: false };
        this.prevMouseButtons = { left: false, right: false, middle: false };
        this.mouseMovement = { x: 0, y: 0 };
        this.wheel = 0;
        this.isLocked = false;

        this.sensitivity = 0.0022;
        this.invertY = false;

        // Action -> key code bindings (remappable via settings)
        this.bindings = {
            forward: ['KeyW'],
            back: ['KeyS'],
            left: ['KeyA'],
            right: ['KeyD'],
            sprint: ['ShiftLeft'],
            crouch: ['ControlLeft', 'KeyC'],
            jump: ['Space'],
            reload: ['KeyR'],
            interact: ['KeyE'],
            fireMode: ['KeyB'],
            weapon1: ['Digit1'],
            weapon2: ['Digit2'],
            weapon3: ['Digit3'],
            melee: ['KeyV'],
            inspect: ['KeyF'],
            cinematic: ['KeyH'],
            pause: ['Escape'],
            scoreboard: ['Tab']
        };

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._onLockChange = this._onLockChange.bind(this);
        this._onContext = (e) => e.preventDefault();
    }

    initialize(canvas) {
        this.canvas = canvas || document.body;
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('mousedown', this._onMouseDown);
        window.addEventListener('mouseup', this._onMouseUp);
        window.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('wheel', this._onWheel, { passive: true });
        window.addEventListener('contextmenu', this._onContext);
        document.addEventListener('pointerlockchange', this._onLockChange);
        document.addEventListener('pointerlockerror', this._onLockChange);
    }

    _onKeyDown(e) {
        // Prevent browser scroll/space defaults while playing
        if (['Space', 'Tab', 'Escape'].includes(e.code)) e.preventDefault();
        this.keys[e.code] = true;
    }
    _onKeyUp(e) { this.keys[e.code] = false; }

    _onMouseDown(e) {
        if (e.button === 0) this.mouseButtons.left = true;
        if (e.button === 1) this.mouseButtons.middle = true;
        if (e.button === 2) this.mouseButtons.right = true;
    }
    _onMouseUp(e) {
        if (e.button === 0) this.mouseButtons.left = false;
        if (e.button === 1) this.mouseButtons.middle = false;
        if (e.button === 2) this.mouseButtons.right = false;
    }
    _onMouseMove(e) {
        if (this.isLocked) {
            this.mouseMovement.x += e.movementX;
            this.mouseMovement.y += e.movementY;
        }
    }
    _onWheel(e) { this.wheel += Math.sign(e.deltaY); }
    _onLockChange() {
        this.isLocked = document.pointerLockElement === this.canvas;
    }

    requestLock() {
        if (!this.isLocked && this.canvas.requestPointerLock) {
            this.canvas.requestPointerLock();
        }
    }
    exitLock() {
        if (document.pointerLockElement) document.exitPointerLock();
    }

    /** True while any bound key for the action is held. */
    isDown(action) {
        const binds = this.bindings[action];
        if (!binds) return false;
        return binds.some(code => this.keys[code]);
    }

    /** True only on the frame the action transitions from up to down. */
    justPressed(action) {
        const binds = this.bindings[action];
        if (!binds) return false;
        return binds.some(code => this.keys[code] && !this.prevKeys[code]);
    }

    isMouseDown(button) { return this.mouseButtons[button]; }
    justPressedMouse(button) {
        return this.mouseButtons[button] && !this.prevMouseButtons[button];
    }

    consumeMouseMovement() {
        const m = {
            x: this.mouseMovement.x * this.sensitivity,
            y: this.mouseMovement.y * this.sensitivity * (this.invertY ? -1 : 1)
        };
        this.mouseMovement.x = 0;
        this.mouseMovement.y = 0;
        return m;
    }

    consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }

    /** Call at the very end of each frame to latch edge states. */
    endFrame() {
        this.prevKeys = { ...this.keys };
        this.prevMouseButtons = { ...this.mouseButtons };
    }

    rebind(action, keyCode) {
        if (this.bindings[action]) this.bindings[action] = [keyCode];
    }
}
