# unstil life — system overview (current implementation)

This document describes what is **actually implemented** in the codebase right
now, as a companion to `architecture.md` (which records the original
concept/decisions from early development and is no longer fully up to date —
most of what's below was added after it). Use this to check the current build
against the original project proposal/concept.

---

## 0. Proposal check: Technical Approach (Section 2) vs. implementation

Point-by-point comparison against the submitted technical proposal
("2 Technical Approach", Figure 2 + Tables 1–4).

### Built as proposed ✅

| Proposal item | Status in code |
|---|---|
| Room: six `PlaneGeometry` meshes, inward normals, ambient + directional light, `PCFSoftShadowMap` | Exactly as proposed (`src/scene/room.js`, `src/scene/lighting.js`, `src/setup/renderer.js`) |
| Space: `BoxGeometry` skybox, back-side rendering, cube map textures | Exactly as proposed (`src/scene/environment.js`) |
| Stars: `BufferGeometry` particles, randomized positions, procedural texture | Exactly as proposed |
| Objects imported as GLB via `GLTFLoader` | Exactly as proposed (`src/objects/table.js`, `src/objects/stageObjects.js`) |
| Dissolve effect: 3D Simplex noise injected via `onBeforeCompile`, world-space noise for room walls / local-space for objects, threshold comparison → fragment discard | Exactly as proposed, line-for-line the Codrops technique cited in the proposal (`src/effects/dissolve.js`) |
| Object particle effect: `Points` geometry, same Simplex noise, visible only near the dissolve boundary, scattered outward by a velocity attribute | Exactly as proposed |
| Floating formula `P = P_initial + p·(H + A⊙sin(ω·t))`, per-object variation in `H`, `A`, `ω` | Exactly as proposed (`src/effects/floating.js`) |
| Scroll → shared progress parameter `p` (0–1) as master state driving dissolve, lighting, floating | Exactly as proposed (`src/scene/phaseMachine.js`) |
| At `p = 1`: scroll disabled, object dissolution proceeds via elapsed time | As proposed (triggered by a GUI button rather than automatically — minor difference) |
| `OrbitControls`, bounded rotation while `p < 1`, bounds removed + zoom at `p = 1` | Exactly as proposed (`src/setup/cameraControls.js`) |
| Lighting transition: warm interior fades, cold space light strengthens, driven by `p` | As proposed, extended with per-background presets (see §6) |
| Sound: ambient café atmosphere, gain interpolated by `p` via the Web Audio API | As proposed (`src/audio/ambientSound.js`, `asset/sound/cafe.m4a` from Freesound) — full volume in the room, fading to silence in space. Extended with a GUI sound picker (Café / None / user-uploaded custom audio) and volume slider. Starts on the first click/key gesture (browser autoplay policy — wheel doesn't count as an activation, so scroll alone can't unlock audio). |

### Deviations from the proposal ⚠️

| Proposal said | What the code actually does |
|---|---|
| "Imported materials are replaced with `MeshStandardMaterial` to enable dissolve shader injection across all objects" | Materials are **cloned**, not force-replaced — `GLTFLoader` already yields `MeshStandardMaterial` for standard glTF materials, so the end state matches for 4 of 5 objects without an explicit replace step. The glass cup is a deliberate exception: its transmission-based material rendered black in this dim scene, so it is replaced with a hand-tuned semi-transparent `MeshPhysicalMaterial`. The *purpose* (dissolve injection on every object) is fulfilled for all objects. |
| Object dissolution starts automatically when `p` reaches 1 | Dissolution is armed at `p = 1` but starts on a GUI button click ("▶ Dissolve Objects") — a deliberate UX choice to give the viewer a moment in space first. |

### Proposed but NOT implemented ❌

| Proposal item | Status |
|---|---|
| **Phase 5 reappearance** — "new objects appear by running each object's dissolve progress in reverse"; reverse scroll "display[s] a different set of pre-loaded objects" | **Not implemented.** After the dissolve timeline completes, stage objects are permanently removed from the scene; only the table returns on scroll-back. There is no second object set and no reverse-dissolve reappearance. |

### Implemented beyond the proposal ➕

Not in the proposal at all — added during development:

- **Background motion** (§7): GUI-toggleable curl-noise swirl on the skybox
  texture + synced star-field rotation (Vrellis *Starry Night* reference).
- **Table system** (§8): live-swappable table geometry (default GLB / Box /
  Cylinder / user-uploaded custom GLB) from a GUI dropdown.
- **Per-background lighting presets + fresnel rim tint** (§6): lighting adapts
  to the selected background; object edges pick up the surrounding color.
- **Module refactor** (§3): the single-file app was split into modules, since
  regrouped (Oct 2026) by what each part is in the artwork: setup, effects,
  scene, objects, ui, audio.

---

## 1. High-level flow

```
page load
  → loading screen (particle-dissolve "Unstil Life" text, while GLBs load)
  → interactive scene unlocks (scroll + orbit)
      'room'       — scroll dissolves the room, revealing space
      'space'      — orbit/zoom freely; "Dissolve Objects" button arms
      'dissolving' — objects vanish one by one, automatically, over ~18s
      'done'       — scroll re-enabled, room can reform
```

## 2. Status vs. the original 5-phase plan (from `architecture.md`)

| Phase | Description | Status |
|---|---|---|
| 1 | Room with soft lighting, objects on table | **Done** — real GLB still-life objects (vase, tulip, cup, wooden dummy, teddy), not placeholders anymore |
| 2 | Scroll → environment dissolves, objects rise | **Done** |
| 3 | Full space, objects float weightlessly | **Done** |
| 4 | Objects disappear one by one (timer-based) | **Done** — sequential dissolve with particle bursts |
| 5 | Room reforms, new objects appear | **Partial** — room reforms on scroll-back; no *new* objects introduced yet |

Beyond the original plan, several features were added that aren't in
`architecture.md` at all (sections 4–8 below).

## 3. Module architecture

The original single 1300-line `main.js` was split into `src/`, organized by
concern. `main.js` is now a thin orchestrator that wires these together and
runs the animation loop.

```
main.js                        orchestrator: creates renderer/scene/camera,
                                wires every module below, runs animate()

src/setup/                     the machinery for viewing the scene
  renderer.js                  WebGLRenderer + camera + resize + adaptive quality
  cameraControls.js            OrbitControls setup, zoom hand-off,
                                auto zoom-out/tilt during the room→space scroll

src/effects/                   visual effects (GPU shaders, post-process, floating)
  dissolve.js                  dissolve shader injection (see §4), shadow-pass
                                dissolve, particle shaders
  dissolveParticles.js         where the dissolve particles start (sampled over
                                a model's surface) and fly; makeParticlePoints
  noise.js                     shared 3D Simplex noise GLSL (Ashima Arts)
  skyboxFlow.js                curl-noise "Starry Night" swirl on the skybox
  particleBloom.js             selective glow on the particles (the one post-process)
  floating.js                  per-frame float/bob/sway of the objects, table
                                collision (the bear's legs: objects/teddyLegs.js)

src/scene/                     the scenes: what is in them and how they change
  room.js                      6-plane room (floor/ceiling/4 walls)
  environment.js               skybox (3 packs + solid colour + upload), stars,
                                LIGHTING_PRESETS keyed by skybox name
  lighting.js                  ambient/directional lights, room↔space colour
                                lerp, objects-only key light, volumetric beam
  phaseMachine.js              room/space/dissolving/done, scroll handling,
                                dissolve timeline (pause/scrub), object swap

src/objects/                   the table and the still life
  table.js                     the table: loading, swapping, dissolve, particles;
                                loadScene (table first, then the objects on it)
  plinth.js                    the Box/Cylinder tables: colour, textures, floor
                                contact shading
  customTable.js               normalising an uploaded table (scale, centre,
                                strip ground planes)
  stageObjects.js              the 5 still-life objects: loading, placement on
                                the table, dissolve, particles
  teddyLegs.js                 the skeleton bear's legs: sitting on the table,
                                hanging once it floats
  objectVariants.js            swapping models: stone choice, the objects that
                                change on each return, the mannequin's finish

src/audio/
  ambientSound.js              room/space beds, dissolve one-shot

src/ui/
  loadingScreen.js             "Unstil Life" text, particle-dissolve intro
  gui.js                       lil-gui debug panel (all dropdowns/buttons)
  perfHud.js, soundHint.js     fps readout, "click for sound" hint
```

## 4. Dissolve shader (room, table, stage objects)

One shared technique (`injectDissolve` in `dissolve.js`), injected via
`onBeforeCompile` into `MeshStandardMaterial`/`MeshPhysicalMaterial`: a 3D
Simplex noise field is compared against a threshold that sweeps from -1.2 to
1.2 as the object's own progress uniform goes 0→1; fragments below the
threshold are discarded, with a thin glowing edge band at the boundary. Room
walls use *world*-space noise (dissolves in place); table/objects use
*local*-space noise (pattern rides with the object as it floats). Each
dissolving thing (room, table, each of the 5 objects) owns its own progress
uniform so they can be sequenced independently — driven by `phaseMachine.js`'s
`'dissolving'` phase timeline (tulip/vase/cup at 0s/0s/3s, dummy at 5s, teddy
at 10s, table last at 15s, each over 3s).

Every dissolving surface also gets a particle burst (`objectParticleVertexShader`
in `dissolve.js`) sampled from its own geometry, visible only in a narrow band
around the current dissolve edge.

## 5. Painting intro (removed)

A painting-to-scene intro used to play before interaction unlocked. It had been
switched off for some time and was removed in October 2026; it remains in the
git history (`src/render/paintingIntro.js`).

## 6. Lighting model

- **Room** (fixed): warm ambient fill (`0x3d2010`, intensity 0.4 — raised from
  an earlier 0.15 after "too dark" feedback) + a single warm directional key
  light (`0xffe8b0`, intensity 2.6) with shadows, matching a Rembrandt-style
  raking-light photo reference. A fake volumetric light beam (additive-blended
  cone) fades out in the first 40% of the room→space scroll.
- **Space** (per-background preset, `LIGHTING_PRESETS` in `environment.js`):
  - `space_blue` / `space_red` / `sky`: ambient stays low, directional climbs — moody,
    high-contrast, "the sun does all the work" look.
  - `None (solid color)`: no ambient; the environment map (below) lights the
    objects evenly with the background colour, so a dark colour gives dark
    objects. Weak directional key (1.2). The colour is live (`voidColor`, white
    by default, GUI swatch).
  - Switching the "Skybox" GUI dropdown updates both together
    (`selectBackground()` in `main.js`) and takes effect **immediately**
    even if not currently mid-scroll.
- **Environment map** (`scene.environment`, built in `main.js` with
  `PMREMGenerator.fromScene` from the current skybox or flat colour, rebuilt
  whenever the background changes): objects reflect their real surroundings,
  sharply on glossy or metal parts and as soft light on matte ones. Its
  strength (`environmentMap.strength`, GUI "Env Map Strength") fades in with
  the sun, so it is 0 in the room. (An earlier `RoomEnvironment` attempt was
  reverted because it also lit the room; the fade-in avoids that.) It replaced
  a Fresnel "rim tint" that mixed one average colour into object outlines.
  Note: the table top and the vase are marked fully metallic in their GLB
  files, so they show the strongest reflections.

## 7. Background motion (not in the original plan)

A GUI toggle ("🌀 Animate Background") eases in (`uFlowStrength` in
`skyboxFlow.js`) a curl-noise UV warp on the skybox texture — inspired by
Petros Vrellis' animated *Starry Night* — plus a synced slow rotation of the
star field (same eased strength, so both read as one swirling motion). Edge
fade prevents seams at the skybox cube's face borders.

## 8. Table system (not in the original plan)

A second GUI dropdown ("Table") lets the table be swapped live between the
default GLB, a plain Box, a Cylinder, or a **user-uploaded custom `.glb`**
file (via a hidden file input + `URL.createObjectURL`). Swapping keeps the
existing stage objects in place and just shifts them by the surface-height
delta, rather than reloading everything (`setTable()` in `objects/table.js`).

## 9. Camera behavior

- Room-mode: azimuth/polar clamped to keep the camera inside the room and
  above the floor (derived from the room's geometry). Space-mode: free orbit.
- During the room→space scroll, the camera automatically pulls back
  (`ZOOM_OUT_EXTRA`) and tilts its gaze upward (`LOOK_UP_EXTRA`, via the
  look-at target rising faster than the camera itself) starting exactly when
  objects begin floating (`FLOAT_START`), so they stay in frame as they rise.
  This is computed as a pure function of scroll progress `p` from a
  camera-offset snapshot taken at startup — an earlier version re-derived the
  offset from the previous frame's camera position, which fed back on itself
  and made the camera run away into a bird's-eye view; this was fixed.
- In space, zoom is enabled until the viewer zooms back in close to the
  original room framing, at which point scroll switches back to
  restoring the room.

## 10. Known open items / tradeoffs worth flagging

- **Glass cup material**: currently a hand-tuned semi-transparent
  `MeshPhysicalMaterial` (icy-blue tint, opacity 0.30), not the GLB's real
  transmission-based glass. True transmission was tried and rejected — in
  this dim, single-key-light room, transmission (which shows whatever's
  literally behind the object) reads as near-black, and boosting environment
  reflections didn't fix it without a brighter/more detailed backdrop. The
  current material is the practical compromise; it reads a bit "plasticky"
  up close. Two follow-up ideas discussed but not implemented: (a) hybrid
  opacity + transmission, (b) a small dedicated light near the cup just to
  guarantee a highlight from the usual camera angle.
- **`architecture.md`** is stale relative to this document — it predates the
  module refactor and everything in §5–8. Worth deciding whether to fold this
  file into it, replace it, or keep both (historical decisions vs. current
  state).
- Debug GUI (lil-gui) is currently the *only* way to change skybox/table/
  background-motion — there's no polished end-user UI for these yet.

## 11. Tech stack (unchanged from `architecture.md`)

Three.js r0.169, Vite, GLSL via `onBeforeCompile`, GLTFLoader, OrbitControls.
Deployed to GitHub Pages via GitHub Actions.
