import * as THREE from 'three';
import { uProgress } from '../effects/dissolve.js';

// ─── The Box and Cylinder tables ("plinths") ─────────────────────────────────
// Simple museum pedestals built in code, instead of loaded from a GLB. Their
// colour and textures can be changed from the GUI ("Table Material").

// Gallery-plinth white for the Box/Cylinder tables: a matte, slightly warm
// museum pedestal rather than furniture.
const TABLE_MATERIAL_COLOR = 0xe8e4dc;
const TABLE_MATERIAL_ROUGHNESS = 0.95;

// Same surface height as table.glb, so objects stay in view when switching tables.
export const PRIMITIVE_TABLE_HEIGHT = 1.88;

// User-uploaded textures for the Box/Cylinder tables (any mix of map slots).
// Kept here so they survive switching between the two. GLB tables ignore them.
const textureLoader = new THREE.TextureLoader();
const primitiveTableMaps = { map: null, normalMap: null, roughnessMap: null, bumpMap: null, metalnessMap: null };

// Base colour of the Box/Cylinder plinths, editable from the GUI colour picker.
// Kept out of TABLE_MATERIAL_COLOR (the default) so "reset" is still possible.
export const primitiveTableColor = { hex: '#e8e4dc' };

// Copies every set map slot onto a primitive-table material (and whitens the
// base color when an albedo map is present so its true colors show).
export function applyPrimitiveMaps(mat) {
    mat.map          = primitiveTableMaps.map;
    mat.normalMap    = primitiveTableMaps.normalMap;
    mat.roughnessMap = primitiveTableMaps.roughnessMap;
    mat.bumpMap      = primitiveTableMaps.bumpMap;
    mat.metalnessMap = primitiveTableMaps.metalnessMap;
    // An albedo map is TINTED by color, so white lets the image show as itself;
    // without one, color IS the surface and takes the GUI value.
    mat.color.set(primitiveTableMaps.map ? 0xffffff : primitiveTableColor.hex);
    // metalness/roughness SCALE their maps, so lift them to 1 once a map exists.
    if (primitiveTableMaps.metalnessMap) mat.metalness = 1.0;
    if (primitiveTableMaps.roughnessMap) mat.roughness = 1.0;
}

// Stores one texture slot from a user-picked image, for every Box/Cylinder built
// from now on. Returns false for an unknown slot. table.js applies it live.
// type: 'map' (albedo/color) | 'normalMap' | 'roughnessMap' | 'bumpMap' | 'metalnessMap'.
export function loadPlinthTexture(file, type) {
    if (!(type in primitiveTableMaps)) return false;
    const url = URL.createObjectURL(file);
    const tex = textureLoader.load(url, () => URL.revokeObjectURL(url));
    // Albedo carries color (sRGB); normal/roughness/bump are linear data maps.
    tex.colorSpace = type === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    primitiveTableMaps[type] = tex;
    return true;
}

// Material for the primitive tables — carries the user-uploaded texture (if any)
// so Box/Cylinder pick it up on every (re)build.
function buildPrimitiveTableMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: TABLE_MATERIAL_COLOR, roughness: TABLE_MATERIAL_ROUGHNESS, metalness: 0.0 });
    applyPrimitiveMaps(mat); // carry over any user-uploaded maps
    return mat;
}

// isPlinth marks the Box/Cylinder (centred, so their base is at -height/2),
// which get the contact shading below. GLB tables don't.
export function buildBoxTable() {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, PRIMITIVE_TABLE_HEIGHT, 1.6), buildPrimitiveTableMaterial());
    mesh.userData.isPlinth = true;
    return mesh;
}

export function buildCylinderTable() {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, PRIMITIVE_TABLE_HEIGHT, 32), buildPrimitiveTableMaterial());
    mesh.userData.isPlinth = true;
    return mesh;
}

// ─── Contact shading where the plinth meets the floor ────────────────────────
// Like the room's edge shading, so the plinth rests on the floor instead of
// looking pasted on. It tints toward the floor's brown (bounced light) rather
// than darkening, which would turn the white plinth grey. Exponential falloff:
// smoothstep ends at a visible line.
const PLINTH_BASE_REACH  = 0.55; // world units; where the tint is ~5% of peak
const PLINTH_BASE_AMOUNT = 0.24; // blend toward the floor colour at the contact line
const PLINTH_BASE_TINT   = new THREE.Color(0x2e1c0e); // matches the floor plane's base colour
// Gone by this p: there's no floor once the table floats.
const PLINTH_BASE_FADE_END = 0.30;

export function injectPlinthBaseShading(mat, height) {
    // Wrap rather than replace: injectDissolve already owns this hook.
    const previous = mat.onBeforeCompile;
    const uBaseY      = { value: -height / 2 };
    const uBaseReach  = { value: PLINTH_BASE_REACH };
    const uBaseAmount = { value: PLINTH_BASE_AMOUNT };
    const uBaseTint   = { value: PLINTH_BASE_TINT };

    mat.onBeforeCompile = (shader) => {
        previous?.(shader);
        shader.uniforms.uBaseY      = uBaseY;
        shader.uniforms.uBaseReach  = uBaseReach;
        shader.uniforms.uBaseAmount = uBaseAmount;
        shader.uniforms.uBaseTint   = uBaseTint;
        // The shared scroll progress, so the fade needs no per-frame update.
        shader.uniforms.uRoomP      = uProgress;

        // Local Y: the base is always at the same local height.
        shader.vertexShader = 'varying float vPlinthY;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vPlinthY = position.y;`
        );

        shader.fragmentShader =
            'uniform float uBaseY;\nuniform float uBaseReach;\nuniform float uBaseAmount;\nuniform vec3 uBaseTint;\nuniform float uRoomP;\nvarying float vPlinthY;\n' +
            shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                {
                    float d    = max(0.0, (vPlinthY - uBaseY) / uBaseReach);
                    float fade = 1.0 - smoothstep(0.0, ${PLINTH_BASE_FADE_END.toFixed(2)}, uRoomP);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, uBaseTint,
                                           exp(-3.0 * d) * uBaseAmount * fade);
                }`
            );
    };
}
