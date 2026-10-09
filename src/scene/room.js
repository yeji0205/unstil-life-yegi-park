import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { injectDissolve } from '../effects/dissolve.js';
import { uProgress } from './phaseMachine.js';

// The room: six textured planes that dissolve with the scroll, with darkened
// floor seams. Wall and floor textures can be replaced from the GUI.

// ─── Wall texture (PBR set) ───────────────────────────────────────────────────
// Each surface uses three images:
//   diff  (colour)    → map
//   nor   (normal)    → normalMap     fake bumps that catch the light
//   rough (roughness) → roughnessMap  how shiny each spot is
// `tile` = how many world units one copy of the texture covers, so the grain is
// the same size on every surface. Values divide the surfaces evenly:
//   walls: 14 × 7  ÷ 7   → 2 × 1 repeat
//   floor: 14 × 14 ÷ 3.5 → 4 × 4 repeat (smaller, denser planks)
const SURFACE_TEXTURES = {
    wall:  { dir: 'asset/texture/red_plaster_weathered', base: 'red_plaster_weathered', tile: 7 },
    // Note for other texture sets: single-channel DWAA roughness EXRs crash
    // EXRLoader; use `skip: ['roughnessMap']` plus a constant `roughness`.
    floor: { dir: 'asset/texture/weathered_planks', base: 'weathered_planks', tile: 3.5 },
};

// The colour map must be sRGB, or it looks washed out. Normal and roughness are
// data, not colour, and must stay linear.
function configureTexture(tex, { srgb = false, w, h, tile }) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // required before repeat can tile
    tex.repeat.set(w / tile, h / tile);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;

    // Mipmaps + anisotropy keep a tiled texture clean; without them it showed
    // dark bands. EXRLoader turns mipmaps off by default, so they're set here.
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8; // keeps the tiling sharp where a wall recedes at a grazing angle
    tex.needsUpdate = true;
    return tex;
}

// Loads one PBR set. Normal and roughness are EXR files, which need EXRLoader.
// Settings are applied in the load callback, because EXRLoader overwrites
// anything set before the file is parsed.
const texLoader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();

function loadPbrTextures(kind, w, h) {
    const { dir, base, tile, skip = [], roughness } = SURFACE_TEXTURES[kind];
    // Materials using this set register here, so a map that fails to load can be
    // removed from all of them (a broken map otherwise turns the surface grey).
    const set = { maps: {}, users: [], roughness };

    const attach = (slot, loader, suffix, srgb = false) => {
        if (skip.includes(slot)) return;
        set.maps[slot] = loader.load(
            `${dir}/${base}_${suffix}`,
            (tex) => configureTexture(tex, { srgb, w, h, tile }),
            undefined,
            () => {
                console.warn(`Room texture "${base}_${suffix}" failed to decode — continuing without ${slot}.`);
                set.maps[slot] = null;
                set.users.forEach((m) => { m[slot] = null; m.needsUpdate = true; });
            }
        );
    };
    attach('map',          texLoader, 'diff_1k.jpg', true);
    attach('normalMap',    exrLoader, 'nor_gl_1k.exr');
    attach('roughnessMap', exrLoader, 'rough_1k.exr');
    return set;
}
// The sets also include a displacement map, unused: the planes have no extra
// vertices to move, and the normal map already fakes the relief.

// Six separate planes, each with its own size, texture, colour and edge shading.
// Which edges of a plane get darkened, as (left, right, bottom, top) flags.
// Base colour of the floor (dark brown under the planks texture). Also used by
// the built-in tables' floor contact shading, so their tint matches the floor.
export const FLOOR_COLOR = 0x2e1c0e;
// Base colour of the four walls (warm dark plaster under the texture).
const WALL_COLOR = 0x3d3520;

// Only the wall/floor seam is shaded; darkening every corner made the room feel
// heavy. Declared above roomParts, which reads them at load time.
const EDGES_WALL_BOTTOM = [0, 0, 1, 0];
const EDGES_FLOOR       = [1, 1, 1, 1];
const EDGES_NONE        = [0, 0, 0, 0];

// `tex` picks a texture set from SURFACE_TEXTURES; `edges` picks which sides are
// darkened.
const roomParts = [
    // floor — weathered planks
    { w: 14, h: 14, pos: [0, -3.5,  0], rx: -Math.PI / 2, ry: 0,
      color: FLOOR_COLOR, tex: 'floor', edges: EDGES_FLOOR },
    // ceiling — same plaster, mostly in darkness above the key light
    { w: 14, h: 14, pos: [0,  3.5,  0], rx:  Math.PI / 2, ry: 0,
      color: 0x1e1810,    tex: 'wall',  edges: EDGES_NONE },
    // wall the camera faces (the one you see behind the table)
    { w: 14, h:  7, pos: [0,  0,   -7], rx: 0,            ry: 0,
      color: WALL_COLOR,  tex: 'wall',  edges: EDGES_WALL_BOTTOM },
    // wall behind the camera
    { w: 14, h:  7, pos: [0,  0,    7], rx: 0,            ry: Math.PI,
      color: WALL_COLOR,  tex: 'wall',  edges: EDGES_WALL_BOTTOM },
    // left wall
    { w: 14, h:  7, pos: [-7, 0,    0], rx: 0,            ry:  Math.PI / 2,
      color: WALL_COLOR,  tex: 'wall',  edges: EDGES_WALL_BOTTOM },
    // right wall
    { w: 14, h:  7, pos: [ 7, 0,    0], rx: 0,            ry: -Math.PI / 2,
      color: WALL_COLOR,  tex: 'wall',  edges: EDGES_WALL_BOTTOM },
];

function makeRoomMaterial(hex, texSet, w, h, edges) {
    const textures = texSet?.maps;
    const mat = new THREE.MeshStandardMaterial({
        // With a texture, `color` tints it; white keeps the texture's own colour.
        color: textures ? 0xffffff : hex,
        side:  THREE.FrontSide,
        transparent: true,
        // `roughness` multiplies a roughness map, so 1.0 leaves the map as it is.
        roughness: textures ? (texSet.roughness ?? 1.0) : 0.9,
        metalness: 0.0,
        ...(textures ?? {}),
    });
    // Register so a late texture-decode failure can detach itself (see loadPbrTextures).
    texSet?.users.push(mat);

    // World space: the room's holes stay fixed in place, unlike the objects'.
    injectDissolve(mat, uProgress, { space: 'world', freqScale: 1.0 });
    // Must come AFTER injectDissolve — it wraps that hook rather than replacing it.
    injectEdgeShading(mat, w, h, edges);

    // Textured/flat and plane size change the compiled shader, so both are in the key.
    mat.customProgramCacheKey = () => `${hex}_${textures ? 'tex' : 'flat'}_${w}x${h}`;
    return mat;
}

// ─── Edge shading (fake ambient occlusion) ────────────────────────────────────
// Two planes meeting at a corner are both fully lit, so the seam looks like a
// hard line. Darkening each plane toward its edges imitates the shadow a real
// corner has, at almost no cost and with no extra geometry.
const EDGE_MARGIN = 1.3;  // world units over which the darkening fades in
const EDGE_DARK   = 0.45; // brightness right at the edge (1 = no darkening)


// Wraps the existing onBeforeCompile (set by injectDissolve) instead of replacing it.
function injectEdgeShading(mat, w, h, edges) {
    const previous = mat.onBeforeCompile;
    // Margin expressed in UV space, which differs per axis on a non-square plane.
    const uEdgeMargin = { value: new THREE.Vector2(EDGE_MARGIN / w, EDGE_MARGIN / h) };
    const uEdgeSides  = { value: new THREE.Vector4(...edges) };

    mat.onBeforeCompile = (shader) => {
        previous?.(shader);
        shader.uniforms.uEdgeMargin = uEdgeMargin;
        shader.uniforms.uEdgeSides  = uEdgeSides;

        // The plane's own uv (0→1 once), not the tiled texture uv, which would
        // darken every tile boundary.
        shader.vertexShader = 'varying vec2 vEdgeUv;\n' + shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vEdgeUv = uv;`
        );

        shader.fragmentShader =
            'uniform vec2 uEdgeMargin;\nuniform vec4 uEdgeSides;\nvarying vec2 vEdgeUv;\n' +
            shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                {
                    // lo = nearness to the uv=0 edges, hi = to the uv=1 edges;
                    // 0 at the very edge → 1 once further in than the margin.
                    vec2 lo = smoothstep(vec2(0.0), uEdgeMargin, vEdgeUv);
                    vec2 hi = smoothstep(vec2(0.0), uEdgeMargin, 1.0 - vEdgeUv);
                    // Edges switched off count as 1 (no darkening). Multiplying
                    // makes corners darker than a single edge, like real shadow.
                    float f = mix(1.0, lo.x, uEdgeSides.x)
                            * mix(1.0, hi.x, uEdgeSides.y)
                            * mix(1.0, lo.y, uEdgeSides.z)
                            * mix(1.0, hi.y, uEdgeSides.w);
                    gl_FragColor.rgb *= mix(${EDGE_DARK.toFixed(3)}, 1.0, f);
                }`
            );
    };
}

// ─── User-supplied room textures ──────────────────────────────────────────────
// Every surface material by kind, with its size: `repeat` lives on the texture,
// so differently sized surfaces each need their own texture instance.
const surfaceRegistry = { wall: [], floor: [] };

// GUI label → the MeshStandardMaterial slot it drives.
export const ROOM_TEXTURE_SLOTS = {
    'Color / Albedo': 'map',
    'Normal':         'normalMap',
    'Roughness':      'roughnessMap',
    'Height / Bump':  'bumpMap',
};
export const ROOM_SURFACES = ['wall', 'floor'];

// Applies a user's image (jpg/png/webp) to one map slot on every surface of a kind.
export function setRoomTexture(kind, slotLabel, file) {
    const slot    = ROOM_TEXTURE_SLOTS[slotLabel];
    const entries = surfaceRegistry[kind];
    if (!slot || !entries?.length) return;

    const url = URL.createObjectURL(file);
    texLoader.load(url, (tex) => {
        URL.revokeObjectURL(url);
        entries.forEach(({ mat, w, h, tile }, i) => {
            // One clone per surface for its own repeat; clones share the image.
            const t = i === 0 ? tex : tex.clone();
            t.needsUpdate = true;
            configureTexture(t, { srgb: slot === 'map', w, h, tile });
            mat[slot] = t;
            // Reset the tint and roughness multiplier, so the image shows as itself.
            if (slot === 'map')          mat.color.set(0xffffff);
            if (slot === 'roughnessMap') mat.roughness = 1.0;
            if (slot === 'bumpMap')      mat.bumpScale = 0.04;
            mat.needsUpdate = true;
        });
    }, undefined, () => {
        URL.revokeObjectURL(url);
        console.warn(`Couldn't load that image for the ${kind} ${slotLabel} map.`);
    });
}

// Restores a surface's original textures, colour and roughness.
export function resetRoomTextures(kind) {
    surfaceRegistry[kind]?.forEach(({ mat, original }) => {
        mat.map          = original.map;
        mat.normalMap    = original.normalMap;
        mat.roughnessMap = original.roughnessMap;
        mat.bumpMap      = original.bumpMap;
        mat.color.copy(original.color);
        mat.roughness    = original.roughness;
        mat.needsUpdate  = true;
    });
}

// The room dissolves by shader only; it has no particles.
export function buildRoom(scene) {
    // One texture set per (kind, size), since `repeat` depends on the size: the
    // walls share one, the ceiling (same plaster, 14 × 14) needs its own.
    const sets = new Map();
    const setFor = (kind, w, h) => {
        const key = `${kind}_${w}x${h}`;
        if (!sets.has(key)) sets.set(key, loadPbrTextures(kind, w, h));
        return sets.get(key);
    };

    roomParts.forEach(({ w, h, pos, rx, ry, color, tex, edges }) => {
        const material = makeRoomMaterial(color, tex ? setFor(tex, w, h) : null, w, h, edges ?? EDGES_NONE);
        if (tex) {
            // Remember the original look for "Reset", before any upload replaces it.
            surfaceRegistry[tex].push({
                mat: material, w, h, tile: SURFACE_TEXTURES[tex].tile,
                original: {
                    map:          material.map ?? null,
                    normalMap:    material.normalMap ?? null,
                    roughnessMap: material.roughnessMap ?? null,
                    bumpMap:      material.bumpMap ?? null,
                    color:        material.color.clone(),
                    roughness:    material.roughness,
                },
            });
        }
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
        mesh.position.set(...pos);
        mesh.rotation.x = rx;
        mesh.rotation.y = ry;
        mesh.receiveShadow = true;
        scene.add(mesh);
    });
}
