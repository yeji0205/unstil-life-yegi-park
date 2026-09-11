import * as THREE from 'three';
import { PARTICLE_BLOOM_LAYER } from './dissolve.js';

// ─── Selective bloom on the dissolve particles ───────────────────────────────
// This is the mechanism the Codrops dissolve demo uses for its shiny particles,
// and it is the only way to get that look: the glow has to spread across
// NEIGHBOURING pixels, which nothing done inside a point sprite can do. An
// earlier attempt drew a core + halo + glint cross into the sprite itself and
// the honest result was just fatter dots — a bigger sprite is a bigger dot, not
// a brighter one.
//
// Three steps per frame, all of them here:
//   1. render ONLY the particles, on black, into a half-resolution target;
//   2. threshold that and blur it with a separable gaussian → the glow map;
//   3. draw the real frame, then add the glow map over it as a full-screen quad.
//
// ─── Why a plain gaussian and not UnrealBloomPass ────────────────────────────
// This used to be an EffectComposer running UnrealBloomPass, which is the
// obvious choice and the one the demo makes. It put a visible SQUARE box around
// every speck.
//
// UnrealBloom blurs a five-level MIP PYRAMID and adds the levels together. The
// coarsest levels are 1/16 and 1/32 of the frame, so a particle — a few pixels
// across at most — lands inside a single texel there. Upsampling one isolated
// texel by bilinear filtering gives a pyramid whose SUPPORT IS A SQUARE: it
// falls to zero along texel-grid lines, not along a circle. That square is
// larger and softer than the speck that cast it, so every particle ended up
// sitting in a faint box.
//
// That is a property of the pyramid, not of a setting, which is why tuning it
// never worked — lowering strength/radius only made the boxes fainter. The fix
// is to stop building a pyramid: one gaussian at a single resolution has no
// texel grid to leave behind, so a dot blurs to a round dot. It is also cheaper
// than the pass it replaces (two blur passes instead of ten plus a composite).
//
// The trade is reach: a pyramid can spread light across a quarter of the screen
// for almost nothing, while a single-resolution gaussian is limited by its tap
// count (BLUR_TAPS below). That ceiling is far wider than this scene wants —
// these are fine specks meant to have a tight, clean halo, not a cinematic haze.
//
// ─── Why the base scene does NOT go through a composer ───────────────────────
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
// flat mode, and only the GLOW is added over it. That is strictly better here:
//   - flat vs. shiny now differ ONLY where there is glow, which is what an A/B
//     toggle is for;
//   - the canvas keeps its own MSAA (a composer would have discarded it, since
//     `antialias: true` does nothing once the scene renders into a texture).
//
// ─── How the particles are isolated ──────────────────────────────────────────
// The demo swaps `scene.background` between a black Color and its cube texture.
// Our sky is a 1000-unit BoxGeometry MESH (see environment.js), not
// scene.background, so swapping the background alone would leave the nebula in
// the glow pass. The glow pass isolates the particles by LAYER instead: the
// Points objects live on PARTICLE_BLOOM_LAYER and the camera is restricted to
// it, so the room, table, objects, skybox mesh and star field are all absent.
// The background is still forced black on top of that, because `scene.background`
// is not layer-filtered.
// Layer isolation is also safer than the demo's approach for us: its mesh is
// dark grey (0x636363) specifically so it stays under the bloom threshold,
// whereas our room walls are warm and brightly lit and WOULD bloom — the whole
// room would glow the moment shiny mode was switched on.
// The trade: glow is not occluded, so a particle behind a solid object still
// adds a soft haze over it. Barely visible in practice — by the time particles
// exist, the object emitting them is half gone.

// All four are live in the GUI ("Particle Bloom") because the right values also
// depend on what is behind the particles — the glow needs more composite
// strength to read against a bright nebula than against the flat black void.
export const bloomSettings = {
    strength:  0.6,   // multiplier on the blurred glow
    radius:    0.20,  // how far the glow bleeds outward (drives the blur width)
    threshold: 0.15,  // luminance below which nothing blooms
    // Higher than it looks, because the overlay adds the glow linearly rather
    // than sRGB-encoding it first (see the overlay shader). The encode used to
    // inflate this number's apparent effect by lifting every dim value; without
    // it the core needs the multiplier the core actually wants.
    composite: 2.5,   // multiplier on the glow when it is added over the scene
};

const BLACK = new THREE.Color(0x000000);

// The glow map is rendered at half the drawing buffer's size. A glow is
// low-frequency by definition, so half resolution is indistinguishable and
// quarters the cost of both blur passes.
const RESOLUTION_SCALE = 0.5;

// Taps per direction, so the kernel is 2*BLUR_TAPS+1 wide. Samples sit one
// source texel apart: spacing them further to reach a wider blur with the same
// tap count is what turns an isolated bright speck into a row of ghost copies,
// since each tap would land on its own patch of an otherwise empty buffer.
// The width is set by SIGMA_MAX instead, kept under BLUR_TAPS/2 so the kernel
// never truncates somewhere the gaussian is still carrying real weight.
const BLUR_TAPS = 8;
const SIGMA_MIN = 0.6;
const SIGMA_MAX = 3.0;

// Rec.709 luma, matching what UnrealBloomPass used, so the threshold slider
// still means the same thing it did.
const BLUR_SHADER = /* glsl */`
    uniform sampler2D tSrc;
    uniform vec2      uTexel;     // 1 / source size, in texels
    uniform vec2      uDirection; // (1,0) horizontal, (0,1) vertical
    uniform float     uSigma;     // gaussian width, in source texels
    uniform float     uThreshold; // negative disables the high-pass
    uniform float     uStrength;
    varying vec2      vUv;

    void main(){
        vec3  sum   = vec3(0.0);
        float total = 0.0;
        for (int i = -${BLUR_TAPS}; i <= ${BLUR_TAPS}; i++) {
            float x = float(i);
            float w = exp(-0.5 * x * x / (uSigma * uSigma));
            vec3  c = texture2D(tSrc, vUv + uDirection * uTexel * x).rgb;
            if (uThreshold >= 0.0) {
                // Same soft high-pass UnrealBloomPass applied: everything under
                // the threshold is dropped, with a narrow ramp so a particle
                // fading past the cutoff doesn't pop.
                float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
                c *= smoothstep(uThreshold, uThreshold + 0.01, luma);
            }
            sum   += c * w;
            total += w;
        }
        gl_FragColor = vec4(sum / total * uStrength, 1.0);
    }
`;

export function createParticleBloom(renderer, scene, camera) {
    // Half float so the hot particle cores can stay above 1.0 through both blur
    // passes instead of clipping before the glow is even built. No depth buffer:
    // the only thing drawn into it is the particle layer, which doesn't depth
    // write anyway.
    const targetOptions = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    const rtParticles = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    const rtBlur      = new THREE.WebGLRenderTarget(1, 1, targetOptions);

    // One full-screen quad, reused for both blur passes and the final overlay by
    // swapping its material. The vertex shader writes clip space directly, so
    // the camera it is rendered with is irrelevant.
    const quadScene  = new THREE.Scene();
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad       = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    quad.frustumCulled = false;
    quadScene.add(quad);

    const QUAD_VERTEX_SHADER = /* glsl */`
        varying vec2 vUv;
        void main(){
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `;

    const blurMaterial = new THREE.ShaderMaterial({
        uniforms: {
            tSrc:       { value: null },
            uTexel:     { value: new THREE.Vector2() },
            uDirection: { value: new THREE.Vector2(1, 0) },
            uSigma:     { value: SIGMA_MIN },
            uThreshold: { value: bloomSettings.threshold },
            uStrength:  { value: 1.0 },
        },
        vertexShader:   QUAD_VERTEX_SHADER,
        fragmentShader: BLUR_SHADER,
        depthTest:  false,
        depthWrite: false,
    });

    // The overlay: the glow map added onto the finished frame. Additive, no
    // depth interaction, drawn after the normal render with autoClear off.
    const overlayMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uGlow:     { value: rtParticles.texture },
            uStrength: { value: bloomSettings.composite },
        },
        vertexShader:   QUAD_VERTEX_SHADER,
        fragmentShader: /* glsl */`
            uniform sampler2D uGlow;
            uniform float     uStrength;
            varying vec2      vUv;
            void main(){
                // Added straight, with NO sRGB encode on the way in.
                //
                // Encoding first (pow(glow, 1/2.2)) is the tempting move, since
                // the canvas holds sRGB-encoded pixels and the glow map is
                // linear. It is also what made every speck look fluffy rather
                // than sharp: that curve is steepest near black, so it lifted the
                // faint OUTER tail of each halo about tenfold (0.0175 -> 0.156)
                // while barely touching the core, and a gaussian raised to the
                // 1/2.2 power is ~1.5x wider besides. Each particle ended up
                // wearing a broad dim skirt, and overlapping skirts read as haze.
                //
                // Adding linearly keeps the falloff the gaussian actually has:
                // a hot core that stays hot, and a tail that stays invisible.
                // Correcting this properly would mean decoding the framebuffer,
                // adding, and re-encoding — which additive blending cannot do —
                // and the error only ever brightens, so the honest fix is to
                // carry it in the composite multiplier instead.
                gl_FragColor = vec4(texture2D(uGlow, vUv).rgb * uStrength, 1.0);
            }
        `,
        blending:    THREE.AdditiveBlending,
        depthTest:   false,
        depthWrite:  false,
        transparent: true,
    });

    // The adaptive-quality controller in renderer.js changes the renderer's
    // pixel ratio at runtime, so the glow map is sized from the DRAWING BUFFER
    // (which already includes that ratio) rather than from CSS pixels.
    let sizeX = 0, sizeY = 0;

    function syncSize() {
        const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
        const x = Math.max(1, Math.floor(buffer.x * RESOLUTION_SCALE));
        const y = Math.max(1, Math.floor(buffer.y * RESOLUTION_SCALE));
        if (x === sizeX && y === sizeY) return;
        sizeX = x; sizeY = y;
        rtParticles.setSize(x, y);
        rtBlur.setSize(x, y);
        blurMaterial.uniforms.uTexel.value.set(1 / x, 1 / y);
    }

    function renderQuad(material, target) {
        quad.material = material;
        renderer.setRenderTarget(target);
        renderer.render(quadScene, quadCamera);
    }

    return {
        render() {
            syncSize();

            // 1 — the glow source: only the particle layer, on black, so nothing
            //     else in the scene can pass the threshold.
            const previousBackground = scene.background;
            const previousLayers     = camera.layers.mask;
            scene.background = BLACK;
            camera.layers.set(PARTICLE_BLOOM_LAYER);
            renderer.setRenderTarget(rtParticles);
            renderer.render(scene, camera);
            scene.background = previousBackground;
            // Restore exactly what the camera had, rather than enableAll(): that
            // turned on every layer as a side effect and masked the fact that
            // main.js was never enabling the particle layer itself.
            camera.layers.mask = previousLayers;

            const sigma = THREE.MathUtils.lerp(SIGMA_MIN, SIGMA_MAX, bloomSettings.radius);
            blurMaterial.uniforms.uSigma.value = sigma;

            // 2 — high-pass + horizontal blur. The threshold is applied on this
            //     pass only; by the vertical one the buffer already holds glow.
            blurMaterial.uniforms.tSrc.value = rtParticles.texture;
            blurMaterial.uniforms.uDirection.value.set(1, 0);
            blurMaterial.uniforms.uThreshold.value = bloomSettings.threshold;
            blurMaterial.uniforms.uStrength.value = 1.0;
            renderQuad(blurMaterial, rtBlur);

            // 3 — vertical blur, back into the particle target (already consumed).
            blurMaterial.uniforms.tSrc.value = rtBlur.texture;
            blurMaterial.uniforms.uDirection.value.set(0, 1);
            blurMaterial.uniforms.uThreshold.value = -1.0;
            blurMaterial.uniforms.uStrength.value = bloomSettings.strength;
            renderQuad(blurMaterial, rtParticles);

            // 4 — the real frame, rendered exactly as flat mode renders it.
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);

            // 5 — add the glow on top, without clearing what was just drawn.
            overlayMaterial.uniforms.uStrength.value = bloomSettings.composite;
            renderer.autoClear = false;
            quad.material = overlayMaterial;
            renderer.render(quadScene, quadCamera);
            renderer.autoClear = true;
        },
        setSize: syncSize,
    };
}
