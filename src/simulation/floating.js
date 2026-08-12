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
    // rawFloatP rises linearly from 0, but rise/bob/sway all scale with it, so a
    // linear ramp means their velocity jumps from 0 to a constant the instant
    // floating begins — a sudden, jerky start. smoothstep eases floatP in (and
    // out), so the derivative is 0 at both ends: objects accelerate smoothly off
    // the table and ease into their top height instead of snapping into motion.
    const rawFloatP = Math.max(0, (p - FLOAT_START) / (1 - FLOAT_START));
    const floatP    = rawFloatP * rawFloatP * (3 - 2 * rawFloatP); // smoothstep
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
            // The object's real underside, not a bounding sphere — see
            // bottomLocalY in glbLoader for why that distinction is the whole
            // shadow-gap bug.
            const objBottomY = (obj._baseY + obj.repelY) + obj.bottomLocalY;
            // Contact height honours the object's own offsetY, which is the
            // second half of the gap. The rounded stones are placed 0.02 INTO the
            // tabletop on purpose, so they read as settled rather than balanced;
            // a collision that insisted on the bare surface lifted them back out
            // of it the moment it engaged at p ≈ 0.15, and re-opened a small gap
            // that looked permanent because it was there for the whole scroll.
            // Using the same rule here as the initial seating means resting and
            // moving agree.
            const contactY = tableTopY + (obj.offsetY ?? 0);
            if (objBottomY < contactY) {
                obj.repelY += (contactY - objBottomY) * collisionStrengthY;
            }
        }
    }

    // Step 3b — vase + tulip lift together. The flowers sit ~0.68 up inside the
    // vase, so only the VASE's underside touches the table. Early in the
    // rise the table floats up faster than the objects' own float, so the table
    // surface pushes the vase upward (repelY) while the free-floating tulip,
    // sitting above the surface, gets no such push — leaving it behind. THAT is
    // the "tulip starts floating later" artifact (not phase/H). Handing the
    // tulip the vase's table-push makes the pair lift as one; the tulip's
    // slightly higher H still lets it pull gently ahead as they rise.
    const vaseObj  = stageObjects.find(o => o.label === 'vase');
    const tulipObj = stageObjects.find(o => o.label === 'tulip');
    if (vaseObj && tulipObj) tulipObj.repelY = Math.max(tulipObj.repelY, vaseObj.repelY);

    // Table top in world Y, or null once there's no table to stand on. Needed
    // again below for the bear's legs — see the clearance note there.
    const tableTopY = tableState.object
        ? tableState.object.position.y + tableState.topOffset
        : null;

    // Step 4 — write final position + rotation to each mesh
    for (const obj of stageObjects) {
        obj.mesh.position.x = obj._baseX + obj.repelX;
        obj.mesh.position.y = obj._baseY + obj.repelY;
        obj.mesh.position.z = obj._baseZ + obj.repelZ;

        // Yaw is a slow BOUNDED DRIFT, not an accumulating spin — and that change
        // is what removes the spiral, not the particle shader.
        //
        // The spin used to accumulate (`spinY += 0.002` every frame) and be
        // applied through floatP. That gave a repeatable resting pose, but it
        // bought it at a price: whatever angle had piled up in space — a minute
        // of lingering is ~7 radians, more than a full turn — had to be shed on
        // the way back, because floatP drags the applied angle down to zero. So
        // the objects reassembled while rotating, and the longer you stayed in
        // space the faster they had to turn to get back in time.
        //
        // The dissolve particles are CHILDREN of these meshes, so they inherited
        // every bit of that. A stream flowing outward from a body that is itself
        // turning traces a spiral — which is why the corkscrew survived flattening
        // the sway in the shader. The shader was never the main source.
        //
        // An oscillation has no such debt. It is bounded (±0.22 rad ≈ 13°), it is
        // exactly zero whenever floatP is zero, so the resting pose is still
        // identical every time, and nothing accumulates that later has to be
        // undone. It also matches how pitch and roll below already work.
        //
        // The cost is that objects no longer turn continuously while parked in
        // space — they drift back and forth over about a minute instead. For a
        // piece meant to be still, that reads better anyway.
        obj.mesh.rotation.y = obj.rotYOffset
            + Math.sin(t * 0.11 + obj.phaseOffset) * 0.22 * floatP;
        obj.mesh.rotation.z = Math.sin(t * 0.42 + obj.phaseOffset) * 0.06 * floatP;
        obj.mesh.rotation.x = Math.sin(t * 0.31 + obj.phaseOffset * 1.3) * 0.04 * floatP;

        // Skeleton leg animation: the bear sits while it's on the table and lets
        // its legs hang once it's airborne.
        if (obj.legBones) {
            // Driven by ACTUAL CLEARANCE above the tabletop, not by progress.
            //
            // Every progress-based window tried before failed the same way, and
            // the reason is that progress doesn't know where the table is. The
            // table rises too — from p = 0, faster than the objects, which only
            // start floating at FLOAT_START — and the collision in step 3 keeps
            // pushing the bear up to sit on it. So through a long stretch of the
            // scroll the bear is still RESTING on a surface that happens to be
            // moving, no matter what floatP says. Any window tuned to look right
            // in one pass was wrong in the next, because the amount of that
            // stretch depends on how the two rises happen to line up.
            //
            // Clearance can't be wrong about it: measure how far the bear's
            // underside sits above the tabletop and unfold across that.
            // Touching the table → folded. Well above it → straight. Table gone
            // (in space) → straight. No thresholds to re-tune, and it costs one
            // subtraction — this is the cheap arithmetic version of the raycast
            // idea, with no ray and no BVH.
            //
            // Thresholds are in units of the bear's own size (its bounding-sphere
            // radius) so they hold if the model is ever rescaled.
            const { bR, bL, sitR, sitL, straightR, straightL } = obj.legBones;
            let boneT = 1; // no table underneath → nothing to overlap, hang free
            if (tableTopY !== null) {
                const bottomY   = obj.mesh.position.y + obj.bottomLocalY;
                // Measured against the same contact height the collision uses, so
                // "resting" reads as exactly zero clearance.
                const contactY  = tableTopY + (obj.offsetY ?? 0);
                const clearance = (bottomY - contactY) / Math.max(obj.radius, 1e-4);
                const LEG_CLEAR_START = 0.15, LEG_CLEAR_END = 1.20; // in radii
                const raw = (clearance - LEG_CLEAR_START) / (LEG_CLEAR_END - LEG_CLEAR_START);
                const bt  = Math.min(1, Math.max(0, raw));
                boneT = bt * bt * (3 - 2 * bt); // smoothstep
            }
            bR.quaternion.slerpQuaternions(sitR, straightR, boneT);
            bL.quaternion.slerpQuaternions(sitL, straightL, boneT);
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
        // Same bounded drift as the objects above, and for the same two reasons:
        // `rotation.y += …` left the table facing a different way every time the
        // room came back, and the accumulate-then-unwind fix for that made it
        // turn on the way down — dragging its own particle cloud round with it.
        tableState.object.rotation.y = Math.sin(t * 0.09 + 0.7) * 0.16 * p;
        tableState.object.rotation.z = Math.sin(t * 0.38) * 0.04 * p;
    }
}
