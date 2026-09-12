import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

// ─── Shared dissolve uniforms ────────────────────────────────────────────────
// One set of GUI-tunable values driving every dissolve shader in the scene
// (room walls, table, stage objects). Each object still owns its own
// progress uniform so they can dissolve independently.
export const uProgress          = { value: 0.0 };
export const uNoiseFreq         = { value: 0.35 };

// ─── Edge width: one per category, NOT one for the scene ─────────────────────
// The rim's thickness in WORLD units is uEdge / (the noise frequency the
// surface is sampled at). The room samples world-space noise at freqScale 1.0
// and the table/objects at 4.0, so a single shared value lands very
// differently on each:
//
//              rim thickness   surface size   rim as % of surface
//   room wall      0.71 u          ~10 u              7%
//   object         0.18 u          ~1 u              18%   <- 2.5x heavier
//
// A 1-unit object was wearing a rim proportionally two and a half times wider
// than a wall's, which is most of why the dissolve read as a soft fade on the
// objects and as a crisp sweep on the room. Objects get their own value,
// picked so their rim covers the same ~7% of the object that the room's does
// of a wall: 0.071 world units x 1.4 frequency = 0.10.
//
// Knock-on effect, deliberate: the particle drift band is uEdge x 11, so a
// thinner object edge also tightens the band the particles live in (2.75 ->
// 1.10 noise units), which pulls them closer to the front they came off.
export const uDissolveEdge       = { value: 0.25 };  // room walls
export const uObjectDissolveEdge = { value: 0.10 };  // table + stage objects
// The colour the surface takes AT the dissolve front, before it discards —
// the rim that outlines whatever is currently breaking up. The demo makes this
// its most recognisable feature with a bright blue (0x4d9bff); black here is a
// deliberate departure, keeping the dissolve front a dark edge rather than a
// lit one. Live on the GUI's "Edge Color" picker if that's ever worth revisiting.
export const uDissolveEdgeColor = { value: new THREE.Color(0x000000) };

// ─── The OBJECTS' edge colour, separate from the room's ──────────────────────
// Split for the same reason the width was: the room wants a dark front against
// warm plaster, while the objects dissolve against black space where a dark rim
// is simply invisible — there is nothing for the particles to visibly come off.
//
// Defaulted to match uParticleColor (white), which is how the demo is built:
// its edge and its particles are two SEPARATE uniforms both initialised to the
// same 0x4d9bff, on two separate GUI controls. Same value, independently
// tunable — so the rim and the specks it sheds read as one material by default,
// without being locked together.
export const uObjectDissolveEdgeColor = { value: new THREE.Color(0xffffff) };

// ─── Rim takes the surface's OWN colour ──────────────────────────────────────
// A fixed rim colour outlines every hole it opens. On a hollow mesh — which all
// the scanned/modelled objects are — that draws a bright line around the empty
// interior and makes the hollowness the most eye-catching thing on screen.
//
// With follow on, the rim is the surface's own LIT colour scaled by the gain, so
// a hole is edged in a darker version of the object rather than in a foreign
// hue, and the eye reads it as the object thinning rather than as an outline.
// Gain below 1 darkens the front, above 1 brightens it into a glow.
//
// Room keeps follow OFF (its walls are not hollow and its dark front is wanted).
// Kept as floats rather than a bool so the shader can branch-free mix() on them.
export const uObjectEdgeFollow = { value: 1.0 };
export const uObjectEdgeGain   = { value: 0.35 };

// The room's defaults: follow off, so it uses uDissolveEdgeColor as before.
const EDGE_FOLLOW_OFF = { value: 0.0 };
const EDGE_GAIN_UNUSED = { value: 1.0 };

// Identity default for localMatrixUniform — a child whose geometry already sits
// in its root's space needs no remap.
const IDENTITY_MATRIX = { value: new THREE.Matrix4() };

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
// Drops a material from the list above. Must be called whenever a dissolving
// mesh is disposed — this array was push-only, so every object swap left its
// old materials in it forever: a growing per-frame loop over materials that no
// longer exist, and a reference that kept each disposed one alive in memory.
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
        // ownsAlpha: this material needs transparency for its OWN sake, not just
        // for the dissolve — a cut-out leaf texture, say, where the mesh is a flat
        // rectangle and the alpha channel carves the leaf shape out of it. Forcing
        // those opaque makes the alpha channel be ignored and the bare rectangle
        // shows. Set in glbLoader BEFORE the dissolve forces transparency on.
        const needsAlpha = material.userData.ownsAlpha || progress.value > 0.001;
        if (material.transparent !== needsAlpha) material.transparent = needsAlpha;
    }
}

// edgeUniform: which category's rim width this surface follows. Defaults to the
// room's, so the room's own call site doesn't have to say so; the table and the
// stage objects pass uObjectDissolveEdge. Anything drawing a rim AND emitting
// particles must hand the same uniform to makeParticleMaterial, or the specks
// will sit at a different place than the edge they are supposed to come off.
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
        shader.uniforms.uRimColor    = uRimColor;
        shader.uniforms.uRimStrength = uRimStrength;
        shader.uniforms.uScale       = scaleUniform;

        // 'local' samples in the ROOT's space, not the child mesh's own.
        //
        // This has to agree with the particle system, which builds its points in
        // root-local space (see buildParticlesFromGeometry). A GLB whose
        // submeshes carry a transform relative to their root broke that
        // agreement silently: the tulip's three submeshes sit 16.06 units above
        // their root, which at that object's scale is 0.75 in noise-argument
        // units — close to a whole noise period. So the surface and the specks
        // it was meant to shed were reading unrelated parts of the field, and
        // the flower dissolved with no particles while they arrived later.
        //
        // uLocalMatrix is that child-to-root transform. It is a uniform, so the
        // generated source is unchanged and the shared program cache key holds.
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
                    // The edge fade MULTIPLIES the material's own alpha instead of
                    // replacing it. A cut-out texture (the tulip's leaves are one
                    // flat quad with the leaf shape carved out by the texture's
                    // alpha) is 0 outside the shape, and overwriting that made the
                    // whole rectangular quad opaque wherever the edge band crossed
                    // it — a rectangle appearing around the leaves mid-dissolve.
                    float alpha = gl_FragColor.a * mix(0.5, 1.0, t);
                    // Either a fixed colour, or the surface's own lit colour
                    // scaled — see uObjectEdgeFollow for why hollow meshes want
                    // the second one.
                    vec3 edgeCol = mix(uEdgeColor, gl_FragColor.rgb * uEdgeGain, uEdgeFollow);
                    gl_FragColor = vec4(mix(edgeCol, gl_FragColor.rgb, t), alpha);
                }
            }`
        );
    };
}

// ─── The same dissolve, for the SHADOW pass ─────────────────────────────────
// injectDissolve only patches the material a mesh is DRAWN with. Shadow maps are
// rendered with a separate depth material that three.js supplies itself, and
// that one knows nothing about the dissolve — so a half-dissolved object went on
// casting its whole solid shadow, and a fully dissolved (invisible) one still
// cast a shadow from nothing.
//
// The workaround for that used to be flipping castShadow off once an object had
// dissolved and back on once it was home, which traded the wrong shadow for a
// sudden one: every shadow in the scene snapped into existence in the same
// frame, at the very end of the return.
//
// Attaching this as a mesh's customDepthMaterial fixes the cause instead. It
// runs the identical noise and the identical discard, so the shadow erodes in
// step with the surface casting it and castShadow can simply stay true.
//
// The options MUST match the injectDissolve() call for the same mesh — same
// space, freqScale, scaleUniform and localMatrixUniform — or the shadow will
// dissolve out of step with the surface.
export function makeDissolveDepthMaterial(progressUniform, {
    space = 'local', freqScale = 1.0, scaleUniform = { value: 1.0 },
    localMatrixUniform = IDENTITY_MATRIX, cacheKey = 'dissolve_depth',
} = {}) {
    // RGBADepthPacking is what three's shadow map reads back for directional and
    // spot lights; the default (BasicDepthPacking) would decode as garbage.
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

        // Discard before the depth is written. Only the fully-eaten region goes:
        // the glowing edge band is still solid surface, so it still casts.
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
            if (uProgress > 0.01) {
                float threshold = mix(-1.2, 1.2, uProgress);
                if (snoise3(vDissolvePos * uScale * uFreq * ${freqScale.toFixed(4)}) < threshold) discard;
            }`
        );
    };

    // Stable, for the same reason the surface materials' keys are — everything
    // that differs between meshes here is a uniform, not generated source.
    depthMat.customProgramCacheKey = () => cacheKey;
    return depthMat;
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

// ─── Sprite size, and how the specks travel ──────────────────────────────────
// SIZE multiplies the sprite's on-screen diameter. 1.2 is the 20% bump asked
// for; the slider is there because the right value depends on how close the
// camera is when you happen to be watching.
// A multiplier on top of the size clamp below, which is what actually decides
// how big a speck lands on screen. 1.0 = the clamp's own range.
export const uParticleSize = { value: 1.0 };

// Depth of the per-particle twinkle. Each speck swings between (1 - twinkle)
// and (1 + twinkle) of its base SIZE, and half that in brightness, on its own
// phase and rate.
//
// Size rather than brightness because of the scale we are working at. Rotating
// the sprite cannot twinkle below roughly 10px — the 512x512 texture is sampled
// from a coarse mip there, which has averaged the wisp's raggedness into a
// symmetric blob, and a symmetric blob looks identical however you spin it.
// Brightness alone barely reads either, since each speck sits under its own
// bloom halo. Size is the channel that survives both.
export const uParticleTwinkle = { value: 0.6 };

// How far the four diffraction spikes reach out of each speck's core.
//   0   -> a clean round bokeh dot, no rays
//   1   -> a star with long rays
// The spikes are SCREEN-ALIGNED and share one orientation, which is what real
// lens/eye diffraction does — the reference images all show every star pointing
// the same way. They are also modulated by vSparkle, so the twinkle grows and
// shrinks the rays rather than only dimming them, which is how a star actually
// reads as twinkling.
export const uParticleSpikes = { value: 0.7 };

// How much a speck shrinks over its life, as 1 / (1 + t * shrink): at 2.0 it
// ends a third of the size it started. 0 disables it.
//
// Shrinking is what makes the disappearance read as RECEDING rather than as
// being switched off. Alpha alone cannot do that: a half-transparent speck at
// full size is a big dim smudge, and a field of those is haze. Size carries
// distance, alpha carries presence, and they want to happen together — which is
// how the demo does it too, with size / (aDist + 1.0).
export const uParticleShrink = { value: 2.0 };

// LIFE is how long a speck survives after the dissolve front passes it,
// measured in NOISE units. This used to be `uEdge * 11.0`, i.e. welded to the
// rim width — so narrowing the objects' rim to 0.10 silently cut particle life
// from 2.75 to 1.10 and made them vanish about two and a half times sooner.
// Those two things have no business being the same number, so life is its own
// value now and the rim can be tuned without touching it.
//
// Counterintuitively, a SMALLER value here gives a LONGER-looking fade.
//
// A speck's progress through its own life is t = (threshold - noise) / life, and
// the threshold only ever sweeps 2.4 noise units in total. At life 2.4 a
// mid-noise speck reaches just t = 0.5 by the time the dissolve ends — still
// half alive — and is then cut off by the global end-of-dissolve fade below
// rather than fading on its own curve. That cut is what read as "too fast".
//
// At about 1.4 a speck's t actually reaches 1 around the moment the dissolve
// finishes, so it plays its whole alpha curve and tails off gracefully instead
// of being switched off part-way. Raising this past ~2 does not lengthen
// anything; it just moves more of the disappearance into the hard cut.
export const uParticleLife = { value: 1.4 };

// DRIFT is how far, in world units, a speck travels over its life — and it now
// scales the per-particle SCATTER as well, so one slider widens the whole plume
// instead of only stretching it along the stream. The scatter used to be a fixed
// 0.7 that ignored this value, so pushing the drift up made a long thin jet
// rather than a wider cloud.
export const uParticleDrift = { value: 4.5 };

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
    uniform float   uSize;           // sprite diameter multiplier (see uParticleSize)
    uniform float   uTwinkle;        // brightness flicker depth (see uParticleTwinkle)
    uniform float   uShrink;         // how much a speck shrinks over its life
    uniform float   uLife;           // trailing band in noise units (see uParticleLife)
    uniform float   uDrift;          // world units travelled over that life
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
        float driftBand    = uLife;

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
                 + aVelocity * t * uDrift * 0.233                       // per-particle spread, scaled with drift
                 + streamDir * t * uDrift * invScale * uStreamStrength;     // shared flow into the background

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

        // ─── Fading away ────────────────────────────────────────────────────
        // Two things happen together, because either alone looks wrong.
        //
        // ALPHA held full for the first quarter of the life, then eased out.
        // This was a straight 1-t, which puts a speck at 50% the moment it is
        // halfway along — so the whole field sits permanently half-faded and
        // reads as a dim haze rather than as specks that are still there and
        // then are not. smoothstep keeps them present, then lets them go.
        vAlpha = 1.0 - smoothstep(0.25, 1.0, t);

        // SIZE shrinking on the demo's curve. This is the half that makes it
        // look like receding into distance instead of a light being dimmed.
        float lifeShrink = 1.0 / (1.0 + t * uShrink);

        // Global fade-out over the last stretch of the dissolve. Without this,
        // the highest-noise particles never reach the cull band (the threshold
        // tops out below them), so a sparse shell stayed frozen in mid-air after
        // the object itself was gone — visible until the whole scene is cleared
        // seconds later. Forcing alpha to 0 by uObjectProgress = 1 removes them
        // exactly when the object finishes dissolving.
        // Safety net for stragglers whose noise sits high enough that they never
        // reach the cull band — without it a sparse shell hangs frozen in mid-air
        // after the object is gone. Starts at 0.92 rather than 0.85: with life
        // tuned so specks finish on their own, this should rarely be what ends
        // them, and starting it earlier just truncated the tail.
        vAlpha *= 1.0 - smoothstep(0.92, 1.0, uObjectProgress);

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
        float flare = 0.5 + 0.5 * sin(uTime * (1.6 + random * 2.4) + random * 31.4);
        float pulse = flare * flare * 2.0 - 1.0; // -1..1, biased low so peaks are brief

        // SIZE is the twinkle that actually reads here, which is the whole point
        // of doing it this way. Brightness flicker fails at this scale: the specks
        // are 3-12px and sit under a bloom halo, so dimming one mostly just dims
        // its glow. Changing how much SPACE it occupies survives any resolution —
        // the eye is far more sensitive to a changing extent than to a changing
        // level, which is why drei's Sparkles animates per-particle size rather
        // than only opacity.
        //
        // Floored at 0.15 rather than 0: a speck that reaches zero size pops out
        // and back in, which reads as a dropped frame, not as a glint.
        // Only ever ADDS size, never subtracts. It used to swing both ways, so a
        // speck spent half its life SMALLER than its base size — and stacked on
        // top of sizeVariation and lifeShrink that compounded down to a fraction
        // of a pixel, which is why they vanished. A twinkle is a brief flare,
        // not a shrink, so max(pulse, 0) is also the truer shape.
        float sizePulse = mix(1.0, 1.0 + uTwinkle * max(pulse, 0.0), uShiny);

        // Brightness follows at HALF depth, in phase. Both at full depth compound
        // into a strobe; half lets a speck look like it is catching the light
        // rather than being switched on and off.
        vSparkle = mix(1.0, 1.0 + uTwinkle * 0.5 * max(pulse, 0.0), uShiny);

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
        // ─── Size is CLAMPED in screen pixels, not left to 1/z ───────────────
        // The camera sits ~6 units out in the room, dollies to ~14 in space, and
        // the viewer can zoom closer still: about a 5x range of distance, and
        // therefore of sprite size. No single constant survives that. Sized for
        // the wide shot the specks become flakes the moment you zoom in; sized
        // for the zoom they are sub-pixel and invisible at the wide shot, which
        // is where the dissolve actually plays.
        //
        // So the DRAWN diameter is clamped to a legible band and the perspective
        // term only moves it inside that band. Distant specks stop shrinking with
        // depth — standard for dust and starfields, and their motion still
        // carries the depth cue.
        //
        // The clamp is on drawn ink, not on gl_PointSize, because the two modes
        // ink very different fractions of the same quad: flat fills the inscribed
        // circle (1.0), while the texture's wisp spans about 0.75 of it. Clamping
        // the quad would make the two modes different sizes for no reason.
        float ink    = mix(1.0, 0.45, uShiny);
        float inkCss = 30. * mix(1.0, 1.7, uShiny) * uSize * ink / -mvPos.z;
        // sizePulse applied AFTER the clamp, like sizeVariation: the clamp exists
        // to normalise for camera distance, and folding the pulse in first would
        // let it flatten the twinkle back out against the 3px floor.
        // The band is the CORE's diameter; the star's rays run out to the quad
        // edge, so the whole speck spans roughly 1/ink = 2.2x this.
        //
        // Then THREE multipliers stack on top — per-particle variation, the
        // twinkle flare, and the life shrink. Their product is what actually
        // reaches the screen, and forgetting that is how a 2px floor became a
        // 0.2px invisible one. The final max() is the backstop: whatever the
        // multipliers do, a live speck never falls under 1.5px. Disappearing at
        // the end of life is alpha's job, not something to leave to a size that
        // has quietly decayed to nothing.
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

        // ─── Shiny mode — a star glint, drawn procedurally ──────────────────
        // Replaces the demo's particle.png, which is a smoke-like WISP: ragged,
        // soft, no core and no rays. That is the opposite shape to a glint, and
        // it is why the specks read as fluff no matter how they were sized or
        // animated. A sparkle needs a small hard core with thin rays coming off
        // it; that shape is trivial to draw and impossible to get from that
        // texture.
        vec2  p = uv * 2.0;          // -1..1 across the quad
        float r = length(p);
        if (r > 1.0) discard;

        // Tight round core. This is the bright point the eye actually locks on.
        float core = exp(-r * r * 24.0);

        // Four screen-aligned spikes: thin ridges along the axes, tapering with
        // radius. 1/(1+|x|*k) gives a sharp ridge rather than the soft lobe a
        // gaussian would; fade^3 pulls the tips to nothing before the quad edge
        // so the sprite's square boundary never shows. Length varies per
        // particle so the field is not uniform, and rides vSparkle so the rays
        // extend and retract as the speck twinkles.
        float fade = max(0.0, 1.0 - r);
        float sx   = 1.0 / (1.0 + abs(p.x) * 110.0);
        float sy   = 1.0 / (1.0 + abs(p.y) * 110.0);
        float arms = (sx + sy) * fade * fade * fade * (0.6 + 0.8 * vRandom);

        float shape = core + arms * uSpikes * vSparkle;
        if (shape < 0.01) discard;

        // Each speck biased slightly warm or cool. Both stay multiples of
        // uParticleColor, so the GUI colour picker still drives the whole look.
        vec3 warm = uParticleColor * vec3(1.12, 1.00, .82);
        vec3 cool = uParticleColor * vec3(.84,  .93, 1.16);
        vec3 tint = mix(warm, cool, vRandom);

        // 0.8 keeps the core just under clipping so overlapping specks stay
        // separate instead of fusing into white (Particle Color dims further).
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
