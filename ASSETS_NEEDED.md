# Assets still needed (all can be found under open / CC0 / CC-BY licences)

Already in the game: Poly Haven CC0 textures + HDRI skies (brick, concrete, corrugated iron, rusty metal,
wood planks, forest ground, leaf litter, mud, gravel, sand, snow, asphalt), EZ-Tree trees, your 4 character
models (3 used) + fern/reed models. Everything else is still procedural placeholder geometry.

## 1. Highest priority (biggest realism gain)
| Asset | Why | Where to look |
|---|---|---|
| **First-person weapon models** (assault rifle, pistol, sniper, SMG) with separate mag/bolt/slide, ideally rigged with reload/draw/fire clips | Weapons are still boxes | Sketchfab (filter CC0/CC-BY, "rigged"), Quaternius, OpenGameArt |
| **Character animation clips**: idle, walk, run, strafe, crouch walk, aim idle, fire, reload, hit reaction, 3-4 death anims, grenade throw | Animation is procedural right now | Mixamo (free; download "Without skin", FBX->GLB), Kenney, Quaternius |
| **Properly rigged versions of `army_character_1/2`** (Mixamo auto-rigger) and the female character with PBR (metal-rough) textures instead of spec-gloss | They use an auto-generated rig; the female model's textures don't load | mixamo.com auto-rigger, or re-export from Sketchfab as glTF |
| **Sound effects**: gunshots per weapon, suppressed shots, bullet impacts (dirt/metal/concrete/flesh), footsteps per surface, reloads, explosions, voice barks/radio chatter | `public/assets/audio` is empty - sound is synthesized | freesound.org (CC0), Sonniss GDC audio bundles, OpenGameArt |
| **Music**: ambient menu theme, tense combat loops, mission-complete sting | Same | incompetech.com, OpenGameArt, Pixabay Music |

## 2. Environment
| Asset | Notes |
|---|---|
| Scanned/hero trees: spruce, pine, birch, dead trees, stumps, logs | Poly Haven models, Quaternius "Ultimate Nature", Sketchfab CC0. Also leaf/needle alpha atlases |
| Plant atlases + models: ferns, bushes, flowers, mushrooms, moss, nettles, dry grass, desert shrubs, snow-covered shrubs | Poly Haven plants, Quaternius |
| Cliff / boulder / rock-wall scans (4-6 variants, plus a snow version and a sand version) | Poly Haven models |
| Full PBR sets (diffuse + normal + **roughness + AO + displacement**) for ground, rock, moss, wet mud, snow, cracked asphalt, rubble | Poly Haven, ambientCG (both CC0). Roughness/AO maps are not wired in yet |
| Modular building kit: walls, doors, windows, roofs, stairs, interior props | Kenney "Modular Buildings", Quaternius, Sketchfab CC0 |
| Industrial + military props: generators, antennas/radio masts, fuel tanks, tents, cots, barrels, pallets, sandbags, hesco, watch-tower, bunkers, signs | Kenney, Quaternius, Poly Haven |
| Vehicles: military truck, jeep, APC, wrecks, civilian cars | Sketchfab CC0, Quaternius |
| Decals: bullet holes (per material), blood, scorch, tyre tracks, footprints, grime, puddle ripple normal map | ambientCG decals, OpenGameArt |
| Extra HDRIs (dusk, night, storm) for mission variety | Poly Haven |

## 3. Effects
Muzzle-flash sprite sheet, smoke/dust/steam sprite sheets, sparks, tracer streak, shell casings, explosion + fire sprite sheet, rain splash sprites (Kenney "Particle Pack", OpenGameArt).

## 4. UI / story
Fonts (e.g. Rajdhani / Oswald / Share Tech Mono from Google Fonts), HUD icons (weapons, grenades, medkit, compass), crosshair variants, mission/intel illustrations, character portraits for Hayes / Maya / Ethan / Kane, voice-over lines (record or use a free TTS pass for prototypes).

## 5. Tooling I used (free)
Poly Haven API (CC0), gltf-transform, sharp, ktx2-encoder (Basis), three.js loaders (Draco / KTX2 / GLTF / RGBE).
See `tools/README.md` to run the compression pipeline on anything you add.

## Licence housekeeping
Keep a credits list for CC-BY items (Sketchfab, Mixamo terms, Incompetech). CC0 needs no credit but is nice to list.
Your Sketchfab character/grass downloads: check each page's licence and add the author credit if it is CC-BY.
