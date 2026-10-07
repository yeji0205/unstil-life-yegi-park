import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJECT_LIGHT_LAYER } from '../scene/lighting.js';
import { injectDissolve, makeDissolveDepthMaterial, makeParticleMaterial, uObjectDissolveEdge, uObjectDissolveEdgeColor, uObjectEdgeFollow, uObjectEdgeGain } from '../effects/dissolve.js';
import { buildParticlesFromGeometry, makeParticlePoints } from '../effects/dissolveParticles.js';
import { setupTeddyLegs } from './teddyLegs.js';

// ─── The still-life objects on the table ─────────────────────────────────────
// Loads each object, scales it, places it on the table, and gives it its
// dissolve shader and particles. The loaded objects are kept in stageObjects,
// which floating.js and the phase machine read every frame.

// Stage-object dissolve settings. A lower noise frequency gives bigger blobs, so
// small objects don't break into unreadable dots. Particle count scales with each
// object's size.
const OBJECT_FREQ_SCALE        = 2.0;
const OBJECT_PARTICLE_PER_UNIT = 550;   // particles per unit of world bounding-box diagonal
const OBJECT_PARTICLE_MIN      = 200;
const OBJECT_PARTICLE_MAX      = 900;

// One loader for every object GLB (it's stateless).
const gltfLoader = new GLTFLoader();

// One entry per loaded stage object (see the `entry` built in loadStageObject).
export const stageObjects = [];

// The still-life objects: file, size, position on the table (offsetX/Z from its
// centre; optional offsetY on top of the surface) and floating settings.
// phaseOffset shifts each object's float waves. The tulip shares the vase's
// phase on purpose, so it can never bob down into the vase while it rises; its
// higher H (2.5 vs 2.2) makes it rise slightly ahead of the vase instead.
export const OBJECT_DEFS = [
    { file: 'asset/model/vase.glb',         label: 'vase',  targetHeight: 0.864, offsetX: -0.39, offsetZ: -1.55, rotYOffset: -0.9515, H: 2.2, phaseOffset: 0.0 },
    { file: 'asset/model/tulip.glb',        label: 'tulip', targetHeight: 1.109, offsetX: -0.39, offsetZ: -1.57, offsetY: 0.68, rotYOffset: 0, H: 2.5, phaseOffset: 0.0 },
    { file: 'asset/model/agate.glb', label: 'stone', targetHeight: 0.35,  offsetX: -0.24, offsetZ: -0.76, offsetY: -0.02, rotYOffset: 0, H: 1.8, phaseOffset: 0.6, recenterXZ: true },
    { file: 'asset/model/Wooden_dummy.glb', label: 'dummy', targetHeight: 1.04,  offsetX:  0.42, offsetZ: -1.50, rotYOffset: -1.7216, H: 2.0, phaseOffset: 1.2 },
    { file: 'asset/model/bear_ribbon.glb',  label: 'teddy', targetHeight: 0.84,  offsetX:  0.35, offsetZ: -0.76, rotYOffset: -0.6415, H: 2.2, phaseOffset: 2.4 },
];

// Extra rotation for the stone in degrees, on top of layFlat's automatic
// alignment. All 0; set them here if a stone rests at a slight tilt.
const stoneOrientation = { xDeg: 0, yDeg: 0, zDeg: 0 };

// Lays a model on its broadest face (stones with layFlat). Tries ~400 rotations
// and keeps the one with the lowest height: that's the model resting on its
// broadest face. Works for any scanned shape, unlike assuming its bounding box
// lines up with a flat face.
function layFlat(mesh) {
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
    // Manual extra rotation on top, see stoneOrientation.
    mesh.rotation.x += THREE.MathUtils.degToRad(stoneOrientation.xDeg);
    mesh.rotation.y += THREE.MathUtils.degToRad(stoneOrientation.yDeg);
    mesh.rotation.z += THREE.MathUtils.degToRad(stoneOrientation.zDeg);
}

// Loads one stage object: applies the dissolve shader and particles, places it
// on the table, and adds it to stageObjects so it floats and dissolves.
export function loadStageObject(def, surfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    // 0 = solid. 1 when swapped in while dissolved (see replaceStageObject).
    const uObjProgress = { value: def.initialProgress ?? 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;

        scene.add(mesh);

        // Lay the model down before measuring it (rotation changes its height).
        // Only for recenterXZ objects: they're wrapped in a group that floats, so
        // the mesh's own rotation isn't overwritten by floating.js.
        if (def.recenterXZ) {
            if (def.layFlat) {
                layFlat(mesh);
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
            child.layers.enable(OBJECT_LIGHT_LAYER); // see the table's traverse

            // Unlit (MeshBasic) materials lack what the dissolve shader needs and
            // would render invisible, so they're upgraded to MeshStandard (which
            // also lets them respond to light).
            let mat = child.material.clone();
            if (mat.isMeshBasicMaterial) {
                mat = new THREE.MeshStandardMaterial({
                    color: mat.color, map: mat.map, roughness: 0.8, metalness: 0.0,
                });
            }

            // Remember if the material needs transparency anyway (e.g. cut-out
            // leaves), so it's never made opaque between dissolves.
            mat.userData.ownsAlpha = mat.transparent === true || mat.alphaTest > 0
                || (mat.opacity ?? 1) < 1 || !!mat.alphaMap;
            mat.transparent = true;

            // Child-to-root transform, so the surface and its particles read the
            // same noise (see posExpr in injectDissolve).
            const childToRoot = new THREE.Matrix4()
                .multiplyMatrices(new THREE.Matrix4().copy(mesh.matrixWorld).invert(), child.matrixWorld);
            injectDissolve(mat, uObjProgress, { space: 'local', freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale, edgeUniform: uObjectDissolveEdge, edgeColorUniform: uObjectDissolveEdgeColor, edgeFollowUniform: uObjectEdgeFollow, edgeGainUniform: uObjectEdgeGain, localMatrixUniform: { value: childToRoot } });
            // One key for all objects: what differs between them is uniforms, which
            // don't change the compiled shader.
            mat.customProgramCacheKey = () => 'stage_dissolve';
            // The shadow dissolves with the object. Options must match injectDissolve above.
            child.customDepthMaterial = makeDissolveDepthMaterial(uObjProgress, {
                space: 'local', freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale,
                localMatrixUniform: { value: childToRoot },
                cacheKey: 'stage_dissolve_depth',
            });
            child.material = mat;
        });

        // ── Scale + place on the table ──────────────────────────────────────
        // obj3d is what floats. Usually the mesh itself; for recenterXZ (the
        // stone, whose geometry can sit far from its pivot) a group with the mesh
        // centred inside, so it rotates in place instead of swinging off the table.
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
            mesh.add(makeParticlePoints(particleGeom, particleMat));
        }

        // The object's lowest point, used for the table collision. Not a bounding
        // sphere: for flat stones the sphere reaches well below them, so they
        // hovered with a visible shadow gap.
        const bottomLocalY = box1.min.y;

        // The sphere is only used as a rough size, for the bear's leg thresholds.
        const sphere = new THREE.Sphere();
        box1.getBoundingSphere(sphere);
        const radius = sphere.radius * 0.85;

        const entry = {
            mesh:         obj3d, // the node that floats/rotates (group for recenterXZ, else the mesh)
            offsetY:      def.offsetY ?? 0, // placement offset, also used by the table collision
            label:        def.label,
            uProgress:    uObjProgress,
            uTime:        uObjTime,
            restY:        obj3d.position.y,
            restX:        obj3d.position.x,
            restZ:        obj3d.position.z,
            H:            def.H,
            phaseOffset:  def.phaseOffset,
            shadowsKilled: false,
            rotYOffset:   def.rotYOffset ?? 0, // initial facing direction baked from GUI
            bottomLocalY,          // lowest vertex Y relative to the pivot (table contact)
            radius,                // rough object size, for scaling the leg-unfold thresholds
            repelX:       0,       // accumulated repulsion offset, decays each frame
            repelY:       0,
            repelZ:       0,
        };
        stageObjects.push(entry);

        // The skeleton bear sits on the table with folded legs (see teddyLegs.js),
        // which also moves it, so its resting height is updated.
        entry.legBones = setupTeddyLegs(mesh, surfaceY, box1.min.y); // null for non-skeleton objects
        if (entry.legBones) entry.restY = mesh.position.y;

        // Optional callbacks; `?.` so a missing one can't make a loaded object
        // look like a failed load.
        onAssetLoaded?.(); // this object is ready
        onObjectReady?.(def.label, entry, scaleFactor);
    }, undefined, (err) => {
        console.error(`Failed to load ${def.file}:`, err);
        onAssetFailed?.(err);
    });
}
