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
5. Shared dissolve uniforms (`uProgress`, `uEdge`, `uFreq`, `uEdgeColor`)
6. `makeRoomMaterial(hex)` — dissolve shader factory
7. Room planes (6× PlaneGeometry)
8. Lighting
9. Cylinder + dissolve shader + particles
10. OrbitControls + scroll state machine
11. Animate loop

### Key files
```
main.js          — entire application
index.html       — minimal shell, loads main.js
vite.config.js   — sets base: '/unstil-life-yegi-park/' for GitHub Pages
public/asset/
  skybox_blue/   — 6 cube map PNGs (bkg1_right/left/top/bot/front/back.png)
```

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

| Pattern | Example |
|---|---|
| Shared uniforms | `uProgress`, `uEdge`, `uFreq`, `uEdgeColor` |
| Per-object uniforms | `uCylinderProgress`, `uCylinderTime` |
| Per-object particle color | `uCylParticleColor` |
| Geometry constants | `CYL_RADIUS`, `CYL_P_COUNT` |
| Phase timing | `phaseStart` (clock seconds), `phase` (string) |

---

## Planned (Not Yet Implemented)

- Load 4 GLB models via `GLTFLoader` (tulip/vase, teddy bear, doll, water glass)
- Per-object `H`, `A`, `ω` variation for independent floating
- Sequential object dissolve (one per object, 3s gap between each)
- Phase 5: room reforms, new objects appear (reverse dissolve)
- Web Audio API: café ambient fade with `uProgress`, per-object disappearance sounds

## What NOT to implement without discussion

- Do not restructure into multiple files without confirming
- Do not add physics engine — floating is purely mathematical (sinusoidal)
- Do not use CSS or HTML elements for UI — canvas only
- Do not add post-processing (bloom, FXAA) without confirming
