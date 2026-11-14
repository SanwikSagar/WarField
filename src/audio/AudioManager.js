/**
 * Sample-based audio engine on the Web Audio API. Every sound the player
 * hears is a recorded CC0 asset from Freesound (credits in
 * public/assets/audio/sfx/credits.json, fetch more with
 * tools/fetch-cc0-audio.mjs); nothing is synthesized. Web Audio only mixes,
 * pans, filters for distance and adds convolution reverb.
 *
 * Volumes are split into master/music/sfx/ambience buses so the settings
 * menu can adjust each independently (GDD 11.11).
 */
export class AudioManager {
    constructor() {
        this.ctx = null;
        this.ready = false;
        this.volumes = { master: 0.8, music: 0.5, sfx: 0.9, ambience: 0.6 };
        this.buses = {};
        this._ambienceNodes = [];
        this._musicNodes = [];
        this._noiseBuffer = null;
        this._ambienceBus = null;
        this._ambienceDuckTimer = null;
    }

    /** Must be called from a user gesture to satisfy autoplay policies. */
    init() {
        if (this.ready) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();

        this.buses.master = this.ctx.createGain();
        this.buses.master.gain.value = this.volumes.master;
        // Bus glue + safety limiter: layered gunshots and explosions sum hot,
        // so a fast compressor tames peaks instead of letting them clip harshly.
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -14;
        this.limiter.knee.value = 8;
        this.limiter.ratio.value = 7;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.2;
        this.buses.master.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);

        for (const name of ['music', 'sfx', 'ambience']) {
            const g = this.ctx.createGain();
            g.gain.value = this.volumes[name];
            g.connect(this.buses.master);
            this.buses[name] = g;
        }
        // A dedicated ambience stage lets combat briefly sit forward in the
        // mix without stopping the environmental bed or creating extra voices.
        this._ambienceBus = this.ctx.createGain();
        this._ambienceBus.gain.value = 1;
        this._ambienceBus.connect(this.buses.ambience);

        // Convolver reverb built from a recorded CC0 impulse response (ir_city_0.mp3, a street canyon
        // between residential blocks). Dry until it has loaded.
        this.reverb = this.ctx.createConvolver();
        this.reverbGain = this.ctx.createGain();
        this.reverbGain.gain.value = 0.25;
        this.reverb.connect(this.reverbGain);
        this.reverbGain.connect(this.buses.sfx);

        this.ready = true;
        this.samples = {};
        this._loadSamples();
        this._fetchBuffer('/assets/audio/sfx/ir_city_0.mp3').then(b => { if (b) this.reverb.buffer = b; });
    }

    // ── recorded CC0 samples (Freesound, see public/assets/audio/sfx/credits.json) ──
    async _loadSamples() {
        const list = { rifle: 3, ak: 2, pistol: 3, distant: 3, magout: 1, magin: 2, charge: 1, slide: 1, dryfire: 1, shell: 1,
            step_grass: 4, step_gravel: 3, step_snow: 2, step_concrete: 3, impact_dirt: 1, impact_metal: 2, impact_concrete: 1, impact_flesh: 1,
            explosion: 2, grunt: 1, whiz: 2, radio_on: 2, radio_off: 2, radio_static: 1, ui_hover: 1, ui_select: 1, ui_back: 1,
            whoosh: 2, boom: 1, sting: 1,
            thunder: 4, bird: 2, crow: 2, wind_gust: 2, creak: 2, distant_blast: 2 };
        await Promise.all(Object.entries(list).map(async ([name, n]) => {
            const bufs = [];
            for (let i = 0; i < n; i++) {
                const b = await this._fetchBuffer(`/assets/audio/sfx/${name}_${i}.mp3`);
                if (b) bufs.push(b);
            }
            if (bufs.length) this.samples[name] = bufs;
        }));
    }
    async _fetchBuffer(url) {
        try {
            const r = await fetch(url);
            if (!r.ok) return null;
            return await this.ctx.decodeAudioData(await r.arrayBuffer());
        } catch (e) { return null; }
    }
    /** play a random variant of a sample; returns false if not loaded */
    _playSample(name, { gain = 1, rate = 1, pan = 0, dist = 0, reverb = 0.15, delay = 0, bus = 'sfx' } = {}) {
        const list = this.samples && this.samples[name];
        if (!this.ready || !list || !list.length) return false;
        const t = this.ctx.currentTime + delay;
        const src = this.ctx.createBufferSource();
        src.buffer = list[Math.floor(Math.random() * list.length)];
        src.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
        const g = this.ctx.createGain();
        g.gain.value = gain;
        let node = src;
        if (dist > 0) {
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = Math.max(900, 16000 - dist * 14000);
            node.connect(lp); node = lp;
        }
        node.connect(g);
        let out = g;
        if (this.ctx.createStereoPanner && pan) {
            const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
            g.connect(p); out = p;
        }
        out.connect(this.buses[bus]);
        if (reverb > 0) { const s = this.ctx.createGain(); s.gain.value = reverb; out.connect(s); s.connect(this.reverb); }
        src.start(t);
        return true;
    }

    /** brass hitting the ground a moment after a shot */
    playShell(volume = 0.25) {
        this._playSample('shell', { gain: volume, rate: 1, delay: 0.35 + Math.random() * 0.25, reverb: 0.05 });
    }

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    setVolume(bus, value) {
        this.volumes[bus] = value;
        if (this.buses[bus]) {
            this.buses[bus].gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
        }
    }

    /**
     * Weapon report. `profile` tunes the character per weapon class so each
     * gun has a distinct sound (GDD 5.2 / 8.2). Built from four layers —
     * a sub body thump, a mid crack, a high snap transient, and a lowpassed
     * report tail — run through a distance lowpass and a stereo spread so
     * shots feel physical and directional rather than flat clicks.
     */
    playGunshot(profile = {}) {
        if (!this.ready) return;
        {
            const dist = profile.dist || 0;
            let name = profile.sample || (profile.body >= 1200 ? 'pistol' : profile.body < 800 ? 'ak' : 'rifle');
            if (dist > 0.55 && this.samples && this.samples.distant) name = 'distant';
            const att = Math.pow(1 - Math.min(dist, 1), 2) * 0.9 + 0.1;
            if (dist < 0.35) this._duckAmbience(0.7, 0.24);
            if (this._playSample(name, { gain: (profile.gain ?? 0.9) * att * 1.1, rate: profile.rate || 1, pan: profile.pan || 0, dist, reverb: 0.12 + dist * 0.5, delay: profile.delay || 0 })) return;
        }
    }

    /** Supersonic round passing close by: sharp crack + short zip, heard before the distant report. */
    playBulletCrack(volume = 0.5, pan = 0) {
        if (!this.ready) return;
        if (!this._playSample('whiz', { gain: volume * 0.9, pan, reverb: 0.08 })) this._playSample('distant', { gain: volume * 0.45, rate: 1.15, pan, reverb: 0.18 });
    }

    /** Dry mechanical click for reloads, weapon switches, empty mags. */
    playMechanical(kind = 'click') {
        if (!this.ready) return;
        const map = { magOut: 'magout', magIn: 'magin', bolt: 'charge', slide: 'slide', click: 'dryfire', clack: 'charge' };
        if (map[kind]) this._playSample(map[kind], { gain: kind === 'clack' ? 0.35 : 0.8, reverb: 0.04 });
    }

    /** Footstep: a low thump layered with a surface-dependent scuff, with
     *  per-step pitch/timing variation so walking doesn't sound machine-gunned. */
    playFootstep(surface = 'dirt', volume = 0.3) {
        if (!this.ready) return;
        const fmap = { grass: 'step_grass', dirt: 'step_gravel', snow: 'step_snow', concrete: 'step_concrete', metal: 'step_concrete' };
        this._playSample(fmap[surface] || 'step_grass', { gain: volume * 1.6, reverb: 0.03 });
    }

    /** Bullet impact: a sharp tick plus a short material body thud. */
    playImpact(volume = 0.3, surface = 'dirt') {
        if (!this.ready) return;
        const name = { metal: 'impact_metal', concrete: 'impact_concrete', flesh: 'impact_flesh' }[surface] || 'impact_dirt';
        if (!this._playSample(name, { gain: volume * 1.4, rate: 1.05, reverb: 0.1 })) this._playSample('impact_dirt', { gain: volume * 1.4, rate: 1.1, reverb: 0.1 });
    }

    /** Enemy hit / death vocal-ish grunt. */
    playGrunt(volume = 0.4) {
        if (!this.ready) return;
        this._playSample('grunt', { gain: volume * 1.2, rate: 0.85 + Math.random() * 0.3, reverb: 0.1 });
    }

    /**
     * Thunder: a recorded CC0 rumble, delayed after the flash like real sound travel
     * (`distance` 0 = overhead, 1 = far), low-passed and wetter the further away it is.
     */
    playThunder({ distance = 0.6, gain = 0.8, delay = null } = {}) {
        if (!this.ready) return;
        this._duckAmbience(0.6, 1.4);
        this._playSample('thunder', {
            gain: gain * (1.15 - distance * 0.55), rate: 1, dist: distance * 0.75, reverb: 0.25 + distance * 0.3,
            delay: delay ?? (0.4 + distance * 3.2), bus: 'ambience'
        });
    }

    /**
     * Random recorded one-shots that make each level sound alive (crows, wind gusts, creaking
     * metal, distant fighting). Timers are cleared by stopAmbience().
     */
    startEvents(biome) {
        this.stopEvents();
        const table = AMBIENT_EVENTS[biome];
        if (!this.ready || !table) return;
        const token = this._eventToken = (this._eventToken || 0) + 1;
        this._eventTimers = [];
        for (const ev of table) {
            const loop = () => {
                if (token !== this._eventToken) return;
                const wait = (ev.every[0] + Math.random() * (ev.every[1] - ev.every[0])) * 1000;
                this._eventTimers.push(setTimeout(() => {
                    if (token !== this._eventToken) return;
                    if (ev.fn === 'thunder') this.playThunder({ distance: 0.35 + Math.random() * 0.6, gain: ev.gain });
                    else this._playSample(ev.sample, { gain: ev.gain, rate: ev.rate || 1, pan: (Math.random() * 2 - 1) * 0.9,
                        dist: ev.dist ?? 0.4, reverb: ev.reverb ?? 0.35, bus: 'ambience' });
                    loop();
                }, wait));
            };
            // first event sooner so a level never starts silent
            this._eventTimers.push(setTimeout(() => { if (token === this._eventToken) { loop(); } }, 1500 + Math.random() * 3000));
        }
    }

    stopEvents() {
        this._eventToken = (this._eventToken || 0) + 1;
        (this._eventTimers || []).forEach(clearTimeout);
        this._eventTimers = [];
    }

    /** Explosion: big low noise burst with long tail. */
    playExplosion(volume = 1.0) {
        if (!this.ready) return;
        this._duckAmbience(0.52, 0.55);
        this._playSample('explosion', { gain: volume, reverb: 0.4 });
    }

    /** Looping environmental ambience bed using CC0 recordings. */
    startAmbience(kind = 'wind', volume = 0.15) {
        if (!this.ready) return;
        this.stopAmbience();
        const file = { rain: 'amb_rain_0', snow: 'amb_snow_0', wind: 'amb_wind_0', forest: 'amb_forest_0', city: 'amb_city_0' }[kind];
        // second recorded layer: wind under the forest, distant sirens over the city
        const layer = { city: ['siren_0', 0.22], forest: ['amb_wind_0', 0.35] }[kind];
        const token = (this._ambToken = (this._ambToken || 0) + 1);
        if (file) {
            this._ambBufs = this._ambBufs || {};
            const go = (buf) => {
                if (token !== this._ambToken || !buf) return;
                this._stopBeds();
                const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
                const g = this.ctx.createGain(); const t = this.ctx.currentTime;
                const filter = this.ctx.createBiquadFilter();
                filter.type = 'highpass'; filter.frequency.value = kind === 'rain' ? 140 : 45; filter.Q.value = 0.35;
                g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(volume * 3.2, t + 2);
                src.connect(filter); filter.connect(g); g.connect(this._ambienceBus); src.start(0, Math.random() * buf.duration);
                this._ambienceNodes = [src, filter, g];
                this._ambienceGain = g;
                if (layer) {
                    const add = (lb) => {
                        if (token !== this._ambToken || !lb) return;
                        const s2 = this.ctx.createBufferSource(); s2.buffer = lb; s2.loop = true;
                        const g2 = this.ctx.createGain(); g2.gain.value = volume * 3.2 * layer[1];
                        s2.connect(g2); g2.connect(g); s2.start(0, Math.random() * lb.duration);
                        this._ambienceNodes.push(s2, g2);
                    };
                    if (this._ambBufs[layer[0]]) add(this._ambBufs[layer[0]]);
                    else this._fetchBuffer(`/assets/audio/sfx/${layer[0]}.mp3`).then(b => { this._ambBufs[layer[0]] = b; add(b); });
                }
            };
            if (this._ambBufs[file]) { go(this._ambBufs[file]); return; }
            this._fetchBuffer(`/assets/audio/sfx/${file}.mp3`).then(b => { this._ambBufs[file] = b; go(b); });
            return;
        }
        return;
    }

    stopAmbience() {
        this.stopEvents();
        this._stopBeds();
    }

    /** Fade out just the looping beds (the async load callback must not cancel the one-shot event timers). */
    _stopBeds() {
        const nodes = this._ambienceNodes;
        const gain = this._ambienceGain;
        if (gain && this.ctx) {
            const t = this.ctx.currentTime;
            gain.gain.cancelScheduledValues(t);
            gain.gain.setTargetAtTime(0.0001, t, 0.12);
            setTimeout(() => nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} }), 700);
        } else {
            nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
        }
        this._ambienceNodes = [];
        this._ambienceGain = null;
    }

    _duckAmbience(level, duration) {
        if (!this._ambienceBus || !this.ctx) return;
        const t = this.ctx.currentTime;
        const target = Math.max(0.35, Math.min(1, level));
        this._ambienceBus.gain.cancelScheduledValues(t);
        this._ambienceBus.gain.setTargetAtTime(target, t, 0.012);
        clearTimeout(this._ambienceDuckTimer);
        this._ambienceDuckTimer = setTimeout(() => {
            if (!this._ambienceBus || !this.ctx) return;
            const now = this.ctx.currentTime;
            this._ambienceBus.gain.cancelScheduledValues(now);
            this._ambienceBus.gain.setTargetAtTime(1, now, 0.18);
        }, duration * 1000);
    }

    /** Looping CC0 music bed: 'menu' (melancholic theme) or 'tension' (cinematics / debrief). */
    startMusic(intensity = 'menu') {
        if (!this.ready) return;
        const file = { menu: 'music_menu_0', tension: 'music_tension_0' }[intensity] || 'music_menu_0';
        if (this._musicFile === file && this._musicNodes.length) return;
        this.stopMusic();
        this._musicFile = file;
        const token = (this._musicToken = (this._musicToken || 0) + 1);
        this._musicBufs = this._musicBufs || {};
        const go = (buf) => {
            if (token !== this._musicToken || !buf) return;
            const g = this.ctx.createGain(); const t = this.ctx.currentTime;
            g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.55, t + 3);
            const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
            src.connect(g); g.connect(this.buses.music); src.start();
            this._musicNodes = [g, src];
        };
        if (this._musicBufs[file]) go(this._musicBufs[file]);
        else this._fetchBuffer(`/assets/audio/sfx/${file}.mp3`).then(b => { this._musicBufs[file] = b; go(b); });
    }

    /** Cinematic accents: 'whoosh' (cuts/title wipe), 'boom' (title hit), 'sting' (episode end). */
    playCinematic(kind = 'whoosh', gain = 0.6) {
        if (!this.ready) return;
        this._playSample(kind, { gain, reverb: kind === 'boom' ? 0.3 : 0.12, bus: 'music' });
    }

    stopMusic() {
        if (!this.ready) return;
        const t = this.ctx.currentTime;
        const master = this._musicNodes[0];
        if (master && master.gain) {
            master.gain.setTargetAtTime(0.0, t, 0.4);
            const nodes = this._musicNodes;
            setTimeout(() => {
                nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
            }, 1200);
        }
        this._musicNodes = [];
        this._musicFile = null;
        this._musicToken = (this._musicToken || 0) + 1;
    }

    /** Comms for the dialogue system (recorded): 'open'/'close' radio squelch, 'chirp' = no sound for in-person lines. */
    playRadio(kind = 'open') {
        if (!this.ready || kind === 'chirp') return;
        this._playSample(kind === 'open' ? 'radio_on' : 'radio_off', { gain: kind === 'open' ? 0.32 : 0.28, reverb: 0 });
        if (kind === 'open') this._playSample('radio_static', { gain: 0.05, rate: 1.2, reverb: 0 });
    }

    /** Short UI confirmation blip. */
    playUI(kind = 'hover') {
        if (!this.ready) return;
        const sample = { hover: 'ui_hover', select: 'ui_select', back: 'ui_back' }[kind] || 'ui_select';
        this._playSample(sample, { gain: kind === 'hover' ? 0.18 : 0.32, reverb: 0 });
    }
}

/**
 * Per-level one-shot events (recorded CC0 samples from /assets/audio/sfx).
 * every = [min, max] seconds between plays; dist = distance low-pass 0..1.
 */
const AMBIENT_EVENTS = {
    wildlands: [
        { fn: 'thunder', every: [22, 48], gain: 0.7 },
        { sample: 'crow', every: [20, 45], gain: 0.5, dist: 0.5 },
        { sample: 'distant', every: [40, 80], gain: 0.4, dist: 0.9, reverb: 0.6 },
        { sample: 'creak', every: [30, 60], gain: 0.25, dist: 0.6 }
    ],
    dustland: [
        { sample: 'wind_gust', every: [14, 30], gain: 0.5, dist: 0.2, reverb: 0.1 },
        { sample: 'distant_blast', every: [35, 70], gain: 0.55, dist: 0.85, reverb: 0.6 },
        { sample: 'crow', every: [30, 60], gain: 0.4, dist: 0.6 },
        { sample: 'creak', every: [25, 50], gain: 0.3, dist: 0.5 }
    ],
    frostland: [
        { sample: 'wind_gust', every: [10, 22], gain: 0.7, dist: 0.15, reverb: 0.1 },
        { sample: 'creak', every: [18, 40], gain: 0.4, dist: 0.4 },
        { sample: 'distant_blast', every: [60, 110], gain: 0.4, dist: 0.95, reverb: 0.7 }
    ],
    deadzone: [
        { sample: 'distant', every: [10, 24], gain: 0.5, dist: 0.8, reverb: 0.5 },
        { sample: 'distant_blast', every: [28, 60], gain: 0.6, dist: 0.8, reverb: 0.6 },
        { sample: 'creak', every: [16, 34], gain: 0.4, dist: 0.4 },
        { sample: 'wind_gust', every: [20, 40], gain: 0.35, dist: 0.2 }
    ],
    city: [
        { sample: 'distant', every: [7, 18], gain: 0.55, dist: 0.7, reverb: 0.7 },
        { sample: 'distant_blast', every: [24, 50], gain: 0.65, dist: 0.8, reverb: 0.8 },
        { sample: 'crow', every: [18, 40], gain: 0.45, dist: 0.5, reverb: 0.5 },
        { sample: 'creak', every: [14, 30], gain: 0.4, dist: 0.4, reverb: 0.5 },
        { sample: 'wind_gust', every: [20, 40], gain: 0.3, dist: 0.2 }
    ]
};

export const audio = new AudioManager();
