import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

// Noise dissolve (Codrops technique) for the room, table and objects, plus the
// particle system the table and objects shed while dissolving.

// ─── Shared dissolve uniforms ────────────────────────────────────────────────
// GUI-tunable values shared by every dissolve shader. Each object still owns its
// own progress uniform so they can dissolve independently.
export const uProgress          = { value: 0.0 };
export const uNoiseFreq         = { value: 0.35 };

// Edge width. While a surface dissolves, a thin coloured band (the "edge") is
// drawn along the border of each hole, just before that part disappears.
export const uDissolveEdge       = { value: 0.25 };  // room walls
export const uObjectDissolveEdge = { value: 0.10 };  // table + stage objects
// Edge colour for the room
export const uDissolveEdgeColor = { value: new THREE.Color(0x000000) };

// Edge colour for the table and objects.
export const uObjectDissolveEdgeColor = { value: new THREE.Color(0xffffff) };

// Edge colour = the object's own colour, instead of the fixed colour above.
// Why: the 3D models are hollow shells. With a fixed colour (white), every hole
// showed a bright white outline around the empty inside of the object, which
// was the most eye-catching thing on screen. Using the object's own colour, a
// hole just looks like the object getting thinner.
export const uObjectEdgeFollow = { value: 1.0 };
export const uObjectEdgeGain   = { value: 0.35 };

// Room defaults: follow off, so it uses uDissolveEdgeColor.
const EDGE_FOLLOW_OFF = { value: 0.0 };
const EDGE_GAIN_UNUSED = { value: 1.0 };

// Default for meshes already in their root's space.
const IDENTITY_MATRIX = { value: new THREE.Matrix4() };

// ─── Transparency, only while dissolving ─────────────────────────────────────
// Transparent materials are expensive (no early-Z, sorting, blending), so they
// are made transparent only while dissolving. Flipping `transparent` does not
// recompile the shader.
const dissolveMaterials = [];

// Removes a disposed mesh's materials from the list. Call on every object swap,
// or the list grows forever and keeps old materials in memory.
export function forgetDissolveMaterials(root) {
    root.traverse?.((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
            const i = dissolveMaterials.findIndex((e) => e.material === m);
            if (i !== -1) dissolveMaterials.splice(i, 1);
        }
    });
}

export function updateDissolveTransparency() {
    for (const { material, progress } of dissolveMaterials) {
        // ownsAlpha: needs transparency anyway (e.g. cut-out leaf textures).
        // Set in objects/table.js and stageObjects.js before the dissolve forces transparency on.
        const needsAlpha = material.userData.ownsAlpha || progress.value > 0.001;
        if (material.transparent !== needsAlpha) material.transparent = needsAlpha;
    }
}

// Injects the dissolve into a MeshStandardMaterial (keeps PBR lighting).
//   space:         'world' = pattern fixed in the world (room walls)
//                  'local' = pattern rides with the mesh (floating objects)
//   freqScale:     extra multiplier on uFreq (table/objects use finer noise)
//   scaleUniform:  the mesh's scale factor, so every object dissolves with the
//                  same world-size blobs whatever size its GLB was
//   edgeUniform:   edge width. Must be the same one passed to makeParticleMaterial,
//                  or the particles won't sit on the edge.
//   localMatrixUniform: child-to-root transform (see posExpr below)
export function injectDissolve(material, progressUniform, { space = 'local', freqScale = 1.0, scaleUniform = { value: 1.0 }, edgeUniform = uDissolveEdge, edgeColorUniform = uDissolveEdgeColor, edgeFollowUniform = EDGE_FOLLOW_OFF, edgeGainUniform = EDGE_GAIN_UNUSED, localMatrixUniform = IDENTITY_MATRIX } = {}) {
    dissolveMaterials.push({ material, progress: progressUniform });
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uProgress    = progressUniform;
        shader.uniforms.uEdge        = edgeUniform;
        shader.uniforms.uFreq        = uNoiseFreq;
        shader.uniforms.uEdgeColor   = edgeColorUniform;
        shader.uniforms.uEdgeFollow  = edgeFollowUniform;
        shader.uniforms.uEdgeGain    = edgeGainUniform;
        shader.uniforms.uLocalMatrix = localMatrixUniform;
        shader.uniforms.uScale       = scaleUniform;

        // 'local' samples in the ROOT's space, matching the particles, which are
        // built in root space. Otherwise submeshes offset from their root (the
        // tulip's) read a different part of the noise than their particles.
        const posExpr = space === 'world'
            ? '(modelMatrix * vec4(transformed, 1.0)).xyz'
            : '(uLocalMatrix * vec4(transformed, 1.0)).xyz';

        shader.vertexShader =
            'uniform mat4 uLocalMatrix;\nvarying vec3 vDissolvePos;\n' +
            shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                vDissolvePos = ${posExpr};`
            );

        shader.fragmentShader =
            `uniform float uProgress;
             uniform float uEdge;
             uniform float uFreq;
             uniform float uScale;
             uniform vec3  uEdgeColor;
             uniform float uEdgeFollow;
             uniform float uEdgeGain;
             varying vec3  vDissolvePos;
             ${NOISE_GLSL}` +
            shader.fragmentShader;

        // Apply dissolve after Three.js computes the lit colour
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>

            if (uProgress > 0.01) {
                float threshold = mix(-1.2, 1.2, uProgress);
                float noise     = snoise3(vDissolvePos * uScale * uFreq * ${freqScale.toFixed(4)});

                if (noise < threshold) discard;

                float edgeEnd = threshold + uEdge;
                if (noise < edgeEnd) {
                    float t     = (noise - threshold) / uEdge;
                    // Multiplies the material's own alpha, not replaces it, or
                    // cut-out textures (tulip leaves) show their rectangle.
                    float alpha = gl_FragColor.a * mix(0.5, 1.0, t);
                    // Fixed colour, or the surface's own colour (see uObjectEdgeFollow).
                    vec3 edgeCol = mix(uEdgeColor, gl_FragColor.rgb * uEdgeGain, uEdgeFollow);
                    gl_FragColor = vec4(mix(edgeCol, gl_FragColor.rgb, t), alpha);
                }
            }`
        );
    };
}

// ─── The same dissolve, for SHADOWS ──────────────────────────────────────────
// Makes an object's shadow dissolve together with the object.
// three.js draws shadows in a separate step, using its own simple material that
// knows nothing about the dissolve. Without this, a half-dissolved object (or an
// invisible one) still cast its complete shadow, and when the objects came back
// to the room all their shadows appeared at once. This material cuts out the
// same holes as the surface, so the shadow gets holes at the same moment.
// Set as the mesh's customDepthMaterial (see objects/table.js and stageObjects.js).
//
// Options MUST match the injectDissolve() call for the same mesh.
export function makeDissolveDepthMaterial(progressUniform, {
    space = 'local', freqScale = 1.0, scaleUniform = { value: 1.0 },
    localMatrixUniform = IDENTITY_MATRIX, cacheKey = 'dissolve_depth',
} = {}) {
    // RGBADepthPacking is what shadow maps read back; the default decodes as garbage.
    const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

    depthMat.onBeforeCompile = (shader) => {
        shader.uniforms.uProgress    = progressUniform;
        shader.uniforms.uFreq        = uNoiseFreq;
        shader.uniforms.uScale       = scaleUniform;
        shader.uniforms.uLocalMatrix = localMatrixUniform;

        const posExpr = space === 'world'
            ? '(modelMatrix * vec4(transformed, 1.0)).xyz'
            : '(uLocalMatrix * vec4(transformed, 1.0)).xyz';

        shader.vertexShader =
            `uniform mat4 uLocalMatrix;
             varying vec3 vDissolvePos;
             ` +
            shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                vDissolvePos = ${posExpr};`
            );

        shader.fragmentShader =
            `uniform float uProgress;
             uniform float uFreq;
             uniform float uScale;
             varying vec3  vDissolvePos;
             ${NOISE_GLSL}` +
            shader.fragmentShader;

        // Only the fully dissolved part is cut out; the edge still casts a shadow.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
            if (uProgress > 0.01) {
                float threshold = mix(-1.2, 1.2, uProgress);
                if (snoise3(vDissolvePos * uScale * uFreq * ${freqScale.toFixed(4)}) < threshold) discard;
            }`
        );
    };

    // Stable key: everything that differs between meshes is a uniform.
    depthMat.customProgramCacheKey = () => cacheKey;
    return depthMat;
}

// ─── Particle settings (GUI sliders) ──────────────────────────────────────────
export const uParticleColor = { value: new THREE.Color(0xffffff) };

// Sideways sway of the particle stream (0 = straight).
export const uParticleSwirl = { value: 0.05 };

// Size on screen (multiplier).
export const uParticleSize = { value: 0.8 };

// How much each particle grows when it twinkles (0 = no twinkle).
export const uParticleTwinkle = { value: 0.6 };

// How strong the star rays are (0 = round dot, no rays).
export const uParticleSpikes = { value: 0.7 };

// How thin the rays are. Higher = thinner; too high (e.g. 110) and they vanish.
export const uParticleSpikeSharp = { value: 8.0 };

// How far the rays reach before fading out. Lower = longer rays.
export const uParticleSpikeLength = { value: 2.0 };

// How much a particle shrinks as it fades out.
export const uParticleShrink = { value: 2.0 };

// How long a particle lives after the edge passes it. Too large and particles
// are cut off when the dissolve ends; ~1.4 lets them fade out fully.
export const uParticleLife = { value: 1.4 };

// How far a particle travels during its life.
export const uParticleDrift = { value: 4.5 };

// 0 = flat soft dots, 1 = shiny star particles with glow (effects/particleBloom.js).
export const uParticleShiny = { value: 1.0 };

// Camera layer for the particles, so the bloom pass can render only them.
export const PARTICLE_BLOOM_LAYER = 1;

export const objectParticleVertexShader = /* glsl */`
    attribute vec3  aVelocity;
    uniform float   uObjectProgress;
    uniform float   uEdge;
    uniform float   uFreq;
    uniform float   uScale;      // mesh scale factor (see injectDissolve)
    uniform float   uFreqScale;  // must match the surface's freqScale
    uniform float   uStreamStrength; // 1 = flow into the sky (objects), low = scatter (table)
    uniform float   uSwirl;          // see uParticleSwirl
    uniform float   uShiny;          // see uParticleShiny
    uniform float   uSize;           // see uParticleSize
    uniform float   uTwinkle;        // see uParticleTwinkle
    uniform float   uShrink;         // see uParticleShrink
    uniform float   uLife;           // see uParticleLife
    uniform float   uDrift;          // see uParticleDrift
    uniform float   uTime;
    varying float   vAlpha;
    varying float   vSparkle;    // twinkle factor for the rays/brightness
    varying float   vRandom;     // stable per-particle 0..1
    ${NOISE_GLSL}

    void main(){
        // Same noise and threshold as the surface, so a particle appears exactly
        // where the surface breaks up.
        float threshold    = mix(-1.2, 1.2, uObjectProgress);
        float noise        = snoise3(position * uScale * uFreq * uFreqScale);
        float distFromEdge = noise - threshold;
        float driftBand    = uLife;

        // Hidden before the edge reaches it, and after its life is over.
        if(distFromEdge > uEdge || distFromEdge < -driftBand){
            gl_Position  = vec4(9999., 9999., 9999., 1.);
            gl_PointSize = 0.;
            vAlpha       = 0.;
            return;
        }

        // Age: 0 at the dissolve front, 1 at the end of its life.
        float t = clamp(-distFromEdge / driftBand, 0., 1.);

        // Drift is in local space; divide by scale so every object's stream is
        // the same length in the world.
        float invScale = 1.0 / uScale;

        // Own random direction + shared stream up and back into the sky.
        vec3 streamDir = normalize(vec3(0.15, 1.0, 0.4));
        vec3 pos = position
                 + aVelocity * t * uDrift * 0.233                       // per-particle spread, scaled with drift
                 + streamDir * t * uDrift * invScale * uStreamStrength;     // shared flow into the background

        // Slow sideways sway. One phase for both axes on purpose: sin on x with
        // cos on z traces a circle, which made the stream corkscrew.
        float swayPhase = position.y * 0.8 + uTime * 0.18;
        float sway      = sin(swayPhase) * uSwirl * t * invScale;
        pos.x += sway;
        pos.z += sway * 0.6; // slight asymmetry so it isn't a flat plane of motion

        // ─── Fading away: alpha AND size together ────────────────────────────
        // Full for the first quarter of life, then fades. A linear 1-t left the
        // whole field half-faded, which read as haze.
        vAlpha = 1.0 - smoothstep(0.25, 1.0, t);
        float lifeShrink = 1.0 / (1.0 + t * uShrink);

        // Safety net: fade out any stragglers as the dissolve ends, so none hang
        // in mid-air after the object is gone.
        vAlpha *= 1.0 - smoothstep(0.92, 1.0, uObjectProgress);

        // Stable per-particle random number, hashed from its position, so no
        // extra attribute or per-frame upload is needed.
        float random = fract(sin(dot(position, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        vRandom      = random;

        // ─── Twinkle (shiny only) ────────────────────────────────────────────
        // Own speed and start per particle, so they never flash in sync.
        float flare = 0.5 + 0.5 * sin(uTime * (1.6 + random * 2.4) + random * 31.4);
        float pulse = flare * flare * 2.0 - 1.0; // -1..1, biased low so peaks are brief

        // Only ever ADDS size: a two-way pulse stacked with the other size
        // multipliers shrank specks to sub-pixel.
        float sizePulse = mix(1.0, 1.0 + uTwinkle * max(pulse, 0.0), uShiny);

        // Rays/brightness at half depth; full depth on both reads as a strobe.
        vSparkle = mix(1.0, 1.0 + uTwinkle * 0.5 * max(pulse, 0.0), uShiny);

        vec4 mvPos   = modelViewMatrix * vec4(pos, 1.);
        // Varied sizes, so the field doesn't look like identical stamps.
        float sizeVariation = mix(1.0, 0.7 + 0.7 * random, uShiny);

        // ─── Size, clamped in screen pixels ──────────────────────────────────
        // Camera distance varies ~5x (room, space, zoom), so a plain 1/z size is
        // either too big close up or invisible far away. The core is clamped to
        // 3–8 px; the rays extend to the quad edge (1/ink = ~2.2x the core).
        float ink    = mix(1.0, 0.45, uShiny);
        float inkCss = 30. * mix(1.0, 1.7, uShiny) * uSize * ink / -mvPos.z;
        // Multipliers applied AFTER the clamp. Floor of 1.5 px so a live speck
        // never shrinks to nothing; disappearing is alpha's job.
        inkCss       = clamp(inkCss, 3.0, 8.0) * sizeVariation * sizePulse * lifeShrink;
        inkCss       = max(inkCss, 1.5);
        gl_PointSize = max(1., inkCss / ink);
        gl_Position  = projectionMatrix * mvPos;
    }
`;

export const objectParticleFragmentShader = /* glsl */`
    uniform vec3      uParticleColor;
    uniform float     uShiny;
    uniform float     uSpikes;
    uniform float     uSpikeSharp;
    uniform float     uSpikeLength;
    varying float vAlpha;
    varying float vSparkle;
    varying float vRandom;

    void main(){
        if(vAlpha < 0.01) discard;
        vec2  uv = gl_PointCoord - .5;
        float d  = length(uv);

        // ─── Flat mode: soft round dot ───────────────────────────────────────
        if(uShiny < 0.5){
            if(d > .5) discard;
            float alpha = vAlpha * (1. - d * 2.); // 1 at center, 0 at edge → soft circle
            // >1 so overlapping specks add up to a bright core.
            gl_FragColor = vec4(uParticleColor * 1.6, alpha);
            return;
        }

        // ─── Shiny mode: star glint, drawn procedurally (no texture) ─────────
        vec2  p = uv * 2.0;          // -1..1 across the quad
        float r = length(p);
        if (r > 1.0) discard;

        // Round core: the bright point.
        float core = exp(-r * r * 24.0);

        // Four rays: thin ridges along x and y, tapering toward the edge.
        // Length varies per particle and grows with the twinkle.
        float fade = max(0.0, 1.0 - r);
        float sx   = 1.0 / (1.0 + abs(p.x) * uSpikeSharp);
        float sy   = 1.0 / (1.0 + abs(p.y) * uSpikeSharp);
        float arms = (sx + sy) * pow(fade, uSpikeLength) * (0.6 + 0.8 * vRandom);

        // Rays start outside the core; stacked on it, the centre clipped to white.
        arms *= smoothstep(0.08, 0.35, r);

        float shape = core + arms * uSpikes * vSparkle;
        if (shape < 0.01) discard;

        // Each speck slightly warm or cool, still driven by the colour picker.
        vec3 warm = uParticleColor * vec3(1.12, 1.00, .82);
        vec3 cool = uParticleColor * vec3(.84,  .93, 1.16);
        vec3 tint = mix(warm, cool, vRandom);

        // 0.8 keeps the core near white, so overlapping specks don't fuse.
        gl_FragColor = vec4(tint * shape * vSparkle * 0.8, vAlpha);
    }
`;

export function makeParticleMaterial(progressUniform, timeUniform, { freqScale = 4.0, scaleUniform = { value: 1.0 }, streamStrength = 1.0, edgeUniform = uObjectDissolveEdge } = {}) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uObjectProgress: progressUniform,
            uEdge:           edgeUniform,
            uFreq:           uNoiseFreq,
            uScale:          scaleUniform,
            uFreqScale:      { value: freqScale },
            uStreamStrength: { value: streamStrength },
            uSwirl:          uParticleSwirl,
            uSize:           uParticleSize,
            uSpikes:         uParticleSpikes,
            uSpikeSharp:     uParticleSpikeSharp,
            uSpikeLength:    uParticleSpikeLength,
            uTwinkle:        uParticleTwinkle,
            uShrink:         uParticleShrink,
            uLife:           uParticleLife,
            uDrift:          uParticleDrift,
            uShiny:          uParticleShiny,
            uParticleColor,
            uTime:           timeUniform,
        },
        vertexShader:   objectParticleVertexShader,
        fragmentShader: objectParticleFragmentShader,
        transparent:    true,
        depthWrite:     false,
        blending:       THREE.AdditiveBlending,
    });
}
