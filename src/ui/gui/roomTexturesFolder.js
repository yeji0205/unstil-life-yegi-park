import { ROOM_SURFACES, ROOM_TEXTURE_SLOTS } from '../../scene/room.js';
import { addFileButton } from './controls.js';

// ─── "Room Textures" folder ──────────────────────────────────────────────────
// One folder per surface, one file picker per map type. Uploads tile at the same
// world scale as the built-in textures, whatever their resolution.
export function addRoomTexturesFolder(gui, { onRoomTextureFile, onRoomTextureReset }) {
    const folder = gui.addFolder('Room Textures');
    folder.close();
    for (const surface of ROOM_SURFACES) {
        const sub = folder.addFolder(surface === 'wall' ? 'Walls + Ceiling' : 'Floor');
        sub.close();
        for (const slotLabel of Object.keys(ROOM_TEXTURE_SLOTS)) {
            addFileButton(sub, `${slotLabel}…`, {
                accept: 'image/*',
                onPick: (file) => onRoomTextureFile(surface, slotLabel, file),
            });
        }
        // Puts back the textures the scene ships with, so an experiment is never
        // one-way — otherwise the only route back is a page reload.
        sub.add({ reset: () => onRoomTextureReset(surface) }, 'reset')
            .name('↺ Reset to original');
    }
}
