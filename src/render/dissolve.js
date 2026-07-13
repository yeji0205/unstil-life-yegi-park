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

// Injects the Codrops noise-dissolve technique into any MeshStandardMaterial
// (or similar) via onBeforeCompile. Replaces three near-identical blocks that
// used to live on the room, table, and stage-object materials.
//
// space: 'world' — noise follows world position (room walls dissolve in place)
//        'local' — noise rides with the mesh (floating objects keep their pattern)
// freqScale: extra multiplier on uFreq (table/objects use a tighter noise scale)
export function injectDissolve(material, progressUniform, { space = 'local', freqScale = 1.0 } = {}) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uProgress  = progressUniform;
        shader.uniforms.uEdge      = uDissolveEdge;
        shader.uniforms.uFreq      = uNoiseFreq;
        shader.uniforms.uEdgeColor = uDissolveEdgeColor;

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
             uniform vec3  uEdgeColor;
             varying vec3  vDissolvePos;
             ${NOISE_GLSL}` +
            shader.fragmentShader;

        // Apply dissolve after Three.js computes the lit colour
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>

            if (uProgress > 0.01) {
                float threshold = mix(-1.2, 1.2, uProgress);
                float noise     = snoise3(vDissolvePos * uFreq * ${freqScale.toFixed(4)});

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
export const uParticleColor = { value: new THREE.Color(0xffffff) }; // bright white

export const objectParticleVertexShader = /* glsl */`
    attribute vec3  aVelocity;
    uniform float   uObjectProgress;
    uniform float   uEdge;
    uniform float   uFreq;
    uniform float   uTime;
    varying float   vAlpha;
    ${NOISE_GLSL}

    void main(){
        float threshold    = mix(-1.2, 1.2, uObjectProgress);
        float noise        = snoise3(position * uFreq * 4.0);
        float distFromEdge = noise - threshold;
        float driftBand    = uEdge * 1.5;

        if(distFromEdge > uEdge || distFromEdge < -driftBand){
            gl_Position  = vec4(9999., 9999., 9999., 1.);
            gl_PointSize = 0.;
            vAlpha       = 0.;
            return;
        }

        float t   = clamp(-distFromEdge / driftBand, 0., 1.);
        vec3  pos = position + aVelocity * t;

        // Sine-wave wiggle (Codrops)
        pos.x += sin(position.y * 3.0 + uTime * 2.0) * 0.05 * t;
        pos.z += cos(position.x * 3.0 + uTime * 1.7) * 0.05 * t;

        vAlpha = 1. - t;

        vec4 mvPos   = modelViewMatrix * vec4(pos, 1.);
        gl_PointSize = max(2., 60. / -mvPos.z);
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
        gl_FragColor = vec4(uParticleColor, alpha);
    }
`;

export function makeParticleMaterial(progressUniform, timeUniform) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uObjectProgress: progressUniform,
            uEdge:           uDissolveEdge,
            uFreq:           uNoiseFreq,
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
