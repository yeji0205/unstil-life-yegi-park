import { forgetDissolveMaterials } from '../effects/dissolve.js';
import { tableState } from './table.js';
import { OBJECT_DEFS, stageObjects, loadStageObject } from './stageObjects.js';

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
    { name: 'Agate',      file: 'asset/model/agate.glb',          targetHeight: 0.35, rotYOffset: 0,     offsetY: -0.02 },
    { name: 'Fluorite',   file: 'asset/model/fluorita_small.glb', targetHeight: 0.28, rotYOffset: -2.11, offsetY: -0.02 },
    { name: 'Aventurine', file: 'asset/model/aventurina.glb', targetHeight: 0.32, rotYOffset: 0, offsetY: -0.02, layFlat: true },
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
    if (variant) replaceStageObject(scene, 'stone', variant, events);
}

// Swaps the stone to an uploaded GLB. It keeps the slot's position and float,
// and is centred and laid flat so any model lands on the table.
export function setCustomStone(scene, url, events = {}) {
    if (!url) return;
    replaceStageObject(scene, 'stone',
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

// Replaces one stage object's model, keeping its slot's position and float
// settings (OBJECT_DEFS). initialProgress = 1 keeps it invisible when swapped in
// while everything is dissolved, instead of flashing solid for a frame.
function replaceStageObject(scene, label, variant, { onObjectReady, onObjectRemoved, initialProgress = 0 } = {}) {
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
        stageObjects.splice(oldIndex, 1);
        onObjectRemoved?.(old);
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
export function applyReturnObjects(scene, { onObjectReady, onObjectRemoved } = {}) {
    returnCycle++;
    for (const [label, variants] of Object.entries(OBJECT_VARIANTS)) {
        replaceStageObject(scene, label, variants[returnCycle % variants.length],
            { onObjectReady, onObjectRemoved, initialProgress: 1 });
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
