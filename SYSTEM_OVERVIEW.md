# unstil life — system overview (current implementation)

This document describes what is **actually implemented** in the codebase right
now. It is the companion to the project description (Sections 1–3 of the
seminar document) and can be used to check one against the other.
`architecture_plan.md` holds the original plan and early design decisions; it
is kept as a record and is no longer up to date.

---

## 0. Project description vs. implementation

Point-by-point check of the project description (Section 1 "Topic", Section 2
"Technical Approach", Figure 2, Tables 1–2) against the code.

### Built as described ✅

| Description | In code |
|---|---|
| Room: six `PlaneGeometry` meshes, inward normals, ambient + directional light, `PCFSoftShadowMap` | `src/scene/room.js`, `src/scene/lighting.js`, `src/setup/renderer.js` |
| Space: `BoxGeometry` skybox, back-side rendering, six cube map images | `src/scene/space.js` (3 skybox sets, plus a solid colour and uploads) |
| Stars: `BufferGeometry` points at random positions | `src/scene/stars.js` (with a small canvas-drawn star texture) |
| Objects: GLB via `GLTFLoader`, `MeshStandardMaterial`, measured and rescaled on load | `src/objects/objectsSetup.js` (`targetHeight` per object), table in `src/objects/tableSetup.js` |
| Dissolve: 3D Simplex noise injected before compiling, world space for the room walls, local space for the table and objects, threshold → discard | `src/effects/dissolve.js` (`injectDissolve`, `addMeshDissolve`), after the Codrops technique |
| Particles: point primitives sampled from the object's own triangles (area-weighted), same noise, visible only near the dissolve edge, scattered by a velocity attribute | `src/effects/dissolveParticles.js` (`makeParticlePoints`) |
| Floating: `P = P_initial + f·(H + A⊙sin(ω·t + φ))`, `f` a smoothstep starting at p = 0.2, per-object `H` and `φ`, vertical table collision | `src/effects/floating.js`; `H` and `φ` (`phaseOffset`) per object in `OBJECT_DEFS`; `A` and `ω` are shared by all objects |
| Scroll accumulated into `p` (0–1), driving dissolve, floating, lighting, sound | `src/scene/phaseMachine.js` (owns `uProgress`) |
| Four states room / space / dissolving / done; during the dissolve, time drives it and scroll is blocked | `src/scene/phaseMachine.js`, timer in `src/scene/dissolveTimeline.js` (5 s) |
| Objects replaced while invisible; scrolling home re-forms them in reverse | `applyReturnObjects` in `src/objects/objectSwap.js`; `followScroll` in `dissolveTimeline.js` |
| Orbit camera angle-bounded in the room, free with zoom in space | `src/setup/cameraControls.js` |
| Automatic journey: key P plays the whole cycle (Figure 2, Section 1) | `src/scene/journey.js` (see §5) |
| Lighting: warm room light fades, the objects take on the light and colour of space | `src/scene/lighting.js`, presets in `src/scene/space.js`, environment map in `main.js` (see §7) |
| Sound: café ambience, gain `1 − p`, silence in space, a dissolve sound | `src/audio/ambientSound.js` |
| Audio unlock on the first `pointerdown` / `keydown` (Table 2) | `src/audio/ambientSound.js` (also retried on `wheel`, which browsers refuse) |

### Details worth knowing ⚠️

| Description says | Code detail |
|---|---|
| (4) "The objects dissolve into particles" | The dissolve starts when the viewer presses **Dissolve** (GUI, enabled in space) or when the journey reaches it. It does not start by itself. |
| "the disappearance of objects" | The table dissolves together with the objects, over the same 5 s. |
| "new objects appear on the table" | Each return swaps the teddy (ribbon ↔ skeleton), the flower (tulip ↔ daffodil) and the stone (agate ↔ fluorite); the mannequin alternates its finish (wood ↔ walnut). The vase stays. |

### Beyond the description ➕

- **Selective particle glow** (`src/effects/particleBloom.js`): optional
  "shiny" particles with a bloom pass on the particles only (GUI toggle, off
  by default).
- **Background motion** (§8): a curl-noise swirl on the skybox and a synced
  rotation of the stars (GUI toggle).
- **Table system** (§9): GLB / Box / Cylinder / uploaded table, swappable live.
- **Uploads in the debug panel**: own skybox (PNG, JPG, WebP, AVIF, GIF, BMP,
  TGA, with clear messages for unsupported or damaged files), table, stone,
  room textures, sounds.
- **Shader warm-up and preloading**: every shader is compiled behind the
  loading screen and the returning models are loaded at startup, so nothing
  stalls mid-journey.
- **Adaptive quality**: the resolution drops on slow machines to keep the
  frame rate (`src/setup/renderer.js`).

---

## 1. High-level flow

```
page load
  → loading screen ("Unstil Life" text dissolving into particles, while the
    models load and the shaders are compiled)
  → interactive scene unlocks (scroll, drag, key P); the top line reads
    "press P to begin the journey (auto play)"
      'room'       — scroll up dissolves the room, objects start to float
      'space'      — free orbit and zoom; the Dissolve button is enabled
      'dissolving' — table and objects dissolve together over 5 s, scroll blocked
      'done'       — scroll down re-forms the room and the (new) objects
```

The journey (key P) drives the same path by itself; see §5.

## 2. The five phases of the project description

| Phase | Description | Status |
|---|---|---|
| 1 | Room with soft lighting and shadows, objects on the table | **Done**: vase with tulips, teddy bear, wooden mannequin, stone, round table |
| 2 | The environment transforms into space, objects rise | **Done** |
| 3 | Outer space, objects float weightlessly | **Done** |
| 4 | Objects dissolve into particles, leaving empty space | **Done**: all together over 5 s, started by the Dissolve button or the journey |
| 5 | The room reforms, new objects appear | **Done**: the objects re-form in reverse as the room returns, partly as new models (see §0) |

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
                                dissolve
  dissolveParticles.js         the dissolve particles: settings, particle shader
                                (makeParticleMaterial), where they start (sampled
                                over a model's surface) and fly; makeParticlePoints
  noise.js                     shared 3D Simplex noise GLSL (Ashima Arts)
  skyboxFlow.js                curl-noise "Starry Night" swirl on the skybox
  particleBloom.js             selective glow on the particles (the one post-process)
  floating.js                  per-frame float/bob/sway of the objects, table
                                collision (the bear's legs: objects/skeletonPose.js)

src/scene/                     the scenes: what is in them and how they change
  room.js                      6-plane room (floor/ceiling/4 walls)
  space.js                     skybox (3 packs + solid colour + upload),
                                LIGHTING_PRESETS keyed by skybox name
  skyboxUpload.js              reading an uploaded skybox folder: matching files
                                to the 6 faces, explaining seams
  stars.js                     the star field, turning with the skybox swirl
  lighting.js                  ambient/directional lights, room↔space colour
                                lerp, objects-only key light, volumetric beam
  phaseMachine.js              room/space/dissolving/done and the scroll: owns
                                uProgress, decides when the dissolve runs
  dissolveTimeline.js          the object dissolve itself: 5 s timer, pause,
                                scrub, shadows, re-forming on the way home
  journey.js                   P / "Play Journey": the whole artwork plays by
                                itself (room, into space, slow orbit, dissolve,
                                back home); any scroll or drag stops it

src/objects/                   the table and the still life
  tableSetup.js                sets up whichever table is picked: its shape
                                (from the two files below or table.glb), then
                                dissolve, particles, floor placement, swapping;
                                loadScene (table first, then the objects on it)
  builtinTable.js              the Box/Cylinder tables, built with three.js:
                                colour, textures, floor contact shading
  customTable.js               normalising an uploaded table (scale, centre,
                                strip ground planes)
  objectsSetup.js              the 5 still-life objects: loading, placement on
                                the table, dissolve, particles
  skeletonPose.js              posing a model by its skeleton (for now only the
                                teddy): legs folded sitting on the table,
                                hanging once it floats
  objectSwap.js                swapping models: stone choice, the objects that
                                change on each return, the mannequin's finish;
                                the return models are loaded at startup and kept
                                hidden, so a swap never loads mid-journey
  modelCleanup.js              removing a model and freeing its GPU memory

src/audio/
  ambientSound.js              room/space beds, dissolve one-shot

src/ui/
  loadingScreen.js             "Unstil Life" text, particle-dissolve intro
  gui.js                       lil-gui debug panel: builds it from ui/gui/
  gui/                         one file per panel section (playback buttons,
                                Scene, Dissolve Look, Scene Contents + skybox,
                                Room Textures, Sound, Objects/Camera) and
                                controls.js, the shared building blocks
  topHint.js                   the one line at the top: "press P to begin the
                                journey" with "(auto play)" under it, or "click anywhere
                                to turn on sound" if someone scrolls while the
                                sound is off
  screenHint.js                a fading line of text over the scene (for topHint)
  perfHud.js                   fps readout
```

## 4. Dissolve shader (room, table, still-life objects)

One shared technique (`injectDissolve` in `dissolve.js`), injected via
`onBeforeCompile` into the models' own materials: a 3D Simplex noise field is
compared against a threshold that sweeps from -1.2 to 1.2 as the progress
uniform goes 0→1; fragments below the threshold are discarded, with a thin
edge band at the boundary (dark for the room, white for the objects). Room
walls use *world*-space noise (dissolves in place) and read `uProgress`
directly; the table and objects use *local*-space noise (the pattern rides
with the object as it floats) and each has its own progress uniform. The
dissolve timeline (`dissolveTimeline.js`) moves all of them together over
`dissolveDuration` (5 s, GUI slider), can pause and scrub, and on the way home
sets them from `p`, so the objects re-form in step with the room.

The table and each object also get dissolve particles
(`makeParticlePoints` in `dissolveParticles.js`), sampled from their own
geometry and visible only in a narrow band around the current dissolve edge.
The room has no particles (a deliberate choice).

## 5. The journey (auto play)

`src/scene/journey.js`. Key P or the GUI button "▶ Play Journey" plays the
whole cycle without input, as a list of steps:

| Step | Length | What it does |
|---|---|---|
| room | 4 s | glides the camera back to the start view if the viewer looked around |
| to space | 6 s | moves the scroll target 0 → 1 |
| look around | 8 s | the camera starts one slow swing around the scene |
| dissolve | 5 s | presses Dissolve; the swing follows the dissolve's progress |
| emptiness | 8 s | the swing turns back (rests only 3 frames, while the new models appear) |
| home | 6 s | moves the scroll target 1 → 0, the swing ends at the start view |
| arrive | until p ≈ 0 | holds the start view |

It drives the same controls a viewer would (`phaseMachine.setScrollTarget`,
`triggerDissolve`), so every effect reacts exactly as it does to scrolling.
Any scroll or drag stops it and hands control back.

## 6. Painting intro (removed)

A painting-to-scene intro used to play before interaction unlocked. It had been
switched off for some time and was removed in October 2026; it remains in the
git history (`src/render/paintingIntro.js`).

## 7. Lighting model

- **Room** (fixed): warm ambient fill (`0x3d2010`, intensity 0.4 — raised from
  an earlier 0.15 after "too dark" feedback) + a single warm directional key
  light (`0xffe8b0`, intensity 2.6) with shadows, matching a Rembrandt-style
  raking-light photo reference. A fake volumetric light beam (additive-blended
  cone) fades out in the first 40% of the room→space scroll.
- **Space** (per-background preset, `LIGHTING_PRESETS` in `space.js`):
  - `space_blue` / `space_red` / `sky`: ambient 0.7, tinted with the skybox's
    measured colour (mixed with white by "Background Tint", 0.65), and a strong
    white directional light (5.4): the sun does most of the work.
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
  the sun (p = 0.45 → 0.9), so it is 0 in the room. (An earlier `RoomEnvironment` attempt was
  reverted because it also lit the room; the fade-in avoids that.) It replaced
  a Fresnel "rim tint" that mixed one average colour into object outlines.
  Note: the table top and the vase are marked fully metallic in their GLB
  files, so they show the strongest reflections.

## 8. Background motion (beyond the description)

A GUI toggle ("🌀 Animate Background") eases in (`uFlowStrength` in
`skyboxFlow.js`) a curl-noise UV warp on the skybox texture — inspired by
Petros Vrellis' animated *Starry Night* — plus a synced slow rotation of the
star field (same eased strength, so both read as one swirling motion). Edge
fade prevents seams at the skybox cube's face borders.

## 9. Table system (beyond the description)

A second GUI dropdown ("Table") lets the table be swapped live between the
default GLB, a plain Box, a Cylinder, or a **user-uploaded custom `.glb`**
file (via a hidden file input + `URL.createObjectURL`). Swapping keeps the
existing still-life objects in place and just shifts them by the surface-height
delta, rather than reloading everything (`setTable()` in `objects/tableSetup.js`).

## 10. Camera behavior

- Room-mode: azimuth/polar clamped to keep the camera inside the room and
  above the floor (derived from the room's geometry). Space-mode: free orbit.
- During the room→space scroll, the camera automatically pulls back
  (`ZOOM_OUT_EXTRA`) and raises its gaze with the objects (`GAZE_RISE`; the
  camera and its target move up together, so the flat-on view of the table is
  kept), starting exactly when objects begin floating (`FLOAT_START`), so they
  stay in frame as they rise.
  This is computed as a pure function of scroll progress `p` from a
  camera-offset snapshot taken at startup — an earlier version re-derived the
  offset from the previous frame's camera position, which fed back on itself
  and made the camera run away into a bird's-eye view; this was fixed.
- In space, zoom is enabled until the viewer zooms back in close to the
  original room framing, at which point scroll switches back to
  restoring the room.

## 11. Known open items / tradeoffs worth flagging

- The debug GUI (lil-gui) is the only way to change the skybox, table,
  background motion and the Dissolve button; there is no end-user UI for these.
  Viewers without it still have scroll, drag and the journey (key P).
- The perf HUD's `calls`/`tris` readout is wrong while shiny particles are on
  (several render passes per frame); fps/ms stay correct.
- `architecture_plan.md` is the original plan, kept as a record; this document
  is the current state.

## 12. Tech stack

Three.js r0.169, Vite 5, GLSL via `onBeforeCompile`, GLTFLoader, OrbitControls,
lil-gui, Web Audio API. ESLint 9 (`npm run lint`). Deployed to GitHub Pages via
GitHub Actions.
