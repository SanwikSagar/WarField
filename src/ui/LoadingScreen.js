/**
 * Loading screen: full-bleed key art that changes every few seconds with a blood-splash morph.
 *
 * How the transition works (and why it keeps moving while a level is being built):
 *   - A random blood-splatter shape (SVG: lobed blob, long thin spikes, flung droplets) is generated per
 *     transition and used as a CSS mask on the reveal layer.
 *   - The reveal layer scales up from the splash centre (transform), while the next image inside it is
 *     counter-scaled by exactly the inverse, so the SPLASH grows but the picture stays still.
 *   - A dark-red copy of the splash leads the reveal and thins out, so it reads as blood that soaks
 *     outward and turns into the next scene.
 *   - Everything is a transform / opacity animation (Web Animations API), which the browser runs on the
 *     compositor thread: the morph stays smooth even while the main thread is busy building the level.
 * Memory: only the current and next images are referenced; every timer and animation is cancelled on hide().
 */
const IMAGES = [
    { src: '/assets/ui/loading/city-dusk.webp', caption: 'VEYRA CITY · DUSK', biomes: ['city', 'deadzone'] },
    { src: '/assets/ui/loading/battlefield-dawn.webp', caption: 'THE FRONT · DAWN', biomes: ['dustland', 'wildlands'] },
    { src: '/assets/ui/loading/locket-mud.webp', caption: 'WHAT THEY LEFT BEHIND', biomes: ['frostland'] },
    { src: '/assets/ui/loading/relics-gold.webp', caption: 'RELICS OF THE WAR', biomes: [] }
];
const TIPS = [
    'Crouch behind cover to reload. Enemies flank when you stay in one place too long.',
    'Aim down sights for accuracy: rounds fired from the hip spread wide.',
    'Suppressed enemies duck and miss. Keep the pressure on before you move.',
    'Your squad follows your lead. Push forward and they cover the flanks.',
    'Bodies, wrecks and craters are cover too. Use the battlefield.',
    'Intel pickups reveal more of the story. Look around buildings and wrecks.',
    'Headshots end a fight fast, but the torso is a bigger target under pressure.',
    'Sprinting lowers your weapon. Stop before you round a corner.',
    'The minimap only shows enemies who are fighting you or very close.',
    'Your progress saves automatically at every objective.'
];
const HOLD = 4.2, MORPH = 1.45;            // seconds per image / transition length
const SPLASH_VMAX = 26;                     // splash size at scale 1, in vmax

let seed = Date.now() % 9973;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

/** Random blood splatter as an SVG data URL (white on transparent: used as an alpha mask). */
function splashSVG() {
    const pts = [], N = 34;
    for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        let r = 38 + rnd() * 10 + Math.sin(a * 3 + rnd()) * 4;
        if (rnd() < 0.28) r += 18 + rnd() * 30;                  // spikes
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    // smooth closed curve through the points (quadratic midpoints)
    let d = '';
    for (let i = 0; i < N; i++) {
        const p = pts[i], q = pts[(i + 1) % N], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        d += (i === 0 ? `M${m[0].toFixed(1)},${m[1].toFixed(1)}` : '') + `Q${q[0].toFixed(1)},${q[1].toFixed(1)} ${((q[0] + pts[(i + 2) % N][0]) / 2).toFixed(1)},${((q[1] + pts[(i + 2) % N][1]) / 2).toFixed(1)}`;
    }
    let drops = '';
    for (let i = 0; i < 16; i++) {
        const a = rnd() * Math.PI * 2, r = 55 + rnd() * 40, s = 1.5 + rnd() * 5;
        drops += `<circle cx="${(Math.cos(a) * r).toFixed(1)}" cy="${(Math.sin(a) * r).toFixed(1)}" r="${s.toFixed(1)}"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200"><g fill="#fff"><path d="${d}Z"/>${drops}</g></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

export class LoadingScreen {
    constructor() {
        this.el = null; this.timer = 0; this.anims = []; this.index = 0; this.next = null; this.cur = null; this.tipT = 0;
    }

    /** Show (or retitle) the loading screen. opts.biome picks a fitting first image. */
    show(text = '', { biome = null } = {}) {
        let el = document.getElementById('loading-screen');
        if (el && el.classList.contains('fade-out')) { el.remove(); el = null; }     // never reuse one that is leaving
        if (!el) { el = document.createElement('div'); el.id = 'loading-screen'; document.body.appendChild(el); }
        if (!el.querySelector('.ld-stage')) {
            el.innerHTML = `
                <div class="ld-stage"><div class="ld-img ld-base"></div><div class="ld-blood"></div><div class="ld-reveal"><div class="ld-img ld-next"></div></div></div>
                <div class="ld-shade"></div>
                <div class="ld-top"><div class="loading-logo">WARFIELD</div><div class="ld-caption" id="ld-caption"></div></div>
                <div class="ld-bottom">
                    <div class="ld-tip"><span>TIP</span><p id="ld-tip"></p></div>
                    <div class="loading-status" id="loading-status"></div>
                    <div class="loading-bar"><div class="loading-fill" id="loading-fill"></div></div>
                </div>`;
        }
        el.classList.remove('fade-out');
        this.el = el;
        this.base = el.querySelector('.ld-base'); this.blood = el.querySelector('.ld-blood');
        this.reveal = el.querySelector('.ld-reveal'); this.nextImg = el.querySelector('.ld-next');
        this.status(text);
        const fill = el.querySelector('#loading-fill'); if (fill) fill.style.width = '8%';
        // first image: one that suits the level, then cycle through the rest
        const pick = biome ? IMAGES.findIndex(i => i.biomes.includes(biome)) : -1;
        this.index = pick >= 0 ? pick : Math.floor(Math.random() * IMAGES.length);
        this._setBase(IMAGES[this.index]);
        this._tip();
        this._schedule();
        return el;
    }

    status(text) { const s = this.el && this.el.querySelector('#loading-status'); if (s && text != null) { s.textContent = text; s.style.color = ''; } }
    progress(p) { const f = this.el && this.el.querySelector('#loading-fill'); if (f) f.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`; }

    /** Fade out and release everything (timers, animations, image references). */
    hide(delay = 0) {
        const el = this.el;
        this._stop();
        this.el = null;
        if (!el) return;
        const go = () => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 650); };
        if (delay) setTimeout(go, delay); else go();
    }

    // ── internals ──
    _stop() {
        clearTimeout(this.timer); this.timer = 0;
        clearInterval(this.tipT); this.tipT = 0;
        this.anims.forEach(a => a.cancel()); this.anims = [];
        if (this.next) { this.next.src = ''; this.next = null; }
        this.cur = null;
    }
    _alive() { return this.el && this.el.isConnected && !this.el.classList.contains('fade-out'); }

    _setBase(img) {
        this.base.style.backgroundImage = `url("${img.src}")`;
        const c = this.el.querySelector('#ld-caption'); if (c) c.textContent = img.caption;
        this.cur = img;
    }

    _tip() {
        const t = this.el.querySelector('#ld-tip');
        const show = () => { if (!this._alive()) { clearInterval(this.tipT); return; } t.textContent = TIPS[Math.floor(Math.random() * TIPS.length)]; };
        show();
        clearInterval(this.tipT); this.tipT = setInterval(show, 6500);
    }

    _schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this._morph(), HOLD * 1000);
    }

    async _morph() {
        if (!this._alive()) { this._stop(); return; }
        const ni = (this.index + 1) % IMAGES.length, img = IMAGES[ni];
        // decode before animating so the reveal never shows a blank frame
        const pre = this.next = new Image();
        pre.src = img.src;
        try { await pre.decode(); } catch (e) { /* show it anyway */ }
        if (!this._alive()) { this._stop(); return; }

        const W = innerWidth, H = innerHeight, vmax = Math.max(W, H) / 100;
        const px = W * (0.3 + Math.random() * 0.4), py = H * (0.3 + Math.random() * 0.4);
        const size = SPLASH_VMAX * vmax;
        const mask = splashSVG();
        for (const layer of [this.reveal, this.blood]) {
            layer.style.webkitMaskImage = layer.style.maskImage = mask;
            layer.style.webkitMaskSize = layer.style.maskSize = `${size}px ${size}px`;
            layer.style.webkitMaskPosition = layer.style.maskPosition = `${px - size / 2}px ${py - size / 2}px`;
            layer.style.transformOrigin = `${px}px ${py}px`;
        }
        this.nextImg.style.transformOrigin = `${px}px ${py}px`;
        this.nextImg.style.backgroundImage = `url("${img.src}")`;

        // exponential growth feels like liquid spreading; the inner image gets the exact inverse at every keyframe
        const smax = (Math.hypot(W, H) * 2.4) / size, s0 = 0.03, K = 24;
        const ease = (t) => 1 - Math.pow(1 - t, 2.2);
        const outer = [], inner = [], blood = [];
        for (let i = 0; i <= K; i++) {
            const t = i / K, s = s0 * Math.pow(smax / s0, ease(t));
            outer.push({ offset: t, transform: `scale(${s})` });
            inner.push({ offset: t, transform: `scale(${1 / s})` });
            const sb = s0 * Math.pow(smax / s0, ease(Math.min(1, t * 1.25))) * 1.08;
            blood.push({ offset: t, transform: `scale(${sb})`, opacity: t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.4) });
        }
        const dur = MORPH * 1000, opt = { duration: dur, fill: 'forwards', easing: 'linear' };
        this.reveal.style.visibility = 'visible'; this.blood.style.visibility = 'visible';
        this.anims.forEach(a => a.cancel());
        this.anims = [this.reveal.animate(outer, opt), this.nextImg.animate(inner, opt), this.blood.animate(blood, opt)];
        try { await this.anims[0].finished; } catch (e) { return; }      // cancelled by hide()
        if (!this._alive()) { this._stop(); return; }
        this._setBase(img);
        this.index = ni;
        this.anims.forEach(a => a.cancel()); this.anims = [];
        this.reveal.style.visibility = 'hidden'; this.blood.style.visibility = 'hidden';
        if (this.next) { this.next.src = ''; this.next = null; }
        this._schedule();
    }
}

export const loadingScreen = new LoadingScreen();
