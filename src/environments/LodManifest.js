/**
 * Offline-reduced model files (tools/simplify-props.mjs writes /assets/models/lod-manifest.json):
 * small and medium assets <= 1000 triangles, large ones <= 6000. Fetched once per session.
 */
import { assetUrl } from '../utils/assetUrl.js';

let manifest = null;
export function lodManifest() {
    if (!manifest) {
        manifest = fetch(assetUrl('/assets/models/lod-manifest.json'))
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null)
            .then(m => ({ props: (m && m.props) || {}, war: (m && m.war) || {} }));
    }
    return manifest;
}
