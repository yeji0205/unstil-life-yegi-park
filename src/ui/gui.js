import GUI from 'lil-gui';
import { flowState } from '../render/skyboxFlow.js';

// Builds the lil-gui debug panel. Hidden during the loading screen; call
// `show()` once it's gone. `onDissolveClick` is invoked when the user presses
// the dissolve button — the simulation phase machine owns the actual gating
// logic (only fires once in the 'space' phase) and enables/disables the
// button returned here as `dissolveController`.
export function createDebugGUI({
    uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor,
    onRevealPainting,
    ambientLight, directionalLight,
    skyboxOptions, defaultSkybox, skyboxCustomLabel, onSkyboxChange, onCustomSkyboxFiles,
    tableOptions, defaultTable, tableCustomLabel, onTableChange, onCustomTableFile, onTableTextureFile,
    stoneOptions, defaultStone, stoneCustomLabel, onStoneChange, onCustomStoneFile,
    roomSoundOptions, defaultRoomSound, spaceSoundOptions, defaultSpaceSound,
    dissolveSoundOptions, defaultDissolveSound, soundCustomLabel,
    onRoomSoundChange, onCustomRoomSoundFile, roomSoundVolume,
    onSpaceSoundChange, onCustomSpaceSoundFile, spaceSoundVolume,
    onDissolveSoundChange, onCustomDissolveSoundFile, dissolveSoundVolume,
    onDissolveClick,
}) {
    const gui = new GUI({ title: 'Unstil Life Debug' });
    gui.hide(); // hidden during loading screen; shown once the loading dissolve completes

    // Reveal button — the intro painting stays on screen until this is clicked,
    // then it dissolves into the live scene. Lets the viewer control the timing.
    // Disables itself after one use (there's nothing left to dissolve).
    const revealActions = {
        reveal: () => {
            if (onRevealPainting?.()) revealController.disable();
        },
    };
    const revealController = gui.add(revealActions, 'reveal').name('▶ Reveal Scene (dissolve painting)');

    gui.add(uProgress,      'value', 0, 1, 0.01).name('Progress (p)').listen();
    gui.add(uDissolveEdge,  'value', 0, 0.8, 0.01).name('Dissolve Edge');
    gui.add(uNoiseFreq,     'value', 0.1, 1.5, 0.01).name('Noise Frequency');
    gui.add(uDissolveEdgeColor.value, 'r', 0, 1, 0.01).name('Edge R');
    gui.add(uDissolveEdgeColor.value, 'g', 0, 1, 0.01).name('Edge G');
    gui.add(uDissolveEdgeColor.value, 'b', 0, 1, 0.01).name('Edge B');

    // Dissolve particle color — live picker so neon shades can be auditioned.
    // Proxy holds a hex string (what lil-gui's color widget edits); onChange
    // writes it into the shared THREE.Color uniform every particle reads.
    const particleColorProxy = { color: '#' + uParticleColor.value.getHexString() };
    gui.addColor(particleColorProxy, 'color').name('Particle Color')
        .onChange((hex) => uParticleColor.value.set(hex));

    const lightFolder = gui.addFolder('Lighting');
    lightFolder.add(ambientLight, 'intensity', 0, 3, 0.05).name('Ambient');
    lightFolder.add(directionalLight, 'intensity', 0, 10, 0.1).name('Directional');
    lightFolder.close();

    // Skybox picker — swaps the cubemap live. Add new folder names to
    // skyboxOptions (geometry/environment.js) to list them here.
    // "Custom images…" is different from every other preset: a single flat
    // image can't be a skybox (the background is a box with 6 separately
    // textured faces). Rather than make the user pick 6 files by hand, this is
    // a FOLDER picker (webkitdirectory): they choose the folder that holds the
    // 6 face images and every file inside is read automatically, then matched
    // to the faces by filename (see environment.js matchFaceFiles).
    const skyboxFileInput = document.createElement('input');
    skyboxFileInput.type = 'file';
    skyboxFileInput.webkitdirectory = true; // pick a folder, get all files inside
    skyboxFileInput.style.display = 'none';
    document.body.appendChild(skyboxFileInput);

    const skyboxSettings = { cubemap: defaultSkybox };
    let lastSkybox = defaultSkybox;
    const skyboxCtrl = gui.add(skyboxSettings, 'cubemap', skyboxOptions)
        .name('Skybox')
        .onChange((folderName) => {
            if (folderName === skyboxCustomLabel) {
                // Snap the dropdown back to the last real preset immediately.
                // lil-gui only fires onChange when the value CHANGES, so if the
                // control stayed stuck on "Custom images…" (after a pick, or a
                // cancelled dialog) selecting it again would do nothing — the
                // "can't add a custom skybox a second time" trap. Resetting the
                // display means picking it always re-fires and re-opens the picker.
                skyboxSettings.cubemap = lastSkybox;
                skyboxCtrl.updateDisplay();
                alert(
                    'A custom background needs a cube map (skybox): 6 images, one for ' +
                    'each side of a box around the scene — not a single picture.\n\n' +
                    'In the next dialog pick the FOLDER that contains the 6 images. Each ' +
                    'file must be named for its face — right, left, top, bot, front, back ' +
                    '(also accepted: east/west/up/down/north/south, posx/negx…, px/nx…), ' +
                    'e.g. "myscene_right.png".'
                );
                skyboxFileInput.click();
                return;
            }
            lastSkybox = folderName;
            onSkyboxChange(folderName);
        });

    skyboxFileInput.addEventListener('change', () => {
        const files = skyboxFileInput.files;
        if (!files || files.length === 0) return;
        const ok = onCustomSkyboxFiles(files);
        if (!ok) {
            alert(
                'Could not find all 6 cube faces in that folder. It needs one image per ' +
                'face, each filename containing one of: right, left, top, bot, front, back.'
            );
        }
        skyboxFileInput.value = '';
    });

    // Table picker — swaps the table geometry live. "Custom GLB…" opens a
    // hidden file input instead of switching immediately; the actual swap
    // happens once the user picks a .glb file (or never, if they cancel —
    // the dropdown is left showing "Custom GLB…" but nothing changes).
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.glb,.gltf';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    const tableSettings = { table: defaultTable };
    gui.add(tableSettings, 'table', tableOptions)
        .name('Table')
        .onChange((label) => {
            if (label === tableCustomLabel) {
                fileInput.click();
                return;
            }
            onTableChange(label);
        });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        onCustomTableFile(file);
        fileInput.value = ''; // reset so picking the same file again still fires 'change'
    });

    // Table material — attach image textures to the Box/Cylinder tables so they
    // get real material character. Several maps can be mixed (albedo + normal +
    // roughness + bump); each picker opens an image dialog and the maps persist
    // across Box↔Cylinder swaps (glbLoader keeps them).
    const tableMatFolder = gui.addFolder('Table Material (Box/Cyl)');
    const addTexturePicker = (name, type) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'image/*';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        const action = { pick: () => inp.click() };
        tableMatFolder.add(action, 'pick').name(name);
        inp.addEventListener('change', () => {
            const file = inp.files[0];
            if (!file) return;
            onTableTextureFile(file, type);
            inp.value = '';
        });
    };
    addTexturePicker('Color / Albedo…', 'map');
    addTexturePicker('Normal…',         'normalMap');
    addTexturePicker('Roughness…',      'roughnessMap');
    addTexturePicker('Bump…',           'bumpMap');
    tableMatFolder.close();

    // Stone picker — same pattern as Table: preset options swap the asset
    // live, "Custom GLB…" opens a hidden file input.
    const stoneFileInput = document.createElement('input');
    stoneFileInput.type = 'file';
    stoneFileInput.accept = '.glb,.gltf';
    stoneFileInput.style.display = 'none';
    document.body.appendChild(stoneFileInput);

    const stoneSettings = { stone: defaultStone };
    gui.add(stoneSettings, 'stone', stoneOptions)
        .name('Stone')
        .onChange((label) => {
            if (label === stoneCustomLabel) {
                stoneFileInput.click();
                return;
            }
            onStoneChange(label);
        });

    stoneFileInput.addEventListener('change', () => {
        const file = stoneFileInput.files[0];
        if (!file) return;
        onCustomStoneFile(file);
        stoneFileInput.value = '';
    });

    // Sound picker + volume — same pattern as the Table picker: preset
    // options switch immediately, "Custom audio…" opens a hidden file input
    // and only takes effect once a file is actually chosen. Any format the
    // browser can decode works (mp3/wav/ogg/m4a). Used for both the room
    // track (café, fades out into space) and the space track (fades in).
    function addSoundPicker(name, options, defaultLabel, onChange, onCustomFile, volume) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/*';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        const settings = { sound: defaultLabel };
        gui.add(settings, 'sound', options)
            .name(name)
            .onChange((label) => {
                if (label === soundCustomLabel) {
                    fileInput.click();
                    return;
                }
                onChange(label);
            });
        gui.add(volume, 'value', 0, 1, 0.01).name(name + ' Volume');

        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            onCustomFile(file);
            fileInput.value = '';
        });
    }

    addSoundPicker('Room Sound', roomSoundOptions, defaultRoomSound, onRoomSoundChange, onCustomRoomSoundFile, roomSoundVolume);
    addSoundPicker('Space Sound', spaceSoundOptions, defaultSpaceSound, onSpaceSoundChange, onCustomSpaceSoundFile, spaceSoundVolume);
    // Dissolve Sound is a one-shot (played once when the Dissolve button fires),
    // but its picker is identical: preset / None / custom upload + volume.
    addSoundPicker('Dissolve Sound', dissolveSoundOptions, defaultDissolveSound, onDissolveSoundChange, onCustomDissolveSoundFile, dissolveSoundVolume);

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
