import * as THREE from '/node_modules/three/build/three.module.js';
import { globalEvents } from '../core/EventManager.js';
import { MISSIONS } from '../environments/biomes.js';

/**
 * Data-driven mission + objective system (GDD 11.9 / 4.x). Objectives are
 * proximity triggers pulled from the episode / biome spawn data; completing
 * one advances to the next and emits HUD updates. Story beats (radio lines,
 * squadmates joining) fire per objective through deps.onObjective, so the
 * dialogue always lands on the moment it describes (see src/story/Story.js).
 */
export class MissionManager {
    constructor(deps = {}) {
        this.deps = deps; // { getPlayerPos, audio, onComplete, onFail, onObjective }
        this.mission = null;
        this.objectives = [];
        this.currentIndex = 0;
        this.active = false;
        this.completed = false;
        this.elapsed = 0;
        this.stats = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, intel: 0 };
        this._flat = new THREE.Vector2();

        globalEvents.on('enemy_killed', () => { if (this.active) this.stats.kills++; });
        globalEvents.on('hitmarker', (d) => { if (!this.active) return; this.stats.shotsHit++; if (d.headshot) this.stats.headshots++; });
        globalEvents.on('weapon_fired', () => { if (this.active) this.stats.shotsFired++; });
    }

    startMission(missionId, levelData, scene) {
        this.mission = MISSIONS.find(m => m.id === missionId) || MISSIONS[0];
        this.scene = scene;
        this.active = true;
        this.completed = false;
        this.elapsed = 0;
        this.currentIndex = 0;
        this.stats = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, intel: 0 };

        const objs = this.mission.objectiveSpawns || (levelData.spawns && levelData.spawns.objectives) || [];
        this.objectives = objs.map(o => ({
            id: o.id, text: o.text,
            position: o.position.clone(), radius: o.radius || 8,
            completed: false
        }));

        if (this.markerGroup) scene.remove(this.markerGroup);
        this.markerGroup = new THREE.Group();
        scene.add(this.markerGroup);
        this._buildMarkers();

        globalEvents.emit('mission_start', {
            code: this.mission.code, title: this.mission.title,
            region: this.mission.region, briefing: this.mission.briefing, act: this.mission.act
        });
        this._emitObjective();
    }

    _buildMarkers() {
        // Soft vertical beacon + ground ring at the active objective
        this.markerMeshes = [];
        const beamGeo = new THREE.CylinderGeometry(0.25, 0.5, 34, 12, 1, true);
        const ringGeo = new THREE.RingGeometry(0.9, 1.15, 40);
        this.objectives.forEach((o, i) => {
            const g = new THREE.Group();
            const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
                color: 0xffa64a, transparent: true, opacity: 0.1, side: THREE.DoubleSide,
                depthWrite: false, blending: THREE.AdditiveBlending, fog: false
            }));
            beam.position.y = 17;
            const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
                color: 0xffb060, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
                depthWrite: false, blending: THREE.AdditiveBlending
            }));
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.08;
            ring.scale.setScalar(Math.min(2.6, o.radius * 0.25));
            g.add(beam, ring);
            g.position.set(o.position.x, 0, o.position.z);
            g.visible = i === 0;
            g.userData = { beam, ring, base: ring.scale.x };
            this.markerGroup.add(g);
            this.markerMeshes.push(g);
        });
    }

    _emitObjective() {
        const obj = this.objectives[this.currentIndex];
        globalEvents.emit('objective_update', {
            current: obj ? obj.text : 'Mission complete',
            index: this.currentIndex,
            total: this.objectives.length,
            list: this.objectives.map(o => ({ text: o.text, completed: o.completed })),
            position: obj ? obj.position : null
        });
        if (this.markerMeshes) this.markerMeshes.forEach((m, i) => { m.visible = i === this.currentIndex; });
    }

    update(dt, playerPos) {
        if (!this.active) return;
        this.elapsed += dt;

        const obj = this.objectives[this.currentIndex];
        if (obj && playerPos) {
            this._flat.set(playerPos.x - obj.position.x, playerPos.z - obj.position.z);
            if (this._flat.length() < obj.radius) {
                obj.completed = true;
                const index = this.currentIndex;
                globalEvents.emit('objective_complete', { text: obj.text, index, id: obj.id });
                this.currentIndex++;
                if (this.deps.onObjective) this.deps.onObjective(index, obj, this.mission);
                if (this.currentIndex >= this.objectives.length) this._completeMission();
                else this._emitObjective();
            }
        }

        const m = this.markerMeshes && this.markerMeshes[this.currentIndex];
        if (m) {
            const { beam, ring, base } = m.userData;
            beam.rotation.y += dt * 0.5;
            beam.material.opacity = 0.05 + Math.sin(this.elapsed * 2) * 0.02;
            const k = (this.elapsed * 0.6) % 1;
            ring.scale.setScalar(base * (0.6 + k * 0.6));
            ring.material.opacity = 0.55 * (1 - k);
        }
    }

    _completeMission() {
        this.active = false;
        this.completed = true;
        if (this.markerGroup) this.markerGroup.visible = false;
        const accuracy = this.stats.shotsFired > 0
            ? Math.round((this.stats.shotsHit / this.stats.shotsFired) * 100) : 0;
        const result = {
            missionId: this.mission.id,
            title: this.mission.title,
            time: Math.round(this.elapsed),
            kills: this.stats.kills,
            headshots: this.stats.headshots,
            accuracy,
            nextMission: MISSIONS.some(x => x.id === this.mission.id + 1) ? this.mission.id + 1 : null
        };
        globalEvents.emit('mission_complete', result);
        if (this.deps.onComplete) this.deps.onComplete(result);
    }

    failMission() {
        if (!this.active) return;
        this.active = false;
        globalEvents.emit('mission_failed', { missionId: this.mission.id });
        if (this.deps.onFail) this.deps.onFail();
    }

    getObjectiveWorldPosition() {
        const obj = this.objectives[this.currentIndex];
        return obj ? obj.position : null;
    }
}
