import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

// ─── Painting intro ───────────────────────────────────────────────────────────
// Before the viewer can interact, they see a stylized painting (e.g. Van Gogh
// style) of the starting room. It merges into the real, already-rendered 3D
// scene on a timer — see injectPaintingMerge() below for how.
//
// Implementation: a single screen-aligned quad parented to the camera, sized
// to exactly fill its view frustum at a fixed distance, so it always covers
// the whole view regardless of camera position (during the intro the camera
// doesn't move anyway — scroll/orbit are still disabled at this point).
//
// The merge is a genuine per-pixel color blend, not just alpha-revealing
// whatever the GPU already drew underneath: render() below does two passes —
// first the real scene (plane hidden) into an offscreen render target, then
// the real scene again on-screen (plane visible), where the plane's own
// shader samples BOTH that offscreen "real" color and the painting texture
// at the same screen position and mixes them explicitly. That's what makes
// this "the drawing's pixel color merging into the actual scene's pixel
// color" rather than a discard/alpha trick.

const REVEAL_DURATION = 5.0; // seconds — how long the merge takes once started
const MAX_DT = 0.1; // clamp any single frame's contribution to the reveal timer

// A single stalled/throttled frame (backgrounded tab, GPU stall, breakpoint)
// can report a huge dt. Without a cap, that one frame would jump the reveal
// straight to "complete" instead of progressing smoothly — this forces at
// least REVEAL_DURATION / MAX_DT frames no matter how choppy any one frame is.

const uPaintingProgress = { value: 0.0 };

// Halftone-style dot grid: the painting is represented as a field of round
// dots, one per grid cell. Each dot shrinks away over time — staggered per
// cell via noise, so they don't all shrink in lockstep — revealing the real
// scene underneath through the gap, like ink dots soaking into canvas.
const DOT_GRID = 46; // dots across the shorter axis

function injectPaintingMerge(material, progressUniform, sceneTexture, resolutionUniform, aspectUniform) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uProgress   = progressUniform;
        shader.uniforms.uSceneTex   = { value: sceneTexture };
        shader.uniforms.uResolution = resolutionUniform;
        shader.uniforms.uAspect     = aspectUniform;

        shader.fragmentShader = `${NOISE_GLSL}
            uniform float     uProgress;
            uniform sampler2D uSceneTex;
            uniform vec2      uResolution;
            uniform float     uAspect;
            varying vec2      vFadeUv;
        ` + shader.fragmentShader;

        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>
            varying vec2 vFadeUv;`
        ).replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
            vFadeUv = uv;`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
                // Square grid cells regardless of the plane's aspect ratio —
                // without the *uAspect scale, cells would stretch into ellipses.
                vec2  grid   = vec2(vFadeUv.x * uAspect, vFadeUv.y) * float(${DOT_GRID});
                vec2  cellId = floor(grid);
                vec2  cellUv = fract(grid) - 0.5; // -0.5..0.5, 0 at the dot's center
                float dist   = length(cellUv);

                vec3  paintColor = texture2D( map, vFadeUv ).rgb;

                // The actual rendered scene, captured this same frame into
                // uSceneTex by render() below (plane hidden for that pass) —
                // read at this fragment's own screen position.
                vec2 screenUv   = gl_FragCoord.xy / uResolution;
                vec3 sceneColor = texture2D( uSceneTex, screenUv ).rgb;

                // Per-cell stagger so dots don't all shrink in lockstep — an
                // organic soak rather than a uniform wipe. halfRange keeps the
                // swept threshold far enough past snoise3's ±1 output range
                // that every dot is fully present at progress=0 and fully
                // gone at progress=1.
                float n         = snoise3(vec3(cellId * 0.15, 0.0));
                float band      = 0.8;
                float halfRange = 1.0 + band + 0.1;
                float threshold = mix(-halfRange, halfRange, uProgress);
                float dotAlive  = smoothstep(threshold, threshold + band, n); // 1 = still a dot, 0 = fully soaked in

                float maxRadius = 0.42; // < 0.5 so neighbouring dots never touch
                float dotRadius = maxRadius * dotAlive;
                float inDot     = 1.0 - smoothstep(dotRadius - 0.06, dotRadius, dist);

                diffuseColor = vec4(mix(sceneColor, paintColor, inDot), 1.0);
            #endif`
        );
    };
}

// scene.add(camera) is required — Object3D children (our plane) only render
// if the camera itself is part of the scene graph passed to renderer.render().
export function createPaintingIntro(renderer, scene, camera, imageUrl) {
    scene.add(camera);

    const initialAspect = camera.aspect;
    const distance = 1.0; // just past the near plane (0.1) — safe margin
    const fovRad   = camera.fov * Math.PI / 180;
    const height   = 2 * Math.tan(fovRad / 2) * distance;
    const width    = height * initialAspect;

    // Offscreen capture of the real scene, sized to the renderer's actual
    // drawing-buffer resolution (not CSS size) so it lines up pixel-for-pixel
    // with gl_FragCoord in the shader above.
    const sceneRenderTarget = new THREE.WebGLRenderTarget(
        renderer.domElement.width || 1,
        renderer.domElement.height || 1
    );
    const uResolution = { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) };
    const uAspect     = { value: initialAspect }; // plane's own aspect, for square (not stretched) dots

    let imageFailed = false;
    const texture = new THREE.TextureLoader().load(imageUrl, undefined, undefined, () => {
        imageFailed = true;
        console.warn(`Painting intro: couldn't load "${imageUrl}" — skipping straight to the interactive scene.`);
    });

    // Opaque: the shader itself decides the final color (a full mix of paint
    // vs. real scene), so there's no blending or discard left for the GPU to
    // do — no more depthWrite/renderOrder interactions to worry about, unlike
    // the earlier alpha-based version.
    const material = new THREE.MeshBasicMaterial({ map: texture });
    injectPaintingMerge(material, uPaintingProgress, sceneRenderTarget.texture, uResolution, uAspect);

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    plane.position.set(0, 0, -distance);
    camera.add(plane);

    let elapsed    = 0;
    let revealing  = false;
    let onComplete = null;
    let removed    = false;

    function removePlane() {
        if (removed) return;
        removed = true;
        camera.remove(plane);
        plane.geometry.dispose();
        material.dispose();
        texture.dispose();
        sceneRenderTarget.dispose();
    }

    // Starts the merge countdown; `callback` fires once fully merged (or
    // immediately, if the image never loaded — in which case the plane is
    // removed right away instead of sitting in front of the camera forever).
    function startReveal(callback) {
        if (imageFailed) { removePlane(); callback?.(); return; }
        revealing  = true;
        elapsed    = 0;
        onComplete = callback;
    }

    // Called every frame regardless of phase.
    function update(dt) {
        // Keep the quad covering the full view even if the window is resized.
        plane.scale.x = camera.aspect / initialAspect;

        if (!revealing) return;
        elapsed += Math.min(dt, MAX_DT);
        uPaintingProgress.value = Math.min(1, elapsed / REVEAL_DURATION);
        if (uPaintingProgress.value >= 1) {
            revealing = false;
            removePlane();
            onComplete?.();
        }
    }

    // Replaces the plain renderer.render(scene, camera) call while the intro
    // is active. Once the plane is gone this is just a passthrough — no
    // offscreen pass overhead once the merge has finished.
    function render(sceneToRender, cam) {
        if (removed) {
            renderer.render(sceneToRender, cam);
            return;
        }

        const w = renderer.domElement.width, h = renderer.domElement.height;
        if (sceneRenderTarget.width !== w || sceneRenderTarget.height !== h) {
            sceneRenderTarget.setSize(w, h);
            uResolution.value.set(w, h);
        }

        plane.visible = false;
        renderer.setRenderTarget(sceneRenderTarget);
        renderer.render(sceneToRender, cam);
        renderer.setRenderTarget(null);

        plane.visible = true;
        renderer.render(sceneToRender, cam);
    }

    return { startReveal, update, render };
}
