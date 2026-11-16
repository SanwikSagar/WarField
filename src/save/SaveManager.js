/**
 * Save system (GDD 11.10 / 13). Persists settings and campaign progress to
 * LocalStorage with a version field so future updates can migrate old saves.
 * IndexedDB would be used for larger data; localStorage is sufficient here.
 */
const SAVE_KEY = 'warfield_save_v1';
const SETTINGS_KEY = 'warfield_settings_v1';
const PLAYER_KEY = 'warfield_player_v1';
const SAVE_VERSION = 1;
const SAVE_FORMAT = 'warfield-save';
/** Settings that travel with the player. Graphics preset, frame cap and fullscreen are device-specific and stay local. */
export const SYNC_SETTINGS = ['masterVolume', 'musicVolume', 'sfxVolume', 'ambienceVolume', 'sensitivity', 'invertY', 'aimAssist',
    'touchLook', 'fov', 'screenShake', 'filmGrain', 'subtitles', 'subtitleSize', 'showDamageNumbers', 'difficulty'];
const MAX_MISSION = 6;

export const DEFAULT_SETTINGS = {
    // Graphics
    quality: 'high',
    fpsCap: '60',            // '30' | '60' | 'unlimited'
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
    aimAssist: true,         // gentle slow-down + ADS snap near targets (strongest with touch)
    touchLook: 1.0,          // touch look speed
    fullscreen: null,        // null = automatic (on for phones), true / false = player's choice
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

// ── sanitising: anything read from a file or the cloud is untrusted ──
const int = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null);
// mission ids must already be valid integers: out-of-range values are DROPPED, never clamped (a corrupt 99 must not mark episode 6 complete)
const okId = (v, hi) => Number.isInteger(v) && v >= 1 && v <= hi;
const ids = (arr, hi) => [...new Set((Array.isArray(arr) ? arr : []).filter(v => okId(v, hi)))].sort((a, b) => a - b).slice(0, 64);
const strs = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter(v => typeof v === 'string' && v.length <= 64))].sort().slice(0, 200);   // sorted: merging is order-independent
function cleanStats(o) {
    const out = {};
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
        const id = Number(k);
        if (!okId(id, MAX_MISSION) || !v || typeof v !== 'object') continue;
        const s = {};
        for (const [sk, sv] of Object.entries(v)) if (typeof sv === 'number' && Number.isFinite(sv)) s[sk.slice(0, 24)] = sv;
        out[id] = s;
    }
    return out;
}
export function sanitizeCampaign(c) {
    c = c && typeof c === 'object' ? c : {};
    const completed = ids(c.completedMissions, MAX_MISSION);
    return {
        version: SAVE_VERSION,
        completedMissions: completed,
        currentMission: Math.max(int(c.currentMission, 1, MAX_MISSION) ?? 1, completed.length ? Math.min(MAX_MISSION, completed[completed.length - 1] + 1) : 1),
        missionStats: cleanStats(c.missionStats),
        collectedIntel: strs(c.collectedIntel),
        unlockedAttachments: strs(c.unlockedAttachments),
        lastPlayed: Number.isFinite(c.lastPlayed) ? c.lastPlayed : null
    };
}
/** Union of two campaigns: progress only ever moves forward, so a stale device can never erase a newer one. */
export function mergeCampaigns(a, b) {
    a = sanitizeCampaign(a); b = sanitizeCampaign(b);
    const completed = ids([...a.completedMissions, ...b.completedMissions], MAX_MISSION);
    const stats = { ...a.missionStats };
    for (const [id, s] of Object.entries(b.missionStats)) {
        if (!stats[id] || (s.accuracy || 0) > (stats[id].accuracy || 0)) stats[id] = s;     // keep the better run
    }
    return {
        version: SAVE_VERSION,
        completedMissions: completed,
        currentMission: Math.max(a.currentMission, b.currentMission),
        missionStats: stats,
        collectedIntel: strs([...a.collectedIntel, ...b.collectedIntel]),
        unlockedAttachments: strs([...a.unlockedAttachments, ...b.unlockedAttachments]),
        lastPlayed: Math.max(a.lastPlayed || 0, b.lastPlayed || 0) || null
    };
}
const newLocalId = () => {
    const b = new Uint8Array(3); (crypto && crypto.getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; }));
    return 'WF-' + [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
};

export class SaveManager {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this.campaign = { ...DEFAULT_CAMPAIGN };
        // player identity: a local ID from the first launch; replaced by one derived from the cloud account when signed in
        this.player = { id: '', uid: null, created: 0, settingsAt: 0 };
        this._listeners = new Set();
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
            const p = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
            if (p && typeof p.id === 'string') this.player = { ...this.player, ...p };
        } catch (e) { /* fall through: a new ID is made below */ }
        if (!this.player.id) { this.player.id = newLocalId(); this.player.created = Date.now(); this._savePlayer(); }

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
        this.player.settingsAt = Date.now();
        this._savePlayer();
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); }
        catch (e) { console.warn('Settings save failed', e); }
        this._emit('settings');
    }

    saveCampaign() {
        this.campaign.lastPlayed = Date.now();
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.campaign)); }
        catch (e) { console.warn('Campaign save failed', e); }
        this._emit('campaign');
    }

    _savePlayer() {
        try { localStorage.setItem(PLAYER_KEY, JSON.stringify(this.player)); } catch (e) { /* storage full / blocked */ }
    }

    /** Subscribe to local changes (used by the cloud sync). Returns an unsubscribe function. */
    onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
    _emit(kind) { for (const fn of this._listeners) { try { fn(kind); } catch (e) { console.warn(e); } } }

    /** Called by the cloud layer: the stable player ID shown in the UI follows the account. */
    setAccount(uid) {
        this.player.uid = uid || null;
        if (uid) this.player.id = 'WF-' + uid.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
        this._savePlayer();
    }

    // ── portable JSON save (file export, cloud storage) ──
    snapshot() {
        const settings = {};
        for (const k of SYNC_SETTINGS) settings[k] = this.settings[k];
        return {
            format: SAVE_FORMAT, version: SAVE_VERSION, playerId: this.player.id, savedAt: Date.now(),
            settingsAt: this.player.settingsAt || 0, campaign: sanitizeCampaign(this.campaign), settings
        };
    }

    /** Parse + validate a snapshot from a file or the cloud. Returns it cleaned, or null if it is not a Warfield save. */
    static parseSnapshot(raw) {
        let o = raw;
        if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (e) { return null; } }
        if (!o || o.format !== SAVE_FORMAT || typeof o.campaign !== 'object') return null;
        const settings = {};
        if (o.settings && typeof o.settings === 'object') {
            for (const k of SYNC_SETTINGS) {
                const v = o.settings[k], d = DEFAULT_SETTINGS[k];
                if (typeof v === typeof d && (typeof v !== 'number' || Number.isFinite(v))) settings[k] = v;
            }
        }
        return { format: SAVE_FORMAT, version: SAVE_VERSION, playerId: typeof o.playerId === 'string' ? o.playerId.slice(0, 16) : '',
            savedAt: Number.isFinite(o.savedAt) ? o.savedAt : 0, settingsAt: Number.isFinite(o.settingsAt) ? o.settingsAt : 0,
            campaign: sanitizeCampaign(o.campaign), settings };
    }

    /**
     * Merge a snapshot into the live state. Campaign progress is unioned; settings follow whichever side changed them last.
     * Returns { campaignChanged, changedSettings: [keys] } so the caller can refresh the UI and apply live settings.
     */
    applySnapshot(snap) {
        const before = JSON.stringify(sanitizeCampaign(this.campaign));
        const merged = mergeCampaigns(this.campaign, snap.campaign);
        const campaignChanged = JSON.stringify(sanitizeCampaign(merged)) !== before;
        if (campaignChanged) {
            this.campaign = { ...DEFAULT_CAMPAIGN, ...merged };
            try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.campaign)); } catch (e) { /* ignore */ }
        }
        const changedSettings = [];
        if ((snap.settingsAt || 0) > (this.player.settingsAt || 0)) {
            for (const [k, v] of Object.entries(snap.settings)) if (this.settings[k] !== v) { this.settings[k] = v; changedSettings.push(k); }
            if (changedSettings.length) {
                this.player.settingsAt = snap.settingsAt; this._savePlayer();
                try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
            }
        }
        return { campaignChanged, changedSettings };
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

    /** Short summary for the profile screen. */
    get progress() {
        const done = this.campaign.completedMissions.filter(id => id >= 1 && id <= MAX_MISSION).length;
        return { done, total: MAX_MISSION, intel: this.campaign.collectedIntel.length };
    }

    get hasSave() {
        return this.campaign.completedMissions.length > 0 || this.campaign.currentMission > 1;
    }
}

export const saveManager = new SaveManager();
