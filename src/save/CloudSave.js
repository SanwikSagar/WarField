import { saveManager, SaveManager } from './SaveManager.js';
import { FIREBASE_CONFIG, isFirebaseConfigured } from './firebaseConfig.js';
import { globalEvents } from '../core/EventManager.js';

/**
 * Cloud save: each player's progress is one small JSON file in Firebase Storage,
 *   users/<uid>/save.json
 * The player gets a stable user ID from Firebase Authentication: anonymous at first (no sign-up, the
 * ID lives in this browser), upgradeable to a Google account so the same progress follows them to any device.
 *
 * Local-first: the game always plays from localStorage. The cloud layer
 *   - pulls on start-up / sign-in and MERGES (progress is a union, so nothing is ever lost),
 *   - pushes a few seconds after each local change (debounced, retried with back-off, resumed when back online),
 *   - and degrades silently to "saved on this device" when Firebase is not configured or unreachable.
 * The Firebase SDK is loaded on demand from Google's CDN (pinned version), only when configured.
 */
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const PUSH_DELAY = 2500;
const MAX_BYTES = 256 * 1024;

class CloudSave {
    constructor() {
        this.configured = isFirebaseConfigured();
        this.status = this.configured ? 'idle' : 'off';     // off | idle | connecting | syncing | synced | offline | error
        this.error = '';
        this.user = null;
        this.lastSync = 0;
        this._ls = new Set();
        this._timer = 0; this._retry = 0; this._retryN = 0;
        this._chain = Promise.resolve();
        this._dirty = false;
        this._started = false;
    }

    // ── state for the UI ──
    get playerId() { return saveManager.player.id; }
    get signedIn() { return !!this.user && !this.user.isAnonymous; }
    get accountLabel() {
        if (!this.configured) return 'This device only';
        if (!this.user) return 'Connecting…';
        return this.user.isAnonymous ? 'Guest (this browser)' : (this.user.email || this.user.displayName || 'Google account');
    }
    on(fn) { this._ls.add(fn); return () => this._ls.delete(fn); }
    _set(status, error = '') {
        this.status = status; this.error = error;
        for (const fn of this._ls) { try { fn(status); } catch (e) { console.warn(e); } }
    }

    // ── start-up ──
    async init() {
        if (!this.configured || this._started) return;
        this._started = true;
        this._set('connecting');
        try {
            const [app, auth, storage] = await Promise.all([
                import(/* @vite-ignore */ `${SDK}/firebase-app.js`),
                import(/* @vite-ignore */ `${SDK}/firebase-auth.js`),
                import(/* @vite-ignore */ `${SDK}/firebase-storage.js`)
            ]);
            this.A = auth; this.S = storage;
            this.app = app.initializeApp(FIREBASE_CONFIG);
            this.auth = auth.getAuth(this.app);
            this.storage = storage.getStorage(this.app);
            // react to sign-in / sign-out / account switches
            auth.onAuthStateChanged(this.auth, (u) => this._onUser(u));
            window.addEventListener('online', () => { if (this._dirty || this.status === 'offline' || this.status === 'error') this.sync(); });
            window.addEventListener('offline', () => this._set('offline'));
            document.addEventListener('visibilitychange', () => { if (document.hidden && this._dirty) this._flush(); });
            saveManager.onChange(() => this.markDirty());
        } catch (e) { this._fail(e); }
    }

    async _onUser(u) {
        if (!u) {                                    // signed out (or first run): continue as a guest
            this.user = null;
            try { await this.A.signInAnonymously(this.auth); } catch (e) { this._fail(e); }
            return;
        }
        const switched = !this.user || this.user.uid !== u.uid;
        this.user = u;
        saveManager.setAccount(u.uid);
        this._set(this.status === 'off' ? 'off' : this.status);   // refresh the UI with the new account label
        if (switched) await this.sync();
    }

    // ── sync ──
    _ref() { return this.S.ref(this.storage, `users/${this.user.uid}/save.json`); }

    /** Pull, merge, and push if anything differs. Safe to call any time; calls are serialised. */
    sync() {
        this._chain = this._chain.then(() => this._sync()).catch(() => {});
        return this._chain;
    }
    async _sync() {
        if (!this.configured || !this.user) return;
        if (!navigator.onLine) { this._set('offline'); return; }
        this._set('syncing');
        try {
            const remote = await this._download();
            let needsPush = !remote;
            if (remote) {
                const res = saveManager.applySnapshot(remote);
                for (const key of res.changedSettings) globalEvents.emit('setting_changed', { key, value: saveManager.settings[key] });
                if (res.campaignChanged || res.changedSettings.length) globalEvents.emit('save_applied', res);
                const mine = saveManager.snapshot();
                needsPush = JSON.stringify({ ...mine.campaign, lastPlayed: 0 }) !== JSON.stringify({ ...remote.campaign, lastPlayed: 0 })
                    || mine.settingsAt > (remote.settingsAt || 0);
            }
            if (needsPush) await this._upload();
            this._dirty = false; this._retryN = 0; this.lastSync = Date.now();
            this._set('synced');
        } catch (e) { this._fail(e); this._backoff(); }
    }

    async _download() {
        try {
            const bytes = await this.S.getBytes(this._ref(), MAX_BYTES);
            return SaveManager.parseSnapshot(new TextDecoder().decode(bytes));
        } catch (e) {
            if (e && e.code === 'storage/object-not-found') return null;     // first sync for this player
            throw e;
        }
    }
    async _upload() {
        const json = JSON.stringify(saveManager.snapshot());
        await this.S.uploadString(this._ref(), json, 'raw', { contentType: 'application/json', cacheControl: 'no-store' });
    }

    markDirty() {
        if (!this.user) { this._dirty = true; return; }
        this._dirty = true;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._flush(), PUSH_DELAY);
    }
    _flush() {
        clearTimeout(this._timer);
        if (!this._dirty || !this.user) return;
        this._chain = this._chain.then(async () => {
            if (!navigator.onLine) { this._set('offline'); return; }
            this._set('syncing');
            try { await this._upload(); this._dirty = false; this._retryN = 0; this.lastSync = Date.now(); this._set('synced'); }
            catch (e) { this._fail(e); this._backoff(); }
        }).catch(() => {});
    }
    _backoff() {
        clearTimeout(this._retry);
        this._retryN = Math.min(this._retryN + 1, 6);
        this._retry = setTimeout(() => this.sync(), Math.min(300000, 8000 * 2 ** this._retryN));
    }

    // ── account actions (Settings → Profile) ──
    async signInWithGoogle() {
        if (!this.auth) throw new Error('Cloud save is not available.');
        const A = this.A, provider = new A.GoogleAuthProvider();
        try {
            if (this.user && this.user.isAnonymous) await A.linkWithPopup(this.user, provider);     // keeps the same uid + progress
            else await A.signInWithPopup(this.auth, provider);
        } catch (e) {
            if (e && (e.code === 'auth/credential-already-in-use' || e.code === 'auth/email-already-in-use')) {
                const cred = A.GoogleAuthProvider.credentialFromError(e);      // this Google account already has a save: switch to it (merged)
                if (!cred) throw e;
                await A.signInWithCredential(this.auth, cred);
            } else throw e;
        }
        this.user = this.auth.currentUser;
        saveManager.setAccount(this.user.uid);
        await this.sync();
    }
    async signOut() {
        if (!this.auth) return;
        await this.A.signOut(this.auth);          // the auth listener starts a fresh guest session
    }
    /** Remove this player's file from the cloud (local progress is untouched). */
    async deleteCloudSave() {
        if (!this.user) return;
        try { await this.S.deleteObject(this._ref()); } catch (e) { if (!e || e.code !== 'storage/object-not-found') throw e; }
        this.lastSync = 0; this._set('idle');
    }

    friendly(e) {
        const c = (e && e.code) || '';
        if (/popup-closed|cancelled-popup/.test(c)) return '';
        if (c === 'auth/operation-not-allowed' || c === 'auth/admin-restricted-operation') return 'Sign-in is not enabled for this Firebase project (turn on Anonymous and Google in Authentication).';
        if (c === 'auth/popup-blocked') return 'The sign-in window was blocked. Allow pop-ups for this site and try again.';
        if (c === 'auth/unauthorized-domain') return 'This site is not in Firebase Authentication → Authorized domains.';
        if (c === 'storage/unauthorized' || c === 'storage/unauthenticated') return 'The Storage rules refused the request (publish storage.rules).';
        if (c === 'storage/retry-limit-exceeded' || c === 'auth/network-request-failed') return 'Cannot reach the server. Progress is saved on this device and will sync later.';
        return (e && e.message ? String(e.message) : 'Unknown error').slice(0, 140);
    }
    _fail(e) {
        console.warn('Cloud save:', e);
        this._set(navigator.onLine ? 'error' : 'offline', this.friendly(e));
    }
}

export const cloud = new CloudSave();
