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

const REVEAL_DURATION = 5.0; // seconds the cross-dissolve takes once the viewer triggers it
const MAX_DT = 0.1; // clamp any single frame's contribution to the reveal timer

// A single stalled/throttled frame (backgrounded tab, GPU stall, breakpoint)
// can report a huge dt. Without a cap, that one frame would jump the reveal
// straight to "complete" instead of progressing smoothly — this forces at
// least REVEAL_DURATION / MAX_DT frames no matter how choppy any one frame is.

const uPaintingProgress = { value: 0.0 };

function injectPaintingMerge(material, progressUniform, sceneTexture, resolutionUniform, aspectUniform, paintAspectUniform) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uProgress    = progressUniform;
        shader.uniforms.uSceneTex    = { value: sceneTexture };
        shader.uniforms.uResolution  = resolutionUniform;
        shader.uniforms.uAspect      = aspectUniform;
        shader.uniforms.uPaintAspect = paintAspectUniform;

        shader.fragmentShader = `${NOISE_GLSL}
            uniform float     uProgress;
            uniform sampler2D uSceneTex;
            uniform vec2      uResolution;
            uniform float     uAspect;       // plane/screen aspect (w/h)
            uniform float     uPaintAspect;  // painting image aspect (w/h)
            varying vec2      vFadeUv;
            // Cover-fit the painting into the screen without distortion: keep its
            // aspect and crop the overflow, instead of stretching a 16:10 image to
            // fill a differently-shaped window.
            vec2 coverUv(vec2 uv){
                vec2 c = uv - 0.5;
                if (uAspect > uPaintAspect) c.y *= uPaintAspect / uAspect; // screen wider → crop top/bottom
                else                        c.x *= uAspect / uPaintAspect; // screen narrower → crop sides
                return c + 0.5;
            }
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
                vec3 paintColor = texture2D( map, coverUv(vFadeUv) ).rgb;

                // The actual rendered scene, captured this same frame into
                // uSceneTex by render() below (plane hidden for that pass) —
                // read at this fragment's own screen position.
                vec2 screenUv   = gl_FragCoord.xy / uResolution;
                vec3 sceneColor = texture2D( uSceneTex, screenUv ).rgb;

                // Smooth, fluid cross-dissolve: every pixel's colour melts from the
                // painting to the live scene. A low-frequency noise field staggers
                // WHEN each region crosses over (large soft flowing patches, not
                // dots), and a WIDE soft band makes each pixel's paint→scene blend
                // gradual — so it reads as colours dissolving into one another.
                float n         = snoise3(vec3(vFadeUv * vec2(uAspect, 1.0) * 2.5, 0.0)); // -1..1, big soft blobs
                float band      = 0.7;
                float halfRange = 1.0 + band;
                float threshold = mix(-halfRange, halfRange, uProgress);
                float paintAmt  = smoothstep(threshold, threshold + band, n); // 1 = painting, 0 = scene

                diffuseColor = vec4(mix(sceneColor, paintColor, paintAmt), 1.0);
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
    // No MSAA (samples) on this offscreen target: while the intro painting is
    // held on screen, render() draws the whole scene into this target AND to the
    // screen every frame, and multisampling that target roughly doubled the
    // offscreen pass cost — a real framerate hit for the whole time the viewer
    // sits on the intro. The cone looks marginally softer in the target during
    // the ~5 s cross-dissolve; not worth the cost.
    const sceneRenderTarget = new THREE.WebGLRenderTarget(
        renderer.domElement.width || 1,
        renderer.domElement.height || 1
    );
    const uResolution = { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) };
    const uAspect     = { value: initialAspect }; // plane/screen aspect — cover-fits the painting + shapes the noise field
    // Painting image aspect (w/h) — set once the texture loads. Defaults to the
    // screen aspect so there's no crop until the real value is known.
    const uPaintAspect = { value: initialAspect };

    let imageFailed = false;
    const texture = new THREE.TextureLoader().load(
        imageUrl,
        (tex) => { if (tex.image) uPaintAspect.value = tex.image.width / tex.image.height; },
        undefined,
        () => {
            imageFailed = true;
            console.warn(`Painting intro: couldn't load "${imageUrl}" — skipping straight to the interactive scene.`);
        }
    );

    // Opaque: the shader itself decides the final color (a full mix of paint
    // vs. real scene), so there's no blending or discard left for the GPU to
    // do — no more depthWrite/renderOrder interactions to worry about, unlike
    // the earlier alpha-based version.
    const material = new THREE.MeshBasicMaterial({ map: texture });
    injectPaintingMerge(material, uPaintingProgress, sceneRenderTarget.texture, uResolution, uAspect, uPaintAspect);

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    plane.position.set(0, 0, -distance);
    camera.add(plane);

    let elapsed    = 0;
    let dissolving = false;
    let armed      = false;
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

    // Shows the painting and WAITS — the dissolve is triggered by the viewer
    // (a GUI button, see beginDissolve), not on a timer, so they control when
    // the drawing disappears. `callback` fires once the painting has fully
    // dissolved (or immediately, if the image never loaded — the plane is
    // removed right away instead of sitting in front of the camera forever).
    function arm(callback) {
        onComplete = callback;
        if (imageFailed) { removePlane(); onComplete?.(); return; }
        armed = true;
    }

    // Triggered by the GUI button — begins the cross-dissolve. Returns false
    // if there's nothing to dissolve (no painting, or already under way / done),
    // so the caller can leave the button alone in that case.
    function beginDissolve() {
        if (!armed || dissolving || removed) return false;
        dissolving = true;
        elapsed = 0;
        return true;
    }

    // Called every frame regardless of phase.
    function update(dt) {
        // Keep the quad covering the full view even if the window is resized.
        plane.scale.x = camera.aspect / initialAspect;

        if (!dissolving) return;
        elapsed += Math.min(dt, MAX_DT);
        uPaintingProgress.value = Math.min(1, elapsed / REVEAL_DURATION);
        if (uPaintingProgress.value >= 1) {
            dissolving = false;
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

    return { arm, beginDissolve, update, render };
}
