import * as THREE from 'three';

/**
 * Letterboxed cinematic camera. Two modes:
 *  - 'intro': scripted mission opening (crane establishing shot, squad close-up
 *    on whoever is talking, low tracking shot, then a push into the player's eyes).
 *  - 'free':  toggleable cinematic view that cycles framed shots around the squad,
 *    cutting to whoever speaks on the radio.
 * Shots are pure functions of time returning { pos, look, fov }, with a light
 * handheld drift layered on top.
 */
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

export class CinematicCamera {
    constructor() {
        this.camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 2000);
        this.active = false;
        this.mode = null;
        this.shots = [];
        this.shotIndex = 0;
        this.shotTime = 0;
        this.time = 0;
        this.speaker = null;
        this._pos = new THREE.Vector3();
        this._look = new THREE.Vector3();
        this._buildOverlay();
    }

    _buildOverlay() {
        const el = document.createElement('div');
        el.id = 'cine-overlay';
        el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:6;opacity:0;transition:opacity .5s;';
        const bar = 'position:absolute;left:0;right:0;height:11vh;background:#000;transition:transform .7s cubic-bezier(.2,.7,.2,1);';
        el.innerHTML = `<div data-bar="top" style="${bar}top:0;transform:translateY(-100%)"></div>`
            + `<div data-bar="bottom" style="${bar}bottom:0;transform:translateY(100%)"></div>`
            + '<div data-title style="position:absolute;left:6vw;bottom:15vh;color:#e8e2d0;font-family:inherit;letter-spacing:.35em;text-transform:uppercase;opacity:0;transition:opacity 1.2s;text-shadow:0 2px 12px rgba(0,0,0,.8)"></div>'
            + '<div data-sub style="position:absolute;left:50%;bottom:12.5vh;transform:translateX(-50%);max-width:70vw;text-align:center;color:#f2eee2;font-size:18px;line-height:1.4;text-shadow:0 2px 6px #000;opacity:0;transition:opacity .3s"></div>'
            + '<div data-hint style="position:absolute;right:3vw;bottom:3.5vh;color:rgba(232,226,208,.55);font-size:12px;letter-spacing:.25em;z-index:1"></div>';
        document.body.appendChild(el);
        this.el = el;
        this.bars = [...el.querySelectorAll('[data-bar]')];
        this.titleEl = el.querySelector('[data-title]');
        this.hintEl = el.querySelector('[data-hint]');
        this.subEl = el.querySelector('[data-sub]');
        this._subTimer = 0;
    }

    _showOverlay(on, hint = '') {
        this.el.style.opacity = on ? '1' : '0';
        this.bars.forEach(b => { b.style.transform = on ? 'translateY(0)' : `translateY(${b.dataset.bar === 'top' ? '-100%' : '100%'})`; });
        this.hintEl.textContent = hint;
        if (!on) { this.titleEl.style.opacity = '0'; this.subEl.style.opacity = '0'; this._subTimer = 0; }
    }

    /**
     * ctx: { scene, playerPos, playerYaw, gameCamera, squad, objective, heightAt, title }
     */
    startIntro(ctx) {
        this.ctx = ctx;
        this.mode = 'intro';
        this.speaker = null;
        const p = ctx.playerPos.clone();
        const toObj = ctx.objective ? ctx.objective.clone().sub(p).setY(0) : new THREE.Vector3(0, 0, -1);
        if (toObj.lengthSq() < 1) toObj.set(0, 0, -1);
        toObj.normalize();
        const right = toObj.clone().cross(UP).normalize();
        const ground = (x, z) => (ctx.heightAt ? ctx.heightAt(x, z) : p.y);
        const startAng = Math.atan2(-toObj.x, -toObj.z);

        this.shots = [
            {   // 1. establishing crane: high behind the squad, sweeping and descending
                dur: 4.2, eval: (u, o) => {
                    const a = startAng + (u - 0.5) * 0.7;
                    const r = THREE.MathUtils.lerp(30, 17, smooth(u));
                    o.pos.set(p.x + Math.sin(a) * r, 0, p.z + Math.cos(a) * r);
                    o.pos.y = ground(o.pos.x, o.pos.z) + THREE.MathUtils.lerp(16, 6, smooth(u));
                    o.look.copy(p).addScaledVector(toObj, 7).setY(p.y + 1.2);
                    o.fov = 46;
                }
            },
            {   // 2. medium close-up on whoever is speaking
                dur: 4.6, eval: (u, o) => this._speakerShot(u, o, 2.5, 0.85, 36)
            },
            {   // 3. low tracking shot across the squad toward the objective
                dur: 3.2, eval: (u, o) => {
                    o.pos.copy(p).addScaledVector(right, 3.4 - u * 1.6).addScaledVector(toObj, 2.5);
                    o.pos.y = ground(o.pos.x, o.pos.z) + 0.45;
                    o.look.copy(p).addScaledVector(toObj, 14).addScaledVector(right, -1.5);
                    o.look.y = ground(o.look.x, o.look.z) + 1.6;
                    o.fov = 44;
                }
            },
            {   // 4. push into the player's eyes, matching the gameplay camera
                dur: 1.8, blendToGame: true, eval: (u, o) => {
                    const cam = ctx.gameCamera;
                    cam.updateWorldMatrix(true, false);
                    const eye = cam.getWorldPosition(new THREE.Vector3());
                    const fwd = cam.getWorldDirection(new THREE.Vector3());
                    const start = p.clone().addScaledVector(toObj, -3.5).addScaledVector(right, 1.2);
                    start.y = eye.y + 0.8;
                    const k = smooth(u);
                    o.pos.lerpVectors(start, eye, k);
                    o.look.lerpVectors(p.clone().addScaledVector(toObj, 10).setY(eye.y), eye.clone().addScaledVector(fwd, 10), k);
                    o.fov = THREE.MathUtils.lerp(44, cam.fov, k);
                }
            }
        ];
        this._begin('SPACE / CLICK — SKIP');
        if (ctx.title) {
            this.titleEl.innerHTML = `<div style="font-size:12px;opacity:.7;margin-bottom:.6em">${escapeHtml(ctx.title.code)} // ${escapeHtml(ctx.title.region)}</div>`
                + `<div style="font-size:30px;font-weight:600">${escapeHtml(ctx.title.title)}</div>`;
            setTimeout(() => { if (this.active && this.mode === 'intro') this.titleEl.style.opacity = '1'; }, 700);
            setTimeout(() => { this.titleEl.style.opacity = '0'; }, 3900);
        }
    }

    /** Free cinematic view that keeps cycling shots until toggled off. */
    startFree(ctx) {
        this.ctx = ctx;
        this.mode = 'free';
        const p = () => ctx.playerPos;
        const ground = (x, z) => (ctx.heightAt ? ctx.heightAt(x, z) : p().y);
        const centroid = () => {
            const alive = (ctx.squad ? ctx.squad.members : []).filter(m => m.isAlive);
            const c = p().clone();
            alive.forEach(m => c.add(m.position));
            return c.multiplyScalar(1 / (alive.length + 1));
        };
        this._freeShots = [
            {   dur: 9, eval: (u, o) => {      // slow wide orbit around the squad
                const c = centroid(), a = this.time * 0.09;
                o.pos.set(c.x + Math.sin(a) * 9, 0, c.z + Math.cos(a) * 9);
                o.pos.y = ground(o.pos.x, o.pos.z) + 3.2;
                o.look.copy(c).setY(c.y + 1.1); o.fov = 42;
            } },
            {   dur: 6, eval: (u, o) => this._speakerShot(u, o, 2.2, -0.8, 34) },
            {   dur: 7, eval: (u, o) => {      // low hero angle
                const c = centroid(), a = 1.9 + u * 0.35;
                o.pos.set(c.x + Math.sin(a) * 3.8, 0, c.z + Math.cos(a) * 3.8);
                o.pos.y = ground(o.pos.x, o.pos.z) + 0.35;
                o.look.copy(c).setY(c.y + 1.5); o.fov = 48;
            } },
            {   dur: 7, eval: (u, o) => {      // high crane, rising
                const c = centroid();
                o.pos.set(c.x - 12 + u * 4, 0, c.z + 10);
                o.pos.y = ground(o.pos.x, o.pos.z) + 7 + u * 5;
                o.look.copy(c).setY(c.y + 0.5); o.fov = 40;
            } }
        ];
        this.shots = this._freeShots;
        this._begin('H — EXIT CINEMATIC VIEW');
    }

    _begin(hint) {
        this.active = true;
        this.shotIndex = 0;
        this.shotTime = 0;
        this.time = 0;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this._showOverlay(true, hint);
        this._eval(0);
        this.camera.position.copy(this._pos);
        this.camera.lookAt(this._look);
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        this.mode = null;
        this.ctx = null;
        this._showOverlay(false);
    }

    /** Cut to whoever starts talking (free mode) or bias the next close-up (intro). */
    onDialogue(d) {
        if (!this.active) return;
        this.subEl.innerHTML = `<span style="color:#e8a33d;letter-spacing:.2em;margin-right:.8em">${escapeHtml(d.speaker)}</span>${escapeHtml(d.text)}`;
        this.subEl.style.opacity = '1';
        this._subTimer = String(d.text || '').length * 0.055 + 1.8;
        if (!this.ctx || !this.ctx.squad) return;
        const m = this.ctx.squad.getMember(String(d.speaker || ''));
        if (!m || !m.isAlive) return;
        this.speaker = m;
        if (this.mode === 'free' && this.shotIndex !== 1) { this.shotIndex = 1; this.shotTime = 0; }
    }

    _speakerShot(u, o, dist, side, fov) {
        const squad = this.ctx.squad;
        const alive = squad ? squad.members.filter(m => m.isAlive) : [];
        const m = (this.speaker && this.speaker.isAlive) ? this.speaker : alive[0];
        if (!m) { o.pos.copy(this.ctx.playerPos).add(new THREE.Vector3(2, 1.6, 2)); o.look.copy(this.ctx.playerPos).setY(this.ctx.playerPos.y + 1.4); o.fov = fov; return; }
        const yaw = m.group.rotation.y;
        const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
        const rt = fwd.clone().cross(UP).normalize();
        const head = m.position.clone().setY(m.position.y + 1.58);
        o.pos.copy(head).addScaledVector(fwd, dist - u * 0.45).addScaledVector(rt, side);
        o.pos.y = head.y - 0.05;
        o.look.copy(head).addScaledVector(rt, side * 0.25);
        o.fov = fov;
    }

    _eval(dt) {
        const shot = this.shots[this.shotIndex];
        const o = { pos: this._pos, look: this._look, fov: 40 };
        shot.eval(Math.min(1, this.shotTime / shot.dur), o);
        this._fov = o.fov;
        this._blend = !!shot.blendToGame;
    }

    /** Returns false once the intro has finished. */
    update(dt) {
        if (!this.active) return false;
        this.time += dt;
        this.shotTime += dt;
        if (this._subTimer > 0) { this._subTimer -= dt; if (this._subTimer <= 0) this.subEl.style.opacity = '0'; }
        const shot = this.shots[this.shotIndex];
        if (this.shotTime >= shot.dur) {
            if (this.mode === 'intro' && this.shotIndex === this.shots.length - 1) return false;
            this.shotIndex = (this.shotIndex + 1) % this.shots.length;
            this.shotTime = 0;
        }
        this._eval(dt);
        // handheld drift (fades out as the intro hands control to the player)
        const fade = this._blend ? 1 - smooth(this.shotTime / this.shots[this.shotIndex].dur) : 1;
        const t = this.time;
        this.camera.position.copy(this._pos);
        this.camera.position.x += (Math.sin(t * 0.9) * 0.03 + Math.sin(t * 2.3) * 0.008) * fade;
        this.camera.position.y += (Math.sin(t * 1.3 + 1) * 0.025) * fade;
        this.camera.lookAt(this._look);
        this.camera.rotation.z += Math.sin(t * 0.7) * 0.008 * fade;
        this.camera.aspect = window.innerWidth / window.innerHeight;
        if (Math.abs(this.camera.fov - this._fov) > 0.01 || this._aspect !== this.camera.aspect) {
            this.camera.fov = this._fov;
            this._aspect = this.camera.aspect;
            this.camera.updateProjectionMatrix();
        }
        return true;
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
