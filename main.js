import * as THREE from 'three';

import { createRenderer, createCamera, setupResize, createAdaptiveQuality } from './src/setup/renderer.js';
import { setupLighting } from './src/scene/lighting.js';
import { uProgress, uDissolveEdge, uObjectDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor, uParticleSwirl, uParticleSize, uParticleLife, uParticleDrift, uParticleTwinkle, uParticleSpikes, uParticleSpikeSharp, uParticleSpikeLength, uParticleShrink, uParticleShiny, uObjectDissolveEdgeColor, uObjectEdgeFollow, uObjectEdgeGain, updateDissolveTransparency } from './src/effects/dissolve.js';
import { updateSkyboxFlow } from './src/effects/skyboxFlow.js';
import { createParticleBloom, bloomSettings } from './src/effects/particleBloom.js';
import { PARTICLE_BLOOM_LAYER } from './src/effects/dissolve.js';

import { buildRoom, setRoomTexture, resetRoomTextures } from './src/scene/room.js';
import { buildSkybox, buildStars, SKYBOX_OPTIONS, SKYBOX_CUSTOM_LABEL, SKYBOX_NONE, LIGHTING_PRESETS, voidColor } from './src/scene/environment.js';

import {
    loadScene, setTable, setTableTexture, applyReturnObjects,
    tableState, stageObjects, LOADING_TOTAL, setTableColor, setStone,
    TABLE_OPTIONS, TABLE_CUSTOM_LABEL, tableKindForLabel,
} from './src/objects/glbLoader.js';

import { createLoadingScreen } from './src/ui/loadingScreen.js';
import { createPerfHud } from './src/ui/perfHud.js';
import { createSoundHint } from './src/ui/soundHint.js';
import { createDebugGUI } from './src/ui/gui.js';

import { createAmbientSoundTracks, ROOM_SOUND_OPTIONS, SPACE_SOUND_OPTIONS, DISSOLVE_SOUND_OPTIONS, SOUND_CUSTOM_LABEL } from './src/audio/ambientSound.js';

import { createCameraControls } from './src/setup/cameraControls.js';
import { createPhaseMachine } from './src/scene/phaseMachine.js';
import { updateFloating } from './src/effects/floating.js';

// Entry point: builds the scene from the modules in src/, wires up the GUI,
// and runs the animation loop.

// ─── Renderer, scene, camera ─────────────────────────────────────────────────
const renderer = createRenderer();
// Lowers the resolution on slow machines to keep the frame rate (see renderer.js).
const adaptiveQuality = createAdaptiveQuality(renderer);
const camera   = createCamera();
const scene    = new THREE.Scene();

// The particles are on their own layer (for the bloom pass). The camera only
// draws layer 0 by default, so without this they'd never be rendered.
camera.layers.enable(PARTICLE_BLOOM_LAYER);
setupResize(camera, renderer);

// ─── Selective particle bloom ────────────────────────────────────────────────
// The glow for shiny particles; only used while shiny mode is on.
// See effects/particleBloom.js.
const particleBloom = createParticleBloom(renderer, scene, camera);

// ─── Geometry ────────────────────────────────────────────────────────────────
const { loadSkybox, loadCustomSkybox, setVoidColor } = buildSkybox(scene);
const { updateStars } = buildStars(scene);
buildRoom(scene);

// ─── Lighting ────────────────────────────────────────────────────────────────
const { updateLighting, setSpacePreset } = setupLighting(scene);

// Changes the background and its matching lighting together (GUI "Skybox"),
// so the two never get out of sync.
function selectBackground(name) {
    const preset = LIGHTING_PRESETS[name] ?? LIGHTING_PRESETS.space_blue;
    setSpacePreset(preset); // apply immediately; textures load asynchronously
    // When the faces have loaded, the fill light takes the background's measured
    // colour (hue only; the preset keeps the intensity). Only a flat colour passes
    // `brightness`, so a dark colour darkens the scene (see environment.js).
    loadSkybox(name, (skyColor, brightness) => setSpacePreset({
        ...preset,
        ambientColor:     skyColor,
        ambientIntensity: preset.ambientIntensity * (brightness ?? 1),
    }));
}
selectBackground(SKYBOX_OPTIONS[0]);

// Changes the flat background colour and tints the fill light to match, like
// selectBackground does for a skybox.
function selectVoidColor(hex) {
    const preset = LIGHTING_PRESETS[SKYBOX_NONE];
    setVoidColor(hex, (hue, brightness) => setSpacePreset({
        ...preset,
        ambientColor:     hue,
        ambientIntensity: preset.ambientIntensity * brightness,
    }));
}

// Set once the GUI exists (it's created after the skybox), so the report on
// uploaded images has somewhere to go.
let customSkyboxReport = null;

// Custom skybox upload: 6 images matched to the faces by filename. Intensities
// come from the space_blue preset; the fill colour is measured from the images.
// Returns true, or the list of faces it couldn't find (the GUI shows the error).
function selectCustomSkybox(files) {
    const base = LIGHTING_PRESETS.space_blue;
    // The third callback reports image problems that cause seams (see inspectFaces).
    const result = loadCustomSkybox(
        files,
        (skyColor) => setSpacePreset({ ...base, ambientColor: skyColor }),
        (report) => customSkyboxReport?.(report),
    );
    if (result === true) { setSpacePreset(base); return true; }
    return result; // e.g. ['top', 'bottom'] — the GUI names them in its error
}

// ─── Camera controls ─────────────────────────────────────────────────────────
const cameraControls = createCameraControls(camera, renderer.domElement);

// Swaps the table (GUI "Table" dropdown, or a custom .glb). The objects stay
// and are just moved to the new surface height.
function selectTable(label) {
    setTable(scene, tableKindForLabel(label));
}
function selectCustomTable(file) {
    setTable(scene, 'custom', { customUrl: URL.createObjectURL(file) });
}

// ─── Ambient sound ───────────────────────────────────────────────────────────
// Café ambience in the room, fading out toward space; a space track (volume 0
// by default); and the dissolve sound. Audio starts on the first click or key.
const ambientSound = createAmbientSoundTracks();

// ─── Debug GUI ───────────────────────────────────────────────────────────────
const gui = createDebugGUI({
    uProgress, uDissolveEdge, uObjectDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uObjectDissolveEdgeColor, uObjectEdgeFollow, uObjectEdgeGain, uParticleColor, uParticleSwirl, uParticleSize, uParticleLife, uParticleDrift, uParticleTwinkle, uParticleSpikes, uParticleSpikeSharp, uParticleSpikeLength, uParticleShrink, uParticleShiny,
    bloomSettings,
    skyboxOptions: SKYBOX_OPTIONS, defaultSkybox: SKYBOX_OPTIONS[0], skyboxCustomLabel: SKYBOX_CUSTOM_LABEL,
    onSkyboxChange: selectBackground,
    onCustomSkyboxFiles: selectCustomSkybox,
    skyboxNoneLabel: SKYBOX_NONE, voidColor, onVoidColorChange: selectVoidColor,
    tableOptions: TABLE_OPTIONS, defaultTable: TABLE_OPTIONS[0], tableCustomLabel: TABLE_CUSTOM_LABEL,
    onTableChange: selectTable,
    onCustomTableFile: selectCustomTable,
    onTableTextureFile: (file, type) => setTableTexture(scene, file, type),
    onRoomTextureFile: (surface, slotLabel, file) => setRoomTexture(surface, slotLabel, file),
    onRoomTextureReset: (surface) => resetRoomTextures(surface),
    onTableColorChange: (hex) => setTableColor(hex),
    // A swapped stone is a new object, so it gets a new GUI folder.
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
    // The dissolve sound starts by itself: it follows the dissolve every frame.
    onDissolveClick: () => phaseMachine.triggerDissolve(),
    // Functions, not direct references: the GUI is built before phaseMachine,
    // so it's looked up when called.
    onDissolvePauseToggle: (paused) => phaseMachine.setDissolvePaused(paused),
    onDissolveSeek:      (fraction) => phaseMachine.seekDissolve(fraction),
    // lil-gui reads this immediately, before phaseMachine exists, which throws a
    // ReferenceError and would stop the rest of the panel being built. Only that
    // error is caught.
    getDissolveFraction: () => {
        try { return phaseMachine.getDissolveFraction(); }
        catch (e) { if (e instanceof ReferenceError) return 0; throw e; }
    },
});
customSkyboxReport = gui.reportSkyboxImages;

// ─── Phase state machine ─────────────────────────────────────────────────────
const clock = new THREE.Clock();
const phaseMachine = createPhaseMachine({
    scene, camera, cameraControls,
    tableState, stageObjects,
    dissolveController: gui.dissolveController,
    // When everything has dissolved, swap in the objects that come back, so the
    // still life that returns isn't the one that left.
    onObjectsDissolved: () => applyReturnObjects(scene, {
        onObjectReady: (label, entry, scaleFactor) => gui.addObjectFolder(label, entry, scaleFactor),
    }),
});

// ─── Loading screen + asset loading ──────────────────────────────────────────
// Once the "Unstil Life" text-dissolve loading screen is gone, scroll/orbit
// interaction unlocks.
const loadingScreen = createLoadingScreen(LOADING_TOTAL, () => {
    gui.gui.show();
    // Shows "click to play sound" until audio is playing.
    createSoundHint(ambientSound.onStarted);
    cameraControls.controls.enabled = true;
    phaseMachine.enableInteraction();
});
// Frame-time / GPU readout, bottom-left. Delete this line and the .update()
// call in the loop to remove it.
const perfHud = createPerfHud(renderer);

loadScene(scene, {
    onAssetLoaded: () => loadingScreen.markAssetLoaded(),
    onAssetFailed: () => loadingScreen.markAssetLoaded(), // still advance so the loading screen doesn't hang
    onObjectReady: (label, entry, scaleFactor) => gui.addObjectFolder(label, entry, scaleFactor),
});

// ─── Animate ─────────────────────────────────────────────────────────────────
let lastT = 0;
function animate() {
    requestAnimationFrame(animate);
    const t  = clock.getElapsedTime();
    const dt = t - lastT;
    lastT = t;

    const { p, phase } = phaseMachine.update(t);

    cameraControls.updateZoom(uProgress.value, { roomReturnBlocked: phase === 'dissolving' });
    updateLighting(p);
    updateSkyboxFlow(t);
    updateStars(dt);
    ambientSound.update(p, t, phaseMachine.getDissolvePlayback());
    updateFloating({ t, p, stageObjects, tableState });
    updateDissolveTransparency(); // keep materials opaque unless mid-dissolve
    cameraControls.updateAutoZoomOut(p);

    gui.updateCameraDebug(camera.position);

    adaptiveQuality.update(dt);
    perfHud.update();
    cameraControls.controls.update();
    // Two render paths:
    //  - shiny particles on: the same straight render, plus a particles-only
    //    pass for the glow map and an additive overlay of it.
    //  - otherwise: one straight render.
    if (uParticleShiny.value > 0.5) particleBloom.render();
    else renderer.render(scene, camera);
}
animate();
