import * as THREE from 'three';

import { createRenderer, createCamera, setupResize, createAdaptiveQuality } from './src/setup/renderer.js';
import { setupLighting } from './src/scene/lighting.js';
import { updateDissolveTransparency, precompileDissolveShaders } from './src/effects/dissolve.js';
import { uParticleShiny, PARTICLE_BLOOM_LAYER } from './src/effects/dissolveParticles.js';
import { updateSkyboxFlow } from './src/effects/skyboxFlow.js';
import { createParticleBloom } from './src/effects/particleBloom.js';

import { buildRoom, setRoomTexture, resetRoomTextures } from './src/scene/room.js';
import { buildSkybox, SKYBOX_OPTIONS, SKYBOX_NONE, LIGHTING_PRESETS } from './src/scene/space.js';
import { buildStars } from './src/scene/stars.js';

import {
    loadScene, setTable, setTableTexture, setTableColor, tableState, LOADING_TOTAL,
} from './src/objects/tableSetup.js';
import { stillLifeObjects } from './src/objects/objectsSetup.js';
import {
    setStone, setCustomStone, applyReturnObjects, preloadReturnObjects, hiddenModels, PRELOADED_MODEL_COUNT,
} from './src/objects/objectSwap.js';

import { createLoadingScreen } from './src/ui/loadingScreen.js';
import { createPerfHud } from './src/ui/perfHud.js';
import { createTopHint } from './src/ui/topHint.js';
import { createDebugGUI } from './src/ui/gui.js';

import { createAmbientSoundTracks } from './src/audio/ambientSound.js';

import { createCameraControls } from './src/setup/cameraControls.js';
import { createPhaseMachine, uProgress } from './src/scene/phaseMachine.js';
import { createJourney } from './src/scene/journey.js';
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
const { loadSkybox, loadCustomSkybox, setVoidColor, skybox } = buildSkybox(scene);

// ─── Environment map ─────────────────────────────────────────────────────────
// Renders the current background once into a pre-blurred map (PMREM), so
// surfaces can reflect it: sharp on glossy parts, blurry on rough ones. Rebuilt
// whenever the background changes. 
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new THREE.Mesh(skybox.geometry, skybox.material); // shares the skybox's textures
envScene.add(envSky);
let envTarget = null;
function refreshEnvironment() {
    envSky.visible = skybox.visible;
    envScene.background = skybox.visible ? null : scene.background; // the flat colour, if chosen
    const next = pmremGenerator.fromScene(envScene, 0, 0.1, 2000); // far enough to reach the 1000-unit skybox
    envTarget?.dispose();
    envTarget = next;
    scene.environment = envTarget.texture;
    warmUpShadersWhenReady(); // the shaders depend on whether there is an environment map
}
const { updateStars } = buildStars(scene);
buildRoom(scene);

// ─── Lighting ────────────────────────────────────────────────────────────────
const { updateLighting, setSpacePreset } = setupLighting(scene);

// Changes the background and its matching lighting together (GUI "Skybox"),
// so the two never get out of sync.
function selectBackground(name) {
    const preset = LIGHTING_PRESETS[name] ?? LIGHTING_PRESETS.space_blue;
    setSpacePreset(preset); // apply immediately; textures load asynchronously
    // When the faces have loaded: the fill light takes the background's measured
    // colour (hue only; the preset keeps the intensity), and the environment map
    // is rebuilt from the new background.
    loadSkybox(name, (skyColor) => {
        setSpacePreset({ ...preset, ambientColor: skyColor });
        refreshEnvironment();
    });
}
selectBackground(SKYBOX_OPTIONS[0]);

// Changes the flat background colour, and rebuilds the environment map from it.
function selectVoidColor(hex) {
    const preset = LIGHTING_PRESETS[SKYBOX_NONE];
    setVoidColor(hex, (hue) => {
        setSpacePreset({ ...preset, ambientColor: hue });
        refreshEnvironment();
    });
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
        (skyColor) => { setSpacePreset({ ...base, ambientColor: skyColor }); refreshEnvironment(); },
        (report) => customSkyboxReport?.(report),
    );
    if (result === true) { setSpacePreset(base); return true; }
    return result; // { missing, unsupported } — the GUI names them in its error
}

// ─── Camera controls ─────────────────────────────────────────────────────────
const cameraControls = createCameraControls(camera, renderer.domElement);

// The GUI keeps one debug folder per still-life object: added when an object loads,
// removed when it's swapped for another model (stone choice, return from space).
// Each newly loaded model also gets its shaders compiled in advance (see the
// shader warm-up below).
const objectFolderEvents = {
    onObjectReady: (label, entry, scaleFactor) => {
        gui.addObjectFolder(label, entry, scaleFactor);
        precompileDissolveShaders(renderer, entry.mesh, camera, scene);
    },
    onObjectRemoved: (entry) => gui.removeObjectFolder(entry),
};

// ─── Ambient sound ───────────────────────────────────────────────────────────
// Café ambience in the room, fading out toward space; a space track (volume 0
// by default); and the dissolve sound. Audio starts on the first click or key.
const ambientSound = createAmbientSoundTracks();

// ─── Debug GUI ───────────────────────────────────────────────────────────────
const gui = createDebugGUI({
    onSkyboxChange: selectBackground,
    onCustomSkyboxFiles: selectCustomSkybox,
    onVoidColorChange: selectVoidColor,
    // Swaps the table. The objects stay and are just moved to the new surface height.
    onTableChange: (kind) => setTable(scene, kind),
    onCustomTableFile: (file) => setTable(scene, 'custom', { customUrl: URL.createObjectURL(file) }),
    onTableTextureFile: (file, type) => setTableTexture(file, type),
    onTableColorChange: (hex) => setTableColor(hex),
    onRoomTextureFile: (surface, slotLabel, file) => setRoomTexture(surface, slotLabel, file),
    onRoomTextureReset: (surface) => resetRoomTextures(surface),
    onStoneChange: (name) => setStone(scene, name, objectFolderEvents),
    onCustomStoneFile: (file) => setCustomStone(scene, URL.createObjectURL(file), objectFolderEvents),
    // The room, space and dissolve sounds: the Sound folder picks and loads them.
    soundTracks: ambientSound,
    // The dissolve sound starts by itself: it follows the dissolve every frame.
    onJourneyToggle: () => journey.toggle(),
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
    camera, cameraControls,
    tableState, stillLifeObjects,
    // The Dissolve button only works in space.
    onPhaseChange: (phase) => gui.setDissolveAvailable(phase === 'space'),
    // When everything has dissolved, swap in the objects that come back, so the
    // still life that returns isn't the one that left.
    onObjectsDissolved: () => applyReturnObjects(scene, objectFolderEvents),
});

// ─── The journey ─────────────────────────────────────────────────────────────
// Press P (or the GUI button) and the artwork plays by itself: into space, the
// dissolve, and back home (see scene/journey.js). The line of text at the top
// hides while it plays.
let topHint = null; // shown once the loading screen is gone
const journey = createJourney({
    phaseMachine, controls: cameraControls.controls,
    onChange: (playing) => {
        gui.setJourneyPlaying(playing);
        topHint?.setJourneyPlaying(playing);
    },
});

// ─── Loading screen + asset loading ──────────────────────────────────────────
// Once the "Unstil Life" text-dissolve loading screen is gone, scroll/orbit
// interaction unlocks.
// ─── Shader warm-up ──────────────────────────────────────────────────────────
// three.js compiles a shader the first time it draws something in a new state,
// and that frame freezes. The first dissolve needs new versions of nearly every
// shader (transparent surfaces, the glow), so it froze for a moment. Once
// everything has loaded, while the loading screen still covers the canvas, one
// hidden frame is drawn mid-dissolve so they're all compiled in advance. The
// models kept hidden for the return (objectSwap.js) are shown for that frame
// too, so their shaders, geometry and textures are ready when they're swapped in.
const ASSET_COUNT = LOADING_TOTAL + PRELOADED_MODEL_COUNT;
let assetsLoaded = 0;
let warmedUp = false;
let loadingScreenGone = false;
function warmUpShadersWhenReady() {
    // Needs every model and the environment map; pointless once the scene shows.
    if (warmedUp || loadingScreenGone || assetsLoaded < ASSET_COUNT || !scene.environment) return;
    warmedUp = true;
    const hidden = hiddenModels();
    const models = [tableState, ...stillLifeObjects, ...hidden];
    const saved = [uProgress.value, ...models.map((m) => m.uProgress.value)];
    uProgress.value = 0.5;
    for (const m of models) m.uProgress.value = 0.5;
    for (const m of hidden) m.mesh.visible = true;
    updateDissolveTransparency();
    particleBloom.render(); // the scene, the particles and their glow
    for (const m of hidden) m.mesh.visible = false;
    uProgress.value = saved[0];
    models.forEach((m, i) => { m.uProgress.value = saved[i + 1]; });
    updateDissolveTransparency();
    // The frame above compiled the transparent versions; this compiles the opaque
    // ones too, including the hidden models' (they're opaque again back home).
    precompileDissolveShaders(renderer, scene, camera, scene);
}
function onAssetDone() {
    loadingScreen.markAssetLoaded();
    assetsLoaded++;
    warmUpShadersWhenReady();
}

const loadingScreen = createLoadingScreen(ASSET_COUNT, () => {
    loadingScreenGone = true;
    gui.gui.show();
    // "press P to begin the journey (auto play)" (or the sound note, see ui/topHint.js).
    topHint = createTopHint(ambientSound.onStarted);
    journey.enable();
    cameraControls.controls.enabled = true;
    phaseMachine.enableInteraction();
});
// Frame-time / GPU readout, bottom-left. Delete this line and the .update()
// call in the loop to remove it.
const perfHud = createPerfHud(renderer);

loadScene(scene, {
    onAssetLoaded: onAssetDone,
    onAssetFailed: onAssetDone, // still advance so the loading screen doesn't hang
    onObjectReady: objectFolderEvents.onObjectReady,
    // Then the models that come back from space, kept hidden until then.
    onTableReady: (surfaceY) => preloadReturnObjects(scene, surfaceY, {
        onAssetLoaded: onAssetDone, onAssetFailed: onAssetDone,
    }),
});

// ─── Animate ─────────────────────────────────────────────────────────────────
let lastT = 0;
function animate() {
    requestAnimationFrame(animate);
    const t  = clock.getElapsedTime();
    const dt = t - lastT;
    lastT = t;

    const { p, phase } = phaseMachine.update(t);
    journey.update(dt, phase, p);

    cameraControls.updateZoom(uProgress.value, { roomReturnBlocked: phase === 'dissolving' });
    updateLighting(p);
    updateSkyboxFlow(t);
    updateStars(dt);
    ambientSound.update(p, t, phaseMachine.getDissolvePlayback());
    updateFloating({ t, p, stillLifeObjects, tableState });
    updateDissolveTransparency(); // keep materials opaque unless mid-dissolve
    cameraControls.updateAutoZoomOut(p);

    gui.updateCameraDebug(camera.position);

    adaptiveQuality.update(dt);
    perfHud.update();
    cameraControls.controls.update();
    // Two render paths:
    //  - shiny particles on AND particles on screen: the straight render, plus
    //    a particles-only pass for the glow map and an additive overlay of it.
    //  - otherwise: one straight render.
    // Particles only exist while the table and objects are part-way through
    // dissolving (progress between 0 and 1). At 0 (intact) or 1 (gone) there is
    // nothing to glow, so the glow passes are skipped; the image is identical.
    if (uParticleShiny.value > 0.5 && particlesOnScreen()) particleBloom.render();
    else renderer.render(scene, camera);
}

function particlesOnScreen() {
    const midDissolve = (u) => u.value > 0.001 && u.value < 0.999;
    return midDissolve(tableState.uProgress) || stillLifeObjects.some((o) => midDissolve(o.uProgress));
}
animate();
