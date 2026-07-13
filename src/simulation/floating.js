// Floating motion described by (see architecture.md):
//
//   P(t) = P_initial + p · (H + A ⊙ sin(ω t))
//
// where t = elapsed time, p = scroll progress, and H, A, ω vary per object so
// each one rises to a different height and drifts independently.
// Exported so simulation/cameraControls.js can start pulling the camera back
// at the exact same point objects start rising, instead of drifting out of
// sync with a second hardcoded threshold.
export const FLOAT_START = 0.2;

// Drives every stage object's rise/bob/sway + table-surface collision, the
// table's own floating, and skeleton leg posing — called once per frame.
export function updateFloating({ t, p, stageObjects, tableState }) {
    tableState.uTime.value = t;

    // Split into 4 steps so collision resolution sees all positions at once.

    // Step 1 — compute base position for each object (no mesh write yet)
    // Floating (rise/bob/sway) only kicks in once p passes FLOAT_START —
    // objects stay put on the table for the first part of the scroll.
    const floatP = Math.max(0, (p - FLOAT_START) / (1 - FLOAT_START));
    for (const obj of stageObjects) {
        obj.uTime.value = t;
        const phi  = obj.phaseOffset;
        const rise = floatP * obj.H;
        // Bob: vertical oscillation gives the main floating rhythm
        const bob  = Math.sin(t * 0.75 + phi) * 0.25 * floatP;
        // Micro-sway: very small horizontal drift so objects feel weightless,
        // not like they're on a vertical rail. Amplitude is ~10× smaller than
        // the old driftX to avoid visible sliding.
        const swayX = Math.sin(t * 0.28 + phi * 1.1) * 0.04 * floatP;
        const swayZ = Math.cos(t * 0.21 + phi * 0.9) * 0.03 * floatP;
        obj._baseX = obj.restX + swayX;
        obj._baseY = obj.restY + rise + bob;
        obj._baseZ = obj.restZ + swayZ;
    }

    // Step 2 — decay / reset repulsion
    for (const obj of stageObjects) {
        if (p < 0.01) {
            // Fully back on the table: snap repelY to 0 so objects return to
            // exact rest position and don't hover after scrolling back.
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
            const sphereBottomY = (obj._baseY + obj.repelY) + obj.sphereCenterLocalY - obj.radius;
            if (sphereBottomY < tableTopY) {
                obj.repelY += (tableTopY - sphereBottomY) * collisionStrengthY;
            }
        }
    }

    // Step 4 — write final position + rotation to each mesh
    for (const obj of stageObjects) {
        obj.mesh.position.x = obj._baseX + obj.repelX;
        obj.mesh.position.y = obj._baseY + obj.repelY;
        obj.mesh.position.z = obj._baseZ + obj.repelZ;
        obj.spinY += 0.002 * floatP;
        obj.mesh.rotation.y = obj.spinY + obj.rotYOffset;
        obj.mesh.rotation.z = Math.sin(t * 0.42 + obj.phaseOffset) * 0.06 * floatP;
        obj.mesh.rotation.x = Math.sin(t * 0.31 + obj.phaseOffset * 1.3) * 0.04 * floatP;

        // Skeleton leg animation: sitting → standing as the room→space
        // progress (p / uProgress) rises 0 → 1, so legs start folding the
        // moment floating begins. Divisor < 1 reaches full standing pose
        // before p hits 1, so the transition finishes early.
        if (obj.legBones) {
            const { bR, bL, sitR, sitL, standR, standL } = obj.legBones;
            const boneT = Math.min(1, p / 0.5);
            bR.quaternion.slerpQuaternions(sitR, standR, boneT);
            bL.quaternion.slerpQuaternions(sitL, standL, boneT);
        }
    }

    // ── Table floating ───────────────────────────────────────────────────────
    // Different H, A, ω values from stage objects → independent drift in space.
    // Guard with null check because the GLB loads asynchronously.
    if (tableState.object) {
        const tableRise = p * 1.5;
        const tableBob  = Math.sin(t * 0.62 + 1.2) * 0.18 * p;
        tableState.object.position.y = tableState.floorY + tableRise + tableBob;
        tableState.object.position.x = 0;
        tableState.object.position.z = tableState.floorZ;
        tableState.object.rotation.y += 0.0015 * p;
        tableState.object.rotation.z  = Math.sin(t * 0.38) * 0.04 * p;
    }
}
