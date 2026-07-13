import { NOISE_GLSL } from './noise.js';

// ─── Animated "Starry Night" background flow ─────────────────────────────────
// Inspired by Petros Vrellis' animated Van Gogh piece
// (https://artof01.com/vrellis/works/starry_night.html): rather than moving
// any geometry, each pixel samples the *same* texture at a slightly displaced
// UV, and that displacement is a swirling vector field that evolves over time.
//
// The field comes from the curl of a scalar noise potential — curl is
// automatically divergence-free, which is exactly what makes it look like
// swirling paint instead of the image just sliding around or tearing apart.

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

    // Each cube face is an independent flat texture, so a swirl direction on
    // one face has no matching direction on its neighbour across a 90° edge
    // — any nonzero warp right at the border reads as a seam. Fading the
    // warp to exactly 0 at the UV border means both faces agree there
    // (nothing moved), so the seam disappears.
    float flowEdgeFade(vec2 uv) {
        float margin = 0.14;
        vec2 d = smoothstep(0.0, margin, uv) * smoothstep(0.0, margin, 1.0 - uv);
        return d.x * d.y;
    }
`;

// Injects the flow-warped texture sample in place of Three.js's default
// map_fragment chunk. vMapUv already exists on any MeshBasicMaterial with a
// map assigned (declared by map_pars_fragment) — reused rather than adding
// a second varying for the same UV.
export function injectSkyboxFlow(material, cacheKey) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uFlowStrength = uFlowStrength;
        shader.uniforms.uFlowTime     = uFlowTime;

        shader.fragmentShader = `${NOISE_GLSL}\n${FLOW_GLSL}` + shader.fragmentShader;

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
                float flowAmount = uFlowStrength * flowEdgeFade(vMapUv);
                vec2 flowUv = vMapUv + curlFlow(vMapUv * 2.0) * 0.025 * flowAmount;
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
