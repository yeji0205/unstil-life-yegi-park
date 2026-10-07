import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJECT_LIGHT_LAYER } from '../scene/lighting.js';
import { injectDissolve, makeDissolveDepthMaterial, makeParticleMaterial, forgetDissolveMaterials, uProgress, uObjectDissolveEdge, uObjectDissolveEdgeColor, uObjectEdgeFollow, uObjectEdgeGain, PARTICLE_BLOOM_LAYER } from '../effects/dissolve.js';

// Loads and manages the table and the still-life objects: placement on the table,
// dissolve shaders, particles, table and stone swapping, and the objects that
// change on each return from space.

const TABLE_PARTICLE_COUNT  = 2000;

// Stage-object dissolve settings. A lower noise frequency gives bigger blobs, so
// small objects don't break into unreadable dots. Particle count scales with each
// object's size.
const OBJECT_FREQ_SCALE        = 2.0;
const OBJECT_PARTICLE_PER_UNIT = 550;   // particles per unit of world bounding-box diagonal
const OBJECT_PARTICLE_MIN      = 200;
const OBJECT_PARTICLE_MAX      = 900;

const uTableProgress = { value: 0.0 };
const uTableTime     = { value: 0.0 };

// One loader for every GLB (they're stateless).
const gltfLoader = new GLTFLoader();

// The current table, updated in place when it loads or is swapped.
export const tableState = {
    object:     null, // set once the table loads
    kind:       'glb', // 'glb' | 'box' | 'cylinder' | 'custom' — tracks the current table
    floorY:     -3.5, // resting Y, updated after load
    floorZ:      0.0, // resting Z, updated after load
    topOffset:   0.0, // table surface Y above its pivot (for the table collision)
    uProgress:  uTableProgress,
    uTime:      uTableTime,
};

// User-uploaded textures for the Box/Cylinder tables (any mix of map slots).
// Kept here so they survive switching between the two. GLB tables ignore them.
const textureLoader = new THREE.TextureLoader();
const primitiveTableMaps = { map: null, normalMap: null, roughnessMap: null, bumpMap: null, metalnessMap: null };

// Base colour of the Box/Cylinder plinths, editable from the GUI colour picker.
// Kept out of TABLE_MATERIAL_COLOR (the default) so "reset" is still possible.
export const primitiveTableColor = { hex: '#e8e4dc' };

// Copies every set map slot onto a primitive-table material (and whitens the
// base color when an albedo map is present so its true colors show).
function applyPrimitiveMaps(mat) {
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

// Sets one texture slot on the primitive tables from a user-picked image.
// type: 'map' (albedo/color) | 'normalMap' | 'roughnessMap' | 'bumpMap' | 'metalnessMap'.
// Applies live to the current Box/Cylinder and persists for future rebuilds.
export function setTableTexture(scene, file, type = 'map') {
    if (!(type in primitiveTableMaps)) return;
    const url = URL.createObjectURL(file);
    const tex = textureLoader.load(url, () => URL.revokeObjectURL(url));
    // Albedo carries color (sRGB); normal/roughness/bump are linear data maps.
    tex.colorSpace = type === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    primitiveTableMaps[type] = tex;

    if ((tableState.kind === 'box' || tableState.kind === 'cylinder') && tableState.object) {
        tableState.object.traverse((c) => {
            if (!c.isMesh) return;
            applyPrimitiveMaps(c.material);
            c.material.needsUpdate = true;
        });
    }
}

// Repaints the Box/Cylinder plinths from the GUI colour picker.
export function setTableColor(hex) {
    primitiveTableColor.hex = hex;
    if ((tableState.kind === 'box' || tableState.kind === 'cylinder') && tableState.object) {
        tableState.object.traverse((c) => {
            if (!c.isMesh) return;
            applyPrimitiveMaps(c.material);
            c.material.needsUpdate = true;
        });
    }
}

// One entry per loaded stage object (see the `entry` built in loadStageObject).
export const stageObjects = [];

// The still-life objects: file, size, position on the table (offsetX/Z from its
// centre; optional offsetY on top of the surface) and floating settings.
// phaseOffset shifts each object's float waves. The tulip shares the vase's
// phase on purpose, so it can never bob down into the vase while it rises; its
// higher H (2.5 vs 2.2) makes it rise slightly ahead of the vase instead.
// dissolveStart is stored but not used: all objects dissolve together.
export const OBJECT_DEFS = [
    { file: 'asset/model/vase.glb',         label: 'vase',  targetHeight: 0.864, offsetX: -0.39, offsetZ: -1.55, rotYOffset: -0.9515, H: 2.2, phaseOffset: 0.0, dissolveStart: 0 },
    { file: 'asset/model/tulip.glb',        label: 'tulip', targetHeight: 1.109, offsetX: -0.39, offsetZ: -1.57, offsetY: 0.68, rotYOffset: 0, H: 2.5, phaseOffset: 0.0, dissolveStart: 0 },
    { file: 'asset/model/agate.glb', label: 'stone', targetHeight: 0.35,  offsetX: -0.24, offsetZ: -0.76, offsetY: -0.02, rotYOffset: 0, H: 1.8, phaseOffset: 0.6, dissolveStart: 0, recenterXZ: true },
    { file: 'asset/model/Wooden_dummy.glb', label: 'dummy', targetHeight: 1.04,  offsetX:  0.42, offsetZ: -1.50, rotYOffset: -1.7216, H: 2.0, phaseOffset: 1.2, dissolveStart: 0 },
    { file: 'asset/model/bear_ribbon.glb',  label: 'teddy', targetHeight: 0.84,  offsetX:  0.35, offsetZ: -0.76, rotYOffset: -0.6415, H: 2.2, phaseOffset: 2.4, dissolveStart: 0 },
];

// ─── Table geometry options ───────────────────────────────────────────────────
// The GUI "Table" dropdown. To add a shape: a label here and a case in
// loadTableGeometry().
const DEFAULT_TABLE_URL   = 'asset/model/table.glb';
export const TABLE_CUSTOM_LABEL = 'Custom GLB…';
export const TABLE_OPTIONS = ['Table (default)', 'Box', 'Cylinder', TABLE_CUSTOM_LABEL];

const TABLE_KIND_BY_LABEL = {
    'Table (default)': 'glb',
    'Box':              'box',
    'Cylinder':         'cylinder',
    [TABLE_CUSTOM_LABEL]: 'custom',
};
export function tableKindForLabel(label) {
    return TABLE_KIND_BY_LABEL[label] ?? 'glb';
}

// ─── Stone options ────────────────────────────────────────────────────────────
// Everything the stone slot can hold (the GUI "Stone" dropdown). `name` is the
// label; the other fields override the stone's entry in OBJECT_DEFS. The first
// entry is shown on load, and the first two alternate on each return.
const STONE_VARIANTS = [
    { name: 'Agate',      file: 'asset/model/agate.glb',          targetHeight: 0.35, rotYOffset: 0,     offsetY: -0.02 },
    { name: 'Fluorite',   file: 'asset/model/fluorita_small.glb', targetHeight: 0.28, rotYOffset: -2.11, offsetY: -0.02 },
    { name: 'Aventurine', file: 'asset/model/aventurina.glb', targetHeight: 0.32, rotYOffset: 0, offsetY: -0.02, layFlat: true },
    // The biface stands upright on a point, so layFlat lays it on its largest
    // face. targetHeight is then its thickness, not its standing height.
    { name: 'Quartz Biface', file: 'asset/model/quartz_biface.glb',
      layFlat: true, targetHeight: 0.22, rotYOffset: 0, offsetY: -0.02 },
];

export const STONE_CUSTOM_LABEL = 'Custom GLB…';
export const STONE_OPTIONS = [...STONE_VARIANTS.map((v) => v.name), STONE_CUSTOM_LABEL];

// Only two stones alternate on return (agate ↔ fluorite): the same still life
// recurring slightly changed. More would feel like a slideshow. The others stay
// selectable in the GUI.
const STONE_CYCLE = STONE_VARIANTS.slice(0, 2);

// Swaps the stone from the GUI. A custom upload keeps the slot's position and
// float, and is centred and laid flat so any model lands on the table.
export function setStone(scene, label, { customUrl, onObjectReady } = {}) {
    const variant = label === STONE_CUSTOM_LABEL
        ? { file: customUrl, layFlat: true, targetHeight: 0.32, offsetY: -0.02, rotYOffset: 0 }
        : STONE_VARIANTS.find((v) => v.name === label);
    if (!variant?.file) return;
    replaceStageObject(scene, 'stone', variant, { onObjectReady });
}

// ─── Objects that come back from space ────────────────────────────────────────
// Each return swaps these slots to their next variant, so the still life that
// comes home isn't the one that left.
const OBJECT_VARIANTS = {
    teddy: [{ file: 'asset/model/bear_ribbon.glb' },              { file: 'asset/model/bear_skeleton.glb' }],
    stone: STONE_CYCLE,
    tulip: [{ file: 'asset/model/tulip.glb' },                    { file: 'asset/model/daffodil.glb' }],
};

// The mannequin has no second model, so it alternates its finish instead:
// original wood ↔ dark walnut. `null` = restore the original material.
const DUMMY_FINISHES = [null, 0x7a5334];

// Extra rotation for the stone in degrees, on top of layFlat's automatic
// alignment. All 0; set them here if a stone rests at a slight tilt.
export const stoneOrientation = { xDeg: 0, yDeg: 0, zDeg: 0 };

// Gallery-plinth white for the Box/Cylinder tables: a matte, slightly warm
// museum pedestal rather than furniture.
const TABLE_MATERIAL_COLOR = 0xe8e4dc;
const TABLE_MATERIAL_ROUGHNESS = 0.95;

// Same surface height as table.glb, so objects stay in view when switching tables.
const PRIMITIVE_TABLE_HEIGHT = 1.88;

// Material for the primitive tables — carries the user-uploaded texture (if any)
// so Box/Cylinder pick it up on every (re)build.
function buildPrimitiveTableMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: TABLE_MATERIAL_COLOR, roughness: TABLE_MATERIAL_ROUGHNESS, metalness: 0.0 });
    applyPrimitiveMaps(mat); // carry over any user-uploaded maps
    return mat;
}

// isPlinth marks the Box/Cylinder (centred, so their base is at -height/2),
// which get the contact shading below. GLB tables don't.
function buildBoxTable() {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, PRIMITIVE_TABLE_HEIGHT, 1.6), buildPrimitiveTableMaterial());
    mesh.userData.isPlinth = true;
    return mesh;
}

function buildCylinderTable() {
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

function injectPlinthBaseShading(mat, height) {
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

// ─── Normalising a user-supplied table ───────────────────────────────────────
// Uploaded models can be any scale (e.g. exported in millimetres) or have their
// pivot far away, which put the table surface, and every object on it, far off
// screen. So custom tables are scaled to the plinths' height and centred.
//
// Many free models also include a big ground plane the artist posed them on,
// which would dissolve along with the table. A mesh is removed as a ground plane
// only if it is BOTH almost flat (thickness < 2% of its width) AND much wider
// than the model is tall (2.5x), so a real tabletop is never removed. Nothing is
// removed if it would remove everything.
const BACKDROP_FLATNESS = 0.02; // thickness as a fraction of own width
const BACKDROP_SPREAD   = 2.5;  // width as a multiple of total model height

function stripBackdropPlanes(root) {
    root.updateWorldMatrix(true, true);
    const modelHeight = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
    if (!(modelHeight > 0)) return [];

    const meshes = [];
    root.traverse((c) => { if (c.isMesh && c.geometry) meshes.push(c); });

    const doomed = meshes.filter((m) => {
        const s = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
        const width = Math.max(s.x, s.z);
        return width > 0
            && s.y   <  BACKDROP_FLATNESS * width
            && width >  BACKDROP_SPREAD   * modelHeight;
    });
    if (!doomed.length || doomed.length === meshes.length) return [];

    for (const m of doomed) {
        m.removeFromParent();
        m.geometry.dispose();
    }
    return doomed.map((m) => m.name || '(unnamed mesh)');
}

function normalizeCustomTable(root) {
    // Remove ground planes first, or they'd distort the measurements below.
    const stripped = stripBackdropPlanes(root);
    if (stripped.length) {
        console.info(`Custom table: removed ${stripped.length} backdrop/ground plane(s) — ${stripped.join(', ')}`);
    }

    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    // Nothing visible to measure: reject, and the caller keeps the old table.
    if (box.isEmpty()) throw new Error('the GLB contains no visible geometry');
    const size = box.getSize(new THREE.Vector3());
    if (size.y < 1e-6) throw new Error('the GLB has no measurable height');

    const center = box.getCenter(new THREE.Vector3());
    const k = PRIMITIVE_TABLE_HEIGHT / size.y;

    // Scale, then move so the bottom is at y=0 and the centre at x=z=0. The
    // offsets were measured before scaling, so they're scaled by k too.
    root.scale.multiplyScalar(k);
    root.position.multiplyScalar(k)
        .sub(new THREE.Vector3(center.x, box.min.y, center.z).multiplyScalar(k));

    // Wrapped in a group, because setupTableObject resets the scale of what it's
    // given, which would undo the scaling above.
    const wrapper = new THREE.Group();
    wrapper.add(root);
    return wrapper;
}

// Returns a Promise of the table for a kind. Box/Cylinder are built directly;
// 'glb' and 'custom' load via GLTFLoader (built-in file or uploaded blob URL).
function loadTableGeometry(kind, customUrl) {
    if (kind === 'box')      return Promise.resolve(buildBoxTable());
    if (kind === 'cylinder') return Promise.resolve(buildCylinderTable());

    const url = kind === 'custom' ? customUrl : DEFAULT_TABLE_URL;
    return new Promise((resolve, reject) => {
        gltfLoader.load(url, (gltf) => {
            if (kind === 'custom') URL.revokeObjectURL(url); // safe once onLoad fires — the .glb is fully parsed by then
            if (kind !== 'custom') { resolve(gltf.scene); return; }
            // Turn a throw into a rejected promise, so the normal error handling sees it.
            try { resolve(normalizeCustomTable(gltf.scene)); }
            catch (err) { reject(err); }
        }, undefined, (err) => {
            if (kind === 'custom') URL.revokeObjectURL(url);
            reject(err);
        });
    });
}

// Removes and disposes the current table (mesh/geometry/material/particles)
// before a new one replaces it, so repeatedly switching in the GUI doesn't
// leak GPU memory.
function disposeTable(scene) {
    if (!tableState.object) return;
    scene.remove(tableState.object);
    forgetDissolveMaterials(tableState.object);
    tableState.object.traverse((child) => {
        if (child.isMesh || child.isPoints) {
            child.geometry?.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => { m?.map?.dispose(); m?.dispose(); });
        }
    });
    tableState.object = null;
}

// Builds particle positions/velocities sampled from a mesh's geometry, in
// the mesh's own local space, so particles stay attached correctly as it floats.
function buildParticlesFromGeometry(root, count, { radial = false, velocityCompensation = 1.0 } = {}) {
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
function makeParticlePoints(geometry, material) {
    const points = new THREE.Points(geometry, material);
    points.layers.set(PARTICLE_BLOOM_LAYER);
    return points;
}

// Applies the dissolve shader + particle system to a freshly loaded table
// root (whether a GLB scene or a bare primitive Mesh), positions it with its
// bottom on the floor, and updates tableState. Returns the new surface Y.
function setupTableObject(tableObject, scene) {
    // traverse() covers both a GLB (many meshes) and a primitive (one mesh).
    tableObject.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = child.receiveShadow = true;
        // Also lit by the objects-only light, so it stays bright in the dark room.
        child.layers.enable(OBJECT_LIGHT_LAYER);

        // Clone the material so each mesh gets its own dissolve shader.
        const mat = child.material.clone();
        mat.userData.ownsAlpha = mat.transparent === true || mat.alphaTest > 0
            || (mat.opacity ?? 1) < 1 || !!mat.alphaMap;
        mat.transparent = true;
        const tableChildToRoot = new THREE.Matrix4()
            .multiplyMatrices(new THREE.Matrix4().copy(tableObject.matrixWorld).invert(), child.matrixWorld);
        injectDissolve(mat, uTableProgress, { space: 'local', freqScale: 4.0, edgeUniform: uObjectDissolveEdge, edgeColorUniform: uObjectDissolveEdgeColor, edgeFollowUniform: uObjectEdgeFollow, edgeGainUniform: uObjectEdgeGain, localMatrixUniform: { value: tableChildToRoot } });
        // After the dissolve, so it wraps that hook instead of clobbering it.
        if (child.userData.isPlinth) injectPlinthBaseShading(mat, PRIMITIVE_TABLE_HEIGHT);
        // Stable cache key (not the uuid), so a table swap reuses compiled shaders
        // instead of recompiling, which caused a stall.
        mat.customProgramCacheKey = () => 'table_dissolve' + (child.userData.isPlinth ? '_plinth' : '');
        // The shadow dissolves with the table. Options must match injectDissolve above.
        child.customDepthMaterial = makeDissolveDepthMaterial(uTableProgress, {
            space: 'local', freqScale: 4.0,
            localMatrixUniform: { value: tableChildToRoot },
            cacheKey: 'table_dissolve_depth',
        });
        child.material = mat;
    });

    // ── Position table: bottom face on the floor ─────────────────────────
    // Add to scene first (at origin), then measure the bounding box.
    // Shifting position.y by (-3.5 - box.min.y) drops the lowest vertex to y=-3.5.
    tableObject.scale.setScalar(1.0);
    scene.add(tableObject);
    tableObject.updateWorldMatrix(true, true); // every mesh inside the table has a correct matrixWorld, so our vertex position sampling is accurate.

    const tableBox = new THREE.Box3().setFromObject(tableObject);
    tableObject.position.y = -3.5 - tableBox.min.y;
    tableObject.position.z = -1.2; // move table back so it sits under the light cone
    tableState.object = tableObject;
    tableState.floorY = tableObject.position.y;
    tableState.floorZ = tableObject.position.z;

    tableBox.setFromObject(tableObject);
    const tableSurfaceY = tableBox.max.y;
    tableState.topOffset = tableSurfaceY - tableState.floorY; // fixed offset from pivot to surface top

    // ── Build particle positions from the table's own geometry ───────────
    const particleGeom = buildParticlesFromGeometry(tableObject, TABLE_PARTICLE_COUNT, { radial: true });
    if (particleGeom) {
        // Low stream strength, so the table's particles scatter instead of
        // flowing off as one clump like the objects'.
        const particleMat = makeParticleMaterial(uTableProgress, uTableTime, { streamStrength: 0.4 });
        // Attach as child so particles inherit the table's position/rotation automatically.
        tableObject.add(makeParticlePoints(particleGeom, particleMat));
    }

    return tableSurfaceY;
}

// Loads a table of the given kind and swaps it in. The first time, it also loads
// every stage object on top; later (GUI "Table" dropdown) it just moves the
// existing objects by the change in surface height.
export function setTable(scene, kind, opts = {}) {
    const { customUrl, onAssetLoaded, onAssetFailed, onObjectReady } = opts;
    const oldSurfaceY = tableState.object ? tableState.floorY + tableState.topOffset : null;

    loadTableGeometry(kind, customUrl).then((rawObject) => {
        disposeTable(scene);
        tableState.kind = kind;
        const newSurfaceY = setupTableObject(rawObject, scene);

        if (oldSurfaceY === null) {
            OBJECT_DEFS.forEach(def =>
                loadStageObject(def, newSurfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady })
            );
        } else {
            const deltaY = newSurfaceY - oldSurfaceY;
            for (const obj of stageObjects) {
                obj.restY += deltaY;
                obj.mesh.position.y += deltaY;
            }
        }
        onAssetLoaded?.();
    }).catch((err) => {
        console.error('Failed to load table:', err);
        onAssetFailed?.(err);
    });
}

// Replaces one stage object's model, keeping its slot's position and float
// settings (OBJECT_DEFS). initialProgress = 1 keeps it invisible when swapped in
// while everything is dissolved, instead of flashing solid for a frame.
function replaceStageObject(scene, label, variant, { onObjectReady, initialProgress = 0 } = {}) {
    const def = OBJECT_DEFS.find((d) => d.label === label);
    if (!def || !variant?.file) return;
    const { file, name, ...overrides } = variant; // `name` is a GUI label, not a def field

    const oldIndex = stageObjects.findIndex((e) => e.label === label);
    if (oldIndex !== -1) {
        const old = stageObjects[oldIndex];
        scene.remove(old.mesh);
        forgetDissolveMaterials(old.mesh);
        old.mesh.traverse((child) => {
            if (child.isMesh || child.isPoints) {
                child.geometry?.dispose();
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => { m?.map?.dispose(); m?.dispose(); });
            }
        });
        old.guiFolder?.destroy();
        stageObjects.splice(oldIndex, 1);
    }

    const surfaceY = tableState.floorY + tableState.topOffset;
    loadStageObject({ ...def, file, ...overrides, initialProgress }, surfaceY, scene, {
        onAssetLoaded: () => {},
        onAssetFailed: (err) => console.error(`Failed to load "${file}":`, err),
        onObjectReady,
    });
}

// Moves each changing slot to its next variant. Called when everything has fully
// dissolved in space, so the swap is never seen. The counter keeps going, so each
// trip shows a different arrangement.
let returnCycle = 0;
export function applyReturnObjects(scene, { onObjectReady } = {}) {
    returnCycle++;
    for (const [label, variants] of Object.entries(OBJECT_VARIANTS)) {
        replaceStageObject(scene, label, variants[returnCycle % variants.length],
            { onObjectReady, initialProgress: 1 });
    }

    applyDummyFinish(DUMMY_FINISHES[returnCycle % DUMMY_FINISHES.length]);
}

// Recolours the mannequin in place. The original colour and texture are saved
// the first time, so `null` can restore them.
function applyDummyFinish(finish) {
    const dummy = stageObjects.find((e) => e.label === 'dummy');
    if (!dummy) return;

    dummy.mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
            if (!m) return;
            // Stash once, before the first modification.
            if (m.userData.origColor === undefined) {
                m.userData.origColor = m.color ? m.color.clone() : null;
                m.userData.origMap   = m.map ?? null;
            }
            if (finish === null) {
                if (m.userData.origColor) m.color.copy(m.userData.origColor);
                m.map = m.userData.origMap;
            } else {
                // Remove the wood texture, or the colour would only darken it.
                m.map = null;
                m.color?.set(finish);
            }
            m.needsUpdate = true;
        });
    });
}

// Loads one stage object: applies the dissolve shader and particles, places it
// on the table, and adds it to stageObjects so it floats and dissolves.
function loadStageObject(def, surfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    // 0 = solid. 1 when swapped in while dissolved (see replaceStageObject).
    const uObjProgress = { value: def.initialProgress ?? 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;

        scene.add(mesh);

        // Lay the model down before measuring it (rotation changes its height).
        // Only for recenterXZ objects: they're wrapped in a group that floats, so
        // the mesh's own rotation isn't overwritten by floating.js.
        if (def.recenterXZ) {
            if (def.layFlat) {
                // Try ~400 rotations and keep the one with the lowest height: that's
                // the model resting on its broadest face. Works for any scanned
                // shape, unlike assuming its bounding box lines up with a flat face.
                mesh.updateWorldMatrix(true, true);
                const pts = [];
                mesh.traverse((c) => {
                    if (!c.isMesh || !c.geometry) return;
                    const pos = c.geometry.getAttribute('position');
                    const step = Math.max(1, Math.floor(pos.count / 400)); // cap the sample
                    const v = new THREE.Vector3();
                    for (let i = 0; i < pos.count; i += step) {
                        pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld).clone());
                    }
                });

                if (pts.length) {
                    const q = new THREE.Quaternion(), e = new THREE.Euler(), t = new THREE.Vector3();
                    let best = { h: Infinity, rx: 0, rz: 0 };
                    const STEP = Math.PI / 20; // 9°, over a half-turn on each axis
                    for (let rx = 0; rx < Math.PI; rx += STEP) {
                        for (let rz = 0; rz < Math.PI; rz += STEP) {
                            q.setFromEuler(e.set(rx, 0, rz));
                            let lo = Infinity, hi = -Infinity;
                            for (const p of pts) {
                                const y = t.copy(p).applyQuaternion(q).y;
                                if (y < lo) lo = y;
                                if (y > hi) hi = y;
                            }
                            if (hi - lo < best.h) best = { h: hi - lo, rx, rz };
                        }
                    }
                    mesh.rotation.set(best.rx, 0, best.rz);
                }
                // The automatic pose (stored, not currently read anywhere).
                mesh.userData.baseRot = mesh.rotation.clone();
                // Manual extra rotation on top, see stoneOrientation.
                mesh.rotation.x += THREE.MathUtils.degToRad(stoneOrientation.xDeg);
                mesh.rotation.y += THREE.MathUtils.degToRad(stoneOrientation.yDeg);
                mesh.rotation.z += THREE.MathUtils.degToRad(stoneOrientation.zDeg);
            } else if (def.rotXDeg || def.rotZDeg) {
                mesh.rotation.set(
                    THREE.MathUtils.degToRad(def.rotXDeg ?? 0), 0,
                    THREE.MathUtils.degToRad(def.rotZDeg ?? 0)
                );
            }
        }

        // Measure the source size FIRST so scaleFactor is known before the
        // dissolve shader is injected — the shader needs it (as uScale) to
        // normalize its blob size to world space (see injectDissolve).
        mesh.updateWorldMatrix(true, true);
        const box0 = new THREE.Box3().setFromObject(mesh, true);
        const scaleFactor = def.targetHeight / (box0.max.y - box0.min.y);
        const uScale = { value: scaleFactor };

        // ── Dissolve shader on every submesh (same pattern as table) ────────
        mesh.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = child.receiveShadow = true;
            child.layers.enable(OBJECT_LIGHT_LAYER); // see the table's traverse

            // Unlit (MeshBasic) materials lack what the dissolve shader needs and
            // would render invisible, so they're upgraded to MeshStandard (which
            // also lets them respond to light).
            let mat = child.material.clone();
            if (mat.isMeshBasicMaterial) {
                mat = new THREE.MeshStandardMaterial({
                    color: mat.color, map: mat.map, roughness: 0.8, metalness: 0.0,
                });
            }

            // Remember if the material needs transparency anyway (e.g. cut-out
            // leaves), so it's never made opaque between dissolves.
            mat.userData.ownsAlpha = mat.transparent === true || mat.alphaTest > 0
                || (mat.opacity ?? 1) < 1 || !!mat.alphaMap;
            mat.transparent = true;

            // Child-to-root transform, so the surface and its particles read the
            // same noise (see posExpr in injectDissolve).
            const childToRoot = new THREE.Matrix4()
                .multiplyMatrices(new THREE.Matrix4().copy(mesh.matrixWorld).invert(), child.matrixWorld);
            injectDissolve(mat, uObjProgress, { space: 'local', freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale, edgeUniform: uObjectDissolveEdge, edgeColorUniform: uObjectDissolveEdgeColor, edgeFollowUniform: uObjectEdgeFollow, edgeGainUniform: uObjectEdgeGain, localMatrixUniform: { value: childToRoot } });
            // One key for all objects: what differs between them is uniforms, which
            // don't change the compiled shader.
            mat.customProgramCacheKey = () => 'stage_dissolve';
            // The shadow dissolves with the object. Options must match injectDissolve above.
            child.customDepthMaterial = makeDissolveDepthMaterial(uObjProgress, {
                space: 'local', freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale,
                localMatrixUniform: { value: childToRoot },
                cacheKey: 'stage_dissolve_depth',
            });
            child.material = mat;
        });

        // ── Scale + place on the table ──────────────────────────────────────
        // obj3d is what floats. Usually the mesh itself; for recenterXZ (the
        // stone, whose geometry can sit far from its pivot) a group with the mesh
        // centred inside, so it rotates in place instead of swinging off the table.
        let obj3d;
        if (def.recenterXZ) {
            const c = box0.getCenter(new THREE.Vector3()); // unscaled geometry center (mesh at origin)
            mesh.position.set(-c.x, -box0.min.y, -c.z);    // XZ-centered on origin; bottom at group-local y=0
            const group = new THREE.Group();
            scene.remove(mesh);
            group.add(mesh);
            group.scale.setScalar(scaleFactor);
            scene.add(group);
            obj3d = group;
        } else {
            mesh.scale.setScalar(scaleFactor);
            obj3d = mesh;
        }
        obj3d.updateWorldMatrix(true, true);
        // Recompute box on the placed node; place its bottom on the surface (+offsetY).
        const box1 = new THREE.Box3().setFromObject(obj3d, true);
        obj3d.position.set(def.offsetX, surfaceY - box1.min.y + (def.offsetY ?? 0), def.offsetZ);

        // Particle count scales with the object's actual world size (bounding
        // diagonal) so a small object emits proportionally fewer particles.
        const worldDiag     = box1.getSize(new THREE.Vector3()).length();
        const particleCount = Math.round(THREE.MathUtils.clamp(
            worldDiag * OBJECT_PARTICLE_PER_UNIT, OBJECT_PARTICLE_MIN, OBJECT_PARTICLE_MAX));

        // velocityCompensation undoes the GLB's scaleFactor shrink.
        // The vertex shader applies modelViewMatrix (which includes scale), so a velocity
        // of 1.0 local = scaleFactor world. Multiplying by 1/scale restores world-space spread.
        const particleGeom = buildParticlesFromGeometry(mesh, particleCount, {
            radial: false,
            velocityCompensation: 1.0 / scaleFactor,
        });
        if (particleGeom) {
            const particleMat = makeParticleMaterial(uObjProgress, uObjTime, { freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale });
            mesh.add(makeParticlePoints(particleGeom, particleMat));
        }

        // The object's lowest point, used for the table collision. Not a bounding
        // sphere: for flat stones the sphere reaches well below them, so they
        // hovered with a visible shadow gap.
        const bottomLocalY = box1.min.y;

        // The sphere is only used as a rough size, for the bear's leg thresholds.
        const sphere = new THREE.Sphere();
        box1.getBoundingSphere(sphere);
        const radius = sphere.radius * 0.85;

        const entry = {
            mesh:         obj3d, // the node that floats/rotates (group for recenterXZ, else the mesh)
            // The model inside the group (not currently read anywhere).
            innerMesh:    def.recenterXZ ? mesh : null,
            offsetY:      def.offsetY ?? 0, // placement offset, also used by the table collision
            label:        def.label,
            uProgress:    uObjProgress,
            uTime:        uObjTime,
            restY:        obj3d.position.y,
            restX:        obj3d.position.x,
            restZ:        obj3d.position.z,
            H:            def.H,
            phaseOffset:  def.phaseOffset,
            dissolveStart: def.dissolveStart,
            shadowsKilled: false,
            rotYOffset:   def.rotYOffset ?? 0, // initial facing direction baked from GUI
            bottomLocalY,          // lowest vertex Y relative to the pivot (table contact)
            radius,                // rough object size, for scaling the leg-unfold thresholds
            repelX:       0,       // accumulated repulsion offset, decays each frame
            repelY:       0,
            repelZ:       0,
        };
        stageObjects.push(entry);

        // ── Skeleton bone animation (bear_skeleton.glb) ─────────────────────
        // Leg bones 'legR' / 'legL'. Builds a sitting pose (folded forward) and a
        // straight hanging pose; floating.js blends between them by the bear's
        // height above the table.
        let legBones = null;
        mesh.traverse((child) => {
            if (!child.isSkinnedMesh || legBones) return;
            const bones = child.skeleton.bones;

            const bR = bones.find(b => b.name === 'legR');
            const bL = bones.find(b => b.name === 'legL');
            if (!bR || !bL) return;

            // Store the GLB's rest pose (= standing) for each leg
            const standR = bR.quaternion.clone();
            const standL = bL.quaternion.clone();

            // Sitting = rest pose folded forward 85°, thighs roughly horizontal
            // (past 90° looked over-folded).
            const SIT_FOLD_DEG = 85;
            const fold = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), (-SIT_FOLD_DEG * Math.PI) / 180
            );
            const sitR = fold.clone().multiply(standR);
            const sitL = fold.clone().multiply(standL);

            // Hanging pose: a little past the rest pose, whose legs are still
            // slightly bent. Higher values over-extend them.
            const LEG_STRAIGHTEN_DEG = 5;
            const straighten = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), (LEG_STRAIGHTEN_DEG * Math.PI) / 180
            );
            const straightR = straighten.clone().multiply(standR);
            const straightL = straighten.clone().multiply(standL);

            // Apply sitting pose (legs only — arms stay in GLB rest/T-pose)
            bR.quaternion.copy(sitR);
            bL.quaternion.copy(sitL);

            // Seat the bear on the table now, in the sitting pose: find the lowest
            // vertex in the posed skeleton and move the mesh onto the surface.
            // Otherwise it would hang above the table and drop into place late.
            mesh.position.y = surfaceY + Math.abs(box1.min.y) * 0.55; // rough start
            mesh.updateMatrixWorld(true);
            child.skeleton.update();

            const posAttr = child.geometry.getAttribute('position');
            const v = new THREE.Vector3();
            let minY = Infinity;
            for (let i = 0; i < posAttr.count; i += 2) { // stride 2: plenty for a low point
                v.fromBufferAttribute(posAttr, i);
                child.applyBoneTransform(i, v);
                v.applyMatrix4(child.matrixWorld);
                if (v.y < minY) minY = v.y;
            }
            if (minY !== Infinity) {
                // 2 cm embed so it reads as sitting ON the table, never hovering.
                mesh.position.y += (surfaceY - minY) - 0.02;
            }
            entry.restY = mesh.position.y;

            legBones = { bR, bL, standR, standL, sitR, sitL, straightR, straightL };
        });
        entry.legBones = legBones; // null for non-skeleton objects

        // Apply the mannequin's finish for the current cycle (the original wood at start).
        if (def.label === 'dummy') {
            applyDummyFinish(DUMMY_FINISHES[returnCycle % DUMMY_FINISHES.length]);
        }

        // Optional callbacks; `?.` so a missing one can't make a loaded object
        // look like a failed load.
        onAssetLoaded?.(); // this object is ready
        onObjectReady?.(def.label, entry, scaleFactor);
    }, undefined, (err) => {
        console.error(`Failed to load ${def.file}:`, err);
        onAssetFailed?.(err);
    });
}

// Kicks off loading of the default table and, once its surface height is
// known, every stage object on top of it. `onAssetLoaded`/`onAssetFailed`
// fire once per GLB (used by the UI loading screen to track total progress);
// `onObjectReady` fires once per stage object so the GUI can add its debug folder.
export function loadScene(scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    setTable(scene, 'glb', { onAssetLoaded, onAssetFailed, onObjectReady });
}

export const LOADING_TOTAL = 1 + OBJECT_DEFS.length; // table + every stage object
