import * as THREE from 'three';

import { createRenderer, createCamera, setupResize } from './src/render/renderer.js';
import { setupLighting } from './src/render/lighting.js';
import { uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor } from './src/render/dissolve.js';
import { updateSkyboxFlow } from './src/render/skyboxFlow.js';

import { buildRoom } from './src/geometry/room.js';
import { buildSkybox, buildStars, SKYBOX_OPTIONS } from './src/geometry/environment.js';

import { loadScene, tableState, stageObjects, LOADING_TOTAL } from './src/persistence/glbLoader.js';

import { createLoadingScreen } from './src/ui/loadingScreen.js';
import { createDebugGUI } from './src/ui/gui.js';

import { createCameraControls } from './src/simulation/cameraControls.js';
import { createPhaseMachine } from './src/simulation/phaseMachine.js';
import { updateFloating } from './src/simulation/floating.js';

// ─── Renderer, scene, camera ─────────────────────────────────────────────────
const renderer = createRenderer();
const camera   = createCamera();
const scene    = new THREE.Scene();
setupResize(camera, renderer);

// ─── Geometry ────────────────────────────────────────────────────────────────
const { loadSkybox } = buildSkybox(scene);
loadSkybox(SKYBOX_OPTIONS[0]);
const { updateStars } = buildStars(scene);
buildRoom(scene);

// ─── Lighting ────────────────────────────────────────────────────────────────
const { ambientLight, directionalLight, updateLighting } = setupLighting(scene);

// ─── Camera controls ─────────────────────────────────────────────────────────
const cameraControls = createCameraControls(camera, renderer.domElement);

// ─── Debug GUI ───────────────────────────────────────────────────────────────
const gui = createDebugGUI({
    uProgress, uDissolveEdge, uNoiseFreq, uDissolveEdgeColor,
    ambientLight, directionalLight,
    skyboxOptions: SKYBOX_OPTIONS, defaultSkybox: SKYBOX_OPTIONS[0],
    onSkyboxChange: loadSkybox,
    onDissolveClick: () => phaseMachine.triggerDissolve(),
});

// ─── Phase state machine ─────────────────────────────────────────────────────
const clock = new THREE.Clock();
const phaseMachine = createPhaseMachine({
    scene, camera, cameraControls,
    tableState, stageObjects,
    dissolveController: gui.dissolveController,
    getTime: () => clock.getElapsedTime(),
});

// ─── Loading screen + asset loading ──────────────────────────────────────────
const loadingScreen = createLoadingScreen(LOADING_TOTAL, () => gui.gui.show());
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
    updateFloating({ t, p, stageObjects, tableState });
    cameraControls.updateAutoZoomOut(phase, p);

    gui.updateCameraDebug(camera.position);

    cameraControls.controls.update();
    renderer.render(scene, camera);
}
animate();
