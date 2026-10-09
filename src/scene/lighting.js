import * as THREE from 'three';

// All scene lights, the fake volumetric light beam, and the visible sun in space.
// updateLighting(p) blends everything from the room look (p = 0) to space (p = 1).

// ─── Fake volumetric light beam ──────────────────────────────────────────────
// A cone with a gradient shader: brightest at the tip (the light source), fading
// to transparent at the floor. ConeGeometry's apex is at local +Y, so it is
// rotated to point +Y at the tip.
const BEAM_TIP  = new THREE.Vector3(-3.8,  3.2,  1.1); // upper-left, light entry
const BEAM_BASE = new THREE.Vector3( 1.5, -3.4, -3.2); // floor intersection
// Cone radius at the floor. The spotlight's angle is derived from it, so the
// visible haze and the lit pool are always the same cone. The tulips sit on the
// cone's edge, in the soft penumbra.
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

                // Edge fade: 1 where the surface faces the camera, 0 at the
                // silhouette (view-space normal.z = cos of the viewing angle).
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
                // pow(), not smoothstep: smoothstep gave a flat solid core with a
                // hard edge; pow() fades continuously. Higher uBeamEdge = softer.
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

    // 192 segments: with fewer, pow() exaggerates the facets into visible bands.
    const beamMesh = new THREE.Mesh(new THREE.ConeGeometry(BEAM_RADIUS, len, 192, 1, true), beamMat);
    beamMesh.position.copy(center);
    beamMesh.quaternion.copy(quat);
    beamMesh.renderOrder = 1;

    return { beamMesh, uBeamFade, uBeamEdge, uBeamHaze };
}

// ─── Key-light direction ─────────────────────────────────────────────────────
// Stored as angles. elevation: 0° = level, 90° = straight down. azimuth: 0° = from
// the front, negative = from the left. Distance is fixed, which keeps the shadow
// camera's framing stable.
const LIGHT_DISTANCE = 10.5; // magnitude of the original (-6, 7, 5) position

// Points the key light out of the nebula's brightest patch, where the visible sun
// sits in space. Keep elevation ≥ 0°, or shadows fall upward onto the wall.
const lightAngle = { elevation: 55, azimuth: -50 };

// ─── Lighting the objects without lighting the room ──────────────────────────
// A light only reaches meshes on its layer. The key light is dimmed for
// everything; a second light on this layer, which only the table and objects
// join, keeps them bright. Layer 1 is the particle bloom layer, hence 2.
export const OBJECT_LIGHT_LAYER = 2;

// Room-end settings (GUI sliders). They only affect the room end of the blend,
// so space always looks the same.
//   roomKey   multiplier on the main key light (reaches everything)
//   objectKey the objects-only light that keeps the still life bright
//   ambient   flat fill on every surface
//   wallFill  extra light on the left wall
// Keeping ambient and wallFill low lets the room fall to near-black outside the
// beam: the beam's contrast is its brightness against the uniform room light.
export const roomLighting = {
    roomKey:   0.20,
    objectKey: 0.6,
    ambient:   0.40,
    wallFill:  0.12,
    beam:      6.0,   // the spotlight that makes the shaft actually light things
    beamWidth: 1.0,   // scales the shaft; mesh and spotlight together
    // Moves the shaft without changing its angle (mesh, spotlight and target together).
    beamShiftX: 0.0,
    beamShiftZ: 0.0,
    // One softness for the haze edge and the spotlight's penumbra, so the two
    // read as one shaft.
    beamSoftness: 0.85,
    // Density of the visible haze, separate from how much light it casts.
    beamHaze: 0.45,
    // Shadow strength per light, 0..1, without changing the light itself.
    // 1 is the maximum: it already removes all of that light inside the shadow.
    beamShadow: 1.0,
    keyShadow:  1.0,
};

// ─── Environment map: objects reflect their surroundings in space ────────────
// three.js's built-in reflections of the background (scene.environment, built
// from the skybox in main.js): sharp on glossy or metal parts, soft light on
// matte ones. Only in space; strength is a GUI slider (Env Map Strength).
export const environmentMap = { strength: 1.0 };

// How much the fill light in space takes the background's colour (measured from
// the skybox in space.js): 0 = white, 1 = the full colour. The full colour made
// objects look painted (a blue vase in the blue nebula); this tints their shadow
// sides so they sit in the background's light. GUI slider (Background Tint).
export const ambientTint = { strength: 0.65 };

// ─── Visible light source ("sun") ────────────────────────────────────────────
// A directional light has no position, so in space there was nothing showing
// where the light comes from. This is a bright core plus a soft halo, placed
// along the light's direction.
const SUN_DISTANCE = 150;  // well inside the 1000-unit skybox, beyond the stars
const SUN_CORE_R   = 1.2;  // small bright disc (~2.5% of screen height)
const SUN_GLOW     = 14;   // halo sprite size

// Radial gradient for the halo, so it fades out instead of showing a hard edge.
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

    // Halo: additive, so it glows over the nebula without a visible edge.
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

// ─── The lights ──────────────────────────────────────────────────────────────

// Single key light from upper-left-front — matches the photo's Rembrandt-style
// raking light. Its position comes from lightAngle; the visible sun is put in
// the same direction.
function createKeyLight(sunGroup) {
    const light = new THREE.DirectionalLight(0xffe8b0, 2.6);
    light.castShadow = true;
    // Shadow camera framed tightly (±5) around the table and objects, so the map's
    // resolution isn't wasted on empty floor. Anything outside it casts no shadow.
    light.shadow.bias        = -0.0002;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far  = 26;
    light.shadow.camera.left = -5;
    light.shadow.camera.right = 5;
    light.shadow.camera.top  = 5;
    light.shadow.camera.bottom = -5;
    setShadowQuality(light, 2048);

    // lightAngle → position (the light always aims at the origin).
    const el = THREE.MathUtils.degToRad(lightAngle.elevation);
    const az = THREE.MathUtils.degToRad(lightAngle.azimuth);
    const horizontal = Math.cos(el) * LIGHT_DISTANCE; // shrinks to 0 as it goes overhead
    light.position.set(
        Math.sin(az) * horizontal,
        Math.sin(el) * LIGHT_DISTANCE,
        Math.cos(az) * horizontal
    );
    sunGroup.position.copy(light.position).normalize().multiplyScalar(SUN_DISTANCE);
    return light;
}

// ─── Shadow resolution ───────────────────────────────────────────────────────
// A bigger map means smaller stair-steps on shadow edges (most visible on the
// pale plinths), at 4x the cost per doubling. normalBias is kept at just over
// one texel: less gives shadow acne, more detaches shadows from objects.
const SHADOW_FRUSTUM = 10; // world units across (camera.left..right)
function setShadowQuality(light, size) {
    light.shadow.mapSize.set(size, size);
    light.shadow.normalBias = 1.2 * (SHADOW_FRUSTUM / size);
    // Dispose the old map so three builds one at the new size next frame.
    if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
    }
}

// ─── Left-wall fill ──────────────────────────────────────────────────────────
// The key light comes from the left, so the left wall faces away from it and
// got only flat ambient. This light shines from +X back toward it (and gives
// the objects a soft second edge). No shadows: they'd point the other way and
// look confused, and a shadow-casting light costs a whole extra render.
function createWallFill() {
    const light = new THREE.DirectionalLight(0xffd0a0, 0.55);
    light.position.set(6, 1.5, 2);
    light.castShadow = false;
    return light;
}

// The objects-only key (OBJECT_LIGHT_LAYER), aimed along the beam so the
// visible shaft appears to light the still life. No shadows: the beam and
// the key light already cast them.
function createObjectKey() {
    const light = new THREE.DirectionalLight(0xffe8b0, roomLighting.objectKey);
    light.castShadow = false;
    light.layers.set(OBJECT_LIGHT_LAYER);
    light.position.copy(new THREE.Vector3().subVectors(BEAM_TIP, BEAM_BASE).normalize().multiplyScalar(12));
    return light;
}

// ─── The shaft as an actual light ────────────────────────────────────────────
// The beam mesh is only visible haze; it lights nothing. This spotlight, on
// the same axis and cone, makes the lit pool on the table and floor. It casts
// shadows, or the beam would shine through the table.
function createBeamLight() {
    const light = new THREE.SpotLight(0xffe8b0, roomLighting.beam);
    light.position.copy(BEAM_TIP);
    light.target.position.copy(BEAM_BASE);
    light.angle    = Math.atan(BEAM_RADIUS / BEAM_LEN);
    light.penumbra = roomLighting.beamSoftness;
    light.decay    = 0;     // no distance falloff: the shaft reads as even
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far  = 20;
    light.shadow.bias        = -0.0005;
    // normalBias stops curved surfaces (the scanned stone) shadowing themselves
    // with thin dark streaks. 0.02 is a few texels, small next to the objects.
    light.shadow.normalBias  = 0.02;
    return light;
}

// Every frame: the visible cone and its spotlight follow the GUI settings
// together (width, softness, haze, shift), and fade out by p = 0.4, so the beam
// doesn't hang in the air while the walls around it dissolve.
function updateBeam(beam, beamLight, p) {
    beam.uBeamFade.value = THREE.MathUtils.clamp((0.4 - p) / 0.35, 0, 1);
    // Fades with the visible beam, so there's never a lit pool without a shaft.
    beamLight.intensity = roomLighting.beam * beam.uBeamFade.value;
    beamLight.shadow.intensity = roomLighting.beamShadow;

    beam.beamMesh.scale.set(roomLighting.beamWidth, 1, roomLighting.beamWidth);
    beamLight.angle = Math.atan((BEAM_RADIUS * roomLighting.beamWidth) / BEAM_LEN);
    beamLight.penumbra = roomLighting.beamSoftness;
    // Softness 0 -> exponent 1 (linear fade); 1 -> 5 (tight core, wide fade).
    beam.uBeamEdge.value = 1.0 + roomLighting.beamSoftness * 4.0;
    beam.uBeamHaze.value = roomLighting.beamHaze;

    const sx = roomLighting.beamShiftX, sz = roomLighting.beamShiftZ;
    beam.beamMesh.position.set(BEAM_CENTER.x + sx, BEAM_CENTER.y, BEAM_CENTER.z + sz);
    beamLight.position.set(BEAM_TIP.x + sx, BEAM_TIP.y, BEAM_TIP.z + sz);
    beamLight.target.position.set(BEAM_BASE.x + sx, BEAM_BASE.y, BEAM_BASE.z + sz);
    beamLight.target.updateMatrixWorld();
}

// Every frame: the sun fades in over the second half of the scroll, after the
// beam has gone, so one light source hands over to the other. Returns its
// eased strength (0 → 1).
function updateSun(sun, p) {
    const sunFade = THREE.MathUtils.clamp((p - 0.45) / 0.45, 0, 1);
    const sunEase = sunFade * sunFade * (3 - 2 * sunFade); // smoothstep
    sun.coreMat.opacity = sunEase;
    sun.glowMat.opacity = sunEase * 0.85;
    sun.group.visible   = sunEase > 0.001; // skip drawing it entirely in the room
    return sunEase;
}

// ─── Lighting ────────────────────────────────────────────────────────────────
export function setupLighting(scene) {
    // Warm ambient fill (intensity is set every frame in updateLighting).
    const ambientLight = new THREE.AmbientLight(0x3d2010, 0.4);
    const sun = createSun();
    const directionalLight = createKeyLight(sun.group);
    const wallFill = createWallFill();
    const objectKey = createObjectKey();
    const beam = createBeam();
    const beamLight = createBeamLight();
    scene.add(ambientLight, directionalLight, wallFill, objectKey, sun.group, beam.beamMesh,
        beamLight, beamLight.target);

    // The light colours and intensities at p = 1, set per skybox by
    // setSpacePreset() (see LIGHTING_PRESETS in scene/space.js).
    let spacePreset = {
        ambientColor:         [0.05, 0.08, 0.22],
        ambientIntensity:     0.0,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 3.5,
    };
    function setSpacePreset(preset) { spacePreset = preset; }

    // Called once per frame with the smoothed room→space progress (0→1).
    function updateLighting(p) {
        // Recomputed every frame, so a skybox change applies immediately even
        // while sitting still.
        const [ar, ag, ab] = spacePreset.ambientColor.map((c) => 1 + (c - 1) * ambientTint.strength);
        const [dr, dg, db] = spacePreset.directionalColor;

        // Ambient: dark warm brown (room) → space preset
        ambientLight.color.setRGB(
            THREE.MathUtils.lerp(0.24, ar, p),   // R  (0x3d = 61 → 0.24)
            THREE.MathUtils.lerp(0.13, ag, p),   // G  (0x20 = 32 → 0.13)
            THREE.MathUtils.lerp(0.06, ab, p)    // B  (0x10 = 16 → 0.06)
        );
        ambientLight.intensity = THREE.MathUtils.lerp(0.4 * roomLighting.ambient, spacePreset.ambientIntensity, p);

        // Directional: warm amber key (0xffe8b0) → space preset
        directionalLight.color.setRGB(
            THREE.MathUtils.lerp(1.00, dr, p),
            THREE.MathUtils.lerp(0.91, dg, p),   // 0xe8 = 232 → 0.91
            THREE.MathUtils.lerp(0.69, db, p)    // 0xb0 = 176 → 0.69
        );
        directionalLight.intensity = THREE.MathUtils.lerp(
            2.6 * roomLighting.roomKey, spacePreset.directionalIntensity, p);
        directionalLight.shadow.intensity = roomLighting.keyShadow;

        // Room-only lights: in space the preset is the whole look, and there's
        // no wall left to light.
        objectKey.intensity = THREE.MathUtils.lerp(roomLighting.objectKey, 0.0, p);
        wallFill.intensity = THREE.MathUtils.lerp(0.55 * roomLighting.wallFill, 0.0, p);

        updateBeam(beam, beamLight, p);

        // The environment map fades in with the sun: none in the room, where
        // objects shouldn't reflect the nebula.
        scene.environmentIntensity = environmentMap.strength * updateSun(sun, p);
    }

    return { updateLighting, setSpacePreset };
}
