import * as THREE from 'three';

const _skinV = new THREE.Vector3(); // scratch for the one-time teddy grounding

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
            const sphereBottomY = (obj._baseY + obj.repelY) + obj.sphereCenterLocalY - obj.radius;
            if (sphereBottomY < tableTopY) {
                obj.repelY += (tableTopY - sphereBottomY) * collisionStrengthY;
            }
        }
    }

    // Step 3b — vase + tulip lift together. The flowers sit ~0.68 up inside the
    // vase, so only the VASE's collision sphere touches the table. Early in the
    // rise the table floats up faster than the objects' own float, so the table
    // surface pushes the vase upward (repelY) while the free-floating tulip,
    // sitting above the surface, gets no such push — leaving it behind. THAT is
    // the "tulip starts floating later" artifact (not phase/H). Handing the
    // tulip the vase's table-push makes the pair lift as one; the tulip's
    // slightly higher H still lets it pull gently ahead as they rise.
    const vaseObj  = stageObjects.find(o => o.label === 'vase');
    const tulipObj = stageObjects.find(o => o.label === 'tulip');
    if (vaseObj && tulipObj) tulipObj.repelY = Math.max(tulipObj.repelY, vaseObj.repelY);

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
            // Legs drop from sitting → hanging almost as soon as the scene stirs.
            // The bear leaves the surface VERY early (the table starts rising at
            // p = 0, so it's already airborne by p ≈ 0.03), and legs still folded
            // in a sitting pose while floating look wrong — there's nothing left
            // to sit on. The old range (0.02 → 0.42) left them only ~2.5%
            // unfolded at p = 0.03, i.e. still fully tucked. This finishes the
            // drop by p = 0.03 instead. Driven by raw p, not floatP, so it isn't
            // gated behind FLOAT_START. smoothstep keeps the short move from
            // snapping — the legs fall rather than teleport.
            const { bR, bL, sitR, sitL, straightR, straightL } = obj.legBones;
            // Starts at 0.036, not ~0: unfolding while the bear is still down on
            // the tabletop swung its legs THROUGH the table surface. 0.036 is
            // late enough that it has cleared the top, so the legs drop in open
            // air. (End = start + 0.044, a quick but not instant fall.)
            const LEG_DROP_START = 0.036, LEG_DROP_END = 0.08;
            const raw   = (p - LEG_DROP_START) / (LEG_DROP_END - LEG_DROP_START);
            const bt    = Math.min(1, Math.max(0, raw));
            const boneT = bt * bt * (3 - 2 * bt); // smoothstep
            bR.quaternion.slerpQuaternions(sitR, straightR, boneT);
            bL.quaternion.slerpQuaternions(sitL, straightL, boneT);
        }

        // ── Grounding of the sitting bear ──────────────────────────────────
        // The bear is placed at load from its STANDING (bind-pose) box, but the
        // SIT pose lifts its real low point well above that — so it floated
        // above the table. While it's at rest, measure the actual skinned-vertex
        // low point (applyBoneTransform = the skinning maths raycasting uses, so
        // it reflects the POSED geometry) and set restY so that point lands on
        // the table. The sit pose takes a few frames to fully propagate into the
        // bone world-matrices, so instead of measuring once we re-measure each
        // frame and only LOCK the result once it stops changing — robust to how
        // fast the pose settles or the framerate.
        if (obj.skinnedMesh && !obj.grounded && p < 0.1) {
            // Let the sit pose fully propagate into the bone world-matrices first
            // (it takes a few dozen frames), THEN measure once and lock. restY is
            // held fixed until the lock so the measurement isn't chasing a moving
            // position (matrixWorld lags the position by a frame). Grounding runs
            // while the bear is hidden behind the intro, so the settle is unseen.
            obj._grFrames = (obj._grFrames || 0) + 1;
            if (obj._grFrames >= 45) {
                const sk = obj.skinnedMesh;
                sk.skeleton.update();
                const posAttr = sk.geometry.getAttribute('position');
                let minY = Infinity;
                for (let i = 0; i < posAttr.count; i += 2) { // stride 2: fast, matches the rendered low point
                    _skinV.fromBufferAttribute(posAttr, i);
                    sk.applyBoneTransform(i, _skinV);
                    _skinV.applyMatrix4(sk.matrixWorld);
                    if (_skinV.y < minY) minY = _skinV.y;
                }
                const surfaceY = tableState.floorY + tableState.topOffset;
                // pivot that puts the measured low point on the surface, minus a
                // 2 cm embed so it reads as sitting ON the table, never hovering.
                obj.restY = surfaceY - (minY - obj.mesh.position.y) - 0.02;
                obj.grounded = true;
            }
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
