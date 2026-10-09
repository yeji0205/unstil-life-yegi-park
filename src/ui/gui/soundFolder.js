import { ROOM_SOUND_OPTIONS, SPACE_SOUND_OPTIONS, DISSOLVE_SOUND_OPTIONS } from '../../audio/ambientSound.js';
import { createFilePicker } from './controls.js';

// ─── "Sound" folder ──────────────────────────────────────────────────────────
// Sound pickers and volumes for the room, space and dissolve sounds. Presets
// switch immediately; "Custom audio…" opens a file picker (mp3/wav/ogg/m4a).
const SOUND_CUSTOM_LABEL = 'Custom audio…';

// soundTracks: the tracks from createAmbientSoundTracks() (room, space, dissolve).
export function addSoundFolder(gui, soundTracks) {
    const folder = gui.addFolder('Sound');
    addSoundPicker(folder, 'Room Sound', ROOM_SOUND_OPTIONS, soundTracks.room);
    addSoundPicker(folder, 'Space Sound', SPACE_SOUND_OPTIONS, soundTracks.space);
    // Dissolve Sound follows the dissolve (see audio/ambientSound.js), but its
    // picker is identical: preset / None / custom upload + volume.
    addSoundPicker(folder, 'Dissolve Sound', DISSOLVE_SOUND_OPTIONS, soundTracks.dissolve);
}

// One sound: a dropdown (presets, None, custom upload) and a volume slider.
function addSoundPicker(folder, name, options, track) {
    const openPicker = createFilePicker({ accept: 'audio/*', onPick: (file) => track.setCustomFile(file) });
    const settings = { sound: options[0] };
    folder.add(settings, 'sound', [...options, SOUND_CUSTOM_LABEL])
        .name(name)
        .onChange((label) => {
            if (label === SOUND_CUSTOM_LABEL) openPicker();
            else track.setSound(label);
        });
    folder.add(track.volume, 'value', 0, 1, 0.01).name(name + ' Volume');
}
