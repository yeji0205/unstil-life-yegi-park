import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJECT_LIGHT_LAYER } from '../scene/lighting.js';
import { addMeshDissolve } from '../effects/dissolve.js';
import { buildParticlesFromGeometry, makeParticlePoints, makeParticleMaterial } from '../effects/dissolveParticles.js';
import {
    BUILTIN_TABLE_HEIGHT, applyBuiltinTableMaps, loadBuiltinTableTexture, builtinTableColor,
    buildBoxTable, buildCylinderTable, injectFloorContactShading,
} from './builtinTable.js';
import { normalizeCustomTable } from './customTable.js';
import { removeModel } from './modelCleanup.js';
import { OBJECT_DEFS, stillLifeObjects, loadStillLifeObject } from './objectsSetup.js';

// ─── Setting up the table ────────────────────────────────────────────────────
// Whichever table is picked, in two steps:
//   1. get its shape: table.glb as it is, a built-in Box/Cylinder
//      (builtinTable.js), or an uploaded GLB made to fit (customTable.js);
//   2. the same for every table: dissolve shader, shadows and particles, put it
//      on the floor, and swap out the old one.
// Loading the first table also loads the objects on top of it (loadScene).

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

// Sets one texture slot on the built-in tables from a user-picked image.
// type: 'map' (albedo/color) | 'normalMap' | 'roughnessMap' | 'bumpMap' | 'metalnessMap'.
// Applies live to the current Box/Cylinder and persists for future rebuilds.
export function setTableTexture(file, type = 'map') {
    if (loadBuiltinTableTexture(file, type)) repaintBuiltinTable();
}

// Repaints the built-in tables from the GUI colour picker.
export function setTableColor(hex) {
    builtinTableColor.hex = hex;
    repaintBuiltinTable();
}

// Re-applies the colour and textures, if the current table is a built-in one.
function repaintBuiltinTable() {
    if ((tableState.kind === 'box' || tableState.kind === 'cylinder') && tableState.object) {
        tableState.object.traverse((c) => {
            if (!c.isMesh) return;
            applyBuiltinTableMaps(c.material);
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
            // Safe once onLoad fires: the .glb is fully parsed by then.
            if (kind === 'custom') URL.revokeObjectURL(url);
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
    removeModel(scene, tableState.object);
    tableState.object = null;
}

// Applies the dissolve shader + particle system to a freshly loaded table
// root (whether a GLB scene or a built-in table's Mesh), positions it with its
// bottom on the floor, and updates tableState. Returns the new surface Y.
function setupTableObject(tableObject, scene) {
    // traverse() covers both a GLB (many meshes) and a built-in table (one mesh).
    tableObject.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = child.receiveShadow = true;
        // Also lit by the objects-only light, so it stays bright in the dark room.
        child.layers.enable(OBJECT_LIGHT_LAYER);

        const builtin = child.userData.isBuiltinTable;
        const mat = addMeshDissolve(child, tableObject, uTableProgress, {
            freqScale: 4.0,
            cacheKey: builtin ? 'table_dissolve_builtin' : 'table_dissolve',
            depthCacheKey: 'table_dissolve_depth',
        });
        // After the dissolve, so it wraps that hook instead of clobbering it.
        if (builtin) injectFloorContactShading(mat, BUILTIN_TABLE_HEIGHT);
    });

    // ── Position table: bottom face on the floor ─────────────────────────
    // Add to scene first (at origin), then measure the bounding box.
    // Shifting position.y by (-3.5 - box.min.y) drops the lowest vertex to y=-3.5.
    tableObject.scale.setScalar(1.0);
    scene.add(tableObject);
    // Every mesh inside the table gets a correct matrixWorld, so the particle
    // sampling below reads accurate positions.
    tableObject.updateWorldMatrix(true, true);

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
// every still-life object on top; later (GUI "Table" dropdown) it just moves the
// existing objects by the change in surface height.
export function setTable(scene, kind, opts = {}) {
    const { customUrl, onAssetLoaded, onAssetFailed, onObjectReady, onTableReady } = opts;
    const oldSurfaceY = tableState.object ? tableState.floorY + tableState.topOffset : null;

    loadTableGeometry(kind, customUrl).then((rawObject) => {
        disposeTable(scene);
        tableState.kind = kind;
        const newSurfaceY = setupTableObject(rawObject, scene);

        if (oldSurfaceY === null) {
            OBJECT_DEFS.forEach(def =>
                loadStillLifeObject(def, newSurfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady })
            );
            onTableReady?.(newSurfaceY);
        } else {
            const deltaY = newSurfaceY - oldSurfaceY;
            for (const obj of stillLifeObjects) {
                obj.restY += deltaY;
                obj.mesh.position.y += deltaY;
                obj.surfaceY += deltaY;
            }
        }
        onAssetLoaded?.();
    }).catch((err) => {
        console.error('Failed to load table:', err);
        onAssetFailed?.(err);
    });
}

// Kicks off loading of the default table and, once its surface height is
// known, every still-life object on top of it. `onAssetLoaded`/`onAssetFailed`
// fire once per GLB (used by the UI loading screen to track total progress);
// `onObjectReady` fires once per still-life object so the GUI can add its debug
// folder; `onTableReady(surfaceY)` once the table stands, to load what goes on it.
export function loadScene(scene, { onAssetLoaded, onAssetFailed, onObjectReady, onTableReady }) {
    setTable(scene, 'glb', { onAssetLoaded, onAssetFailed, onObjectReady, onTableReady });
}

export const LOADING_TOTAL = 1 + OBJECT_DEFS.length; // table + every still-life object
