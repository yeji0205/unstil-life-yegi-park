# unstil life — implementation (initial)

> The original plan and early design decisions, kept as a record. It is no
> longer up to date: the current implementation is described in
> [implementation_current.md](implementation_current.md).

## concept

A scroll-driven scene transition: a classical Still Life room gradually dissolves into cosmic
space using a noise-based dissolve shader. Objects float weightlessly as the room disappears.
The viewer interacts by scrolling (room ↔ space transition) and orbiting/zooming (in space).

---

## scenes

### room
- **Geometry:** 6 individual `PlaneGeometry` meshes (floor, ceiling, 4 walls), each rotated
  so its normal points inward
- **Why not `BoxGeometry`:** each wall as its own mesh gets its own size, UVs, texture and
  colour. (Correction: this section used to say that `BackSide` does not flip the normals,
  so a box room could not be lit. That is wrong: three.js flips the normals of back faces
  (`FLIP_SIDED`), so a lit box room works. The first room went black because it used
  `ShaderMaterial`, which ignores three.js lights; the planes and `MeshStandardMaterial`
  came in the same commit.)
- **Material:** `MeshStandardMaterial` with dissolve shader injected via `onBeforeCompile`
- **Lighting:**
  - `AmbientLight` (warm white, intensity 2.8 in room → 0.0 in space)
  - `DirectionalLight` (warm sunlight `#fff5e0`, intensity 3.5 in room → 8.0 in space)
  - Both lerped parametrically each frame based on `uProgress`
- **Shadows:** `PCFSoftShadowMap`, 2048×2048 shadow map

### space
- **Skybox:** `BoxGeometry(1000,1000,1000)` with 6 `MeshBasicMaterial` faces using
  cube map textures (`asset/skybox/<name>/{right,left,top,bottom,front,back}.png`), rendered `BackSide`
- **Why the skybox needs no lighting:** `MeshBasicMaterial` ignores lights entirely: it
  shows the texture colours as they are. The lights in space light the objects, not the
  sky, so the skybox's normals don't matter.
- **Stars:** 1000 `Points` with additive blending, canvas-generated radial gradient texture,
  warm tint (`r=1, g=0.9, b=0.8`), randomly distributed in a 200-unit cube
- **Lighting:** zero ambient, pure white directional at 8.0 intensity — simulates
  unfiltered sunlight with no atmospheric scattering

---

## transition

**Trigger:** mouse `wheel` event maps `deltaY` to `uProgress` (0.0 → 1.0)

**Technique:** [Codrops noise-based dissolve](https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/)

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
Stored as a JS string constant `NOISE_GLSL`, injected into room shader and object
dissolve shaders. No JS noise library used — noise must run on the GPU per-fragment.

---

## objects

### current (placeholder)
- **Cylinder:** `CylinderGeometry(0.3, 0.3, 1.2)` with dissolve shader + particle system
- Dissolve shader injected via `onBeforeCompile` using LOCAL position for noise — pattern
  stays fixed on the object as it floats (unlike room which uses world position)
- Own `uCylinderProgress` uniform, driven by phase timer (not scroll)

### floating animation
Floating motion described by:

$$P(t) = P_\text{initial} + p \cdot (H + A \odot \sin(\omega\, t))$$

where `t` = elapsed time (scalar), `p` = scroll progress, and `H`, `A`, `ω ∈ ℝ³`:
- `H` — upward rise vector (how high object lifts at p=1), varies per object
- `A` — per-axis amplitude (how wide the swing), varies per object
- `ω` — per-axis angular frequency (how fast the swing), varies per object

Per-object variation in `H`, `A`, and `ω` ensures each object rises to a different
height and drifts independently. Rotation is also driven by `sin(t) * p` per axis.

### object disappearance (Phase 4) — implemented on cylinder
Two-layer effect triggered by a **phase timer** (not scroll — death is uncontrollable):

**Phase state machine:**
```
'room'       → uProgress 0→1 via scroll
'space'      → uProgress=1, zoom enabled, 5s timer starts
'dissolving' → scroll blocked, uCylinderProgress 0→1 over 3s (timer-driven)
'done'       → scroll re-enabled to restore room
```

**Layer 1 — dissolve shader on object material**
- `onBeforeCompile` injects Simplex noise into `MeshStandardMaterial`
- Uses LOCAL position so noise pattern is stable as object floats
- `uCylinderProgress` (0→1) drives threshold: `mix(-1.2, 1.2, uCylinderProgress)`
- Fragments below threshold are discarded → organic dissolve shape

**Layer 2 — particle system**
- 1500 `Points` sampled on cylinder surface (side + top/bottom caps) in local space
- Attached as **child of cylinder mesh** → automatically follows object as it floats
- Each particle's vertex shader evaluates the same Simplex noise at local position
- Particles visible only within a narrow band around the dissolve threshold
- Velocity attribute (`aVelocity`) displaces each particle outward — side particles
  scatter radially, cap particles burst upward
- Sine-wave wiggle applied on top: `pos.x += sin(localPos.y * 3.0 + t * 2.0) * 0.05`
- Particle color: **white** (`0xffffff`) with `AdditiveBlending` — bright against dark space
- Separate `uCylParticleColor` uniform (decoupled from room edge color)

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

### 5-phase plan (from abstract)

| Phase | Description | Status |
|---|---|---|
| 1 | Room with soft lighting, objects on table | partial (room done, objects placeholder) |
| 2 | Scroll → environment dissolves, objects rise | dissolve done, floating done |
| 3 | Full space, objects float weightlessly | space done |
| 4 | Objects disappear one by one (timer-based) | not started |
| 5 | Room reforms, new objects appear | not started |

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
