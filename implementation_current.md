# unstil life — implementation (current)

How the artwork is built, part by part. Built-in three.js features are only
named; the project's own techniques are explained with their formulas and the
code that implements them. 

---

## 1. State machine and the parameter p

One value drives the whole scene: the progress parameter $p \in [0, 1]$
(`uProgress`), 0 = room, 1 = space. Scroll moves a **target** $p^*$; $p$
follows it with an exponential ease, so the motion is soft and the same at any
frame rate:

$$p \leftarrow p + (p^* - p)\,\bigl(1 - e^{-\Delta t/\tau}\bigr)$$

with $\tau = 0.28$ s, and $\tau = 0.75$ s on the way home so the return is
slower. Every effect reads $p$ each frame; nothing is told to start.

A state machine decides what scroll does:

| State | Entered when | Scroll | What happens |
|---|---|---|---|
| `room` | start, or $p^* < 0.95$ | moves $p^*$ | the room dissolves into space as $p$ rises |
| `space` | $p^* = 1$ | zooms the camera | the Dissolve button becomes available |
| `dissolving` | Dissolve pressed | **blocked** | the objects dissolve on a timer: $d = \min(1, t_d/T)$, $T = 5$ s |
| `done` | $d = 1$ | moves $p^*$ again | the objects are swapped, then re-form on the way home |

**Rebirth.** The dissolve is timer-driven (it cannot be scrolled: "death is
uncontrollable"), the return is scroll-driven. At $d = 1$ every object is
invisible, which is the moment to swap models. From then on the
objects' dissolve amount follows the room: $d = p$, so scrolling home plays
the dissolve backwards and the new still life forms together with the room.
The returning models are loaded at startup and kept hidden, so a swap only
shows and hides meshes.

- `src/scene/phaseMachine.js`: `easeToward`, the states, `scrollTo`,
  `setScrollTarget` (shared by the wheel and the journey)
- `src/scene/dissolveTimeline.js`: `advance(dt)` (timer, pause, scrub),
  `followScroll(p)` (the reverse dissolve)
- `src/objects/objectSwap.js`: `applyReturnObjects`, `preloadReturnObjects`

## 2. Objects

Five models from Sketchfab, loaded with `GLTFLoader`: flowers in a vase, a
teddy bear, a wooden mannequin, a stone and a round table. Each is scaled to a
target height from its bounding box,

$$s = \frac{h_\text{target}}{y_\text{max} - y_\text{min}},$$

where $y_\text{min}, y_\text{max}$ are the bottom and top of the model's
bounding box (`Box3`) and $h_\text{target}$ the height it should have
(`targetHeight`). Models come in any units (centimetres, metres…); scaling all
three axes by $s$ gives each the intended height with its proportions kept.
The model is then set onto the table top. Stones are laid on their flattest side: the model
is tilted in 9° steps about two axes, and the tilt with the smallest height
wins.

**Teddy bear pose.** The bear models have a skeleton. Their leg bones get two
poses, sitting (folded forward 85°) and hanging (straight), blended by how
high the bear floats above the table:

$$c = \frac{y_\text{bottom} - y_\text{table}}{r}, \qquad
b = \operatorname{smoothstep}\!\Bigl(\frac{c - 0.15}{1.20 - 0.15}\Bigr), \qquad
q_\text{leg} = \operatorname{slerp}(q_\text{sit}, q_\text{hang}, b)$$

- $c$ — clearance: the gap between the bear's lowest point $y_\text{bottom}$
  and the table top $y_\text{table}$, in units of the bear's size $r$, so the
  thresholds still fit if the bear is rescaled. $c = 0$: sitting on the table.
- $b$ — blend from sitting (0) to hanging (1): 0 below $c = 0.15$, 1 above
  $c = 1.20$, rising smoothly in between.
- $q_\text{sit}, q_\text{hang}$ — the leg bones' rotations (quaternions) in the
  two poses; $q_\text{leg}$ is the rotation applied to both leg bones.
  `slerp` blends two rotations smoothly; rotations can't simply be averaged.

So the bear sits on the table and its legs unfold the higher it floats. Height,
not $p$, drives it, because the table rises too. Built only for the given
teddy models (the bone names `legL`, `legR`).

- `src/objects/objectsSetup.js`: `OBJECT_DEFS`, `loadStillLifeObject`, `layFlat`
- `src/objects/skeletonPose.js`: `setupTeddyPose`, `updateTeddyPose`
- `src/objects/tableSetup.js`: the table, also swappable for a built-in Box or
  Cylinder (`builtinTable.js`) or an uploaded model (`customTable.js`)

## 3. Room

Six `PlaneGeometry` meshes (floor, ceiling, four walls) with inward-facing
normals and `MeshStandardMaterial` with PBR textures from Poly Haven. Each wall
is its own mesh, so it gets its own size, texture tiling and colour.

**Edge shading (fake ambient occlusion).** Where two planes meet, both are
fully lit and the seam looks like a hard line. Each plane is darkened toward
its edges in the shader:

$$\lambda = \prod_{\text{edges}} \operatorname{smoothstep}(0, m, u_\text{edge}), \qquad
\text{colour} \mathrel{*}= \operatorname{mix}(0.45, 1, \lambda)$$

- $u_\text{edge}$ — distance of the pixel from one edge of the plane, in UV
  space (0 at the edge, 1 at the opposite edge)
- $m$ — the margin over which the darkening fades out (1.3 world units,
  converted to UV space)
- $\lambda$ — brightness factor: 0 right at an edge, 1 further in; the product
  runs over the edges that touch another surface
- $0.45$ — the brightness left right at the edge

Multiplying makes a corner, where two edges meet, darker than a single edge,
like a real one.

**Lighting.** An `AmbientLight`, a `DirectionalLight` key light with soft
shadows (`PCFSoftShadowMap`), a weak fill on the left wall, and two parts of
our own:

- **Fake volumetric light beam.** A visible shaft of light falling into the
  room, without volumetric rendering. It is an open `ConeGeometry` from the
  light's entry point to the floor, drawn with additive blending and this
  fragment alpha:

  $$\alpha = \underbrace{v^2}_{\text{tip}} \cdot h \cdot
  \underbrace{|n_z|^{k}}_{\text{silhouette}} \cdot \text{fade}(p)$$

  $v$ = position along the cone (1 at the tip, 0 at the floor), so the haze
  is densest at the light source. $n_z$ = the view-space normal's $z$, i.e.
  how directly the surface faces the camera; raising it to the power
  $k = 1 + 4s$ (softness $s$) fades the haze toward the cone's outline, which
  reads as a soft volume instead of a solid cone. $h$ = haze density (0.45).
  The cone itself lights nothing, so a `SpotLight` on the same axis, with the
  angle $\arctan(R/L)$ of the cone, casts the lit pool and the shadows on
  table and floor. Both fade out early in the scroll:

  $$\text{fade}(p) = \operatorname{clamp}\bigl((0.4 - p)/0.35,\ 0,\ 1\bigr)$$
- **Objects-only key light.** three.js lights reach only meshes on their
  layer. The main key is kept dim so the room falls to near-black outside
  the beam; a second directional light on layer 2, which only the table and
  objects join, keeps the still life bright. It points along the beam, so
  the visible shaft appears to light the objects.

- `src/scene/room.js`: `roomParts`, `makeRoomMaterial`, `injectEdgeShading`
- `src/scene/lighting.js`: `createBeam`, `createBeamLight`, `createObjectKey`,
  `updateLighting(p)`

## 4. Space

A `BoxGeometry` skybox (1000 units) with six `MeshBasicMaterial` faces, which
ignore lights and show the images as they are, plus a star field of `Points`
at random positions. Three skybox sets; uploads accept PNG, JPG, WebP, AVIF,
GIF, BMP and TGA.

**Lighting from the background.** Two things make the objects take on the
colour of space:

1. **Background-tinted ambient light.** Each face is drawn into a 32×32
   canvas, which averages it, and the average colour $\bar c$ of all six is
   normalised to its hue ($\hat c = \bar c / \max(\bar c)$), since a starry
   sky averages to almost black. The ambient light in space takes that hue,
   mixed with white by the Background Tint $s = 0.65$:

   $$c_\text{ambient} = 1 + s\,(\hat c - 1)$$

2. **Environment map.** The skybox is rendered once into a pre-blurred map
   (`PMREMGenerator`) and set as `scene.environment`, so surfaces reflect the
   background, sharply where glossy, softly where matte. It fades in with the
   visible sun: $e = \operatorname{smoothstep}\bigl((p - 0.45)/0.45\bigr)$,
   so there are no space reflections in the room.

**The blend from room to space.** Every light value is interpolated by $p$,
$x = \operatorname{lerp}(x_\text{room}, x_\text{space}, p)$:

| | Room ($p = 0$) | Space ($p = 1$, starry sky) |
|---|---|---|
| Ambient | warm brown, 0.4 | background hue, 0.7 |
| Key light | warm amber `#ffe8b0`, 2.6 | white, 5.4 |

- `src/scene/space.js`: `buildSkybox`, `averageFaceColor`, `normalizeHue`,
  `LIGHTING_PRESETS`
- `main.js`: `refreshEnvironment` (the environment map)
- `src/scene/stars.js`, `src/scene/skyboxUpload.js`

## 5. Dissolve

The technique follows the Codrops article [Implementing a Dissolve Effect with
Shaders and Particles in Three.js](https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/). 3D simplex noise $n(\mathbf x) \in [-1, 1]$
is compared with a threshold that sweeps past the noise range as the
progress $d$ goes from 0 to 1:

$$\theta = \operatorname{mix}(-1.2,\ 1.2,\ d), \qquad
\text{discard if } n(\mathbf x) < \theta, \qquad
\text{edge band: } \theta \le n < \theta + w$$

Inside the edge band the colour blends toward an edge colour and becomes
half transparent, $\text{colour} = \operatorname{mix}(c_\text{edge}, c,\ (n - \theta)/w)$,
where $\mathbf x$ is the surface point, $c$ its lit colour, $c_\text{edge}$ the
edge colour and $w$ the edge band's width (0.25 for the room, 0.10 for the
objects),
so the boundary is a soft rim instead of a hard cut. The code is injected into the
models' own `MeshStandardMaterial` with `onBeforeCompile`, after the lighting
is computed, so the surfaces keep their PBR lighting. A matching depth
material makes the shadows dissolve with the surface.

**Room.** $d = p$, noise at the **world** position (the pattern stays in place
as the room dissolves), a black edge.

**Objects.** $d$ from the dissolve timer (or $p$ on the way home), noise at the
**local** position, so the pattern rides with each object as it floats. The
edge takes the object's own colour, darkened ($c_\text{edge} = 0.35\,c$): the
models are hollow shells, and a fixed white edge outlined every hole. The
brightness at the boundary comes from the particles instead. The table and
all objects dissolve together.

**Particles.** Each object gets 200–900 particles (by its size), drawn as
points. Their start positions are sampled on the object's own triangles,
weighted by triangle area so they cover the surface evenly: a triangle is
picked with probability $A_i / \sum A$, then a random point inside it. Each
particle evaluates the same noise and threshold as the surface, so it
appears exactly where the surface breaks up. Its age is how far the edge has
passed it, $a = \operatorname{clamp}\bigl((\theta - n)/\ell, 0, 1\bigr)$ with
lifetime $\ell$, and it moves on the GPU without any per-frame update:

$$\mathbf x = \mathbf x_0 + a\,D\,(0.233\,\mathbf v + \mathbf s)$$

$\mathbf x_0$ = its start point on the surface, $a$ = its age (above),
$\mathbf v$ = its own random velocity, $\mathbf s$ = a shared stream up and
back into the sky, $D$ = drift distance, plus a slow sideways sway. It fades
out over its life, $\alpha = 1 - \operatorname{smoothstep}(0.25, 1, a)$. The
particles are children of their object, so they follow its floating. The
table's particles burst outward from its centre instead.

**How a particle looks: shape, twinkle and glow.** The particles are
`THREE.Points` with our
own `ShaderMaterial`; the built-in `PointsMaterial` can't dissolve or move them
individually. Three separate things make them look like starlight:

- **Shape** (one frame, inside the particle's own square). No texture: the
  fragment shader computes each pixel's brightness from its distance $r$ to
  the centre, a bright core plus four thin rays along $x$ and $y$, like a star
  glint:

  $$\text{shape} = e^{-24 r^2} + \kappa \cdot \text{rays}(x, y)$$

  with ray strength $\kappa = 0.7$. Each particle is tinted slightly warm or
  cool at random, so they aren't all identical.

- **Twinkle** (over time). Each particle pulses: its rays and brightness grow
  briefly, then calm down. With a random number $\rho_i \in [0, 1)$ per
  particle (hashed from its position), its own speed and starting moment are

  $$\phi = \tfrac12 + \tfrac12 \sin\bigl(t\,(1.6 + 2.4\,\rho_i) + 31.4\,\rho_i\bigr),
  \qquad \text{pulse} = \max(0,\ 2\phi^2 - 1)$$

  Squaring keeps the flashes short. The pulse scales the size by
  $1 + 0.6\,\text{pulse}$ and the brightness by $1 + 0.3\,\text{pulse}$, so
  the particles flash at different moments and never in sync.

- **Glow** (around the particle). A soft halo of light around each particle,
  like a lamp in fog. A particle can only colour its own small square, not the
  pixels next to it, so the halo is made from a blurred copy of the particles,
  laid over the picture. Every frame:
  1. **Only the particles.** The particles are on their own three.js layer,
     a label that lets the camera draw them alone. They are drawn onto black
     into a hidden half-size image. Without the separate layer this image
     would contain the whole scene, and every object, the stars and the sky
     would get a halo too, making the picture hazy.
  2. **Blur.** Each pixel of that image is mixed with its neighbours, so every
     sharp dot spreads into a soft cloud of light. A neighbour at distance $x$
     counts with weight $w(x) = e^{-x^2 / 2\sigma^2}$ (a gaussian): close
     pixels count a lot, far ones little, which gives a round, soft falloff.
  3. **Add it on top.** The normal scene is drawn, then the blurred image is
     added over it, brightening the pixels around each particle.

  This step only runs while particles are on screen.

Glow makes the particles read as light; twinkle makes them read as alive.
Both can be adjusted in the debug panel (Particle Twinkle, Particle Bloom).

- `src/effects/dissolve.js`: `injectDissolve`, `makeDissolveDepthMaterial`
- `src/effects/noise.js`: `NOISE_GLSL` (Ashima Arts simplex noise)
- `src/effects/dissolveParticles.js`: `buildParticlesFromGeometry`,
  `makeParticleMaterial`, `makeParticlePoints`
- `src/effects/particleBloom.js`: the glow

## 6. Floating

$$P = P_\text{initial} + f \cdot \bigl(H + A \odot \sin(\omega\, t + \varphi)\bigr)$$

- $f$ — floating factor: 0 until $p = 0.2$, then a smoothstep to 1, so the
  objects rest on the table and then ease off it:
  $f = \operatorname{smoothstep}\bigl((p - 0.2)/0.8\bigr)$
- $H$ — rise, **per object** (1.8 to 2.5)
- $\varphi$ — oscillation offset, **per object**, so they don't move in synchrony
  (the tulips share the vase's, so they never bob into it)
- $A, \omega$ — per axis, shared: vertical bob 0.25 at 0.75 rad/s, sideways
  sway 0.04 at 0.28 rad/s and 0.03 at 0.21 rad/s

Rotation is a bounded back-and-forth of the same form (at most ±13°), not a
spin. A vertical collision pass keeps the objects from sinking through the
table: wherever an object's bottom is below the table top, it is pushed up by
the overlap, faded in over $p \le 0.15$.

- `src/effects/floating.js`: `updateFloating`

## 7. Camera

A `PerspectiveCamera` (35°) with `OrbitControls`. Our own logic on top:

- **Room limits that open up.** In the room the orbit is limited to ±30°
  around the front view and to above the floor; the limits ease open
  with $t = \operatorname{smoothstep}(p;\ 0.6, 0.95)$, e.g. azimuth
  $\operatorname{lerp}(\pi/6, \pi, t)$, instead of snapping.
- **Pull-back with the rising objects.** With $f$ as in floating (from
  $p = 0.2$), the camera moves back and its gaze rises with the objects, so
  they stay in frame:
  $\text{distance} = d_0 + 8f$, $\ \text{gaze height} = y_0 + 1.4f$, where
  $d_0$ is the orbit distance when the objects start rising and $y_0$ the
  gaze height in the room.
  Camera and target move up together, so the flat-on view of the table is
  kept.
- **Zoom hand-off.** In space the wheel zooms. Once the viewer has zoomed out
  and comes back closer than 5.5 units, the wheel returns to scrolling the
  room home.

- `src/setup/cameraControls.js`: `applyControlMode`, `updateAutoZoomOut`,
  `updateZoom`

## 8. Sound

Web Audio, started by the first click or key (browsers refuse to play sound
before one; a scroll does not count). The café ambience fades with the room,
$g = v\,(1 - p)$ ($g$ = gain, $v$ = the volume setting), to silence in space. The dissolve sound follows the
dissolve's own playback: it starts with it, pauses with it and jumps when the
scrub bar jumps.

- `src/audio/ambientSound.js`

## 9. The journey

Key P plays the whole cycle without input. It acts as a virtual viewer: it
moves the scroll target $p^*$ and presses Dissolve, so every effect reacts
exactly as it does to scrolling. The cycle is a list of steps:

| Step | Lasts | Does | Swing $u$ (below) |
|---|---|---|---|
| room | 4 s | glides the camera to the start view | — |
| to space | 6 s | $p^*: 0 \to 1$ | — |
| look around | 8 s | the camera starts its swing | $0 \to 0.31$, by time |
| dissolve | until the objects are gone (5 s by default) | presses Dissolve | $0.31 \to 0.5$, by the **dissolve's progress** |
| emptiness | 8 s | the swing turns back | $0.5 \to 0.79$, by time |
| home | 6 s | $p^*: 1 \to 0$ | $0.79 \to 1$, by time |

Every step has a fixed length in seconds except the dissolve: it ends when the
dissolve does, and moves the swing with the dissolve's progress instead of the
clock.

**The camera swing.** Over the journey the camera circles once to the left
around the still life, 55° out and back, at the same height and distance,
always facing the objects. Three steps make this happen every frame:

1. **The angle.** The camera's position around its target is described by a
   horizontal angle $\theta$ (around the vertical $y$ axis) and a tilt
   $\varphi$. The journey computes the angle for this moment:

   $$\theta = \theta_0 + \Theta \cdot \sin^2(\pi u)$$

   - $\theta_0$ — the start angle: the view when the page opened
   - $\Theta = -55^\circ$ — how far the swing goes (negative = to the left)
   - $u$ — how far through the swing we are, from 0 (start) to 1 (back home)
   - $\sin^2(\pi u)$ — goes $0 \to 1 \to 0$ as $u$ goes $0 \to 0.5 \to 1$:
     out, then back. Its slope is zero at $u = 0$, $0.5$ and $1$, so the
     camera starts gently, slows to a stop at the turning point and arrives
     gently, without a jerk.

   | $u$ | 0 | 0.25 | 0.5 | 0.75 | 1 |
   |---|---|---|---|---|---|
   | $\theta - \theta_0$ | 0° | −27.5° | −55° | −27.5° | 0° |

2. **The position.** The angle is turned into a camera position on a circle
   around the target (`THREE.Spherical`), keeping the distance $r$ and the
   tilt $\varphi$:

   $$\mathbf c = \mathbf t + r\,(\sin\varphi \sin\theta,\ \cos\varphi,\ \sin\varphi \cos\theta)$$

   with $\mathbf t$ the target (the still life) and $\mathbf c$ the camera.

3. **The rotation.** OrbitControls then turns the camera to face the target
   (`lookAt`), so the objects stay in the centre of the picture.

**How $u$ advances.** In most steps $u$ grows with the step's time. During the
dissolve it is tied to the dissolve fraction $d$ (0 = intact, 1 = gone)
instead:

$$u = a + (0.5 - a)\,d, \qquad a = 0.5 \cdot \frac{8}{8 + 5} \approx 0.31$$

$a$ is where the swing stands when the dissolve starts (after the 8 s look
around, out of the 8 s + 5 s that lead to the turning point). So the further
the objects have dissolved, the further the camera has turned, and it reaches
the turning point $u = 0.5$ exactly when they are gone. That is when the
models are swapped (see [Rebirth in section 1](#1-state-machine-and-the-parameter-p)): the new ones take their place, still fully dissolved
and invisible, and form on the way home. At the turning point the camera stands
still for the first few frames after the swap. If the dissolve runs slower or
is paused, the camera slows down or stops with it.

- `src/scene/journey.js`: `journeySteps`, `moveCamera`, `stepsFrom`
- `main.js`: `warmUpShadersWhenReady`

