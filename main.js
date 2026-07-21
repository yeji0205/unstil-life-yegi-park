import * as THREE from 'three';

import { createRenderer, createCamera, setupResize } from './src/render/renderer.js';
import { setupLighting } from './src/render/lighting.js';
import { uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor } from './src/render/dissolve.js';
import { updateSkyboxFlow } from './src/render/skyboxFlow.js';
import { createPaintingIntro } from './src/render/paintingIntro.js';

import { buildRoom } from './src/geometry/room.js';
import { buildSkybox, buildStars, SKYBOX_OPTIONS, SKYBOX_CUSTOM_LABEL, LIGHTING_PRESETS } from './src/geometry/environment.js';

import {
    loadScene, setTable, setStone, setTableTexture, tableState, stageObjects, LOADING_TOTAL,
    TABLE_OPTIONS, TABLE_CUSTOM_LABEL, tableKindForLabel,
    STONE_OPTIONS, STONE_CUSTOM_LABEL,
} from './src/persistence/glbLoader.js';

import { createLoadingScreen } from './src/ui/loadingScreen.js';
import { createDebugGUI } from './src/ui/gui.js';

import { createAmbientSoundTracks, ROOM_SOUND_OPTIONS, SPACE_SOUND_OPTIONS, DISSOLVE_SOUND_OPTIONS, SOUND_CUSTOM_LABEL } from './src/audio/ambientSound.js';

import { createCameraControls } from './src/simulation/cameraControls.js';
import { createPhaseMachine } from './src/simulation/phaseMachine.js';
import { updateFloating } from './src/simulation/floating.js';

// ─── Renderer, scene, camera ─────────────────────────────────────────────────
const renderer = createRenderer();
const camera   = createCamera();
const scene    = new THREE.Scene();
setupResize(camera, renderer);

// ─── Geometry ────────────────────────────────────────────────────────────────
const { loadSkybox, loadCustomSkybox } = buildSkybox(scene);
const { updateStars } = buildStars(scene);
buildRoom(scene);

// ─── Lighting ────────────────────────────────────────────────────────────────
const { ambientLight, directionalLight, updateLighting, setSpacePreset } = setupLighting(scene);

// Swaps the background AND its matching lighting tint together — the GUI's
// "Skybox" dropdown is the only control needed; there's no separate lighting
// button because the two should never be out of sync.
function selectBackground(name) {
    loadSkybox(name);
    setSpacePreset(LIGHTING_PRESETS[name]);
}
selectBackground(SKYBOX_OPTIONS[0]);

// Custom cube map upload: 6 user-picked images matched to the 6 faces by
// filename. There's no lighting preset for an arbitrary user image, so it
// reuses the moody skybox_blue tint as a reasonable default. Returns whether
// the files matched — the GUI shows an error itself if not.
function selectCustomSkybox(files) {
    const ok = loadCustomSkybox(files);
    if (ok) setSpacePreset(LIGHTING_PRESETS.skybox_blue);
    return ok;
}

// ─── Camera controls ─────────────────────────────────────────────────────────
const cameraControls = createCameraControls(camera, renderer.domElement);

// ─── Painting intro ──────────────────────────────────────────────────────────
// A stylized (e.g. Van Gogh) painting of the starting room, shown first and
// dissolved away once loading finishes — see selectBackground-style wiring
// below where its reveal is kicked off and interaction unlocked afterward.
const paintingIntro = createPaintingIntro(renderer, scene, camera, 'asset/intro_painting.jpeg');

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

// Swaps the stone/gem stage object live — see setStone() for why this only
// touches that one object rather than the whole stage like setTable does.
function selectStone(label) {
    setStone(scene, label, { onObjectReady: (l, entry, scaleFactor) => gui.addObjectFolder(l, entry, scaleFactor) });
}
function selectCustomStone(file) {
    setStone(scene, STONE_CUSTOM_LABEL, {
        customUrl: URL.createObjectURL(file),
        onObjectReady: (l, entry, scaleFactor) => gui.addObjectFolder(l, entry, scaleFactor),
    });
}

// ─── Ambient sound ───────────────────────────────────────────────────────────
// Two layers, gain interpolated by p via the Web Audio API: café is full in
// the room and fades out into space; space-ambient is silent in the room and
// fades in. Both start on the first user gesture (autoplay policy).
const ambientSound = createAmbientSoundTracks();

// ─── Debug GUI ───────────────────────────────────────────────────────────────
const gui = createDebugGUI({
    uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uParticleColor,
    ambientLight, directionalLight,
    skyboxOptions: SKYBOX_OPTIONS, defaultSkybox: SKYBOX_OPTIONS[0], skyboxCustomLabel: SKYBOX_CUSTOM_LABEL,
    onSkyboxChange: selectBackground,
    onCustomSkyboxFiles: selectCustomSkybox,
    tableOptions: TABLE_OPTIONS, defaultTable: TABLE_OPTIONS[0], tableCustomLabel: TABLE_CUSTOM_LABEL,
    onTableChange: selectTable,
    onCustomTableFile: selectCustomTable,
    onTableTextureFile: (file) => setTableTexture(scene, file),
    stoneOptions: STONE_OPTIONS, defaultStone: STONE_OPTIONS[0], stoneCustomLabel: STONE_CUSTOM_LABEL,
    onStoneChange: selectStone,
    onCustomStoneFile: selectCustomStone,
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
    // The dissolve sound is now fired per-object (see onObjectDissolveStart
    // below) as each object begins dissolving, not once at button-press.
    onDissolveClick: () => phaseMachine.triggerDissolve(),
});

// ─── Phase state machine ─────────────────────────────────────────────────────
const clock = new THREE.Clock();
const phaseMachine = createPhaseMachine({
    scene, camera, cameraControls,
    tableState, stageObjects,
    dissolveController: gui.dissolveController,
    getTime: () => clock.getElapsedTime(),
    onObjectDissolveStart: () => ambientSound.dissolve.play(),
});

// ─── Loading screen + asset loading ──────────────────────────────────────────
// Once the "Unstil Life" text-dissolve loading screen is gone, start
// dissolving the painting intro; only once THAT finishes (or immediately, if
// there's no intro image) does scroll/orbit interaction unlock.
const loadingScreen = createLoadingScreen(LOADING_TOTAL, () => {
    gui.gui.show();
    paintingIntro.startReveal(() => {
        cameraControls.controls.enabled = true;
        phaseMachine.enableInteraction();
    });
});
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

    cameraControls.updateZoom(uProgress.value);
    updateLighting(p);
    updateSkyboxFlow(t);
    updateStars(dt);
    ambientSound.update(p, t);
    paintingIntro.update(dt);
    updateFloating({ t, p, stageObjects, tableState });
    cameraControls.updateAutoZoomOut(p);

    gui.updateCameraDebug(camera.position);

    cameraControls.controls.update();
    paintingIntro.render(scene, camera);
}
animate();
