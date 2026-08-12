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

    // Bookkeeping for the return trip: `leftSpace` marks that the camera was
    // last under manual control in space (so its distance is whatever the viewer
    // zoomed to, not what the transition formula expects), and `reentryOffset`
    // holds the resulting discrepancy while it's eased away. See updateAutoZoomOut.
    let leftSpace = false;
    let reentryOffset = 0;

    // Armed once the user zooms out past ROOM_RETURN_DIST after entering space.
    // Prevents the room from immediately re-appearing when the room first dissolves
    // (camera starts inside the threshold).
    const zoomState = { hasZoomedOut: false };

    // The orbit limits EASE between room and space instead of switching.
    //
    // They used to flip at p = 0.95. Going out that's harmless, but coming back
    // it was the single most jarring thing in the piece: in space you can orbit
    // anywhere, so if you'd swung round to look at the objects from behind
    // (azimuth ~180°), the frame p crossed 0.95 the limit snapped to ±30° and
    // OrbitControls teleported the camera the whole way round to obey it. That's
    // the sudden jump in the x/y/z readout — not the room appearing, the camera
    // being yanked back inside the room's allowed cone in one frame.
    //
    // Interpolating the LIMIT instead of the camera fixes it without any extra
    // animation machinery: OrbitControls already clamps to whatever the limit is
    // each frame, so a limit that closes gradually sweeps the camera home
    // gradually. Scroll speed sets the pace, and it stays interruptible — stop
    // scrolling and the camera stops where it is.
    const LIMIT_RELEASE_START = 0.6;   // fully room-limited at or below this p
    const LIMIT_RELEASE_END   = 0.95;  // fully free at or above (unchanged)
    function applyControlMode(progressValue) {
        const t = THREE.MathUtils.smoothstep(progressValue, LIMIT_RELEASE_START, LIMIT_RELEASE_END);
        if (t >= 1) {
            // Genuinely unbounded, so the viewer can keep spinning past 180°
            // without hitting a wall.
            controls.minAzimuthAngle = -Infinity;
            controls.maxAzimuthAngle =  Infinity;
            controls.minPolarAngle   = 0;
            controls.maxPolarAngle   = Math.PI;
        } else {
            // Widening to ±180° means the finite limit is a no-op the instant it
            // engages (OrbitControls reports azimuth wrapped into ±180°), so the
            // hand-off from "unbounded" costs nothing — and from there the cone
            // narrows smoothly back to the room's ±30°.
            const az = THREE.MathUtils.lerp(ROOM_AZIMUTH, Math.PI, t);
            controls.minAzimuthAngle = -az;
            controls.maxAzimuthAngle =  az;
            controls.minPolarAngle   = THREE.MathUtils.lerp(ROOM_LIMITS.minPolar, 0,       t);
            controls.maxPolarAngle   = THREE.MathUtils.lerp(ROOM_LIMITS.maxPolar, Math.PI, t);
        }
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
            reentryOffset = 0;
            leftSpace = false;
            return;
        }
        if (p >= 0.999) { leftSpace = true; return; }
        // smoothstep-eased so the pull-back starts and ends gently, matching the
        // eased object float (simulation/floating.js) — a linear ramp jerked the
        // camera into motion the instant scrolling crossed ZOOM_OUT_START.
        const rawZoomT = Math.max(0, (p - ZOOM_OUT_START) / (1 - ZOOM_OUT_START));
        const zoomT  = rawZoomT * rawZoomT * (3 - 2 * rawZoomT);
        const baselineDist = activeDist + ZOOM_OUT_EXTRA * zoomT;

        // Second half of the same jump. In space the viewer can ZOOM, so by the
        // time they scroll back the camera may be 3 units from the target while
        // this formula, at zoomT ≈ 1, wants activeDist + 8 ≈ 14. The old code
        // wrote that straight in on the first frame back — an instant 11-unit
        // dolly out, which is the other half of what read as "sudden".
        //
        // Rather than fight it, absorb it: measure the discrepancy once on the
        // way back in and carry it as an offset that's scaled by zoomT. At the
        // hand-off (zoomT ≈ 1) the offset exactly cancels the formula, so the
        // camera doesn't move at all; as p falls the offset shrinks with zoomT
        // and it lands on the correct room distance by ZOOM_OUT_START. Free of
        // any timer, so it stays in step with the scroll however fast it's done.
        if (leftSpace) {
            leftSpace = false;
            const currentDist = camera.position.distanceTo(controls.target);
            reentryOffset = (currentDist - baselineDist) / Math.max(zoomT, 0.05);
        }
        const desiredDist = Math.max(controls.minDistance, baselineDist + reentryOffset * zoomT);

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
