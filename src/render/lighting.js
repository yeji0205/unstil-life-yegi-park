import * as THREE from 'three';
import { uRimColor, uRimStrength } from './dissolve.js';

// ─── Fake volumetric light beam ──────────────────────────────────────────────
// Single cone with a custom gradient shader: full brightness at the tip (light
// source) fading to fully transparent at the base (floor). The cone stretches
// all the way down to the floor plane so there is no abrupt cut-off.
//
// ConeGeometry: apex at local +Y, base at local -Y.
// We rotate so +Y points toward the light source (upper-left, near ceiling)
// and -Y reaches the floor.
const BEAM_TIP  = new THREE.Vector3(-3.8,  3.2,  1.1); // upper-left, light entry
const BEAM_BASE = new THREE.Vector3( 1.5, -3.4, -3.2); // floor intersection
// Both moved +0.7 right and 0.9 further back than they were, to bring the tulips
// into the shaft without widening it. Right alone was not enough: the blooms sit
// ~1.0 unit deeper toward the wall than the axis did at their height, so most of
// the gap was in DEPTH rather than sideways. Right-only closed 1.57 -> 1.33
// against a radius of 1.32; right and back closes it to 0.79.
// Cone radius at the floor end. Named because the spotlight below derives its
// angle from it — the lit pool and the visible haze have to be the same cone,
// or you see a bright patch with no shaft in it (or the reverse).
//
// Kept at 2.2 — the shaft's width is part of the mood, so raising the tip does
// the work of reaching the flowers instead. With the tip at y 3.2 the blooms sit
// about 1.57 units off the axis where the cone's radius is 1.41, so they land
// right on its edge and catch the penumbra rather than sitting in full shadow.
// Beam Width ~1.15 puts them fully inside if that reads as too marginal.
const BEAM_RADIUS = 2.2;
const BEAM_LEN    = BEAM_TIP.distanceTo(BEAM_BASE);
const BEAM_CENTER = new THREE.Vector3().addVectors(BEAM_TIP, BEAM_BASE).multiplyScalar(0.5);

function createBeam() {
    const axis    = new THREE.Vector3().subVectors(BEAM_TIP, BEAM_BASE).normalize();
    const len     = BEAM_LEN;
    const halfLen = len * 0.5;
    const center  = new THREE.Vector3().addVectors(BEAM_TIP, BEAM_BASE).multiplyScalar(0.5);
    const quat    = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

    // uBeamFade driven each frame by updateLighting() to dissolve with the room
    const uBeamFade = { value: 1.0 };
    // How sharply the haze fades toward its silhouette, and how dense it is.
    const uBeamEdge = { value: 3.5 };
    const uBeamHaze = { value: 0.45 };

    const beamMat = new THREE.ShaderMaterial({
        uniforms: { uBeamFade, uBeamEdge, uBeamHaze },
        vertexShader: /* glsl */`
            varying float vTipness;
            varying float vEdgeFade;
            void main() {
                // Axis fade: 0 at floor base, 1 at light-source tip
                vTipness = clamp(position.y / ${halfLen.toFixed(4)} * 0.5 + 0.5, 0.0, 1.0);

                // Edge fade: how much the surface faces the camera.
                // normalMatrix transforms model normals → view space.
                // In view space the camera looks down -Z, so the Z component of the
                // view-space normal equals cos(angle between normal and view direction).
                // At the silhouette edge the normal is perpendicular to view → Z≈0 → fade to 0.
                // Facing the camera directly → Z≈1 → full contribution.
                vec3 viewNormal = normalize(normalMatrix * normal);
                vEdgeFade = abs(viewNormal.z); // abs handles DoubleSide back-faces

                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform float uBeamFade;
            uniform float uBeamEdge;
            uniform float uBeamHaze;
            varying float vTipness;
            varying float vEdgeFade;
            void main() {
                // A POWER CURVE, not a smoothstep. smoothstep(0.0, 0.5, ...) made
                // every part of the shaft facing the camera more than halfway
                // FULLY opaque, so the haze had a flat solid core and only a thin
                // fade right at its silhouette — which is what read as a hard
                // edge. pow() never plateaus: it falls off continuously from the
                // centre outward, so the shaft has no boundary you can point at.
                //
                // Higher uBeamEdge = a narrower bright core and a wider, gentler
                // fade, i.e. softer. 1.0 is a plain linear fade.
                float edge  = pow(clamp(vEdgeFade, 0.0, 1.0), uBeamEdge);
                float alpha = vTipness * vTipness * uBeamHaze * edge * uBeamFade;
                gl_FragColor = vec4(1.0, 0.91, 0.65, alpha);
            }
        `,
        transparent: true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
        side:        THREE.DoubleSide,
    });

    // 192 radial segments, up from 48. The fragment shader raises vEdgeFade to a
    // power, and vEdgeFade is a VARYING — interpolated linearly across each flat
    // facet while the value it approximates curves. That leaves a small kink in
    // the gradient at every facet boundary, and pow() amplifies kinks, which is
    // why visible straight bands appeared across the shaft only after the edge
    // falloff was softened. Finer facets shrink the error below the point where
    // the eye can pick the boundaries out. It is one cone, so the extra
    // triangles cost nothing worth measuring.
    const beamMesh = new THREE.Mesh(new THREE.ConeGeometry(BEAM_RADIUS, len, 192, 1, true), beamMat);
    beamMesh.position.copy(center);
    beamMesh.quaternion.copy(quat);
    beamMesh.renderOrder = 1;

    return { beamMesh, uBeamFade, uBeamEdge, uBeamHaze };
}

// ─── Key-light direction ─────────────────────────────────────────────────────
// The directional light's direction is stored as two ANGLES rather than a raw
// XYZ position, so the GUI can expose it as sliders that mean something:
//
//   elevation — 0° = level with the tabletop (raking in from the side),
//               90° = straight down from directly overhead
//   azimuth   — which way around the scene it comes from (0° = from the front,
//               negative = swinging toward the left)
//
// Only the direction matters for a DirectionalLight, so the distance is held
// constant; that also keeps the shadow camera's framing stable as you drag.
const LIGHT_DISTANCE = 10.5; // magnitude of the original (-6, 7, 5) position

// Live values the GUI edits. Defaults reproduce the original (-6, 7, 5) key
// light exactly, so the scene looks unchanged until a slider is touched.
//
// Elevation is deliberately kept at or above 0° (see the GUI slider range): a
// light BELOW the horizon throws the table's and objects' shadows UPWARD onto
// the wall instead of down onto the floor, which reads as wrong.
// Elevation 55° / azimuth −50° aims the key light at the nebula's brightest
// region, measured by raycasting the skybox and sampling its textures (the glow
// centres near az −50°, el ~55°). So the light now comes FROM the bright patch
// you can actually see behind the objects, and the visible sun below sits there.
export const lightAngle = { elevation: 55, azimuth: -50 };

// User overrides for light intensity, applied AFTER the room→space preset blend.
// The GUI's Ambient/Directional sliders used to write straight to the lights,
// but updateLighting() overwrites those every frame from the preset — so dragging
// them did nothing (the slider showed your value while the real intensity stayed
// at the preset's). Multiplying here instead means the sliders work at any point
// in the transition, including at full space. 1 = exactly the preset.
export const lightBoost = { ambient: 1.0, directional: 1.0 };

// ─── Lighting the objects without lighting the room ──────────────────────────
// A three.js light only illuminates objects that share a LAYER with it, which is
// the one mechanism that can separate the two. Dimming the key light alone
// cannot: it reaches the still life as well as the walls, so the objects go down
// with the room and the whole frame just gets murky.
//
// So the key light is turned down for everything, and a second light — on this
// layer, which only the table and the stage objects enable — puts the objects
// back where they were. The room keeps only the dimmed key, the objects get
// dimmed key + this.
//
// Layer 1 is already the particle bloom layer (see dissolve.js), hence 2.
export const OBJECT_LIGHT_LAYER = 2;

// All four scale the ROOM end of the blend only, so space always lands on
// exactly the preset it did before and none of this can disturb it.
//
//   roomKey   multiplier on the main key light, which reaches everything
//   objectKey the objects-only light that compensates for it
//   ambient   the flat fill that lifts every surface equally
//   wallFill  the second directional that exists to lift the far wall
//
// The first two separate the room from the still life. The last two are what
// decide how DEEP the falloff is: ambient and the wall fill both lift the
// shadows, so leaving them at full keeps the dark parts of the room grey and
// the objects' shadow sides soft. Pulling them down is what lets the room drop
// away to near-black at the edges while the lit pool stays bright — one source,
// deep falloff, very little fill.
//
// 1 / 0 / 1 / 1 is the original lighting exactly.
// The beam is a fixed additive contribution, so the contrast between "inside
// the shaft" and "outside it" is that fixed amount divided by the UNIFORM room
// light. A directional light lights the whole wall evenly whatever the beam is
// doing, so the only way to make the shaft stand out — without touching the
// beam itself — is to push everything uniform well down.
//
// Room now receives  0.52 + 0.16 + 0.07 = 0.75  against the original 3.55, so
// about a fifth. Objects receive 0.52 + 2.2 + 0.16 = 2.88, near enough what
// they always had, because the object key rises as the room key falls.
export const roomLighting = {
    roomKey:   0.20,
    objectKey: 0.6,
    ambient:   0.40,
    wallFill:  0.12,
    beam:      6.0,   // the spotlight that makes the shaft actually light things
    beamWidth: 1.0,   // scales the shaft; mesh and spotlight together
    // Slide the whole shaft without changing its angle. Applied to the mesh, the
    // spotlight and its target together, so the visible haze and the lit pool
    // never come apart.
    beamShiftX: 0.0,
    beamShiftZ: 0.0,
    // ONE softness for the whole shaft. Drives the visible haze's edge falloff
    // and the spotlight's penumbra together, for the same reason beamWidth does:
    // a soft haze over a hard-edged pool (or the reverse) reads as two effects
    // rather than one shaft.
    beamSoftness: 0.85,
    // Density of the visible haze, separate from how much light it casts.
    beamHaze: 0.45,
};

// ─── Visible light source ("sun") ────────────────────────────────────────────
// A directional light has no position on screen — it's a sun at infinity — so in
// space there was nothing to show WHERE the light came from, which is what made
// it read as unrealistic. This puts an actual luminous body at the light's
// direction: a small bright core plus a soft additive halo. It's parented to
// nothing and simply repositioned whenever the angle changes, so dragging the
// elevation/azimuth sliders visibly moves the source the light comes from.
const SUN_DISTANCE = 150;  // well inside the 1000-unit skybox, beyond the stars
const SUN_CORE_R   = 1.2;  // small bright disc (~2.5% of screen height)
const SUN_GLOW     = 14;   // halo sprite size

// Radial-gradient sprite texture: opaque white centre → transparent edge, so the
// halo falls off smoothly instead of showing a hard circle.
function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(210,232,255,0.55)'); // cool blue-white, matching the nebula
    g.addColorStop(1.0, 'rgba(150,200,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}

function createSun() {
    const group = new THREE.Group();

    // Core: unlit so it always reads as emitting rather than being lit.
    const coreMat = new THREE.MeshBasicMaterial({
        color: 0xfdfaf0, transparent: true, opacity: 0, depthWrite: false,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(SUN_CORE_R, 16, 12), coreMat);

    // Halo: additive so it blooms against the dark background where it overlaps
    // the nebula, without a visible sprite edge.
    const glowMat = new THREE.SpriteMaterial({
        map: makeGlowTexture(), transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(SUN_GLOW);

    group.add(glow, core);
    group.renderOrder = 1;
    return { group, coreMat, glowMat };
}

// ─── Lighting ────────────────────────────────────────────────────────────────
export function setupLighting(scene) {
    // Warm ambient fill — raised from 0.15 so shadowed areas of the room stay
    // readable instead of dropping to near-black.
    const ambientLight = new THREE.AmbientLight(0x3d2010, 0.4);
    scene.add(ambientLight);

    // Single key light from upper-left-front — matches the photo's Rembrandt-style raking light
    const directionalLight = new THREE.DirectionalLight(0xffe8b0, 2.6);
    directionalLight.castShadow = true;
    // Keep the map at 1024: 2048 quadruples the per-frame shadow-pass cost and
    // tanked the framerate for no visual gain worth it here.
    //
    // Instead of a bigger map, use the one we have more densely. The shadow
    // camera was framing ±8 units — far wider than anything that casts a visible
    // shadow — so most of its resolution fell on empty floor. Tightening it to
    // ±5 puts ~2.5× more texels on the table and the objects standing on it, at
    // zero runtime cost, which is what actually closes the gap between the agate
    // and its contact shadow: a coarse shadow map needs a large normalBias to
    // hide its own stair-stepping, and normalBias is precisely what pushes the
    // shadow away from the object ("peter-panning").
    //
    // With the sharper map, normalBias can drop to a quarter of what it was and
    // the shadow meets the stone where it touches the table. Keep the frustum
    // wide enough for the table's shadow on the floor and the objects' shadows
    // on the walls — anything outside it silently stops casting.
    // Bias is sized against the actual TEXEL, so it has to be recomputed
    // whenever the map size changes — see setShadowQuality below, which is what
    // sets the initial values too.
    directionalLight.shadow.bias        = -0.0002;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far  = 26;
    directionalLight.shadow.camera.left = -5;
    directionalLight.shadow.camera.right = 5;
    directionalLight.shadow.camera.top  = 5;
    directionalLight.shadow.camera.bottom = -5;
    scene.add(directionalLight);

    // ─── Shadow resolution ───────────────────────────────────────────────────
    // The blocky stair-stepped shadow edges show up worst on the pale Box and
    // Cylinder plinths, and that's not a coincidence: a shadow edge is a
    // brightness step, and a step is easiest to see against a light, flat,
    // untextured surface. The wood and plaster elsewhere hide the same jaggedness
    // behind their own detail.
    //
    // The jaggedness itself is the shadow map's pixel grid. Its camera spans 10
    // world units, so at 1024 each texel covers ~1 cm of world — and the plinth
    // fills enough of the screen that those centimetre squares are plainly
    // visible. Doubling to 2048 halves the step size, which is the only real fix;
    // filtering can soften an edge but can't invent detail that was never
    // rasterised. Cost is 4× the shadow-map memory and fill, which is why this is
    // adjustable rather than simply set high.
    //
    // normalBias is derived from the texel rather than hard-coded, so it stays
    // just over one texel at any resolution: too little and surfaces stipple
    // themselves with acne, too much and shadows detach from their objects. A
    // sharper map therefore also buys a tighter contact shadow, for free.
    const SHADOW_FRUSTUM = 10; // world units across (camera.left..right)
    function setShadowQuality(size) {
        directionalLight.shadow.mapSize.set(size, size);
        directionalLight.shadow.normalBias = 1.2 * (SHADOW_FRUSTUM / size);
        // A shadow map already allocated on the GPU keeps its old dimensions.
        // Disposing it makes three build a new one at the new size next frame.
        if (directionalLight.shadow.map) {
            directionalLight.shadow.map.dispose();
            directionalLight.shadow.map = null;
        }
    }
    setShadowQuality(2048);

    // ─── Left-wall fill ──────────────────────────────────────────────────────
    // The key light above comes from the upper LEFT, so it rakes across the back
    // wall and lights the objects — but the left wall itself faces AWAY from it.
    // A surface only gets light from a source it can "see": Lambert shading
    // scales by dot(normal, lightDirection), and for the left wall that dot is
    // negative, so the key contributes exactly zero. All it had left was the
    // ambient term, which is a flat constant with no shading in it — hence the
    // dead, colorless look.
    //
    // The fix is a second source aimed the other way. Only ONE is needed, not
    // the pair discussed earlier: the ceiling was going to get its own light,
    // but barely any of it is on screen, so it isn't worth a draw of anyone's
    // attention or the GPU's. This one sits out on +X and shines back toward the
    // origin, so it catches every surface whose normal points right — the left
    // wall, and the right-hand side of the objects, which also gives them a
    // gentle second edge.
    //
    // castShadow stays FALSE, and that is the whole reason this is cheap. A
    // shadow-casting light means a second full render of the scene from the
    // light's point of view every frame; a non-casting one is a few extra lines
    // of arithmetic in the fragment shader. Fill lights almost never need to
    // cast — a second set of shadows going the other way would read as confused
    // rather than realistic.
    const wallFill = new THREE.DirectionalLight(0xffd0a0, 0.55);
    wallFill.position.set(6, 1.5, 2);
    wallFill.castShadow = false;
    scene.add(wallFill);

    // The objects-only key. Restricted to OBJECT_LIGHT_LAYER, so the walls,
    // ceiling and floor never receive it however bright it gets.
    //
    // Aimed down the beam's own axis, so what appears to light the still life is
    // the shaft you can see. castShadow stays false: the dimmed main key still
    // casts the table and object shadows, and a second set thrown from the same
    // direction would only double the edges.
    const objectKey = new THREE.DirectionalLight(0xffe8b0, roomLighting.objectKey);
    objectKey.castShadow = false;
    objectKey.layers.set(OBJECT_LIGHT_LAYER);
    objectKey.position.copy(new THREE.Vector3().subVectors(BEAM_TIP, BEAM_BASE).normalize().multiplyScalar(12));
    scene.add(objectKey);

    // Converts the two angles above into the light's XYZ position. Called once
    // now (so the default matches the original hardcoded position) and again
    // from the GUI whenever a slider moves. The light always aims at the origin,
    // which is DirectionalLight.target's default — nothing else to update.
    const { group: sunGroup, coreMat: sunCoreMat, glowMat: sunGlowMat } = createSun();
    scene.add(sunGroup);

    function applyLightAngle() {
        const el = THREE.MathUtils.degToRad(lightAngle.elevation);
        const az = THREE.MathUtils.degToRad(lightAngle.azimuth);
        const horizontal = Math.cos(el) * LIGHT_DISTANCE; // shrinks to 0 as it goes overhead
        directionalLight.position.set(
            Math.sin(az) * horizontal,
            Math.sin(el) * LIGHT_DISTANCE,
            Math.cos(az) * horizontal
        );
        // Put the visible sun along that same direction, far out in the sky, so
        // what you see and what lights the objects always agree.
        sunGroup.position.copy(directionalLight.position)
            .normalize().multiplyScalar(SUN_DISTANCE);
    }
    applyLightAngle();

    const { beamMesh, uBeamFade, uBeamEdge, uBeamHaze } = createBeam();
    scene.add(beamMesh);

    // ─── The shaft as an actual light ────────────────────────────────────────
    // The beam mesh is additive haze in the air: it is VISIBLE but it illuminates
    // nothing, so the wall and floor it crosses received exactly what the corners
    // did. Turning the room lights down therefore darkened everything evenly and
    // produced a dim frame rather than a contrasty one — the lit pool has to come
    // from somewhere, and there was nothing making one.
    //
    // A spotlight down the same axis, with its angle taken from the same cone,
    // is what makes the shaft light the surfaces it lands on. Now the room can be
    // pushed far down and the pool stays bright, which is the contrast itself.
    //
    // It casts: otherwise the beam would shine through the table and light the
    // floor underneath it as if nothing were in the way.
    const beamLight = new THREE.SpotLight(0xffe8b0, roomLighting.beam);
    beamLight.position.copy(BEAM_TIP);
    beamLight.target.position.copy(BEAM_BASE);
    beamLight.angle    = Math.atan(BEAM_RADIUS / BEAM_LEN);
    beamLight.penumbra = roomLighting.beamSoftness;
    beamLight.decay    = 0;     // no distance falloff: the shaft reads as even
    beamLight.castShadow = true;
    beamLight.shadow.mapSize.set(1024, 1024);
    beamLight.shadow.camera.near = 0.5;
    beamLight.shadow.camera.far  = 20;
    beamLight.shadow.bias        = -0.0005;
    // normalBias, not just bias, and this was missing. bias alone offsets along
    // the light direction, which does nothing for a face nearly PARALLEL to the
    // light — and a scanned rock is full of those. normalBias offsets the lookup
    // along the surface normal instead, which is what stops a curved surface
    // shadowing itself and drawing thin dark streaks across its own face. The
    // directional light has had one all along (derived from its texel size); the
    // spotlight went in without.
    //
    // 0.02 is about four texels at this cone's far end (the lit disc is ~4.4
    // units across against a 1024 map). Small next to the objects themselves —
    // the stone is 0.35 tall — so it clears the acne without lifting contact
    // shadows off the surfaces they belong to.
    beamLight.shadow.normalBias  = 0.02;
    scene.add(beamLight);
    scene.add(beamLight.target);

    // The color AND intensity the lights ease toward at p=1 — swapped by
    // setSpacePreset() whenever the background changes (see
    // geometry/environment.js LIGHTING_PRESETS). Intensity matters as much
    // as color here: against deep space, ambient fades to ~0 and the
    // directional key light does the work; against a plain white void
    // there's no light source to justify that, so ambient instead stays
    // bright and neutral, acting as an even fill that shows each object's
    // own material color instead of a moody directional-only look.
    let spacePreset = {
        ambientColor:         [0.05, 0.08, 0.22],
        ambientIntensity:     0.0,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 3.5,
    };
    function setSpacePreset(preset) { spacePreset = preset; }

    // Called once per frame with the smoothed room→space progress (0→1).
    function updateLighting(p) {
        // Beam holds FULL brightness through the start of the scroll (p ≤ 0.2,
        // i.e. while still settled in the room / objects just beginning to rise),
        // then fades out gradually, gone by ~0.9 — so it never looks like the
        // light "disappears shortly" right after the intro. (Old 1−p/0.85 began
        // dimming from the very first bit of scroll.)
        // Gone by p = 0.4 rather than 0.9. The old curve deliberately held the
        // beam most of the way into the transition so it would not look like the
        // light "disappeared shortly" after the intro — but that reads as the
        // shaft outstaying the room it belongs to, still hanging in the air while
        // the walls are visibly breaking up. Leaving early makes the room's
        // dissolve the thing you watch.
        uBeamFade.value = THREE.MathUtils.clamp((0.4 - p) / 0.35, 0, 1);

        // Recomputed every frame — even at settled p=0/p=1 — so switching the
        // skybox preset while sitting still in 'room' or 'space' takes effect
        // immediately instead of only updating the next time p crosses back
        // through the transition. lerp(x, y, 0)=x and lerp(x, y, 1)=y exactly,
        // so this is a no-op at the endpoints when the preset hasn't changed.
        const [ar, ag, ab] = spacePreset.ambientColor;
        const [dr, dg, db] = spacePreset.directionalColor;

        // Ambient: dark warm brown (room) → space preset
        ambientLight.color.setRGB(
            THREE.MathUtils.lerp(0.24, ar, p),   // R  (0x3d = 61 → 0.24)
            THREE.MathUtils.lerp(0.13, ag, p),   // G  (0x20 = 32 → 0.13)
            THREE.MathUtils.lerp(0.06, ab, p)    // B  (0x10 = 16 → 0.06)
        );
        ambientLight.intensity = THREE.MathUtils.lerp(0.4 * roomLighting.ambient, spacePreset.ambientIntensity, p) * lightBoost.ambient;

        // Directional: warm amber key (0xffe8b0) → space preset
        directionalLight.color.setRGB(
            THREE.MathUtils.lerp(1.00, dr, p),
            THREE.MathUtils.lerp(0.91, dg, p),   // 0xe8 = 232 → 0.91
            THREE.MathUtils.lerp(0.69, db, p)    // 0xb0 = 176 → 0.69
        );
        // roomKey applies to the ROOM end of the blend only, so space still lands
        // on exactly the preset intensity it always did and this change cannot
        // alter the look once the room is gone.
        directionalLight.intensity = THREE.MathUtils.lerp(2.6 * roomLighting.roomKey, spacePreset.directionalIntensity, p) * lightBoost.directional;

        // Fades out with the room for the same reason wallFill does: it exists to
        // solve a room-lighting problem, and in space the preset is meant to be
        // the whole look rather than something with an extra key added on top.
        objectKey.intensity = THREE.MathUtils.lerp(roomLighting.objectKey, 0.0, p);

        // Tied to the beam's own fade so the light and the visible shaft leave
        // together — a lit pool with no shaft above it reads as a mistake.
        beamLight.intensity = roomLighting.beam * uBeamFade.value;

        // Width drives the visible cone and the spotlight TOGETHER. Scaling only
        // the mesh would give a wider haze lighting nothing at its new edges;
        // only the angle would light a pool with no shaft over part of it.
        beamMesh.scale.set(roomLighting.beamWidth, 1, roomLighting.beamWidth);
        beamLight.angle = Math.atan((BEAM_RADIUS * roomLighting.beamWidth) / BEAM_LEN);
        beamLight.penumbra = roomLighting.beamSoftness;
        // Softness 0 -> exponent 1 (linear fade); 1 -> 5 (tight core, wide fade).
        uBeamEdge.value = 1.0 + roomLighting.beamSoftness * 4.0;
        uBeamHaze.value = roomLighting.beamHaze;

        const sx = roomLighting.beamShiftX, sz = roomLighting.beamShiftZ;
        beamMesh.position.set(BEAM_CENTER.x + sx, BEAM_CENTER.y, BEAM_CENTER.z + sz);
        beamLight.position.set(BEAM_TIP.x + sx, BEAM_TIP.y, BEAM_TIP.z + sz);
        beamLight.target.position.set(BEAM_BASE.x + sx, BEAM_BASE.y, BEAM_BASE.z + sz);
        beamLight.target.updateMatrixWorld();

        // The wall fill exists to solve a ROOM problem — a wall the key light
        // can't reach. Once the room has dissolved there's no wall left to lift,
        // and in space the preset lighting is meant to be the whole look, so it
        // fades out with the transition rather than quietly brightening one side
        // of every floating object.
        wallFill.intensity = THREE.MathUtils.lerp(0.55 * roomLighting.wallFill, 0.0, p) * lightBoost.ambient;

        // Fade the visible sun in with the transition: hidden in the room (we're
        // indoors — the window beam is the source there), easing in over the
        // second half of the scroll so it's fully present in space. Sharing the
        // same fade curve shape as the beam's fade-out means one source hands
        // over to the other rather than both being visible at once.
        const sunFade = THREE.MathUtils.clamp((p - 0.45) / 0.45, 0, 1);
        const sunEase = sunFade * sunFade * (3 - 2 * sunFade); // smoothstep
        sunCoreMat.opacity = sunEase;
        sunGlowMat.opacity = sunEase * 0.85;
        sunGroup.visible   = sunEase > 0.001; // skip drawing it entirely in the room

        // Rim tint always tracks the current ambient color/intensity (even at
        // settled p=0/p=1, unlike the block above) so every object's edges
        // pick up whatever's actually around them right now.
        uRimColor.value.copy(ambientLight.color);
        uRimStrength.value = THREE.MathUtils.clamp(ambientLight.intensity * 0.3, 0.05, 0.6);
    }

    return { ambientLight, directionalLight, updateLighting, setSpacePreset, applyLightAngle, setShadowQuality };
}
