import * as THREE from 'three';

// Cap the device-pixel-ratio the scene renders at. This scene is fill-bound
// (full-screen skybox shader, room walls, the additive light cone's overdraw,
// per-frame soft shadows, MSAA), so cost scales with the NUMBER of pixels
// shaded. 1.5 is the original crisp default; disabling the intro painting
// (see SHOW_INTRO_PAINTING in main.js) removed the big per-frame cost, so 1.5
// should be fine again. If a weaker machine still struggles, lower this toward
// 1.0 — on a 2× (retina) display 1.0 shades ~56% fewer pixels than 1.5.
const PIXEL_RATIO_CAP = 1.5;

export function createRenderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);
    return renderer;
}

export function createCamera() {
    const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(-0.2, -0.29, 5.52);
    return camera;
}

export function setupResize(camera, renderer) {
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    });
}
