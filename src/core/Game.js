import * as THREE from '/node_modules/three/build/three.module.js';
import { SceneManager } from './SceneManager.js';
import { Renderer } from './Renderer.js';
import { detectGPUTier } from './Renderer.js';
import { InputManager } from './InputManager.js';
import { CameraManager } from './CameraManager.js';
import { Player } from '../player/Player.js';
import { EnemyAI } from '../ai/EnemyAI.js';
import { SquadManager } from '../squad/SquadManager.js';
import { MissionManager } from '../missions/MissionManager.js';
import { HUDManager } from '../ui/HUDManager.js';
import { MainMenu } from '../ui/MainMenu.js';
import { UINav } from '../ui/UINav.js';
import { MenuScene } from '../ui/MenuScene.js';
import { SettingsMenu } from '../ui/SettingsMenu.js';
import { PauseMenu } from '../ui/PauseMenu.js';
import { MissionComplete } from '../ui/MissionComplete.js';
import { audio } from '../audio/AudioManager.js';
import { saveManager } from '../save/SaveManager.js';
import { globalEvents } from './EventManager.js';
import { MISSIONS } from '../environments/biomes.js';
import { loadPhotoAssets } from '../environments/PhotoAssets.js';
import { initLoaders } from '../environments/AssetLoaders.js';
import { loadCharacters } from './CharacterFactory.js';
import { loadWeaponModels } from '../weapons/WeaponModels.js';
import { loadPropModels } from '../environments/PropModels.js';
import { BIOMES } from '../environments/biomes.js';
import { CinematicCamera } from './CinematicCamera.js';
import { DialogueSystem } from '../story/DialogueSystem.js';
import { animation } from '../animation/AnimationSystem.js';
import { bakeStaticShadows } from '../render/ShadowBake.js';
import { Platform } from './Platform.js';
import { cloud } from '../save/CloudSave.js';
import { loadingScreen } from '../ui/LoadingScreen.js';
import { MiniMap } from '../ui/MiniMap.js';
import { occlusion, updateViewCone, viewCone } from '../render/Occlusion.js';
import { loadCivilians, trimCivilianModels, Civilians } from '../ai/Civilians.js';
import { TouchControls } from '../ui/TouchControls.js';
import { buildReflectionProbe } from '../render/ReflectionProbe.js';
import { loadWarModels, warIds, WAR_TEXTURES } from '../environments/WarModels.js';
import { getScript, SEASON, UPCOMING, formatRelease } from '../story/Story.js';

/** Opening location stamp typed under each episode title. */
const LOCATIONS = {
    1: 'NORTHERN WILDLANDS  —  05:42 LOCAL',
    2: 'DUSTLAND SUPPLY ROUTE  —  13:15 LOCAL',
    3: 'FROSTLAND RESEARCH SITE  —  21:08 LOCAL',
    4: 'DEADZONE, SECTOR 9  —  16:30 LOCAL',
    5: 'COMMUNICATIONS HQ  —  23:31 LOCAL',
    6: 'VEYRA CITY, MARKET DISTRICT  —  18:47 LOCAL'
};

/**
 * Top-level game orchestrator and state machine (GDD 11.4). States:
 *   BOOT -> MENU -> BRIEFING -> PLAYING <-> PAUSED -> COMPLETE / FAILED
 * Owns the loop, wires every subsystem together, routes settings changes to
 * live systems, and handles mission start/complete/fail and persistence.
 */
const STATE = { BOOT: 'boot', MENU: 'menu', BRIEFING: 'briefing', LOADING: 'loading', CINEMATIC: 'cinematic', PLAYING: 'playing', PAUSED: 'paused', COMPLETE: 'complete', FAILED: 'failed' };

export class Game {
    constructor() {
        this.state = STATE.BOOT;
        this.renderer = new Renderer();
        this.cameraManager = new CameraManager();
        this.sceneManager = new SceneManager();
        this.inputManager = new InputManager();

        this.audio = audio;
        this.animation = animation;   // central animation system (also handy from the console)
        this.lastTime = performance.now();
        this.animate = this.animate.bind(this);

        this.enemies = [];
        this.pendingMission = null;
        this._buildToken = 0;
        this.currentDifficulty = saveManager.settings.difficulty || 'regular';

        // Menu backdrop lives in its own scene + camera
        this.menuThreeScene = new THREE.Scene();
        this.menuCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
    }

    async initialize() {
        saveManager.load();
        this._applySavedSettings();
        // cloud save: merged progress arrives asynchronously, so refresh whatever shows it
        globalEvents.on('save_applied', () => { if (this.mainMenu) this.mainMenu.refresh(); });
        cloud.init().catch(e => console.warn('Cloud save unavailable:', e));      // no-op unless Firebase is configured

        this.sceneManager.initialize();
        this.renderer.initialize(this.sceneManager.getScene(), this.cameraManager.getCamera());
        // Apply the saved (or auto-detected) quality preset — the renderer
        // boots at its own default, so without this the GPU tier is ignored.
        this.renderer.applyQuality(saveManager.settings.quality);
        initLoaders(this.renderer.renderer);   // KTX2 / Draco
        const canvas = this.renderer.getDomElement();
        const container = document.getElementById('canvas-container');
        if (container) container.appendChild(canvas);
        this.inputManager.initialize(canvas);

        // Menu backdrop
        this.menuScene = new MenuScene(this.menuThreeScene);
        this.renderer.setScene(this.menuThreeScene, this.menuCamera);
        this.renderer.setExposure(this.menuScene.exposure);

        // UI controllers
        this.uiNav = new UINav();
        this.cinematic = new CinematicCamera();
        this.dialogue = new DialogueSystem({ audio: this.audio });
        this.hud = new HUDManager();
        this.minimap = new MiniMap();
        this.culling = { occlusion, viewCone };            // debug handle (console / tests)
        if (Platform.touch) {
            this.touch = new TouchControls(this.inputManager, { onPause: () => this.pause(), getLookScale: () => saveManager.settings.touchLook ?? 1 });
            this.inputManager.touchOnly = Platform.mobile;
        }
        this.settingsMenu = new SettingsMenu({ audio: this.audio });
        this.mainMenu = new MainMenu({
            audio: this.audio,
            onStartMission: (id, diff) => this.startMission(id, diff),
            onExit: () => this._exit()
        });
        this.pauseMenu = new PauseMenu({
            audio: this.audio,
            onResume: () => this.resume(),
            onSettings: () => { this.mainMenu.returnTo = 'pause'; this.mainMenu.show('settings'); this.state = STATE.PAUSED; },
            onRestart: () => this.restartCheckpoint(),
            onAbort: () => this.abortToMenu(),
            onFullscreen: () => this.toggleFullscreen()
        });
        // pause whenever the game loses the player: tab hidden, window blurred, or mouse released
        document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === STATE.PLAYING) this.pause(); });
        window.addEventListener('blur', () => { if (this.state === STATE.PLAYING && !Platform.touch) this.pause(); });
        document.addEventListener('pointerlockchange', () => {
            if (!document.pointerLockElement && this.state === STATE.PLAYING && !Platform.touch && performance.now() - (this._resumedAt || 0) > 400) this.pause();
        });
        this.missionComplete = new MissionComplete({
            audio: this.audio,
            onNext: () => this._nextMission(),
            onMenu: () => this.abortToMenu()
        });

        this.missionManager = new MissionManager({
            getPlayerPos: () => (this.player ? this.player.getEyePosition() : null),
            audio: this.audio,
            onComplete: (result) => this._onMissionComplete(result),
            onFail: () => this._onMissionFailed(),
            onObjective: (index, obj, mission) => this._onStoryBeat(index, obj, mission)
        });

        this._bindGlobalEvents();
        this._hideLoading();

        // Create the AudioContext only during a user gesture to satisfy autoplay policies.
        const unlock = () => {
            this.audio.init();
            this.audio.resume();
            this.audio.startMusic('menu');
            this.audio.startAmbience('rain', 0.12);
            window.removeEventListener('pointerdown', unlock, true);
            window.removeEventListener('keydown', unlock, true);
        };
        window.addEventListener('pointerdown', unlock, { capture: true });
        window.addEventListener('keydown', unlock, { capture: true });

        this.state = STATE.MENU;
        requestAnimationFrame(this.animate);
        console.log('%cWARFIELD: Operation Blackout — systems online.', 'color:#e8a33d;font-weight:bold');
    }

    _applySavedSettings() {
        const s = saveManager.settings;
        // On the very first launch, pick a quality preset that matches the
        // detected GPU so integrated graphics don't stall during play. Once
        // the player has chosen a preset, we respect their saved choice.
        if (!saveManager.settingsFromStorage) {
            const tier = Platform.mobile ? 'low' : detectGPUTier();      // phones start on the mobile budget
            s.quality = tier;
            if (tier === 'low') s.filmGrain = 0.0;
        }
        if (!saveManager.settingsFromStorage) s.fpsCap = s.quality === 'low' || Platform.mobile ? '30' : '60';
        this.setFrameCap(s.fpsCap);
        this.inputManager.sensitivity = 0.0022 * (s.sensitivity || 1);
        this.inputManager.invertY = !!s.invertY;
        this.cameraManager.shakeIntensity = s.screenShake ?? 1;
        this.cameraManager.setFOV(s.fov || 75);
        this.cameraManager.baseFOV = s.fov || 75;
    }

    _bindGlobalEvents() {
        // Settings applied live
        globalEvents.on('setting_changed', ({ key, value }) => this._onSetting(key, value));

        // Gunfire alerts AI + squad to the player's position
        globalEvents.on('weapon_fired', () => {
            if (!this.player) return;
            const pos = this.player.weapons.getMuzzleWorldPosition();
            this.enemies.forEach(e => e.hearSound(pos, 2.2));
            if (this.squad) this.squad.hearSound(pos);
        });

        // Footsteps make noise when sprinting
        globalEvents.on('footstep', (d) => {
            if (d.sprinting) this.enemies.forEach(e => e.hearSound(d.position, 0.8));
        });

        // One AI spotting the player alerts others nearby
        globalEvents.on('ai_alert', (d) => {
            this.enemies.forEach(e => {
                if (e !== d.source && e.isAlive && e.position.distanceTo(d.position) < 40) {
                    e.lastKnownPlayerPos = d.position.clone();
                    if (e.state === 'PATROL') e._setState('SUSPICIOUS');
                }
            });
        });

        // Player damage -> renderer red pulse + audio
        globalEvents.on('player_damage', (d) => {
            this.renderer.setDamage(Math.min(1, (1 - d.current / d.max) * 0.9));
            this.cameraManager.addShake(0.25);
            this.cameraManager.addRecoil(0.012 + Math.random() * 0.01, (Math.random() - 0.5) * 0.025);   // flinch
        });
        globalEvents.on('player_heal', () => this.renderer.setDamage(0));
        globalEvents.on('player_health_regen', (d) => {
            this.renderer.setDamage(Math.min(1, (1 - d.current / d.max) * 0.7));
        });

        globalEvents.on('player_death', () => this._onPlayerDeath());
        globalEvents.on('near_miss', (d) => {
            if (this.state !== STATE.PLAYING) return;
            this.suppression = Math.min(1.4, (this.suppression || 0) + 0.18 + d.amount * 0.3);
            this.cameraManager.addShake(0.05 + d.amount * 0.1);
        });
        globalEvents.on('player_land', (d) => {
            // hard landings hurt: ~4 m drop (impact ~9 m/s) and up
            if (this.player && d.impact > 11) this.player.health.takeDamage((d.impact - 11) * 9, new THREE.Vector3(0, -1, 0));
            if (this.audio) this.audio.playFootstep(this.player ? this.player.movement.surface : 'dirt', Math.min(0.7, 0.3 + d.impact * 0.02));
        });
        globalEvents.on('menu_show', () => { this.renderer.setDamage(0); });
        globalEvents.on('dialogue', (d) => {
            if (this.squad) this.squad.onDialogue(d);
            if (this.cinematic) this.cinematic.onDialogue(d);
        });
    }

    _onSetting(key, value) {
        const s = saveManager.settings;
        switch (key) {
            case 'quality':
                this.renderer.applyQuality(value);
                if (this.sceneManager.level && this.sceneManager.level.sky) this._bakeShadows(this.sceneManager.level);
                break;
            case 'fpsCap':
                this.setFrameCap(value);
                break;
            case 'fov':
                this.cameraManager.baseFOV = value;
                this.cameraManager.setFOV(value);
                if (this.player) this.player.weapons.setBaseFOV(value);
                break;
            case 'sensitivity':
                this.inputManager.sensitivity = 0.0022 * value;
                break;
            case 'invertY':
                this.inputManager.invertY = value;
                break;
            case 'screenShake':
                this.cameraManager.shakeIntensity = value;
                break;
            case 'filmGrain':
                this.renderer.setGrain(value ? 0.022 : 0.0);
                break;
            case 'masterVolume': this.audio.setVolume('master', value); break;
            case 'musicVolume': this.audio.setVolume('music', value); break;
            case 'sfxVolume': this.audio.setVolume('sfx', value); break;
            case 'ambienceVolume': this.audio.setVolume('ambience', value); break;
        }
    }

    /** '30' | '60' | 'unlimited'. Drives frame pacing and the adaptive-resolution target. */
    setFrameCap(cap) {
        const fps = cap === '30' || cap === 30 ? 30 : cap === 'unlimited' ? 0 : 60;
        this.frameInterval = fps ? 1000 / fps : 0;
        this._lastPresent = 0;
        if (this.renderer) this.renderer.targetFrameMs = this.frameInterval || 1000 / 60;
    }

    _hideLoading() {
        loadingScreen.progress(1); loadingScreen.hide(400); return;
        const ls = document.getElementById('loading-screen');
        const fill = document.getElementById('loading-fill');
        if (fill) fill.style.width = '100%';
        setTimeout(() => {
            if (ls) { ls.classList.add('fade-out'); setTimeout(() => ls.remove(), 700); }
        }, 400);
    }

    // ── MISSION LIFECYCLE ───────────────────────────────────────────────
    /** Fullscreen + landscape lock (needs a user gesture: called from clicks / taps). */
    toggleFullscreen(force) {
        const want = force ?? !document.fullscreenElement;
        try {
            if (want && !document.fullscreenElement) {
                const p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
                if (p && p.then) p.then(() => { if (Platform.mobile && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); }).catch(() => {});
            } else if (!want && document.fullscreenElement) document.exitFullscreen().catch(() => {});
        } catch (e) { /* not supported (iOS Safari): the game still runs windowed */ }
    }

    startMission(missionId, difficulty, { intro = true } = {}) {
        if (saveManager.settings.fullscreen ?? Platform.mobile) this.toggleFullscreen(true);     // deploy click is a user gesture
        this.currentDifficulty = difficulty || this.currentDifficulty;
        const mission = MISSIONS.find(m => m.id === missionId) || MISSIONS[0];
        this.pendingMission = mission;
        this._playIntro = intro;
        this.mainMenu.hideAll();
        this._showLoadingFor(`DEPLOYING TO ${mission.region.toUpperCase()}...`);
        // Newest request wins: builds are serialized and stale ones bail out between steps, so a
        // double click, restart or abort during loading can't tear down a level mid-build.
        const token = ++this._buildToken;
        clearTimeout(this._buildStartTimer);
        // Defer heavy build a frame so the loading text paints
        this._buildStartTimer = setTimeout(() => {
            this._buildChain = (this._buildChain || Promise.resolve()).catch(() => {})
                .then(() => (token === this._buildToken ? this._buildMission(mission, token) : null))
                .catch(err => this._onBuildFailed(err, token));
        }, 60);
    }

    _onBuildFailed(err, token) {
        console.error('Mission build failed:', err);
        if (token !== this._buildToken) return;
        {
            const msg = String(err && err.message || err);
            if (/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(msg) && !sessionStorage.getItem('wf-chunk-reload')) {
                sessionStorage.setItem('wf-chunk-reload', '1');
                location.reload();
                return;
            }
            const st = document.getElementById('loading-status');
            if (st) {
                st.textContent = `FAILED TO BUILD LEVEL — ${msg.slice(0, 140).toUpperCase()}`;
                st.style.color = '#d64545';
            }
            // don't strand the player on the loading screen
            setTimeout(() => {
                if (this.state !== STATE.LOADING || token !== this._buildToken) return;
                const ls = document.getElementById('loading-screen');
                if (ls) ls.remove();
                this._loadingEl = null;
                this.abortToMenu();
            }, 6000);
        }
    }

    _showLoadingFor(text) {
        this._loadingEl = loadingScreen.show(text, { biome: this.pendingMission && this.pendingMission.biome });
        const fl0 = document.getElementById('loading-fill'); if (fl0) fl0.style.width = '30%';
        return;
        // (legacy path below kept unreachable)
        let ls = document.getElementById('loading-screen');
        // a fading overlay is about to be removed by its own timer; never reuse it
        if (ls && ls.classList.contains('fade-out')) { ls.remove(); ls = null; }
        if (!ls) {
            ls = document.createElement('div');
            ls.id = 'loading-screen';
            ls.innerHTML = `<div class="loading-logo">WARFIELD</div><div class="loading-bar"><div class="loading-fill" id="loading-fill"></div></div><div class="loading-status" id="loading-status"></div>`;
            document.body.appendChild(ls);
        }
        ls.classList.remove('fade-out');
        const st = document.getElementById('loading-status');
        const fl = document.getElementById('loading-fill');
        if (st) { st.textContent = text; st.style.color = ''; }
        if (fl) fl.style.width = '30%';
        this._loadingEl = ls;
    }

    async _buildMission(mission, token = this._buildToken) {
        const stale = () => token !== this._buildToken;
        this.state = STATE.LOADING;
        // Tear down any previous mission
        this._clearGameplay();

        const cfg = BIOMES[mission.biome] || {};
        const quality = this.renderer.getSettings();
        const setStage = (text, progress) => {
            loadingScreen.status(text);
            loadingScreen.progress(progress);
        };
        setStage('INITIAL GAME ASSETS', 0.12);
        const civilianModels = mission.biome === 'city' ? ['man', 'woman', 'man2'] : mission.biome === 'deadzone' ? ['man'] : [];
        trimCivilianModels(civilianModels);
        await Promise.all([
            import('../environments/Foliage.js')
                .then(({ loadFoliageAssets }) => loadFoliageAssets(cfg))
                .catch(e => { console.warn('Foliage assets unavailable:', e); }),
            Promise.all([
                loadCharacters(),
                loadWeaponModels(['urgi', 'ak74m', 'g17', 'm5scw']),
                loadPropModels(cfg),
                loadCivilians(civilianModels)
            ])
                .catch(e => { console.warn('Characters/weapons unavailable:', e); }),
            loadWarModels(warIds(cfg)).catch(e => { console.warn('War models unavailable:', e); }),
            loadPhotoAssets([...(cfg.photo || []), ...(cfg.war ? WAR_TEXTURES : [])], quality.loadHDR && cfg.hdr ? cfg.hdr.file : null)
                .catch(e => { console.warn('Photo assets unavailable:', e); })
        ]);
        if (stale()) return;
        setStage('LEVEL LOADING', 0.55);
        await new Promise(r => setTimeout(r, 16)); // let the loading bar paint
        if (stale()) return;

        // Build the level
        const level = await this.sceneManager.loadLevel(mission.biome, { ...quality, renderer: this.renderer.renderer });
        if (stale()) return;
        setStage('LEVEL LOADED - PREPARING GAMEPLAY', 0.75);

        this.renderer.setExposure(level.exposure || 1.2);
        this.renderer.setGrade(cfg.grade);
        this.renderer.setSun(level.sky && level.sky.palette ? level.sky.palette.sunPosition : null, (cfg.grade && cfg.grade.shafts) || 0);

        // Point the renderer at the gameplay scene
        this.renderer.setScene(this.sceneManager.getScene(), this.cameraManager.getCamera());
        // Bake the sun shadows once, before any character exists (no real-time shadow pass after this)
        this._bakeShadows(level);
        this.minimap.setLevel(level);
        occlusion.setOccluders(level.colliders);           // buildings / walls hide what is behind them
        if (level.group) level.group.traverse(o => { if (o.isMesh && o.userData.occludable) occlusion.register(o); });

        // Central animation: fire/smoke/turrets/beacons + every character registers here (before any are created)
        animation.beginLevel({
            scene: this.sceneManager.getScene(), level, audio: this.audio, heightAt: level.heightAt,
            surface: this._surfaceForBiome(mission.biome), lights: this.renderer.quality === 'low' ? 1 : 2
        });

        // Player
        const spawns = level.spawns;
        this.player = new Player(this.cameraManager.getCamera(), this.sceneManager.getScene(), {
            cameraManager: this.cameraManager,
            audio: this.audio,
            difficulty: this.currentDifficulty,
            colliders: level.colliders,
            world: level.world,
            heightAt: level.heightAt,
            getWorld: () => level.world,
            bounds: level.bounds,
            baseFov: saveManager.settings.fov || 75,
            getRaycastables: () => level.raycastables,
            getEnemies: () => (this._cineHoldFire ? [] : this.enemies),   // scripted scenes: squad holds fire
            onEnemyHit: (enemy, dmg, point, headshot) => this._onEnemyHit(enemy, dmg, point, headshot),
            getInteractables: () => this.interactables
        });
        this.player.initialize(spawns.player.clone(), ['asr14', 'ak74', 'm1911']);
        this.player.weapons.effects.quality = this.renderer.getSettings().fx || 1;
        this.player.movement.setSurface(this._surfaceForBiome(mission.biome));

        // Enemies
        this.enemies = [];
        spawns.enemies.forEach((e, ei) => {
            const enemy = new EnemyAI(this.sceneManager.getScene(), {
                characterKind: ei % 2 ? 'soldier' : 'army2',
                getPlayerPos: () => this.player.getEyePosition(),
                getRaycastables: () => level.raycastables,
                getCover: () => level.cover,
                getWorld: () => level.world,
                heightAt: level.heightAt,
                audio: this.audio,
                difficulty: this.currentDifficulty,
                bounds: level.bounds,
                getAudioPan: (worldPos) => this._audioPan(worldPos),
                getPlayerState: () => {
                    const m = this.player ? this.player.movement : null;
                    return m ? { moving: m.isMoving(), sprinting: m.isSprinting(), crouched: m.crouchingFlag } : {};
                },
                getEffects: () => (this.player ? this.player.weapons.effects : null),
                dusty: mission.biome === 'dustland' || mission.biome === 'deadzone',
                onPlayerDamage: (dmg, dir) => {
                    this.player.health.takeDamage(dmg, dir);
                }
            });
            enemy.spawn(e.x, e.z, e.patrol);
            this.enemies.push(enemy);
        });

        // Squad
        this.squad = new SquadManager(this.sceneManager.getScene(), {
            getPlayerPos: () => this.player.getPosition(),
            getEnemies: () => (this._cineHoldFire ? [] : this.enemies),   // scripted scenes: squad holds fire
            getRaycastables: () => level.raycastables,
            getWorld: () => level.world,
            heightAt: level.heightAt,
            audio: this.audio,
            getEffects: () => (this.player ? this.player.weapons.effects : null)
        });
        const formation = [
            new THREE.Vector3(-2.2, 0, 2.5),
            new THREE.Vector3(2.2, 0, 2.5),
            new THREE.Vector3(0, 0, 4)
        ];
        this._formation = formation;
        (mission.squad || spawns.squad).forEach((s, i) => {
            this.squad.addMember(s.name, s, formation[i % formation.length]);
        });

        // Interactables (intel pickups)
        this.interactables = [];
        this._spawnIntel(level, mission);

        // Civilians, medics and the dead (after the animation system exists: bodies bake into its corpse batch)
        try { this.civilians = new Civilians(this.sceneManager.getScene(), level, mission, cfg, () => (this.player ? this.player.getPosition() : new THREE.Vector3())); }
        catch (e) { console.warn('Civilians failed:', e); this.civilians = null; }

        // Mission system
        this.missionManager.startMission(mission.id, level, this.sceneManager.getScene());

        // Audio ambience per biome
        this.audio.startAmbience(level.ambience, 0.14);
        this.audio.startEvents(mission.biome);
        this.audio.stopMusic();

        // Apply live settings to fresh systems
        this.renderer.setGrain(saveManager.settings.filmGrain > 0.001 ? 0.022 : 0);

        // HUD
        this.hud.show();
        document.body.classList.add('in-game');
        this.hud.setIntel(saveManager.campaign.collectedIntel.length);

        setStage('PREPARING GAMEPLAY', 0.88);
        await this._warmupShaders(level);
        if (stale()) return;
        this._buildProbe();
        setStage('REALTIME STREAMING ACTIVE', 1);
        this._missionReadyTimer = setTimeout(() => {
            this._missionReadyTimer = null;
            const overlay = this._loadingEl;
            if (overlay) { loadingScreen.hide(); this._loadingEl = null; }
            if (false) {
                overlay.classList.add('fade-out');
                setTimeout(() => overlay.remove(), 600);
                this._loadingEl = null;
            }
            if (this._playIntro) { this._startCinematic('intro', mission); return; }
            this.dialogue.play(getScript(mission.id).start || []);
            this.state = STATE.PLAYING;
            this.inputManager.requestLock();
            this.resumeMusicCombat();
        }, 350);
    }

    /**
     * Static sun shadows for the whole level: one combined caster mesh, rendered into the shadow map
     * once (render/ShadowBake.js). Re-run only when the quality preset changes the map size.
     */
    _bakeShadows(level) {
        if (!level || !level.sky || !level.sky.sun) return;
        const mapSize = { low: 2048, medium: 2048, high: 4096, ultra: 4096, extreme: 4096 }[this.renderer.quality] || 2048;
        try {
            level.sky.staticShadows = true;
            this._shadowBake = bakeStaticShadows(this.renderer.renderer, this.sceneManager.getScene(), this.cameraManager.getCamera(),
                level.sky.sun, { bounds: level.bounds || 90, mapSize });
        } catch (e) { console.warn('Shadow bake failed:', e); }
    }

    /**
     * Aim assist (setting, on by default): while the crosshair sits on an enemy the look slows down,
     * and starting to aim down sights eases the view onto the nearest enemy inside a small cone.
     * Touch play gets a wider cone and stronger pull. Targets must be fighting you or close, which
     * stands in for line of sight without a raycast.
     */
    _aimAssist(dt) {
        const input = this.inputManager, mv = this.player.movement;
        input.assistScale = 1;
        const adsEdge = input.mouseButtons.right && !this._adsWas;      // (input edges are latched before this runs)
        this._adsWas = input.mouseButtons.right;
        if (saveManager.settings.aimAssist === false || !this.enemies.length) return;
        const eye = this.player.getEyePosition();
        const fx = -Math.sin(mv._lookYaw) * Math.cos(mv._lookPitch), fy = Math.sin(mv._lookPitch), fz = -Math.cos(mv._lookYaw) * Math.cos(mv._lookPitch);
        const touch = !!this.touch;
        let best = null, bestCos = Math.cos((touch ? 9 : 5) * Math.PI / 180);
        for (const e of this.enemies) {
            if (!e.isAlive || !e.group) continue;
            const engaged = e.state === 'COMBAT' || e.state === 'FLANKING';
            const dx = e.group.position.x - eye.x, dy = e.group.position.y + 1.25 - eye.y, dz = e.group.position.z - eye.z;
            const d = Math.hypot(dx, dy, dz);
            if (d > 70 || d < 1 || (!engaged && d > 18)) continue;
            const c = (dx * fx + dy * fy + dz * fz) / d;
            if (c > bestCos) { bestCos = c; best = { dx, dy, dz, d }; }
        }
        if (!best) return;
        const ang = Math.acos(Math.min(1, bestCos)) * 180 / Math.PI;
        if (ang < (touch ? 4 : 2.5)) input.assistScale = touch ? 0.45 : 0.6;
        if (adsEdge) {
            const as = mv.assist || (mv.assist = { t: 0, yaw: 0, pitch: 0, strength: 1 });
            as.yaw = Math.atan2(-best.dx, -best.dz);
            as.pitch = Math.atan2(best.dy, Math.hypot(best.dx, best.dz));
            as.t = 0.22; as.strength = touch ? 1 : 0.7;
        }
    }

    /** Minimap state (reused arrays: no garbage); enemies show once they are fighting you or very close. */
    _updateMiniMap(dt, playerPos) {
        const st = this._mm || (this._mm = { pos: null, yaw: 0, squad: [], enemies: [], objective: null, _o: { x: 0, z: 0 } });
        st.pos = playerPos; st.yaw = this.player.yaw.rotation.y;
        st.squad.length = 0;
        for (const m of (this.squad && this.squad.members) || []) if (m.group) st.squad.push({ x: m.group.position.x, z: m.group.position.z, down: (m.health ?? 100) <= 0 });
        st.enemies.length = 0;
        for (const e of this.enemies) {
            if (!e.isAlive || !e.group) continue;
            const dx = e.group.position.x - playerPos.x, dz = e.group.position.z - playerPos.z;
            st.enemies.push({ x: e.group.position.x, z: e.group.position.z, spotted: e.state === 'COMBAT' || e.state === 'FLANKING' || dx * dx + dz * dz < 15 * 15 });
        }
        const o = this.missionManager.getObjectiveWorldPosition();
        st.objective = o ? (st._o.x = o.x, st._o.z = o.z, st._o) : null;
        this.minimap.update(dt, st);
    }

    /** One-shot cubemap of the finished level for glass / vehicle / wet-ground reflections. */
    _buildProbe() {
        if (this._probe) { this._probe.dispose(); this._probe = null; }
        try {
            const size = { low: 96, medium: 128, high: 192, ultra: 256, extreme: 256 }[this.renderer.quality] || 128;
            const hide = animation.fire ? animation.fire.layers.map(l => l.mesh) : [];
            this._probe = buildReflectionProbe(this.renderer.renderer, this.sceneManager.getScene(), { position: new THREE.Vector3(0, 6, 0), size, hide });
        } catch (e) { console.warn('Reflection probe failed:', e); }
    }

    /** Render once with every hidden LOD bucket shown (0 instances) so all shader
     *  programs, including shadow depth variants, compile during loading instead of
     *  hitching the first time a tree/plant tier comes into view. */
    /**
     * Pre-process every shader the level can use while the loading screen is up: all LOD
     * buckets are briefly made visible and one real render compiles exactly the programs the
     * level will draw, including the shadow-depth variants. Nothing compiles mid-game, so no first-sight hitches.
     */
    async _warmupShaders(level) {
        const scene = this.sceneManager.getScene();
        const hidden = [];
        scene.traverse(o => {
            if ((o.isInstancedMesh || o.isMesh || o.isPoints) && !o.visible && o.userData.environmentManaged) { hidden.push(o); o.visible = true; }
        });
        // (compileAsync was measured: it doubled load time and built ~77 variants never drawn, so the warm-up render does it)
        try { this.renderer.render(); } catch (e) { console.warn('Shader warm-up failed:', e); }
        hidden.forEach(o => { o.visible = false; });
    }

    _surfaceForBiome(biome) {
        return { wildlands: 'grass', dustland: 'dirt', frostland: 'snow', deadzone: 'concrete', city: 'concrete' }[biome] || 'dirt';
    }

    // ── CINEMATICS ───────────────────────────────────────────────────
    _startCinematic(mode, mission) {
        const level = this.sceneManager.getLevel();
        const objective = this.missionManager.getObjectiveWorldPosition();
        const playerPos = this.player.getPosition();
        if (mode === 'intro' && objective) {
            // start the mission facing the first objective so the push-in lands naturally
            const dx = objective.x - playerPos.x, dz = objective.z - playerPos.z;
            if (dx * dx + dz * dz > 1) {
                this.player.movement._lookYaw = Math.atan2(-dx, -dz);
                this.player.yaw.rotation.y = this.player.movement._lookYaw;
            }
        }
        const ctx = {
            playerPos, gameCamera: this.cameraManager.getCamera(), squad: this.squad, objective,
            playerYaw: this.player.yaw.rotation.y,
            heightAt: level && level.heightAt,
            raycastables: level && level.raycastables,
            dialogue: this.dialogue,
            audio: this.audio,
            title: mission ? {
                code: mission.code, title: mission.title, region: mission.region,
                eyebrow: `SEASON ${SEASON.number}  ·  EPISODE ${mission.code}`,
                location: LOCATIONS[mission.id]
            } : null
        };
        if (mode === 'intro') {
            this.dialogue.clear();
            this.cinematic.startIntro(ctx);
            // first line lands as the establishing shot settles (cinematic clock, see animate)
            this._introLines = getScript(mission.id).intro || [];
        } else if (mode === 'outro') {
            this.cinematic.startOutro(ctx);
        } else if (mode === 'beat') {
            ctx.objective = this._beatObjective || objective;
            this.cinematic.startBeat(ctx);
        } else {
            this.cinematic.startFree(ctx);
        }
        this.state = STATE.CINEMATIC;
        if (mode !== 'free') this.audio.startMusic('tension');
        this.hud.hide();
        this.player.weapons.setViewModelVisible(false);
        const sc = document.getElementById('scope-overlay');
        if (sc) sc.style.display = 'none';
        this.renderer.setScene(this.sceneManager.getScene(), this.cinematic.camera);
        this._cineHealth = this.player.health.currentHealth + this.player.health.currentArmor;
    }

    _endCinematic() {
        const mode = this.cinematic.mode;
        this._introLines = null;
        if (mode === 'outro') { this._finishOutro(); return; }
        if (mode === 'intro') {
            // a skipped intro drops its remaining lines; gameplay opens with the start beat
            this.dialogue.clear();
            this.dialogue.play(getScript(this.pendingMission.id).start || []);
        }
        if (mode === 'beat' && this.dialogue.busy) this.dialogue.clear();   // skipped: drop the rest of the scene
        this._cineHoldFire = false;
        this.cinematic.stop();
        this.renderer.setScene(this.sceneManager.getScene(), this.cameraManager.getCamera());
        this.cameraManager.resize();
        if (!this.player) return;
        this.player.weapons.setViewModelVisible(true);
        this.player.weapons._scopeType = undefined;
        this.hud.show();
        this.inputManager.consumeMouseMovement();
        this.state = STATE.PLAYING;
        this.inputManager.requestLock();
        this.resumeMusicCombat();
    }

    /** Stereo pan (-1..1) for a world position relative to the camera's facing,
     *  so enemy gunfire comes from the correct direction. */
    _audioPan(worldPos) {
        const cam = this.cameraManager.getCamera();
        this._camRight = this._camRight || new THREE.Vector3();
        this._panTmp = this._panTmp || new THREE.Vector3();
        this._camRight.setFromMatrixColumn(cam.matrixWorld, 0);
        this._panTmp.copy(worldPos).sub(cam.position);
        const d = this._panTmp.length() || 1;
        return THREE.MathUtils.clamp(this._panTmp.dot(this._camRight) / d, -1, 1);
    }

    _spawnIntel(level, mission) {
        // A few collectible intel documents scattered near objectives
        const positions = (level.spawns.objectives || []).map(o => o.position.clone().add(new THREE.Vector3(3, 0, 3)));
        positions.forEach((p, i) => {
            const id = `${mission.id}-intel-${i}`;
            if (saveManager.campaign.collectedIntel.includes(id)) return;
            const geo = new THREE.BoxGeometry(0.3, 0.4, 0.05);
            const mat = new THREE.MeshStandardMaterial({ color: 0xd8d0b8, emissive: 0x2a2410, roughness: 0.8 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(p.x, 1.0, p.z);
            mesh.castShadow = true;
            this.sceneManager.getScene().add(mesh);
            const obj = {
                position: mesh.position, active: true, prompt: 'Collect Intelligence',
                mesh,
                onInteract: () => {
                    obj.active = false;
                    this.sceneManager.getScene().remove(mesh);
                    saveManager.collectIntel(id);
                    this.hud.setIntel(saveManager.campaign.collectedIntel.length);
                    this.audio.playUI('select');
                    globalEvents.emit('intel_collected', { count: saveManager.campaign.collectedIntel.length });
                    globalEvents.emit('dialogue', { speaker: 'MAYA', text: 'Got it — adding this to the evidence file.' });
                }
            };
            this.interactables.push(obj);
        });
    }

    _onEnemyHit(enemy, dmg, point, headshot) {
        const killed = enemy.takeDamage(dmg, point, headshot);
        return killed;
    }

    _clearGameplay() {
        clearTimeout(this._missionReadyTimer);
        this._missionReadyTimer = null;
        this.suppression = 0;
        this._cineHoldFire = false;
        this._introLines = null;
        if (this.dialogue) { this.dialogue.clear(); this.dialogue.setVisible(true); this.dialogue.setMode('hud'); }
        if (this.renderer) this.renderer.setSuppression(0);
        if (this.cinematic && this.cinematic.active) {
            this.cinematic.stop();
            this.renderer.setScene(this.sceneManager.getScene(), this.cameraManager.getCamera());
        }
        if (this.civilians) { this.civilians.dispose(); this.civilians = null; }
        animation.endLevel();
        if (this._probe) { this._probe.dispose(); this._probe = null; }
        if (this.player) { this.player.weapons.dispose(); this.sceneManager.getScene().remove(this.player.yaw); }
        this.enemies.forEach(e => e.dispose());
        this.enemies = [];
        if (this.squad) this.squad.clear();
        this.interactables = [];
        this.player = null;
        this.squad = null;
    }

    /** Objective reached: play its story lines and apply squad changes (e.g. Hayes joining). */
    _onStoryBeat(index, obj, mission) {
        const script = getScript(mission.id);
        const isLast = index >= this.missionManager.objectives.length - 1;
        const lines = (!isLast && script.objectives && script.objectives[index]) || [];
        this.dialogue.play(lines);
        const join = mission.joins && mission.joins[index];
        if (join && this.squad && !this.squad.getMember(join.name)) {
            const n = this.squad.members.length;
            this.squad.addMember(join.name, { x: obj.position.x + 1.5, z: obj.position.z + 1.5 }, this._formation[n % this._formation.length]);
            this._lastSquadSig = null;
        }
        // story beats flagged in the script cut into a short in-mission cinematic
        if (lines.length && (script.cinematicBeats || []).includes(index) && this.state === STATE.PLAYING) {
            this._beatObjective = obj.position.clone();
            this.inputManager.exitLock();
            this._startCinematic('beat', mission);
        }
    }

    /** Last objective done: roll the closing cinematic with the outro lines, then the debrief. */
    _onMissionComplete(result) {
        const mission = this.pendingMission;
        const script = getScript(mission.id);
        result.episode = mission.episode || mission.id;
        if (!result.nextMission && UPCOMING[0]) {
            const u = UPCOMING[0];
            result.teaser = { code: u.code, title: u.title, blurb: u.blurb, when: formatRelease(u.release) };
        }
        saveManager.completeMission(result.missionId, { time: result.time, kills: result.kills, accuracy: result.accuracy });
        this._pendingResult = result;
                this.inputManager.exitLock();
        this.dialogue.clear();
        const lines = [...((script.objectives && script.objectives[this.missionManager.objectives.length - 1]) || []), ...(script.outro || [])];
        this.dialogue.play(lines);
        this._startCinematic('outro', mission);
    }

    _finishOutro() {
        this.cinematic.stop();
        this.dialogue.clear();
        this.renderer.setScene(this.sceneManager.getScene(), this.cameraManager.getCamera());
        this._showMissionComplete(this._pendingResult);
    }

    _showMissionComplete(result) {
        this.state = STATE.COMPLETE;
        this.inputManager.exitLock();
        this.missionComplete.show(result);
        this.hud.hide();
        this.audio.stopAmbience();
        this.audio.startMusic('menu');
    }

    _nextMission() {
        this.missionComplete.hide();
        const nextId = (this.pendingMission?.id || 1) + 1;
        const next = MISSIONS.find(m => m.id === nextId);
        if (next) {
            this.mainMenu.refresh();
            this.startMission(next.id, this.currentDifficulty);
        } else {
            this.abortToMenu();
        }
    }

    _onMissionFailed() {
        this.state = STATE.FAILED;
        this.inputManager.exitLock();
        this.hud.hide();
        // Auto-restart from checkpoint after a beat
        setTimeout(() => {
            if (this.state === STATE.FAILED) this.restartCheckpoint();
        }, 2500);
    }

    _onPlayerDeath() {
        this.audio.stopMusic();
        this.audio.playExplosion(0.4);
        this.cameraManager.addShake(0.6);
        this.missionManager.failMission();
    }

    restartCheckpoint() {
        this.missionComplete.hide();
        this.pauseMenu.hide();
        if (this.pendingMission) {
            this.startMission(this.pendingMission.id, this.currentDifficulty, { intro: false });
        } else {
            this.abortToMenu();
        }
    }

    pause() {
        if (this.touch) this.touch.reset();
        if (this.state !== STATE.PLAYING) return;
        this.state = STATE.PAUSED;
        this.inputManager.exitLock();
        this.dialogue.setVisible(false);
        const stats = this.missionManager.stats;
        const acc = stats.shotsFired > 0 ? Math.round((stats.shotsHit / stats.shotsFired) * 100) : 0;
        this.pauseMenu.show(
            `MISSION ${this.pendingMission.code} — ${this.pendingMission.title.toUpperCase()}`,
            { time: Math.round(this.missionManager.elapsed), kills: stats.kills, accuracy: acc }
        );
        this.audio.startMusic('menu');
    }

    resume() {
        if (this.state !== STATE.PAUSED) return;
        this.mainMenu.hideAll();
        this.pauseMenu.hide();
        this.dialogue.setVisible(true);
        this.state = STATE.PLAYING;
        this._resumedAt = performance.now();
        this.inputManager.requestLock();
        this.inputManager.endFrame();   // latch the Esc that resumed so it doesn't re-trigger pause next frame
        this.resumeMusicCombat();
    }

    resumeMusicCombat() {
        // Gameplay keeps only the biome ambience; the low drone obscures the scene audio.
        this.audio.stopMusic();
    }

    abortToMenu() {
        this._buildToken++;
        clearTimeout(this._buildStartTimer);
        const ls = document.getElementById('loading-screen');
        if (ls) ls.remove();
        this._loadingEl = null;
        this._clearGameplay();
        trimCivilianModels();
        this.sceneManager.clearLevel();
        this.missionComplete.hide();
        this.pauseMenu.hide();
        this.hud.hide();
        this.mainMenu.refresh();
        this.mainMenu.show('menu');
        this.renderer.setScene(this.menuThreeScene, this.menuCamera);
        this.renderer.setExposure(this.menuScene.exposure);
        this.renderer.setGrade();
        this.renderer.setSun(null);
        this.audio.stopAmbience();
        this.audio.startAmbience('rain', 0.12);
        this.audio.startMusic('menu');
        document.body.classList.remove('in-game');
        this.state = STATE.MENU;
    }

    _exit() {
        // Browsers cannot close a tab opened by the user; show a message.
        this.mainMenu.show('menu');
        globalEvents.emit('dialogue', { speaker: 'SYSTEM', text: 'Close the browser tab to exit. Progress is saved automatically.' });
    }

    // ── MAIN LOOP ───────────────────────────────────────────────────────
    animate(currentTime) {
        requestAnimationFrame(this.animate);
        // ── frame pacing: present on a steady 30/60 Hz cadence (or every vsync when uncapped) ──
        const interval = this.frameInterval || 0;
        if (interval > 0) {
            const since = currentTime - (this._lastPresent || 0);
            if (since < interval - 1.5) return;                        // too early for this slot: skip the vsync
            // advance in whole intervals so the cadence never drifts; resync after a long stall
            this._lastPresent = since > interval * 4 ? currentTime : this._lastPresent + interval * Math.floor((since + 1.5) / interval);
        }
        let frameDt = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        frameDt = Math.min(Math.max(frameDt, 0), 0.25);                // a long hitch never turns into a physics explosion
        const dt = Math.min(frameDt, 0.05);                            // visual systems step at most 50 ms

        if (this.state === STATE.MENU || this.state === STATE.BRIEFING) {
            this.menuScene.update(dt, this.menuCamera);
            this.dialogue.update(dt);
            this.renderer.render();
            this.inputManager.endFrame();
            return;
        }

        if (this.state === STATE.CINEMATIC) {
            const free = this.cinematic.mode === 'free';
            this._cineHoldFire = !free;
            const input = this.inputManager;
            let skip;
            if (free) skip = input.justPressed('cinematic') || input.justPressed('pause');
            else {
                const pad = navigator.getGamepads ? [...navigator.getGamepads()].some(g => g && g.buttons[0] && g.buttons[0].pressed) : false;
                const held = input.isDown('jump') || input.keys.Enter || input.isMouseDown('left') || pad;
                skip = this.cinematic.feedSkip(held, dt);
            }
            const hurt = free && this.player.health.currentHealth + this.player.health.currentArmor < this._cineHealth;
            const playerPos = this.player.getPosition();
            // scripted cinematics freeze the fight; the free view keeps the world live but bails out on damage
            if (free) this.enemies.forEach(e => e.update(dt));
            this.squad.update(dt, playerPos);
            if (free) this.missionManager.update(dt, this.player.getEyePosition());
            updateViewCone(this.cinematic.camera); occlusion.update(dt, this.cinematic.camera);
            this.sceneManager.update(dt, playerPos, this.cinematic.camera);
            this.hud.update(dt);
            if (this._introLines && this.cinematic.mode === 'intro' && this.cinematic.time > 1.8) {
                this.dialogue.play(this._introLines);
                this._introLines = null;
            }
            this.dialogue.update(dt);
            animation.update(dt, this.cinematic.camera);
            if (this.civilians) this.civilians.update(dt, this.cinematic.camera);
            const running = this.cinematic.update(dt);
            if (!running || skip || hurt) this._endCinematic();
            this.renderer.render();
            input.consumeMouseMovement();
            input.endFrame();
            return;
        }

        if (this.state === STATE.PLAYING) {
            // Pause on Escape / pointer-lock loss
            if (this.inputManager.justPressed('pause')) { this.pause(); }
            if (this.inputManager.justPressed('cinematic') && this.player.health.isAlive) {
                this._startCinematic('free', this.pendingMission);
                this.inputManager.endFrame();
                return;
            }

            const playerPos = this.player.getPosition();
            // ── simulation in fixed-size sub-steps (≤ 1/60 s): identical gameplay speed and physics at
            //    30, 60 or uncapped. If the frame was slow, several steps run and only one render follows
            //    (frame skipping); beyond 8 steps the extra time is dropped so a stall can't snowball.
            {
                const cam = this.cameraManager.getCamera(), base = this.cameraManager.baseFOV || 75;
                this.player.movement.zoomScale = Math.min(1, Math.max(0.25, Math.tan(cam.fov * Math.PI / 360) / Math.tan(base * Math.PI / 360)));
                this.player.weapons.lookSource = this.player.movement;
            }
            const steps = Math.min(8, Math.max(1, Math.ceil(frameDt / (1 / 60) - 1e-3)));
            const sdt = Math.min(frameDt, 8 / 60) / steps;
            for (let i = 0; i < steps; i++) {
                this.player.update(sdt, this.inputManager, this.audio);
                for (let e = 0; e < this.enemies.length; e++) this.enemies[e].update(sdt);
                this.squad.update(sdt, playerPos);
                this.missionManager.update(sdt, this.player.getEyePosition());
                if (this.state !== STATE.PLAYING) break;
                if (i === 0) this.inputManager.endFrame();           // edge presses (fire, jump, reload) count once per frame
            }
            if (this.state !== STATE.PLAYING) { this.inputManager.endFrame(); return; }   // mission just completed → outro owns the frame
            { const cam = this.cameraManager.getCamera(); updateViewCone(cam); occlusion.update(dt, cam); }
            this.sceneManager.update(dt, playerPos, this.cameraManager.getCamera());

            // HUD extras
            this.hud.update(dt);
            this.dialogue.update(dt);
            animation.update(dt, this.cameraManager.getCamera());
            if (this.civilians) this.civilians.update(dt, this.cameraManager.getCamera());
            this.hud.updateCompass(this.player.yaw.rotation.y);
            this._updateMiniMap(dt, playerPos);
            this._aimAssist(dt);
            if (this.touch) this.touch.update(dt, { canUse: !document.getElementById('interaction-prompt').classList.contains('hidden'), aiming: this.inputManager.mouseButtons.right });
            this._updateCrosshair();
            this._updateSquadStatus();
            this._updateStance();

            // Recover damage pulse toward current health
            const hp = this.player.health.healthPct;
            this.renderer.setDamage(this.player.health.isAlive ? Math.max(0, (1 - hp) * 0.5) : 0.9);
            this.suppression = Math.max(0, (this.suppression || 0) - frameDt * 0.45);
            this.player.weapons.suppression = this.suppression;
            this.renderer.setSuppression(Math.min(1, this.suppression));

            this.renderer.render();
        } else if (this.state === STATE.PAUSED || this.state === STATE.COMPLETE || this.state === STATE.FAILED) {
            // Keep rendering the frozen gameplay scene behind the overlay
            this.renderer.render();
        }

        this.inputManager.endFrame();
    }

    _updateCrosshair() {
        const w = this.player.weapons.current;
        if (!w) return;
        const aiming = w.ads > 0.5;
        // Map weapon spread (radians) to screen pixels
        const spreadPx = aiming && w.data.category === 'Sniper Rifle'
            ? 0
            : THREE.MathUtils.clamp(w.currentSpread * 900, 4, 46);
        const scoped = document.getElementById('scope-overlay')?.style.display === 'block';
        globalEvents.emit('spread_update', { spread: spreadPx, hidden: scoped || (aiming && w.data.category === 'Sniper Rifle') });
    }

    _updateSquadStatus() {
        if (!this.squad) return;
        // Only rebuild the DOM when the squad state actually changes
        const sig = this.squad.members.map(m => `${m.name}${m.isAlive ? 1 : 0}`).join('|');
        if (sig === this._lastSquadSig) return;
        this._lastSquadSig = sig;
        globalEvents.emit('squad_update', {
            members: this.squad.members.map(m => ({ name: m.name.toUpperCase(), alive: m.isAlive }))
        });
    }

    _updateStance() {
        const m = this.player.movement;
        let stance = 'STANDING';
        if (m.isSliding()) stance = 'SLIDING';
        else if (m.isCrouching()) stance = 'CROUCHED';
        else if (m.isSprinting()) stance = 'SPRINTING';
        else if (!m.isGrounded()) stance = 'AIRBORNE';
        else if (m.isMoving()) stance = 'MOVING';
        if (stance !== this._lastStance) {
            this._lastStance = stance;
            globalEvents.emit('stance_update', { stance });
        }
    }
}
