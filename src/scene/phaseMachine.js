import { uProgress } from '../effects/dissolve.js';

// How far the smoothed progress trails the scroll, as a time constant in seconds
// (GUI slider). Higher = objects keep coasting and read as floating; lower =
// they follow the wheel tightly and look dragged. Per second, not per frame, so
// it feels the same at any framerate.
export const scrollSmoothing = { tau: 0.28 };

// Length of the object dissolve in seconds (GUI slider). Particle life and drift
// are measured against it, so a longer dissolve also means slower particles.
export const dissolveDuration = { value: 5.0 };

// Phases:
// 'room'       — room visible, scroll controls uProgress
// 'space'      — room gone, zoom active, waiting for the dissolve button
// 'dissolving' — objects dissolving automatically, scroll blocked
// 'done'       — objects dissolved away (kept, invisible); scroll re-enabled
//
// uProgress < 1              → scroll dissolves / restores room
// uProgress = 1, not yet zoomed out OR still far → OrbitControls zooms
// uProgress = 1, zoomed out AND back to start    → scroll restores room
//
// Dissolved objects are kept, not deleted. Scrolling home drives their dissolve
// from 1 back to 0, so they re-form by playing the dissolve backwards.
//
// onPhaseChange(phase) reports every phase change (main.js uses it to enable the
// GUI's Dissolve button only in 'space').
export function createPhaseMachine({ scene, camera, cameraControls, tableState, stageObjects, onPhaseChange, onObjectsDissolved }) {
    const { controls, zoomState, applyControlMode } = cameraControls;
    const ROOM_RETURN_DIST = 5.5; // kept in sync with setup/cameraControls.js

    const MAX_DT = 0.1; // ignore huge frame gaps (tab backgrounded, GPU stall)
    // Slower smoothing on the way home from space, so the return is gradual.
    const RETURN_TAU = 0.75;

    let phase         = 'room';
    let targetP       = 0;   // raw scroll destination; uProgress.value eases toward this
    let lastUpdateT   = null; // for the frame-rate-independent smoothing above
    let scrollBlocked = false;
    // Seconds into the dissolve. Accumulated from dt (not now - start), which is
    // what makes it pausable; a backgrounded tab resumes where it left off.
    let dissolveElapsed = 0;
    let dissolvePaused  = false;
    // Counts scrub-bar jumps, so the dissolve sound knows when to jump too.
    let dissolveSeekCount = 0;
    // True from the end of a dissolve until the objects have re-formed in the room.
    // Meanwhile their dissolve follows the scroll (see the reverse dissolve below).
    let objectsDissolved = false;
    // False until the loading screen is gone; main.js calls enableInteraction().
    let interactionEnabled = false;

    function setPhase(next) {
        if (next === phase) return;
        phase = next;
        onPhaseChange?.(phase);
    }

    function resetToRoom() {
        zoomState.hasZoomedOut = false;
        setPhase('room');
        // Mid reverse-dissolve, leave the objects alone; update() re-forms them.
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
        // Ignored until the loading screen is gone.
        if (!interactionEnabled) return;
        // Block scroll entirely during object dissolve phase
        if (scrollBlocked) return;

        if (targetP >= 1.0) {
            const dist = camera.position.distanceTo(controls.target);
            if (!zoomState.hasZoomedOut || dist > ROOM_RETURN_DIST) return;
        }
        // Scroll up (negative deltaY) goes toward space, down comes back. Matches
        // the reversed zoom in setup/cameraControls.js.
        targetP = Math.min(1.0, Math.max(0.0, targetP - e.deltaY * 0.001));
        if (targetP < 0.95) resetToRoom();
        applyControlMode(uProgress.value);
    });

    // The GUI's Dissolve button. Only works in 'space'; the button is disabled
    // otherwise, but a stray click mid-transition is ignored here too.
    function triggerDissolve() {
        if (phase !== 'space') return false;
        dissolveElapsed = 0;
        scrollBlocked   = true;
        setPhase('dissolving');
        return true;
    }

    // Pause/resume the dissolve. Only the dissolve stops; floating and particle
    // drift keep running.
    function setDissolvePaused(value) { dissolvePaused = value; }

    // Scrub bar: jump the dissolve to a fraction of its length. Only while
    // 'dissolving'. Stops at the dissolve's end, before the +0.2 s tail that
    // swaps the models, so dragging to the end doesn't trigger the swap.
    // Returns whether the seek applied.
    function seekDissolve(fraction) {
        if (phase !== 'dissolving') return false;
        const f = Math.min(1, Math.max(0, fraction));
        dissolveElapsed = f * dissolveDuration.value;
        dissolveSeekCount++;
        return true;
    }

    // For the dissolve sound: whether the dissolve is running (not paused, not
    // finished), how many seconds in it is, and the scrub-jump counter.
    function getDissolvePlayback() {
        return { playing: phase === 'dissolving' && !dissolvePaused, time: dissolveElapsed, seekCount: dissolveSeekCount };
    }

    // What the scrub bar shows: the table's dissolve progress, which all objects share.
    function getDissolveFraction() { return tableState.uProgress.value; }

    // Called once per frame: eases uProgress toward the scroll target and runs
    // the phase transitions.
    function update(t) {
        // Smooths out trackpad spikes and gives the floaty motion. Snaps when
        // within 0.001 so it reaches 0 and 1 exactly.
        const dt = lastUpdateT === null ? 1 / 60 : Math.min(t - lastUpdateT, MAX_DT);
        lastUpdateT = t;

        // The trip home (p > 0.3, falling) uses the slower RETURN_TAU. It eases
        // uProgress itself, so room, camera, lights and objects arrive together.
        const returning = targetP < uProgress.value && uProgress.value > 0.3;
        const tau = returning ? RETURN_TAU : scrollSmoothing.tau;
        uProgress.value += (targetP - uProgress.value) * (1 - Math.exp(-dt / tau));
        if (Math.abs(targetP - uProgress.value) < 0.001) uProgress.value = targetP;
        const p    = uProgress.value; // smooth — drives all visuals and shaders
        const rawP = targetP;         // instant — used only for state-machine thresholds

        // Every frame, not only on wheel events: p keeps easing after the wheel stops.
        applyControlMode(p);

        if (phase === 'room' && rawP >= 1.0) {
            scrollBlocked = false;
            setPhase('space'); // the Dissolve button becomes clickable
        }

        if (phase === 'dissolving') {
            if (!dissolvePaused) dissolveElapsed += dt;
            const elapsed = dissolveElapsed;
            // All objects and the table dissolve together over dissolveDuration.
            const d = Math.min(1.0, Math.max(0.0, elapsed / dissolveDuration.value));
            // Shadows off at full dissolve (a saving: nothing is left to cast), back
            // on if the scrub bar rewinds. Safe because the shadow dissolves with
            // the surface (customDepthMaterial).
            const gone = d >= 1.0;
            for (const obj of stageObjects) {
                obj.uProgress.value = d;
                if (gone !== !!obj.shadowsKilled) {
                    obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = !gone; });
                    obj.shadowsKilled = gone;
                }
            }
            tableState.uProgress.value = d;
            if (tableState.object && gone !== !!tableState.object.userData.shadowsKilled) {
                tableState.object.traverse(c => { if (c.isMesh) c.castShadow = !gone; });
                tableState.object.userData.shadowsKilled = gone;
            }
            if (elapsed >= dissolveDuration.value + 0.2) {
                setPhase('done');
                scrollBlocked = false;
                // Keep the invisible objects for the reverse dissolve on the way home.
                objectsDissolved = true;
                // Everything is invisible now: the safe moment to swap in the
                // objects that come back, so the still life isn't the same one.
                onObjectsDissolved?.();
            }
        }

        // Reverse dissolve: on the way home the objects re-form, driven by p, the
        // same value as the room and camera, so everything arrives together.
        if (objectsDissolved && phase !== 'dissolving') {
            tableState.uProgress.value = p;
            for (const obj of stageObjects) obj.uProgress.value = p;

            // Shadows back on as soon as the objects start to re-form, not at the
            // end (that made every shadow appear at once). They grow back with the
            // object because the shadow dissolves with the surface.
            if (p < 0.999) {
                if (tableState.object?.userData.shadowsKilled) {
                    tableState.object.traverse(c => { if (c.isMesh) c.castShadow = true; });
                    tableState.object.userData.shadowsKilled = false;
                }
                for (const obj of stageObjects) {
                    if (obj.shadowsKilled) {
                        obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = true; });
                        obj.shadowsKilled = false;
                    }
                }
            }

            if (p <= 0.02) {
                // Fully home: back to normal, so a new dissolve can run.
                objectsDissolved = false;
                tableState.uProgress.value = 0;
                for (const obj of stageObjects) obj.uProgress.value = 0;
            }
        }

        return { p, rawP, phase };
    }

    // Called by main.js once the loading screen is gone.
    function enableInteraction() { interactionEnabled = true; }

    return { update, triggerDissolve, setDissolvePaused, seekDissolve, getDissolveFraction, getDissolvePlayback, enableInteraction };
}
