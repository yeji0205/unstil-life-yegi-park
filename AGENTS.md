# AGENTS.md — Unstill Life

System prompt for any AI agent working on this codebase.
Read this fully before making any changes.

---

## Project Overview

A scroll-driven Three.js web application that transitions a classical Still Life room into
cosmic space. One scalar parameter `uProgress` (0↔1) drives all scene transitions.
Single entry point: `main.js` — all logic lives in one file currently.

**Live:** https://yeji0205.github.io/unstil-life-yegi-park/
**Run locally:** `npm run dev` (Vite dev server)
**Build:** `npm run build` → deploys via GitHub Actions to GitHub Pages

---

## Hard Rules — Never Violate

- **NEVER use `BoxGeometry` for the room.** Normals point outward — `DirectionalLight`
  calculates `dot(normal, lightDir)` as negative → room goes black. Use 6 individual
  `PlaneGeometry` meshes with manually rotated inward-facing normals instead.

- **NEVER use `ShaderMaterial` for lit objects.** `ShaderMaterial` does not respond to
  Three.js lights. Always use `MeshStandardMaterial` + `onBeforeCompile` to inject
  custom GLSL while keeping PBR lighting.

- **NEVER write noise functions in JavaScript.** Dissolve noise must run on the GPU
  per-fragment. Use the existing `NOISE_GLSL` string constant (`snoise3`) — do not
  import JS noise libraries.

- **NEVER add a room particle system.** Room dissolve is shader-only (no particles).
  Particles are reserved for object disappearance only.

- **NEVER change `uProgress` during the `dissolving` or `done` phase** — scroll is
  blocked intentionally. Death is uncontrollable (artistic decision).

---

## Architecture

### Single file structure
Everything is in `main.js`. Sections in order:
1. Renderer + Scene + Camera
2. Skybox (space environment)
3. Stars
4. `NOISE_GLSL` constant (shared by all shaders)
5. Shared dissolve uniforms (`uProgress`, `uDissolveEdge`, `uNoiseFreq`, `uDissolveEdgeColor`)
6. `makeRoomMaterial(hex)` — dissolve shader factory
7. Room planes (6× PlaneGeometry)
8. Lighting
9. Cylinder + dissolve shader + particles
10. OrbitControls + scroll state machine
11. Animate loop

### Key files
```
main.js          — scene assembly + animation loop; picks the render path
src/render/particleBloom.js — the scene's only post-process (see below)
index.html       — minimal shell, loads main.js
vite.config.js   — sets base: '/unstil-life-yegi-park/' for GitHub Pages
public/asset/    — the ONLY asset tree. Vite serves public/ at the site root in
  model/           dev AND copies it to dist/ on build, so one copy works for
  skybox/          both. There used to be a second tree at ./asset/ and forgetting
    space_blue/    to mirror into public/ was a recurring deploy bug.
    space_red/
    sky/           — 6 PNGs each: right/left/top/bottom/front/back.png
                     Folder name IS the dropdown label and the LIGHTING_PRESETS
                     key, so renaming a folder means renaming both.
  texture/         — PBR sets, one folder per material
  sound/
  image/
source/blend/    — Blender authoring files. Deliberately outside public/ so they
                   are never deployed; only their exported textures ship.
```

To add a skybox: drop the folder in `public/asset/skybox/`, rename its faces to
the six words above, then add the folder name to `SKYBOX_OPTIONS` and a matching
entry to `LIGHTING_PRESETS` (both in `src/geometry/environment.js`).

---

## Central State: uProgress

```
uProgress = 0.0  → room fully visible
uProgress = 1.0  → room fully dissolved, space visible
```

`uProgress` controls simultaneously:
- Dissolve threshold in room wall shaders
- Ambient + directional light intensity and color lerp
- Floating amplitude for all objects
- Camera orbit limits (room constraints vs full freedom)

**Do not add new state variables if `uProgress` can drive the behaviour directly.**

---

## Phase State Machine

```
'room'       → scroll changes uProgress 0→1
'space'      → uProgress=1, zoom enabled, 5s timer
'dissolving' → scroll BLOCKED, objects dissolve over 3s (timer)
'done'       → scroll re-enabled, user can restore room
```

Variables: `phase` (string), `phaseStart` (clock time), `scrollBlocked` (boolean).
Reset to `'room'` when `uProgress` drops below 0.95.

---

## Dissolve Shader Pattern

Always inject into `MeshStandardMaterial` via `onBeforeCompile`:

```javascript
mat.onBeforeCompile = (shader) => {
    shader.uniforms.uProgress = uProgress; // or per-object uniform
    // inject NOISE_GLSL + uniforms at top of fragmentShader
    // replace '#include <dithering_fragment>' to run dissolve AFTER PBR lighting
};
mat.customProgramCacheKey = () => uniqueKey; // required — prevents shader reuse
```

**Room:** uses `vWorldPos` (world space) — noise pattern fixed in world.
**Objects:** uses `vLocalPos` (local space) — noise pattern fixed on object as it floats.

Threshold formula: `mix(-1.2, 1.2, progress)` — the ±1.2 range slightly exceeds
Simplex noise output (-1 to 1) so dissolve starts/ends cleanly.

---

## Object Particle System Pattern

For each object:
1. Sample N positions on object surface in local space → `Float32Array`
2. Generate outward velocity per particle → `aVelocity` attribute
3. Create `THREE.Points` with `ShaderMaterial` sharing same `NOISE_GLSL` + progress uniform
4. **Attach as `object.add(particles)`** — particles follow object automatically
5. Use `AdditiveBlending`, `depthWrite: false`
6. Particle color: **white** `0xffffff` (separate from room edge color)
7. **Every particle `Points` object must be created via `makeParticlePoints()`**
   (glbLoader), which puts it on `PARTICLE_BLOOM_LAYER`. A `new THREE.Points`
   built by hand is invisible to the bloom pass and will silently never glow.
8. Two selectable appearances, switched live by the `uParticleShiny` uniform
   (`✨ Shiny Particles` button in the GUI): `0` = flat evenly-lit white dots
   (the default and the fast path), `1` = the Codrops demo's shiny look.
   Shiny is **two** things, and neither works alone:
   - **Selective bloom** (`src/render/particleBloom.js`) does all the work. A
     point sprite can only fill its own quad, so a "glow" drawn inside one just
     makes fatter dots — tried, and that is exactly what it looked like. Glow
     has to spread onto NEIGHBOURING pixels, which needs a post-process.
   - **The sprite stays a plain soft point of light**: one smooth radial
     gaussian, peaking just above white, with a mild per-particle stretch.

   Do NOT copy the demo's `particle.png` shape here. It is a ragged elongated
   wisp, which works because it emits a few hundred LARGE wisps; this scene
   emits 200–2000 specks a few pixels across, and at that size any shape with
   structure (a dash, a plus, a star) is just a recognisable little GLYPH —
   a thousand identical stamps rather than a dissolving object. Two failed
   attempts, in order: a core+halo+glint cross (read as fat dots), then a
   rotating streak plus a crossing one (read as a square with a dark X in it,
   because it also clipped).

   Two traps in the sprite, both learned the hard way:
   - Keep peak brightness barely over 1.0. It only has to clear the bloom
     threshold; brighter just clips flat across the sprite and the soft point
     becomes a hard white slab.
   - The stretch is applied as `q.x / stretch, q.y * stretch` (constant area),
     so the effective long:short ratio is **stretch squared**. 1.35 → ~1.8:1.

   Per-particle randomness is HASHED from the particle's own `position` rather
   than stored as an attribute, so the shared geometry builder needs no extra
   buffer (and no per-frame upload, unlike the demo).

Particles appear only within `uEdge * 1.5` band around dissolve threshold.

---

## Floating Animation Formula

$$P = P_\text{initial} + p \cdot (H + A \odot \sin(\omega\, t))$$

- `p` = uProgress (scales entire effect — no float when room visible)
- `t` = `clock.getElapsedTime()` (continuous oscillation)
- `H` ∈ ℝ³ — upward rise, **varies per object**
- `A` ∈ ℝ³ — per-axis amplitude, **varies per object**
- `ω` ∈ ℝ³ — per-axis frequency, **varies per object**

Per-object variation ensures independent drift. Always scale by `p` so objects
only float when room is dissolving.

---

## Lighting

`renderer.outputColorSpace = THREE.SRGBColorSpace` (gamma corrected).

| | Room | Space |
|---|---|---|
| AmbientLight intensity | 0.7 | 0.0 |
| DirectionalLight intensity | 1.05 | 3.5 |
| DirectionalLight color | `#fff5e0` (warm) | `#ffffff` (pure white) |

Lerped each frame: `THREE.MathUtils.lerp(roomVal, spaceVal, p)`.
Ambient color also lerps from warm white → deep blue as `p` increases.

---

## Camera

- `PerspectiveCamera` FOV 35°, position `(0, 1.0, 4)`, target `(0, -2.5, -1)`
- Orbital radius ≈ 6.1 units
- `ROOM_RETURN_DIST = 7.0` — threshold for zoom→room-restore handoff

| Mode | Azimuth | Polar | Zoom |
|---|---|---|---|
| Room | ±0.55π | 0.1π – 1.65 rad | off |
| Space | unlimited | 0 – π | on (2–200 units) |

`hasZoomedOut` flag: prevents room from reappearing immediately when dissolve
completes (camera starts inside ROOM_RETURN_DIST threshold).

---

## Naming Conventions

Follow Clean Code principles — names must be descriptive and unambiguous.

| Pattern | Rule | Example |
|---|---|---|
| Uniforms | always prefix `u`, full descriptive name | `uProgress`, `uDissolveEdge`, `uNoiseFreq`, `uDissolveEdgeColor` |
| Per-object uniforms | `u` + ObjectName + Property | `uCylinderProgress`, `uCylinderTime` |
| Particle color | `uParticleColor` (shared name across objects) | `uParticleColor` |
| Constants | SCREAMING_SNAKE_CASE, fully spelled out | `CYLINDER_RADIUS`, `CYLINDER_PARTICLE_COUNT`, `ROOM_RETURN_DIST` |
| Geometry | descriptive + `Geometry` suffix | `cylinderParticleGeometry`, `starGeometry` |
| Materials | descriptive + `Material` suffix | `cylinderMat`, `cylinderParticleMaterial` |
| Shaders | descriptive + `VertexShader` / `FragmentShader` | `cylinderParticleVertexShader` |
| Three.js instances | full descriptive name, no abbreviation | `directionalLight`, `textureLoader` |
| Phase timing | `phaseStart` (clock seconds), `phase` (string) | — |

**GLSL uniform names** (inside shader strings) must match the key in `shader.uniforms`:
- JS variable `uDissolveEdge` → `shader.uniforms.uEdge = uDissolveEdge` (key stays `uEdge`)
- Only rename the GLSL uniform name itself if it exists in a custom `ShaderMaterial` (not `onBeforeCompile`)

---

## Planned (Not Yet Implemented)

- Load 4 GLB models via `GLTFLoader` (tulip/vase, teddy bear, doll, water glass)
- Per-object `H`, `A`, `ω` variation for independent floating
- Sequential object dissolve (one per object, 3s gap between each)
- Phase 5: room reforms, new objects appear (reverse dissolve)
- Web Audio API: café ambient fade with `uProgress`, per-object disappearance sounds

## Debug GUI (lil-gui)

A `lil-gui` debug panel is always present. Comment out the `gui` block before final release.
Controls: `uProgress`, `uDissolveEdge`, `uNoiseFreq`, edge color RGB, ambient/directional intensity.
Loose top-level buttons (the ones you press rather than adjust): dissolve trigger,
background motion, and the flat/shiny particle A/B toggle.

## What NOT to implement without discussion

- Do not restructure into multiple files without confirming (single file is preferred for AI context)
- Do not add physics engine — floating is purely mathematical (sinusoidal)
- Do not use CSS or HTML elements for UI — canvas only
- Do not add post-processing without confirming. There is now exactly ONE
  post-process — the selective particle bloom in `src/render/particleBloom.js` —
  and it is opt-in, only rendering while shiny particle mode is on. Do not move
  it onto the default path, and do not add a second (FXAA, DOF, vignette)
  without asking.
- **NEVER route the on-screen render through an `EffectComposer`.** This scene
  has several ADDITIVE layers (volumetric light cone, star field, particles).
  Rendering straight to canvas blends them on sRGB-encoded values; a composer's
  linear half-float target blends them in linear space, and the sRGB encode at
  the end then lifts every dark pixel. Measured cost of getting this wrong: the
  whole frame washed out by R +7 / G +14 / B +17 of 255 with no particles even
  on screen. It also silently discards the canvas MSAA. `particleBloom.js`
  therefore renders the base frame with a plain `renderer.render()` and adds
  only the glow, as an additive full-screen quad. The painting-intro note in
  main.js is the same trap ("made the volumetric lighting look off").
- Known cosmetic limitation: the perf HUD's `calls`/`tris` readout is wrong while
  shiny mode is on, because `renderer.info` resets per `render()` call and the
  composer makes several. The fps/ms figures are still correct (they're timed
  from the animation loop, not from `renderer.info`).
- Do not add `DRACOLoader` unless GLB files were explicitly exported with Draco compression
