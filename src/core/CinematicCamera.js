import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Letterboxed cinematic director. Three modes:
 *  - 'intro': mission opening. Establishing crane → dialogue coverage that cuts
 *    to each speaker as their line starts (alternating over-the-shoulder,
 *    frontal close-up and two-shot) → low tracking shot → push into the
 *    player's eyes, blending seamlessly into gameplay.
 *  - 'outro': mission close. Hero orbit with speaker coverage for the closing
 *    lines, then a rising crane and fade to black.
 *  - 'free':  toggleable (H) cinematic view cycling framed shots around the squad.
 *
 * Robustness: every framing is checked against level geometry so walls never
 * block the shot (the camera is pulled in front of the occluder), look targets
 * are spring-smoothed so animated characters don't jitter the frame, and shot
 * length adapts to how much dialogue is left. Skipping is hold-to-skip so a
 * stray click can't throw away the story.
 */
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const ease = (x) => { x = Math.min(1, Math.max(0, x)); return 1 - Math.pow(1 - x, 3); };
const HOLD_TO_SKIP = 0.9;
/** Horizontal distance from point p to segment a-b. */
function segDist(p, a, b) {
    const abx = b.x - a.x, abz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / (abx * abx + abz * abz || 1)));
    return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

export class CinematicCamera {
    constructor() {
        this.camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 2000);
        this.active = false;
        this.mode = null;
        this.time = 0;
        this.speaker = null;
        this.shot = null;
        this.shotTime = 0;
        this.cutCount = 0;
        this.skipHold = 0;
        this._pos = new THREE.Vector3();
        this._look = new THREE.Vector3();
        this._lookSmooth = new THREE.Vector3();
        this._ray = new THREE.Raycaster();
        this._occl = 1;
        this._occlTarget = 1;
        this._occlTimer = 0;
        this._buildOverlay();
    }

    _buildOverlay() {
        const el = document.createElement('div');
        el.id = 'cine-overlay';
        el.innerHTML = `
            <div class="cine-bar top"></div><div class="cine-bar bottom"></div>
            <div class="cine-title">
                <div class="ct-eyebrow"></div>
                <div class="ct-title"></div>
                <div class="ct-rule"></div>
                <div class="ct-loc"></div>
            </div>
            <div class="cine-skip"><svg viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="15"/><circle class="ring" cx="18" cy="18" r="15"/></svg><span></span></div>
            <div class="cine-fade"></div>`;
        document.body.appendChild(el);
        this.el = el;
        this.titleEl = el.querySelector('.cine-title');
        this.skipEl = el.querySelector('.cine-skip');
        this.skipLabel = this.skipEl.querySelector('span');
        this.skipRing = this.skipEl.querySelector('.ring');
        this.fadeEl = el.querySelector('.cine-fade');
        this._timers = [];
    }

    _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }

    _showOverlay(on, hint = '') {
        this.el.classList.toggle('on', on);
        this.skipLabel.textContent = hint;
        if (!on) {
            this.titleEl.classList.remove('show');
            this._timers.forEach(clearTimeout); this._timers = [];
        }
    }

    /** Fade the frame to/from black. */
    fade(toBlack, seconds = 0.6) {
        this.fadeEl.style.transitionDuration = `${seconds}s`;
        this.fadeEl.classList.toggle('black', !!toBlack);
    }

    /** ctx: { playerPos, playerYaw, gameCamera, squad, objective, heightAt, raycastables, title, dialogue } */
    startIntro(ctx) {
        this.ctx = ctx;
        this.mode = 'intro';
        this.speaker = null;
        const p = ctx.playerPos.clone();
        const toObj = ctx.objective ? ctx.objective.clone().sub(p).setY(0) : new THREE.Vector3(0, 0, -1);
        if (toObj.lengthSq() < 1) toObj.set(0, 0, -1);
        toObj.normalize();
        this._anchor = { p, toObj, right: toObj.clone().cross(UP).normalize(), startAng: Math.atan2(-toObj.x, -toObj.z) };
        this.phase = 'establish';
        this._begin('HOLD SPACE TO SKIP');
        this.fadeEl.style.transitionDuration = '0s';
        this.fadeEl.classList.add('black');
        requestAnimationFrame(() => this.fade(false, 1.4));
        this._setShot(this._establishShot(), false);
        if (ctx.title) this._showTitle(ctx.title);
    }

    /** Closing cinematic around the squad. Resolves via update() returning false. */
    startOutro(ctx) {
        this.ctx = ctx;
        this.mode = 'outro';
        this.speaker = null;
        this.phase = 'orbit';
        const p = ctx.playerPos.clone();
        this._anchor = { p, toObj: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), startAng: ctx.playerYaw || 0 };
        this._begin('HOLD SPACE TO SKIP');
        this._setShot(this._heroOrbitShot(14), false);
        this._outroTail = 0;
        this._sfx('whoosh', 0.5);
    }

    /**
     * Mid-mission story beat: cut into a short letterboxed scene covering the
     * beat's lines (speaker coverage + a wide establishing angle on the
     * objective), then cut back to gameplay. ctx.objective = the beat location.
     */
    startBeat(ctx) {
        this.ctx = ctx;
        this.mode = 'beat';
        this.speaker = null;
        this.phase = 'beat';
        const p = ctx.playerPos.clone();
        const look = (ctx.objective || p).clone();
        const toObj = look.clone().sub(p).setY(0);
        if (toObj.lengthSq() < 1) toObj.set(0, 0, -1);
        toObj.normalize();
        this._anchor = { p, toObj, right: toObj.clone().cross(UP).normalize(), startAng: Math.atan2(-toObj.x, -toObj.z) };
        this._begin('HOLD SPACE TO SKIP');
        this.fadeEl.style.transitionDuration = '0s';
        this.fadeEl.classList.add('black');
        requestAnimationFrame(() => this.fade(false, 0.5));
        this._setShot(this._heroOrbitShot(3.5), false);
        this._sfx('whoosh', 0.55);
    }

    _sfx(kind, gain) { if (this.ctx && this.ctx.audio && this.ctx.audio.playCinematic) this.ctx.audio.playCinematic(kind, gain); }

    /** Free cinematic view that keeps cycling shots until toggled off. */
    startFree(ctx) {
        this.ctx = ctx;
        this.mode = 'free';
        this.phase = 'free';
        this._freeIndex = 0;
        this._begin('H — EXIT CINEMATIC VIEW');
        this._setShot(this._freeShots()[0], false);
    }

    _showTitle(t) {
        const T = this.titleEl;
        T.querySelector('.ct-eyebrow').textContent = t.eyebrow || `${t.code} // ${t.region}`;
        T.querySelector('.ct-title').textContent = t.title;
        const loc = T.querySelector('.ct-loc');
        loc.textContent = '';
        // driven by cinematic time in update(), so it stays in sync even when frames drop
        this._title = { full: t.location || t.region.toUpperCase(), shown: -1, on: false, off: false, loc };
    }

    _updateTitle() {
        const T = this._title;
        if (!T) return;
        if (!T.on && this.time > 1.1) { T.on = true; this.titleEl.classList.add('show'); this._sfx('boom', 0.55); }
        const n = Math.max(0, Math.min(T.full.length, Math.floor((this.time - 1.75) * 26)));
        if (n !== T.shown) { T.shown = n; T.loc.textContent = T.full.slice(0, n); }
        if (!T.off && this.time > 6.6) { T.off = true; this.titleEl.classList.remove('show'); this._title = null; }
    }

    _begin(hint) {
        this.active = true;
        this.time = 0;
        this.cutCount = 0;
        this.skipHold = 0;
        this._title = null;
        this._fadeAt = null;
        this.titleEl.classList.remove('show');
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this._showOverlay(true, hint);
        this.skipEl.classList.remove('visible');
        if (this.ctx && this.ctx.dialogue) this.ctx.dialogue.setMode('cinematic');
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        if (this.ctx && this.ctx.dialogue) this.ctx.dialogue.setMode('hud');
        this.mode = null;
        this.ctx = null;
        this._showOverlay(false);
        this.fade(false, 0.4);
    }

    // ── dialogue-driven cutting ─────────────────────────────────────────
    onDialogue(d) {
        if (!this.active || !this.ctx) return;
        const m = this.ctx.squad ? this.ctx.squad.getMember(String(d.speaker || '')) : null;
        // a speaker far from the action (lagging squadmate, radio voice) gets a wide shot instead of a long-lens close-up
        this.speaker = m && m.isAlive && m.position.distanceTo(this.ctx.playerPos) < 14 ? m : null;
        if (this.mode === 'intro' && (this.phase === 'establish' && this.shotTime > 2.6)) this.phase = 'dialogue';
        if ((this.mode === 'intro' && this.phase === 'dialogue') || this.mode === 'outro' || this.mode === 'beat' || this.mode === 'free') {
            this._setShot(this.speaker ? this._coverageShot(this.speaker, this.cutCount) : this._heroOrbitShot(8), true);
        }
    }

    _setShot(shot, cut = true) {
        this.shot = shot;
        this.shotTime = 0;
        if (cut) this.cutCount++;
        this._snap = true;          // reset smoothing on a cut
        this._occlTimer = 0;
    }

    // ── shot library (each returns { dur, eval(u, o) }) ─────────────────
    _ground(x, z) { return this.ctx.heightAt ? this.ctx.heightAt(x, z) : this._anchor.p.y - 1.7; }

    _centroid(out = new THREE.Vector3()) {
        const ctx = this.ctx;
        const alive = (ctx.squad ? ctx.squad.members : []).filter(m => m.isAlive);
        out.copy(ctx.playerPos);
        alive.forEach(m => out.add(m.position));
        return out.multiplyScalar(1 / (alive.length + 1));
    }

    _establishShot() {
        const { p, toObj, startAng } = this._anchor;
        return { dur: 5.2, eval: (u, o) => {
            const a = startAng + (u - 0.5) * 0.75;
            const r = THREE.MathUtils.lerp(32, 16, smooth(u));
            o.pos.set(p.x + Math.sin(a) * r, 0, p.z + Math.cos(a) * r);
            o.pos.y = this._ground(o.pos.x, o.pos.z) + THREE.MathUtils.lerp(17, 5.5, smooth(u));
            o.look.copy(p).addScaledVector(toObj, 6).setY(p.y);
            o.fov = THREE.MathUtils.lerp(50, 42, u);
        } };
    }

    /** Coverage on a speaking squadmate. Variant cycles: OTS from the player, frontal close-up, wide two-shot. */
    _coverageShot(m, n) {
        let variant = n % 3;
        const p0 = this.ctx.playerPos;
        let side = (n % 2 ? 1 : -1);
        if (variant === 0) {
            // over-the-shoulder only works if no squadmate is standing where the lens would be
            const dir = m.position.clone().sub(p0).setY(0).normalize();
            const rt = dir.clone().cross(UP).normalize();
            const blocked = (s) => {
                const cam = p0.clone().addScaledVector(dir, -0.9).addScaledVector(rt, 0.55 * s);
                return (this.ctx.squad ? this.ctx.squad.members : []).some(o => o !== m && o.isAlive &&
                    (Math.hypot(o.position.x - cam.x, o.position.z - cam.z) < 1.4 ||
                     segDist(o.position, cam, m.position) < 0.6));
            };
            if (blocked(side)) { if (!blocked(-side)) side = -side; else variant = 1; }
        }
        return { dur: 6.5, eval: (u, o) => {
            const head = this._tmpHead || (this._tmpHead = new THREE.Vector3());
            head.copy(m.position); head.y += 1.6;
            const toSpk = this._tmpA || (this._tmpA = new THREE.Vector3());
            toSpk.copy(m.position).sub(p0).setY(0);
            if (toSpk.lengthSq() < 0.25) toSpk.set(0, 0, -1);
            toSpk.normalize();
            const rt = this._tmpB || (this._tmpB = new THREE.Vector3());
            rt.copy(toSpk).cross(UP).normalize();
            if (variant === 0) {          // over the player's shoulder
                o.pos.copy(p0).addScaledVector(toSpk, -0.9 + u * 0.25).addScaledVector(rt, 0.55 * side);
                o.pos.y = p0.y + 1.62;            // playerPos is the feet; shoulder height
                o.look.copy(head).addScaledVector(rt, -0.25 * side);
                o.fov = 34;
            } else if (variant === 1) {   // frontal close-up, slow push
                o.pos.copy(head).addScaledVector(toSpk, -(2.3 - u * 0.4)).addScaledVector(rt, 0.7 * side);
                o.pos.y = head.y - 0.08;
                o.look.copy(head);
                o.fov = 30;
            } else {                      // two-shot, low and wide
                const mid = this._tmpC || (this._tmpC = new THREE.Vector3());
                mid.copy(head).add(p0).multiplyScalar(0.5); mid.y = head.y - 0.25;
                o.pos.copy(mid).addScaledVector(rt, 4.2 * side).addScaledVector(toSpk, -0.6 + u * 0.4);
                o.pos.y = this._ground(o.pos.x, o.pos.z) + 1.05;
                o.look.copy(mid).setY(mid.y - 0.1);
                o.fov = 40;
            }
        } };
    }

    _heroOrbitShot(dur) {
        const a0 = this.time * 0.1 + (this.cutCount % 2 ? 1.6 : 0);
        return { dur, eval: (u, o) => {
            const c = this._centroid(this._tmpCen || (this._tmpCen = new THREE.Vector3()));
            const a = a0 + u * 0.55;
            const r = 6.5 - u * 1.2;
            o.pos.set(c.x + Math.sin(a) * r, 0, c.z + Math.cos(a) * r);
            o.pos.y = this._ground(o.pos.x, o.pos.z) + 0.9 + u * 0.4;
            o.look.copy(c).setY(c.y + 0.1);
            o.fov = 42;
        } };
    }

    _craneRiseShot() {
        const a = this.time * 0.1 + 2.4;
        return { dur: 5.5, eval: (u, o) => {
            const c = this._centroid(this._tmpCen || (this._tmpCen = new THREE.Vector3()));
            const r = 8 + u * 10;
            o.pos.set(c.x + Math.sin(a + u * 0.3) * r, 0, c.z + Math.cos(a + u * 0.3) * r);
            o.pos.y = this._ground(o.pos.x, o.pos.z) + 2 + ease(u) * 16;
            o.look.copy(c).setY(c.y - 0.6 + u * 1.5);
            o.fov = 44;
        } };
    }

    _trackShot() {
        const { p, toObj, right } = this._anchor;
        return { dur: 3.4, eval: (u, o) => {
            o.pos.copy(p).addScaledVector(right, 3.4 - u * 1.8).addScaledVector(toObj, 2.5);
            o.pos.y = this._ground(o.pos.x, o.pos.z) + 0.45;
            o.look.copy(p).addScaledVector(toObj, 14).addScaledVector(right, -1.5);
            o.look.y = this._ground(o.look.x, o.look.z) + 1.6;
            o.fov = 44;
        } };
    }

    _pushInShot() {
        const { p, toObj, right } = this._anchor;
        const cam = this.ctx.gameCamera;
        return { dur: 1.9, blendToGame: true, noOcclusion: true, eval: (u, o) => {
            cam.updateWorldMatrix(true, false);
            const eye = cam.getWorldPosition(this._tmpEye || (this._tmpEye = new THREE.Vector3()));
            const fwd = cam.getWorldDirection(this._tmpFwd || (this._tmpFwd = new THREE.Vector3()));
            const start = this._tmpS || (this._tmpS = new THREE.Vector3());
            start.copy(p).addScaledVector(toObj, -3.5).addScaledVector(right, 1.2);
            start.y = eye.y + 0.8;
            const k = smooth(u);
            o.pos.lerpVectors(start, eye, k);
            const lookA = this._tmpL || (this._tmpL = new THREE.Vector3());
            lookA.copy(p).addScaledVector(toObj, 10).setY(eye.y);
            o.look.lerpVectors(lookA, fwd.multiplyScalar(10).add(eye), k);
            o.fov = THREE.MathUtils.lerp(44, cam.fov, k);
        } };
    }

    _freeShots() {
        return [
            { dur: 9, eval: (u, o) => {
                const c = this._centroid(this._tmpCen || (this._tmpCen = new THREE.Vector3())), a = this.time * 0.09;
                o.pos.set(c.x + Math.sin(a) * 9, 0, c.z + Math.cos(a) * 9);
                o.pos.y = this._ground(o.pos.x, o.pos.z) + 3.2;
                o.look.copy(c).setY(c.y - 0.4); o.fov = 42;
            } },
            this._heroOrbitShot(7),
            this._craneRiseShot()
        ];
    }

    // ── per-frame ───────────────────────────────────────────────────────
    /** Pull the camera in front of any wall between it and its subject. */
    _resolveOcclusion(dt) {
        const list = this.ctx.raycastables;
        if (!list || !list.length || (this.shot && this.shot.noOcclusion)) { this._occl = 1; return; }
        this._occlTimer -= dt;
        if (this._occlTimer <= 0) {
            this._occlTimer = 0.2;
            const dir = this._tmpDir || (this._tmpDir = new THREE.Vector3());
            dir.copy(this._pos).sub(this._look);
            const dist = dir.length();
            if (dist > 0.01) {
                dir.multiplyScalar(1 / dist);
                this._ray.set(this._look, dir);
                this._ray.far = dist;
                const hit = this._ray.intersectObjects(list, false)[0];
                this._occlTarget = hit ? Math.max(0.12, (hit.distance - 0.35) / dist) : 1;
            }
        }
        if (this._snap) this._occl = this._occlTarget;
        else this._occl += (this._occlTarget - this._occl) * Math.min(1, dt * 6);
        if (this._occl < 0.999) this._pos.lerpVectors(this._look, this._pos, this._occl);
    }

    _advancePhase() {
        if (this.mode === 'intro') {
            const dlg = this.ctx.dialogue;
            if (this.phase === 'establish') {
                this.phase = dlg && dlg.busy ? 'dialogue' : 'track';
                this._setShot(this.phase === 'dialogue'
                    ? (this.speaker ? this._coverageShot(this.speaker, this.cutCount) : this._heroOrbitShot(6))
                    : this._trackShot());
                return true;
            }
            if (this.phase === 'dialogue') {
                if (dlg && dlg.busy) { this._setShot(this._heroOrbitShot(Math.min(8, dlg.remaining() + 1))); return true; }
                this.phase = 'track'; this._setShot(this._trackShot()); return true;
            }
            if (this.phase === 'track') { this.phase = 'push'; this._setShot(this._pushInShot()); return true; }
            return false;   // push finished: intro is over
        }
        if (this.mode === 'outro') {
            const dlg = this.ctx.dialogue;
            if (this.phase === 'orbit') {
                if (dlg && dlg.busy) { this._setShot(this._heroOrbitShot(Math.min(8, dlg.remaining() + 1))); return true; }
                this.phase = 'crane'; this._setShot(this._craneRiseShot());
                this._fadeAt = this.time + 3.6;
                this._sfx('sting', 0.6);
                return true;
            }
            return false;
        }
        if (this.mode === 'beat') {
            const dlg = this.ctx.dialogue;
            if (dlg && dlg.busy) { this._setShot(this._heroOrbitShot(Math.min(6, dlg.remaining() + 0.8))); return true; }
            return false;
        }
        const shots = this._freeShots();
        this._freeIndex = (this._freeIndex + 1) % shots.length;
        this._setShot(shots[this._freeIndex]);
        return true;
    }

    /**
     * Feed skip input every frame while a skippable cinematic runs.
     * Returns true once the hold completes.
     */
    feedSkip(held, dt) {
        if (this.mode === 'free') return false;
        if (held) {
            this.skipHold += dt;
            this.skipEl.classList.add('visible');
            this._skipSeen = 2.5;
        } else {
            this.skipHold = Math.max(0, this.skipHold - dt * 3);
            if (this._skipSeen > 0) this._skipSeen -= dt; else this.skipEl.classList.remove('visible');
        }
        const k = Math.min(1, this.skipHold / HOLD_TO_SKIP);
        this.skipRing.style.strokeDashoffset = String(94.25 * (1 - k));
        return k >= 1;
    }

    /** Returns false once the intro/outro has finished. */
    update(dt) {
        if (!this.active) return false;
        this.time += dt;
        this.shotTime += dt;
        this._updateTitle();
        if (this._fadeAt != null && this.time >= this._fadeAt) { this._fadeAt = null; this.fade(true, 1.6); }
        if (this.shotTime >= this.shot.dur && !this._advancePhase()) return false;

        const o = { pos: this._pos, look: this._look, fov: 40 };
        this.shot.eval(Math.min(1, this.shotTime / this.shot.dur), o);
        this._resolveOcclusion(dt);

        // spring-smoothed look target (snaps on cuts)
        if (this._snap) { this._lookSmooth.copy(this._look); this._snap = false; }
        else this._lookSmooth.lerp(this._look, 1 - Math.exp(-dt * 7));

        // handheld drift fades out as the intro hands control to the player
        const fade = this.shot.blendToGame ? 1 - smooth(this.shotTime / this.shot.dur) : 1;
        const t = this.time;
        this.camera.position.copy(this._pos);
        this.camera.position.x += (Math.sin(t * 0.9) * 0.025 + Math.sin(t * 2.3) * 0.006) * fade;
        this.camera.position.y += (Math.sin(t * 1.3 + 1) * 0.02) * fade;
        this.camera.lookAt(this._lookSmooth);
        this.camera.rotation.z += Math.sin(t * 0.7) * 0.006 * fade;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        if (Math.abs(this.camera.fov - o.fov) > 0.01 || this._aspect !== this.camera.aspect) {
            this.camera.fov = o.fov;
            this._aspect = this.camera.aspect;
            this.camera.updateProjectionMatrix();
        }
        return true;
    }
}
