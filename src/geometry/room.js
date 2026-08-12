import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { uProgress, injectDissolve } from '../render/dissolve.js';

// ─── Wall texture (PBR set) ───────────────────────────────────────────────────
// A physically-based material is several greyscale/colour images that each
// answer a different question about the surface:
//   diff  (colour)    — what colour is it?            → map
//   nor   (normal)    — which way does each point face? → normalMap  (fake relief)
//   rough (roughness) — how sharp is the reflection?    → roughnessMap
// Together they make a flat plane read as pitted, uneven plaster: the normal map
// perturbs the lighting per-pixel so the raking key light catches every bump,
// and the roughness map keeps worn patches from looking uniformly matte.
// Each surface type points at its own PBR folder. `tile` is how many WORLD UNITS
// one copy of the texture covers — tiling at a fixed world size keeps the grain
// at the same physical scale no matter how big the surface is, and choosing a
// value that divides the surface evenly means whole tiles with no cut-off edge.
//   walls: 14 × 7  ÷ 7   → 2 × 1 repeat (square tiles, low repetition)
//   floor: 14 × 14 ÷ 3.5 → 4 × 4 repeat (cobbles want a smaller, denser grain)
const SURFACE_TEXTURES = {
    wall:  { dir: 'asset/texture/red_plaster_weathered', base: 'red_plaster_weathered', tile: 7 },
    // This set's maps are all 3-channel DWAA, which EXRLoader handles. (Sets whose
    // roughness is a SINGLE-channel `Y` EXR with DWAA compression — stained_pine,
    // pebble — crash three's lossyDctDecode; those need `skip: ['roughnessMap']`
    // plus a constant `roughness`. The loader also detaches any map that fails at
    // runtime, so a bad file degrades instead of taking the surface down.)
    floor: { dir: 'asset/texture/weathered_planks', base: 'weathered_planks', tile: 3.5 },
};

// diff is a COLOUR image, so it must be tagged sRGB or it renders washed out.
// normal/roughness are DATA (directions and numbers, not colour) and must stay
// linear — mis-tagging these is the classic reason a normal map looks wrong.
function configureTexture(tex, { srgb = false, w, h, tile }) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // required before repeat can tile
    tex.repeat.set(w / tile, h / tile);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;

    // Mipmaps + anisotropy are what make a TILED texture hold together. Without
    // mipmaps the GPU point-samples a 1024² image squeezed into far fewer screen
    // pixels, and the sampling pattern beats against the tile grid — which showed
    // up as dark horizontal bands across the wall. EXRLoader ships its textures
    // with generateMipmaps = false, LinearFilter and anisotropy 1, so the normal
    // and roughness maps were aliasing while the mipmapped jpg tiled cleanly.
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8; // keeps the tiling sharp where a wall recedes at a grazing angle
    tex.needsUpdate = true;
    return tex;
}

// Loads one PBR set. Every surface of a given type shares these texture objects
// (all four walls are 14 × 7, so one repeat setting serves them all). The two
// EXRs need EXRLoader — TextureLoader only handles what the browser can decode
// natively (jpg/png/webp), and these sets ship normal + roughness as float EXR.
//
// Configuration happens in the LOAD CALLBACK, not on the object the loader
// returns up front: EXRLoader applies its own filtering defaults once the file
// has been parsed, which silently overwrote anything set beforehand.
const texLoader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();

function loadPbrTextures(kind, w, h) {
    const { dir, base, tile, skip = [], roughness } = SURFACE_TEXTURES[kind];
    // Materials register here so a map that fails to decode can be detached from
    // every material already using it. Without that, a broken texture stays bound
    // and the surface renders wrong — a failed roughness map took the whole floor
    // down to flat grey, diffuse and all.
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
// NOTE: the set also ships a displacement map (disp_1k.png). It's deliberately
// unused — displacement moves actual vertices, and these walls are a single
// two-triangle PlaneGeometry with no subdivisions to move. It would need
// PlaneGeometry(w, h, 200, 200) to show anything, which is a lot of geometry for
// an effect the normal map already fakes convincingly.

// Individual planes — FrontSide with inward-pointing normals so DirectionalLight works.
// See architecture.md "Why not BoxGeometry" for the lighting reasoning.
// Which edges of a plane get darkened, as (left, right, bottom, top) flags.
//
// Only the FLOOR junction is shaded. Darkening the wall corners and the ceiling
// line as well made the whole room feel closed-in and heavy — the shading read
// as grime rather than occlusion. The wall/floor seam is the one that genuinely
// needed it (that's where a real room has a shadow and where the two planes
// meet at a hard line), so walls darken only along their BOTTOM edge and the
// ceiling gets none at all. The floor keeps all four, since its whole perimeter
// IS that same junction seen from the other side.
// (Declared here, above roomParts, because roomParts reads them at module load —
// a `const` below would be in its temporal dead zone and throw.)
const EDGES_WALL_BOTTOM = [0, 0, 1, 0];
const EDGES_FLOOR       = [1, 1, 1, 1];
const EDGES_NONE        = [0, 0, 0, 0];

// `tex` picks a PBR set from SURFACE_TEXTURES; `edges` picks which sides get the
// corner shading. Every surface is textured now — the plaster wraps all four
// walls and the ceiling, with planks underfoot — so the room holds up from any
// camera angle rather than only the default one.
const roomParts = [
    // floor — weathered planks
    { w: 14, h: 14, pos: [0, -3.5,  0], rx: -Math.PI / 2, ry: 0,            color: 0x2e1c0e, tex: 'floor', edges: EDGES_FLOOR },
    // ceiling — same plaster, mostly in darkness above the key light
    { w: 14, h: 14, pos: [0,  3.5,  0], rx:  Math.PI / 2, ry: 0,            color: 0x1e1810, tex: 'wall',  edges: EDGES_NONE },
    // wall the camera faces (the one you see behind the table)
    { w: 14, h:  7, pos: [0,  0,   -7], rx: 0,            ry: 0,            color: 0x3d3520, tex: 'wall',  edges: EDGES_WALL_BOTTOM },
    // wall behind the camera
    { w: 14, h:  7, pos: [0,  0,    7], rx: 0,            ry: Math.PI,      color: 0x3d3520, tex: 'wall',  edges: EDGES_WALL_BOTTOM },
    // left wall
    { w: 14, h:  7, pos: [-7, 0,    0], rx: 0,            ry:  Math.PI / 2, color: 0x3d3520, tex: 'wall',  edges: EDGES_WALL_BOTTOM },
    // right wall
    { w: 14, h:  7, pos: [ 7, 0,    0], rx: 0,            ry: -Math.PI / 2, color: 0x3d3520, tex: 'wall',  edges: EDGES_WALL_BOTTOM },
];

function makeRoomMaterial(hex, texSet, w, h, edges) {
    const textures = texSet?.maps;
    const mat = new THREE.MeshStandardMaterial({
        // With a map present, `color` acts as a TINT multiplied over the texture
        // rather than the surface colour. White leaves the plaster its own
        // colour; the walls' original olive-brown would muddy it, so textured
        // walls pass white and keep their mood from the lighting instead.
        color: textures ? 0xffffff : hex,
        side:  THREE.FrontSide,
        transparent: true,
        // roughness SCALES roughnessMap when one is present, so it stays at 1.0
        // to let the map speak for itself. When a set has no roughness map (see
        // `skip` in SURFACE_TEXTURES) it supplies a constant instead.
        roughness: textures ? (texSet.roughness ?? 1.0) : 0.9,
        metalness: 0.0,
        ...(textures ?? {}),
    });
    // Register so a late texture-decode failure can detach itself (see loadPbrTextures).
    texSet?.users.push(mat);

    // Room dissolve uses world position — the hole sweeps through the wall in
    // place, unlike floating objects whose noise pattern rides with the mesh.
    injectDissolve(mat, uProgress, { space: 'world', freqScale: 1.0 });
    // Must come AFTER injectDissolve — it wraps that hook rather than replacing it.
    injectEdgeShading(mat, w, h, edges);

    // Each distinct material setup needs its own compiled program. The textured
    // flag has to be part of the key: a textured and an untextured wall compile
    // to genuinely different shaders (USE_MAP / USE_NORMALMAP), so keying on
    // colour alone would let one reuse the other's program. The plane's size is
    // in the key too, since the edge-shading margin is baked per surface size.
    mat.customProgramCacheKey = () => `${hex}_${textures ? 'tex' : 'flat'}_${w}x${h}`;
    return mat;
}

// ─── Corner shading (fake ambient occlusion) ──────────────────────────────────
// Where two planes meet there is nothing — they simply intersect at a
// mathematically sharp line, both fully lit, so the corner reads as a hard seam
// and the wall looks like it's floating on the floor.
//
// A real skirting board fixes that, but actual geometry sitting flush against
// the wall z-fights and jitters as the camera moves. This does it in the shader
// instead: darken each plane toward its own edges. That's what ambient occlusion
// would compute — less light reaches a crevice — just derived from "how close am
// I to the edge of this surface" rather than from an expensive depth buffer.
// It costs a handful of instructions, has no geometry to fight, and softens the
// wall/wall and wall/floor seams into shadow instead of a visible line.
const EDGE_MARGIN = 1.3;  // world units over which the darkening fades in
const EDGE_DARK   = 0.45; // brightness right at the edge (1 = no darkening)


// Wraps whatever onBeforeCompile is already on the material (injectDissolve sets
// one) rather than replacing it — only one such hook exists per material, so the
// dissolve and this effect have to share it.
function injectEdgeShading(mat, w, h, edges) {
    const previous = mat.onBeforeCompile;
    // Margin expressed in UV space, which differs per axis on a non-square plane.
    const uEdgeMargin = { value: new THREE.Vector2(EDGE_MARGIN / w, EDGE_MARGIN / h) };
    const uEdgeSides  = { value: new THREE.Vector4(...edges) };

    mat.onBeforeCompile = (shader) => {
        previous?.(shader);
        shader.uniforms.uEdgeMargin = uEdgeMargin;
        shader.uniforms.uEdgeSides  = uEdgeSides;

        // The raw `uv` attribute, NOT vMapUv: the textures tile (repeat 2×1), so
        // vMapUv runs 0→2 and would darken every tile boundary. uv runs 0→1 once
        // across the whole plane, which is what "distance to the edge" needs.
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
                    // uEdgeSides switches each edge on (1) or off (0); an edge
                    // that's off contributes 1.0, i.e. no darkening. Multiplying
                    // the survivors darkens corners more than a single edge,
                    // which is how occlusion actually behaves.
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
// Every surface material, grouped by kind, together with the size it was built
// at. The size matters: `repeat` lives on the texture object, so a user image
// applied to both the 14 × 7 walls and the 14 × 14 ceiling needs a separate
// texture instance per size or one of them tiles wrong.
const surfaceRegistry = { wall: [], floor: [] };

// GUI label → the MeshStandardMaterial slot it drives.
export const ROOM_TEXTURE_SLOTS = {
    'Color / Albedo': 'map',
    'Normal':         'normalMap',
    'Roughness':      'roughnessMap',
    'Height / Bump':  'bumpMap',
};
export const ROOM_SURFACES = ['wall', 'floor'];

// Applies a user-picked image to one map slot across every surface of a kind.
// Accepts anything the browser can decode (jpg/png/webp) — EXR would need
// EXRLoader, which is what the built-in sets use, but file pickers realistically
// hand us ordinary images.
export function setRoomTexture(kind, slotLabel, file) {
    const slot    = ROOM_TEXTURE_SLOTS[slotLabel];
    const entries = surfaceRegistry[kind];
    if (!slot || !entries?.length) return;

    const url = URL.createObjectURL(file);
    texLoader.load(url, (tex) => {
        URL.revokeObjectURL(url);
        entries.forEach(({ mat, w, h, tile }, i) => {
            // Clone per surface so each can carry its own repeat; clones share
            // the decoded image, so this costs no extra download.
            const t = i === 0 ? tex : tex.clone();
            t.needsUpdate = true;
            configureTexture(t, { srgb: slot === 'map', w, h, tile });
            mat[slot] = t;
            // A colour map is TINTED by material.color, and roughnessMap is
            // SCALED by material.roughness — reset both so the uploaded image
            // shows as itself rather than being multiplied by an old value.
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

// Puts a surface back to the textures it shipped with, undoing any uploads.
// Restores colour and roughness too, since setRoomTexture whitens the tint when
// an albedo map is applied and lifts roughness to 1 for a roughness map — reset
// would otherwise leave a white, uniformly-rough wall wearing its old texture.
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

// Room dissolve uses shader only — no particles on room walls (see architecture.md).
export function buildRoom(scene) {
    // Cache PBR sets per (texture kind + surface size). The four walls are all
    // 14 × 7 so they share one set, but the ceiling uses the same plaster at
    // 14 × 14 and needs its own `repeat` — and repeat lives on the texture
    // object, so differently-sized surfaces can't share one.
    const sets = new Map();
    const setFor = (kind, w, h) => {
        const key = `${kind}_${w}x${h}`;
        if (!sets.has(key)) sets.set(key, loadPbrTextures(kind, w, h));
        return sets.get(key);
    };

    roomParts.forEach(({ w, h, pos, rx, ry, color, tex, edges }) => {
        const material = makeRoomMaterial(color, tex ? setFor(tex, w, h) : null, w, h, edges ?? EDGES_NONE);
        if (tex) {
            // Snapshot the built-in look BEFORE any upload can replace it, so
            // "Reset" has something to put back. The texture objects are captured
            // by reference and are still loading at this point — that's fine, the
            // same objects finish loading and remain valid to restore later.
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
