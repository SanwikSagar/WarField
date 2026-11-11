# Asset compression tools

`compress-assets.mjs` converts textures/models to GPU-compressed KTX2 (Basis ETC1S):

    cd tools && npm init -y && npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions sharp ktx2-encoder
    node compress-assets.mjs tex                          # public/assets/polyhaven/*.jpg -> public/assets/ktx2/*.ktx2
    node compress-assets.mjs glb in.glb out.glb 1024      # resize + KTX2 every texture inside a GLB

Textures named `*_diff` are encoded sRGB, `*_nor` as normal maps. Rows are flipped so they match
three.js' TextureLoader orientation. The runtime loaders live in `src/environments/AssetLoaders.js`
(transcoder files are in `public/assets/basis`).

## Environment distance budgets

All five missions use the shared policy in `src/environments/EnvironmentPolicy.js`.
Distances are metres and scale with the selected graphics preset. Override the
policy fields when calling `LevelBuilder.build(config, detail)`.

| Preset | View Range | Foliage Range | Shadow Casters | Weather | Reflections | Shadow Refresh |
|---|---:|---:|---:|---:|---:|---:|
| Low | 66 | 27.9 | 17.6 | 13.2 | 17.6 | 10 Hz |
| Medium | 78 | 32.9 | 20.8 | 15.6 | 20.8 | 10 Hz |
| High | 90 | 38 | 24 | 18 | 24 | 15 Hz |
| Ultra | 102 | 43.1 | 27.2 | 20.4 | 27.2 | 15 Hz |
| Extreme | 120 | 50.7 | 32 | 24 | 32 | 15 Hz |

- Trees: detailed and reduced geometry, baked four-view GPU impostors, then
    cylindrical billboards. On Low the tier boundaries are 13.2 / 27.9 / 44.9 / 66 m.
- Shrubs, scanned plants and rocks use the same instanced geometry/card pipeline.
    Nearby curved grass transitions to instanced texture cards and far billboards.
- Scenery: shared geometry batches, reduced geometry, compact-prop impostors and
    far billboards. Already-simple walls, roofs and flat surfaces retain solid
    geometry; changing them to independent cards would break the architecture.
- Terrain: 64 frustum-culled patches, three tessellation tiers, shared vertex
    buffers and full-resolution patch borders. Only near-overlapping patches
    receive shadows. Collision and raycast geometry remain independent of LOD.
- Shadow buckets separate nearby casters from distant visible instances. Shadow
    projections snap to texels and refresh on a budget rather than every frame.
- Reflections use the existing photographic environment map, not an additional
    scene render. Distant specular samples and water-ripple calculations are skipped;
    diffuse sky illumination remains active everywhere.

Impostor snapshots are baked once per level load and released on level disposal.
They approximate the lighting at capture time; they are not depth impostors.
Geometry/card tier transitions are discrete, while grass and weather ranges fade.

Half of GPU grass path candidates are redirected to the nearest verge using a
256x256 displacement map. Scanned plants alternate path-candidate relocation;
non-path placements stay unchanged. The verge mask also strengthens local grass
density. Nearby grass uses a smaller camera-wrapped area with a 0.55 ground-density
multiplier; extra fern, broad-leaf and litter layers are reduced further. Shrubs
retain the 1.2 density multiplier, while scanned plants also use a 0.75 multiplier.
Existing path and structure exclusions remain.

Nearby grass, fern and broad-leaf tufts use five curved blades (25 triangles),
while distant impostors remain two-triangle cards. Instance density is unchanged.

Built-in exponential-squared fog reaches approximately 93% opacity at the view
limit; no volumetric or screen-space fog pass is added. The camera far plane is
limited to the view range plus 8 m and restored when leaving the level. Texture
formats remain unchanged, retaining GPU-compressed KTX2 and HDR lighting data.

The foliage module and level builder are imported dynamically on deployment, not
at menu startup. `SceneManager.loadLevel()` is asynchronous and must be awaited.
Independent foliage, model and photographic-asset groups preload concurrently;
mission construction waits for all three groups and retains missing-asset fallbacks.

## Streaming

- Forest and backdrop counts use a 1.25 tree-density multiplier. Existing spacing,
    collisions, impostor tiers, render limits and shadow budgets stay in effect.
- `AssetStream.js` limits top-level GLB, KTX2 and HDR jobs to three concurrent
    requests, prioritizes base textures, and deduplicates matching in-flight URLs.
    Draco and Basis decoding each use at most two workers.
- Prop GLBs are selected from the current mission's prop/scatter definitions and
    foliage requirements instead of loading the entire prop catalogue.
- Photographic diffuse maps load before deployment. Normal-map detail requests
    start only when matching rendered surfaces are near the camera (20 m on High,
    scaled by preset), with one new request per 0.2-second update interval.
- Texture transforms are preserved when detail arrives. Late arrivals cannot
    modify a disposed level; per-material streamed copies are released on teardown.
- Inactive photographic sets are evicted above 12 cached sets, with active sets
    protected. At most two HDR entries remain after a level change, including
    missing-file entries. Common geometry/model templates remain cached for reuse.

This streams full compressed texture files and mission-scoped model requests;
it is not virtual-texture tile/mip streaming or open-world geometry-chunk loading.
Diffuse lighting and gameplay collision assets remain available before play.
Inspect `window.__WARFIELD__.sceneManager.level.getStreamingStats()` for request,
cache and proximity-detail counters.

Run `npm run test:environment` for range, terrain-border, shadow, reflection,
weather, raycast-preservation and renderer-state regression checks. Production
builds alone do not validate injected GLSL; verify shader linking in the browser.
