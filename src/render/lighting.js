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
const BEAM_TIP  = new THREE.Vector3(-4.5,  2.8,  2.0); // upper-left, light entry
const BEAM_BASE = new THREE.Vector3( 0.8, -3.4, -2.3); // floor intersection

function createBeam() {
    const axis    = new THREE.Vector3().subVectors(BEAM_TIP, BEAM_BASE).normalize();
    const len     = BEAM_TIP.distanceTo(BEAM_BASE);          // ~9.2 units
    const halfLen = len * 0.5;
    const center  = new THREE.Vector3().addVectors(BEAM_TIP, BEAM_BASE).multiplyScalar(0.5);
    const quat    = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

    // uBeamFade driven each frame by updateLighting() to dissolve with the room
    const uBeamFade = { value: 1.0 };

    const beamMat = new THREE.ShaderMaterial({
        uniforms: { uBeamFade },
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
            varying float vTipness;
            varying float vEdgeFade;
            void main() {
                // Tip-to-base fall-off (quadratic) × soft silhouette edge × room fade
                float edge  = smoothstep(0.0, 0.5, vEdgeFade); // transparent at edge, solid toward centre
                float alpha = vTipness * vTipness * 0.30 * edge * uBeamFade; // brighter so the shaft reads clearly
                gl_FragColor = vec4(1.0, 0.91, 0.65, alpha);
            }
        `,
        transparent: true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
        side:        THREE.DoubleSide,
    });

    const beamMesh = new THREE.Mesh(new THREE.ConeGeometry(2.2, len, 48, 1, true), beamMat);
    beamMesh.position.copy(center);
    beamMesh.quaternion.copy(quat);
    beamMesh.renderOrder = 1;

    return { beamMesh, uBeamFade };
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
    directionalLight.shadow.mapSize.set(1024, 1024);
    directionalLight.shadow.bias       = -0.001; // prevents shadow acne (self-shadowing stripes)
    directionalLight.shadow.normalBias =  0.004; // normalBias pushes the shadow lookup along the
                                                 // surface normal, which detaches the contact
                                                 // shadow from small objects (the stone) — the
                                                 // "peter-panning" gap. Lowered from 0.008 to
                                                 // shrink that gap while staying acne-free at 1024.
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far  = 30;
    directionalLight.shadow.camera.left = -8;
    directionalLight.shadow.camera.right = 8;
    directionalLight.shadow.camera.top  = 8;
    directionalLight.shadow.camera.bottom = -8;
    scene.add(directionalLight);

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

    const { beamMesh, uBeamFade } = createBeam();
    scene.add(beamMesh);

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
        uBeamFade.value = THREE.MathUtils.clamp((0.9 - p) / 0.7, 0, 1);

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
        ambientLight.intensity = THREE.MathUtils.lerp(0.4, spacePreset.ambientIntensity, p) * lightBoost.ambient;

        // Directional: warm amber key (0xffe8b0) → space preset
        directionalLight.color.setRGB(
            THREE.MathUtils.lerp(1.00, dr, p),
            THREE.MathUtils.lerp(0.91, dg, p),   // 0xe8 = 232 → 0.91
            THREE.MathUtils.lerp(0.69, db, p)    // 0xb0 = 176 → 0.69
        );
        directionalLight.intensity = THREE.MathUtils.lerp(2.6, spacePreset.directionalIntensity, p) * lightBoost.directional;

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

    return { ambientLight, directionalLight, updateLighting, setSpacePreset, applyLightAngle };
}
