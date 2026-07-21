import { uProgress } from '../render/dissolve.js';

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
export function createPhaseMachine({ scene, camera, cameraControls, tableState, stageObjects, dissolveController, getTime, onObjectDissolveStart }) {
    const { controls, zoomState, applyControlMode } = cameraControls;
    const ROOM_RETURN_DIST = 5.5; // kept in sync with simulation/cameraControls.js

    let phase         = 'room';
    let targetP       = 0;   // raw scroll destination; uProgress.value lerps toward this
    let phaseStart    = 0;   // clock time when current phase began
    let scrollBlocked = false;
    // True from when a dissolve finishes until the objects have fully
    // re-materialized back in the room. While set, the objects' dissolve amount
    // tracks the scroll (p) so returning to the room reverses the dissolve.
    let objectsDissolved = false;
    // One-shot guard so the table's dissolve whoosh fires once per dissolve.
    let tableDissolveSoundFired = false;
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
        phase         = 'dissolving';
        phaseStart    = getTime();
        scrollBlocked = true;
        tableDissolveSoundFired = false; // re-arm the table whoosh for this run
        dissolveController.disable();
        return true; // caller uses this to fire the one-shot dissolve sound
    }

    // Advances uProgress toward targetP and runs the phase transitions. Called
    // once per frame; returns the values other simulation/render modules need.
    function update(t) {
        // Lerp uProgress.value toward targetP — absorbs trackpad deltaY spikes.
        // Snap when within 0.001 so it actually reaches 0 and 1 exactly.
        uProgress.value += (targetP - uProgress.value) * 0.05;
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
            phaseStart    = t;
            scrollBlocked = false;
            dissolveController.enable(); // button becomes clickable when fully in space
        }

        if (phase === 'dissolving') {
            const elapsed = t - phaseStart;
            // Objects dissolve sequentially: vase 0s, tulip 1.5s, stone 3s,
            // dummy 5s, teddy 10s (each over 3s).
            for (const obj of stageObjects) {
                const objElapsed = elapsed - obj.dissolveStart;
                // Fire the one-shot dissolve sound the moment THIS object begins
                // dissolving, so each object gets its own whoosh in sequence
                // rather than a single sound at button-press.
                if (objElapsed >= 0 && !obj.dissolveSoundFired) {
                    obj.dissolveSoundFired = true;
                    onObjectDissolveStart?.();
                }
                obj.uProgress.value = Math.min(1.0, Math.max(0.0, objElapsed / 3.0));
                if (obj.uProgress.value >= 1.0 && !obj.shadowsKilled) {
                    obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = false; });
                    obj.shadowsKilled = true;
                }
            }
            // Table dissolves last: starts at 15s, ends at 18s. Give it a
            // whoosh too, the moment it starts — same one-shot the objects use.
            if (elapsed >= 15.0 && !tableDissolveSoundFired) {
                tableDissolveSoundFired = true;
                onObjectDissolveStart?.();
            }
            tableState.uProgress.value = Math.min(1.0, Math.max(0.0, (elapsed - 15.0) / 3.0));
            if (tableState.uProgress.value >= 1.0 && tableState.object && !tableState.object.userData.shadowsKilled) {
                tableState.object.traverse(c => { if (c.isMesh) c.castShadow = false; });
                tableState.object.userData.shadowsKilled = true;
            }
            if (elapsed >= 18.0) {
                phase         = 'done';
                scrollBlocked = false;
                // Keep the objects (now fully dissolved / invisible at uProgress=1)
                // so they can reverse-dissolve back on the way home. objectsDissolved
                // hands control of their uProgress to the reverse block below.
                objectsDissolved = true;
            }
        }

        // Reverse dissolve: while the objects are in their dissolved-away state,
        // tie every object's (and the table's) uProgress to the scroll p. In
        // 'done' p is still 1 so they stay invisible; as the viewer scrolls back
        // toward the room p falls to 0 and they re-materialize — the dissolve
        // effect played backwards — while floating back down onto the table.
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
                    obj.dissolveSoundFired = false;
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

    return { update, triggerDissolve, enableInteraction };
}
