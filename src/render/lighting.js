import * as THREE from 'three';

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
                float alpha = vTipness * vTipness * 0.18 * edge * uBeamFade;
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

// ─── Lighting ────────────────────────────────────────────────────────────────
export function setupLighting(scene) {
    // Warm ambient fill — raised from 0.15 so shadowed areas of the room stay
    // readable instead of dropping to near-black.
    const ambientLight = new THREE.AmbientLight(0x3d2010, 0.4);
    scene.add(ambientLight);

    // Single key light from upper-left-front — matches the photo's Rembrandt-style raking light
    const directionalLight = new THREE.DirectionalLight(0xffe8b0, 2.6);
    directionalLight.position.set(-6, 7, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.set(1024, 1024);
    directionalLight.shadow.bias       = -0.003; // prevents shadow acne (self-shadowing stripes)
    directionalLight.shadow.normalBias =  0.02;  // extra offset along surface normal for curved meshes
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far  = 30;
    directionalLight.shadow.camera.left = -8;
    directionalLight.shadow.camera.right = 8;
    directionalLight.shadow.camera.top  = 8;
    directionalLight.shadow.camera.bottom = -8;
    scene.add(directionalLight);

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
        // Beam fades quickly in the first 40% of the scroll so it's gone well
        // before the room walls fully dissolve.
        uBeamFade.value = Math.max(0, 1 - p / 0.4);

        // Only update lighting during transition — skip when fully settled at p=0 or p=1
        if (p > 0.001 && p < 0.999) {
            const [ar, ag, ab] = spacePreset.ambientColor;
            const [dr, dg, db] = spacePreset.directionalColor;

            // Ambient: dark warm brown (room) → space preset
            ambientLight.color.setRGB(
                THREE.MathUtils.lerp(0.24, ar, p),   // R  (0x3d = 61 → 0.24)
                THREE.MathUtils.lerp(0.13, ag, p),   // G  (0x20 = 32 → 0.13)
                THREE.MathUtils.lerp(0.06, ab, p)    // B  (0x10 = 16 → 0.06)
            );
            ambientLight.intensity = THREE.MathUtils.lerp(0.4, spacePreset.ambientIntensity, p);

            // Directional: warm amber key (0xffe8b0) → space preset
            directionalLight.color.setRGB(
                THREE.MathUtils.lerp(1.00, dr, p),
                THREE.MathUtils.lerp(0.91, dg, p),   // 0xe8 = 232 → 0.91
                THREE.MathUtils.lerp(0.69, db, p)    // 0xb0 = 176 → 0.69
            );
            directionalLight.intensity = THREE.MathUtils.lerp(2.6, spacePreset.directionalIntensity, p);
        }
    }

    return { ambientLight, directionalLight, updateLighting, setSpacePreset };
}
