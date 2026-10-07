import { NOISE_GLSL } from './noise.js';

// ─── Animated "Starry Night" background flow ─────────────────────────────────
// Inspired by Petros Vrellis' animated Van Gogh piece
// (https://artof01.com/vrellis/works/starry_night.html): rather than moving
// any geometry, each pixel samples the *same* texture at a slightly displaced
// UV, and that displacement is a swirling vector field that evolves over time.
//
// The field is the curl of a noise function: curl never converges or spreads,
// so it swirls like paint instead of sliding or tearing the image.

export const uFlowStrength = { value: 0.0 }; // eased 0→1 by updateSkyboxFlow()
export const uFlowTime     = { value: 0.0 };

// Shared toggle: the GUI button flips `enabled`; updateSkyboxFlow() eases
// uFlowStrength toward 0 or 1 every frame so turning it on/off doesn't snap.
export const flowState = { enabled: false };

const FLOW_GLSL = /* glsl */`
    uniform float uFlowStrength;
    uniform float uFlowTime;

    // Curl of snoise3(p, t) with respect to (x, y) — a 2D divergence-free
    // flow field that slowly reshapes itself as uFlowTime advances.
    // The 0.015 time coefficient keeps the field evolving slowly, rather
    // than reshuffling every second.
    vec2 curlFlow(vec2 p) {
        float e = 0.06;
        float t = uFlowTime * 0.015;
        float n1 = snoise3(vec3(p.x, p.y + e, t));
        float n2 = snoise3(vec3(p.x, p.y - e, t));
        float n3 = snoise3(vec3(p.x + e, p.y, t));
        float n4 = snoise3(vec3(p.x - e, p.y, t));
        return vec2(n1 - n2, -(n3 - n4)) / (2.0 * e);
    }

    // The swirl fades to 0 at each face's border; otherwise neighbouring faces
    // would warp differently at the shared edge and show a seam.
    float flowEdgeFade(vec2 uv) {
        float margin = 0.14;
        vec2 d = smoothstep(0.0, margin, uv) * smoothstep(0.0, margin, 1.0 - uv);
        return d.x * d.y;
    }
`;

// Replaces three's texture read (map_fragment) with the swirled one, reusing
// its existing vMapUv.
export function injectSkyboxFlow(material, cacheKey) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uFlowStrength = uFlowStrength;
        shader.uniforms.uFlowTime     = uFlowTime;

        shader.fragmentShader = `${NOISE_GLSL}\n${FLOW_GLSL}` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
                // The swirl costs 4 noise calls per pixel, so skip it when off
                // (the default) and do a plain texture read.
                vec2 flowUv = vMapUv;
                float flowAmount = uFlowStrength * flowEdgeFade(vMapUv);
                if (flowAmount > 0.001) {
                    flowUv += curlFlow(vMapUv * 2.0) * 0.025 * flowAmount;
                }
                vec4 sampledDiffuseColor = texture2D( map, flowUv );
                diffuseColor *= sampledDiffuseColor;
            #endif`
        );
    };
    material.customProgramCacheKey = () => cacheKey;
}

// Called once per frame. Advances the flow field and eases its strength
// toward 0 (off) or 1 (on) so toggling the GUI button fades smoothly.
export function updateSkyboxFlow(t) {
    uFlowTime.value = t;
    const target = flowState.enabled ? 1.0 : 0.0;
    uFlowStrength.value += (target - uFlowStrength.value) * 0.03;
}
