// Floating motion, every frame:
//
//   P(t) = P_rest + floatP · (H + A ⊙ sin(ω t + phase))
//
// t = elapsed time, floatP = eased scroll progress. Each object has its own rise
// height H and phase, so they drift independently; A and ω are shared.
// Also: table collision, the tulip lifting with the vase, and the bear's legs
// (objects/teddyLegs.js).

import { poseTeddyLegs } from '../objects/teddyLegs.js';

// Objects start rising at this p. Also where the camera starts pulling back
// (setup/cameraControls.js), so the two stay in sync.
export const FLOAT_START = 0.2;

export function updateFloating({ t, p, stageObjects, tableState }) {
    tableState.uTime.value = t;

    // Four steps, so the collision sees every object's position before any is written.

    // Step 1 — compute base position for each object (no mesh write yet)
    // smoothstep, so objects ease off the table instead of jerking into motion.
    const rawFloatP = Math.max(0, (p - FLOAT_START) / (1 - FLOAT_START));
    const floatP    = rawFloatP * rawFloatP * (3 - 2 * rawFloatP); // smoothstep
    for (const obj of stageObjects) {
        obj.uTime.value = t;
        const phi  = obj.phaseOffset;
        const rise = floatP * obj.H;
        // Bob: vertical oscillation gives the main floating rhythm
        const bob  = Math.sin(t * 0.75 + phi) * 0.25 * floatP;
        // Tiny sideways drift so objects feel weightless, small enough not to
        // look like sliding.
        const swayX = Math.sin(t * 0.28 + phi * 1.1) * 0.04 * floatP;
        const swayZ = Math.cos(t * 0.21 + phi * 0.9) * 0.03 * floatP;
        obj._baseX = obj.restX + swayX;
        obj._baseY = obj.restY + rise + bob;
        obj._baseZ = obj.restZ + swayZ;
    }

    // Step 2 — decay / reset repulsion
    for (const obj of stageObjects) {
        if (p < 0.01) {
            // Back on the table: reset, so objects don't hover.
            obj.repelY = 0;
        } else {
            obj.repelY *= 0.92;
        }
        obj.repelX = obj.repelZ = 0;
    }

    // Only vertical collision: table surface pushes objects upward when they overlap it.
    const collisionStrengthY = Math.min(1, p / 0.15);

    // Step 3 — table surface keeps objects from sinking through the table.
    if (tableState.object && collisionStrengthY > 0) {
        const tableTopY = tableState.object.position.y + tableState.topOffset;
        for (const obj of stageObjects) {
            // The object's real underside (lowest vertex), not a bounding sphere,
            // which made flat stones hover. See bottomLocalY in objects/stageObjects.js.
            const objBottomY = (obj._baseY + obj.repelY) + obj.bottomLocalY;
            // Includes the object's offsetY: the stones sit slightly into the table
            // on purpose, and the collision must not lift them back out.
            const contactY = tableTopY + (obj.offsetY ?? 0);
            if (objBottomY < contactY) {
                obj.repelY += (contactY - objBottomY) * collisionStrengthY;
            }
        }
    }

    // Step 3b — the tulip sits inside the vase, above the table, so it never gets
    // the table's push and would lag behind. It takes the vase's push instead.
    const vaseObj  = stageObjects.find(o => o.label === 'vase');
    const tulipObj = stageObjects.find(o => o.label === 'tulip');
    if (vaseObj && tulipObj) tulipObj.repelY = Math.max(tulipObj.repelY, vaseObj.repelY);

    // Table top height, or null once there's no table (needed for the bear's legs).
    const tableTopY = tableState.object
        ? tableState.object.position.y + tableState.topOffset
        : null;

    // Step 4 — write final position + rotation to each mesh
    for (const obj of stageObjects) {
        obj.mesh.position.x = obj._baseX + obj.repelX;
        obj.mesh.position.y = obj._baseY + obj.repelY;
        obj.mesh.position.z = obj._baseZ + obj.repelZ;

        // Rotation is a bounded back-and-forth (±13°), not an accumulating spin.
        // A spin had to unwind on the way home, and the particles (children of
        // the mesh) traced a corkscrew. Zero whenever floatP is zero.
        obj.mesh.rotation.y = obj.rotYOffset
            + Math.sin(t * 0.11 + obj.phaseOffset) * 0.22 * floatP;
        obj.mesh.rotation.z = Math.sin(t * 0.42 + obj.phaseOffset) * 0.06 * floatP;
        obj.mesh.rotation.x = Math.sin(t * 0.31 + obj.phaseOffset * 1.3) * 0.04 * floatP;

        // The skeleton bear sits while it's on the table and lets its legs hang
        // once it's airborne.
        if (obj.legBones) poseTeddyLegs(obj, tableTopY);

    }

    // ── Table floating ───────────────────────────────────────────────────────
    // Its own values, so it drifts independently of the objects.
    // Guard with null check because the GLB loads asynchronously.
    if (tableState.object) {
        const tableRise = p * 1.5;
        const tableBob  = Math.sin(t * 0.62 + 1.2) * 0.18 * p;
        tableState.object.position.y = tableState.floorY + tableRise + tableBob;
        tableState.object.position.x = 0;
        tableState.object.position.z = tableState.floorZ;
        // Bounded rotation, for the same reasons as the objects above.
        tableState.object.rotation.y = Math.sin(t * 0.09 + 0.7) * 0.16 * p;
        tableState.object.rotation.z = Math.sin(t * 0.38) * 0.04 * p;
    }
}
