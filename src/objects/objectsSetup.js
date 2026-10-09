import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJECT_LIGHT_LAYER } from '../scene/lighting.js';
import { addMeshDissolve } from '../effects/dissolve.js';
import { buildParticlesFromGeometry, makeParticlePoints, makeParticleMaterial } from '../effects/dissolveParticles.js';
import { setupTeddyPose } from './skeletonPose.js';

// ─── The still-life objects on the table ─────────────────────────────────────
// Loads each object, scales it, places it on the table, and gives it its
// dissolve shader and particles. The loaded objects are kept in stillLifeObjects,
// which floating.js and the phase machine read every frame.

// Still-life object dissolve settings. A lower noise frequency gives bigger blobs, so
// small objects don't break into unreadable dots. Particle count scales with each
// object's size.
const OBJECT_FREQ_SCALE        = 2.0;
const OBJECT_PARTICLE_PER_UNIT = 550;   // particles per unit of world bounding-box diagonal
const OBJECT_PARTICLE_MIN      = 200;
const OBJECT_PARTICLE_MAX      = 900;

// One loader for every object GLB (it's stateless).
const gltfLoader = new GLTFLoader();

// One entry per loaded still-life object (see the `entry` built in loadStillLifeObject).
export const stillLifeObjects = [];

// The still-life objects: file, size, position on the table (offsetX/Z from its
// centre; optional offsetY on top of the surface) and floating settings.
// phaseOffset shifts each object's float waves. The tulip shares the vase's
// phase on purpose, so it can never bob down into the vase while it rises; its
// higher H (2.5 vs 2.2) makes it rise slightly ahead of the vase instead.
export const OBJECT_DEFS = [
    { label: 'vase',  file: 'asset/model/vase.glb',         targetHeight: 0.864, rotYOffset: -0.9515,
      offsetX: -0.39, offsetZ: -1.55,                 H: 2.2, phaseOffset: 0.0 },
    { label: 'tulip', file: 'asset/model/tulip.glb',        targetHeight: 1.109, rotYOffset: 0,
      offsetX: -0.39, offsetZ: -1.57, offsetY:  0.68, H: 2.5, phaseOffset: 0.0 },
    { label: 'stone', file: 'asset/model/agate.glb',        targetHeight: 0.35,  rotYOffset: 0,
      offsetX: -0.24, offsetZ: -0.76, offsetY: -0.02, H: 1.8, phaseOffset: 0.6, recenterXZ: true },
    { label: 'dummy', file: 'asset/model/Wooden_dummy.glb', targetHeight: 1.04,  rotYOffset: -1.7216,
      offsetX:  0.42, offsetZ: -1.50,                 H: 2.0, phaseOffset: 1.2 },
    { label: 'teddy', file: 'asset/model/bear_ribbon.glb',  targetHeight: 0.84,  rotYOffset: -0.6415,
      offsetX:  0.35, offsetZ: -0.76,                 H: 2.2, phaseOffset: 2.4 },
];

// Extra tilt for the stone in degrees, if it still lies slightly crooked
// after layFlat. All 0 now.
const stoneOrientation = { xDeg: 0, yDeg: 0, zDeg: 0 };

// Turns a stone so it lies on its flattest side, like a real stone put down on
// a table. It tilts the stone in 9° steps, measures how tall it is each time,
// and keeps the tilt where it is lowest. Used for stones with layFlat.
function layFlat(mesh) {
    const points = samplePoints(mesh);
    if (points.length) {
        let best = { height: Infinity, rx: 0, rz: 0 };
        const STEP = Math.PI / 20; // 9°, over a half-turn on each axis
        for (let rx = 0; rx < Math.PI; rx += STEP) {
            for (let rz = 0; rz < Math.PI; rz += STEP) {
                const height = heightWhenTilted(points, rx, rz);
                if (height < best.height) best = { height, rx, rz };
            }
        }
        mesh.rotation.set(best.rx, 0, best.rz);
    }
    // Manual extra rotation on top, see stoneOrientation.
    mesh.rotation.x += THREE.MathUtils.degToRad(stoneOrientation.xDeg);
    mesh.rotation.y += THREE.MathUtils.degToRad(stoneOrientation.yDeg);
    mesh.rotation.z += THREE.MathUtils.degToRad(stoneOrientation.zDeg);
}

// About 400 points of each mesh, in world space: enough to measure the height.
function samplePoints(mesh) {
    mesh.updateWorldMatrix(true, true);
    const points = [];
    mesh.traverse((c) => {
        if (!c.isMesh || !c.geometry) return;
        const pos = c.geometry.getAttribute('position');
        const step = Math.max(1, Math.floor(pos.count / 400));
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i += step) {
            points.push(v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld).clone());
        }
    });
    return points;
}

// How tall the points are after tilting them by rx (around X) and rz (around Z).
const tilt = new THREE.Quaternion(), tiltEuler = new THREE.Euler(), tilted = new THREE.Vector3();
function heightWhenTilted(points, rx, rz) {
    tilt.setFromEuler(tiltEuler.set(rx, 0, rz));
    let low = Infinity, high = -Infinity;
    for (const p of points) {
        const y = tilted.copy(p).applyQuaternion(tilt).y;
        low = Math.min(low, y);
        high = Math.max(high, y);
    }
    return high - low;
}

// Lays the model down before it's measured (rotation changes its height). Only
// for recenterXZ objects: they're wrapped in a group that floats, so the mesh's
// own rotation isn't overwritten by floating.js.
function orientModel(mesh, def) {
    if (!def.recenterXZ) return;
    if (def.layFlat) {
        layFlat(mesh);
    } else if (def.rotXDeg || def.rotZDeg) {
        mesh.rotation.set(
            THREE.MathUtils.degToRad(def.rotXDeg ?? 0), 0,
            THREE.MathUtils.degToRad(def.rotZDeg ?? 0)
        );
    }
}

// A copy of the material for the dissolve. Unlit (MeshBasic) materials lack what
// the dissolve shader needs and would render invisible, so they're upgraded to
// MeshStandard (which also lets them respond to light).
function litMaterialCopy(material) {
    if (!material.isMeshBasicMaterial) return material.clone();
    return new THREE.MeshStandardMaterial({
        color: material.color, map: material.map, roughness: 0.8, metalness: 0.0,
    });
}

// Scales the model and puts its bottom on the table (+offsetY). Returns the node
// that floats: usually the mesh itself; for recenterXZ (the stone, whose geometry
// can sit far from its pivot) a group with the mesh centred inside, so it rotates
// in place instead of swinging off the table. Also returns its bounding box.
function placeOnTable(mesh, def, sourceBox, scaleFactor, surfaceY, scene) {
    let node = mesh;
    if (def.recenterXZ) {
        const c = sourceBox.getCenter(new THREE.Vector3()); // unscaled geometry center (mesh at origin)
        mesh.position.set(-c.x, -sourceBox.min.y, -c.z);    // XZ-centered on origin; bottom at group-local y=0
        node = new THREE.Group();
        scene.remove(mesh);
        node.add(mesh);
        scene.add(node);
    }
    node.scale.setScalar(scaleFactor);
    node.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(node, true);
    node.position.set(def.offsetX, surfaceY - box.min.y + (def.offsetY ?? 0), def.offsetZ);
    return { node, box };
}

// The particles the object sheds while dissolving. Their count scales with the
// object's world size (bounding diagonal), so a small object emits fewer.
function addObjectParticles(mesh, box, scaleFactor, progressUniform, timeUniform, scaleUniform) {
    const worldDiag     = box.getSize(new THREE.Vector3()).length();
    const particleCount = Math.round(THREE.MathUtils.clamp(
        worldDiag * OBJECT_PARTICLE_PER_UNIT, OBJECT_PARTICLE_MIN, OBJECT_PARTICLE_MAX));

    // velocityCompensation undoes the GLB's scaleFactor shrink. The vertex shader
    // applies modelViewMatrix (which includes scale), so a velocity of 1.0 local =
    // scaleFactor world. Multiplying by 1/scale restores world-space spread.
    const particleGeom = buildParticlesFromGeometry(mesh, particleCount, {
        radial: false,
        velocityCompensation: 1.0 / scaleFactor,
    });
    if (!particleGeom) return;
    const particleMat = makeParticleMaterial(progressUniform, timeUniform, {
        freqScale: OBJECT_FREQ_SCALE, scaleUniform,
    });
    mesh.add(makeParticlePoints(particleGeom, particleMat));
}

// The entry floating.js and the phase machine read every frame.
function makeEntry(def, node, box, progressUniform, timeUniform) {
    // The sphere is only used as a rough size, for the bear's leg thresholds.
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return {
        mesh:         node, // the node that floats/rotates (group for recenterXZ, else the mesh)
        offsetY:      def.offsetY ?? 0, // placement offset, also used by the table collision
        label:        def.label,
        uProgress:    progressUniform,
        uTime:        timeUniform,
        restY:        node.position.y,
        restX:        node.position.x,
        restZ:        node.position.z,
        H:            def.H,
        phaseOffset:  def.phaseOffset,
        rotYOffset:   def.rotYOffset ?? 0, // initial facing direction baked from GUI
        // The object's lowest point, for the table collision. Not a bounding
        // sphere: for flat stones the sphere reaches well below them, so they
        // hovered with a visible shadow gap.
        bottomLocalY: box.min.y,
        radius:       sphere.radius * 0.85, // rough size, for the leg-unfold thresholds
        repelX:       0,       // accumulated repulsion offset, decays each frame
        repelY:       0,
        repelZ:       0,
    };
}

// Loads one still-life object: applies the dissolve shader and particles, places it
// on the table, and adds it to stillLifeObjects so it floats and dissolves.
// active = false loads it fully but hidden and not in stillLifeObjects, ready to
// be swapped in later without loading (see objectSwap.js); onPrepared gets it.
export function loadStillLifeObject(def, surfaceY, scene, {
    onAssetLoaded, onAssetFailed, onObjectReady, active = true, onPrepared,
}) {
    // 0 = solid. 1 when swapped in while dissolved (see replaceStillLifeObject).
    const uObjProgress = { value: def.initialProgress ?? 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;
        scene.add(mesh);
        orientModel(mesh, def);

        // Measure the source size FIRST so scaleFactor is known before the
        // dissolve shader is injected — the shader needs it (as uScale) to
        // normalize its blob size to world space (see injectDissolve).
        mesh.updateWorldMatrix(true, true);
        const sourceBox = new THREE.Box3().setFromObject(mesh, true);
        const scaleFactor = def.targetHeight / (sourceBox.max.y - sourceBox.min.y);
        const uScale = { value: scaleFactor };

        mesh.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = child.receiveShadow = true;
            child.layers.enable(OBJECT_LIGHT_LAYER); // see the table's traverse
            // One cache key for all objects: what differs between them is uniforms.
            addMeshDissolve(child, mesh, uObjProgress, {
                material: litMaterialCopy(child.material),
                freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale,
                cacheKey: 'still_life_dissolve',
            });
        });

        const { node, box } = placeOnTable(mesh, def, sourceBox, scaleFactor, surfaceY, scene);
        addObjectParticles(mesh, box, scaleFactor, uObjProgress, uObjTime, uScale);
        const entry = makeEntry(def, node, box, uObjProgress, uObjTime);
        // Kept for swapping it in again later: which model it is, how it was
        // scaled, and the table height it was placed for.
        Object.assign(entry, { file: def.file, scaleFactor, surfaceY });

        // The skeleton bear sits on the table with folded legs (see skeletonPose.js),
        // which also moves it, so its resting height is updated.
        entry.legBones = setupTeddyPose(mesh, surfaceY, box.min.y); // null for non-skeleton objects
        if (entry.legBones) entry.restY = mesh.position.y;

        // Optional callbacks; `?.` so a missing one can't make a loaded object
        // look like a failed load.
        onAssetLoaded?.(); // this object is ready
        if (active) {
            stillLifeObjects.push(entry);
            onObjectReady?.(def.label, entry, scaleFactor);
        } else {
            node.visible = false;
            onPrepared?.(entry);
        }
    }, undefined, (err) => {
        console.error(`Failed to load ${def.file}:`, err);
        onAssetFailed?.(err);
    });
}
