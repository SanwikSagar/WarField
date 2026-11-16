import * as THREE from '/node_modules/three/build/three.module.js';

/**
 * Global shader conventions, applied once before any program is compiled.
 *
 * Physically plausible albedo: nothing in the real world reflects much more than ~65-70 % of
 * the light that hits it (fresh white paint, snow is the exception at ~80 %). Flat-colour assets
 * routinely ship pure white, which under daylight exposure blows out into featureless patches
 * (crosswalks, lamp posts, signs). Capping the base colour of every lit (Standard / Physical)
 * material keeps whites readable and lets bloom pick out real light sources only.
 * roughnessmap_fragment exists only in the PBR shaders, so sprites, UI and unlit effects
 * (muzzle flashes, fire, tracers) are untouched.
 */
const CAP = 0.66;
if (!THREE.ShaderChunk.roughnessmap_fragment.includes('ALBEDO_CAP')) {
    THREE.ShaderChunk.roughnessmap_fragment =
        `/* ALBEDO_CAP */ diffuseColor.rgb = min(diffuseColor.rgb, vec3(${CAP.toFixed(2)}));\n` + THREE.ShaderChunk.roughnessmap_fragment;
}
