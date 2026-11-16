/**
 * Tactical minimap (top-right): player-centred, rotates with the view, 15 Hz redraw.
 *
 * The level layout (building footprints, obstacles, play-area edge) is rendered ONCE per level
 * into an offscreen canvas from the colliders the level already has; each frame only that bitmap
 * is blitted with a rotation and the markers are drawn on top:
 *   white arrow  you        green dots  squad        red dots  enemies you have spotted
 *   (in combat with you, or very close)               yellow diamond  current objective,
 *   pinned to the rim with a distance readout when it is off the map.
 * Touch / mobile: same map, slightly smaller; tap it to toggle a zoomed-out view.
 */
const RANGE = 48;           // metres from centre to rim (zoomed in)
const RANGE_FAR = 110;

export class MiniMap {
    constructor() {
        const wrap = this.el = document.createElement('div');
        wrap.id = 'minimap';
        wrap.innerHTML = '<canvas></canvas><div class="mm-n">N</div><div class="mm-dist"></div>';
        (document.getElementById('hud') || document.body).appendChild(wrap);
        this.canvas = wrap.querySelector('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.north = wrap.querySelector('.mm-n');
        this.dist = wrap.querySelector('.mm-dist');
        this.layer = null;
        this.acc = 1;
        this.range = RANGE;
        wrap.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.range = this.range === RANGE ? RANGE_FAR : RANGE; this.acc = 1; });
        this._resize();
        window.addEventListener('resize', () => this._resize());
    }

    _resize() {
        const css = this.el.clientWidth || 168;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.size = css; this.canvas.width = this.canvas.height = Math.round(css * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Build the static layer for a level (colliders: Box3[], bounds: half-size in metres). */
    setLevel(level) {
        const b = (level.bounds || 90) + 25, N = 768, k = N / (2 * b);
        const c = document.createElement('canvas'); c.width = c.height = N;
        const x = c.getContext('2d');
        x.fillStyle = 'rgba(32,36,34,0.92)'; x.fillRect(0, 0, N, N);
        // faint 10 m grid for distance judgement
        x.strokeStyle = 'rgba(255,255,255,0.05)'; x.lineWidth = 1;
        for (let m = -b; m <= b; m += 10) { const p = (m + b) * k; x.beginPath(); x.moveTo(p, 0); x.lineTo(p, N); x.moveTo(0, p); x.lineTo(N, p); x.stroke(); }
        // play-area edge
        const pb = (level.bounds || 90);
        x.strokeStyle = 'rgba(214,170,90,0.35)'; x.lineWidth = 2;
        x.strokeRect((b - pb) * k, (b - pb) * k, 2 * pb * k, 2 * pb * k);
        for (const box of level.colliders || []) {
            const w = (box.max.x - box.min.x), d = (box.max.z - box.min.z), h = box.max.y - box.min.y;
            if (w > 2 * b || d > 2 * b || h < 0.6) continue;
            const tall = h > 3;
            x.fillStyle = tall ? 'rgba(150,154,150,0.85)' : 'rgba(110,112,104,0.7)';
            x.fillRect((box.min.x + b) * k, (box.min.z + b) * k, Math.max(1.5, w * k), Math.max(1.5, d * k));
            if (tall) { x.strokeStyle = 'rgba(220,224,218,0.6)'; x.lineWidth = 1; x.strokeRect((box.min.x + b) * k, (box.min.z + b) * k, w * k, d * k); }
        }
        this.layer = c; this.layerB = b; this.layerK = k;
        this.acc = 1;
    }

    clear() { this.layer = null; }

    /**
     * s: { pos, yaw, squad: [{x,z,down}], enemies: [{x,z,spotted}], objective: {x,z}|null }
     * yaw: player heading (radians, three.js convention: 0 = looking down -Z).
     */
    update(dt, s) {
        this.acc += dt;
        if (this.acc < 1 / 15 || !this.layer) return;
        this.acc = 0;
        const g = this.ctx, S = this.size, R = S / 2, scale = R / this.range;
        g.clearRect(0, 0, S, S);
        g.save();
        g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.clip();
        g.fillStyle = 'rgba(20,22,21,0.9)'; g.fillRect(0, 0, S, S);
        // world -> map: rotate so the view direction points up
        g.translate(R, R);
        g.rotate(s.yaw);
        const toMap = (wx, wz) => [(wx - s.pos.x) * scale, (wz - s.pos.z) * scale];
        const lk = this.layerK, lb = this.layerB;
        const px = (s.pos.x + lb) * lk, pz = (s.pos.z + lb) * lk, src = this.range * lk;
        g.drawImage(this.layer, px - src, pz - src, src * 2, src * 2, -R, -R, R * 2, R * 2);
        // squad and enemies (counter-rotated dots are round, so no per-marker rotation needed)
        for (const m of s.squad || []) {
            const [mx, mz] = toMap(m.x, m.z);
            g.fillStyle = m.down ? '#c9a24a' : '#5fd27a';
            g.beginPath(); g.arc(mx, mz, 3.6, 0, Math.PI * 2); g.fill();
        }
        for (const e of s.enemies || []) {
            if (!e.spotted) continue;
            const [ex, ez] = toMap(e.x, e.z);
            if (ex * ex + ez * ez > (R - 4) * (R - 4)) continue;
            g.fillStyle = '#ff4b3e';
            g.beginPath(); g.arc(ex, ez, 3.6, 0, Math.PI * 2); g.fill();
        }
        // objective: diamond, pinned to the rim when far away
        let far = false;
        if (s.objective) {
            let [ox, oz] = toMap(s.objective.x, s.objective.z);
            const d = Math.hypot(ox, oz), lim = R - 9;
            if (d > lim) { ox *= lim / d; oz *= lim / d; far = true; }
            g.save(); g.translate(ox, oz); g.rotate(-s.yaw + Math.PI / 4);
            g.fillStyle = '#f2c14e'; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1.5;
            g.fillRect(-4.5, -4.5, 9, 9); g.strokeRect(-4.5, -4.5, 9, 9);
            g.restore();
        }
        g.restore();
        // player arrow (always up) and rim
        g.save(); g.translate(R, R);
        g.fillStyle = '#ffffff'; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.stroke();
        g.restore();
        g.strokeStyle = 'rgba(232,226,210,0.35)'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.stroke();
        // north marker orbits the rim
        // world north (-Z) after the map rotation
        this.north.style.transform = `translate(${Math.sin(s.yaw) * (R - 9)}px, ${-Math.cos(s.yaw) * (R - 9)}px)`;
        if (s.objective) {
            const d = Math.hypot(s.objective.x - s.pos.x, s.objective.z - s.pos.z);
            this.dist.textContent = far || d > 25 ? `${Math.round(d)} m` : '';
        } else this.dist.textContent = '';
    }

    show() { this.el.style.display = ''; }
    hide() { this.el.style.display = 'none'; }
}
