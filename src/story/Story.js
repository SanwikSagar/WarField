import { MISSIONS } from '../environments/biomes.js';

/**
 * WARFIELD story bible for the live campaign. The campaign ships as monthly
 * episodes: MISSIONS (biomes.js) holds the released ones, UPCOMING the ones
 * still in production. Adding next month's episode = move it from UPCOMING
 * to MISSIONS, give it a SCRIPT entry here, done.
 *
 * Scripts are keyed by story beat, not by time, so lines always land on the
 * moment they describe:
 *   intro      — spoken over the opening cinematic
 *   start      — first lines once the player has control
 *   objectives — { <objectiveIndex>: [...] } fired when that objective completes
 *   outro      — spoken over the closing cinematic
 *   cinematicBeats — objective indexes whose lines play as an in-mission cutscene
 *   teaser     — end-of-episode sting (shown after the outro, sets up next month)
 * A line may carry { radio: true } (squelch + filtered styling) and { pause } (extra seconds after).
 */

export const SEASON = {
    number: 1,
    title: 'OPERATION BLACKOUT',
    cadence: 'NEW EPISODE EVERY MONTH',
    tagline: 'A conspiracy that reaches the top of command. One squad who refuses to look away.'
};

export const UPCOMING = [
    { episode: 7, code: '07', title: 'Ashes of Veyra', region: 'Veyra Outskirts', release: '2026-12-01',
      blurb: 'An old military band. A voice everyone thought was gone. Kane was never the top.' },
    { episode: 8, code: '08', title: 'Classified', region: 'Unknown', release: '2027-01-01',
      blurb: 'Redacted by Varencian Command.' }
];

export const SPEAKERS = {
    MERCER:    { name: 'Capt. Alex Mercer', role: 'Squad Lead', color: '#d5dde6' },
    HAYES:     { name: 'Lt. Daniel Hayes', role: 'Commander', color: '#ee9b3a' },
    MAYA:      { name: 'Maya Brooks', role: 'Intel / Comms', color: '#5cc8e6' },
    ETHAN:     { name: 'Ethan Cole', role: 'Medic', color: '#8fd26a' },
    REYES:     { name: 'Sgt. Ana Reyes', role: 'Veyra City Guard', color: '#e87a8c' },
    KANE:      { name: 'Gen. Victor Kane', role: 'Unknown Frequency', color: '#e04a3a' },
    OVERWATCH: { name: 'Overwatch', role: 'Command', color: '#a9b4bf' },
    UNKNOWN:   { name: 'Unknown', role: 'Old Military Band', color: '#c9b37a' },
    SYSTEM:    { name: 'System', role: '', color: '#8c949b' }
};

export function speakerInfo(id) {
    const key = String(id || '').toUpperCase();
    return SPEAKERS[key] || { name: key, role: '', color: '#e8a33d' };
}

/** "Previously on WARFIELD" recap shown in each episode briefing. */
export const RECAPS = {
    1: 'Varencia is fracturing. Captain Alex Mercer\'s squad is sent after a recon team that stopped transmitting six hours ago.',
    2: 'Recon Two was erased, not ambushed — and the casings left behind were military issue. Someone inside command is arming the enemy.',
    3: 'The convoy manifest carried an authorization code Hayes recognised: General Victor Kane, his former commander.',
    4: 'Proof of Kane\'s operation was recovered in the Frostland — but the ridge exploded and Hayes was taken. Transfer logs point to the Deadzone.',
    5: 'Hayes is free, and Kane\'s endgame has a name: Operation Blackout. At midnight every screen in Varencia goes dark.',
    6: 'The broadcast went out and Kane is in custody. Hayes held the control room alone and has not been seen since. Now Kane\'s loyalists have taken Veyra City.'
};

export const SCRIPT = {
    1: {
        cinematicBeats: [1],
        intro: [
            { speaker: 'HAYES', text: 'Comms went dark six hours ago. Whatever hit Recon Two, they never called for help.' },
            { speaker: 'MAYA', text: 'Last ping came from the old outpost, two klicks north. Faint, but it\'s there.' },
            { speaker: 'ETHAN', text: 'Stay sharp. This forest doesn\'t feel empty.' }
        ],
        start: [{ speaker: 'HAYES', text: 'Mercer, take point. Let\'s bring them home.' }],
        objectives: {
            0: [
                { speaker: 'MAYA', text: 'No bodies. No vehicles. Just their gear, left where it fell.' },
                { speaker: 'HAYES', text: 'Find that recording. Recon always keeps a backup.' }
            ],
            1: [
                { speaker: 'MAYA', text: 'These casings are military grade. Not insurgent stock. Someone supplied them.' },
                { speaker: 'HAYES', text: 'That\'s something we\'re not supposed to know about. Get us out of here.' },
                { speaker: 'ETHAN', text: 'Contacts moving in from the treeline!' }
            ]
        },
        outro: [
            { speaker: 'HAYES', text: 'Recon Two didn\'t vanish. They were erased.' },
            { speaker: 'MAYA', text: 'Then whoever did it made a mistake. They left a trail.' }
        ]
    },
    2: {
        cinematicBeats: [2],
        intro: [
            { speaker: 'MAYA', text: 'Supply convoy runs this route in ten minutes. We watch, we learn.' },
            { speaker: 'ETHAN', text: 'Heat\'s playing tricks out here. Keep your water close.' }
        ],
        start: [{ speaker: 'HAYES', text: 'Eyes on the road, Mercer.' }],
        objectives: {
            0: [
                { speaker: 'HAYES', text: 'They hit it before we got here. Everyone, move up!' },
                { speaker: 'ETHAN', text: 'Two survivors in the wreck. Still breathing.' },
                { speaker: 'MAYA', text: 'The stolen crates are tagged for an industrial facility east of here.' }
            ],
            1: [{ speaker: 'MAYA', text: 'Manifest office should be inside. Cover me while I pull the records.' }],
            2: [
                { speaker: 'MAYA', text: 'Authorization code on the manifest traces to senior command.' },
                { speaker: 'HAYES', text: 'I know that code. I served under him.' },
                { speaker: 'HAYES', text: 'Not over an open channel. Not yet.' }
            ]
        },
        outro: [
            { speaker: 'MAYA', text: 'Victor Kane. Your old commander, Hayes?' },
            { speaker: 'HAYES', text: 'Once. Before he decided this war needed a different ending.' }
        ]
    },
    3: {
        cinematicBeats: [1],
        intro: [
            { speaker: 'MAYA', text: 'This installation was decommissioned eight years ago. Someone forgot to tell the generators.' },
            { speaker: 'HAYES', text: 'I\'m on the ridge with overwatch. You two are my eyes inside.', radio: true },
            { speaker: 'ETHAN', text: 'Visibility\'s dropping. Stay close, Mercer.' }
        ],
        objectives: {
            0: [{ speaker: 'HAYES', text: 'Records room should be on the lower level. Maya, get that data.', radio: true }],
            1: [
                { speaker: 'MAYA', text: 'It\'s all here. Kane authorized every attack. He\'s destabilizing Varencia on purpose.' },
                { speaker: 'HAYES', text: 'I saw operations like this before. I stayed quiet. I thought it would never surface.', radio: true },
                { speaker: 'ETHAN', text: 'Explosion on the ridge! Hayes, respond!' },
                { speaker: 'MAYA', text: 'His signal\'s gone. Get to extraction, now!' }
            ]
        },
        outro: [
            { speaker: 'MAYA', text: 'Transfer logs mention a detention site in the Deadzone.' },
            { speaker: 'ETHAN', text: 'Then that\'s where they took him. We\'re going in after him.' }
        ]
    },
    4: {
        cinematicBeats: [1],
        intro: [
            { speaker: 'MAYA', text: 'The Frostland transfer records point here. Hayes could be inside that detention block.' },
            { speaker: 'ETHAN', text: 'Checkpoint ahead is dug in. We go through the buildings, not the street.' }
        ],
        start: [{ speaker: 'MAYA', text: 'Mercer, you have the lead. Quiet as you can.' }],
        objectives: {
            0: [{ speaker: 'ETHAN', text: 'Checkpoint\'s clear. Detention block is west, the brick building.' }],
            1: [
                { speaker: 'HAYES', text: 'Mercer? Took you long enough. They were going to execute me in an hour.' },
                { speaker: 'HAYES', text: 'Kane is activating the final stage. Operation Blackout goes live tonight.' },
                { speaker: 'MAYA', text: 'Then we take the communications HQ. Hayes, can you shoot?' },
                { speaker: 'HAYES', text: 'Give me a rifle and find out.' }
            ]
        },
        outro: [
            { speaker: 'HAYES', text: 'Every screen in Varencia goes dark at midnight. Unless we get there first.' }
        ]
    },
    5: {
        cinematicBeats: [1],
        intro: [
            { speaker: 'MAYA', text: 'This is the heart of it. Kane is running Blackout from inside that building.' },
            { speaker: 'HAYES', text: 'Get Maya to the broadcast array. I\'ll hold the control room.' }
        ],
        objectives: {
            0: [
                { speaker: 'MAYA', text: 'I\'m in. Upload\'s started. I need time. Defend this position!' },
                { speaker: 'ETHAN', text: 'Power\'s out! Emergency lighting only. Watch your corners.' }
            ],
            1: [
                { speaker: 'HAYES', text: 'System restored. Go, Mercer. I\'ve got this. Get Kane.', radio: true },
                { speaker: 'KANE', text: 'You were always loyal to the wrong things, Daniel.', radio: true }
            ],
            2: [
                { speaker: 'ETHAN', text: 'Hayes isn\'t responding. He held the line.' },
                { speaker: 'MAYA', text: 'Broadcast complete. The whole country is watching. Kane is in custody.' }
            ]
        },
        outro: [
            { speaker: 'MERCER', text: 'Some missions are about winning. Others are about what you\'re willing to lose.' }
        ]
    },
    6: {
        cinematicBeats: [1],
        intro: [
            { speaker: 'MAYA', text: 'Kane\'s in a cell, but his loyalists have taken Veyra City. They want the blackout to look like civil collapse.' },
            { speaker: 'REYES', text: 'Sergeant Ana Reyes, City Guard. Glad you came. We\'re out of everything but stubbornness.' },
            { speaker: 'ETHAN', text: 'Movement between the apartment blocks. Keep it tight.' }
        ],
        start: [{ speaker: 'REYES', text: 'Civilians are sheltering in the west hall. Market Street first, then we go get them.' }],
        objectives: {
            0: [
                { speaker: 'REYES', text: 'This was the market district. Now it\'s a firing range. Stay off the open street.' },
                { speaker: 'MAYA', text: 'West hall is past the next cross street. Low brick building.' }
            ],
            1: [
                { speaker: 'REYES', text: 'They\'re here. Eleven of them, two wounded. I\'ll bring them out, you clear the road north.' },
                { speaker: 'MAYA', text: 'City\'s broadcasting again. Every street we take back gives Varencia a chance.' }
            ]
        },
        outro: [
            { speaker: 'ETHAN', text: 'Checkpoint secure. Civilians are through.' },
            { speaker: 'MERCER', text: 'The war didn\'t end when Kane fell. It ends when people can go home.' },
            { speaker: 'MAYA', text: 'Mercer, I\'m picking up something on an old military band. It\'s repeating.' },
            { speaker: 'UNKNOWN', text: 'Mercer... if you can hear this... Kane was never the top...', radio: true },
            { speaker: 'MAYA', text: 'That voice. That\'s Hayes.' }
        ]
    }
};

export function getScript(missionId) { return SCRIPT[missionId] || { intro: [], objectives: {}, outro: [] }; }

// ── release schedule helpers ────────────────────────────────────────────
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function formatRelease(iso) {
    const d = new Date(iso + 'T00:00:00');
    return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Newest released episode (gets the NEW badge for its first month). */
export function latestEpisode() { return MISSIONS[MISSIONS.length - 1]; }

export function isNewEpisode(mission, now = new Date()) {
    if (mission !== latestEpisode()) return false;
    const rel = new Date(mission.released + 'T00:00:00');
    return now - rel < 45 * 86400000;
}

export function nextEpisode() { return UPCOMING[0] || null; }

/** { days, hours, minutes } until the next episode drops, or null once it's out. */
export function countdownTo(iso, now = new Date()) {
    const ms = new Date(iso + 'T00:00:00') - now;
    if (ms <= 0) return null;
    return { days: Math.floor(ms / 86400000), hours: Math.floor(ms / 3600000) % 24, minutes: Math.floor(ms / 60000) % 60 };
}
