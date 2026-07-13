import GUI from 'lil-gui';
import { flowState } from '../render/skyboxFlow.js';

// Builds the lil-gui debug panel. Hidden during the loading screen; call
// `show()` once it's gone. `onDissolveClick` is invoked when the user presses
// the dissolve button — the simulation phase machine owns the actual gating
// logic (only fires once in the 'space' phase) and enables/disables the
// button returned here as `dissolveController`.
export function createDebugGUI({
    uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor,
    ambientLight, directionalLight,
    skyboxOptions, defaultSkybox, onSkyboxChange,
    onDissolveClick,
}) {
    const gui = new GUI({ title: 'Unstil Life Debug' });
    gui.hide(); // hidden during loading screen; shown once the loading dissolve completes

    gui.add(uProgress,      'value', 0, 1, 0.01).name('Progress (p)').listen();
    gui.add(uDissolveEdge,  'value', 0, 0.8, 0.01).name('Dissolve Edge');
    gui.add(uNoiseFreq,     'value', 0.1, 1.5, 0.01).name('Noise Frequency');
    gui.add(uDissolveEdgeColor.value, 'r', 0, 1, 0.01).name('Edge R');
    gui.add(uDissolveEdgeColor.value, 'g', 0, 1, 0.01).name('Edge G');
    gui.add(uDissolveEdgeColor.value, 'b', 0, 1, 0.01).name('Edge B');

    const lightFolder = gui.addFolder('Lighting');
    lightFolder.add(ambientLight, 'intensity', 0, 3, 0.05).name('Ambient');
    lightFolder.add(directionalLight, 'intensity', 0, 10, 0.1).name('Directional');
    lightFolder.close();

    // Skybox picker — swaps the cubemap live. Add new folder names to
    // skyboxOptions (geometry/environment.js) to list them here.
    const skyboxSettings = { cubemap: defaultSkybox };
    gui.add(skyboxSettings, 'cubemap', skyboxOptions)
        .name('Skybox')
        .onChange((folderName) => onSkyboxChange(folderName));

    // Toggles the swirling curl-noise UV warp on the skybox texture (see
    // render/skyboxFlow.js). Label flips to reflect state, same pattern as
    // the dissolve button below.
    const bgMotionAction = {
        toggle: () => {
            flowState.enabled = !flowState.enabled;
            bgMotionController.name(flowState.enabled ? '⏸ Stop Background Motion' : '🌀 Animate Background');
        },
    };
    const bgMotionController = gui.add(bgMotionAction, 'toggle').name('🌀 Animate Background');

    // Camera position display — read-only, updated every frame via updateCameraDebug.
    // Only meaningful when inside the room (p < 0.95); numbers freeze in space mode.
    const cameraDebug = { x: 0, y: 0, z: 0 };
    const cameraFolder = gui.addFolder('Camera position (room)');
    cameraFolder.add(cameraDebug, 'x').name('Cam X').listen().disable();
    cameraFolder.add(cameraDebug, 'y').name('Cam Y').listen().disable();
    cameraFolder.add(cameraDebug, 'z').name('Cam Z').listen().disable();

    // Button lives in the GUI panel. Disabled until phase === 'space'.
    const dissolveActions = { dissolve: () => onDissolveClick() };
    const dissolveController = gui.add(dissolveActions, 'dissolve').name('▶ Dissolve Objects');
    dissolveController.disable(); // enabled by the phase machine when room is fully gone

    // Camera position display — capped to 2 decimal places for readability.
    function updateCameraDebug(position) {
        cameraDebug.x = +position.x.toFixed(2);
        cameraDebug.y = +position.y.toFixed(2);
        cameraDebug.z = +position.z.toFixed(2);
    }

    // Per-object debug folder, added once a stage object's GLB finishes loading.
    function addObjectFolder(label, entry, scaleFactor) {
        const folder = gui.addFolder(label);
        const scaleProxy = { scale: scaleFactor };
        folder.add(scaleProxy, 'scale', 0.05, 5.0, 0.01).name('Scale')
            .onChange(v => entry.mesh.scale.setScalar(v));
        const resetRepel = () => { entry.repelX = entry.repelY = entry.repelZ = 0; };
        folder.add(entry, 'restX', -3, 3, 0.01).name('Pos X').listen().onChange(resetRepel);
        folder.add(entry, 'restY', -5, 8, 0.01).name('Pos Y').listen().onChange(resetRepel);
        folder.add(entry, 'restZ', -3, 3, 0.01).name('Pos Z').listen().onChange(resetRepel);
        folder.add(entry, 'rotYOffset', -Math.PI, Math.PI, 0.01).name('Rot Y offset');
        folder.close();
        entry.guiFolder = folder; // saved so we can hide it after permanent dissolve
    }

    return { gui, dissolveController, updateCameraDebug, addObjectFolder };
}
