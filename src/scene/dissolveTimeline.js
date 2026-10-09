// ─── The object dissolve ─────────────────────────────────────────────────────
// After the Dissolve button, the table and all still-life objects dissolve
// together over dissolveDuration; it can be paused and scrubbed. Dissolved
// objects are kept, not deleted: on the way home they re-form by playing the
// dissolve backwards, following the scroll. The phase machine decides when each
// of this happens; this file runs it.

// Length of the object dissolve in seconds (GUI slider). Particle life and drift
// are measured against it, so a longer dissolve also means slower particles.
export const dissolveDuration = { value: 5.0 };

// The dissolve counts as finished this long after the objects are gone; the
// models that come back are swapped in then.
const DISSOLVE_FINISH_DELAY = 0.2;

// Sets the dissolve progress of the table and every still-life object at once
// (they always dissolve together).
function setAllDissolveProgress(tableState, stillLifeObjects, value) {
    tableState.uProgress.value = value;
    for (const obj of stillLifeObjects) obj.uProgress.value = value;
}

// Turns the shadows of the table and every object on or off. A model is only
// walked through when its state changes, so calling this every frame is cheap.
function setAllShadows(tableState, stillLifeObjects, on) {
    const models = [tableState.object, ...stillLifeObjects.map((obj) => obj.mesh)];
    for (const model of models) {
        if (!model || model.userData.shadowsOn === on) continue;
        model.traverse((child) => { if (child.isMesh) child.castShadow = on; });
        model.userData.shadowsOn = on;
    }
}

export function createDissolveTimeline(tableState, stillLifeObjects) {
    const setProgress = (value) => setAllDissolveProgress(tableState, stillLifeObjects, value);
    const setShadows  = (on) => setAllShadows(tableState, stillLifeObjects, on);

    let running = false;
    // Seconds into the dissolve. Accumulated from dt (not now - start), which is
    // what makes it pausable; a backgrounded tab resumes where it left off.
    let elapsed = 0;
    let paused  = false;
    // Counts scrub-bar jumps, so the dissolve sound knows when to jump too.
    let seekCount = 0;
    // True from the end of a dissolve until the objects have re-formed in the room.
    let dissolved = false;

    return {
        start() {
            elapsed = 0;
            running = true;
        },

        // Pause/resume. Only the dissolve stops; floating and particle drift keep running.
        setPaused(value) { paused = value; },

        // Scrub bar: jump to a fraction of the dissolve's length. Only while it runs.
        // Stops at the dissolve's end, before DISSOLVE_FINISH_DELAY, so dragging to the end
        // doesn't swap the models. Returns whether the seek applied.
        seek(fraction) {
            if (!running) return false;
            elapsed = Math.min(1, Math.max(0, fraction)) * dissolveDuration.value;
            seekCount++;
            return true;
        },

        // For the dissolve sound: whether it's playing, how many seconds in, and
        // the scrub-jump counter.
        playback() { return { playing: running && !paused, time: elapsed, seekCount }; },

        // What the scrub bar shows: the table's progress, which all objects share.
        fraction() { return tableState.uProgress.value; },

        isDissolved() { return dissolved; },

        // Every frame while running. Returns true on the frame it finishes.
        advance(dt) {
            if (!paused) elapsed += dt;
            const d = Math.min(1.0, Math.max(0.0, elapsed / dissolveDuration.value));
            setProgress(d);
            // Shadows off at full dissolve (a saving: nothing is left to cast), back
            // on if the scrub bar rewinds. Safe because the shadow dissolves with
            // the surface (customDepthMaterial).
            setShadows(d < 1.0);
            if (elapsed < dissolveDuration.value + DISSOLVE_FINISH_DELAY) return false;
            running   = false;
            dissolved = true; // kept invisible for the reverse dissolve on the way home
            return true;
        },

        // Reverse dissolve, every frame once dissolved: the objects re-form driven
        // by p, the same value as the room and camera, so everything arrives together.
        followScroll(p) {
            setProgress(p);
            // Shadows back on as soon as the objects start to re-form, not at the
            // end (that made every shadow appear at once). They grow back with the
            // object because the shadow dissolves with the surface.
            if (p < 0.999) setShadows(true);
            if (p <= 0.02) {
                // Fully home: back to normal, so a new dissolve can run.
                dissolved = false;
                setProgress(0);
            }
        },

        // Back to solid objects with shadows (scrolling back into the room).
        reset() {
            setProgress(0);
            setShadows(true);
        },
    };
}
