import GUI from 'lil-gui';
import { flowState } from '../render/skyboxFlow.js';
import { scrollSmoothing } from '../simulation/phaseMachine.js';
import { ROOM_SURFACES, ROOM_TEXTURE_SLOTS } from '../geometry/room.js';
import { primitiveTableColor, STONE_OPTIONS, STONE_CUSTOM_LABEL } from '../persistence/glbLoader.js';

// A small centered modal — readable padding/typography, a dimmed backdrop, and
// up to two buttons. Used instead of the browser's cramped alert() for the
// custom-background instructions (which need real structure: what's needed,
// how to name the files, and what size/order). Returns nothing; buttons close
// it and fire their callback.
function showModal({ title, bodyHTML, confirmLabel, onConfirm, cancelLabel = 'Cancel' }) {
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
        position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.55)',
        zIndex: '10000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
        background: '#f7f4ef', color: '#2a2622', width: 'min(90vw, 460px)',
        maxHeight: '85vh', overflowY: 'auto', borderRadius: '10px',
        padding: '26px 28px', boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        font: "15px/1.55 'Cormorant Garamond', Garamond, Georgia, serif",
    });
    box.innerHTML = `
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:600;letter-spacing:0.3px;">${title}</h2>
        <div style="font-size:15px;">${bodyHTML}</div>`;

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' });
    const mkBtn = (label, primary) => {
        const b = document.createElement('button');
        b.textContent = label;
        Object.assign(b.style, {
            padding: '9px 18px', borderRadius: '6px', cursor: 'pointer',
            border: primary ? 'none' : '1px solid #bdb4a6',
            background: primary ? '#3d2f22' : 'transparent',
            color: primary ? '#f7f4ef' : '#5a5145',
            font: "600 14px 'Cormorant Garamond', Garamond, serif", letterSpacing: '0.4px',
        });
        return b;
    };
    const close = () => backdrop.remove();
    if (cancelLabel) { const c = mkBtn(cancelLabel, false); c.onclick = close; row.appendChild(c); }
    if (confirmLabel) {
        const ok = mkBtn(confirmLabel, true);
        ok.onclick = () => { close(); onConfirm?.(); };
        row.appendChild(ok);
    }
    box.appendChild(row);
    backdrop.appendChild(box);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
}

// Builds the lil-gui debug panel. Hidden during the loading screen; call
// `show()` once it's gone. `onDissolveClick` is invoked when the user presses
// the dissolve button — the simulation phase machine owns the actual gating
// logic (only fires once in the 'space' phase) and enables/disables the
// button returned here as `dissolveController`.
export function createDebugGUI({
    uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor,
    onRevealPainting,
    skyboxOptions, defaultSkybox, skyboxCustomLabel, onSkyboxChange, onCustomSkyboxFiles,
    tableOptions, defaultTable, tableCustomLabel, onTableChange, onCustomTableFile, onTableTextureFile,
    onRoomTextureFile, onRoomTextureReset, onTableColorChange,
    onRenderScaleChange, onAdaptiveQualityToggle,
    onStoneChange, onCustomStoneFile,
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

    // Button lives in the GUI panel. Disabled until phase === 'space'.
    const dissolveActions = { dissolve: () => onDissolveClick() };
    const dissolveController = gui.add(dissolveActions, 'dissolve').name('▶ Dissolve Objects');
    dissolveController.disable(); // enabled by the phase machine when room is fully gone

    // Toggles the swirling curl-noise UV warp on the skybox texture (see
    // render/skyboxFlow.js). Label flips to reflect state, same pattern as
    // the dissolve button above.
    const bgMotionAction = {
        toggle: () => {
            flowState.enabled = !flowState.enabled;
            bgMotionController.name(flowState.enabled ? '⏸ Stop Background Motion' : '🌀 Animate Background');
        },
    };
    const bgMotionController = gui.add(bgMotionAction, 'toggle').name('🌀 Animate Background');

    // ─── Panel layout ────────────────────────────────────────────────────────
    // The three buttons above are the only things left loose at the top level:
    // they're the controls you press rather than adjust, so they're grouped
    // together and reachable without opening anything. Everything else lives in
    // a folder — previously some settings sat loose and some were in folders,
    // which made the panel read as a list with arbitrary dividers in it.
    //
    // lil-gui renders in creation order, so these four are declared here to fix
    // the sequence; their contents are attached further down, next to the code
    // that owns them. The remaining folders (Room Textures, Sound, Objects,
    // Camera position) are created later in the file and follow in that order,
    // ending with the read-only camera readout — nothing to change there, so it
    // belongs at the bottom.
    const sceneFolder    = gui.addFolder('Scene');
    const perfFolder     = gui.addFolder('Performance');
    const dissolveFolder = gui.addFolder('Dissolve Look');
    const contentFolder  = gui.addFolder('Scene Contents');

    sceneFolder.add(uProgress, 'value', 0, 1, 0.01).name('Progress (p)').listen();
    // Scroll feel: how much the scene trails the wheel. Higher = objects drift
    // and coast (floaty); lower = they track the wheel closely (snappy, but the
    // float/bob gets swamped and reads as dragging). See scrollSmoothing.
    sceneFolder.add(scrollSmoothing, 'tau', 0.08, 0.6, 0.01).name('Scroll Drift (float ⇢)');

    // Sharpness vs speed. The scene is fill-bound, so cost rises with the SQUARE
    // of this: 1.2 shades 44% more pixels than 1.0. Watch the fps readout while
    // dragging and stop where it stops being worth it.
    perfFolder.add({ q: 1.0 }, 'q', 0.55, 1.0, 0.05).name('Render Quality (max)')
        .onChange(onRenderScaleChange);
    // On by default: the piece lowers its own resolution on slow machines so it
    // stays smooth on hardware we can't test. Turn off to pin the quality above.
    perfFolder.add({ adaptive: true }, 'adaptive').name('Auto-adjust for fps')
        .onChange(onAdaptiveQualityToggle);

    dissolveFolder.add(uDissolveEdge, 'value', 0, 0.8, 0.01).name('Dissolve Edge');
    dissolveFolder.add(uNoiseFreq,    'value', 0.1, 1.5, 0.01).name('Noise Frequency');
    dissolveFolder.add(uDissolveEdgeColor.value, 'r', 0, 1, 0.01).name('Edge R');
    dissolveFolder.add(uDissolveEdgeColor.value, 'g', 0, 1, 0.01).name('Edge G');
    dissolveFolder.add(uDissolveEdgeColor.value, 'b', 0, 1, 0.01).name('Edge B');

    // Dissolve particle color — live picker so neon shades can be auditioned.
    // Proxy holds a hex string (what lil-gui's color widget edits); onChange
    // writes it into the shared THREE.Color uniform every particle reads.
    const particleColorProxy = { color: '#' + uParticleColor.value.getHexString() };
    dissolveFolder.addColor(particleColorProxy, 'color').name('Particle Color')
        .onChange((hex) => uParticleColor.value.set(hex));
    dissolveFolder.close();

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
    const skyboxCtrl = contentFolder.add(skyboxSettings, 'cubemap', skyboxOptions)
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
                showModal({
                    title: 'Custom background (cube map)',
                    bodyHTML: `
                        <p style="margin:0 0 12px;">The background is a <b>box around the whole
                        scene</b>, so it needs <b>6 images</b> — one per side — not a single
                        picture.</p>
                        <p style="margin:0 0 6px;"><b>Name each file for its face</b> (the
                        name just has to <i>contain</i> the word):</p>
                        <ul style="margin:0 0 12px;padding-left:20px;">
                          <li><code>right</code> &amp; <code>left</code> — the two sides</li>
                          <li><code>top</code> &amp; <code>bot</code> — up &amp; down</li>
                          <li><code>front</code> &amp; <code>back</code> — ahead &amp; behind</li>
                        </ul>
                        <p style="margin:0 0 12px;font-size:14px;color:#6a6155;">Most skybox packs
                        are already named this way and will just work. Also accepted:
                        <code>rt/lf/up/dn/ft/bk</code>, <code>posx/negx…</code>,
                        <code>px/nx…</code>, east/west/north/south — with or without a prefix,
                        e.g. <code>myscene_rt.png</code>.</p>
                        <p style="margin:0 0 4px;"><b>Size:</b> all 6 the <b>same square size</b>
                        (e.g. 1024×1024 or 2048×2048). Non-square images are center-cropped, so
                        very wide/tall ones lose their edges.</p>
                        <p style="margin:8px 0 0;">Next, pick the <b>folder</b> that contains the
                        6 images.</p>`,
                    confirmLabel: 'Choose folder…',
                    onConfirm: () => skyboxFileInput.click(),
                });
                return;
            }
            lastSkybox = folderName;
            onSkyboxChange(folderName);
        });

    skyboxFileInput.addEventListener('change', () => {
        const files = skyboxFileInput.files;
        if (!files || files.length === 0) return;
        // true on success; otherwise an array naming the faces it couldn't find,
        // which is far more actionable than "something was wrong with the folder".
        const result = onCustomSkyboxFiles(files);
        if (result !== true) {
            const missing = Array.isArray(result) ? result : [];
            showModal({
                title: "Couldn't read all 6 faces",
                bodyHTML: `
                    ${missing.length ? `<p style="margin:0 0 10px;">No image found for:
                    <strong>${missing.join(', ')}</strong>.</p>` : ''}
                    <p style="margin:0 0 10px;">Each of the six images needs a filename that
                    says which face it is. Any of these spellings work:</p>
                    <table style="margin:0 0 10px;border-collapse:collapse;font-size:14px;">
                      <tr><td style="padding:2px 14px 2px 0;"><strong>right</strong></td><td><code>right</code> · <code>rt</code> · <code>posx</code> · <code>px</code> · <code>east</code></td></tr>
                      <tr><td style="padding:2px 14px 2px 0;"><strong>left</strong></td><td><code>left</code> · <code>lf</code> · <code>negx</code> · <code>nx</code> · <code>west</code></td></tr>
                      <tr><td style="padding:2px 14px 2px 0;"><strong>top</strong></td><td><code>top</code> · <code>up</code> · <code>posy</code> · <code>py</code></td></tr>
                      <tr><td style="padding:2px 14px 2px 0;"><strong>bottom</strong></td><td><code>bottom</code> · <code>bot</code> · <code>dn</code> · <code>down</code> · <code>negy</code> · <code>ny</code></td></tr>
                      <tr><td style="padding:2px 14px 2px 0;"><strong>front</strong></td><td><code>front</code> · <code>ft</code> · <code>posz</code> · <code>pz</code> · <code>north</code></td></tr>
                      <tr><td style="padding:2px 14px 2px 0;"><strong>back</strong></td><td><code>back</code> · <code>bk</code> · <code>negz</code> · <code>nz</code> · <code>south</code></td></tr>
                    </table>
                    <p style="margin:0;font-size:14px;opacity:0.75;">Prefixes and suffixes are fine
                    — <code>myscene_rt.png</code> and <code>skyBK.jpg</code> both work. Files
                    numbered <code>0</code>–<code>5</code> can't be matched, since there's no way
                    to tell a face number from an image size.</p>`,
                confirmLabel: 'Got it',
                cancelLabel: null,
            });
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
    contentFolder.add(tableSettings, 'table', tableOptions)
        .name('Table')
        .onChange((label) => {
            if (label === tableCustomLabel) {
                fileInput.click();
                syncTableMatVisibility(label);
                return;
            }
            onTableChange(label);
            syncTableMatVisibility(label);
        });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        onCustomTableFile(file);
        fileInput.value = ''; // reset so picking the same file again still fires 'change'
    });

    // Table material — only meaningful for the Box/Cylinder plinths, since the
    // GLB tables carry their own materials. A colour swatch for a plain painted
    // plinth, plus the full set of PBR map slots for anything richer. Maps mix
    // freely and persist across Box↔Cylinder swaps (glbLoader keeps them).
    const tableMatFolder = contentFolder.addFolder('Table Material (Box/Cyl)');

    // Colour applies only when no albedo map is loaded — a map is TINTED by
    // colour, so the two would fight. glbLoader whitens the tint in that case.
    tableMatFolder.addColor(primitiveTableColor, 'hex').name('Plinth Color')
        .onChange(onTableColorChange);
    tableMatFolder.add({ reset: () => {
        primitiveTableColor.hex = '#e8e4dc'; // gallery-plinth off-white
        tableMatFolder.controllers.forEach((c) => c.updateDisplay());
        onTableColorChange(primitiveTableColor.hex);
    } }, 'reset').name('↺ Reset to plinth white');

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
    addTexturePicker('Metalness…',      'metalnessMap');
    addTexturePicker('Bump / Height…',  'bumpMap');

    // Shown AND expanded the moment Box/Cylinder is picked, directly beneath the
    // Table dropdown it belongs to. Left collapsed, the colour and texture
    // controls were behind a disclosure arrow that nobody would think to click —
    // the options may as well not have existed. Hidden entirely for the GLB
    // tables, which carry their own materials and would ignore these.
    const syncTableMatVisibility = (label) => {
        if (label === 'Box' || label === 'Cylinder') {
            tableMatFolder.show();
            tableMatFolder.open();
        } else {
            tableMatFolder.hide();
        }
    };
    syncTableMatVisibility(defaultTable);

    // Stone picker — swap the gem on the table to see how each one sits with the
    // rest of the still life. The same list drives the return-from-space cycle,
    // so whatever is offered here is also what can come back (see STONE_VARIANTS).
    const stoneFileInput = document.createElement('input');
    stoneFileInput.type = 'file';
    stoneFileInput.accept = '.glb,.gltf';
    stoneFileInput.style.display = 'none';
    document.body.appendChild(stoneFileInput);

    const stoneSettings = { stone: STONE_OPTIONS[0] };
    let lastStone = STONE_OPTIONS[0];
    const stoneCtrl = contentFolder.add(stoneSettings, 'stone', STONE_OPTIONS)
        .name('Stone')
        .onChange((label) => {
            if (label === STONE_CUSTOM_LABEL) {
                // Snap back to the last real choice so picking "Custom" twice in
                // a row still re-opens the dialog — lil-gui only fires onChange
                // when the value actually changes.
                stoneSettings.stone = lastStone;
                stoneCtrl.updateDisplay();
                stoneFileInput.click();
                return;
            }
            lastStone = label;
            onStoneChange(label);
        });

    stoneFileInput.addEventListener('change', () => {
        const file = stoneFileInput.files[0];
        if (file) onCustomStoneFile(file);
        stoneFileInput.value = '';
    });

    // Room surfaces — one folder per surface, one picker per PBR map type, so a
    // full texture set can be swapped in from disk without touching the code.
    // Uploads tile at the same world scale as the built-in sets (see
    // setRoomTexture), so they don't need to match any particular resolution.
    const roomTexFolder = gui.addFolder('Room Textures');
    ROOM_SURFACES.forEach((surface) => {
        const sub = roomTexFolder.addFolder(surface === 'wall' ? 'Walls + Ceiling' : 'Floor');
        Object.keys(ROOM_TEXTURE_SLOTS).forEach((slotLabel) => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = 'image/*';
            inp.style.display = 'none';
            document.body.appendChild(inp);
            const action = { pick: () => inp.click() };
            sub.add(action, 'pick').name(`${slotLabel}…`);
            inp.addEventListener('change', () => {
                const file = inp.files[0];
                if (file) onRoomTextureFile(surface, slotLabel, file);
                inp.value = '';
            });
        });
        // Puts back the textures the scene ships with, so an experiment is never
        // one-way — otherwise the only route back is a page reload.
        sub.add({ reset: () => onRoomTextureReset(surface) }, 'reset')
            .name('↺ Reset to original');
        sub.close();
    });
    roomTexFolder.close();

    // Sound picker + volume — same pattern as the Table picker: preset
    // options switch immediately, "Custom audio…" opens a hidden file input
    // and only takes effect once a file is actually chosen. Any format the
    // browser can decode works (mp3/wav/ogg/m4a). Used for both the room
    // track (café, fades out into space) and the space track (fades in).
    const soundFolder = gui.addFolder('Sound');
    function addSoundPicker(name, options, defaultLabel, onChange, onCustomFile, volume) {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/*';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        const settings = { sound: defaultLabel };
        soundFolder.add(settings, 'sound', options)
            .name(name)
            .onChange((label) => {
                if (label === soundCustomLabel) {
                    fileInput.click();
                    return;
                }
                onChange(label);
            });
        soundFolder.add(volume, 'value', 0, 1, 0.01).name(name + ' Volume');

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
    soundFolder.close();

    // Per-object placement folders are added at runtime as each GLB finishes
    // loading. Declared here so they land inside one parent instead of six
    // loose folders appended to the very bottom of the panel — and so the
    // camera readout below stays last no matter when the models arrive.
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
    cameraFolder.close();

    // Camera position display — capped to 2 decimal places for readability.
    function updateCameraDebug(position) {
        cameraDebug.x = +position.x.toFixed(2);
        cameraDebug.y = +position.y.toFixed(2);
        cameraDebug.z = +position.z.toFixed(2);
    }

    // Per-object debug folder, added once a stage object's GLB finishes loading.
    function addObjectFolder(label, entry, scaleFactor) {
        const folder = objectsFolder.addFolder(label);
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
