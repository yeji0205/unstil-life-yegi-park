import * as THREE from 'three';

// ─── Posing a model by its skeleton: sitting and hanging ─────────────────────
// Built only for the teddy bear models (bear_ribbon.glb, bear_skeleton.glb).
// Their leg bones get two poses: sitting (legs folded forward) while on the
// table, and hanging straight once they float. setupTeddyPose runs once when
// the model loads; updateTeddyPose runs every frame (from floating.js) and
// blends between the two.

// Sitting = rest pose folded forward 85°, thighs roughly horizontal (past 90°
// looked over-folded).
const SIT_FOLD_DEG = 85;
// Hanging pose: a little past the rest pose, whose legs are still slightly
// bent. Higher values over-extend them.
const LEG_STRAIGHTEN_DEG = 5;
// Clearance above the table (in units of the bear's size) over which the legs
// go from sitting to hanging.
const LEG_CLEAR_START = 0.15, LEG_CLEAR_END = 1.20;

// Builds both poses, puts the bear in the sitting one and seats it on the table.
// Returns the bones and poses for updateTeddyPose, or null if the model has no
// leg bones (every object except the skeleton bear).
export function setupTeddyPose(mesh, surfaceY, boxMinY) {
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

        const fold = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0), (-SIT_FOLD_DEG * Math.PI) / 180
        );
        const sitR = fold.clone().multiply(standR);
        const sitL = fold.clone().multiply(standL);

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
        mesh.position.y = surfaceY + Math.abs(boxMinY) * 0.55; // rough start
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

        legBones = { bR, bL, standR, standL, sitR, sitL, straightR, straightL };
    });
    return legBones;
}

// Every frame: the bear sits while it's on the table and lets its legs hang once
// it's airborne. tableTopY is null once there's no table.
export function updateTeddyPose(obj, tableTopY) {
    // Based on the bear's actual height above the table, not on scroll
    // progress: the table rises too, so progress can't tell whether the
    // bear is still sitting on it. Thresholds are in units of the bear's
    // size, so they survive rescaling.
    const { bR, bL, sitR, sitL, straightR, straightL } = obj.legBones;
    let boneT = 1; // no table underneath → nothing to overlap, hang free
    if (tableTopY !== null) {
        const bottomY   = obj.mesh.position.y + obj.bottomLocalY;
        // Same contact height as the collision, so resting = zero clearance.
        const contactY  = tableTopY + (obj.offsetY ?? 0);
        const clearance = (bottomY - contactY) / Math.max(obj.radius, 1e-4);
        const raw = (clearance - LEG_CLEAR_START) / (LEG_CLEAR_END - LEG_CLEAR_START);
        const bt  = Math.min(1, Math.max(0, raw));
        boneT = bt * bt * (3 - 2 * bt); // smoothstep
    }
    bR.quaternion.slerpQuaternions(sitR, straightR, boneT);
    bL.quaternion.slerpQuaternions(sitL, straightL, boneT);
}
