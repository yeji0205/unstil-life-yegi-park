import * as THREE from 'three';

import { createRenderer, createCamera, setupResize, createAdaptiveQuality } from './src/render/renderer.js';
import { setupLighting } from './src/render/lighting.js';
import { uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor, updateDissolveTransparency } from './src/render/dissolve.js';
import { updateSkyboxFlow } from './src/render/skyboxFlow.js';
import { createPaintingIntro } from './src/render/paintingIntro.js';

import { buildRoom, setRoomTexture, resetRoomTextures } from './src/geometry/room.js';
import { buildSkybox, buildStars, SKYBOX_OPTIONS, SKYBOX_CUSTOM_LABEL, LIGHTING_PRESETS } from './src/geometry/environment.js';

import {
    loadScene, setTable, setTableTexture, applyReturnObjects,
    tableState, stageObjects, LOADING_TOTAL, setTableColor, setStone,
    TABLE_OPTIONS, TABLE_CUSTOM_LABEL, tableKindForLabel,
} from './src/persistence/glbLoader.js';

import { createLoadingScreen } from './src/ui/loadingScreen.js';
import { createPerfHud } from './src/ui/perfHud.js';
import { createSoundHint } from './src/ui/soundHint.js';
import { createDebugGUI } from './src/ui/gui.js';

import { createAmbientSoundTracks, ROOM_SOUND_OPTIONS, SPACE_SOUND_OPTIONS, DISSOLVE_SOUND_OPTIONS, SOUND_CUSTOM_LABEL } from './src/audio/ambientSound.js';

import { createCameraControls } from './src/simulation/cameraControls.js';
import { createPhaseMachine } from './src/simulation/phaseMachine.js';
import { updateFloating } from './src/simulation/floating.js';

// ─── Renderer, scene, camera ─────────────────────────────────────────────────
const renderer = createRenderer();
// Measures its own frame rate and trades resolution for smoothness on whatever
// machine opens the page — see createAdaptiveQuality.
const adaptiveQuality = createAdaptiveQuality(renderer);
const camera   = createCamera();
const scene    = new THREE.Scene();
setupResize(camera, renderer);

// ─── Geometry ────────────────────────────────────────────────────────────────
const { loadSkybox, loadCustomSkybox } = buildSkybox(scene);
const { updateStars } = buildStars(scene);
buildRoom(scene);

// ─── Lighting ────────────────────────────────────────────────────────────────
const { updateLighting, setSpacePreset } = setupLighting(scene);

// Swaps the background AND its matching lighting tint together — the GUI's
// "Skybox" dropdown is the only control needed; there's no separate lighting
// button because the two should never be out of sync.
function selectBackground(name) {
    const preset = LIGHTING_PRESETS[name] ?? LIGHTING_PRESETS.skybox_blue;
    setSpacePreset(preset); // apply immediately; textures load asynchronously
    // Once all 6 faces are in, replace the preset's hand-picked ambient colour
    // with the cube map's own measured average, so the fill light always matches
    // the background actually on screen. Only the hue comes from the sky — the
    // preset keeps control of intensity. See averageFaceColor in environment.js.
    loadSkybox(name, (skyColor) => setSpacePreset({ ...preset, ambientColor: skyColor }));
}
selectBackground(SKYBOX_OPTIONS[0]);

// Custom cube map upload: 6 user-picked images matched to the 6 faces by
// filename. There's no lighting preset for an arbitrary user image, so it
// reuses the moody skybox_blue tint as a reasonable default. Returns whether
// the files matched — the GUI shows an error itself if not.
function selectCustomSkybox(files) {
    const base = LIGHTING_PRESETS.skybox_blue;
    // A user image has no preset, but it doesn't need one for colour any more:
    // the fill is sampled from their own images, so the lighting matches
    // whatever they upload. The preset only supplies the intensities.
    // true on success, otherwise the array of faces it couldn't find.
    const result = loadCustomSkybox(files, (skyColor) =>
        setSpacePreset({ ...base, ambientColor: skyColor }));
    if (result === true) { setSpacePreset(base); return true; }
    return result; // e.g. ['top', 'bottom'] — the GUI names them in its error
}

// ─── Camera controls ─────────────────────────────────────────────────────────
const cameraControls = createCameraControls(camera, renderer.domElement);

// ─── Painting intro ──────────────────────────────────────────────────────────
// A stylized (Caravaggio) painting of the starting room, shown first and
// cross-dissolved into the live scene once the viewer clicks "Reveal".
//
// PERFORMANCE NOTE: while the painting is on screen, paintingIntro.render()
// draws the WHOLE scene twice per frame — an offscreen pass (so the painting
// can blend into the real render) plus the on-screen pass — which roughly
// halves the framerate for the entire time it's shown, and also routes the
// additive light cone through an offscreen buffer (that's what made the
// volumetric lighting look off). Set this to false to skip the intro entirely
// and start straight in the interactive 3D scene at full performance.
const SHOW_INTRO_PAINTING = false;
const paintingIntro = SHOW_INTRO_PAINTING
    ? createPaintingIntro(renderer, scene, camera, 'asset/intro_painting.png')
    : null;

// Swaps the table geometry live. Called both from the GUI's preset options
// (Box/Cylinder/Table (default)) and after a custom .glb file is picked —
// setTable() itself handles keeping the existing stage objects and just
// shifting them onto the new surface height rather than reloading them.
function selectTable(label) {
    setTable(scene, tableKindForLabel(label));
}
function selectCustomTable(file) {
    setTable(scene, 'custom', { customUrl: URL.createObjectURL(file) });
}

// ─── Ambient sound ───────────────────────────────────────────────────────────
// Two layers, gain interpolated by p via the Web Audio API: café is full in
// the room and fades out into space; space-ambient is silent in the room and
// fades in. Both start on the first user gesture (autoplay policy).
const ambientSound = createAmbientSoundTracks();

// ─── Debug GUI ───────────────────────────────────────────────────────────────
const gui = createDebugGUI({
    uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor,
    onRevealPainting: () => paintingIntro?.beginDissolve(),
    skyboxOptions: SKYBOX_OPTIONS, defaultSkybox: SKYBOX_OPTIONS[0], skyboxCustomLabel: SKYBOX_CUSTOM_LABEL,
    onSkyboxChange: selectBackground,
    onCustomSkyboxFiles: selectCustomSkybox,
    tableOptions: TABLE_OPTIONS, defaultTable: TABLE_OPTIONS[0], tableCustomLabel: TABLE_CUSTOM_LABEL,
    onTableChange: selectTable,
    onCustomTableFile: selectCustomTable,
    onTableTextureFile: (file, type) => setTableTexture(scene, file, type),
    onRoomTextureFile: (surface, slotLabel, file) => setRoomTexture(surface, slotLabel, file),
    onRoomTextureReset: (surface) => resetRoomTextures(surface),
    onTableColorChange: (hex) => setTableColor(hex),
    onRenderScaleChange: (v) => adaptiveQuality.setCeiling(v),
    onAdaptiveQualityToggle: (on) => adaptiveQuality.setEnabled(on),
    // Swapping the stone reloads just that one object, so it needs a fresh GUI
    // folder — the old one is destroyed with the object it described.
    onStoneChange: (label) => setStone(scene, label, {
        onObjectReady: (l, entry, scaleFactor) => gui.addObjectFolder(l, entry, scaleFactor),
    }),
    onCustomStoneFile: (file) => setStone(scene, 'Custom GLB…', {
        customUrl: URL.createObjectURL(file),
        onObjectReady: (l, entry, scaleFactor) => gui.addObjectFolder(l, entry, scaleFactor),
    }),
     roomSoundOptions: ROOM_SOUND_OPTIONS, defaultRoomSound: ROOM_SOUND_OPTIONS[0],
    spaceSoundOptions: SPACE_SOUND_OPTIONS, defaultSpaceSound: SPACE_SOUND_OPTIONS[0],
    soundCustomLabel: SOUND_CUSTOM_LABEL,
    onRoomSoundChange: (label) => ambientSound.room.setSound(label),
    onCustomRoomSoundFile: (file) => ambientSound.room.setCustomFile(file),
    roomSoundVolume: ambientSound.room.volume,
    onSpaceSoundChange: (label) => ambientSound.space.setSound(label),
    onCustomSpaceSoundFile: (file) => ambientSound.space.setCustomFile(file),
    spaceSoundVolume: ambientSound.space.volume,
    dissolveSoundOptions: DISSOLVE_SOUND_OPTIONS, defaultDissolveSound: DISSOLVE_SOUND_OPTIONS[0],
    onDissolveSoundChange: (label) => ambientSound.dissolve.setSound(label),
    onCustomDissolveSoundFile: (file) => ambientSound.dissolve.setCustomFile(file),
    dissolveSoundVolume: ambientSound.dissolve.volume,
    // Play the dissolve sound exactly ONCE, when the button actually starts a
    // dissolve (triggerDissolve returns false if not in the 'space' phase).
    onDissolveClick: () => { if (phaseMachine.triggerDissolve()) ambientSound.dissolve.play(); },
});

// ─── Phase state machine ─────────────────────────────────────────────────────
const clock = new THREE.Clock();
const phaseMachine = createPhaseMachine({
    scene, camera, cameraControls,
    tableState, stageObjects,
    dissolveController: gui.dissolveController,
    getTime: () => clock.getElapsedTime(),
    // Fires the instant everything has dissolved away in space. The objects that
    // reverse-dissolve back into the room are then the "returned" set, so the
    // still life that comes home isn't the one that left.
    onObjectsDissolved: () => applyReturnObjects(scene, {
        onObjectReady: (label, entry, scaleFactor) => gui.addObjectFolder(label, entry, scaleFactor),
    }),
});

// ─── Loading screen + asset loading ──────────────────────────────────────────
// Once the "Unstil Life" text-dissolve loading screen is gone, start
// dissolving the painting intro; only once THAT finishes (or immediately, if
// there's no intro image) does scroll/orbit interaction unlock.
const loadingScreen = createLoadingScreen(LOADING_TOTAL, () => {
    gui.gui.show();
    // Now that the room is visible, invite the click that unlocks audio. It
    // removes itself as soon as sound is actually playing.
    createSoundHint(ambientSound.onStarted);
    const startInteraction = () => {
        cameraControls.controls.enabled = true;
        phaseMachine.enableInteraction();
    };
    if (paintingIntro) {
        // Show the painting and wait — the viewer dissolves it with the GUI's
        // "Reveal Scene" button (onRevealPainting), controlling the timing.
        paintingIntro.arm(startInteraction);
    } else {
        // Intro disabled — go straight into the interactive 3D scene.
        startInteraction();
    }
});
loadScene(scene, {
    onAssetLoaded: () => loadingScreen.markAssetLoaded(),
    onAssetFailed: () => loadingScreen.markAssetLoaded(), // still advance so the loading screen doesn't hang
    onObjectReady: (label, entry, scaleFactor) => gui.addObjectFolder(label, entry, scaleFactor),
});

const perfHud = createPerfHud(renderer); // diagnostic readout — see src/ui/perfHud.js
// ─── Animate ─────────────────────────────────────────────────────────────────
let lastT = 0;
function animate() {
    requestAnimationFrame(animate);
    const t  = clock.getElapsedTime();
    const dt = t - lastT;
    lastT = t;

    const { p, phase } = phaseMachine.update(t);

    cameraControls.updateZoom(uProgress.value);
    updateLighting(p);
    updateSkyboxFlow(t);
    updateStars(dt);
    ambientSound.update(p, t);
    paintingIntro?.update(dt);
    updateFloating({ t, p, stageObjects, tableState });
    updateDissolveTransparency(); // keep materials opaque unless mid-dissolve
    cameraControls.updateAutoZoomOut(p);

    gui.updateCameraDebug(camera.position);

    adaptiveQuality.update(dt);
    perfHud.update();
    cameraControls.controls.update();
    // With the intro active, render() does its two-pass cross-dissolve; without
    // it, a single straight render at full performance.
    if (paintingIntro) paintingIntro.render(scene, camera);
    else renderer.render(scene, camera);
}
animate();
