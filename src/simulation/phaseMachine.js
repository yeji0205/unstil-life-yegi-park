import { uProgress } from '../render/dissolve.js';

// 'room'       — room visible, scroll controls uProgress
// 'space'      — room gone, zoom active, waiting for the dissolve button
// 'dissolving' — objects dissolving automatically, scroll blocked
// 'done'       — all objects gone, scroll re-enabled to restore room
//
// uProgress < 1              → scroll dissolves / restores room
// uProgress = 1, not yet zoomed out OR still far → OrbitControls zooms
// uProgress = 1, zoomed out AND back to start    → scroll restores room
export function createPhaseMachine({ scene, camera, cameraControls, tableState, stageObjects, dissolveController, getTime }) {
    const { controls, zoomState, applyControlMode } = cameraControls;
    const ROOM_RETURN_DIST = 5.5; // kept in sync with simulation/cameraControls.js

    let phase         = 'room';
    let targetP       = 0;   // raw scroll destination; uProgress.value lerps toward this
    let phaseStart    = 0;   // clock time when current phase began
    let scrollBlocked = false;

    function resetToRoom() {
        zoomState.hasZoomedOut = false;
        phase = 'room';
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
        dissolveController.disable();
    }

    window.addEventListener('wheel', (e) => {
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
        if (phase !== 'space') return;
        phase         = 'dissolving';
        phaseStart    = getTime();
        scrollBlocked = true;
        dissolveController.disable();
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
            // Objects dissolve sequentially: tulip 0s, dummy 5s, teddy 10s (each over 3s)
            for (const obj of stageObjects) {
                const objElapsed = elapsed - obj.dissolveStart;
                obj.uProgress.value = Math.min(1.0, Math.max(0.0, objElapsed / 3.0));
                if (obj.uProgress.value >= 1.0 && !obj.shadowsKilled) {
                    obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = false; });
                    obj.shadowsKilled = true;
                }
            }
            // Table dissolves last: starts at 15s, ends at 18s
            tableState.uProgress.value = Math.min(1.0, Math.max(0.0, (elapsed - 15.0) / 3.0));
            if (tableState.uProgress.value >= 1.0 && tableState.object && !tableState.object.userData.shadowsKilled) {
                tableState.object.traverse(c => { if (c.isMesh) c.castShadow = false; });
                tableState.object.userData.shadowsKilled = true;
            }
            if (elapsed >= 18.0) {
                phase         = 'done';
                scrollBlocked = false;
                // Permanently remove the stage objects — only the table returns on room restore
                for (const obj of stageObjects) {
                    scene.remove(obj.mesh);
                    if (obj.guiFolder) obj.guiFolder.hide();
                }
                stageObjects.length = 0; // clear array so downstream loops skip them
            }
        }

        return { p, rawP, phase };
    }

    return { update, triggerDissolve };
}
