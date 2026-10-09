import * as THREE from 'three';
import { tableState } from './tableSetup.js';
import { OBJECT_DEFS, stillLifeObjects, loadStillLifeObject } from './objectsSetup.js';
import { removeModel, materialsOf } from './modelCleanup.js';

// ─── Swapping objects for other models ───────────────────────────────────────
// The other models an object slot can hold: the stones (GUI "Stone" dropdown),
// and the models that change each time the objects come back from space.
//
// `onObjectReady(label, entry, scaleFactor)` and `onObjectRemoved(entry)` report
// every swap, so the GUI can keep one debug folder per object.

// ─── Stone options ────────────────────────────────────────────────────────────
// Everything the stone slot can hold (the GUI "Stone" dropdown). `name` is the
// label; the other fields override the stone's entry in OBJECT_DEFS. The first
// entry is shown on load, and the first two alternate on each return.
const STONE_VARIANTS = [
    { name: 'Agate',      file: 'asset/model/agate.glb',
      targetHeight: 0.35, rotYOffset: 0,     offsetY: -0.02 },
    { name: 'Fluorite',   file: 'asset/model/fluorita_small.glb',
      targetHeight: 0.28, rotYOffset: -2.11, offsetY: -0.02 },
    { name: 'Aventurine', file: 'asset/model/aventurina.glb',
      targetHeight: 0.32, rotYOffset: 0,     offsetY: -0.02, layFlat: true },
    // The biface stands upright on a point, so layFlat lays it on its largest
    // face. targetHeight is then its thickness, not its standing height.
    { name: 'Quartz Biface', file: 'asset/model/quartz_biface.glb',
      layFlat: true, targetHeight: 0.22, rotYOffset: 0, offsetY: -0.02 },
];

export const STONE_NAMES = STONE_VARIANTS.map((v) => v.name);

// Only two stones alternate on return (agate ↔ fluorite): the same still life
// recurring slightly changed. More would feel like a slideshow. The others stay
// selectable in the GUI.
const STONE_CYCLE = STONE_VARIANTS.slice(0, 2);

// Swaps the stone to one of STONE_VARIANTS, by name.
export function setStone(scene, name, events = {}) {
    const variant = STONE_VARIANTS.find((v) => v.name === name);
    if (variant) replaceStillLifeObject(scene, 'stone', variant, events);
}

// Swaps the stone to an uploaded GLB. It keeps the slot's position and float,
// and is centred and laid flat so any model lands on the table.
export function setCustomStone(scene, url, events = {}) {
    if (!url) return;
    replaceStillLifeObject(scene, 'stone',
        { file: url, layFlat: true, targetHeight: 0.32, offsetY: -0.02, rotYOffset: 0 }, events);
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

// Replaces the wood texture for the walnut finish. A plain white texture rather
// than none: a material without a texture needs a different shader, which would
// compile (and freeze a frame) right when the objects come back.
const PLAIN_TEXTURE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
PLAIN_TEXTURE.colorSpace = THREE.SRGBColorSpace;
PLAIN_TEXTURE.needsUpdate = true;

// ─── Models kept ready ───────────────────────────────────────────────────────
// Loading a model while the scene is on screen makes it stutter (parsing the
// file, compiling shaders, uploading to the GPU), and the return swap happens
// mid-journey. So every model of the return cycle is loaded at startup, behind
// the loading screen, and a swap only shows one and hides the other. Hidden
// models wait here, keyed by slot and file.
const readyModels = new Map();
const modelKey = (label, file) => `${label}|${file}`;
const isCycleModel = (label, file) => (OBJECT_VARIANTS[label] ?? []).some((v) => v.file === file);

// The return models that aren't on the table at the start.
const PRELOADED = Object.entries(OBJECT_VARIANTS).flatMap(([label, variants]) => {
    const def = OBJECT_DEFS.find((d) => d.label === label);
    return variants.filter((v) => v.file !== def.file).map((variant) => ({ def, variant }));
});
export const PRELOADED_MODEL_COUNT = PRELOADED.length;

// Loads the return models hidden, for the table at surfaceY. Called once the
// first table stands; counts towards the loading screen like the other models.
export function preloadReturnObjects(scene, surfaceY, { onAssetLoaded, onAssetFailed } = {}) {
    for (const { def, variant } of PRELOADED) {
        const { file, name, ...overrides } = variant; // `name` is a GUI label, not a def field
        loadStillLifeObject({ ...def, file, ...overrides }, surfaceY, scene, {
            onAssetLoaded, onAssetFailed, active: false,
            onPrepared: (entry) => readyModels.set(modelKey(def.label, file), entry),
        });
    }
}

// The hidden models, for the shader warm-up in main.js.
export function hiddenModels() {
    return [...readyModels.values()];
}

// Takes a model off the table: a return-cycle model is hidden for next time,
// anything else (a stone from the GUI) is freed.
function putAway(scene, entry) {
    if (isCycleModel(entry.label, entry.file)) {
        entry.mesh.visible = false;
        readyModels.set(modelKey(entry.label, entry.file), entry);
    } else {
        removeModel(scene, entry.mesh);
    }
}

// Puts a hidden model on the table, at the current table height.
function bringOut(entry, progress) {
    readyModels.delete(modelKey(entry.label, entry.file));
    const surfaceY = tableState.floorY + tableState.topOffset;
    const deltaY = surfaceY - entry.surfaceY;
    entry.restY += deltaY;
    entry.mesh.position.y += deltaY;
    entry.surfaceY = surfaceY;
    entry.repelX = entry.repelY = entry.repelZ = 0;
    entry.uProgress.value = progress;
    entry.mesh.visible = true;
    stillLifeObjects.push(entry);
}

// Replaces one still-life object's model, keeping its slot's position and float
// settings (OBJECT_DEFS). initialProgress = 1 keeps it invisible when swapped in
// while everything is dissolved, instead of flashing solid for a frame.
function replaceStillLifeObject(scene, label, variant, { onObjectReady, onObjectRemoved, initialProgress = 0 } = {}) {
    const def = OBJECT_DEFS.find((d) => d.label === label);
    if (!def || !variant?.file) return;
    const { file, name, ...overrides } = variant; // `name` is a GUI label, not a def field

    const oldIndex = stillLifeObjects.findIndex((e) => e.label === label);
    if (oldIndex !== -1) {
        const [old] = stillLifeObjects.splice(oldIndex, 1);
        putAway(scene, old);
        onObjectRemoved?.(old);
    }

    const ready = readyModels.get(modelKey(label, file));
    if (ready) {
        bringOut(ready, initialProgress);
        onObjectReady?.(label, ready, ready.scaleFactor);
        return;
    }
    const surfaceY = tableState.floorY + tableState.topOffset;
    loadStillLifeObject({ ...def, file, ...overrides, initialProgress }, surfaceY, scene, {
        onAssetLoaded: () => {},
        onAssetFailed: (err) => console.error(`Failed to load "${file}":`, err),
        onObjectReady,
    });
}

// Moves each changing slot to its next variant. Called when everything has fully
// dissolved in space, so the swap is never seen. The counter keeps going, so each
// trip shows a different arrangement.
let returnCycle = 0;
export function applyReturnObjects(scene, { onObjectReady, onObjectRemoved } = {}) {
    returnCycle++;
    for (const [label, variants] of Object.entries(OBJECT_VARIANTS)) {
        replaceStillLifeObject(scene, label, variants[returnCycle % variants.length],
            { onObjectReady, onObjectRemoved, initialProgress: 1 });
    }

    applyDummyFinish(DUMMY_FINISHES[returnCycle % DUMMY_FINISHES.length]);
}

// Recolours the mannequin in place. The original colour and texture are saved
// the first time, so `null` can restore them.
function applyDummyFinish(finish) {
    const dummy = stillLifeObjects.find((e) => e.label === 'dummy');
    if (!dummy) return;

    dummy.mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        materialsOf(child).forEach((m) => {
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
                // Replace the wood texture, or the colour would only darken it.
                m.map = PLAIN_TEXTURE;
                m.color?.set(finish);
            }
            m.needsUpdate = true;
        });
    });
}
