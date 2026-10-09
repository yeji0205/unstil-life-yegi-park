// ─── "Objects" and "Camera position" folders ─────────────────────────────────
// Per-object placement folders are added at runtime as each GLB finishes
// loading. The parent is created up front so they land inside one folder
// instead of loose at the bottom, and the camera readout stays last no matter
// when the models arrive.
export function addObjectsAndCameraFolders(gui) {
    const objectsFolder = gui.addFolder('Objects');
    objectsFolder.close();

    // Camera position display — read-only, updated every frame via
    // updateCameraDebug. Last in the panel: there's nothing to change here, it's
    // only ever read while dialling in a shot.
    const cameraDebug = { x: 0, y: 0, z: 0 };
    const cameraFolder = gui.addFolder('Camera position');
    cameraFolder.add(cameraDebug, 'x').name('Cam X').listen().disable();
    cameraFolder.add(cameraDebug, 'y').name('Cam Y').listen().disable();
    cameraFolder.add(cameraDebug, 'z').name('Cam Z').listen().disable();

    // Capped to 2 decimal places for readability.
    function updateCameraDebug(position) {
        cameraDebug.x = +position.x.toFixed(2);
        cameraDebug.y = +position.y.toFixed(2);
        cameraDebug.z = +position.z.toFixed(2);
    }

    // One folder per object: added when it finishes loading, removed when it's
    // swapped for another model.
    const objectFolders = new Map(); // object entry → its folder
    function addObjectFolder(label, entry, scaleFactor) {
        // Closed like the rest. These are created after the panel's closeAll pass
        // has run (see gui.js), so they have to close themselves.
        const folder = objectsFolder.addFolder(label).close();
        const scaleProxy = { scale: scaleFactor };
        folder.add(scaleProxy, 'scale', 0.05, 5.0, 0.01).name('Scale')
            .onChange(v => entry.mesh.scale.setScalar(v));
        const resetRepel = () => { entry.repelX = entry.repelY = entry.repelZ = 0; };
        folder.add(entry, 'restX', -3, 3, 0.01).name('Pos X').listen().onChange(resetRepel);
        folder.add(entry, 'restY', -5, 8, 0.01).name('Pos Y').listen().onChange(resetRepel);
        folder.add(entry, 'restZ', -3, 3, 0.01).name('Pos Z').listen().onChange(resetRepel);
        folder.add(entry, 'rotYOffset', -Math.PI, Math.PI, 0.01).name('Rot Y offset');
        objectFolders.set(entry, folder);
    }
    function removeObjectFolder(entry) {
        objectFolders.get(entry)?.destroy();
        objectFolders.delete(entry);
    }

    return { updateCameraDebug, addObjectFolder, removeObjectFolder };
}
