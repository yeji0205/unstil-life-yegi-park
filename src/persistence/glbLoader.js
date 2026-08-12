import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { injectDissolve, makeParticleMaterial } from '../render/dissolve.js';

const TABLE_PARTICLE_COUNT  = 2000;

// Dissolve pattern/particle tuning for stage objects.
// - FREQ_SCALE 2.0 (was 4.0): larger dissolve blobs so small objects don't
//   break up into tiny hard-to-read dots.
// - particle count scales with each object's world-space size, so a small
//   object emits fewer particles than a big one (instead of a flat 750 each).
const OBJECT_FREQ_SCALE        = 2.0;
const OBJECT_PARTICLE_PER_UNIT = 550;   // particles per unit of world bounding-box diagonal
const OBJECT_PARTICLE_MIN      = 200;
const OBJECT_PARTICLE_MAX      = 900;

const uTableProgress = { value: 0.0 };
const uTableTime     = { value: 0.0 };

// One shared loader — GLTFLoader instances are stateless, so the initial
// table/stage-object load and any later table swap (see setTable) all reuse
// this instead of creating a new one each time.
const gltfLoader = new GLTFLoader();

// Mutated in place as the table loads (or is swapped); other modules
// (simulation) read from this single shared reference rather than several
// loose variables.
export const tableState = {
    object:     null, // set once the table loads
    kind:       'glb', // 'glb' | 'box' | 'cylinder' | 'custom' — tracks the current table
    floorY:     -3.5, // resting Y, updated after load
    floorZ:      0.0, // resting Z, updated after load
    topOffset:   0.0, // table surface Y above pivot — used for sphere-plane collision
    uProgress:  uTableProgress,
    uTime:      uTableTime,
};

// Optional user-uploaded textures for the primitive (Box/Cylinder) tables so
// they carry real material character instead of a flat color. Several map slots
// can be mixed — albedo + normal + roughness + bump. Stored here so they survive
// Box↔Cylinder swaps (re-applied when those meshes are (re)built). The GLB/
// custom tables keep their own textures and ignore these.
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

// Filled as each stage-object GLB loads. Each entry: mesh, uProgress, uTime,
// restY, restX, restZ, H, phaseOffset, dissolveStart, shadowsKilled, ...
export const stageObjects = [];

// Each entry defines one still-life object: its file, visual scale, table position,
// floating motion params, and when it starts dissolving after the button is clicked.
// offsetX/Z are relative to the table centre (world 0,0).
// offsetY (optional): extra height added on top of the surface-flush position.
// dissolveStart: seconds after button click when this object begins dissolving.
// phaseOffset: shifts the sin/cos waves so every object drifts independently in space.
// Vase + tulip are separate meshes; tulip offsetY lifts it into the vase opening.
// Both start floating at the exact same moment (floatP is shared, driven by
// the same FLOAT_START), and tulip is given the SAME phaseOffset as the vase
// (0.0). This is deliberate: the bob/sway terms scale with floatP but their
// amplitude (~0.25) is larger than the tiny rise-rate gap early on, so ANY
// phase difference let the tulip bob *downward* while the vase rose — which is
// exactly the "tulip floats later" artifact. With identical phase the two
// share one vertical rhythm and the tulip can never dip below the vase.
// Separation instead comes purely from H: 2.5 vs 2.2 (~14% faster) means the
// flowers steadily pull UP out of the vase (rise = floatP·H is linear, so the
// H ratio IS the speed ratio) — a clean "lighter object rises a bit faster"
// read with no false late start. dissolveStart is 0 for every object so they
// all dissolve simultaneously the moment the Dissolve button is pressed (the
// table follows just after — see phaseMachine).
export const OBJECT_DEFS = [
    { file: 'asset/vase.glb',         label: 'vase',  targetHeight: 0.864, offsetX: -0.39, offsetZ: -1.55, rotYOffset: -0.9515, H: 2.2, phaseOffset: 0.0, dissolveStart: 0 },
    { file: 'asset/tulip.glb',        label: 'tulip', targetHeight: 1.109, offsetX: -0.39, offsetZ: -1.57, offsetY: 0.68, rotYOffset: 0, H: 2.5, phaseOffset: 0.0, dissolveStart: 0 },
    { file: 'asset/fluorita_small.glb', label: 'stone', targetHeight: 0.28,  offsetX: -0.24, offsetZ: -0.76, offsetY: -0.02, rotYOffset: -2.11, H: 1.8, phaseOffset: 0.6, dissolveStart: 0, recenterXZ: true },
    { file: 'asset/Wooden_dummy.glb', label: 'dummy', targetHeight: 1.04,  offsetX:  0.42, offsetZ: -1.50, rotYOffset: -1.7216, H: 2.0, phaseOffset: 1.2, dissolveStart: 0 },
    { file: 'asset/bear_ribbon.glb',  label: 'teddy', targetHeight: 0.84,  offsetX:  0.35, offsetZ: -0.76, rotYOffset: -0.6415, H: 2.2, phaseOffset: 2.4, dissolveStart: 0 },
];

// ─── Table geometry options ───────────────────────────────────────────────────
// Selectable from the debug GUI's "Table" dropdown (mirrors the Skybox
// dropdown). Add a new label here + a case in loadTableGeometry() to offer
// another built-in shape.
const DEFAULT_TABLE_URL   = 'asset/table.glb';
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

// ─── Objects that come BACK from space ────────────────────────────────────────
// The journey changes the still life: the objects that re-materialize on the way
// home are not the ones that left. Each slot cycles through this list — index 0
// is what OBJECT_DEFS starts with, and every return advances one step and wraps
// round — so repeated trips keep changing the arrangement instead of settling on
// one fixed "after" state.
//
// `offsetY` overrides that variant's vertical placement: a fixed value can't suit
// two different shapes. The agate is rounded and wants sinking 0.15 into the
// tabletop so it reads as settled, but the quartz biface is flat-bottomed and the
// same offset drove it THROUGH the table — it sits at 0.
// ─── Stone options ────────────────────────────────────────────────────────────
// One list serving two purposes: the GUI's "Stone" dropdown, and the stone
// slot's return cycle. Keeping them the same means a stone picked by hand and a
// stone that arrives back from space are described in exactly one place.
//
// `name` is the dropdown label; everything else overrides that variant's entry
// in OBJECT_DEFS. Values not listed are inherited from the def — which is set up
// for the fluorite, so the other two restate rotYOffset to cancel its rotation.
const STONE_VARIANTS = [
    { name: 'Fluorite', file: 'asset/fluorita_small.glb' },
    { name: 'Agate',      file: 'asset/agate.glb',      targetHeight: 0.35, rotYOffset: 0, offsetY: -0.02 },
    { name: 'Aventurine', file: 'asset/aventurina.glb', targetHeight: 0.32, rotYOffset: 0, offsetY: -0.02, layFlat: true },
    // The biface arrives balanced upright on a narrow point, which reads as
    // perched rather than placed. layFlat measures it and rests it on its
    // largest face. targetHeight is THICKNESS once it's lying down, not stature:
    // that value normalises height, so a flat slab would otherwise be scaled up
    // until it stood tall again. 0.22 gives a ~0.56 × 0.49 footprint.
    { name: 'Quartz Biface', file: 'asset/quartz_biface.glb',
      layFlat: true, targetHeight: 0.22, rotYOffset: 0, offsetY: -0.02 },
];

export const STONE_CUSTOM_LABEL = 'Custom GLB…';
export const STONE_OPTIONS = [...STONE_VARIANTS.map((v) => v.name), STONE_CUSTOM_LABEL];

// Swaps the stone on demand from the GUI. A custom upload inherits the slot's
// placement (position, float, dissolve timing) and gets recenterXZ + layFlat, so
// an arbitrary model still lands on the table rather than wherever its pivot
// happens to be — the same treatment the built-in scans need.
export function setStone(scene, label, { customUrl, onObjectReady } = {}) {
    const variant = label === STONE_CUSTOM_LABEL
        ? { file: customUrl, layFlat: true, targetHeight: 0.32, offsetY: -0.02, rotYOffset: 0 }
        : STONE_VARIANTS.find((v) => v.name === label);
    if (!variant?.file) return;
    replaceStageObject(scene, 'stone', variant, { onObjectReady });
}

const OBJECT_VARIANTS = {
    teddy: [{ file: 'asset/bear_ribbon.glb' },              { file: 'asset/bear_skeleton.glb' }],
    stone: STONE_VARIANTS,
    tulip: [{ file: 'asset/tulip.glb' },                    { file: 'asset/daffodil.glb' }],
};

// The mannequin has no second model, so it changes finish instead of shape —
// same silhouette, clearly not the same object. Cycles alongside the models:
// original wood → dark walnut → original → walnut …
// `null` means "put the original material back", which is why the recolour has
// to be reversible (see applyDummyFinish).
const DUMMY_FINISHES = [null, 0x7a5334];

// Manual rotation trim for the stone, in degrees, applied ON TOP of layFlat's
// automatic alignment. Exposed in the GUI ("Stone Orientation") because
// bounding-box alignment can only guarantee the flattest BOX face points down —
// a scanned rock's real resting face is often a few degrees off that, which
// reads as the stone lying at a slight tilt. Dial it in on screen, then paste the
// numbers here as the new default.
export const stoneOrientation = { xDeg: 0, yDeg: 0, zDeg: 0 };

// Gallery-plinth white. The Box and Cylinder tables aren't meant to read as
// furniture — they're the abstract pedestal a still life gets displayed ON, so
// they take the off-white of a museum plinth rather than the room's wood tones.
// Very slightly warm (not pure #fff) so it sits in the room's light instead of
// glaring, and matte: a plinth is painted MDF, never glossy.
const TABLE_MATERIAL_COLOR = 0xe8e4dc;
const TABLE_MATERIAL_ROUGHNESS = 0.95;

// Total height of the primitive tables. Sized to match the default table.glb's
// surface height (its top sits ~1.88 above the floor): the primitives were only
// 0.9 tall, so their surface landed ~1 unit lower and every object dropped below
// the framed view the moment you switched to Box/Cylinder. Matching the height
// keeps the surface — and thus the objects — at the same place across all tables.
const PRIMITIVE_TABLE_HEIGHT = 1.88;

// Material for the primitive tables — carries the user-uploaded texture (if any)
// so Box/Cylinder pick it up on every (re)build.
function buildPrimitiveTableMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: TABLE_MATERIAL_COLOR, roughness: TABLE_MATERIAL_ROUGHNESS, metalness: 0.0 });
    applyPrimitiveMaps(mat); // carry over any user-uploaded maps
    return mat;
}

function buildBoxTable() {
    return new THREE.Mesh(new THREE.BoxGeometry(1.6, PRIMITIVE_TABLE_HEIGHT, 1.6), buildPrimitiveTableMaterial());
}

function buildCylinderTable() {
    return new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, PRIMITIVE_TABLE_HEIGHT, 32), buildPrimitiveTableMaterial());
}

// Resolves a table "kind" into a loaded root Object3D. Box/Cylinder are
// synchronous but wrapped in a Promise so callers don't need to branch on
// sync-vs-async — 'glb' and 'custom' both go through GLTFLoader, just with
// a different URL (the built-in table.glb, or a blob: URL from a
// user-picked file).
function loadTableGeometry(kind, customUrl) {
    if (kind === 'box')      return Promise.resolve(buildBoxTable());
    if (kind === 'cylinder') return Promise.resolve(buildCylinderTable());

    const url = kind === 'custom' ? customUrl : DEFAULT_TABLE_URL;
    return new Promise((resolve, reject) => {
        gltfLoader.load(url, (gltf) => {
            if (kind === 'custom') URL.revokeObjectURL(url); // safe once onLoad fires — the .glb is fully parsed by then
            resolve(gltf.scene);
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

    // Collect every triangle (in root-local space) with a running cumulative
    // area, so particles can be sampled UNIFORMLY across the surface rather
    // than AT the vertices. Vertex sampling clusters wherever a mesh is sparsely
    // tessellated — a CylinderGeometry's side has vertices only on its top and
    // bottom rings, and its caps only at centre + rim, so vertex-sampled
    // particles bunched into rings (the cylinder's "grouped" particles). Picking
    // a random triangle weighted by area, then a uniform point inside it, spreads
    // the particles evenly no matter how the shape happens to be tessellated.
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
            // Radial length prevents division by zero at the exact center.
            // Large radial magnitudes so the table's particles burst OUTWARD and
            // disperse (paired with the table's low streamStrength) instead of
            // drifting off together as one clump.
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

// Applies the dissolve shader + particle system to a freshly loaded table
// root (whether a GLB scene or a bare primitive Mesh), positions it with its
// bottom on the floor, and updates tableState. Returns the new surface Y.
function setupTableObject(tableObject, scene) {
    // GLB files contain a tree of Mesh children; a primitive table is just
    // one Mesh. traverse() visits both cases uniformly (Object3D.traverse
    // calls the callback on the node itself before any children).
    tableObject.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = child.receiveShadow = true;

        // Clone the material so each submesh owns its shader independently.
        // Without cloning, all meshes would share one compiled program and
        // the first mesh to compile would overwrite the others.
        const mat = child.material.clone();
        mat.userData.ownsAlpha = mat.transparent === true || mat.alphaTest > 0
            || (mat.opacity ?? 1) < 1 || !!mat.alphaMap;
        mat.transparent = true;
        injectDissolve(mat, uTableProgress, { space: 'local', freqScale: 4.0 });
        // Unique key per submesh prevents Three.js from reusing another mesh's
        // compiled shader program (which would skip our onBeforeCompile injection).
        mat.customProgramCacheKey = () => 'table_dissolve_' + child.uuid;
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
        // streamStrength 0.4: the table disperses its particles outward instead
        // of drifting them off together as a clump (unlike the objects, which
        // keep the full directional "flow into the background").
        const particleMat = makeParticleMaterial(uTableProgress, uTableTime, { streamStrength: 0.4 });
        // Attach as child so particles inherit the table's position/rotation automatically.
        tableObject.add(new THREE.Points(particleGeom, particleMat));
    }

    return tableSurfaceY;
}

// Loads/builds a table of the given kind and swaps it in.
// - First call ever (tableState.object is null): places every stage object
//   on top of it for the first time (used by loadScene at startup).
// - Later calls (GUI "Table" dropdown): keeps the existing stage objects and
//   just shifts them by the surface-height delta, so switching tables live
//   doesn't require reloading vase/tulip/cup/dummy/teddy from scratch.
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

// Replaces ONE stage object's model in place: unloads whichever GLB currently
// fills that slot and loads the given one instead, keeping the slot's table
// position, height, float and dissolve timing (its OBJECT_DEFS entry) — only the
// file differs. Unlike setTable this touches a single object, since swapping one
// model has no effect on where the others sit.
//
// initialProgress seeds the new object's dissolve amount. That matters when
// swapping while everything is dissolved away: a fresh object defaults to 0
// (fully solid), so without this it would pop into view for a frame before the
// reverse-dissolve took over.
function replaceStageObject(scene, label, variant, { onObjectReady, initialProgress = 0 } = {}) {
    const def = OBJECT_DEFS.find((d) => d.label === label);
    if (!def || !variant?.file) return;
    const { file, name, ...overrides } = variant; // `name` is a GUI label, not a def field

    const oldIndex = stageObjects.findIndex((e) => e.label === label);
    if (oldIndex !== -1) {
        const old = stageObjects[oldIndex];
        scene.remove(old.mesh);
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

// Advances every cycling slot to its NEXT variant. Called at the moment
// everything has finished dissolving in space — while the objects are invisible —
// so the replacements are what reverse-dissolve back into the room and the change
// is never seen happening. initialProgress: 1 keeps them fully dissolved until the
// reverse-dissolve drives them back in step with everything else.
//
// The counter persists, so each trip out and back shows a different arrangement
// rather than one permanent "after" state.
let returnCycle = 0;
export function applyReturnObjects(scene, { onObjectReady } = {}) {
    returnCycle++;
    for (const [label, variants] of Object.entries(OBJECT_VARIANTS)) {
        replaceStageObject(scene, label, variants[returnCycle % variants.length],
            { onObjectReady, initialProgress: 1 });
    }

    applyDummyFinish(DUMMY_FINISHES[returnCycle % DUMMY_FINISHES.length]);
}

// Re-applies stoneOrientation to the stone that's currently on the table, and
// re-seats it afterwards. Rotating changes which part of the model is lowest, so
// without the re-seat a tilt leaves the stone hovering or buried.
export function applyStoneOrientation() {
    const entry = stageObjects.find((e) => e.label === 'stone');
    const inner = entry?.innerMesh;
    const base  = inner?.userData.baseRot;
    if (!inner || !base) return;

    inner.rotation.set(
        base.x + THREE.MathUtils.degToRad(stoneOrientation.xDeg),
        base.y + THREE.MathUtils.degToRad(stoneOrientation.yDeg),
        base.z + THREE.MathUtils.degToRad(stoneOrientation.zDeg)
    );

    const group = entry.mesh;
    group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(group, true);
    const surfaceY = tableState.floorY + tableState.topOffset;
    group.position.y += (surfaceY + entry.offsetY) - box.min.y;
    entry.restY = group.position.y;
}

// Recolour-in-place, no reload. The materials were already cloned per submesh in
// loadStageObject, so tinting here can't leak into any other object.
//
// The recolour must be REVERSIBLE, and originally it wasn't: it overwrote
// material.color and set map = null outright, which threw the original look away.
// So when the cycle came back round to "original" there was nothing to restore —
// the mannequin just kept whatever finish it was last given (and with a 3-entry
// list it landed on the darker grey, which is why the third trip looked darker
// still instead of returning to bare wood). Stashing the original colour and map
// the first time makes `null` genuinely mean "undo".
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
                // A colour is multiplied OVER a texture, so the grain has to go —
                // otherwise this only darkens the wood instead of restaining it.
                m.map = null;
                m.color?.set(finish);
            }
            m.needsUpdate = true;
        });
    });
}

// Called once per entry in OBJECT_DEFS, after the table surface Y is known.
// Loads the GLB, applies dissolve shader + particle system, and registers the
// object in stageObjects so the simulation loop can drive its floating + dissolve.
function loadStageObject(def, surfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    // Normally 0 (solid). Set to 1 when an object is swapped in while the scene
    // is dissolved away, so it starts invisible instead of flashing solid — see
    // replaceStageObject().
    const uObjProgress = { value: def.initialProgress ?? 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;

        scene.add(mesh);

        // Lay the model down before anything is measured.
        //
        // `layFlat` MEASURES the model and tips it so its thinnest dimension
        // becomes the vertical one — i.e. it always comes to rest on its largest
        // face, like a stone set down on a table. That's more reliable than a
        // hardcoded angle: which way a scanned model happens to face is arbitrary
        // (its node transforms can already rotate it), so guessing "90° about X"
        // is right for one file and wrong for the next. Measuring can't guess
        // wrong. `rotXDeg`/`rotZDeg` remain for tipping a model deliberately.
        //
        // This has to happen BEFORE box0, because rotating changes which
        // dimension is "height" and therefore the scaleFactor. It's also applied
        // to the INNER mesh, which only works for recenterXZ objects: those get
        // wrapped in a group that carries the floating, so the mesh's own
        // rotation survives. On any other object floating.js overwrites
        // rotation.x/z every frame with the drift wobble.
        if (def.recenterXZ) {
            if (def.layFlat) {
                // SEARCH for the orientation that genuinely lies flattest, rather
                // than assuming the model's bounding box is aligned with its flat
                // face. Snapping the thinnest BOX axis to vertical only works if
                // the box happens to line up with the geometry — for a scanned
                // rock it usually doesn't, which left the biface tipped up on an
                // edge no matter which 90° turn was applied.
                //
                // Minimising the object's HEIGHT over candidate rotations is the
                // same thing as resting it on its broadest face, and it needs no
                // assumptions about the model at all. ~400 candidates over a few
                // hundred sampled vertices is a few milliseconds, once, at load.
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
                // Remember the auto-aligned pose so the GUI trim below is always
                // applied relative to it, not accumulated on each adjustment.
                mesh.userData.baseRot = mesh.rotation.clone();
                // Bounding-box alignment only guarantees the flattest BOX side is
                // down; a scanned rock's actual resting face can still sit at an
                // angle to its box. stoneOrientation is the manual trim on top,
                // exposed in the GUI so the final pose can be eyeballed.
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

            // The dissolve/rim-tint shader injected below reads vNormal and
            // vViewPosition, varyings that only lit (Standard/Physical)
            // material shaders declare. An unlit MeshBasicMaterial GLB (some
            // stone scans export this way) would fail to compile with them
            // injected and render invisible, so upgrade it to Standard first
            // — this also makes it actually respond to scene lighting like
            // every other stage object, instead of looking flat/shadeless.
            let mat = child.material.clone();
            if (mat.isMeshBasicMaterial) {
                mat = new THREE.MeshStandardMaterial({
                    color: mat.color, map: mat.map, roughness: 0.8, metalness: 0.0,
                });
            }

            // Record whether this material was ALREADY transparent for its own
            // reasons (glTF alphaMode BLEND/MASK — cut-out leaves, etc.) before we
            // force transparency on for the dissolve. updateDissolveTransparency
            // must never take alpha away from those.
            mat.userData.ownsAlpha = mat.transparent === true || mat.alphaTest > 0
                || (mat.opacity ?? 1) < 1 || !!mat.alphaMap;
            mat.transparent = true;

            injectDissolve(mat, uObjProgress, { space: 'local', freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale });
            mat.customProgramCacheKey = () => def.label + '_dissolve_' + child.uuid;
            child.material = mat;
        });

        // ── Scale + place on the table ──────────────────────────────────────
        // obj3d is the node that floats/rotates (and becomes entry.mesh). For
        // most objects that's the mesh itself. For recenterXZ objects — the
        // swappable stone, whose scan geometry can sit FAR from its own pivot —
        // we wrap the mesh in a group and shift the mesh so its geometry is
        // centered on the group's origin. The group then carries the scale and
        // placement, so rotation during float spins the stone IN PLACE instead
        // of orbiting a distant pivot and flinging it off the table (the quartz
        // fly-away). The old fix moved the pivot to offsetX/Z, which fixed the
        // resting position but left that orbiting-on-spin behaviour.
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
            mesh.add(new THREE.Points(particleGeom, particleMat));
        }

        // Bounding sphere — used for collision detection.
        // radius at 0.85× gives tighter fit than full diagonal, avoids jitter
        // on very irregular shapes while still preventing visible overlap.
        // sphereCenterLocalY is the sphere centre's Y offset from the mesh pivot
        // (box1 was computed with mesh at y=0, so this offset is constant).
        const sphere = new THREE.Sphere();
        box1.getBoundingSphere(sphere);
        const radius             = sphere.radius * 0.85;
        const sphereCenterLocalY = sphere.center.y; // Y of sphere centre in mesh-local space

        const entry = {
            mesh:         obj3d, // the node that floats/rotates (group for recenterXZ, else the mesh)
            // The model inside that group. Rotating THIS is safe — floating.js
            // drives the group, so an orientation tweak here isn't overwritten.
            innerMesh:    def.recenterXZ ? mesh : null,
            offsetY:      def.offsetY ?? 0, // needed to re-seat it after a rotation change
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
            spinY:        0,                    // cumulative auto-rotation (driven by simulation loop)
            rotYOffset:   def.rotYOffset ?? 0, // initial facing direction baked from GUI
            radius,                // sphere radius for collision detection
            sphereCenterLocalY,    // sphere centre Y above mesh pivot (for table collision)
            repelX:       0,       // accumulated repulsion offset, decays each frame
            repelY:       0,
            repelZ:       0,
        };
        stageObjects.push(entry);

        // ── Skeleton bone animation (bear_skeleton.glb) ─────────────────────
        // Leg bones are named exactly 'legR' / 'legL'. The GLB rest pose is
        // standing. We premultiply a 90° forward fold (X axis, parent space) to
        // create the sitting quaternion, apply it immediately, then slerp back
        // to the rest (standing) quaternion as uObjProgress rises 0 → 0.4.
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

            // Sitting = rest pose folded forward in the bone's parent space.
            // 85° (was 100°): past 90° tucked the feet under and read as
            // over-folded/unnatural; 85° keeps the thighs roughly horizontal
            // like a normal seated pose.
            const SIT_FOLD_DEG = 85;
            const fold = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), (-SIT_FOLD_DEG * Math.PI) / 180
            );
            const sitR = fold.clone().multiply(standR);
            const sitL = fold.clone().multiply(standL);

            // "Straight" airborne pose. The GLB's rest (standing) pose still has
            // the legs slightly bent, so simply returning to rest leaves the bear
            // looking half-folded in mid-air (nothing to sit on up there). We
            // continue the unfold a bit PAST rest — the opposite sign of the fold
            // above, about the same X axis — so the legs hang straight when
            // floating. LEG_STRAIGHTEN_DEG is the only knob; raise it if they
            // should extend more, lower it (0 = back to rest pose) if too much.
            // 5° (was 25°): at 25 the legs read as ~20° OVER-extended — hyper-
            // straightened past a natural hang. 5 keeps just a hint of unfold
            // past the GLB's rest pose so they don't look half-folded in mid-air.
            const LEG_STRAIGHTEN_DEG = 5;
            const straighten = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), (LEG_STRAIGHTEN_DEG * Math.PI) / 180
            );
            const straightR = straighten.clone().multiply(standR);
            const straightL = straighten.clone().multiply(standL);

            // Apply sitting pose (legs only — arms stay in GLB rest/T-pose)
            bR.quaternion.copy(sitR);
            bL.quaternion.copy(sitL);

            // Ground the bear on the table RIGHT NOW, in the sitting pose it was
            // just put into. This used to be deferred to floating.js, which had to
            // wait ~45 frames at p < 0.1 for the pose to settle — so the bear
            // visibly hung above the tabletop and dropped into place a moment
            // after every other object had already settled. Worse, a bear swapped
            // in on the way home started that wait all over again.
            //
            // Forcing the matrices and skeleton up to date makes the measurement
            // valid immediately: walk the skinned vertices through the CURRENT
            // pose (applyBoneTransform is the same maths raycasting uses), find
            // the true low point, and shift the mesh so it lands on the surface.
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

        // The mannequin's finish is part of the return cycle, but index 0 is its
        // OPENING look — apply it here so the room starts dark-brown rather than
        // waiting for the first trip back.
        if (def.label === 'dummy') {
            applyDummyFinish(DUMMY_FINISHES[returnCycle % DUMMY_FINISHES.length]);
        }

        // Optional: these run at the very END of a successful load, so a missing
        // (or throwing) callback used to look exactly like a failed GLB — the
        // error surfaced through GLTFLoader's onError and the object was quietly
        // lost even though it had loaded fine.
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
