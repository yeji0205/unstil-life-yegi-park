import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJECT_LIGHT_LAYER } from '../scene/lighting.js';
import { injectDissolve, makeDissolveDepthMaterial, makeParticleMaterial, forgetDissolveMaterials, uObjectDissolveEdge, uObjectDissolveEdgeColor, uObjectEdgeFollow, uObjectEdgeGain } from '../effects/dissolve.js';
import { buildParticlesFromGeometry, makeParticlePoints } from '../effects/dissolveParticles.js';
import { PRIMITIVE_TABLE_HEIGHT, applyPrimitiveMaps, loadPlinthTexture, primitiveTableColor, buildBoxTable, buildCylinderTable, injectPlinthBaseShading } from './plinth.js';
import { normalizeCustomTable } from './customTable.js';
import { OBJECT_DEFS, stageObjects, loadStageObject } from './stageObjects.js';

// ─── The table ───────────────────────────────────────────────────────────────
// Loads the table (table.glb, a Box/Cylinder plinth, or an uploaded GLB), gives
// it its dissolve shader and particles, and puts it on the floor. Loading the
// first table also loads the objects on top of it (loadScene).

const TABLE_PARTICLE_COUNT = 2000;
const DEFAULT_TABLE_URL    = 'asset/model/table.glb';

const uTableProgress = { value: 0.0 };
const uTableTime     = { value: 0.0 };

// One loader for every table GLB (it's stateless).
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

// Sets one texture slot on the primitive tables from a user-picked image.
// type: 'map' (albedo/color) | 'normalMap' | 'roughnessMap' | 'bumpMap' | 'metalnessMap'.
// Applies live to the current Box/Cylinder and persists for future rebuilds.
export function setTableTexture(file, type = 'map') {
    if (loadPlinthTexture(file, type)) repaintPlinth();
}

// Repaints the Box/Cylinder plinths from the GUI colour picker.
export function setTableColor(hex) {
    primitiveTableColor.hex = hex;
    repaintPlinth();
}

// Re-applies the plinth colour and textures, if the current table is a Box/Cylinder.
function repaintPlinth() {
    if ((tableState.kind === 'box' || tableState.kind === 'cylinder') && tableState.object) {
        tableState.object.traverse((c) => {
            if (!c.isMesh) return;
            applyPrimitiveMaps(c.material);
            c.material.needsUpdate = true;
        });
    }
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

// Kicks off loading of the default table and, once its surface height is
// known, every stage object on top of it. `onAssetLoaded`/`onAssetFailed`
// fire once per GLB (used by the UI loading screen to track total progress);
// `onObjectReady` fires once per stage object so the GUI can add its debug folder.
export function loadScene(scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    setTable(scene, 'glb', { onAssetLoaded, onAssetFailed, onObjectReady });
}

export const LOADING_TOTAL = 1 + OBJECT_DEFS.length; // table + every stage object
