import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Room-mode limits (applied initially, relaxed when in space)
// Limits calculated from orbital radius (r≈6.1) and room bounds
// maxPolar: acos((-3.3 - targetY) / r) = 1.70 rad — keeps camera above floor
// azimuth ±0.55π: keeps camera away from back wall at z=-7
const ROOM_LIMITS = {
    minAzimuth: -Math.PI * 0.55,
    maxAzimuth:  Math.PI * 0.55,
    minPolar:    Math.PI * 0.1,
    maxPolar:    1.65,
};

// Camera is "at the starting point" when within this distance of the target.
// Original orbit radius ≈ 6.1; add a small margin so the switch feels natural.
export const ROOM_RETURN_DIST = 5.5; // orbit radius from new camera (~3.8 units); 5.5 gives comfortable margin

const ZOOM_OUT_START = 0.5;
const ZOOM_OUT_EXTRA = 3.0; // extra distance (units) added by p = 1

// LOOK_UP_START matches FLOAT_START in simulation/floating.js — objects only
// start rising off the table at that point, so there's nothing to tilt toward
// before it.
const LOOK_UP_START = 0.2;
const LOOK_UP_EXTRA = 2.4; // extra height added to the look-at target by p = 1

export function createCameraControls(camera, domElement) {
    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan     = false;
    controls.enableZoom    = false;
    controls.rotateSpeed   = 1.0;
    controls.target.set(0, -0.69, -0.5); // aimed at scene center, shifted up with camera

    // Captured once at startup — the baseline orbit distance/target height the
    // auto zoom-out (see updateAutoZoomOut) adds extra distance/height on top of.
    const initialOrbitDist = camera.position.distanceTo(controls.target);
    const initialTargetY   = controls.target.y;

    // Armed once the user zooms out past ROOM_RETURN_DIST after entering space.
    // Prevents the room from immediately re-appearing when the room first dissolves
    // (camera starts inside the threshold).
    const zoomState = { hasZoomedOut: false };

    function applyControlMode(progressValue) {
        const inSpace = progressValue >= 0.95;
        controls.minAzimuthAngle = inSpace ? -Infinity : ROOM_LIMITS.minAzimuth;
        controls.maxAzimuthAngle = inSpace ?  Infinity : ROOM_LIMITS.maxAzimuth;
        controls.minPolarAngle   = inSpace ?  0        : ROOM_LIMITS.minPolar;
        controls.maxPolarAngle   = inSpace ?  Math.PI  : ROOM_LIMITS.maxPolar;
        controls.minDistance = 2;
        controls.maxDistance = 200;
        // enableZoom managed every frame by updateZoom()
    }
    applyControlMode(0);

    // Zoom is ON whenever fully in space AND (not yet zoomed out OR still far).
    // Turns OFF only after the user zoomed out past ROOM_RETURN_DIST and has
    // now zoomed back in — at that point scroll restores the room instead.
    function updateZoom(progressValue) {
        if (progressValue >= 1.0) {
            const dist = camera.position.distanceTo(controls.target);
            if (dist > ROOM_RETURN_DIST) zoomState.hasZoomedOut = true;
            controls.enableZoom = !zoomState.hasZoomedOut || dist > ROOM_RETURN_DIST;
        } else {
            controls.enableZoom = false;
        }
    }

    // Pulls the camera back as p rises past ZOOM_OUT_START so the viewer can
    // see objects rising out of frame, and tilts the view upward as p rises
    // past LOOK_UP_START so it keeps tracking them as they float higher.
    // Only runs during the scroll-driven 'room' phase; once 'space' is
    // reached, manual OrbitControls zoom/orbit takes over and this stops
    // touching the camera.
    function updateAutoZoomOut(phase, p) {
        if (phase !== 'room') return;
        const zoomT = Math.max(0, (p - ZOOM_OUT_START) / (1 - ZOOM_OUT_START));
        const desiredDist = initialOrbitDist + ZOOM_OUT_EXTRA * zoomT;
        const dir = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(controls.target).addScaledVector(dir, desiredDist);

        // Camera itself only rises a little (20% of the extra pull-back distance)...
        const riseY = 0.2 * ZOOM_OUT_EXTRA * zoomT;
        camera.position.y += riseY;

        // ...but the look-at target rises faster than the camera, so the
        // gaze angle pitches upward over time instead of just translating —
        // that's what keeps objects in frame as they float up past the
        // camera's height.
        const lookT = Math.max(0, (p - LOOK_UP_START) / (1 - LOOK_UP_START));
        controls.target.y = initialTargetY + riseY + LOOK_UP_EXTRA * lookT;
    }

    return { controls, zoomState, applyControlMode, updateZoom, updateAutoZoomOut };
}
