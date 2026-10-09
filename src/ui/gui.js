import GUI from 'lil-gui';
import { addPlaybackButtons } from './gui/playbackButtons.js';
import { addSceneFolder } from './gui/sceneFolder.js';
import { addDissolveLookFolder } from './gui/dissolveLookFolder.js';
import { addSceneContentsFolder } from './gui/sceneContentsFolder.js';
import { addRoomTexturesFolder } from './gui/roomTexturesFolder.js';
import { addSoundFolder } from './gui/soundFolder.js';
import { addObjectsAndCameraFolders } from './gui/objectsFolder.js';

// Builds the lil-gui debug panel (hidden until the loading screen is gone; call
// show()). Each part of the panel is built in its own file in ui/gui/, in the
// order it appears (lil-gui shows things in creation order).
//
// The panel imports the settings it shows (sliders, colours, option lists)
// straight from their modules; `actions` holds what main.js wants done when a
// button or dropdown is used (load a table, swap a stone, start the dissolve…).
export function createDebugGUI(actions) {
    const gui = new GUI({ title: 'Unstil Life Debug' });
    gui.hide(); // hidden during loading screen; shown once the loading dissolve completes

    const playback = addPlaybackButtons(gui, actions);
    addSceneFolder(gui);
    addDissolveLookFolder(gui);
    const contents = addSceneContentsFolder(gui, actions);
    addRoomTexturesFolder(gui, actions);
    addSoundFolder(gui, actions.soundTracks);
    const objects = addObjectsAndCameraFolders(gui);

    // Close every folder (nested ones too), so the panel opens as a short list.
    // Done once here, so a new folder can't forget it.
    (function closeAll(g) {
        for (const folder of g.folders) { folder.close(); closeAll(folder); }
    })(gui);
    // ...except Scene Contents (skybox, table, stone), used most often.
    contents.folder.open();

    return { gui, ...playback, reportSkyboxImages: contents.reportSkyboxImages, ...objects };
}
