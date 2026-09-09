import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { PARTICLE_BLOOM_LAYER } from './dissolve.js';

// ─── Selective bloom on the dissolve particles ───────────────────────────────
// This is the mechanism the Codrops dissolve demo uses for its shiny particles,
// and it is the only way to get that look: the glow has to spread across
// NEIGHBOURING pixels, which nothing done inside a point sprite can do. An
// earlier attempt drew a core + halo + glint cross into the sprite itself and
// the honest result was just fatter dots — a bigger sprite is a bigger dot, not
// a brighter one.
//
// The demo's version (src/main.ts in JatinChopra/emissive-dissolve-effect) is
// two EffectComposers rendering the scene twice per frame:
//
//   composer1: background forced BLACK -> RenderPass -> UnrealBloomPass -> offscreen
//   composer2: real background         -> RenderPass -> composite -> OutputPass -> screen
//
// where the composite is literally `base + bloom * strength`, with strength 8.
// Forcing the background black in the first pass is what makes the bloom
// "selective": with nothing bright behind them, only the additive particles
// clear the bloom threshold, so the environment never blooms.
//
// ─── Why the base scene does NOT go through a composer here ──────────────────
// Following the demo exactly meant routing the on-screen render through an
// EffectComposer too, and that visibly WASHED OUT the whole scene — measured at
// p=0 with no particles on screen at all: R +7, G +14, B +17 out of 255, the
// darkest channel lifted most.
//
// The cause is blending space. Rendering straight to the canvas with
// `outputColorSpace = SRGBColorSpace`, each material sRGB-encodes in its own
// shader, so this scene's several ADDITIVE effects — the volumetric light cone,
// the star field, the particles — blend on top of sRGB-encoded values. An
// EffectComposer renders into a linear half-float target instead, so those same
// additive effects blend in linear space and then get encoded once at the end.
// Linear addition followed by an sRGB encode lifts dark pixels far more, because
// the sRGB curve is steep near black. Hence a washed-out, slightly blue-grey
// image. main.js already records the same trap for the painting intro: routing
// the additive light cone through an offscreen buffer "made the volumetric
// lighting look off".
//
// So the base frame is rendered by plain renderer.render(), byte for byte as in
// flat mode, and only the GLOW is added over it as an additive full-screen quad.
// That is strictly better here than the demo's structure:
//   - flat vs. shiny now differ ONLY where there is glow, which is what an A/B
//     toggle is for;
//   - the canvas keeps its own MSAA (a composer would have discarded it, since
//     `antialias: true` does nothing once the scene renders into a texture);
//   - it is much cheaper — see COST below.
//
// ─── Other differences from the demo, and why ────────────────────────────────
// 1. The demo swaps `scene.background` between a black Color and its cube
//    texture. Our sky is a 1000-unit BoxGeometry MESH (see environment.js), not
//    scene.background, so swapping the background alone would leave the nebula
//    in the bloom pass. The glow pass isolates the particles by LAYER instead:
//    the Points objects live on PARTICLE_BLOOM_LAYER and the camera is
//    restricted to it, so the room, table, objects, skybox mesh and star field
//    are all absent from it. The background is still forced black on top of
//    that, because `scene.background` is not layer-filtered.
//    Layer isolation is also safer than the demo's approach for us: its mesh is
//    dark grey (0x636363) specifically so it stays under the bloom threshold,
//    whereas our room walls are warm and brightly lit and WOULD bloom — the
//    whole room would glow the moment shiny mode was switched on.
//    The trade: glow is not occluded, so a particle behind a solid object still
//    adds a soft haze over it. Barely visible in practice — by the time
//    particles exist, the object emitting them is half gone.
// 2. The demo sets `renderer.toneMapping = CineonToneMapping`, which softens the
//    roll-off into white everywhere. Not adopted: it would change the look of
//    the ENTIRE scene, so flat vs. shiny would no longer isolate the particles,
//    and switching it live recompiles every material in the scene (toneMapping
//    is a shader define), which stalls on the toggle. Highlights therefore clip
//    a little harder here than in the demo.
//
// COST: one extra scene render, but a nearly empty one — the camera is
// restricted to the particle layer, so it draws a few thousand points and
// nothing else — plus the bloom mip chain and one additive full-screen blit.
// Still only used while shiny mode is on; flat mode never touches this file.

// Tuned from the demo's own numbers (strength 0.5, radius 0.25, threshold 0.2,
// composite 8.0), which were too hot here for one reason: the demo emits a few
// hundred LARGE wisps, while this scene emits 200–2000 fine specks per object.
// Many small bright points bloom into a milky full-screen haze at composite 8,
// and UnrealBloom's low-resolution mips turn a tiny bright dot into a visibly
// SQUARE halo. Lower composite and a wider radius fix both: less total energy
// added, spread more softly, so each speck keeps a hot core with a clean glow
// around it and the background stays black.
//
// All four are live in the GUI ("Particle Bloom") because the right values also
// depend on what is behind the particles — the glow needs more composite
// strength to read against a bright nebula than against the flat black void.
export const bloomSettings = {
    strength:  0.6,   // UnrealBloomPass strength
    radius:    0.20,  // UnrealBloomPass radius — how far the glow spreads
    threshold: 0.15,  // luminance below which nothing blooms
    composite: 3.5,   // multiplier on the glow when it is added over the scene
};

const BLACK = new THREE.Color(0x000000);

export function createParticleBloom(renderer, scene, camera) {
    const size = renderer.getSize(new THREE.Vector2());

    // ─── The glow pass: particles only, on black → a blurred glow map ────────
    const glowComposer = new EffectComposer(renderer);
    const renderPass = new RenderPass(scene, camera);
    const unrealBloomPass = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        bloomSettings.strength,
        bloomSettings.radius,
        bloomSettings.threshold,
    );
    glowComposer.addPass(renderPass);
    glowComposer.addPass(unrealBloomPass);
    glowComposer.renderToScreen = false; // its output is a texture, not the frame

    // ─── The overlay: that glow map added onto the finished frame ────────────
    // A full-screen quad with additive blending and no depth interaction, drawn
    // after the normal render with autoClear off. This is the whole compositing
    // step — it replaces the demo's second composer, its ShaderPass and its
    // OutputPass, none of which can be used without also pulling the base scene
    // into a linear buffer (see the note above).
    const overlayScene  = new THREE.Scene();
    const overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const overlayMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uGlow:     { value: null }, // set below, once the pass has built its targets
            uStrength: { value: bloomSettings.composite },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main(){
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform sampler2D uGlow;
            uniform float     uStrength;
            varying vec2      vUv;
            void main(){
                vec3 glow = texture2D(uGlow, vUv).rgb * uStrength;
                // The glow map is linear; the canvas holds sRGB-encoded pixels.
                // Encode before adding, or the faint outer glow lands far dimmer
                // than intended — the sRGB curve is steep near black, which is
                // exactly where most of a bloom's energy sits.
                glow = pow(max(glow, 0.0), vec3(1.0 / 2.2));
                gl_FragColor = vec4(glow, 1.0);
            }
        `,
        blending:    THREE.AdditiveBlending,
        depthTest:   false,
        depthWrite:  false,
        transparent: true,
    });
    overlayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMaterial));

    // BLOOM-ONLY texture. UnrealBloomPass finishes by blending its blur
    // additively over whatever was in the read buffer, so the composer's own
    // output is "particles + glow" — adding that over a frame that already
    // contains the particles would draw them twice, at full brightness, without
    // depth. renderTargetsHorizontal[0] is where the pass composites its five
    // blurred mips just BEFORE that final blend, so it is the glow alone (at
    // half resolution, which is plenty for a soft glow and cheaper to sample).
    // It is an internal of the addon rather than public API; the fallback keeps
    // this working, slightly hotter, if a future three.js renames it.
    overlayMaterial.uniforms.uGlow.value =
        unrealBloomPass.renderTargetsHorizontal?.[0]?.texture
        ?? glowComposer.renderTarget2.texture;

    // The adaptive-quality controller in renderer.js changes the renderer's
    // pixel ratio at runtime, and a composer picks that up only when told to.
    // Left unsynced, the glow map keeps whatever resolution it was built at and
    // the overlay samples it at the wrong scale. Starts at -1 so the first
    // frame always syncs.
    let lastPixelRatio = -1;

    function syncSize() {
        const current = renderer.getSize(new THREE.Vector2());
        const ratio   = renderer.getPixelRatio();
        if (ratio !== lastPixelRatio) {
            lastPixelRatio = ratio;
            glowComposer.setPixelRatio(ratio);
        }
        // setSize takes CSS pixels; the composer scales by its own pixel ratio
        // and forwards the result to every pass it owns, the bloom pass
        // included. Calling unrealBloomPass.setSize() here as well (as the demo
        // does) would overwrite that with the unscaled size and halve the
        // glow's resolution. Cheap to repeat: a render target whose size is
        // unchanged returns immediately.
        glowComposer.setSize(current.x, current.y);
    }

    return {
        render() {
            unrealBloomPass.strength  = bloomSettings.strength;
            unrealBloomPass.radius    = bloomSettings.radius;
            unrealBloomPass.threshold = bloomSettings.threshold;
            overlayMaterial.uniforms.uStrength.value = bloomSettings.composite;

            syncSize();

            // 1 — glow map: only the particle layer, on black, so nothing else
            //     in the scene can pass the bloom threshold.
            const previousBackground = scene.background;
            scene.background = BLACK;
            camera.layers.set(PARTICLE_BLOOM_LAYER);
            glowComposer.render();

            // 2 — the real frame, rendered exactly as flat mode renders it.
            scene.background = previousBackground;
            camera.layers.enableAll();
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);

            // 3 — add the glow on top, without clearing what was just drawn.
            renderer.autoClear = false;
            renderer.render(overlayScene, overlayCamera);
            renderer.autoClear = true;
        },
        setSize: syncSize,
    };
}
