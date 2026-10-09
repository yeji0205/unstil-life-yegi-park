import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';
import { uNoiseFreq, uObjectDissolveEdge } from './dissolve.js';

// ─── Particles for the dissolve ──────────────────────────────────────────────
// Everything about the particles the table and objects shed while dissolving:
// their settings (GUI sliders), the particle shader (makeParticleMaterial), and
// where each particle starts on the model's surface and which way it flies.
// They use the same noise and edge as the surface dissolve (dissolve.js), so
// each particle appears exactly where a hole opens.

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

const objectParticleVertexShader = /* glsl */`
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

const objectParticleFragmentShader = /* glsl */`
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

export function makeParticleMaterial(progressUniform, timeUniform, {
    freqScale = 4.0, scaleUniform = { value: 1.0 }, streamStrength = 1.0, edgeUniform = uObjectDissolveEdge,
} = {}) {
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

// ─── Where the particles start, and the Points object ────────────────────────

// Builds particle positions/velocities sampled from a mesh's geometry, in
// the mesh's own local space, so particles stay attached correctly as it floats.
export function buildParticlesFromGeometry(root, count, { radial = false, velocityCompensation = 1.0 } = {}) {
    root.updateWorldMatrix(true, true);
    const worldInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

    // Collect every triangle with a running total of area, so particles can be
    // spread evenly over the surface. Sampling the vertices instead clustered
    // them wherever the mesh has few triangles (e.g. rings on a cylinder).
    const tris  = [];   // flat [ax,ay,az, bx,by,bz, cx,cy,cz] per triangle
    const cumul = [];   // cumulative area up to and including each triangle
    let totalArea = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
        const geom    = child.geometry;
        const posAttr = geom.getAttribute('position');
        const index   = geom.getIndex();
        const toLocal = new THREE.Matrix4().multiplyMatrices(worldInverse, child.matrixWorld);
        const triCount = (index ? index.count : posAttr.count) / 3;
        for (let t = 0; t < triCount; t++) {
            const i0 = index ? index.getX(t * 3)     : t * 3;
            const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
            a.fromBufferAttribute(posAttr, i0).applyMatrix4(toLocal);
            b.fromBufferAttribute(posAttr, i1).applyMatrix4(toLocal);
            c.fromBufferAttribute(posAttr, i2).applyMatrix4(toLocal);
            const area = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() * 0.5;
            if (area <= 0) continue;
            totalArea += area;
            tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            cumul.push(totalArea);
        }
    });

    if (tris.length === 0) return null; // guard: geometry had no triangles

    const positions  = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        // Area-weighted triangle pick (binary search the cumulative areas),
        // then a uniformly random barycentric point within that triangle.
        const target = Math.random() * totalArea;
        let lo = 0, hi = cumul.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cumul[mid] < target) lo = mid + 1; else hi = mid; }
        const o = lo * 9;
        let u = Math.random(), w = Math.random();
        if (u + w > 1) { u = 1 - u; w = 1 - w; } // reflect into the triangle
        const px = tris[o]     + u * (tris[o + 3] - tris[o])     + w * (tris[o + 6] - tris[o]);
        const py = tris[o + 1] + u * (tris[o + 4] - tris[o + 1]) + w * (tris[o + 7] - tris[o + 1]);
        const pz = tris[o + 2] + u * (tris[o + 5] - tris[o + 2]) + w * (tris[o + 8] - tris[o + 2]);
        positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;

        if (radial) {
            // Table: particles burst outward from the centre and scatter.
            // (`|| 1` avoids dividing by zero at the exact centre.)
            const r = Math.sqrt(px * px + pz * pz) || 1;
            const spread = Math.random() * 4.0 + 2.5; // 2.5–6.5
            velocities[i * 3]     = (px / r) * spread;
            velocities[i * 3 + 1] = Math.random() * 3.0 + 0.5;
            velocities[i * 3 + 2] = (pz / r) * spread;
        } else {
            // Random spread angle instead of radial — avoids thin objects (tulip stem) clustering
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 1.5 + 0.5;
            velocities[i * 3]     = Math.cos(angle) * speed * velocityCompensation;
            velocities[i * 3 + 1] = (Math.random() * 2.5 + 0.5) * velocityCompensation;
            velocities[i * 3 + 2] = Math.sin(angle) * speed * velocityCompensation;
        }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    return geom;
}

// Creates a particle Points object on the bloom layer. Always use this, or the
// glow pass won't see the particles.
export function makeParticlePoints(geometry, material) {
    const points = new THREE.Points(geometry, material);
    points.layers.set(PARTICLE_BLOOM_LAYER);
    return points;
}
