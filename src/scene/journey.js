import * as THREE from 'three';
import { dissolveDuration } from './dissolveTimeline.js';

// ─── The journey: the artwork playing by itself ──────────────────────────────
// Press P (or the GUI button): the room, the way into space, a look around, the
// dissolve, a moment of emptiness, and the way home. It drives the same controls
// a viewer would (the scroll target and the Dissolve button), so everything else
// reacts exactly as it does to scrolling. Any scroll or camera drag stops it and
// hands control back to the viewer. Pressed in space, mid-dissolve or after it,
// it carries on from there instead of starting over.

const ROOM_WAIT      = 4; // seconds looking at the still life
const TO_SPACE       = 6; // "scrolling" up into space
const LOOK_AROUND    = 8; // in space, before the dissolve
const AFTER_DISSOLVE = 8; // the emptiness after the objects are gone
const TO_ROOM        = 6; // "scrolling" back home

// The journey always starts and ends at the same view: the camera's view when
// the page opened. If the viewer has looked around, the first seconds of the
// room wait glide the camera back to it.
const START_GLIDE = 2;

// In space the camera makes one slow swing around the scene: out to this angle,
// and back to the start view by the time the room is back. It slows down to the
// turning point exactly as the dissolve ends, when the objects that come back are
// swapped in, rests there only for the first few frames after the swap (when the
// new models are first drawn, any hitch is invisible while nothing moves), then
// swings back. At the turning point it's at rest anyway, so there's no jerk.
const SWING_ANGLE = THREE.MathUtils.degToRad(-55);
const SWING_HOLD_FRAMES = 3;

// The difference between two angles, the short way round (-π..π).
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const smoothstep = (x) => x * x * (3 - 2 * x);

// The camera's direction around its target: theta = left/right, phi = up/down.
function cameraAngles(controls) {
    const offset = new THREE.Vector3().subVectors(controls.object.position, controls.target);
    const { theta, phi } = new THREE.Spherical().setFromVector3(offset);
    return { theta, phi };
}

// Turns the camera around its target to these angles (radians), keeping its
// distance, as if the viewer had dragged it. phi = null keeps the current tilt.
function setCameraAngles(controls, theta, phi = null) {
    const offset = new THREE.Vector3().subVectors(controls.object.position, controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta = theta;
    if (phi !== null) spherical.phi = phi;
    controls.object.position.copy(controls.target).add(offset.setFromSpherical(spherical));
}

// Each step lasts `seconds`, or until `until({ phase, p })` is true. `scroll: [a, b]`
// moves the scroll target from a to b over the step (the phase machine's own
// smoothing softens the start and end); `swing: [a, b]` moves the camera along
// the swing from a to b (0 = start, 1 = back home); `toStartView` glides the
// camera to the start view (over `glideSeconds`, or the whole step) and
// `holdStartView` keeps it there; `start` runs when the step begins;
// `holdFrames` keeps the step at its start for that many frames.
//
// The swing follows the journey's progress, not the clock: during the dissolve
// it follows the dissolve itself, so it stays in step even when the dissolve
// runs slower (a slow machine, or a longer Dissolve Duration). The first half
// (out to the turning point, 0.5) spans the look around and the dissolve; the
// second half (back, 0.5 → 1) the rest of the emptiness and the way home.
function journeySteps(phaseMachine) {
    const a = 0.5 * LOOK_AROUND / (LOOK_AROUND + dissolveDuration.value);
    const c = 0.5 + 0.5 * AFTER_DISSOLVE / (AFTER_DISSOLVE + TO_ROOM);
    return [
        { seconds: ROOM_WAIT, toStartView: true, glideSeconds: START_GLIDE },
        { seconds: TO_SPACE, scroll: [0, 1] },
        { seconds: LOOK_AROUND, swing: [0, a] },
        { start: () => phaseMachine.triggerDissolve(), until: ({ phase }) => phase === 'done',
          swing: [a, 0.5], progress: () => phaseMachine.getDissolveFraction() },
        { seconds: AFTER_DISSOLVE, swing: [0.5, c], holdFrames: SWING_HOLD_FRAMES },
        { seconds: TO_ROOM, scroll: [1, 0], swing: [c, 1] },
        // The way home eases slowly; the journey ends once the room is fully back.
        { until: ({ p }) => p <= 0.001, holdStartView: true },
    ];
}

// If P is pressed half-way between room and space: glide home first, then start.
function goHomeSteps(phaseMachine) {
    const from = phaseMachine.getScrollTarget();
    return [
        { seconds: Math.max(TO_ROOM * from, 1), scroll: [from, 0], toStartView: true },
        { until: ({ p }) => p <= 0.001, holdStartView: true },
    ];
}

// If P is pressed in space, mid-dissolve or after it, the journey carries on
// from the matching step (an index into journeySteps) instead of rewinding.
const JOIN_STEP = { space: 2, dissolving: 3, done: 4 };

// The steps to play when P is pressed, given where the scene is now.
function stepsFrom(phaseMachine, phase, atHome) {
    const steps = journeySteps(phaseMachine);
    if (atHome) return { steps, joined: false };
    if (phase in JOIN_STEP) return { steps: steps.slice(JOIN_STEP[phase]), joined: true };
    return { steps: [...goHomeSteps(phaseMachine), ...steps], joined: false };
}

// After joining mid-way, the camera is wherever the viewer left it. Every frame
// for START_GLIDE seconds, this pulls it from there onto the journey's path:
// the difference measured on the first frame shrinks to zero, so it neither
// jumps nor stops. Returns false once the blend is over.
function blendOntoPath(controls, blend, dt, startView) {
    const onPath = cameraAngles(controls); // where the journey put it this frame
    blend.offset ??= {
        theta: angleDelta(onPath.theta, blend.from.theta),
        phi:   blend.from.phi - startView.phi,
    };
    blend.time += dt;
    const remaining = 1 - smoothstep(Math.min(1, blend.time / START_GLIDE));
    setCameraAngles(controls,
        onPath.theta + blend.offset.theta * remaining,
        startView.phi + blend.offset.phi * remaining);
    return remaining > 0;
}

// Moves the camera for this frame, as the step says. progress: how far through
// the step (0..1); startView / glideFrom: camera angles (see createJourney).
function moveCamera(controls, step, { progress, stepTime, startView, glideFrom }) {
    if (step.swing) {
        const [from, to] = step.swing;
        const u = from + (to - from) * progress;
        // sin² starts and ends at rest and turns around smoothly in the middle.
        setCameraAngles(controls, startView.theta + SWING_ANGLE * Math.sin(Math.PI * u) ** 2);
    }
    if (step.toStartView) {
        const t = smoothstep(step.glideSeconds ? Math.min(1, stepTime / step.glideSeconds) : progress);
        setCameraAngles(controls,
            glideFrom.theta + angleDelta(glideFrom.theta, startView.theta) * t,
            glideFrom.phi + (startView.phi - glideFrom.phi) * t);
    }
    if (step.holdStartView) setCameraAngles(controls, startView.theta, startView.phi);
}

// onChange(playing) reports every start and stop (for the GUI button and the hint).
export function createJourney({ phaseMachine, controls, onChange }) {
    // The camera hasn't moved yet: this is the view every journey starts from.
    const startView = cameraAngles(controls);

    let steps = null; // the steps being played, or null when not playing
    let index = 0;
    let stepTime = 0;
    let stepFrames = 0;
    let holdEnd = 0;  // stepTime when the step's holdFrames were over
    let enabled = false; // only after the loading screen
    let lastP = 0;       // p and phase of the last frame, to know where the journey starts
    let lastPhase = 'room';
    let glideFrom = startView; // the camera's view when a toStartView step began
    let blend = null;    // easing the camera onto the path after joining mid-way

    function enterStep(i) {
        index = i;
        stepTime = 0;
        stepFrames = 0;
        holdEnd = 0;
        const step = steps[i];
        if (step.toStartView) glideFrom = cameraAngles(controls);
        step.start?.();
    }

    function start() {
        if (!enabled || steps) return;
        const atHome = lastP <= 0.001 && phaseMachine.getScrollTarget() === 0;
        const plan = stepsFrom(phaseMachine, lastPhase, atHome);
        steps = plan.steps;
        blend = plan.joined ? { from: cameraAngles(controls), offset: null, time: 0 } : null;
        enterStep(0);
        onChange?.(true);
    }

    function stop() {
        if (!steps) return;
        steps = null;
        onChange?.(false);
    }

    // The viewer takes over: scrolling, or grabbing the camera.
    window.addEventListener('wheel', stop);
    controls.addEventListener('start', stop);

    // How far through the current step we are, 0..1 (still 0 during holdFrames).
    function stepProgress(step) {
        if (step.progress) return step.progress();
        if (stepFrames <= (step.holdFrames ?? 0)) {
            holdEnd = stepTime;
            return 0;
        }
        return Math.min(1, (stepTime - holdEnd) / (step.seconds - holdEnd));
    }

    // Called every frame with the phase machine's phase and p.
    function update(dt, phase, p) {
        lastP = p;
        lastPhase = phase;
        if (!steps) return;
        stepTime += dt;
        stepFrames++;
        const step = steps[index];
        if (step.scroll) {
            const [from, to] = step.scroll;
            phaseMachine.setScrollTarget(from + (to - from) * stepProgress(step));
        }
        moveCamera(controls, step, { progress: stepProgress(step), stepTime, startView, glideFrom });
        if (blend && !blendOntoPath(controls, blend, dt, startView)) blend = null;
        const done = step.until ? step.until({ phase, p }) : stepTime >= step.seconds;
        if (!done) return;
        if (index + 1 < steps.length) enterStep(index + 1);
        else stop();
    }

    function toggle() {
        if (steps) stop();
        else start();
    }

    // P starts the journey, or stops it if it's playing. Typing in a GUI field
    // doesn't count.
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'p' && e.key !== 'P') return;
        if (e.target.closest?.('input, textarea, select')) return;
        toggle();
    });

    return {
        update,
        toggle,
        // Called by main.js once the loading screen is gone.
        enable: () => { enabled = true; },
    };
}
