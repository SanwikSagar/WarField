import * as THREE from 'three';
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

        // UI controllers
        this.cinematic = new CinematicCamera();
        this.hud = new HUDManager();
        this.settingsMenu = new SettingsMenu({ audio: this.audio });
        this.mainMenu = new MainMenu({
            audio: this.audio,
            onStartMission: (id, diff) => this.startMission(id, diff),
            onExit: () => this._exit()
        });
        this.pauseMenu = new PauseMenu({
            audio: this.audio,
            onResume: () => this.resume(),
            onSettings: () => { this.mainMenu.show('settings'); this.state = STATE.PAUSED; },
            onRestart: () => this.restartCheckpoint(),
            onAbort: () => this.abortToMenu()
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
            onFail: () => this._onMissionFailed()
        });

        this._bindGlobalEvents();
        this._hideLoading();

        this.audio.init();
        this.audio.startMusic('menu');
        this.audio.startAmbience('rain', 0.12);

        // Browsers suspend the AudioContext until a user gesture; unlock on
        // the first click or keypress so menu/game audio actually plays.
        const unlock = () => { this.audio.resume(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('keydown', unlock);

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
            const tier = detectGPUTier();
            s.quality = tier;
            if (tier === 'low') s.filmGrain = 0.0;
        }
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
                if (this.sceneManager.level && this.sceneManager.level.sky) {
                    const sizes = { low: 1024, medium: 1024, high: 2048, ultra: 4096 };
                    this.sceneManager.level.sky.setShadowMapSize(sizes[value] || 2048);
                }
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

    _hideLoading() {
        const ls = document.getElementById('loading-screen');
        const fill = document.getElementById('loading-fill');
        if (fill) fill.style.width = '100%';
        setTimeout(() => {
            if (ls) { ls.classList.add('fade-out'); setTimeout(() => ls.remove(), 700); }
        }, 400);
    }

    // ── MISSION LIFECYCLE ───────────────────────────────────────────────
    startMission(missionId, difficulty, { intro = true } = {}) {
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
        await Promise.all([
            import('../environments/Foliage.js')
                .then(({ loadFoliageAssets }) => loadFoliageAssets())
                .catch(e => { console.warn('Foliage assets unavailable:', e); }),
            Promise.all([loadCharacters(), loadWeaponModels(), loadPropModels(cfg)])
                .catch(e => { console.warn('Characters/weapons unavailable:', e); }),
            loadPhotoAssets(cfg.photo || [], cfg.hdr && cfg.hdr.file)
                .catch(e => { console.warn('Photo assets unavailable:', e); })
        ]);
        if (stale()) return;
        const fl0 = document.getElementById('loading-fill');
        if (fl0) fl0.style.width = '55%';
        await new Promise(r => setTimeout(r, 16)); // let the loading bar paint
        if (stale()) return;

        // Build the level
        const level = await this.sceneManager.loadLevel(mission.biome, { ...this.renderer.getSettings(), renderer: this.renderer.renderer });
        if (stale()) return;
        // Match the sky's shadow-map resolution to the active quality preset
        // (the Sky builds at 2048 by default; low/medium should be cheaper).
        if (level.sky) {
            const shadowSizes = { low: 1024, medium: 1024, high: 2048, ultra: 4096 };
            level.sky.setShadowMapSize(shadowSizes[this.renderer.quality] || 2048);
        }
        const fl = document.getElementById('loading-fill');
        if (fl) fl.style.width = '70%';

        this.renderer.setExposure(level.exposure || 1.2);

        // Point the renderer at the gameplay scene
        this.renderer.setScene(this.sceneManager.getScene(), this.cameraManager.getCamera());

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
            getEnemies: () => this.enemies,
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
            getEnemies: () => this.enemies,
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
        spawns.squad.forEach((s, i) => {
            this.squad.addMember(s.name, s, formation[i % formation.length]);
        });

        // Interactables (intel pickups)
        this.interactables = [];
        this._spawnIntel(level, mission);

        // Mission system
        this.missionManager.startMission(mission.id, level, this.sceneManager.getScene());

        // Audio ambience per biome
        this.audio.startAmbience(level.ambience, 0.14);
        this.audio.stopMusic();

        // Apply live settings to fresh systems
        this.renderer.setGrain(saveManager.settings.filmGrain > 0.001 ? 0.022 : 0);

        // HUD
        this.hud.show();
        this.hud.setIntel(saveManager.campaign.collectedIntel.length);

        if (fl) fl.style.width = '100%';
        this._warmupShaders(level);
        this._missionReadyTimer = setTimeout(() => {
            this._missionReadyTimer = null;
            const overlay = this._loadingEl;
            if (overlay) {
                overlay.classList.add('fade-out');
                setTimeout(() => overlay.remove(), 600);
                this._loadingEl = null;
            }
            if (this._playIntro) { this._startCinematic('intro', mission); return; }
            this.state = STATE.PLAYING;
            this.inputManager.requestLock();
            this.resumeMusicCombat();
        }, 350);
    }

    /** Render once with every hidden LOD bucket shown (0 instances) so all shader
     *  programs, including shadow depth variants, compile during loading instead of
     *  hitching the first time a tree/plant tier comes into view. */
    _warmupShaders(level) {
        const hidden = [];
        this.sceneManager.getScene().traverse(o => {
            if (o.isInstancedMesh && !o.visible && o.userData.environmentManaged) { hidden.push(o); o.visible = true; }
        });
        if (level.sky && level.sky.sun) level.sky.sun.shadow.needsUpdate = true;
        try { this.renderer.render(); } catch (e) { console.warn('Shader warm-up failed:', e); }
        hidden.forEach(o => { o.visible = false; });
    }

    _surfaceForBiome(biome) {
        return { wildlands: 'grass', dustland: 'dirt', frostland: 'snow', deadzone: 'concrete' }[biome] || 'dirt';
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
            heightAt: level && level.heightAt,
            title: mission ? { code: mission.code, title: mission.title, region: mission.region } : null
        };
        if (mode === 'intro') this.cinematic.startIntro(ctx); else this.cinematic.startFree(ctx);
        this.state = STATE.CINEMATIC;
        this.hud.hide();
        this.player.weapons.setViewModelVisible(false);
        const sc = document.getElementById('scope-overlay');
        if (sc) sc.style.display = 'none';
        this.renderer.setScene(this.sceneManager.getScene(), this.cinematic.camera);
        this._cineHealth = this.player.health.currentHealth + this.player.health.currentArmor;
    }

    _endCinematic() {
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
        if (this.renderer) this.renderer.setSuppression(0);
        if (this.cinematic && this.cinematic.active) {
            this.cinematic.stop();
            this.renderer.setScene(this.sceneManager.getScene(), this.cameraManager.getCamera());
        }
        if (this.player) { this.player.weapons.dispose(); this.sceneManager.getScene().remove(this.player.yaw); }
        this.enemies.forEach(e => e.dispose());
        this.enemies = [];
        if (this.squad) this.squad.clear();
        this.interactables = [];
        this.player = null;
        this.squad = null;
    }

    _onMissionComplete(result) {
        this.state = STATE.COMPLETE;
        this.inputManager.exitLock();
        saveManager.completeMission(result.missionId, { time: result.time, kills: result.kills, accuracy: result.accuracy });
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
        if (this.state !== STATE.PLAYING) return;
        this.state = STATE.PAUSED;
        this.inputManager.exitLock();
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
        this.state = STATE.PLAYING;
        this.inputManager.requestLock();
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
        this.sceneManager.clearLevel();
        this.missionComplete.hide();
        this.pauseMenu.hide();
        this.hud.hide();
        this.mainMenu.refresh();
        this.mainMenu.show('menu');
        this.renderer.setScene(this.menuThreeScene, this.menuCamera);
        this.renderer.setExposure(1.05);
        this.audio.stopAmbience();
        this.audio.startAmbience('rain', 0.12);
        this.audio.startMusic('menu');
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
        let dt = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;
        dt = Math.min(dt, 0.05); // cap to avoid physics explosion after stalls

        if (this.state === STATE.MENU || this.state === STATE.BRIEFING) {
            this.menuScene.update(dt, this.menuCamera);
            this.renderer.render();
            this.inputManager.endFrame();
            return;
        }

        if (this.state === STATE.CINEMATIC) {
            const intro = this.cinematic.mode === 'intro';
            const input = this.inputManager;
            const skip = intro
                ? (input.justPressed('jump') || input.justPressed('pause') || input.justPressedMouse('left') || input.keys.Enter)
                : (input.justPressed('cinematic') || input.justPressed('pause'));
            const hurt = this.player.health.currentHealth + this.player.health.currentArmor < this._cineHealth;
            const playerPos = this.player.getPosition();
            // intro freezes enemies; the free view keeps the world live but bails out on damage
            if (!intro) this.enemies.forEach(e => e.update(dt));
            this.squad.update(dt, playerPos);
            this.missionManager.update(dt, this.player.getEyePosition());
            this.sceneManager.update(dt, playerPos, this.cinematic.camera);
            this.hud.update(dt);
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
            this.player.update(dt, this.inputManager, this.audio);
            this.enemies.forEach(e => e.update(dt));
            this.squad.update(dt, playerPos);
            this.missionManager.update(dt, this.player.getEyePosition());
            this.sceneManager.update(dt, playerPos, this.cameraManager.getCamera());

            // HUD extras
            this.hud.update(dt);
            this.hud.updateCompass(this.player.yaw.rotation.y);
            this._updateCrosshair();
            this._updateSquadStatus();
            this._updateStance();

            // Recover damage pulse toward current health
            const hp = this.player.health.healthPct;
            this.renderer.setDamage(this.player.health.isAlive ? Math.max(0, (1 - hp) * 0.5) : 0.9);
            this.suppression = Math.max(0, (this.suppression || 0) - dt * 0.45);
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
