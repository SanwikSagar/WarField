/**
 * Fully procedural audio engine built on the Web Audio API.
 * There are no audio asset files in this project, so every sound is
 * synthesized at runtime: weapon reports use layered noise bursts through
 * resonant filters, footsteps are short filtered thumps, ambience is
 * evolving noise beds, and the menu theme is a generated drone.
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

        // Convolver reverb for indoor/outdoor spatial character (GDD 8.2)
        this.reverb = this.ctx.createConvolver();
        this.reverb.buffer = this._makeImpulse(2.2, 2.5);
        this.reverbGain = this.ctx.createGain();
        this.reverbGain.gain.value = 0.25;
        this.reverb.connect(this.reverbGain);
        this.reverbGain.connect(this.buses.sfx);

        this._noiseBuffer = this._makeNoise(2.0);
        this.ready = true;
        this.samples = {};
        this._loadSamples();
    }

    // ── recorded CC0 samples (Freesound, see public/assets/audio/sfx/credits.json) ──
    async _loadSamples() {
        const list = { rifle: 3, ak: 2, pistol: 3, distant: 3, magout: 1, magin: 2, charge: 1, slide: 1, dryfire: 1, shell: 1,
            step_grass: 4, step_gravel: 3, step_snow: 1, step_concrete: 1, impact_dirt: 1, impact_metal: 1, explosion: 2, grunt: 1 };
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

    _makeNoise(duration) {
        const len = Math.floor(this.ctx.sampleRate * duration);
        const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
    }

    _makeImpulse(duration, decay) {
        const len = Math.floor(this.ctx.sampleRate * duration);
        const buffer = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
            }
        }
        return buffer;
    }

    _noiseSource() {
        const src = this.ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        src.loop = true;
        return src;
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
            if (this._playSample(name, { gain: (profile.gain ?? 0.9) * att * 1.1, rate: profile.rate || 1, pan: profile.pan || 0, dist, reverb: 0.12 + dist * 0.5, delay: profile.delay || 0 })) return;
        }
        const t = this.ctx.currentTime + (profile.delay || 0);
        const {
            body = 900,      // low-mid thump frequency
            crack = 3200,    // high transient frequency
            decay = 0.28,    // overall length
            gain = 0.9,
            dist = 0,        // 0 = at the listener, 1 = far away
            tail = 0.4,      // length of the lowpassed report echo
            pan = 0          // -1..1 stereo placement (enemy shots)
        } = profile;
        const jitter = 0.93 + Math.random() * 0.14; // per-shot variation
        const distanceAttenuation = Math.pow(1 - dist, 2) * 0.9 + 0.1;

        const out = this.ctx.createGain();
        out.gain.value = gain * distanceAttenuation;

        // Distance dulls the shot (highs roll off) — a strong depth cue.
        const distFilter = this.ctx.createBiquadFilter();
        distFilter.type = 'lowpass';
        distFilter.frequency.value = Math.max(1200, 17000 - dist * 13000);
        distFilter.Q.value = 0.4;
        out.connect(distFilter);

        // Stereo placement (own weapon stays centered; enemies get panned).
        let tailNode = distFilter;
        if (this.ctx.createStereoPanner) {
            const panner = this.ctx.createStereoPanner();
            panner.pan.value = Math.max(-1, Math.min(1, pan || (dist > 0.15 ? (Math.random() - 0.5) * 1.2 : 0)));
            distFilter.connect(panner);
            panner.connect(this.buses.sfx);
            tailNode = panner;
        } else {
            distFilter.connect(this.buses.sfx);
        }

        // Reverb send grows with distance (far shots are mostly tail/space).
        const send = this.ctx.createGain();
        send.gain.value = 0.15 + dist * 0.5;
        tailNode.connect(send);
        send.connect(this.reverb);

        // Layer 1 — sub body thump (pitched sine sweep down)
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(body * 1.35 * jitter, t);
        osc.frequency.exponentialRampToValueAtTime(body * 0.32, t + decay);
        const oscGain = this.ctx.createGain();
        oscGain.gain.setValueAtTime(0.0001, t);
        oscGain.gain.exponentialRampToValueAtTime(0.85, t + 0.005);
        oscGain.gain.exponentialRampToValueAtTime(0.001, t + decay);
        osc.connect(oscGain); oscGain.connect(out);
        osc.start(t); osc.stop(t + decay + 0.02);

        // Layer 2 — mid crack (bandpassed noise)
        const crackSrc = this._noiseSource();
        const crackFilter = this.ctx.createBiquadFilter();
        crackFilter.type = 'bandpass';
        crackFilter.frequency.value = crack * jitter * (1 - dist * 0.4);
        crackFilter.Q.value = 0.9;
        const crackGain = this.ctx.createGain();
        crackGain.gain.setValueAtTime(1.0, t);
        crackGain.gain.exponentialRampToValueAtTime(0.001, t + decay * 0.55);
        crackSrc.connect(crackFilter); crackFilter.connect(crackGain); crackGain.connect(out);
        crackSrc.start(t); crackSrc.stop(t + decay);

        // Layer 3 — high snap transient (very short, adds "bite")
        const snapSrc = this._noiseSource();
        const snapFilter = this.ctx.createBiquadFilter();
        snapFilter.type = 'highpass';
        snapFilter.frequency.value = 5200;
        const snapGain = this.ctx.createGain();
        snapGain.gain.setValueAtTime(0.6 * (1 - dist * 0.7), t);
        snapGain.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
        snapSrc.connect(snapFilter); snapFilter.connect(snapGain); snapGain.connect(out);
        snapSrc.start(t); snapSrc.stop(t + 0.04);

        // Layer 4 — lowpassed report tail (the "boom" that lingers)
        const tailSrc = this._noiseSource();
        const tailFilter = this.ctx.createBiquadFilter();
        tailFilter.type = 'lowpass';
        tailFilter.frequency.setValueAtTime(1400 * (1 - dist * 0.5), t);
        tailFilter.frequency.exponentialRampToValueAtTime(300, t + tail);
        const tailGain = this.ctx.createGain();
        tailGain.gain.setValueAtTime(0.0001, t);
        tailGain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
        tailGain.gain.exponentialRampToValueAtTime(0.001, t + tail);
        tailSrc.connect(tailFilter); tailFilter.connect(tailGain); tailGain.connect(out);
        tailSrc.start(t); tailSrc.stop(t + tail + 0.02);
    }

    /** Supersonic round passing close by: sharp crack + short zip, heard before the distant report. */
    playBulletCrack(volume = 0.5, pan = 0) {
        if (!this.ready) return;
        const t = this.ctx.currentTime;
        const out = this.ctx.createGain();
        out.gain.value = volume;
        let node = out;
        if (this.ctx.createStereoPanner) {
            const p = this.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
            out.connect(p); node = p;
        }
        node.connect(this.buses.sfx);
        const src = this._noiseSource();
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.setValueAtTime(6500, t);
        hp.frequency.exponentialRampToValueAtTime(1800, t + 0.09);
        hp.Q.value = 1.4;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1.0, t + 0.002);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
        src.connect(hp); hp.connect(g); g.connect(out);
        src.start(t); src.stop(t + 0.13);
    }

    /** Dry mechanical click for reloads, weapon switches, empty mags. */
    playMechanical(kind = 'click') {
        if (!this.ready) return;
        const map = { magOut: 'magout', magIn: 'magin', bolt: 'charge', slide: 'slide', click: 'dryfire', clack: 'charge' };
        if (map[kind] && this._playSample(map[kind], { gain: kind === 'clack' ? 0.35 : 0.8, reverb: 0.04 })) return;
        const t = this.ctx.currentTime;
        const src = this._noiseSource();
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        const gain = this.ctx.createGain();

        const presets = {
            click: { freq: 2200, q: 3, dur: 0.05, vol: 0.4 },
            clack: { freq: 1400, q: 2, dur: 0.08, vol: 0.5 },
            magOut: { freq: 900, q: 1.5, dur: 0.12, vol: 0.45 },
            magIn: { freq: 1600, q: 2, dur: 0.1, vol: 0.55 },
            bolt: { freq: 2600, q: 4, dur: 0.07, vol: 0.5 }
        };
        const p = presets[kind] || presets.click;
        filter.frequency.value = p.freq;
        filter.Q.value = p.q;
        gain.gain.setValueAtTime(p.vol, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + p.dur);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.buses.sfx);
        src.start(t);
        src.stop(t + p.dur + 0.02);
    }

    /** Footstep: a low thump layered with a surface-dependent scuff, with
     *  per-step pitch/timing variation so walking doesn't sound machine-gunned. */
    playFootstep(surface = 'dirt', volume = 0.3) {
        if (!this.ready) return;
        const fmap = { grass: 'step_grass', dirt: 'step_gravel', snow: 'step_snow', concrete: 'step_concrete', metal: 'step_concrete' };
        if (this._playSample(fmap[surface] || 'step_grass', { gain: volume * 1.6, reverb: 0.03 })) return;
        const t = this.ctx.currentTime;
        const v = volume * (0.85 + Math.random() * 0.3);

        const surfaces = {
            dirt:     { freq: 620,  dur: 0.13, thump: 130 },
            concrete: { freq: 1500, dur: 0.08, thump: 190 },
            metal:    { freq: 2600, dur: 0.11, thump: 240 },
            snow:     { freq: 4200, dur: 0.15, thump: 110 },
            grass:    { freq: 2100, dur: 0.11, thump: 150 }
        };
        const s = surfaces[surface] || surfaces.dirt;

        // Scuff (surface character)
        const src = this._noiseSource();
        src.playbackRate.value = 0.85 + Math.random() * 0.3;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = s.freq * (0.9 + Math.random() * 0.2);
        filter.Q.value = 0.7;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(v * 0.5, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + s.dur);
        src.connect(filter); filter.connect(gain); gain.connect(this.buses.sfx);
        src.start(t); src.stop(t + s.dur + 0.02);

        // Thump (weight/impact)
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(s.thump * (0.9 + Math.random() * 0.2), t);
        osc.frequency.exponentialRampToValueAtTime(s.thump * 0.5, t + 0.09);
        const og = this.ctx.createGain();
        og.gain.setValueAtTime(v * 0.7, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(og); og.connect(this.buses.sfx);
        osc.start(t); osc.stop(t + 0.12);
    }

    /** Bullet impact: a sharp tick plus a short material body thud. */
    playImpact(volume = 0.3, surface = 'dirt') {
        if (!this.ready) return;
        if (this._playSample(surface === 'metal' ? 'impact_metal' : 'impact_dirt', { gain: volume * 1.4, rate: 1.1, reverb: 0.1 })) return;
        const t = this.ctx.currentTime;
        const v = volume * (0.8 + Math.random() * 0.4);
        // Tick
        const src = this._noiseSource();
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1800 + Math.random() * 800;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(v, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
        src.connect(filter); filter.connect(gain); gain.connect(this.buses.sfx);
        src.start(t); src.stop(t + 0.08);
        // Body
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320 + Math.random() * 120, t);
        osc.frequency.exponentialRampToValueAtTime(120, t + 0.07);
        const og = this.ctx.createGain();
        og.gain.setValueAtTime(v * 0.5, t);
        og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        osc.connect(og); og.connect(this.buses.sfx);
        osc.start(t); osc.stop(t + 0.09);
    }

    /** Enemy hit / death vocal-ish grunt. */
    playGrunt(volume = 0.4) {
        if (!this.ready) return;
        if (this._playSample('grunt', { gain: volume * 1.2, rate: 0.85 + Math.random() * 0.3, reverb: 0.1 })) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180 + Math.random() * 40, t);
        osc.frequency.exponentialRampToValueAtTime(90, t + 0.18);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.buses.sfx);
        osc.start(t);
        osc.stop(t + 0.22);
    }

    /** Explosion: big low noise burst with long tail. */
    playExplosion(volume = 1.0) {
        if (!this.ready) return;
        if (this._playSample('explosion', { gain: volume, reverb: 0.4 })) return;
        const t = this.ctx.currentTime;
        const src = this._noiseSource();
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1200, t);
        filter.frequency.exponentialRampToValueAtTime(120, t + 1.2);
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.buses.sfx);
        gain.connect(this.reverb);
        src.start(t);
        src.stop(t + 1.5);
    }

    /** Looping environmental ambience bed, built from layered noise bands so
     *  rain/wind feel like a space rather than a single static hiss. */
    startAmbience(kind = 'wind', volume = 0.15) {
        if (!this.ready) return;
        this.stopAmbience();
        const file = { rain: 'amb_rain_0', snow: 'amb_snow_0', wind: 'amb_wind_0', forest: 'amb_forest_0' }[kind];
        const token = (this._ambToken = (this._ambToken || 0) + 1);
        if (file) {
            this._ambBufs = this._ambBufs || {};
            const go = (buf) => {
                if (token !== this._ambToken || !buf) return;
                this.stopAmbience();
                const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
                const g = this.ctx.createGain(); const t = this.ctx.currentTime;
                const filter = this.ctx.createBiquadFilter();
                filter.type = 'highpass'; filter.frequency.value = kind === 'rain' ? 140 : 45; filter.Q.value = 0.35;
                g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(volume * 3.2, t + 2);
                src.connect(filter); filter.connect(g); g.connect(this.buses.ambience); src.start(0, Math.random() * buf.duration);
                this._ambienceNodes = [src, filter, g];
            };
            if (this._ambBufs[file]) { go(this._ambBufs[file]); return; }
            this._fetchBuffer(`/assets/audio/sfx/${file}.mp3`).then(b => { this._ambBufs[file] = b; go(b); });
        }
        const nodes = [];
        const t = this.ctx.currentTime;

        const addLayer = (type, freq, q, gainVal, lfoFreq, lfoDepth) => {
            const src = this._noiseSource();
            const filter = this.ctx.createBiquadFilter();
            filter.type = type;
            filter.frequency.value = freq;
            filter.Q.value = q;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(gainVal, t + 1.5); // gentle fade-in
            src.connect(filter); filter.connect(g); g.connect(this.buses.ambience);
            src.start();
            nodes.push(src, g);
            if (lfoDepth > 0) {
                const lfo = this.ctx.createOscillator();
                lfo.frequency.value = lfoFreq;
                const lfoGain = this.ctx.createGain();
                lfoGain.gain.value = lfoDepth;
                lfo.connect(lfoGain); lfoGain.connect(filter.frequency);
                lfo.start();
                nodes.push(lfo);
            }
        };

        if (kind === 'rain') {
            addLayer('highpass', 1200, 0.5, volume * 0.5, 0.0, 0);      // broad hiss
            addLayer('bandpass', 3200, 0.6, volume * 0.7, 0.35, 500);   // patter
        } else if (kind === 'snow') {
            addLayer('lowpass', 700, 0.6, volume * 0.8, 0.1, 220);       // soft wind
            addLayer('bandpass', 2600, 0.5, volume * 0.25, 0.05, 400);  // faint hiss
        } else { // wind
            addLayer('lowpass', 480, 0.7, volume * 0.9, 0.08, 200);
            addLayer('bandpass', 900, 0.9, volume * 0.3, 0.13, 300);
        }
        this._ambienceNodes = nodes;
    }

    stopAmbience() {
        this._ambienceNodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
        this._ambienceNodes = [];
    }

    /** Cinematic menu / story drone. Minor, restrained (GDD 8.3). */
    startMusic(intensity = 'menu') {
        if (!this.ready) return;
        this.stopMusic();
        const t = this.ctx.currentTime;
        const master = this.ctx.createGain();
        master.gain.value = 0.0;
        master.gain.setTargetAtTime(0.35, t, 2.0);
        master.connect(this.buses.music);

        const roots = { menu: [55, 82.4, 110], combat: [49, 73.4, 98] };
        const freqs = roots[intensity] || roots.menu;
        const nodes = [master];

        freqs.forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            osc.type = i === 0 ? 'sawtooth' : 'sine';
            osc.frequency.value = f;
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 400 + i * 200;
            const g = this.ctx.createGain();
            g.gain.value = i === 0 ? 0.12 : 0.2;
            // Slow detune drift for a living pad
            const lfo = this.ctx.createOscillator();
            lfo.frequency.value = 0.05 + i * 0.03;
            const lfoGain = this.ctx.createGain();
            lfoGain.gain.value = 1.5;
            lfo.connect(lfoGain);
            lfoGain.connect(osc.detune);
            osc.connect(filter);
            filter.connect(g);
            g.connect(master);
            osc.start();
            lfo.start();
            nodes.push(osc, lfo);
        });

        this._musicNodes = nodes;
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
    }

    /** Short UI confirmation blip. */
    playUI(kind = 'hover') {
        if (!this.ready) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        const gain = this.ctx.createGain();
        const freqs = { hover: 660, select: 880, back: 440 };
        osc.frequency.setValueAtTime(freqs[kind] || 660, t);
        gain.gain.setValueAtTime(0.0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.connect(gain);
        gain.connect(this.buses.sfx);
        osc.start(t);
        osc.stop(t + 0.14);
    }
}

export const audio = new AudioManager();
