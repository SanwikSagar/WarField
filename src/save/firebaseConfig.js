/**
 * Firebase web-app configuration, read from Vite env vars (see .env.example and FIREBASE_SETUP.md).
 * These values identify your Firebase project; they are NOT secrets (access is controlled by
 * storage.rules and Authentication), so it is fine for them to ship in the built game.
 * Left empty, cloud save is simply off and progress stays on the device.
 */
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const FIREBASE_CONFIG = {
    apiKey: env.VITE_FIREBASE_API_KEY || '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: env.VITE_FIREBASE_PROJECT_ID || '',
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
    appId: env.VITE_FIREBASE_APP_ID || ''
};

export const isFirebaseConfigured = () =>
    !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId && FIREBASE_CONFIG.storageBucket && FIREBASE_CONFIG.appId);
