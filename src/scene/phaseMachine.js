import { ROOM_RETURN_DIST } from '../setup/cameraControls.js';
import { createDissolveTimeline } from './dissolveTimeline.js';

// The central value of the artwork: 0 = room, 1 = space. Set only here (from the
// scroll); the room's dissolve, lighting, floating, camera and sound all follow
// it. A uniform object ({ value }), so shaders can read it directly.
export const uProgress = { value: 0.0 };

// How far the smoothed progress trails the scroll, as a time constant in seconds
// (GUI slider). Higher = objects keep coasting and read as floating; lower =
// they follow the wheel tightly and look dragged. Per second, not per frame, so
// it feels the same at any framerate.
export const scrollSmoothing = { tau: 0.28 };

const MAX_DT = 0.1; // ignore huge frame gaps (tab backgrounded, GPU stall)
// Slower smoothing on the way home from space, so the return is gradual.
const RETURN_TAU = 0.75;

// Moves `current` toward `target` with time constant `tau` (seconds), the same at
// any framerate; snaps when within 0.001, so it reaches 0 and 1 exactly.
function easeToward(current, target, dt, tau) {
    const next = current + (target - current) * (1 - Math.exp(-dt / tau));
    return Math.abs(target - next) < 0.001 ? target : next;
}

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
// The object dissolve itself (timer, pause, scrub, re-forming on the way home)
// runs in dissolveTimeline.js; this file decides when.
//
// onPhaseChange(phase) reports every phase change (main.js uses it to enable the
// GUI's Dissolve button only in 'space').
export function createPhaseMachine({
    camera, cameraControls, tableState, stillLifeObjects, onPhaseChange, onObjectsDissolved,
}) {
    const { controls, zoomState, applyControlMode } = cameraControls;
    const dissolve = createDissolveTimeline(tableState, stillLifeObjects);

    let phase         = 'room';
    let targetP       = 0;   // raw scroll destination; uProgress.value eases toward this
    let lastUpdateT   = null; // for the frame-rate-independent smoothing
    let scrollBlocked = false;
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
        if (!dissolve.isDissolved()) dissolve.reset();
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
        scrollTo(targetP - e.deltaY * 0.001);
    });

    // Moves the scroll target, as the wheel does.
    function scrollTo(next) {
        targetP = Math.min(1.0, Math.max(0.0, next));
        if (targetP < 0.95) resetToRoom();
        applyControlMode(uProgress.value);
    }

    // "Scrolling" without the wheel, for the journey (journey.js). Same rules as
    // the wheel, except that no zoom is needed to go home from space. Returns
    // whether it applied.
    function setScrollTarget(value) {
        if (!interactionEnabled || scrollBlocked) return false;
        scrollTo(value);
        return true;
    }

    // The GUI's Dissolve button. Only works in 'space'; the button is disabled
    // otherwise, but a stray click mid-transition is ignored here too.
    function triggerDissolve() {
        if (phase !== 'space') return false;
        dissolve.start();
        scrollBlocked = true;
        setPhase('dissolving');
        return true;
    }

    // Eases uProgress toward the scroll target and returns it. Smooths out
    // trackpad spikes and gives the floaty motion. The trip home (p > 0.3,
    // falling) uses the slower RETURN_TAU, so room, camera, lights and objects
    // arrive together.
    function easeProgress(dt) {
        const returning = targetP < uProgress.value && uProgress.value > 0.3;
        uProgress.value = easeToward(uProgress.value, targetP, dt, returning ? RETURN_TAU : scrollSmoothing.tau);
        return uProgress.value;
    }

    // Called once per frame: eases uProgress toward the scroll target and runs
    // the phase transitions.
    function update(t) {
        const dt = lastUpdateT === null ? 1 / 60 : Math.min(t - lastUpdateT, MAX_DT);
        lastUpdateT = t;
        const p = easeProgress(dt); // drives all visuals and shaders

        // Every frame, not only on wheel events: p keeps easing after the wheel stops.
        applyControlMode(p);

        // The stage changes use the scroll target, not the eased p.
        if (phase === 'room' && targetP >= 1.0) {
            scrollBlocked = false;
            setPhase('space'); // the Dissolve button becomes clickable
        }
        if (phase === 'dissolving' && dissolve.advance(dt)) {
            setPhase('done');
            scrollBlocked = false;
            // Everything is invisible now: the safe moment to swap in the
            // objects that come back, so the still life isn't the same one.
            onObjectsDissolved?.();
        }
        if (dissolve.isDissolved() && phase !== 'dissolving') dissolve.followScroll(p);

        return { p, phase };
    }

    return {
        update,
        triggerDissolve,
        setScrollTarget,
        getScrollTarget: () => targetP,
        // The scrub bar, Pause button and dissolve sound talk to the timeline.
        setDissolvePaused: (value) => dissolve.setPaused(value),
        seekDissolve: (fraction) => dissolve.seek(fraction),
        getDissolveFraction: () => dissolve.fraction(),
        getDissolvePlayback: () => dissolve.playback(),
        // Called by main.js once the loading screen is gone.
        enableInteraction: () => { interactionEnabled = true; },
    };
}
