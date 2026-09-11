import { uProgress } from '../render/dissolve.js';

// How heavily the smoothed uProgress trails the raw scroll target, as an
// exponential time constant in SECONDS: after `tau` it has covered ~63% of the
// remaining distance. This is a FEEL knob, exposed in the GUI:
//
//   higher (0.3–0.5) — objects drift and keep coasting after the wheel stops;
//                      the gentle bob/sway stays visible, so the motion reads
//                      as floating. Too high and input feels laggy.
//   lower  (~0.1)    — p tracks the wheel closely, so objects snap to the
//                      scroll position. That swamps the bob and looks like the
//                      objects are being DRAGGED rather than floating.
//
// 0.28 sits just barely snappier than the original hand-tuned value (a flat
// 0.05 per frame ≈ tau 0.33 at 60 fps), keeping the floaty character.
//
// Unlike the original, this is applied per SECOND rather than per FRAME, so the
// feel no longer changes with the framerate — the old version took 1.5 s to
// settle at 60 fps but over 3 s at 20 fps, i.e. it felt laggiest exactly when
// the scene was already struggling.
export const scrollSmoothing = { tau: 0.28 };

// ─── How long the dissolve takes, in seconds ─────────────────────────────────
// This is the budget EVERYTHING in the effect is spent out of, which makes it
// the real control over how fast the particles move.
//
// A speck's whole existence is measured against the threshold sweep, not against
// the clock: it lives uParticleLife out of the 2.4 noise units the threshold
// covers, so its life in seconds is (life / 2.4) * duration. Its speed is then
// simply drift / that. So at a fixed duration, asking for a wider spread is
// asking for faster specks — the two cannot both improve. Lengthening the
// dissolve is what buys slowness without pulling the plume back in.
//
// Was a hardcoded 3.0. On a slider because it sets the pace of the piece's
// central moment, and that is judged by watching rather than by arithmetic.
export const dissolveDuration = { value: 5.0 };

// 'room'       — room visible, scroll controls uProgress
// 'space'      — room gone, zoom active, waiting for the dissolve button
// 'dissolving' — objects dissolving automatically, scroll blocked
// 'done'       — objects dissolved away (kept, invisible); scroll re-enabled
//
// uProgress < 1              → scroll dissolves / restores room
// uProgress = 1, not yet zoomed out OR still far → OrbitControls zooms
// uProgress = 1, zoomed out AND back to start    → scroll restores room
//
// After a dissolve, the objects are NOT deleted — they're kept at uProgress = 1
// (fully dissolved / invisible). Scrolling back toward the room then drives
// their uProgress from 1 → 0 (see the reverse-dissolve block in update), so the
// exact same objects re-materialize by playing the dissolve effect backwards.
export function createPhaseMachine({ scene, camera, cameraControls, tableState, stageObjects, dissolveController, onObjectsDissolved }) {
    const { controls, zoomState, applyControlMode } = cameraControls;
    const ROOM_RETURN_DIST = 5.5; // kept in sync with simulation/cameraControls.js

    const MAX_DT = 0.1; // ignore huge frame gaps (tab backgrounded, GPU stall)
    // Smoothing time constant for the journey home, replacing scrollSmoothing.tau
    // while p is falling from space. Longer than the normal 0.28 so the arrival
    // is gradual, but not so long that the scroll feels disconnected.
    const RETURN_TAU = 0.75;

    let phase         = 'room';
    let targetP       = 0;   // raw scroll destination; uProgress.value eases toward this
    let lastUpdateT   = null; // for the frame-rate-independent smoothing above
    let scrollBlocked = false;
    // Seconds into the 3s dissolve. ACCUMULATED from per-frame dt rather than
    // measured as (now - startTime), which is what makes it pausable: holding it
    // still holds the whole effect still. The dt it adds is the clamped one, so
    // a backgrounded tab resumes the dissolve where it left off instead of
    // finding it already over.
    let dissolveElapsed = 0;
    let dissolvePaused  = false;
    // True from when a dissolve finishes until the objects have fully
    // re-materialized back in the room. While set, the objects' dissolve amount
    // tracks the scroll (p) so returning to the room reverses the dissolve.
    let objectsDissolved = false;
    // False until the painting intro (if any) finishes dissolving away —
    // see main.js, which calls enableInteraction() once that completes.
    let interactionEnabled = false;

    function resetToRoom() {
        zoomState.hasZoomedOut = false;
        phase = 'room';
        dissolveController.disable();
        // If we're mid reverse-dissolve, DON'T snap the objects/table solid —
        // update()'s reverse-dissolve block eases their uProgress from 1 → 0 as
        // p falls, and re-enables shadows / clears objectsDissolved once solid.
        if (objectsDissolved) return;
        tableState.uProgress.value = 0;
        if (tableState.object) {
            tableState.object.userData.shadowsKilled = false;
            tableState.object.traverse(c => { if (c.isMesh) c.castShadow = true; });
        }
        for (const obj of stageObjects) {
            obj.uProgress.value = 0;
            if (obj.shadowsKilled) {
                obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = true; });
                obj.shadowsKilled = false;
            }
        }
    }

    window.addEventListener('wheel', (e) => {
        // Locked out during the painting intro — nothing to scroll into yet.
        if (!interactionEnabled) return;
        // Block scroll entirely during object dissolve phase
        if (scrollBlocked) return;

        if (targetP >= 1.0) {
            const dist = camera.position.distanceTo(controls.target);
            if (!zoomState.hasZoomedOut || dist > ROOM_RETURN_DIST) return;
        }
        targetP = Math.min(1.0, Math.max(0.0, targetP + e.deltaY * 0.001));
        if (targetP < 0.95) resetToRoom();
        applyControlMode(uProgress.value);
    });

    // Fires when the user clicks the GUI's dissolve button. Only takes effect
    // once the scene is fully in 'space' — the button itself is disabled the
    // rest of the time, but the phase is re-checked here in case a stray click
    // lands mid-transition.
    function triggerDissolve() {
        if (phase !== 'space') return false;
        phase           = 'dissolving';
        dissolveElapsed = 0;
        scrollBlocked   = true;
        dissolveController.disable();
        return true; // caller plays the single dissolve sound when this returns true
    }

    // Freezes/unfreezes the 3s dissolve mid-flight, so the noise pattern on the
    // surfaces can actually be looked at — it is otherwise on screen for about a
    // second per object. Only the dissolve stops; the float, the sway and the
    // particle drift keep running, so a paused frame is still a live scene.
    function setDissolvePaused(value) { dissolvePaused = value; }

    // Advances uProgress toward targetP and runs the phase transitions. Called
    // once per frame; returns the values other simulation/render modules need.
    function update(t) {
        // Ease uProgress.value toward targetP — absorbs trackpad deltaY spikes and
        // gives the objects their drifting, floaty motion. Frame-rate independent:
        // the fraction covered comes from elapsed time, so the feel is identical
        // at 20 or 144 fps. Snap when within 0.001 so it reaches 0 and 1 exactly.
        const dt = lastUpdateT === null ? 1 / 60 : Math.min(t - lastUpdateT, MAX_DT);
        lastUpdateT = t;

        // The long trip home from space is eased harder than ordinary scrolling.
        // Crucially this eases uProgress ITSELF, so the room, the camera dolly,
        // the lighting blend and the objects' re-materialization all arrive
        // together. An earlier attempt eased only the objects, which left them
        // lagging ~1 s behind a room that had already snapped into place — the
        // scene arrived in two stages, which is what read as sudden.
        //
        // Gated to p > 0.3 so it only affects the return from space; small
        // adjustments near the room keep the responsive feel of scrollSmoothing.
        const returning = targetP < uProgress.value && uProgress.value > 0.3;
        const tau = returning ? RETURN_TAU : scrollSmoothing.tau;
        uProgress.value += (targetP - uProgress.value) * (1 - Math.exp(-dt / tau));
        if (Math.abs(targetP - uProgress.value) < 0.001) uProgress.value = targetP;
        const p    = uProgress.value; // smooth — drives all visuals and shaders
        const rawP = targetP;         // instant — used only for state-machine thresholds

        // Re-check every frame (not just on wheel events) — uProgress.value lerps
        // toward targetP over several frames, so checking only on wheel meant the
        // room's orbit limits could stay locked after scrolling stopped, before
        // the lerp actually crossed the 0.95 threshold.
        applyControlMode(p);

        if (phase === 'room' && rawP >= 1.0) {
            phase         = 'space';
            scrollBlocked = false;
            dissolveController.enable(); // button becomes clickable when fully in space
        }

        if (phase === 'dissolving') {
            if (!dissolvePaused) dissolveElapsed += dt;
            const elapsed = dissolveElapsed;
            // Everything — all objects AND the table — dissolves together over 3s.
            const d = Math.min(1.0, Math.max(0.0, elapsed / dissolveDuration.value));
            for (const obj of stageObjects) {
                obj.uProgress.value = d;
                if (obj.uProgress.value >= 1.0 && !obj.shadowsKilled) {
                    obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = false; });
                    obj.shadowsKilled = true;
                }
            }
            tableState.uProgress.value = d;
            if (tableState.uProgress.value >= 1.0 && tableState.object && !tableState.object.userData.shadowsKilled) {
                tableState.object.traverse(c => { if (c.isMesh) c.castShadow = false; });
                tableState.object.userData.shadowsKilled = true;
            }
            if (elapsed >= dissolveDuration.value + 0.2) {
                phase         = 'done';
                scrollBlocked = false;
                // Keep the objects (now fully dissolved / invisible at uProgress=1)
                // so they can reverse-dissolve back on the way home. objectsDissolved
                // hands control of their uProgress to the reverse block below.
                objectsDissolved = true;
                // Everything is invisible right now — the one safe moment to swap
                // models. The replacements are what re-materialize in the room, so
                // the still life that comes back isn't the one that left.
                onObjectsDissolved?.();
            }
        }

        // Reverse dissolve: while the objects are in their dissolved-away state,
        // they re-materialize as the viewer scrolls home — the dissolve effect
        // played backwards, while floating back down onto the table.
        //
        // Driven by p, the SAME value the room and camera use, so everything
        // re-forms in step. The gradualness comes from RETURN_TAU easing p itself
        // (see the top of update), not from a second ease layered on here.
        if (objectsDissolved && phase !== 'dissolving') {
            tableState.uProgress.value = p;
            for (const obj of stageObjects) obj.uProgress.value = p;

            if (p <= 0.02) {
                // Fully home: solidify, restore shadows, and leave the dissolved
                // state so a later scroll-up just floats them (and Dissolve can
                // run fresh — including re-firing each object's whoosh).
                objectsDissolved = false;
                tableState.uProgress.value = 0;
                if (tableState.object) {
                    tableState.object.userData.shadowsKilled = false;
                    tableState.object.traverse(c => { if (c.isMesh) c.castShadow = true; });
                }
                for (const obj of stageObjects) {
                    obj.uProgress.value = 0;
                    if (obj.shadowsKilled) {
                        obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = true; });
                        obj.shadowsKilled = false;
                    }
                }
            }
        }

        return { p, rawP, phase };
    }

    // Called once the painting intro finishes dissolving (or there is none).
    function enableInteraction() { interactionEnabled = true; }

    return { update, triggerDissolve, setDissolvePaused, enableInteraction };
}
