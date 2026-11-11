/**
 * Weapon definitions (GDD 5.3 / 11.6). Each entry fully describes handling
 * so the system stays data-driven: adding a gun means adding data, not code.
 * recoilPattern is a list of [pitch, yaw] kicks applied per successive shot,
 * looping — this gives each weapon a recognizable climb (GDD 5.2).
 */
export const WEAPON_DATA = {
    asr14: {
        id: 'asr14',
        modelId: 'urgi', adsRelief: 0.2, adsFovOverride: 40,
        name: 'URG-I SOCOM',
        category: 'Assault Rifle',
        magSize: 30,
        reserve: 180,
        fireRate: 0.095,        // seconds between shots (~630 rpm)
        damage: 26,
        headshotMult: 2.2,
        reloadTime: 2.1,
        auto: true,
        adsTime: 0.22,
        adsFov: 55,
        spreadHip: 0.022,
        spreadAds: 0.004,
        recoilPattern: [[0.020, 0.004], [0.024, -0.005], [0.018, 0.006], [0.026, -0.003], [0.020, 0.002]],
        recoilKick: 0.9,
        shake: 0.10,
        range: 120,
        sound: { sample: 'rifle', body: 850, crack: 3400, decay: 0.26, gain: 0.85 },
        model: { type: 'rifle', color: 0x2a2c2e, accent: 0x1a1b1d, length: 0.62 }
    },
    mp9: {
        id: 'mp9',
        modelId: 'm5scw', adsRelief: 0.26,
        name: 'M5 SCW',
        category: 'Carbine',
        magSize: 34,
        reserve: 204,
        fireRate: 0.062,        // ~970 rpm
        damage: 18,
        headshotMult: 1.8,
        reloadTime: 1.7,
        auto: true,
        adsTime: 0.16,
        adsFov: 62,
        spreadHip: 0.03,
        spreadAds: 0.009,
        recoilPattern: [[0.014, 0.006], [0.016, -0.007], [0.012, 0.005], [0.018, -0.004]],
        recoilKick: 0.65,
        shake: 0.07,
        range: 60,
        sound: { sample: 'rifle', rate: 1.08, body: 1100, crack: 4200, decay: 0.18, gain: 0.75 },
        model: { type: 'smg', color: 0x33363a, accent: 0x222427, length: 0.44 }
    },
    m870: {
        id: 'm870',
        name: 'M-870 Breacher',
        category: 'Shotgun',
        magSize: 6,
        reserve: 36,
        fireRate: 0.85,
        damage: 16,             // per pellet
        pellets: 8,
        headshotMult: 1.5,
        reloadTime: 0.55,       // per shell (shell-by-shell)
        fullReloadTime: 3.0,
        auto: false,
        adsTime: 0.28,
        adsFov: 60,
        spreadHip: 0.07,
        spreadAds: 0.045,
        recoilPattern: [[0.09, 0.01]],
        recoilKick: 2.4,
        shake: 0.35,
        range: 30,
        sound: { body: 500, crack: 2200, decay: 0.4, gain: 1.0 },
        model: { type: 'shotgun', color: 0x3a2e22, accent: 0x22201c, length: 0.7 }
    },
    m40: {
        id: 'm40',
        modelId: 'uar10', adsRelief: 0.26,
        name: 'UAR-10 Marksman',
        category: 'Sniper Rifle',
        magSize: 5,
        reserve: 30,
        fireRate: 1.3,
        damage: 95,
        headshotMult: 2.5,
        reloadTime: 2.8,
        auto: false,
        adsTime: 0.4,
        adsFov: 28,
        spreadHip: 0.06,
        spreadAds: 0.0005,
        recoilPattern: [[0.14, 0.01]],
        recoilKick: 3.0,
        shake: 0.5,
        range: 300,
        sound: { sample: 'rifle', rate: 0.86, body: 420, crack: 2600, decay: 0.6, gain: 1.1 },
        model: { type: 'sniper', color: 0x2e3328, accent: 0x1c1f18, length: 0.85 }
    },
    m1911: {
        id: 'm1911',
        modelId: 'g17', adsRelief: 0.34,
        name: 'G17 Gen5',
        category: 'Sidearm',
        magSize: 12,
        reserve: 96,
        fireRate: 0.16,
        damage: 32,
        headshotMult: 2.0,
        reloadTime: 1.5,
        auto: false,
        adsTime: 0.14,
        adsFov: 65,
        spreadHip: 0.02,
        spreadAds: 0.006,
        recoilPattern: [[0.03, 0.004], [0.026, -0.005]],
        recoilKick: 1.1,
        shake: 0.12,
        range: 50,
        sound: { sample: 'pistol', body: 1300, crack: 4600, decay: 0.2, gain: 0.7 },
        model: { type: 'pistol', color: 0x2c2e30, accent: 0x1a1b1c, length: 0.28 }
    }
};

/** Default loadout the player starts each mission with (GDD 5.3). */
WEAPON_DATA.ak74 = {
    ...WEAPON_DATA.asr14,
    id: 'ak74', modelId: 'ak74m', adsRelief: 0.2, adsFov: 58,
    name: 'AK-74M', category: 'Assault Rifle',
    fireRate: 0.092, damage: 29, spreadHip: 0.026, spreadAds: 0.005,
    recoilPattern: [[0.026, 0.006], [0.03, -0.008], [0.024, 0.009], [0.032, -0.006], [0.027, 0.004]],
    recoilKick: 1.1, shake: 0.13, reloadTime: 2.4,
    sound: { sample: 'ak', body: 760, crack: 3000, decay: 0.3, gain: 0.95 }
};

export const DEFAULT_LOADOUT = ['asr14', 'ak74', 'm1911'];

/** Attachment definitions (GDD 5.3) — cosmetic/stat modifiers. */
export const ATTACHMENTS = {
    suppressor: { name: 'Suppressor', slot: 'muzzle', soundGain: 0.45, spreadMult: 0.95, recoilMult: 0.9 },
    foregrip: { name: 'Foregrip', slot: 'underbarrel', recoilMult: 0.8, adsTimeMult: 1.05 },
    redDot: { name: 'Red Dot', slot: 'optic', adsFovBonus: 4, spreadAdsMult: 0.9 },
    scope4x: { name: '4x Scope', slot: 'optic', adsFovBonus: -10, spreadAdsMult: 0.6 },
    extendedMag: { name: 'Extended Mag', slot: 'magazine', magBonus: 10 }
};
