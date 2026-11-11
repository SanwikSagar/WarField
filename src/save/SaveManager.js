/**
 * Save system (GDD 11.10 / 13). Persists settings and campaign progress to
 * LocalStorage with a version field so future updates can migrate old saves.
 * IndexedDB would be used for larger data; localStorage is sufficient here.
 */
const SAVE_KEY = 'warfield_save_v1';
const SETTINGS_KEY = 'warfield_settings_v1';
const SAVE_VERSION = 1;

export const DEFAULT_SETTINGS = {
    // Graphics
    quality: 'high',
    fov: 75,
    motionBlur: false,
    screenShake: 1.0,
    filmGrain: 0.06,
    // Audio
    masterVolume: 0.8,
    musicVolume: 0.5,
    sfxVolume: 0.9,
    ambienceVolume: 0.6,
    // Controls
    sensitivity: 1.0,
    invertY: false,
    // Accessibility
    subtitles: true,
    subtitleSize: 'medium',
    showDamageNumbers: true,
    // Gameplay
    difficulty: 'regular'
};

export const DEFAULT_CAMPAIGN = {
    version: SAVE_VERSION,
    currentMission: 1,
    completedMissions: [],
    missionStats: {},       // missionId -> { time, kills, accuracy }
    collectedIntel: [],
    unlockedAttachments: ['redDot'],
    lastPlayed: null
};

export class SaveManager {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this.campaign = { ...DEFAULT_CAMPAIGN };
        // True until settings are found in storage; lets the game auto-pick a
        // GPU-appropriate quality preset on the very first launch only.
        this.settingsFromStorage = false;
    }

    load() {
        try {
            const s = localStorage.getItem(SETTINGS_KEY);
            if (s) { this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) }; this.settingsFromStorage = true; }
        } catch (e) { console.warn('Settings load failed', e); }

        try {
            const c = localStorage.getItem(SAVE_KEY);
            if (c) {
                const data = JSON.parse(c);
                if (data.version === SAVE_VERSION) {
                    this.campaign = { ...DEFAULT_CAMPAIGN, ...data };
                } else {
                    console.warn('Save version mismatch, starting fresh campaign');
                }
            }
        } catch (e) { console.warn('Save load failed', e); }
        return { settings: this.settings, campaign: this.campaign };
    }

    saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); }
        catch (e) { console.warn('Settings save failed', e); }
    }

    saveCampaign() {
        this.campaign.lastPlayed = Date.now();
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.campaign)); }
        catch (e) { console.warn('Campaign save failed', e); }
    }

    updateSetting(key, value) {
        this.settings[key] = value;
        this.saveSettings();
    }

    completeMission(missionId, stats) {
        if (!this.campaign.completedMissions.includes(missionId)) {
            this.campaign.completedMissions.push(missionId);
        }
        this.campaign.missionStats[missionId] = stats;
        this.campaign.currentMission = Math.min(6, missionId + 1);
        this.saveCampaign();
    }

    isMissionUnlocked(missionId) {
        if (missionId === 1) return true;
        return this.campaign.completedMissions.includes(missionId - 1);
    }

    collectIntel(id) {
        if (!this.campaign.collectedIntel.includes(id)) {
            this.campaign.collectedIntel.push(id);
            this.saveCampaign();
        }
    }

    resetCampaign() {
        this.campaign = { ...DEFAULT_CAMPAIGN };
        this.saveCampaign();
    }

    get hasSave() {
        return this.campaign.completedMissions.length > 0 || this.campaign.currentMission > 1;
    }
}

export const saveManager = new SaveManager();
