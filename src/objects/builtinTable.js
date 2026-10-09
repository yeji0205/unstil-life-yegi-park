import * as THREE from 'three';
import { uProgress } from '../scene/phaseMachine.js';
import { FLOOR_COLOR } from '../scene/room.js';

// ─── Built-in tables: Box and Cylinder ───────────────────────────────────────
// Built with three.js (BoxGeometry, CylinderGeometry) instead of loaded from a
// GLB: plain white museum pedestals ("plinths"). Since no model file brings a
// material along, this file also provides their colour, uploaded textures (GUI
// "Table Material") and the shading where they touch the floor.

// Gallery-plinth white for the built-in tables: a matte, slightly warm
// museum pedestal rather than furniture.
const TABLE_MATERIAL_COLOR = 0xe8e4dc;
const TABLE_MATERIAL_ROUGHNESS = 0.95;

// Same surface height as table.glb, so objects stay in view when switching tables.
export const BUILTIN_TABLE_HEIGHT = 1.88;

// User-uploaded textures for the Box/Cylinder tables (any mix of map slots).
// Kept here so they survive switching between the two. GLB tables ignore them.
const textureLoader = new THREE.TextureLoader();
const builtinTableMaps = { map: null, normalMap: null, roughnessMap: null, bumpMap: null, metalnessMap: null };

// Base colour of the built-in tables, editable from the GUI colour picker.
// Kept out of TABLE_MATERIAL_COLOR (the default) so "reset" is still possible.
export const builtinTableColor = { hex: '#e8e4dc' };

// Copies every set map slot onto a built-in table's material (and whitens the
// base color when an albedo map is present so its true colors show).
export function applyBuiltinTableMaps(mat) {
    mat.map          = builtinTableMaps.map;
    mat.normalMap    = builtinTableMaps.normalMap;
    mat.roughnessMap = builtinTableMaps.roughnessMap;
    mat.bumpMap      = builtinTableMaps.bumpMap;
    mat.metalnessMap = builtinTableMaps.metalnessMap;
    // An albedo map is TINTED by color, so white lets the image show as itself;
    // without one, color IS the surface and takes the GUI value.
    mat.color.set(builtinTableMaps.map ? 0xffffff : builtinTableColor.hex);
    // metalness/roughness SCALE their maps, so lift them to 1 once a map exists.
    if (builtinTableMaps.metalnessMap) mat.metalness = 1.0;
    if (builtinTableMaps.roughnessMap) mat.roughness = 1.0;
}

// Stores one texture slot from a user-picked image, for every Box/Cylinder built
// from now on. Returns false for an unknown slot. tableSetup.js applies it live.
// type: 'map' (albedo/color) | 'normalMap' | 'roughnessMap' | 'bumpMap' | 'metalnessMap'.
export function loadBuiltinTableTexture(file, type) {
    if (!(type in builtinTableMaps)) return false;
    const url = URL.createObjectURL(file);
    const tex = textureLoader.load(url, () => URL.revokeObjectURL(url));
    // Albedo carries color (sRGB); normal/roughness/bump are linear data maps.
    tex.colorSpace = type === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    builtinTableMaps[type] = tex;
    return true;
}

// Material for the built-in tables — carries the user-uploaded texture (if any)
// so Box/Cylinder pick it up on every (re)build.
function buildBuiltinTableMaterial() {
    const mat = new THREE.MeshStandardMaterial({
        color: TABLE_MATERIAL_COLOR, roughness: TABLE_MATERIAL_ROUGHNESS, metalness: 0.0,
    });
    applyBuiltinTableMaps(mat); // carry over any user-uploaded maps
    return mat;
}

// isBuiltinTable marks the Box/Cylinder (centred, so their base is at -height/2),
// which get the contact shading below. GLB tables don't.
export function buildBoxTable() {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, BUILTIN_TABLE_HEIGHT, 1.6), buildBuiltinTableMaterial());
    mesh.userData.isBuiltinTable = true;
    return mesh;
}

export function buildCylinderTable() {
    const geometry = new THREE.CylinderGeometry(0.9, 0.9, BUILTIN_TABLE_HEIGHT, 32);
    const mesh = new THREE.Mesh(geometry, buildBuiltinTableMaterial());
    mesh.userData.isBuiltinTable = true;
    return mesh;
}

// ─── Contact shading where the table meets the floor ─────────────────────────
// Like the room's edge shading, so the table rests on the floor instead of
// looking pasted on. It tints toward the floor's brown (bounced light) rather
// than darkening, which would turn the white table grey. Exponential falloff:
// smoothstep ends at a visible line.
const FLOOR_CONTACT_REACH  = 0.55; // world units; where the tint is ~5% of peak
const FLOOR_CONTACT_AMOUNT = 0.24; // blend toward the floor colour at the contact line
const FLOOR_CONTACT_TINT   = new THREE.Color(FLOOR_COLOR); // the floor's base colour
// Gone by this p: there's no floor once the table floats.
const FLOOR_CONTACT_FADE_END = 0.30;

// The uniforms and varying the floor contact shading adds to the fragment shader.
const FLOOR_CONTACT_DECLARATIONS = [
    'uniform float uBaseY;', 'uniform float uBaseReach;', 'uniform float uBaseAmount;',
    'uniform vec3 uBaseTint;', 'uniform float uRoomP;', 'varying float vTableY;',
].join('\n') + '\n';

export function injectFloorContactShading(mat, height) {
    // Wrap rather than replace: injectDissolve already owns this hook.
    const previous = mat.onBeforeCompile;
    const uBaseY      = { value: -height / 2 };
    const uBaseReach  = { value: FLOOR_CONTACT_REACH };
    const uBaseAmount = { value: FLOOR_CONTACT_AMOUNT };
    const uBaseTint   = { value: FLOOR_CONTACT_TINT };

    mat.onBeforeCompile = (shader) => {
        previous?.(shader);
        shader.uniforms.uBaseY      = uBaseY;
        shader.uniforms.uBaseReach  = uBaseReach;
        shader.uniforms.uBaseAmount = uBaseAmount;
        shader.uniforms.uBaseTint   = uBaseTint;
        // The shared scroll progress, so the fade needs no per-frame update.
        shader.uniforms.uRoomP      = uProgress;

        // Local Y: the base is always at the same local height.
        shader.vertexShader = 'varying float vTableY;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vTableY = position.y;`
        );

        shader.fragmentShader =
            FLOOR_CONTACT_DECLARATIONS +
            shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                {
                    float d    = max(0.0, (vTableY - uBaseY) / uBaseReach);
                    float fade = 1.0 - smoothstep(0.0, ${FLOOR_CONTACT_FADE_END.toFixed(2)}, uRoomP);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, uBaseTint,
                                           exp(-3.0 * d) * uBaseAmount * fade);
                }`
            );
    };
}
