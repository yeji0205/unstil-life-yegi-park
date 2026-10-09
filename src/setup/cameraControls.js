import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FLOAT_START } from '../effects/floating.js';

// Orbit camera: room limits that open up in space, the scroll-driven pull-back
// during the transition, and the zoom hand-off back to the room.

// Room limits. Azimuth is narrow (±30°) so the viewer can't swing round far
// enough to see the light beam's origin side-on. maxPolar keeps the camera above
// the floor. Space (p ≥ 0.95) removes them; the beam is gone by then.
const ROOM_AZIMUTH = Math.PI / 6; // 30° each side of the front view
const ROOM_LIMITS = {
    minAzimuth: -ROOM_AZIMUTH,
    maxAzimuth:  ROOM_AZIMUTH,
    minPolar:    Math.PI * 0.1,
    maxPolar:    1.65,
};

// In space, zooming back in closer than this hands the wheel to the room scroll.
export const ROOM_RETURN_DIST = 5.5; // orbit radius from new camera (~3.8 units); 5.5 gives comfortable margin

// The pull-back starts when the objects start rising, so they never drift out of frame.
const ZOOM_OUT_START = FLOAT_START;
// Extra orbit distance by p = 1, so the risen still life fits on screen. If it
// looks too small in space, lower this.
const ZOOM_OUT_EXTRA = 8.0;

// How far the gaze rises by p = 1: the risen objects sit ~1.3 above the room's
// target height. See setGazeHeight.
const GAZE_RISE = 1.4;

// The orbit limits ease between room and space instead of snapping. A snap
// teleported the camera back into the room's ±30° cone in one frame.
const LIMIT_RELEASE_START = 0.6;   // fully room-limited at or below this p
const LIMIT_RELEASE_END   = 0.95;  // fully free at or above (unchanged)

// The cone may open instantly but only close at this rate, so a fast scroll
// home can't wrench the camera round. It may lag p for a second or two.
const CONE_CLOSE_RATE = 1.0; // radians per second

function createOrbitControls(camera, domElement) {
    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan     = false;
    controls.enableZoom    = false;
    controls.rotateSpeed   = 1.0;
    // Negative = reversed: scroll up zooms out, down zooms in, matching the room
    // scroll (up = toward space). Otherwise going home needed a direction change
    // mid-gesture. OrbitControls uses it as an exponent, so pinch and
    // middle-drag are reversed too.
    controls.zoomSpeed     = -1.0;
    controls.target.set(0, -0.69, -0.5); // aimed at scene center, shifted up with camera
    // Disabled until the loading screen is gone; main.js enables it then.
    controls.enabled = false;
    return controls;
}

// Moves the orbit cone toward where release t (0 = room, 1 = free) says it
// should be: opening is instant, closing at most CONE_CLOSE_RATE per second.
function moveCone(cone, t, dt) {
    if (t >= 1) {
        // Fully free in space; the cone is parked open for the way back.
        cone.az = Math.PI; cone.polarMin = 0; cone.polarMax = Math.PI;
        return;
    }
    // Where p says the cone should be...
    const wantAz  = THREE.MathUtils.lerp(ROOM_AZIMUTH, Math.PI, t);
    const wantMin = THREE.MathUtils.lerp(ROOM_LIMITS.minPolar, 0,       t);
    const wantMax = THREE.MathUtils.lerp(ROOM_LIMITS.maxPolar, Math.PI, t);
    // ...and how far it may move there this frame: opening free, closing capped.
    const step = CONE_CLOSE_RATE * dt;
    cone.az       = wantAz  >= cone.az       ? wantAz  : Math.max(wantAz,  cone.az - step);
    cone.polarMin = wantMin <= cone.polarMin ? wantMin : Math.min(wantMin, cone.polarMin + step);
    cone.polarMax = wantMax >= cone.polarMax ? wantMax : Math.max(wantMax, cone.polarMax - step);
}

export function createCameraControls(camera, domElement) {
    const controls = createOrbitControls(camera, domElement);

    // Snapshot at startup. The pull-back is computed from this plus p, never from
    // last frame's position, which used to feed back and run away.
    const initialOffset    = camera.position.clone().sub(controls.target);
    const initialOrbitDist = initialOffset.length();
    const initialTargetY   = controls.target.y;

    // Orbit distance the pull-back starts from (tracks the viewer's zoom in the room).
    let activeDist = initialOrbitDist;

    // Return trip from space: the viewer may have zoomed anywhere, so that
    // difference is measured once and eased away. See updateAutoZoomOut.
    let leftSpace = false;
    let reentryOffset = 0;

    // Set once the viewer zooms out past ROOM_RETURN_DIST in space, so the room
    // doesn't come back the moment space is reached.
    const zoomState = { hasZoomedOut: false };

    // The current orbit cone (see moveCone).
    const cone = { az: ROOM_AZIMUTH, polarMin: ROOM_LIMITS.minPolar, polarMax: ROOM_LIMITS.maxPolar };
    let lastLimitMs  = null;
    // Moves camera and target up together: the frame shifts, the angle and
    // distance stay the same.
    function setGazeHeight(y) {
        const dy = y - controls.target.y;
        if (Math.abs(dy) < 1e-6) return;
        controls.target.y += dy;
        camera.position.y += dy;
    }

    function applyControlMode(progressValue) {
        // Real time, so scrolling harder can't close the cone faster. Clamped so a
        // backgrounded tab doesn't resume with one huge step.
        const now = performance.now();
        const dt  = lastLimitMs === null ? 0 : Math.min(0.1, (now - lastLimitMs) / 1000);
        lastLimitMs = now;

        const t = THREE.MathUtils.smoothstep(progressValue, LIMIT_RELEASE_START, LIMIT_RELEASE_END);
        moveCone(cone, t, dt);
        // Fully free in space: no azimuth limit at all.
        controls.minAzimuthAngle = t >= 1 ? -Infinity : -cone.az;
        controls.maxAzimuthAngle = t >= 1 ?  Infinity :  cone.az;
        controls.minPolarAngle   = cone.polarMin;
        controls.maxPolarAngle   = cone.polarMax;
        controls.minDistance = 2;
        controls.maxDistance = 200;
        // enableZoom managed every frame by updateZoom()
    }
    applyControlMode(0);

    // In space, zoom is on until the viewer has zoomed out past ROOM_RETURN_DIST
    // and come back in; from then on the wheel brings the room back instead.
    // While the room can't be returned to (mid-dissolve, scroll blocked), zoom
    // stays on, otherwise the wheel would do nothing at all.
    function updateZoom(progressValue, { roomReturnBlocked = false } = {}) {
        if (progressValue >= 1.0) {
            const dist = camera.position.distanceTo(controls.target);
            if (dist > ROOM_RETURN_DIST) zoomState.hasZoomedOut = true;
            controls.enableZoom = roomReturnBlocked || !zoomState.hasZoomedOut || dist > ROOM_RETURN_DIST;
        } else {
            controls.enableZoom = false;
        }
    }

    // During the room→space transition: pulls the camera back and lifts the gaze
    // so the rising objects stay in frame. The viewer can still orbit throughout.
    function updateAutoZoomOut(p) {
        // Driven by the smoothed p, not the phase: the phase flips to 'space' as
        // soon as the scroll target hits 1, well before the visuals get there.
        //   p ≤ ZOOM_OUT_START  → in the room, OrbitControls has free look-around
        //   p ≥ 0.999           → in space, manual orbit/zoom takes over
        if (p <= ZOOM_OUT_START) {
            setGazeHeight(initialTargetY);
            // Start the pull-back from wherever the viewer is now (no jump).
            activeDist = camera.position.distanceTo(controls.target);
            reentryOffset = 0;
            leftSpace = false;
            return;
        }
        if (p >= 0.999) { leftSpace = true; return; }
        // Eased, matching the objects' float (effects/floating.js).
        const rawZoomT = Math.max(0, (p - ZOOM_OUT_START) / (1 - ZOOM_OUT_START));
        const zoomT  = rawZoomT * rawZoomT * (3 - 2 * rawZoomT);

        // Lift the gaze with the objects, so they stay centred. Camera and target
        // move together, so it's a shift, not a tilt; the flat-on view of the
        // table is part of the still-life look.
        setGazeHeight(initialTargetY + GAZE_RISE * zoomT);

        const baselineDist = activeDist + ZOOM_OUT_EXTRA * zoomT;

        // Coming back from space, the viewer may be zoomed far from the distance
        // this formula expects. Measure the difference once and shrink it with
        // zoomT, so there's no jump and the camera lands on the room distance.
        if (leftSpace) {
            leftSpace = false;
            const currentDist = camera.position.distanceTo(controls.target);
            reentryOffset = (currentDist - baselineDist) / Math.max(zoomT, 0.05);
        }
        const desiredDist = Math.max(controls.minDistance, baselineDist + reentryOffset * zoomT);

        // Set only the distance; keep the direction, so OrbitControls still owns
        // the viewing angle.
        const offset = camera.position.clone().sub(controls.target);
        const len = offset.length();
        if (len > 1e-4) {
            camera.position.copy(controls.target).addScaledVector(offset, desiredDist / len);
        }
    }

    return { controls, zoomState, applyControlMode, updateZoom, updateAutoZoomOut };
}
