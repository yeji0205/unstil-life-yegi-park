import * as THREE from 'three';

// Ceiling on the device-pixel-ratio the scene renders at. This scene is
// fill-bound (full-screen background, six textured room planes, an additive
// light cone), so cost scales with the NUMBER of pixels: dpr 1.5 shades 2.25×
// as many as 1.0. 1.25 is a reasonable ceiling even on fast hardware; the
// adaptive controller below scales DOWN from here when a machine can't keep up.
const PIXEL_RATIO_CAP = 1.25;

// Live multiplier on that ceiling. The GUI slider sets the ceiling the viewer
// would LIKE; adaptive quality lowers the actual value when frames are slow.
export const renderScale = { value: 1.0 };

export function setRenderScale(renderer, value) {
    renderScale.value = value;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP) * value);
}

// ─── Adaptive quality ─────────────────────────────────────────────────────────
// The piece has to run on hardware we'll never see — a professor's laptop, a
// classmate's phone-tethered browser — where any fixed quality setting is wrong
// for someone. So instead of choosing one, it measures its own frame time and
// scales the render resolution to fit, the same trick console games use.
//
// Resolution is the right dial for this because it's the one with a smooth,
// continuous cost curve: everything else (shadows, lights, textures) is a step
// change that would be visible as a jolt.
//
// Deliberately sluggish: it samples over a whole second and moves in small
// steps, because a controller that reacted quickly would visibly pump the
// sharpness up and down while the scene animates. Better to settle slowly.
const ADAPT = {
    sampleMs:  1000,  // averaging window
    slowMs:    30,    // above this (≈33 fps) → give up resolution
    fastMs:    17,    // below this (≈59 fps) → we can afford more
    step:      0.08,  // per adjustment
    min:       0.55,  // never go below this fraction of the ceiling
};

export function createAdaptiveQuality(renderer) {
    let elapsed = 0, frames = 0, enabled = true;
    let ceiling = 1.0; // what the GUI slider asks for

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
        // The GUI slider raises/lowers the ceiling rather than fighting the
        // controller: ask for more and it may be granted if the frame rate allows.
        setCeiling(v) {
            ceiling = v;
            if (renderScale.value > v) setRenderScale(renderer, v);
        },
        setEnabled(v) { enabled = v; },
    };
}

export function createRenderer() {
    // Anti-aliasing back ON. It targets exactly one thing — the stair-stepping
    // along object outlines — and for that it is much better value than raising
    // the resolution: MSAA takes extra samples only at edge pixels, whereas a
    // higher pixel ratio pays for every pixel on screen. Cost here is mostly
    // memory bandwidth, which is the scarce resource on integrated graphics, so
    // it isn't free, but it should be well under what dpr 1.5 was costing.
    //
    // `antialias` can only be chosen when the WebGL context is created, so it
    // can't be a live GUI toggle. Add ?aa=0 to the URL to compare with it off.
    const antialias = new URLSearchParams(location.search).get('aa') !== '0';

    // powerPreference: ask for the DISCRETE GPU on machines that have two.
    // A 15" MacBook Pro of this era carries both an integrated Intel chip and a
    // discrete Radeon; both drive the same display, so macOS switches the whole
    // system between them rather than splitting work. It defaults to the Intel
    // for battery life, and Chrome deliberately requests the low-power GPU for
    // the same reason — which is why this scene was running on the weaker chip
    // with the Radeon idle. This hint asks for the other one.
    //
    // It IS only a hint: the browser may ignore it on battery, and macOS's
    // "Automatic graphics switching" setting can override it. Check which one
    // actually got used on the last line of the perf HUD.
    //
    // Escape hatch: ?gpu=low asks for the integrated chip instead. The discrete
    // GPU runs hotter and draws considerably more power, which on an older
    // machine with a tired battery is a real cost — use this when working
    // unplugged and let the adaptive quality above absorb the difference.
    const lowPower = new URLSearchParams(location.search).get('gpu') === 'low';
    const renderer = new THREE.WebGLRenderer({
        antialias,
        powerPreference: lowPower ? 'low-power' : 'high-performance',
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    // PCFSoft, not plain PCF. This was the other way round while the scene was
    // stuck on integrated graphics, where the extra texture samples per shaded
    // pixel weren't affordable. With the discrete GPU in play they are, and the
    // wider filter is what takes the remaining hard stair-steps off a shadow
    // edge once the map resolution has done the heavy lifting (see
    // setShadowQuality in lighting.js). Add ?shadows=hard to compare.
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
