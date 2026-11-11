import * as THREE from 'three';
import { globalEvents } from '../core/EventManager.js';
import { MISSIONS } from '../environments/biomes.js';

/**
 * Data-driven mission + objective system (GDD 11.9 / 4.x). Objectives are
 * proximity triggers pulled from the biome spawn data; completing one
 * advances to the next and emits HUD updates. Radio dialogue is scripted per
 * mission and played on a timed queue to deliver the cinematic story beats.
 */
export class MissionManager {
    constructor(deps = {}) {
        this.deps = deps; // { getPlayerPos, audio, onComplete, onFail }
        this.mission = null;
        this.objectives = [];
        this.currentIndex = 0;
        this.active = false;
        this.completed = false;
        this.elapsed = 0;
        this.dialogueQueue = [];
        this.dialogueTimer = 0;
        this.stats = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, intel: 0 };
        this.markers = new THREE.Group();

        globalEvents.on('enemy_killed', () => { this.stats.kills++; });
        globalEvents.on('hitmarker', (d) => { this.stats.shotsHit++; if (d.headshot) this.stats.headshots++; });
        globalEvents.on('weapon_fired', () => { this.stats.shotsFired++; });
    }

    startMission(missionId, levelData, scene) {
        this.mission = MISSIONS.find(m => m.id === missionId) || MISSIONS[0];
        this.scene = scene;
        this.active = true;
        this.completed = false;
        this.elapsed = 0;
        this.currentIndex = 0;
        this.stats = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0, intel: 0 };

        // Build objectives from spawn data
        const objs = this.mission.objectiveSpawns || (levelData.spawns && levelData.spawns.objectives) || [];
        this.objectives = objs.map(o => ({
            id: o.id, text: o.text,
            position: o.position.clone(), radius: o.radius || 8,
            completed: false
        }));

        // Objective marker group
        if (this.markerGroup) scene.remove(this.markerGroup);
        this.markerGroup = new THREE.Group();
        scene.add(this.markerGroup);
        this._buildMarkers();

        globalEvents.emit('mission_start', {
            code: this.mission.code, title: this.mission.title,
            region: this.mission.region, briefing: this.mission.briefing, act: this.mission.act
        });

        // Queue opening radio dialogue
        this.dialogueQueue = DIALOGUE[this.mission.id] ? [...DIALOGUE[this.mission.id]] : [];
        this.dialogueTimer = 2.0;

        this._emitObjective();
    }

    _buildMarkers() {
        // A subtle vertical beacon at the active objective
        this.markerMeshes = [];
        this.objectives.forEach((o, i) => {
            const geo = new THREE.CylinderGeometry(0.6, 0.6, 30, 8, 1, true);
            const mat = new THREE.MeshBasicMaterial({
                color: 0x66ccff, transparent: true, opacity: 0.12,
                side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
            });
            const beacon = new THREE.Mesh(geo, mat);
            beacon.position.set(o.position.x, 15, o.position.z);
            beacon.visible = i === 0;
            this.markerGroup.add(beacon);
            this.markerMeshes.push(beacon);
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
        if (this.markerMeshes) {
            this.markerMeshes.forEach((m, i) => { m.visible = i === this.currentIndex; });
        }
    }

    update(dt, playerPos) {
        if (!this.active) return;
        this.elapsed += dt;

        // Dialogue queue
        if (this.dialogueQueue.length) {
            this.dialogueTimer -= dt;
            if (this.dialogueTimer <= 0) {
                const line = this.dialogueQueue.shift();
                globalEvents.emit('dialogue', { speaker: line.speaker, text: line.text });
                this.dialogueTimer = line.text.length * 0.055 + 2.0;
            }
        }

        // Objective proximity check
        const obj = this.objectives[this.currentIndex];
        if (obj && playerPos) {
            const flat = new THREE.Vector2(playerPos.x - obj.position.x, playerPos.z - obj.position.z);
            if (flat.length() < obj.radius) {
                obj.completed = true;
                globalEvents.emit('objective_complete', { text: obj.text });
                this.currentIndex++;
                if (this.currentIndex >= this.objectives.length) {
                    this._completeMission();
                } else {
                    this._emitObjective();
                }
            }
        }

        // Animate active beacon
        if (this.markerMeshes && this.markerMeshes[this.currentIndex]) {
            const m = this.markerMeshes[this.currentIndex];
            m.rotation.y += dt * 0.5;
            m.material.opacity = 0.1 + Math.sin(this.elapsed * 2) * 0.04;
        }
    }

    _completeMission() {
        this.active = false;
        this.completed = true;
        const accuracy = this.stats.shotsFired > 0
            ? Math.round((this.stats.shotsHit / this.stats.shotsFired) * 100) : 0;
        const result = {
            missionId: this.mission.id,
            title: this.mission.title,
            time: Math.round(this.elapsed),
            kills: this.stats.kills,
            headshots: this.stats.headshots,
            accuracy,
            nextMission: this.mission.id < MISSIONS.length ? this.mission.id + 1 : null
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

/**
 * Scripted radio dialogue per mission (GDD 3.2 / 4.x). Delivered as timed
 * subtitles to build the cinematic story without voice assets.
 */
const DIALOGUE = {
    1: [
        { speaker: 'HAYES', text: 'Comms went dark six hours ago. Whatever hit this team, they did not radio for help.' },
        { speaker: 'MAYA', text: 'Last transmission came from near the old outpost. I am picking up faint signals.' },
        { speaker: 'ETHAN', text: 'Stay sharp. This forest does not feel empty.' },
        { speaker: 'HAYES', text: 'Mercer, take point. Find that recon team.' },
        { speaker: 'MAYA', text: 'These are military-grade casings. Not insurgents. Someone equipped them.' },
        { speaker: 'HAYES', text: 'That is... something we are not supposed to know about.' }
    ],
    2: [
        { speaker: 'MAYA', text: 'Convoy is running this route in ten minutes. We watch and learn.' },
        { speaker: 'HAYES', text: 'Contact! They are hitting the convoy. Everyone, move up!' },
        { speaker: 'ETHAN', text: 'Survivors down the road. I am moving to help.' },
        { speaker: 'MAYA', text: 'The stolen crates are tagged for an industrial facility east of here.' },
        { speaker: 'MAYA', text: 'Authorization code on the manifest... it traces to a senior command structure.' },
        { speaker: 'HAYES', text: 'I know that code. I served under him. Not over an open channel.' }
    ],
    3: [
        { speaker: 'MAYA', text: 'This installation is supposed to be decommissioned. It is not.' },
        { speaker: 'ETHAN', text: 'Visibility is dropping. Stay close.' },
        { speaker: 'HAYES', text: 'Records room should be below. Maya, get the data.' },
        { speaker: 'MAYA', text: 'Victor Kane authorized every attack. He is destabilizing Varencia on purpose.' },
        { speaker: 'HAYES', text: 'I saw operations like this before. I stayed quiet. I thought it would never surface.' },
        { speaker: 'ETHAN', text: 'Explosion! We are cut off — Hayes is on the other side!' },
        { speaker: 'MAYA', text: 'His signal is gone. Transfers are headed for the Deadzone.' }
    ],
    4: [
        { speaker: 'MAYA', text: 'Detention facility matches the Frostland transfer records. Hayes could be inside.' },
        { speaker: 'ETHAN', text: 'Checkpoint ahead is heavily defended. We go through the buildings.' },
        { speaker: 'HAYES', text: '...Mercer? They were going to execute me an hour from now.' },
        { speaker: 'HAYES', text: 'Kane is activating the final stage. Operation Blackout goes live tonight.' },
        { speaker: 'MAYA', text: 'We have the evidence. We just have to reach the communications HQ.' }
    ],
    5: [
        { speaker: 'MAYA', text: 'This is the heart of it. Kane is running Blackout from inside.' },
        { speaker: 'HAYES', text: 'Get Maya to the broadcast array. I will hold the control room.' },
        { speaker: 'MAYA', text: 'Upload started. I need time — defend this position!' },
        { speaker: 'ETHAN', text: 'Power is out! Emergency lighting only. Watch your corners.' },
        { speaker: 'HAYES', text: 'System restored. Go, Mercer. I have got this. Get Kane.' },
        { speaker: 'ETHAN', text: 'Hayes... Hayes is not responding. He held the line.' },
        { speaker: 'MAYA', text: 'Broadcast complete. The conspiracy is exposed. Kane is in custody.' },
        { speaker: 'MERCER', text: 'Some missions are about winning. Others are about what you are willing to lose.' }
    ],
    6: [
        { speaker: 'MAYA', text: 'Kane is contained, but his network is firing on Veyra City. They want the blackout to look like a civil collapse.' },
        { speaker: 'ETHAN', text: 'I see movement between the apartment blocks. Keep the squad tight.' },
        { speaker: 'HAYES', text: 'Civilians are sheltering in the west block. Get them to the checkpoint.' },
        { speaker: 'MAYA', text: 'The city is broadcasting again. Every street we secure gives Varencia a chance to recover.' },
        { speaker: 'MERCER', text: 'The war did not end when Kane fell. It ends when the people can go home.' }
    ]
};
