import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLOAT_START } from './floating.js';

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

// Starts exactly when objects start rising (FLOAT_START) — previously this
// waited until p=0.5, leaving a stretch where objects rose with no
// compensating pull-back and drifted out of frame.
const ZOOM_OUT_START = FLOAT_START;
const ZOOM_OUT_EXTRA = 5.5; // extra distance (units) added by p = 1

const LOOK_UP_START = FLOAT_START;
const LOOK_UP_EXTRA = 2.4; // extra height added to the look-at target by p = 1

export function createCameraControls(camera, domElement) {
    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan     = false;
    controls.enableZoom    = false;
    controls.rotateSpeed   = 1.0;
    controls.target.set(0, -0.69, -0.5); // aimed at scene center, shifted up with camera

    // Captured once at startup — the baseline camera↔target offset that
    // updateAutoZoomOut scales/raises, and the target height it adds on top
    // of. Everything below is a pure function of this snapshot plus the
    // current p, never of last frame's camera position — recomputing from
    // "current" position each frame (as this used to) turns any asymmetry
    // between the camera's and target's rise speed into a feedback loop that
    // compounds frame over frame instead of settling.
    const initialOffset    = camera.position.clone().sub(controls.target);
    const initialOrbitDist = initialOffset.length();
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
        const zoomT  = Math.max(0, (p - ZOOM_OUT_START) / (1 - ZOOM_OUT_START));
        const scale  = (initialOrbitDist + ZOOM_OUT_EXTRA * zoomT) / initialOrbitDist;
        const riseY  = 0.2 * ZOOM_OUT_EXTRA * zoomT; // camera's own rise — a little, not as much as the target
        const lookT  = Math.max(0, (p - LOOK_UP_START) / (1 - LOOK_UP_START));

        // Target x/z never move; only its height changes (rising faster than
        // the camera's own riseY tilts the gaze upward toward floating objects).
        controls.target.y = initialTargetY + riseY + LOOK_UP_EXTRA * lookT;

        // Camera position = target(x,z) + the ORIGINAL offset direction,
        // radially scaled — anchored to initialTargetY, not the tilted
        // controls.target.y, so the look-up tilt only rotates the gaze
        // instead of also dragging the camera's own height along with it.
        camera.position.x = controls.target.x + initialOffset.x * scale;
        camera.position.z = controls.target.z + initialOffset.z * scale;
        camera.position.y = initialTargetY + initialOffset.y * scale + riseY;
    }

    return { controls, zoomState, applyControlMode, updateZoom, updateAutoZoomOut };
}
