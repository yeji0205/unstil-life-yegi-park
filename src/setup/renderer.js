import * as THREE from 'three';

// Renderer, camera and window resizing, plus adaptive quality.

// Maximum pixel ratio. The cost grows with the number of pixels (1.5 shades 2.25x
// as many as 1.0), so this is capped; adaptive quality lowers it further on slow machines.
const PIXEL_RATIO_CAP = 1.25;

// Current multiplier on that maximum, lowered by adaptive quality when frames are slow.
export const renderScale = { value: 1.0 };

export function setRenderScale(renderer, value) {
    renderScale.value = value;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP) * value);
}

// ─── Adaptive quality ─────────────────────────────────────────────────────────
// Measures the frame time and adjusts the render resolution to fit, so the piece
// runs on unknown hardware. Resolution changes smoothly; shadows or textures
// would jump. It averages over a second and moves in small steps, so the
// sharpness doesn't visibly pump.
const ADAPT = {
    sampleMs:  1000,  // averaging window
    slowMs:    30,    // above this (≈33 fps) → give up resolution
    fastMs:    17,    // below this (≈59 fps) → we can afford more
    step:      0.08,  // per adjustment
    min:       0.55,  // never go below this fraction of the ceiling
};

export function createAdaptiveQuality(renderer) {
    let elapsed = 0, frames = 0, enabled = true;
    let ceiling = 1.0; // highest scale allowed (setCeiling; currently never changed)

    return {
        // Called from the render loop with the frame's delta in seconds.
        update(dt) {
            if (!enabled) return;
            elapsed += dt * 1000;
            frames++;
            if (elapsed < ADAPT.sampleMs) return;

            const avg = elapsed / frames;
            elapsed = 0; frames = 0;

            let next = renderScale.value;
            if (avg > ADAPT.slowMs)      next -= ADAPT.step;
            else if (avg < ADAPT.fastMs) next += ADAPT.step;
            next = Math.min(ceiling, Math.max(ADAPT.min, next));

            if (Math.abs(next - renderScale.value) > 0.001) setRenderScale(renderer, next);
        },
        // Sets the highest scale the controller may reach. (Not called at the moment.)
        setCeiling(v) {
            ceiling = v;
            if (renderScale.value > v) setRenderScale(renderer, v);
        },
        setEnabled(v) { enabled = v; },
    };
}

export function createRenderer() {
    // Anti-aliasing smooths object outlines, much more cheaply than a higher pixel
    // ratio. It can only be set when the WebGL context is created, so it isn't a
    // GUI toggle: add ?aa=0 to the URL to turn it off.
    const antialias = new URLSearchParams(location.search).get('aa') !== '0';

    // Ask for the faster (discrete) GPU on laptops that have two; browsers pick
    // the low-power one by default. Only a hint: the browser or OS may ignore it.
    // The perf HUD shows which GPU was used. Add ?gpu=low to use the low-power
    // GPU instead, e.g. on battery.
    const lowPower = new URLSearchParams(location.search).get('gpu') === 'low';
    const renderer = new THREE.WebGLRenderer({
        antialias,
        powerPreference: lowPower ? 'low-power' : 'high-performance',
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // Soft shadow edges (PCFSoft). Add ?shadows=hard to compare with plain PCF.
    renderer.shadowMap.type = new URLSearchParams(location.search).get('shadows') === 'hard'
        ? THREE.PCFShadowMap
        : THREE.PCFSoftShadowMap;
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
