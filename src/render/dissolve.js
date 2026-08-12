import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

// ─── Shared dissolve uniforms ────────────────────────────────────────────────
// One set of GUI-tunable values driving every dissolve shader in the scene
// (room walls, table, stage objects). Each object still owns its own
// progress uniform so they can dissolve independently.
export const uProgress          = { value: 0.0 };
export const uDissolveEdge      = { value: 0.25 };
export const uNoiseFreq         = { value: 0.35 };
export const uDissolveEdgeColor = { value: new THREE.Color(0x000000) };

// Fresnel rim tint — every object edge-blends toward this color at grazing
// angles, so objects visually "pick up" whatever's actually around them
// (warm room light, blue nebula, white void) instead of only getting
// brighter/dimmer as a whole. Driven each frame from the live ambient light
// in render/lighting.js, so it always matches the current background.
export const uRimColor    = { value: new THREE.Color(0xffffff) };
export const uRimStrength = { value: 0.0 };

// Injects the Codrops noise-dissolve technique into any MeshStandardMaterial
// (or similar) via onBeforeCompile. Replaces three near-identical blocks that
// used to live on the room, table, and stage-object materials.
//
// space: 'world' — noise follows world position (room walls dissolve in place)
//        'local' — noise rides with the mesh (floating objects keep their pattern)
// freqScale: extra multiplier on uFreq (table/objects use a tighter noise scale)
// scaleUniform: {value} carrying the mesh's scaleFactor. The noise is sampled
// in LOCAL space (so the pattern rides with a floating object), but multiplying
// the sample position by the mesh scale cancels out how much the object was
// shrunk/enlarged to reach its target height — so every object dissolves with
// the SAME world-space blob size regardless of how big its source GLB was.
// Without this, a natively-large GLB (small scaleFactor) dissolved in fine dots
// while a natively-small one dissolved in big blobs, which read as each object
// fading at a different speed. Default 1 = no normalization (room walls, table).

// ─── Transparency, only while dissolving ─────────────────────────────────────
// Every material the dissolve is injected into, with the uniform driving it.
const dissolveMaterials = [];

// Transparency is only needed WHILE something is dissolving — that's when the
// effect fades its edge with alpha. The rest of the time these materials are
// fully opaque, and leaving `transparent: true` on them is expensive on a
// fill-limited GPU: transparent meshes skip early-Z rejection, get sorted
// back-to-front and run through the blender. That was 13 of the scene's 14
// meshes, including six near-full-screen room planes, all paying for blending
// they never used.
//
// Toggling `transparent` does NOT recompile the shader — three reads it per
// frame when building render lists — so this is free to flip every frame.
export function updateDissolveTransparency() {
    for (const { material, progress } of dissolveMaterials) {
        // ownsAlpha: this material needs transparency for its OWN sake, not just
        // for the dissolve — a cut-out leaf texture, say, where the mesh is a flat
        // rectangle and the alpha channel carves the leaf shape out of it. Forcing
        // those opaque makes the alpha channel be ignored and the bare rectangle
        // shows. Set in glbLoader BEFORE the dissolve forces transparency on.
        const needsAlpha = material.userData.ownsAlpha || progress.value > 0.001;
        if (material.transparent !== needsAlpha) material.transparent = needsAlpha;
    }
}

export function injectDissolve(material, progressUniform, { space = 'local', freqScale = 1.0, scaleUniform = { value: 1.0 } } = {}) {
    dissolveMaterials.push({ material, progress: progressUniform });
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uProgress    = progressUniform;
        shader.uniforms.uEdge        = uDissolveEdge;
        shader.uniforms.uFreq        = uNoiseFreq;
        shader.uniforms.uEdgeColor   = uDissolveEdgeColor;
        shader.uniforms.uRimColor    = uRimColor;
        shader.uniforms.uRimStrength = uRimStrength;
        shader.uniforms.uScale       = scaleUniform;

        const posExpr = space === 'world'
            ? '(modelMatrix * vec4(transformed, 1.0)).xyz'
            : 'transformed';

        shader.vertexShader =
            'varying vec3 vDissolvePos;\n' +
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
             uniform vec3  uRimColor;
             uniform float uRimStrength;
             varying vec3  vDissolvePos;
             ${NOISE_GLSL}` +
            shader.fragmentShader;

        // Apply dissolve after Three.js computes the lit colour
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>

            // Fresnel rim tint — grazing-angle surfaces (silhouette edges)
            // blend toward the current environment color; surfaces facing
            // the camera stay their own material color. vNormal/vViewPosition
            // are standard varyings already present in this shader.
            {
                vec3  rimViewDir = normalize(vViewPosition);
                float rimFactor  = pow(1.0 - max(dot(normalize(vNormal), rimViewDir), 0.0), 3.0);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, uRimColor, rimFactor * uRimStrength);
            }

            if (uProgress > 0.01) {
                float threshold = mix(-1.2, 1.2, uProgress);
                float noise     = snoise3(vDissolvePos * uScale * uFreq * ${freqScale.toFixed(4)});

                if (noise < threshold) discard;

                float edgeEnd = threshold + uEdge;
                if (noise < edgeEnd) {
                    float t     = (noise - threshold) / uEdge;
                    float alpha = mix(0.5, 1.0, t);
                    gl_FragColor = vec4(mix(uEdgeColor, gl_FragColor.rgb, t), alpha);
                }
            }`
        );
    };
}

// ─── Dissolve particle system (shared by table + every stage object) ────────
// White particle color — reads cleanest against the dark space background
// (tinted variants looked worse). Additive blending + the brightness boost in
// the fragment shader still gives it glow. Tweak live via the GUI "Particle
// Color" picker if another shade is ever wanted. (A true halo/bloom glow rather
// than bright dots would need a bloom post-process — offered as a follow-up.)
export const uParticleColor = { value: new THREE.Color(0xffffff) };

// How far the particle stream sways sideways as it flows, in object-local units
// before scale compensation. 0 = a perfectly straight stream. Kept low: this
// used to be an orbit rather than a sway (see the shader note) and read as a fast
// corkscrew, which fought the stillness the piece is going for.
export const uParticleSwirl = { value: 0.05 };

// Direction the particle stream flows toward as it leaves the object: up and
// slightly back, i.e. off into the sky/space background. Kept as a
// normalized-ish constant in object-local space (objects barely rotate, so
// local up ≈ world up) — biasing every particle this way turns the old
// radial "crumble in place" into a directional stream.
// How far the stream carries particles (object-height units) and how much
// wider the trailing band is than the dissolve edge. A wider band keeps many
// shells of particles in flight at once, so the stream is continuous instead
// of a thin flickering shell.
export const objectParticleVertexShader = /* glsl */`
    attribute vec3  aVelocity;
    uniform float   uObjectProgress;
    uniform float   uEdge;
    uniform float   uFreq;
    uniform float   uScale;      // mesh scaleFactor — normalizes blob size (see injectDissolve)
    uniform float   uFreqScale;  // matches the material's freqScale so particles sit on the dissolve edge
    uniform float   uStreamStrength; // 1 = coherent "flow into background" (objects); low = disperse (table)
    uniform float   uSwirl;          // lateral sway amplitude; 0 = straight stream
    uniform float   uTime;
    varying float   vAlpha;
    ${NOISE_GLSL}

    void main(){
        float threshold    = mix(-1.2, 1.2, uObjectProgress);
        // Same scale-normalized noise as the material dissolve, so particles
        // appear exactly where the surface is breaking up regardless of object size.
        float noise        = snoise3(position * uScale * uFreq * uFreqScale);
        float distFromEdge = noise - threshold;
        // Very long trailing band (11× the edge): the dissolve front sweeps a
        // given particle over a much longer window, so it drifts GRADUALLY
        // instead of zipping — and many shells stay in flight at once, reading
        // as a continuous stream rather than a quick burst. Raised from 8: the
        // wider the band, the more spread out a particle's whole journey is in
        // time, which is the other half of "too fast" alongside the sway rate.
        float driftBand    = uEdge * 11.0;

        if(distFromEdge > uEdge || distFromEdge < -driftBand){
            gl_Position  = vec4(9999., 9999., 9999., 1.);
            gl_PointSize = 0.;
            vAlpha       = 0.;
            return;
        }

        // t: 0 at the dissolve front → 1 at the far end of the trailing band.
        float t = clamp(-distFromEdge / driftBand, 0., 1.);

        // Manual drift terms live in LOCAL space, so divide by the mesh scale
        // to keep the world-space stream length identical for every object
        // (aVelocity is already scale-compensated when the buffer is built).
        float invScale = 1.0 / uScale;

        // Two blended motions: a per-particle spread (aVelocity) and a shared
        // directional flow into the background (streamDir). uStreamStrength scales
        // the directional part: at 1.0 the coherent stream dominates (objects
        // flowing into the sky); low values let the per-particle spread win so the
        // particles DISPERSE instead of drifting off as one clump (the table).
        vec3 streamDir = normalize(vec3(0.15, 1.0, 0.4));
        vec3 pos = position
                 + aVelocity * t * 0.7                                   // per-particle spread
                 + streamDir * t * 4.5 * invScale * uStreamStrength;     // shared flow into the background

        // A slow LATERAL SWAY, deliberately not a rotation.
        //
        // This used to be sin() on x paired with cos() on z. Those are a quarter
        // cycle apart, which is the parametric equation of a circle — so every
        // particle was orbiting while it rose, and a circle plus a rise is a
        // helix. That's where the corkscrew came from. It wasn't designed; it fell
        // out of reaching for two trig functions to get motion on two axes.
        //
        // Using ONE phase for both axes moves a particle back and forth along a
        // single fixed diagonal instead of around a ring, so the stream wanders
        // rather than winds. The time frequency is also ~6× slower (0.18 vs 1.1):
        // the old rate completed a full turn in a few seconds, which is brisk for
        // something meant to be watched rather than noticed.
        //
        // Tunable live via "Particle Sway" — at 0 the stream is perfectly
        // straight, which is the calmest setting and a fair default to judge from.
        float swayPhase = position.y * 0.8 + uTime * 0.18;
        float sway      = sin(swayPhase) * uSwirl * t * invScale;
        pos.x += sway;
        pos.z += sway * 0.6; // slight asymmetry so it isn't a flat plane of motion

        // Fade smoothly across the whole (longer) band — bright as it leaves
        // the surface, gently gone by the far end.
        vAlpha = 1. - t;

        // Global fade-out over the last stretch of the dissolve. Without this,
        // the highest-noise particles never reach the cull band (the threshold
        // tops out below them), so a sparse shell stayed frozen in mid-air after
        // the object itself was gone — visible until the whole scene is cleared
        // seconds later. Forcing alpha to 0 by uObjectProgress = 1 removes them
        // exactly when the object finishes dissolving.
        vAlpha *= 1.0 - smoothstep(0.85, 1.0, uObjectProgress);

        vec4 mvPos   = modelViewMatrix * vec4(pos, 1.);
        // Halved (was 60./2.) so particles read as fine specks rather than
        // chunky dots/points.
        gl_PointSize = max(1., 30. / -mvPos.z);
        gl_Position  = projectionMatrix * mvPos;
    }
`;

export const objectParticleFragmentShader = /* glsl */`
    uniform vec3  uParticleColor;
    varying float vAlpha;

    void main(){
        if(vAlpha < 0.01) discard;
        vec2  uv = gl_PointCoord - .5;
        if(length(uv) > .5) discard;
        float alpha = vAlpha * (1. - length(uv) * 2.); // 1 at center, 0 at edge → soft circle
        // Brightness boost (>1) so the additive blending blooms toward a hot
        // neon core where particles overlap, instead of flat dots.
        gl_FragColor = vec4(uParticleColor * 1.6, alpha);
    }
`;

export function makeParticleMaterial(progressUniform, timeUniform, { freqScale = 4.0, scaleUniform = { value: 1.0 }, streamStrength = 1.0 } = {}) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uObjectProgress: progressUniform,
            uEdge:           uDissolveEdge,
            uFreq:           uNoiseFreq,
            uScale:          scaleUniform,
            uFreqScale:      { value: freqScale },
            uStreamStrength: { value: streamStrength },
            uSwirl:          uParticleSwirl,
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
