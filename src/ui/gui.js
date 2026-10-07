import GUI from 'lil-gui';
import { flowState } from '../effects/skyboxFlow.js';
import { scrollSmoothing, dissolveDuration } from '../scene/phaseMachine.js';
import { ROOM_SURFACES, ROOM_TEXTURE_SLOTS } from '../scene/room.js';
import { primitiveTableColor } from '../objects/plinth.js';
import { STONE_NAMES } from '../objects/objectVariants.js';
import { roomLighting, environmentMap } from '../scene/lighting.js';

// The Table and Stone dropdown labels live here because they're only GUI text:
// the scene is told a table kind ('glb' | 'box' | 'cylinder') or a stone name.
// "Custom GLB…" in either dropdown opens a file picker.
const CUSTOM_GLB_LABEL = 'Custom GLB…';
// The Table dropdown: label → the table kind the scene builds. To add a shape:
// a label here and a case in loadTableGeometry() (objects/table.js).
const TABLE_KIND_BY_LABEL = {
    'Table (default)': 'glb',
    'Box':             'box',
    'Cylinder':        'cylinder',
};
const TABLE_OPTIONS = [...Object.keys(TABLE_KIND_BY_LABEL), CUSTOM_GLB_LABEL];

// A centred dialog with a dimmed backdrop and up to two buttons, used instead
// of alert() for the custom-skybox instructions. Buttons close it and run their
// callback.
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

// Builds the lil-gui panel (hidden until the loading screen is gone; call
// show()). The phase machine decides when Dissolve works; main.js passes that
// on through the returned setDissolveAvailable().
export function createDebugGUI({
    uProgress, uDissolveEdge, uObjectDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uObjectDissolveEdgeColor, uObjectEdgeFollow, uObjectEdgeGain, uParticleColor, uParticleSwirl, uParticleSize, uParticleLife, uParticleDrift, uParticleTwinkle, uParticleSpikes, uParticleSpikeSharp, uParticleSpikeLength, uParticleShrink,
    uParticleShiny, bloomSettings,
    skyboxOptions, defaultSkybox, skyboxCustomLabel, onSkyboxChange, onCustomSkyboxFiles,
    skyboxNoneLabel, voidColor, onVoidColorChange,
    onTableChange, onCustomTableFile, onTableTextureFile,
    onRoomTextureFile, onRoomTextureReset, onTableColorChange,
    onStoneChange, onCustomStoneFile,
    roomSoundOptions, defaultRoomSound, spaceSoundOptions, defaultSpaceSound,
    dissolveSoundOptions, defaultDissolveSound, soundCustomLabel,
    onRoomSoundChange, onCustomRoomSoundFile, roomSoundVolume,
    onSpaceSoundChange, onCustomSpaceSoundFile, spaceSoundVolume,
    onDissolveSoundChange, onCustomDissolveSoundFile, dissolveSoundVolume,
    onDissolveClick, onDissolvePauseToggle, onDissolveSeek, getDissolveFraction,
}) {
    const gui = new GUI({ title: 'Unstil Life Debug' });
    gui.hide(); // hidden during loading screen; shown once the loading dissolve completes

    // Button lives in the GUI panel. Disabled until phase === 'space'.
    const dissolveActions = { dissolve: () => onDissolveClick() };
    const dissolveController = gui.add(dissolveActions, 'dissolve').name('▶ Dissolve Objects');
    dissolveController.disable(); // enabled once the room is fully gone (setDissolveAvailable)
    function setDissolveAvailable(available) { dissolveController.enable(available); }

    // Freezes the dissolve, to look at one moment of it. Can be pressed before
    // Dissolve too, which then holds at the very start.
    let dissolvePaused = false;
    const dissolvePauseAction = {
        toggle: () => {
            dissolvePaused = !dissolvePaused;
            onDissolvePauseToggle(dissolvePaused);
            dissolvePauseController.name(dissolvePaused ? '▶ Resume Dissolve' : '⏸ Pause Dissolve');
        },
    };
    const dissolvePauseController = gui.add(dissolvePauseAction, 'toggle').name('⏸ Pause Dissolve');

    // Scrub bar: drag back to rewind, forward to advance. It reads the phase
    // machine every frame (.listen()), so it also follows playback and the return.
    // Dragging pauses, so the bar holds the moment, but only if the seek applied
    // (mid-dissolve); otherwise the next Dissolve would start paused.
    const dissolveScrub = {
        get position() { return getDissolveFraction(); },
        set position(v) {
            if (onDissolveSeek(v) && !dissolvePaused) dissolvePauseAction.toggle();
        },
    };
    gui.add(dissolveScrub, 'position', 0, 1, 0.001).name('⏯ Dissolve Position').listen();

    // Toggles the swirling curl-noise UV warp on the skybox texture (see
    // effects/skyboxFlow.js). Label flips to reflect state, same pattern as
    // the dissolve button above.
    const bgMotionAction = {
        toggle: () => {
            flowState.enabled = !flowState.enabled;
            bgMotionController.name(flowState.enabled ? '⏸ Stop Background Motion' : '🌀 Animate Background');
        },
    };
    const bgMotionController = gui.add(bgMotionAction, 'toggle').name('🌀 Animate Background');

    // Flat/shiny particle switch, at the top level so it can be flipped during a
    // dissolve; it takes effect on the next frame. Flat mode skips the glow pass,
    // so it's also faster. The label names what the NEXT click does (the opposite
    // of the current mode), and is read from the uniform so it always matches.
    const shinyLabel = () => (uParticleShiny.value > 0.5
        ? '⚪ Flat White Particles'
        : '✨ Shiny Particles');
    const particleShinyAction = {
        toggle: () => {
            uParticleShiny.value = uParticleShiny.value > 0.5 ? 0.0 : 1.0;
            particleShinyController.name(shinyLabel());
        },
    };
    const particleShinyController = gui.add(particleShinyAction, 'toggle').name(shinyLabel());

    // ─── Panel layout ────────────────────────────────────────────────────────
    // Only the controls you press (buttons and the scrub bar) sit at the top
    // level; everything else is in folders. lil-gui shows things in creation
    // order, so these three folders are created here to fix the order and filled
    // in further down.
    const sceneFolder    = gui.addFolder('Scene');
    const dissolveFolder = gui.addFolder('Dissolve Look');
    const contentFolder  = gui.addFolder('Scene Contents');

    sceneFolder.add(uProgress, 'value', 0, 1, 0.01).name('Progress (p)').listen();
    // Scroll feel: how much the scene trails the wheel. Higher = objects drift
    // and coast (floaty); lower = they track the wheel closely (snappy, but the
    // float/bob gets swamped and reads as dragging). See scrollSmoothing.
    sceneFolder.add(scrollSmoothing, 'tau', 0.08, 0.6, 0.01).name('Scroll Drift (float ⇢)');

    // Room Key dims the key light for EVERYTHING; Object Key puts it back on the
    // table and the objects alone, via a light they have a layer for. Together
    // they darken the walls and floor without taking the still life with them.
    // 1.0 / 0.0 is the original lighting exactly.
    sceneFolder.add(roomLighting, 'roomKey',   0.05, 1.5, 0.05).name('Room Key Light');
    sceneFolder.add(roomLighting, 'objectKey', 0.0,  4.0, 0.05).name('Object Key Light');
    sceneFolder.add(roomLighting, 'ambient',   0.0,  1.5, 0.05).name('Room Ambient');
    sceneFolder.add(roomLighting, 'wallFill',  0.0,  1.5, 0.05).name('Room Wall Fill');
    // The spotlight matched to the visible shaft — this is what creates the
    // bright pool, so it is the one to raise for more contrast, not lower.
    sceneFolder.add(roomLighting, 'beam',      0.0,  25,  0.5 ).name('Beam Light');
    // Fade each light's shadow on its own: 0 = gone, 1 = full. The beam's is the
    // dark one inside the lit pool; the key's is the lighter one that reaches
    // beyond it. Only the shadow changes — the light stays. Capped at 1, see
    // roomLighting.beamShadow for why.
    sceneFolder.add(roomLighting, 'beamShadow', 0, 1, 0.01).name('Beam Shadow');
    sceneFolder.add(roomLighting, 'keyShadow',  0, 1, 0.01).name('Key Light Shadow');
    // How strongly objects reflect their surroundings in space (see lighting.js).
    sceneFolder.add(environmentMap, 'strength', 0, 3, 0.05).name('Env Map Strength');
    sceneFolder.add(roomLighting, 'beamWidth', 0.4,  2.5, 0.05).name('Beam Width');
    sceneFolder.add(roomLighting, 'beamShiftX', -4, 4, 0.1).name('Beam Shift X (→)');
    sceneFolder.add(roomLighting, 'beamShiftZ', -4, 4, 0.1).name('Beam Shift Z (back)');
    sceneFolder.add(roomLighting, 'beamSoftness', 0, 1, 0.05).name('Beam Softness');
    sceneFolder.add(roomLighting, 'beamHaze', 0, 1.5, 0.05).name('Beam Haze');

    // Two edge widths, not one. The same number lands very differently on a
    // 10-unit wall and a 1-unit object — see uObjectDissolveEdge for the
    // arithmetic. The object range is finer because its useful band is smaller.
    dissolveFolder.add(uDissolveEdge,       'value', 0, 0.8,  0.01 ).name('Edge Width (Room)');
    dissolveFolder.add(uObjectDissolveEdge, 'value', 0, 0.5,  0.005).name('Edge Width (Objects)');
    dissolveFolder.add(uNoiseFreq,    'value', 0.1, 1.5, 0.01).name('Noise Frequency');
    // The colour of the edge around the holes in the walls (black by default).
    const edgeColorProxy = { color: '#' + uDissolveEdgeColor.value.getHexString() };
    dissolveFolder.addColor(edgeColorProxy, 'color').name('Edge Color (Room)')
        .onChange((hex) => uDissolveEdgeColor.value.set(hex));

    // Edge colour for the table and objects, separate from the room's. White by
    // default, like the particles. Ignored while "Edge Uses Object Color" is on.
    const objectEdgeColorProxy = { color: '#' + uObjectDissolveEdgeColor.value.getHexString() };
    dissolveFolder.addColor(objectEdgeColorProxy, 'color').name('Edge Color (Objects)')
        .onChange((hex) => uObjectDissolveEdgeColor.value.set(hex));

    // When on, the edge uses the object's own colour instead of the picker above,
    // so holes in the hollow models don't get a bright outline. Brightness: below
    // 1 the edge is darker than the object, above 1 it glows.
    const edgeFollowProxy = { on: uObjectEdgeFollow.value > 0.5 };
    dissolveFolder.add(edgeFollowProxy, 'on').name('Edge Uses Object Color')
        .onChange((v) => { uObjectEdgeFollow.value = v ? 1.0 : 0.0; });
    dissolveFolder.add(uObjectEdgeGain, 'value', 0, 2.5, 0.05).name('Edge Brightness (Objects)');

    // Dissolve particle color — live picker so neon shades can be auditioned.
    // Proxy holds a hex string (what lil-gui's color widget edits); onChange
    // writes it into the shared THREE.Color uniform every particle reads.
    const particleColorProxy = { color: '#' + uParticleColor.value.getHexString() };
    dissolveFolder.addColor(particleColorProxy, 'color').name('Particle Color')
        .onChange((hex) => uParticleColor.value.set(hex));
    // How far the particle stream wanders sideways. 0 is a perfectly straight
    // stream — the calmest setting, and worth starting from when judging the feel.
    dissolveFolder.add(uParticleSwirl, 'value', 0, 0.25, 0.005).name('Particle Sway');

    // Size is a particle's size on screen. Life is how long it lasts after the
    // dissolve edge passes it; Drift is how far it travels in that time.
    // Speed is Drift / Life, so raising Life alone slows them down.
    dissolveFolder.add(uParticleSize,  'value', 0.3, 3.0, 0.05).name('Particle Size');
    dissolveFolder.add(uParticleLife,  'value', 0.4, 4.0, 0.1 ).name('Particle Life');
    dissolveFolder.add(uParticleDrift, 'value', 0.2, 8.0, 0.1 ).name('Particle Drift');

    // The time budget the whole effect is spent out of — see dissolveDuration.
    // Raising it slows the specks without narrowing the plume, which is the one
    // thing Drift and Life cannot do between them.
    dissolveFolder.add(dissolveDuration, 'value', 1.5, 12, 0.5).name('Dissolve Duration (s)');
    dissolveFolder.add(uParticleTwinkle, 'value', 0, 1, 0.05).name('Particle Twinkle');
    dissolveFolder.add(uParticleSpikes,  'value', 0, 1, 0.05).name('Particle Spikes');
    // Sharpness is a ray WIDTH, and it is the control that decides whether the
    // star is visible at all: half-width in pixels = (1/value) * sprite radius,
    // against a sprite clamped to 3-8 px. Range stops at 40 because anything
    // beyond that is already thinner than a pixel and indistinguishable.
    dissolveFolder.add(uParticleSpikeSharp,  'value', 2, 40, 0.5).name('Spike Sharpness');
    // Lower = longer rays (it is the exponent on the radial fade).
    dissolveFolder.add(uParticleSpikeLength, 'value', 0.5, 4, 0.1).name('Spike Length');
    dissolveFolder.add(uParticleShrink,  'value', 0, 5, 0.1 ).name('Particle Shrink');


    // ─── Particle bloom ──────────────────────────────────────────────────────
    // Only affects shiny mode. Sliders, because the right glow depends on the
    // background (a bright nebula needs more than a black void).
    const bloomFolder = dissolveFolder.addFolder('Particle Bloom (shiny only)');
    // Composite strength is the dial to reach for first — it scales the whole
    // glow after the fact, without touching what qualifies as bloom.
    bloomFolder.add(bloomSettings, 'composite', 0, 20, 0.1).name('Glow Strength');
    // How far the glow bleeds outward from each speck.
    bloomFolder.add(bloomSettings, 'radius', 0, 1, 0.01).name('Glow Radius');
    // Luminance a pixel has to reach before it blooms at all. Raise it to make
    // only the hottest particle cores glow; drop it and the dimmer trailing
    // specks start to as well.
    bloomFolder.add(bloomSettings, 'threshold', 0, 1, 0.01).name('Glow Threshold');
    bloomFolder.add(bloomSettings, 'strength', 0, 3, 0.01).name('Bloom Pass Strength');

    // Skybox picker (options from SKYBOX_OPTIONS in scene/environment.js).
    // "Add custom skybox…" opens a FOLDER picker: a skybox needs 6 face images,
    // which are matched to the faces by filename (see matchFaceFiles).
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
                // Reset the dropdown, or choosing "Add custom skybox…" a second
                // time wouldn't fire onChange (the value wouldn't change).
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
            syncVoidColorVisibility(folderName);
        });

    // Background colour: only shown for the solid-colour option, since it does
    // nothing while a skybox is showing. (Table Material below works the same way.)
    const voidColorCtrl = contentFolder.addColor(voidColor, 'hex').name('Background Color')
        .onChange(onVoidColorChange);
    const voidResetCtrl = contentFolder.add({ reset: () => {
        voidColor.hex = '#ffffff';
        voidColorCtrl.updateDisplay();
        onVoidColorChange(voidColor.hex);
    } }, 'reset').name('↺ Reset to white');
    const syncVoidColorVisibility = (label) => {
        if (label === skyboxNoneLabel) { voidColorCtrl.show(); voidResetCtrl.show(); }
        else                           { voidColorCtrl.hide(); voidResetCtrl.hide(); }
    };
    syncVoidColorVisibility(defaultSkybox);

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

    // Called once all 6 faces of a custom cube map have decoded, with anything
    // about the IMAGES that will make the joins visible. Shown only when there's
    // something to say — a clean folder loads silently.
    function reportSkyboxImages(report) {
        if (!report?.notes?.length) return;
        showModal({
            title: 'Background loaded, with caveats',
            bodyHTML: `
                <p style="margin:0 0 10px;">The six faces were found and applied, but
                these will show as edges between them:</p>
                <ul style="margin:0 0 12px;padding-left:20px;">
                  ${report.notes.map(n => `<li style="margin-bottom:6px;">${n}</li>`).join('')}
                </ul>
                <p style="margin:0;font-size:14px;opacity:0.8;">A cube map only joins
                invisibly when all six faces are <b>square and the same size</b>, and when
                they came from one cube map rather than being assembled by hand. If the
                sizes look right and you still see edges, the pack is most likely using a
                different face <b>orientation</b> convention — top and bottom are the usual
                culprits, and that can only be fixed by rotating those two images.</p>`,
            confirmLabel: 'Got it',
            cancelLabel: null,
        });
    }

    // Table picker — swaps the table geometry live. "Custom GLB…" opens a
    // hidden file input instead of switching immediately; the actual swap
    // happens once the user picks a .glb file (or never, if they cancel —
    // the dropdown is left showing "Custom GLB…" but nothing changes).
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.glb,.gltf';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    const tableSettings = { table: TABLE_OPTIONS[0] };
    contentFolder.add(tableSettings, 'table', TABLE_OPTIONS)
        .name('Table')
        .onChange((label) => {
            if (label === CUSTOM_GLB_LABEL) {
                fileInput.click();
                syncTableMatVisibility(label);
                return;
            }
            onTableChange(TABLE_KIND_BY_LABEL[label]);
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
    // freely and persist across Box↔Cylinder swaps (objects/plinth.js keeps them).
    const tableMatFolder = contentFolder.addFolder('Table Material (Box/Cyl)');

    // Colour applies only when no albedo map is loaded — a map is TINTED by
    // colour, so the two would fight. plinth.js whitens the tint in that case.
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

    // Shown, and opened, only for Box/Cylinder (collapsed, nobody found it). GLB
    // tables have their own materials and ignore these.
    const syncTableMatVisibility = (label) => {
        if (label === 'Box' || label === 'Cylinder') {
            tableMatFolder.show();
            tableMatFolder.open();
        } else {
            tableMatFolder.hide();
        }
    };
    syncTableMatVisibility(TABLE_OPTIONS[0]);

    // Stone picker — swap the gem on the table to see how each one sits with the
    // rest of the still life. The same list drives the return-from-space cycle,
    // so whatever is offered here is also what can come back (see STONE_VARIANTS).
    const stoneFileInput = document.createElement('input');
    stoneFileInput.type = 'file';
    stoneFileInput.accept = '.glb,.gltf';
    stoneFileInput.style.display = 'none';
    document.body.appendChild(stoneFileInput);

    const stoneOptions = [...STONE_NAMES, CUSTOM_GLB_LABEL];
    const stoneSettings = { stone: stoneOptions[0] };
    let lastStone = stoneOptions[0];
    const stoneCtrl = contentFolder.add(stoneSettings, 'stone', stoneOptions)
        .name('Stone')
        .onChange((label) => {
            if (label === CUSTOM_GLB_LABEL) {
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

    // Room textures: one folder per surface, one file picker per map type.
    // Uploads tile at the same world scale as the built-in textures, whatever
    // their resolution.
    const roomTexFolder = gui.addFolder('Room Textures');
    roomTexFolder.close();
    ROOM_SURFACES.forEach((surface) => {
        const sub = roomTexFolder.addFolder(surface === 'wall' ? 'Walls + Ceiling' : 'Floor');
        sub.close();
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
    });

    // Sound pickers and volumes for the room, space and dissolve sounds. Presets
    // switch immediately; "Custom audio…" opens a file picker (mp3/wav/ogg/m4a).
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

    // Camera position display — capped to 2 decimal places for readability.
    function updateCameraDebug(position) {
        cameraDebug.x = +position.x.toFixed(2);
        cameraDebug.y = +position.y.toFixed(2);
        cameraDebug.z = +position.z.toFixed(2);
    }

    // Per-object debug folders: one is added when an object finishes loading,
    // and removed when the object is swapped for another model.
    const objectFolders = new Map(); // object entry → its folder
    function addObjectFolder(label, entry, scaleFactor) {
        // Closed like the rest. These are created as each GLB finishes loading,
        // which is after the closeAll pass at the end of this function has
        // already run, so they have to close themselves.
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

    // Close every folder (nested ones too), so the panel opens as a short list.
    // Done once here, so a new folder can't forget it.
    (function closeAll(g) {
        for (const folder of g.folders) { folder.close(); closeAll(folder); }
    })(gui);
    // ...except Scene Contents (skybox, table, stone), used most often.
    contentFolder.open();

    return { gui, setDissolveAvailable, updateCameraDebug, addObjectFolder, removeObjectFolder, reportSkyboxImages };
}
