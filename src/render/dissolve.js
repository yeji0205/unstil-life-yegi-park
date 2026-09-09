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


// ─── Particle look: flat white vs. shiny ─────────────────────────────────────
// 0 = the original look: every speck the same flat, evenly-lit white dot.
// 1 = "shiny": the appearance the Codrops dissolve demo has.
//
// That look is TWO things working together, and neither is enough alone:
//
//   1. The sprite. The demo's particle.png is not a round dot — it is a wispy,
//      irregular horizontal STREAK, rotated per particle by an `aAngle`
//      attribute that it advances by 0.01 every frame. So each speck is a small
//      elongated flare, slowly spinning. That rotation is where the shimmer
//      comes from: a spinning streak changes its silhouette frame to frame,
//      while a round dot looks identical no matter how you turn it. Reproduced
//      here as an anisotropic gaussian in the fragment shader (long on one
//      axis, thin on the other) rather than a texture, so there is no image
//      asset to ship or to keep mirrored into public/.
//
//   2. Selective bloom. See render/particleBloom.js. This is the part that
//      actually makes them shiny rather than merely bigger, because it spreads
//      light onto NEIGHBOURING pixels — impossible inside a point sprite, which
//      can only ever fill its own quad. Drawing a "glow" into the sprite gives
//      fatter dots and nothing else.
//
// So the sprite here stays deliberately tight and only moderately bright: it
// just has to clear the bloom threshold and let the post-process do the glowing.
//
// Kept as a uniform rather than two materials so the switch is instant and
// costs no shader recompile — it's meant to be flipped back and forth mid
// dissolve to compare. Treated as a boolean (the shader branches on < 0.5);
// intermediate values don't cross-fade.
export const uParticleShiny = { value: 0.0 };

// The camera layer the particle Points objects are put on, so the bloom pass
// can render them and nothing else. Set on the Points in glbLoader; read by
// render/particleBloom.js. Layer 0 (everything else) is left alone.
export const PARTICLE_BLOOM_LAYER = 1;

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
    uniform float   uShiny;          // 0 = flat white dots, 1 = specular glints (see uParticleShiny)
    uniform float   uTime;
    varying float   vAlpha;
    varying float   vSparkle;    // per-particle twinkle brightness (shiny only)
    varying float   vStreakAngle; // per-particle streak rotation (shiny only)
    varying float   vRandom;     // stable per-particle 0–1, reused for tint
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

        // ─── Per-particle identity ───────────────────────────────────────────
        // Hashed from the particle's own surface position, which is unique and
        // never changes, so each speck keeps the same size, phase and tint for
        // its whole life. Done here rather than as a third buffer attribute: the
        // geometry builder in glbLoader is shared by the table and every object,
        // and a hash of an existing attribute costs nothing next to another
        // Float32Array per object. (The demo does use an attribute, aAngle, and
        // rewrites it from JS every frame — a hash plus uTime is the same result
        // without the per-frame upload.)
        float random = fract(sin(dot(position, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        vRandom      = random;

        // The spin. The demo advances each particle's angle by 0.01 per frame,
        // i.e. ~0.6 rad/s at 60fps; matched here, but driven by TIME rather than
        // frame count so it runs at the same speed on any refresh rate, and with
        // a per-particle rate and start angle so the field doesn't turn in unison.
        vStreakAngle = random * 6.2831853 + uTime * (0.45 + random * 0.5);

        // Twinkle: kept subtle now that the streak's rotation carries most of
        // the shimmer, and that bloom exaggerates whatever brightness variation
        // there is. Flat mode gets a constant 1.
        float flare   = 0.5 + 0.5 * sin(uTime * (1.6 + random * 2.4) + random * 31.4);
        float twinkle = 0.75 + 0.45 * flare * flare;
        vSparkle      = mix(1.0, twinkle, uShiny);

        vec4 mvPos   = modelViewMatrix * vec4(pos, 1.);
        // Base 30 (was 60./2.) so particles read as fine specks rather than
        // chunky dots/points.
        //
        // Shiny mode needs a slightly wider sprite because the streak has to be
        // longer than it is thick to read as a streak at all — below ~4px it
        // just aliases into a dot. Only 1.7×, not more: the glow is bloom's job
        // now, and a large sprite was exactly what made the previous attempt
        // look thick instead of shiny. Sizes also vary per particle here; a
        // field of identically sized flares is what gives a particle system away.
        float sizeVariation = mix(1.0, 0.7 + 0.7 * random, uShiny);
        gl_PointSize = max(1., 30. * mix(1.0, 1.7, uShiny) * sizeVariation / -mvPos.z);
        gl_Position  = projectionMatrix * mvPos;
    }
`;

export const objectParticleFragmentShader = /* glsl */`
    uniform vec3  uParticleColor;
    uniform float uShiny;
    varying float vAlpha;
    varying float vSparkle;
    varying float vStreakAngle;
    varying float vRandom;

    void main(){
        if(vAlpha < 0.01) discard;
        vec2  uv = gl_PointCoord - .5;
        float d  = length(uv);

        // ─── Flat mode — the original look, unchanged ────────────────────────
        if(uShiny < 0.5){
            if(d > .5) discard;
            float alpha = vAlpha * (1. - d * 2.); // 1 at center, 0 at edge → soft circle
            // Brightness boost (>1) so the additive blending blooms toward a hot
            // neon core where particles overlap, instead of flat dots.
            gl_FragColor = vec4(uParticleColor * 1.6, alpha);
            return;
        }

        // ─── Shiny mode — a soft point of light for the bloom to work on ────
        // NOT a copy of the demo's sprite, deliberately. Its particle.png is a
        // ragged elongated wisp, and reproducing that shape here (an elongated
        // gaussian plus a crossing one) was a mistake for two reasons:
        //
        //   - The demo emits a few hundred LARGE wisps; this scene emits 200–2000
        //     specks that are only a handful of pixels across. Any shape with
        //     structure in it — a dash, a plus, a star — is at that size just a
        //     recognisable little GLYPH, and a glyph repeated a thousand times
        //     reads as a thousand pasted stamps, not as a dissolving object.
        //   - It was bright enough to clip, so the shape saturated into a flat
        //     white slab with dim gaps between its arms, which is what put a
        //     visible dark X inside every speck.
        //
        // So: one smooth radial falloff, peaking just about at white and fading
        // to nothing well inside the sprite quad, with only a mild per-particle
        // stretch for variety. Everything that makes it read as SHINY rather
        // than as a dot now comes from the bloom pass, which is the one place it
        // can come from. vStreakAngle still orients the stretch, so the specks
        // don't all lean the same way and still turn slowly.
        float c = cos(vStreakAngle), s = sin(vStreakAngle);
        vec2  q = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) * 2.;

        // A gentle stretch. NOTE the effective long:short ratio is stretch
        // SQUARED, because one axis is divided while the other is multiplied
        // (done that way so the sprite's area stays roughly constant). So 1.35
        // here means about 1.8:1 — enough that no two specks are quite the same
        // shape, too little to read as a dash. Setting this to 1.8 directly, as
        // a first attempt did, gives 3.2:1 and they turn back into little marks.
        float stretch = 1. + vRandom * .35;
        vec2  e       = vec2(q.x / stretch, q.y * stretch);

        // Gaussian peaking at 1.0. Reaching 0 by ~40% of the quad radius keeps
        // the sprite's square edge far away from anything visible.
        float shape = exp(-dot(e, e) * 26.) * vSparkle;
        if(shape < .01) discard;

        // Each speck biased slightly warm or cool. Both stay multiples of
        // uParticleColor, so the GUI colour picker still drives the whole look.
        vec3 warm = uParticleColor * vec3(1.12, 1.00, .82);
        vec3 cool = uParticleColor * vec3(.84,  .93, 1.16);
        vec3 tint = mix(warm, cool, vRandom);

        // Only just over 1.0 at the centre. The point is to have a hot core the
        // bloom threshold can catch WITHOUT flattening the falloff into a slab:
        // anything much brighter clips across most of the sprite and the soft
        // point of light becomes a hard white blob again.
        // Additive blending contributes rgb * alpha, so the shape lives in the
        // colour and alpha stays the particle's own life fade (vAlpha).
        gl_FragColor = vec4(tint * shape * 1.15, vAlpha);
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
