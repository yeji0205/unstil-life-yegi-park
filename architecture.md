# unstil life — architecture

## concept

A scroll-driven scene transition: a classical Still Life room gradually dissolves into cosmic
space using a noise-based dissolve shader. Objects float weightlessly as the room disappears.
The viewer interacts by scrolling (room ↔ space transition) and orbiting/zooming (in space).

---

## scenes

### room
- **Geometry:** 6 individual `PlaneGeometry` meshes (floor, ceiling, 4 walls), each rotated
  so normals point inward → required for correct PBR lighting from inside
- **Why not `BoxGeometry`:** `BoxGeometry` with `BackSide` rendering cannot be correctly lit
  from inside using Three.js standard lighting. `BackSide` flips which face is rendered but
  does NOT flip the normals used for lighting calculations — normals still point outward.
  `DirectionalLight` computes `dot(normal, lightDir)` which becomes negative (light hits the
  outside of the box), so the room appears black regardless of light position.
  Six individual `PlaneGeometry` meshes with manually rotated inward-facing normals solve
  this — `dot(normal, lightDir)` is positive and the room is correctly illuminated.
- **Material:** `MeshStandardMaterial` with dissolve shader injected via `onBeforeCompile`
- **Lighting:**
  - `AmbientLight` (warm white, intensity 2.8 in room → 0.0 in space)
  - `DirectionalLight` (warm sunlight `#fff5e0`, intensity 3.5 in room → 8.0 in space)
  - Both lerped parametrically each frame based on `uProgress`
- **Shadows:** `PCFSoftShadowMap`, 2048×2048 shadow map

### space
- **Skybox:** `BoxGeometry(1000,1000,1000)` with 6 `MeshBasicMaterial` faces using
  cube map textures (`asset/skybox_blue/bkg1_*.png`), rendered `BackSide`
- **Why `BoxGeometry` + `BackSide` works here:** `MeshBasicMaterial` ignores lighting
  entirely — no normal vectors, no dot product calculations. It simply displays the texture
  color directly. So the outward-pointing normals of `BoxGeometry` cause no problem —
  there is no lighting math to get wrong.
- **Stars:** 1000 `Points` with additive blending, canvas-generated radial gradient texture,
  warm tint (`r=1, g=0.9, b=0.8`), randomly distributed in a 200-unit cube
- **Lighting:** zero ambient, pure white directional at 8.0 intensity — simulates
  unfiltered sunlight with no atmospheric scattering

---

## transition

**Trigger:** mouse `wheel` event maps `deltaY` to `uProgress` (0.0 → 1.0)

**Technique:** Codrops noise-based dissolve
(ref: tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/)

### dissolve shader (room walls)
Injected into `MeshStandardMaterial` via `onBeforeCompile` — PBR lighting preserved:

```glsl
float threshold = mix(-1.2, 1.2, uProgress);   // sweeps through noise range
float noise     = snoise3(vWorldPos * uFreq);   // 3D Simplex noise at world position

if (noise < threshold) discard;                 // kill fragment — hole in wall

// edge glow band just above the threshold
float edgeEnd = threshold + uEdge;
if (noise < edgeEnd) {
    float t = (noise - threshold) / uEdge;      // 0=at edge, 1=intact wall
    gl_FragColor = vec4(mix(uEdgeColor, gl_FragColor.rgb, t), mix(0.5, 1.0, t));
}
```

- `-1.2` / `1.2`: slightly beyond Simplex noise output range (-1 to 1) so the
  dissolve starts/ends cleanly with no leftover fragments
- `uFreq = 0.35`: noise scale — lower = larger organic blobs
- `uEdge = 0.25`: width of the soft glow band at dissolve boundary
- `uEdgeColor`: colour of the edge (currently black)

### dissolve particles (room)
- Currently implemented but **will be removed** — room dissolve uses shader only, no particles
- Decision: cleaner visual without particles; particles reserved for object disappearance

### noise implementation
3D Simplex Noise — Ashima Arts / Stefan Gustavson (2011) GLSL implementation.
Stored as a JS string constant `NOISE_GLSL`, injected into both room shader and
particle shader. No JS noise library used — noise must run on the GPU per-fragment.

---

## objects

### current (placeholder)
- **Cylinder:** `CylinderGeometry(0.3, 0.3, 1.2)` with `MeshStandardMaterial`
- Floating animation driven by `uProgress` and elapsed time `t`:
  ```javascript
  position.y = CYLINDER_FLOOR_Y + p * 2.0 + sin(t * 0.8) * 0.25 * p  // rise + bob
  position.x = sin(t * 0.5) * 0.35 * p                                 // lateral drift
  position.z = -1 + cos(t * 0.4) * 0.25 * p                           // depth drift
  rotation.y += 0.003 * p                                               // lazy spin
  rotation.z  = sin(t * 0.45) * 0.08 * p                               // gentle tilt
  ```
- Emissive: black (no glow added — shadow side goes pitch black in space)

### planned
- 4 GLB models via `GLTFLoader`: tulip/vase, teddy bear, doll, water glass
- Same floating animation per object with per-object phase offsets

### object disappearance (Phase 4)
Two-layer effect — same noise dissolve technique as room, but **with particles**:

**Layer 1 — dissolve shader on object material**
- Same `onBeforeCompile` injection as room, but each object has its own `uObjectProgress`
  uniform (0→1), independent of `uProgress` (room dissolve)
- Triggered by a sequential timer — each object disappears with a delay after the
  previous one (death is not scroll-controllable, intentional artistic decision)

**Layer 2 — particle burst per object**
- `Points` geometry placed on object surfaces (sampled from GLB geometry at load time)
- Particles drift outward + upward when object dissolves, fade by opacity over lifetime
- Same `NOISE_GLSL` + `uObjectProgress` uniform shared with object shader → edge-aligned
- `AdditiveBlending` — particles glow against dark space background

**Why particles on objects but not on room:**
- Room dissolve → quiet, gradual, environmental — no particles keeps it calm
- Object disappearance → significant event (life ending) — particles emphasize the moment

---

## interaction & camera

### scroll state machine
```
uProgress < 1.0           → scroll changes uProgress (room dissolve / restore)
uProgress = 1.0, far away → OrbitControls zoom (hasZoomedOut arms the return path)
uProgress = 1.0, close    → scroll restores room (zoom disabled)
```
- `ROOM_RETURN_DIST = 7.0` units from orbit target — original camera distance ≈ 6.1
- `hasZoomedOut` flag prevents room re-appearing immediately after dissolve
  (camera starts inside the threshold)

### camera
- `PerspectiveCamera`, FOV 35°, position `(0, 1.0, 4)`, target `(0, -2.5, -1)`
- `OrbitControls` with two modes:

| Mode | Azimuth | Polar | Zoom |
|---|---|---|---|
| Room | ±0.55π | 0.1π – 1.65 rad | off |
| Space | unlimited | 0 – π | on (dist 2–200) |

- Polar limit derived mathematically: `acos((floorY - targetY) / r) ≈ 1.70 rad`
  ensures camera never exits below the floor

---

## lighting transition (per frame)

```javascript
// Ambient: warm white (room) → off (space)
ambientLight.color.setRGB(lerp(1.00, 0.05, p), lerp(1.00, 0.08, p), lerp(1.00, 0.22, p));
ambientLight.intensity = lerp(2.8, 0.0, p);

// Directional: warm sunlight → pure white harsh starlight
dirLight.color.setRGB(lerp(1.00, 1.00, p), lerp(0.96, 1.00, p), lerp(0.88, 1.00, p));
dirLight.intensity = lerp(3.5, 8.0, p);
```

---

## tech stack

| Tool | Role |
|---|---|
| **Three.js r0.169** | 3D rendering, scene graph, PBR materials |
| **Vite** | Dev server, ES module bundler, GitHub Pages build |
| **GLSL / onBeforeCompile** | Dissolve shader injected into MeshStandardMaterial |
| **3D Simplex Noise (GLSL)** | Organic dissolve shape, particle edge sync |
| **OrbitControls** | Camera interaction with dynamic angle/zoom limits |
| **GLTFLoader** | (planned) loading .glb object models |
| **Web Audio API** | (planned) ambient sound fade across phases |

## color space
`renderer.outputColorSpace = THREE.LinearSRGBColorSpace` — matches first-universe
project aesthetic. No gamma correction applied → monitor darkens output, compensated
by higher light intensities (ambient 2.8, directional up to 8.0).

---

## 5-phase plan (from abstract)

| Phase | Description | Status |
|---|---|---|
| 1 | Room with soft lighting, objects on table | partial (room done, objects placeholder) |
| 2 | Scroll → environment dissolves, objects rise | dissolve done, floating done |
| 3 | Full space, objects float weightlessly | space done |
| 4 | Objects disappear one by one (timer-based) | not started |
| 5 | Room reforms, new objects appear | not started |

## deployment
- GitHub Pages via GitHub Actions (`static.yml`)
- Vite build (`npm run build`) → `dist/` deployed
- Base path: `/unstil-life-yegi-park/`
- Skybox textures in `public/asset/skybox_blue/` → copied to `dist/` by Vite
