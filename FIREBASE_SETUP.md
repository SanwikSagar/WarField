# Cloud save with Firebase (about 10 minutes)

Warfield saves progress on the device first. Optionally it also keeps one small JSON file per player in
Firebase Storage, so progress follows the player between devices. Each player has a user ID
(shown in Settings → Profile) from Firebase Authentication: anonymous by default, or a Google account.

What gets stored: `users/<uid>/save.json` (campaign progress and a few preferences, a few KB).

## 1. Create the project
1. https://console.firebase.google.com → **Add project**.
2. **Build → Authentication → Get started → Sign-in method**: enable **Anonymous** and **Google**.
   Under *Settings → Authorized domains* add the domain you publish the game on (`localhost` is there already).
3. **Build → Storage → Get started** (production mode), pick a region.
   Note: Firebase may require the Blaze (pay-as-you-go) plan for new Storage buckets. Save files are tiny, so usage stays
   far inside the free quota.
4. **Project settings → Your apps → Web (`</>`)**: register an app and copy the config values.

## 2. Add the keys
```bash
cp .env.example .env.local     # then fill in the five values
```
These identify your project and are not secrets (the rules below control access). Restart `npm run dev`.
For a hosted build, set the same `VITE_FIREBASE_*` variables in the host's environment settings before building.

## 3. Publish the security rules (important)
Storage → **Rules** → paste the contents of [`storage.rules`](storage.rules) → **Publish**.
They allow each signed-in player to read and write only their own `users/<uid>/save.json` (JSON, under 200 KB) and block everything else.

## 4. Allow the game to download saves from the browser (CORS)
Edit [`cors.json`](cors.json) so `origin` lists your game's address(es), then run once with the Google Cloud SDK:
```bash
gsutil cors set cors.json gs://YOUR_BUCKET_NAME
```
(Bucket name is in Storage → Files, e.g. `your-project.firebasestorage.app`.) Without this, uploads work but loading a save on a new device fails.

## How it behaves
- Playing is never blocked: everything saves locally first; the cloud copy updates a few seconds after each change.
- Signing in on a new device merges the two saves (completed episodes and intel are combined, the better run is kept),
  so progress is never lost.
- **Guest** progress is tied to that browser. **Sign in with Google** (Settings → Profile) makes it portable.
- Players can export or import their save as a `.json` file from the same screen, and delete their cloud copy.
