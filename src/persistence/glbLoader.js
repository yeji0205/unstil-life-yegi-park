import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { injectDissolve, makeParticleMaterial } from '../render/dissolve.js';

const TABLE_PARTICLE_COUNT  = 2000;
const OBJECT_PARTICLE_COUNT = 750;

const uTableProgress = { value: 0.0 };
const uTableTime     = { value: 0.0 };

// Mutated in place as the table GLB loads; other modules (simulation) read
// from this single shared reference rather than several loose variables.
export const tableState = {
    object:     null, // set once GLB loads
    floorY:     -3.5, // resting Y, updated after GLB loads
    floorZ:      0.0, // resting Z, updated after GLB loads
    topOffset:   0.0, // table surface Y above pivot — used for sphere-plane collision
    uProgress:  uTableProgress,
    uTime:      uTableTime,
};

// Filled as each stage-object GLB loads. Each entry: mesh, uProgress, uTime,
// restY, restX, restZ, H, phaseOffset, dissolveStart, shadowsKilled, ...
export const stageObjects = [];

// Each entry defines one still-life object: its file, visual scale, table position,
// floating motion params, and when it starts dissolving after the button is clicked.
// offsetX/Z are relative to the table centre (world 0,0).
// offsetY (optional): extra height added on top of the surface-flush position.
// dissolveStart: seconds after button click when this object begins dissolving.
// phaseOffset: shifts the sin/cos waves so every object drifts independently in space.
// Vase + tulip are separate meshes; tulip offsetY lifts it into the vase opening.
// Tulip has a higher H so it rises faster and pulls away from the vase naturally.
export const OBJECT_DEFS = [
    { file: 'asset/vase.glb',         label: 'vase',  targetHeight: 0.864, offsetX: -0.39, offsetZ: -1.55, rotYOffset: -0.9515, H: 2.2, phaseOffset: 0.0, dissolveStart:  0 },
    { file: 'asset/tulip.glb',        label: 'tulip', targetHeight: 1.109, offsetX: -0.39, offsetZ: -1.57, offsetY: 0.68, rotYOffset: 0, H: 3.2, phaseOffset: 0.0, dissolveStart:  0 },
    { file: 'asset/glass_cup.glb',    label: 'cup',   targetHeight: 0.55,  offsetX: -0.24, offsetZ: -0.76, rotYOffset: 0, H: 1.8, phaseOffset: 0.6, dissolveStart:  3 },
    { file: 'asset/Wooden_dummy.glb', label: 'dummy', targetHeight: 1.04,  offsetX:  0.42, offsetZ: -1.50, rotYOffset: -1.7216, H: 2.0, phaseOffset: 1.2, dissolveStart:  5 },
    { file: 'asset/bear_skeleton.glb',label: 'teddy', targetHeight: 0.84,  offsetX:  0.35, offsetZ: -0.76, rotYOffset: -0.6415, H: 2.2, phaseOffset: 2.4, dissolveStart: 10 },
];

// Builds particle positions/velocities sampled from a GLB's geometry, in the
// mesh's own local space, so particles stay attached correctly as it floats.
function buildParticlesFromGeometry(root, count, { radial = false, velocityCompensation = 1.0 } = {}) {
    root.updateWorldMatrix(true, true);
    const worldInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const rawPositions = [];

    root.traverse((child) => {
        if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
        const posAttr = child.geometry.getAttribute('position');
        const toLocal = new THREE.Matrix4().multiplyMatrices(worldInverse, child.matrixWorld);
        const v = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i).applyMatrix4(toLocal);
            rawPositions.push(v.x, v.y, v.z);
        }
    });

    if (rawPositions.length === 0) return null; // guard: GLB had no geometry

    const positions  = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const vertexCount = rawPositions.length / 3;

    for (let i = 0; i < count; i++) {
        const src = Math.floor(Math.random() * vertexCount) * 3;
        const px = rawPositions[src], py = rawPositions[src + 1], pz = rawPositions[src + 2];
        positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;

        if (radial) {
            // Radial length prevents division by zero at the exact center.
            const r = Math.sqrt(px * px + pz * pz) || 1;
            velocities[i * 3]     = (px / r) * (Math.random() * 1.2 + 0.4);
            velocities[i * 3 + 1] = Math.random() * 2.0 + 0.3;
            velocities[i * 3 + 2] = (pz / r) * (Math.random() * 1.2 + 0.4);
        } else {
            // Random spread angle instead of radial — avoids thin objects (tulip stem) clustering
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 1.5 + 0.5;
            velocities[i * 3]     = Math.cos(angle) * speed * velocityCompensation;
            velocities[i * 3 + 1] = (Math.random() * 2.5 + 0.5) * velocityCompensation;
            velocities[i * 3 + 2] = Math.sin(angle) * speed * velocityCompensation;
        }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    return geom;
}

function loadTable(scene, gltfLoader, { onAssetLoaded, onAssetFailed, onTableReady }) {
    gltfLoader.load('asset/table.glb', (gltf) => {
        const tableObject = gltf.scene;
        tableState.object = tableObject;

        // ── Dissolve shader on every submesh ─────────────────────────────────
        // GLB files contain a tree of Mesh children. We traverse every one and
        // inject the same dissolve logic used on stage objects — local position so
        // the noise pattern stays fixed on the object as it floats.
        tableObject.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = child.receiveShadow = true;

            // Clone the material so each submesh owns its shader independently.
            // Without cloning, all meshes would share one compiled program and
            // the first mesh to compile would overwrite the others.
            const mat = child.material.clone();
            mat.transparent = true;
            injectDissolve(mat, uTableProgress, { space: 'local', freqScale: 4.0 });
            // Unique key per submesh prevents Three.js from reusing another mesh's
            // compiled shader program (which would skip our onBeforeCompile injection).
            mat.customProgramCacheKey = () => 'table_dissolve_' + child.uuid;
            child.material = mat;
        });

        // ── Position table: bottom face on the floor ─────────────────────────
        // Add to scene first (at origin), then measure the bounding box.
        // Shifting position.y by (-3.5 - box.min.y) drops the lowest vertex to y=-3.5.
        tableObject.scale.setScalar(1.0);
        scene.add(tableObject);
        tableObject.updateWorldMatrix(true, true); // every mesh inside the table has a correct matrixWorld, so our vertex position sampling is accurate.

        const tableBox = new THREE.Box3().setFromObject(tableObject);
        tableObject.position.y = -3.5 - tableBox.min.y;
        tableObject.position.z = -1.2; // move table back so it sits under the light cone
        tableState.floorY = tableObject.position.y;
        tableState.floorZ = tableObject.position.z;

        console.log('Table size (units):', tableBox.getSize(new THREE.Vector3()));

        // ── Now that table surface Y is known, load the stage objects ────────
        tableBox.setFromObject(tableObject);
        const tableSurfaceY = tableBox.max.y;
        tableState.topOffset = tableSurfaceY - tableState.floorY; // fixed offset from pivot to surface top
        onTableReady(tableSurfaceY);

        // ── Build particle positions from GLB geometry ────────────────────────
        const particleGeom = buildParticlesFromGeometry(tableObject, TABLE_PARTICLE_COUNT, { radial: true });
        if (!particleGeom) return;
        const particleMat = makeParticleMaterial(uTableProgress, uTableTime);
        // Attach as child so particles inherit the table's position/rotation automatically.
        tableObject.add(new THREE.Points(particleGeom, particleMat));

        onAssetLoaded(); // table is ready
    }, undefined, (err) => {
        console.error('Failed to load table.glb:', err);
        onAssetFailed(err);
    });
}

// Called once per entry in OBJECT_DEFS, after the table surface Y is known.
// Loads the GLB, applies dissolve shader + particle system, and registers the
// object in stageObjects so the simulation loop can drive its floating + dissolve.
function loadStageObject(def, surfaceY, scene, gltfLoader, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    const uObjProgress = { value: 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;

        // ── Dissolve shader on every submesh (same pattern as table) ────────
        mesh.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = child.receiveShadow = true;

            // For the glass cup replace the GLB material entirely — the GLB's
            // transmission-based material refracts the dark background and looks black.
            // A simple semi-transparent physical material looks far more like glass.
            const mat = def.label === 'cup'
                ? new THREE.MeshPhysicalMaterial({
                    color:      0xc8e8ff,   // faint icy blue tint
                    opacity:    0.30,
                    transparent: true,
                    roughness:  0.05,
                    metalness:  0.10,
                    side:       THREE.DoubleSide,
                    depthWrite: false,
                  })
                : child.material.clone();
            if (def.label !== 'cup') mat.transparent = true;
            if (def.label === 'cup') child.renderOrder = 1;

            injectDissolve(mat, uObjProgress, { space: 'local', freqScale: 4.0 });
            mat.customProgramCacheKey = () => def.label + '_dissolve_' + child.uuid;
            child.material = mat;
        });

        // ── Scale to target height and position on table ───────────────────
        scene.add(mesh);
        mesh.updateWorldMatrix(true, true);
        const box0 = new THREE.Box3().setFromObject(mesh);
        const scaleFactor = def.targetHeight / (box0.max.y - box0.min.y);
        mesh.scale.setScalar(scaleFactor);

        // After scaling, recompute box to find the scaled bottom vertex
        const box1 = new THREE.Box3().setFromObject(mesh);
        // Place so bottom of mesh sits exactly on the table surface, plus optional offsetY
        mesh.position.set(def.offsetX, surfaceY - box1.min.y + (def.offsetY ?? 0), def.offsetZ);

        console.log(`${def.label} size:`, box1.getSize(new THREE.Vector3()));

        // velocityCompensation undoes the GLB's scaleFactor shrink.
        // The vertex shader applies modelViewMatrix (which includes scale), so a velocity
        // of 1.0 local = scaleFactor world. Multiplying by 1/scale restores world-space spread.
        const particleGeom = buildParticlesFromGeometry(mesh, OBJECT_PARTICLE_COUNT, {
            radial: false,
            velocityCompensation: 1.0 / scaleFactor,
        });
        if (particleGeom) {
            const particleMat = makeParticleMaterial(uObjProgress, uObjTime);
            mesh.add(new THREE.Points(particleGeom, particleMat));
        }

        // Bounding sphere — used for collision detection.
        // radius at 0.85× gives tighter fit than full diagonal, avoids jitter
        // on very irregular shapes while still preventing visible overlap.
        // sphereCenterLocalY is the sphere centre's Y offset from the mesh pivot
        // (box1 was computed with mesh at y=0, so this offset is constant).
        const sphere = new THREE.Sphere();
        box1.getBoundingSphere(sphere);
        const radius             = sphere.radius * 0.85;
        const sphereCenterLocalY = sphere.center.y; // Y of sphere centre in mesh-local space

        const entry = {
            mesh,
            uProgress:    uObjProgress,
            uTime:        uObjTime,
            restY:        mesh.position.y,
            restX:        def.offsetX,
            restZ:        def.offsetZ,
            H:            def.H,
            phaseOffset:  def.phaseOffset,
            dissolveStart: def.dissolveStart,
            shadowsKilled: false,
            spinY:        0,                    // cumulative auto-rotation (driven by simulation loop)
            rotYOffset:   def.rotYOffset ?? 0, // initial facing direction baked from GUI
            radius,                // sphere radius for collision detection
            sphereCenterLocalY,    // sphere centre Y above mesh pivot (for table collision)
            repelX:       0,       // accumulated repulsion offset, decays each frame
            repelY:       0,
            repelZ:       0,
        };
        stageObjects.push(entry);

        // ── Skeleton bone animation (bear_skeleton.glb) ─────────────────────
        // Leg bones are named exactly 'legR' / 'legL'. The GLB rest pose is
        // standing. We premultiply a 90° forward fold (X axis, parent space) to
        // create the sitting quaternion, apply it immediately, then slerp back
        // to the rest (standing) quaternion as uObjProgress rises 0 → 0.4.
        let legBones = null;
        mesh.traverse((child) => {
            if (!child.isSkinnedMesh || legBones) return;
            const bones = child.skeleton.bones;
            console.log(`[${def.label}] skeleton bones:`, bones.map(b => b.name));

            const bR = bones.find(b => b.name === 'legR');
            const bL = bones.find(b => b.name === 'legL');
            if (!bR || !bL) return;

            // Store the GLB's rest pose (= standing) for each leg
            const standR = bR.quaternion.clone();
            const standL = bL.quaternion.clone();

            // Sitting = rest pose folded backward -95° in the bone's parent space
            const fold = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), -Math.PI * 100 / 180
            );
            const sitR = fold.clone().multiply(standR);
            const sitL = fold.clone().multiply(standL);

            // Apply sitting pose (legs only — arms stay in GLB rest/T-pose)
            bR.quaternion.copy(sitR);
            bL.quaternion.copy(sitL);

            // Position: raise the mesh so the body sits ON the table rather than
            // sinking into it. box1.min.y is the foot Y when mesh is at origin
            // (negative = below pivot). 30% of that distance lifts the bear just
            // enough so the butt geometry clears the table surface.
            mesh.position.y = surfaceY + Math.abs(box1.min.y) * 0.1;
            entry.restY = mesh.position.y;

            legBones = { bR, bL, standR, standL, sitR, sitL };
        });
        entry.legBones = legBones; // null for non-skeleton objects

        onAssetLoaded(); // this object is ready
        onObjectReady(def.label, entry, scaleFactor);
    }, undefined, (err) => {
        console.error(`Failed to load ${def.file}:`, err);
        onAssetFailed(err);
    });
}

// Kicks off loading of the table and, once its surface height is known,
// every stage object on top of it. `onAssetLoaded`/`onAssetFailed` fire once
// per GLB (used by the UI loading screen to track total progress);
// `onObjectReady` fires once per stage object so the GUI can add its debug folder.
export function loadScene(scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    const gltfLoader = new GLTFLoader();
    loadTable(scene, gltfLoader, {
        onAssetLoaded,
        onAssetFailed,
        onTableReady: (surfaceY) => {
            OBJECT_DEFS.forEach(def =>
                loadStageObject(def, surfaceY, scene, gltfLoader, { onAssetLoaded, onAssetFailed, onObjectReady })
            );
        },
    });
}

export const LOADING_TOTAL = 1 + OBJECT_DEFS.length; // table + every stage object
