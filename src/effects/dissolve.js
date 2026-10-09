import * as THREE from 'three';
import { NOISE_GLSL } from './noise.js';

// Noise dissolve for the room, table and objects: holes that open in the surface
// and its shadow. The particles they shed are in dissolveParticles.js.
//
// Based on: "Implementing a Dissolve Effect with Shaders and Particles in
// Three.js", Codrops, 17 Feb 2025.
// https://tympanus.net/codrops/2025/02/17/implementing-a-dissolve-effect-with-shaders-and-particles-in-three-js/

// ─── Shared dissolve uniforms ────────────────────────────────────────────────
// GUI-tunable values shared by every dissolve shader. The room dissolves with the
// central uProgress (scene/phaseMachine.js); the table and each object own their
// own progress uniform so they can dissolve independently.
export const uNoiseFreq         = { value: 0.35 };

// Edge width. While a surface dissolves, a thin coloured band (the "edge") is
// drawn along the border of each hole, just before that part disappears.
export const uDissolveEdge       = { value: 0.25 };  // room walls
export const uObjectDissolveEdge = { value: 0.10 };  // table + still-life objects
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
// are made transparent only while dissolving. three.js compiles a separate shader
// for the transparent version, so both versions are compiled in advance (see
// precompileDissolveShaders below and warmUpShaders in main.js); otherwise the
// first switch freezes a frame.
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
        // Set in objects/tableSetup.js and objectsSetup.js before the dissolve forces transparency on.
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
export function injectDissolve(material, progressUniform, {
    space = 'local', freqScale = 1.0, scaleUniform = { value: 1.0 },
    edgeUniform = uDissolveEdge, edgeColorUniform = uDissolveEdgeColor,
    edgeFollowUniform = EDGE_FOLLOW_OFF, edgeGainUniform = EDGE_GAIN_UNUSED,
    localMatrixUniform = IDENTITY_MATRIX,
} = {}) {
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
// Set as the mesh's customDepthMaterial (see objects/tableSetup.js and objectsSetup.js).
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

// ─── Dissolve on one mesh of a loaded model (table and still-life objects) ───
// Gives the mesh its own copy of the material with the dissolve, and a shadow
// that dissolves the same way (same noise, same options). The noise is read in
// the model root's space, so the pattern stays on the model as it floats and its
// particles read the same noise. Returns the new material.
export function addMeshDissolve(mesh, root, progressUniform, {
    material = mesh.material.clone(), freqScale, scaleUniform = { value: 1.0 },
    cacheKey, depthCacheKey = cacheKey + '_depth',
}) {
    // Remember if the material needs transparency anyway (e.g. cut-out leaves),
    // so it's never made opaque between dissolves.
    material.userData.ownsAlpha = material.transparent === true || material.alphaTest > 0
        || (material.opacity ?? 1) < 1 || !!material.alphaMap;
    material.transparent = true;

    const meshToRoot = new THREE.Matrix4()
        .multiplyMatrices(new THREE.Matrix4().copy(root.matrixWorld).invert(), mesh.matrixWorld);
    const localMatrixUniform = { value: meshToRoot };
    injectDissolve(material, progressUniform, {
        space: 'local', freqScale, scaleUniform, localMatrixUniform,
        edgeUniform: uObjectDissolveEdge, edgeColorUniform: uObjectDissolveEdgeColor,
        edgeFollowUniform: uObjectEdgeFollow, edgeGainUniform: uObjectEdgeGain,
    });
    // Stable key (not the uuid): what differs between meshes is uniforms, which
    // don't change the compiled shader, so a swap reuses it instead of recompiling.
    material.customProgramCacheKey = () => cacheKey;
    mesh.customDepthMaterial = makeDissolveDepthMaterial(progressUniform, {
        space: 'local', freqScale, scaleUniform, localMatrixUniform, cacheKey: depthCacheKey,
    });
    mesh.material = material;
    return material;
}

// Compiles both shader versions (opaque, and transparent while dissolving) for
// the dissolve materials inside `root`, without drawing anything. For models
// loaded while the scene is on screen (swapped stones, the objects that come
// back), so their first dissolve doesn't freeze a frame. compileAsync compiles in
// the background where the browser supports it.
export function precompileDissolveShaders(renderer, root, camera, scene) {
    const inRoot = new Set();
    root.traverse((child) => {
        if (!child.isMesh) return;
        for (const m of Array.isArray(child.material) ? child.material : [child.material]) inRoot.add(m);
    });
    const materials = dissolveMaterials.filter((e) => inRoot.has(e.material)).map((e) => e.material);
    for (const transparent of [false, true]) {
        for (const m of materials) m.transparent = transparent || !!m.userData.ownsAlpha;
        renderer.compileAsync(root, camera, scene).catch(() => { /* drawn later anyway */ });
    }
    updateDissolveTransparency(); // back to what each material's progress needs
}
