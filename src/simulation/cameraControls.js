import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLOAT_START } from './floating.js';

// Room-mode limits (applied initially, relaxed when in space)
// Limits calculated from orbital radius (r≈6.1) and room bounds.
// maxPolar: acos((-3.3 - targetY) / r) = 1.70 rad — keeps camera above floor.
// Azimuth is deliberately narrow (±30°): the viewer can look around a little,
// but can't orbit far enough to see the volumetric light beam's bright origin
// against the wall from the side (where it read as an odd bright cylinder).
// Space mode (p ≥ 0.95) removes these limits, but the beam has faded out by
// then, so there's no source to reveal.
const ROOM_AZIMUTH = Math.PI / 6; // 30° each side of the front view
const ROOM_LIMITS = {
    minAzimuth: -ROOM_AZIMUTH,
    maxAzimuth:  ROOM_AZIMUTH,
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
// Extra orbit distance added by p = 1. The camera keeps its ROOM position and
// gaze; it only dollies straight back along its original view direction so the
// whole rising still-life fits on screen. (Bumped from 5.5 to 8.0 to compensate
// for no longer raising the camera / tilting the gaze up — pure pull-back needs
// more distance to keep the floating objects framed.)
const ZOOM_OUT_EXTRA = 8.0;

export function createCameraControls(camera, domElement) {
    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan     = false;
    controls.enableZoom    = false;
    controls.rotateSpeed   = 1.0;
    controls.target.set(0, -0.69, -0.5); // aimed at scene center, shifted up with camera
    // Disabled until the painting intro (if any) finishes dissolving — see
    // main.js, which flips this to true once createPaintingIntro's reveal
    // completes (or immediately, if there's no intro image to show).
    controls.enabled = false;

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

    // Orbit distance the dolly-back grows from. Tracks the viewer's current
    // distance while free-looking in the room, then the transition adds
    // ZOOM_OUT_EXTRA on top of it — the DIRECTION is left to OrbitControls the
    // whole time, so the viewer keeps orbiting freely even mid-scroll.
    let activeDist = initialOrbitDist;

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
    function updateAutoZoomOut(p) {
        // Driven purely by the SMOOTHED p across the room→space transition (and
        // its reverse). Deliberately NOT gated on phase === 'room': the phase
        // flips to 'space' the instant the RAW scroll target reaches 1, which on
        // a quick scroll is many frames before the smoothed p (what the visuals
        // ease along) actually gets there. Gating on phase froze the pull-back
        // and upward look mid-transition — the camera stopped rising as it
        // entered space. Two hand-offs bracket the auto motion instead:
        //   • p ≤ ZOOM_OUT_START  → still in the room: OrbitControls owns the
        //     free look-around (within ROOM_LIMITS).
        //   • p ≥ 0.999           → fully in space: OrbitControls takes over for
        //     manual orbit/zoom, starting from the finished transition pose.
        if (p <= ZOOM_OUT_START) {
            // Still free-looking in the room: remember the current orbit distance
            // so the dolly-back begins from exactly here (no jump).
            activeDist = camera.position.distanceTo(controls.target);
            return;
        }
        if (p >= 0.999) return;
        // smoothstep-eased so the pull-back starts and ends gently, matching the
        // eased object float (simulation/floating.js) — a linear ramp jerked the
        // camera into motion the instant scrolling crossed ZOOM_OUT_START.
        const rawZoomT = Math.max(0, (p - ZOOM_OUT_START) / (1 - ZOOM_OUT_START));
        const zoomT  = rawZoomT * rawZoomT * (3 - 2 * rawZoomT);
        const desiredDist = activeDist + ZOOM_OUT_EXTRA * zoomT;

        // Enforce only the DISTANCE — rescale the current camera→target offset to
        // desiredDist, preserving its DIRECTION. OrbitControls (which runs right
        // after, with zoom disabled during the transition) keeps owning the angle,
        // so the viewer can orbit and explore the whole time while the scene
        // still pulls back with the scroll. target is fixed, so this can't feed
        // back / run away. At zoomT≈0 desiredDist≈activeDist → no jump.
        const offset = camera.position.clone().sub(controls.target);
        const len = offset.length();
        if (len > 1e-4) {
            camera.position.copy(controls.target).addScaledVector(offset, desiredDist / len);
        }
    }

    return { controls, zoomState, applyControlMode, updateZoom, updateAutoZoomOut };
}
