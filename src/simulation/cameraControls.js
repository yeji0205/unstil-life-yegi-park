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
// Extra orbit distance added by p = 1: the camera dollies straight back along
// its original view direction so the whole rising still-life fits on screen.
// 8.0 was chosen while the gaze stayed fixed at the room's height, where the
// only way to keep the risen objects in frame was to back off far enough to
// catch them near the top edge. GAZE_RISE now handles the vertical part, so
// this is doing less work than it was sized for — if the still life reads as
// too small once centred, this is the number to bring down, not the framing.
const ZOOM_OUT_EXTRA = 8.0;

// How far the gaze lifts, in world units, by the time the transition finishes.
// Derived rather than eyeballed: at p = 1 the table top sits at ≈ −0.12 and the
// objects float around ≈ +0.6, so the centre of interest is ~1.3 above the
// room-framing target of −0.69. See setGazeHeight at the call site.
const GAZE_RISE = 1.4;

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

    // ── Why the cone also has a speed limit ─────────────────────────────────
    // Tying the limits to p alone fixed the one-frame teleport but left the
    // sweep's SPEED in the viewer's hands, and in the wrong direction: the
    // faster you scrolled home, the faster the camera was wrenched back. Coming
    // out of space from behind the objects, all 150° of it had to happen inside
    // p 0.95 → 0.6 — about a third of a scroll, which is well under a second if
    // you spin the wheel. That's the jump.
    //
    // So the cone is allowed to WIDEN instantly — nothing is being pushed when
    // it opens — but may only NARROW at a fixed angular rate. How quickly the
    // camera gets swept home is then set by the clock rather than by how hard
    // the wheel was spun, which is the property that was missing.
    //
    // The trade is that the cone can lag p: arrive in the room from a wide angle
    // and for a second or two you can still orbit further than ±30° while it
    // catches up. Preferable to being yanked, and invisible unless you go
    // looking for it.
    const CONE_CLOSE_RATE = 1.0; // radians per second
    let coneAz       = ROOM_AZIMUTH;
    let conePolarMin = ROOM_LIMITS.minPolar;
    let conePolarMax = ROOM_LIMITS.maxPolar;
    let lastLimitMs  = null;
    // Moves camera and target together by the same amount, so the frame shifts
    // vertically while the viewing angle, the orbit radius and the azimuth all
    // stay exactly as they were. OrbitControls derives its offset from
    // (position − target) at the top of every update(), so translating both is
    // invisible to it — nothing to fight over, and the distance the dolly logic
    // measures is unchanged.
    function setGazeHeight(y) {
        const dy = y - controls.target.y;
        if (Math.abs(dy) < 1e-6) return;
        controls.target.y += dy;
        camera.position.y += dy;
    }

    function applyControlMode(progressValue) {
        // Real elapsed time, taken here rather than threaded through the two
        // callers (the frame loop and the wheel handler). A wheel event firing
        // between frames simply sees dt ≈ 0 and contributes no extra narrowing,
        // which is exactly right — scrolling harder must not close the cone
        // faster. Clamped so a backgrounded tab doesn't resume with one huge step.
        const now = performance.now();
        const dt  = lastLimitMs === null ? 0 : Math.min(0.1, (now - lastLimitMs) / 1000);
        lastLimitMs = now;

        const t = THREE.MathUtils.smoothstep(progressValue, LIMIT_RELEASE_START, LIMIT_RELEASE_END);

        if (t >= 1) {
            // Genuinely unbounded, so the viewer can keep spinning past 180°
            // without hitting a wall. The cone is parked fully open so the
            // narrowing starts from there the moment the scroll comes back.
            coneAz = Math.PI; conePolarMin = 0; conePolarMax = Math.PI;
            controls.minAzimuthAngle = -Infinity;
            controls.maxAzimuthAngle =  Infinity;
            controls.minPolarAngle   = 0;
            controls.maxPolarAngle   = Math.PI;
        } else {
            // Where p says the cone should be...
            const wantAz  = THREE.MathUtils.lerp(ROOM_AZIMUTH, Math.PI, t);
            const wantMin = THREE.MathUtils.lerp(ROOM_LIMITS.minPolar, 0,       t);
            const wantMax = THREE.MathUtils.lerp(ROOM_LIMITS.maxPolar, Math.PI, t);

            // ...and how far it is allowed to move toward that this frame.
            // Opening is free; closing is capped. Widening to ±180° also means
            // the finite azimuth limit is a no-op the instant it replaces
            // Infinity (OrbitControls reports azimuth wrapped into ±180°), so
            // the hand-off out of unbounded costs nothing.
            const step = CONE_CLOSE_RATE * dt;
            coneAz       = wantAz  >= coneAz       ? wantAz  : Math.max(wantAz,  coneAz - step);
            conePolarMin = wantMin <= conePolarMin ? wantMin : Math.min(wantMin, conePolarMin + step);
            conePolarMax = wantMax >= conePolarMax ? wantMax : Math.max(wantMax, conePolarMax - step);

            controls.minAzimuthAngle = -coneAz;
            controls.maxAzimuthAngle =  coneAz;
            controls.minPolarAngle   =  conePolarMin;
            controls.maxPolarAngle   =  conePolarMax;
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
            // Back in the room: the still life is on the table at eye level, so
            // the gaze returns to where it started.
            setGazeHeight(initialTargetY);
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

        // Lift the gaze along with the pull-back, so the still life stays centred.
        //
        // Pulling straight back keeps the camera aimed at where the table stood,
        // but the subject doesn't stay there: objects rise by their own H (≈2.2)
        // while the table rises 1.5, so by p = 1 the interesting part of the frame
        // has moved to roughly y = +0.6 while the gaze was still fixed at −0.69.
        // Everything worth looking at ended up in the top third, with the table's
        // pedestal filling the middle and empty space below it.
        //
        // GAZE_RISE closes that ≈1.3-unit gap. It is not a tilt: camera and target
        // move together, so the viewing ANGLE and the orbit radius are untouched
        // and the dolly logic below still measures the distance it expects. A tilt
        // would also work optically but would change the perspective on the table,
        // and the flat-on view is part of the still-life read.
        setGazeHeight(initialTargetY + GAZE_RISE * zoomT);

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
