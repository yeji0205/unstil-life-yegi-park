import * as THREE from 'three';
import { PARTICLE_BLOOM_LAYER } from './dissolve.js';

// ─── Selective bloom on the dissolve particles ───────────────────────────────
// The glow has to spread onto neighbouring pixels, which a point sprite can't do
// (drawing a glow inside the sprite only makes fatter dots). Each frame:
//   1. render ONLY the particles, on black, into a half-resolution target;
//   2. threshold that and blur it with a separable gaussian → the glow map;
//   3. draw the real frame, then add the glow map over it as a full-screen quad.
//
// Why not UnrealBloomPass: it blurs a mip pyramid, and a few-pixel speck lands
// in one texel of the coarse levels, which upsamples into a faint SQUARE around
// every particle. One gaussian at a single resolution blurs a dot into a round
// dot, and is cheaper.
//
// Why the frame isn't rendered through an EffectComposer: it blends the scene's
// additive layers (light cone, stars, particles) in linear space, then encodes to
// sRGB, which washed out the whole scene. So the frame is a plain
// renderer.render() and only the glow is added on top. This also keeps the
// canvas's own anti-aliasing.
//
// The particles are isolated by camera LAYER, not by swapping the background:
// the skybox is a mesh, and the lit room walls would bloom too. Downside: the
// glow isn't hidden behind objects, which is barely visible in practice.

// GUI-tunable ("Particle Bloom"): the right values depend on the background.
export const bloomSettings = {
    strength:  0.6,   // multiplier on the blurred glow
    radius:    0.14,  // how far the glow bleeds outward (drives the blur width)
    threshold: 0.15,  // luminance below which nothing blooms
    // Glow is added linearly (see the overlay shader), so this has to be higher
    // than it would with an sRGB encode.
    composite: 1.8,   // multiplier on the glow when it is added over the scene
};

const BLACK = new THREE.Color(0x000000);

// Glow map at half resolution: a glow is soft anyway, and it quarters the cost.
const RESOLUTION_SCALE = 0.5;

// Taps per side (kernel = 2*BLUR_TAPS+1), one texel apart; spacing them wider
// turns a speck into a row of ghost copies. SIGMA_MAX stays under BLUR_TAPS/2
// so the kernel never cuts off real weight.
const BLUR_TAPS = 8;
const SIGMA_MIN = 0.6;
const SIGMA_MAX = 3.0;

// Rec.709 luma for the threshold.
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
                // Soft high-pass: a narrow ramp, so a fading particle doesn't pop.
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
    // Half float, so bright particle cores stay above 1.0 through the blur.
    // No depth buffer: particles don't write depth.
    const targetOptions = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    const rtParticles = new THREE.WebGLRenderTarget(1, 1, targetOptions);
    const rtBlur      = new THREE.WebGLRenderTarget(1, 1, targetOptions);

    // One full-screen quad, reused for both blur passes and the overlay. Its
    // vertex shader writes clip space directly, so the camera doesn't matter.
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
                // Added linearly, with no sRGB encode: the encode brightened each
                // halo's faint outer edge ~10x, which made the particles look fluffy.
                gl_FragColor = vec4(texture2D(uGlow, vUv).rgb * uStrength, 1.0);
            }
        `,
        blending:    THREE.AdditiveBlending,
        depthTest:   false,
        depthWrite:  false,
        transparent: true,
    });

    // Sized from the drawing buffer, which includes the pixel ratio the adaptive
    // quality (setup/renderer.js) changes at runtime.
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
            // Restore the camera's exact layers (not enableAll(), which turns on every layer).
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
