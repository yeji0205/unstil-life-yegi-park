import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { injectDissolve, makeParticleMaterial } from '../render/dissolve.js';

const TABLE_PARTICLE_COUNT  = 2000;

// Dissolve pattern/particle tuning for stage objects.
// - FREQ_SCALE 2.0 (was 4.0): larger dissolve blobs so small objects don't
//   break up into tiny hard-to-read dots.
// - particle count scales with each object's world-space size, so a small
//   object emits fewer particles than a big one (instead of a flat 750 each).
const OBJECT_FREQ_SCALE        = 2.0;
const OBJECT_PARTICLE_PER_UNIT = 550;   // particles per unit of world bounding-box diagonal
const OBJECT_PARTICLE_MIN      = 200;
const OBJECT_PARTICLE_MAX      = 900;

const uTableProgress = { value: 0.0 };
const uTableTime     = { value: 0.0 };

// One shared loader — GLTFLoader instances are stateless, so the initial
// table/stage-object load and any later table swap (see setTable) all reuse
// this instead of creating a new one each time.
const gltfLoader = new GLTFLoader();

// Mutated in place as the table loads (or is swapped); other modules
// (simulation) read from this single shared reference rather than several
// loose variables.
export const tableState = {
    object:     null, // set once the table loads
    kind:       'glb', // 'glb' | 'box' | 'cylinder' | 'custom' — tracks the current table
    floorY:     -3.5, // resting Y, updated after load
    floorZ:      0.0, // resting Z, updated after load
    topOffset:   0.0, // table surface Y above pivot — used for sphere-plane collision
    uProgress:  uTableProgress,
    uTime:      uTableTime,
};

// Optional user-uploaded texture for the primitive (Box/Cylinder) tables so
// they carry some character instead of a flat color. Stored here so it survives
// Box↔Cylinder swaps (re-applied when those meshes are (re)built). The GLB/
// custom tables keep their own textures and ignore this.
const textureLoader = new THREE.TextureLoader();
let primitiveTableTexture = null;

// Applies a user-picked image as the map of the primitive tables. Called from
// the GUI's "Table Texture" picker. Applies live to the current table if it's a
// Box/Cylinder, and is re-applied whenever a primitive table is rebuilt.
export function setTableTexture(scene, file) {
    const url = URL.createObjectURL(file);
    const tex = textureLoader.load(url, () => URL.revokeObjectURL(url));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    primitiveTableTexture = tex;

    if ((tableState.kind === 'box' || tableState.kind === 'cylinder') && tableState.object) {
        tableState.object.traverse((c) => {
            if (c.isMesh) {
                c.material.map = tex;
                c.material.color.set(0xffffff); // white base so the texture shows true colors
                c.material.needsUpdate = true;
            }
        });
    }
}

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
// Both start floating at the exact same moment (floatP is shared, driven by
// the same FLOAT_START), and tulip is given the SAME phaseOffset as the vase
// (0.0). This is deliberate: the bob/sway terms scale with floatP but their
// amplitude (~0.25) is larger than the tiny rise-rate gap early on, so ANY
// phase difference let the tulip bob *downward* while the vase rose — which is
// exactly the "tulip floats later" artifact. With identical phase the two
// share one vertical rhythm and the tulip can never dip below the vase.
// Separation instead comes purely from H: 2.5 vs 2.2 (~14% faster) means the
// flowers steadily pull UP out of the vase (rise = floatP·H is linear, so the
// H ratio IS the speed ratio) — a clean "lighter object rises a bit faster"
// read with no false late start. dissolveStart still differs so they dissolve
// at separate moments.
export const OBJECT_DEFS = [
    { file: 'asset/vase.glb',         label: 'vase',  targetHeight: 0.864, offsetX: -0.39, offsetZ: -1.55, rotYOffset: -0.9515, H: 2.2, phaseOffset: 0.0, dissolveStart:  0 },
    { file: 'asset/tulip.glb',        label: 'tulip', targetHeight: 1.109, offsetX: -0.39, offsetZ: -1.57, offsetY: 0.68, rotYOffset: 0, H: 2.5, phaseOffset: 0.0, dissolveStart:  1.5 },
    { file: 'asset/agate.glb',        label: 'stone', targetHeight: 0.55,  offsetX: -0.24, offsetZ: -0.76, offsetY: -0.15, rotYOffset: 0, H: 1.8, phaseOffset: 0.6, dissolveStart:  3, recenterXZ: true },
    { file: 'asset/Wooden_dummy.glb', label: 'dummy', targetHeight: 1.04,  offsetX:  0.42, offsetZ: -1.50, rotYOffset: -1.7216, H: 2.0, phaseOffset: 1.2, dissolveStart:  5 },
    { file: 'asset/bear_skeleton.glb',label: 'teddy', targetHeight: 0.84,  offsetX:  0.35, offsetZ: -0.76, rotYOffset: -0.6415, H: 2.2, phaseOffset: 2.4, dissolveStart: 10 },
];

// ─── Table geometry options ───────────────────────────────────────────────────
// Selectable from the debug GUI's "Table" dropdown (mirrors the Skybox
// dropdown). Add a new label here + a case in loadTableGeometry() to offer
// another built-in shape.
const DEFAULT_TABLE_URL   = 'asset/table.glb';
export const TABLE_CUSTOM_LABEL = 'Custom GLB…';
export const TABLE_OPTIONS = ['Table (default)', 'Box', 'Cylinder', TABLE_CUSTOM_LABEL];

const TABLE_KIND_BY_LABEL = {
    'Table (default)': 'glb',
    'Box':              'box',
    'Cylinder':         'cylinder',
    [TABLE_CUSTOM_LABEL]: 'custom',
};
export function tableKindForLabel(label) {
    return TABLE_KIND_BY_LABEL[label] ?? 'glb';
}

// ─── Stone geometry options ────────────────────────────────────────────────────
// Selectable from the debug GUI's "Stone" dropdown (mirrors Table/Skybox).
// Unlike the table swap (which repositions existing stage objects), swapping
// the stone means unloading and reloading just that one stage object — see
// setStone() below.
export const STONE_CUSTOM_LABEL = 'Custom GLB…';
export const STONE_OPTIONS = ['Agate', 'Quartz Biface', STONE_CUSTOM_LABEL];

const STONE_URL_BY_LABEL = {
    'Agate':          'asset/agate.glb',
    'Quartz Biface':  'asset/quartz_biface.glb',
};

// Template def for the stone stage object — file swaps per selection, every
// other placement/timing param (position, height, dissolve timing) stays.
const STONE_DEF = OBJECT_DEFS.find((d) => d.label === 'stone');

const TABLE_MATERIAL_COLOR = 0x8a5a34; // matches the room's warm wood tones

// Total height of the primitive tables. Sized to match the default table.glb's
// surface height (its top sits ~1.88 above the floor): the primitives were only
// 0.9 tall, so their surface landed ~1 unit lower and every object dropped below
// the framed view the moment you switched to Box/Cylinder. Matching the height
// keeps the surface — and thus the objects — at the same place across all tables.
const PRIMITIVE_TABLE_HEIGHT = 1.88;

// Material for the primitive tables — carries the user-uploaded texture (if any)
// so Box/Cylinder pick it up on every (re)build.
function buildPrimitiveTableMaterial() {
    // With a texture, use a white base so the image shows its true colors
    // (base color multiplies the map — a brown base would tint/darken it).
    const mat = new THREE.MeshStandardMaterial({
        color: primitiveTableTexture ? 0xffffff : TABLE_MATERIAL_COLOR,
        roughness: 0.85, metalness: 0.0,
    });
    if (primitiveTableTexture) mat.map = primitiveTableTexture;
    return mat;
}

function buildBoxTable() {
    return new THREE.Mesh(new THREE.BoxGeometry(1.6, PRIMITIVE_TABLE_HEIGHT, 1.6), buildPrimitiveTableMaterial());
}

function buildCylinderTable() {
    return new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, PRIMITIVE_TABLE_HEIGHT, 32), buildPrimitiveTableMaterial());
}

// Resolves a table "kind" into a loaded root Object3D. Box/Cylinder are
// synchronous but wrapped in a Promise so callers don't need to branch on
// sync-vs-async — 'glb' and 'custom' both go through GLTFLoader, just with
// a different URL (the built-in table.glb, or a blob: URL from a
// user-picked file).
function loadTableGeometry(kind, customUrl) {
    if (kind === 'box')      return Promise.resolve(buildBoxTable());
    if (kind === 'cylinder') return Promise.resolve(buildCylinderTable());

    const url = kind === 'custom' ? customUrl : DEFAULT_TABLE_URL;
    return new Promise((resolve, reject) => {
        gltfLoader.load(url, (gltf) => {
            if (kind === 'custom') URL.revokeObjectURL(url); // safe once onLoad fires — the .glb is fully parsed by then
            resolve(gltf.scene);
        }, undefined, (err) => {
            if (kind === 'custom') URL.revokeObjectURL(url);
            reject(err);
        });
    });
}

// Removes and disposes the current table (mesh/geometry/material/particles)
// before a new one replaces it, so repeatedly switching in the GUI doesn't
// leak GPU memory.
function disposeTable(scene) {
    if (!tableState.object) return;
    scene.remove(tableState.object);
    tableState.object.traverse((child) => {
        if (child.isMesh || child.isPoints) {
            child.geometry?.dispose();
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => { m?.map?.dispose(); m?.dispose(); });
        }
    });
    tableState.object = null;
}

// Builds particle positions/velocities sampled from a mesh's geometry, in
// the mesh's own local space, so particles stay attached correctly as it floats.
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

    if (rawPositions.length === 0) return null; // guard: geometry had no vertices

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

// Applies the dissolve shader + particle system to a freshly loaded table
// root (whether a GLB scene or a bare primitive Mesh), positions it with its
// bottom on the floor, and updates tableState. Returns the new surface Y.
function setupTableObject(tableObject, scene) {
    // GLB files contain a tree of Mesh children; a primitive table is just
    // one Mesh. traverse() visits both cases uniformly (Object3D.traverse
    // calls the callback on the node itself before any children).
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
    tableState.object = tableObject;
    tableState.floorY = tableObject.position.y;
    tableState.floorZ = tableObject.position.z;

    tableBox.setFromObject(tableObject);
    const tableSurfaceY = tableBox.max.y;
    tableState.topOffset = tableSurfaceY - tableState.floorY; // fixed offset from pivot to surface top

    // ── Build particle positions from the table's own geometry ───────────
    const particleGeom = buildParticlesFromGeometry(tableObject, TABLE_PARTICLE_COUNT, { radial: true });
    if (particleGeom) {
        const particleMat = makeParticleMaterial(uTableProgress, uTableTime);
        // Attach as child so particles inherit the table's position/rotation automatically.
        tableObject.add(new THREE.Points(particleGeom, particleMat));
    }

    return tableSurfaceY;
}

// Loads/builds a table of the given kind and swaps it in.
// - First call ever (tableState.object is null): places every stage object
//   on top of it for the first time (used by loadScene at startup).
// - Later calls (GUI "Table" dropdown): keeps the existing stage objects and
//   just shifts them by the surface-height delta, so switching tables live
//   doesn't require reloading vase/tulip/cup/dummy/teddy from scratch.
export function setTable(scene, kind, opts = {}) {
    const { customUrl, onAssetLoaded, onAssetFailed, onObjectReady } = opts;
    const oldSurfaceY = tableState.object ? tableState.floorY + tableState.topOffset : null;

    loadTableGeometry(kind, customUrl).then((rawObject) => {
        disposeTable(scene);
        tableState.kind = kind;
        const newSurfaceY = setupTableObject(rawObject, scene);

        if (oldSurfaceY === null) {
            OBJECT_DEFS.forEach(def =>
                loadStageObject(def, newSurfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady })
            );
        } else {
            const deltaY = newSurfaceY - oldSurfaceY;
            for (const obj of stageObjects) {
                obj.restY += deltaY;
                obj.mesh.position.y += deltaY;
            }
        }
        onAssetLoaded?.();
    }).catch((err) => {
        console.error('Failed to load table:', err);
        onAssetFailed?.(err);
    });
}

// Swaps the stone stage object live: unloads whichever GLB currently fills
// that slot and loads the chosen one in its place, keeping the same table
// position/height/floating/dissolve timing (STONE_DEF) — only the file
// differs. Unlike setTable, this touches exactly one stage object, not all
// of them, since a stone swap has no effect on the other objects' placement.
export function setStone(scene, label, opts = {}) {
    const { customUrl, onObjectReady } = opts;
    const url = label === STONE_CUSTOM_LABEL ? customUrl : STONE_URL_BY_LABEL[label];
    if (!url) return;

    const oldIndex = stageObjects.findIndex((e) => e.label === 'stone');
    if (oldIndex !== -1) {
        const old = stageObjects[oldIndex];
        scene.remove(old.mesh);
        old.mesh.traverse((child) => {
            if (child.isMesh || child.isPoints) {
                child.geometry?.dispose();
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach((m) => { m?.map?.dispose(); m?.dispose(); });
            }
        });
        old.guiFolder?.destroy();
        stageObjects.splice(oldIndex, 1);
    }

    const surfaceY = tableState.floorY + tableState.topOffset;
    loadStageObject({ ...STONE_DEF, file: url }, surfaceY, scene, {
        onAssetLoaded: () => {},
        onAssetFailed: (err) => console.error(`Failed to load stone asset "${url}":`, err),
        onObjectReady,
    });
}

// Called once per entry in OBJECT_DEFS, after the table surface Y is known.
// Loads the GLB, applies dissolve shader + particle system, and registers the
// object in stageObjects so the simulation loop can drive its floating + dissolve.
function loadStageObject(def, surfaceY, scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    const uObjProgress = { value: 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;

        // Measure the source size FIRST so scaleFactor is known before the
        // dissolve shader is injected — the shader needs it (as uScale) to
        // normalize its blob size to world space (see injectDissolve).
        scene.add(mesh);
        mesh.updateWorldMatrix(true, true);
        const box0 = new THREE.Box3().setFromObject(mesh);
        const scaleFactor = def.targetHeight / (box0.max.y - box0.min.y);
        const uScale = { value: scaleFactor };

        // ── Dissolve shader on every submesh (same pattern as table) ────────
        mesh.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = child.receiveShadow = true;

            // The dissolve/rim-tint shader injected below reads vNormal and
            // vViewPosition, varyings that only lit (Standard/Physical)
            // material shaders declare. An unlit MeshBasicMaterial GLB (some
            // stone scans export this way) would fail to compile with them
            // injected and render invisible, so upgrade it to Standard first
            // — this also makes it actually respond to scene lighting like
            // every other stage object, instead of looking flat/shadeless.
            let mat = child.material.clone();
            if (mat.isMeshBasicMaterial) {
                mat = new THREE.MeshStandardMaterial({
                    color: mat.color, map: mat.map, roughness: 0.8, metalness: 0.0,
                });
            }
            mat.transparent = true;

            injectDissolve(mat, uObjProgress, { space: 'local', freqScale: OBJECT_FREQ_SCALE, scaleUniform: uScale });
            mat.customProgramCacheKey = () => def.label + '_dissolve_' + child.uuid;
            child.material = mat;
        });

        // ── Scale to target height and position on table ───────────────────
        mesh.scale.setScalar(scaleFactor);

        // After scaling, recompute box to find the scaled bottom vertex
        const box1 = new THREE.Box3().setFromObject(mesh);
        // Horizontal placement: normally the mesh pivot goes to offsetX/offsetZ.
        // But some GLBs (e.g. the quartz scan) have geometry far from their pivot,
        // so the pivot-based placement puts the visible mesh way off (behind the
        // table). For recenterXZ objects — the swappable stone slot, which must
        // work with arbitrary models — offset by the geometry's own XZ center so
        // the VISIBLE mesh (not the pivot) lands on offsetX/offsetZ. box1 was
        // measured with the mesh still at the origin, so box1.center is exactly
        // that pivot→geometry offset.
        const cx = def.recenterXZ ? box1.getCenter(new THREE.Vector3()).x : 0;
        const cz = def.recenterXZ ? box1.getCenter(new THREE.Vector3()).z : 0;
        // Place so bottom of mesh sits exactly on the table surface, plus optional offsetY
        mesh.position.set(def.offsetX - cx, surfaceY - box1.min.y + (def.offsetY ?? 0), def.offsetZ - cz);

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
            label:        def.label,
            uProgress:    uObjProgress,
            uTime:        uObjTime,
            restY:        mesh.position.y,
            // Rest = the ACTUAL placed pivot position (matters for recenterXZ
            // objects, whose pivot ≠ offsetX/Z); floating drifts around this, so
            // using the raw offset here would snap a recentered stone back to the
            // wrong spot the moment it started floating.
            restX:        mesh.position.x,
            restZ:        mesh.position.z,
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

            // "Straight" airborne pose. The GLB's rest (standing) pose still has
            // the legs slightly bent, so simply returning to rest leaves the bear
            // looking half-folded in mid-air (nothing to sit on up there). We
            // continue the unfold a bit PAST rest — the opposite sign of the fold
            // above, about the same X axis — so the legs hang straight when
            // floating. LEG_STRAIGHTEN_DEG is the only knob; raise it if they
            // should extend more, lower it (0 = back to rest pose) if too much.
            const LEG_STRAIGHTEN_DEG = 25;
            const straighten = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), (LEG_STRAIGHTEN_DEG * Math.PI) / 180
            );
            const straightR = straighten.clone().multiply(standR);
            const straightL = straighten.clone().multiply(standL);

            // Apply sitting pose (legs only — arms stay in GLB rest/T-pose)
            bR.quaternion.copy(sitR);
            bL.quaternion.copy(sitL);

            // Position: raise the mesh so the body sits ON the table rather than
            // sinking into it. box1.min.y is the foot Y when mesh is at origin
            // (negative = below pivot). 30% of that distance lifts the bear just
            // enough so the butt geometry clears the table surface.
            mesh.position.y = surfaceY + Math.abs(box1.min.y) * 0.1;
            entry.restY = mesh.position.y;

            legBones = { bR, bL, standR, standL, sitR, sitL, straightR, straightL };
        });
        entry.legBones = legBones; // null for non-skeleton objects

        onAssetLoaded(); // this object is ready
        onObjectReady(def.label, entry, scaleFactor);
    }, undefined, (err) => {
        console.error(`Failed to load ${def.file}:`, err);
        onAssetFailed(err);
    });
}

// Kicks off loading of the default table and, once its surface height is
// known, every stage object on top of it. `onAssetLoaded`/`onAssetFailed`
// fire once per GLB (used by the UI loading screen to track total progress);
// `onObjectReady` fires once per stage object so the GUI can add its debug folder.
export function loadScene(scene, { onAssetLoaded, onAssetFailed, onObjectReady }) {
    setTable(scene, 'glb', { onAssetLoaded, onAssetFailed, onObjectReady });
}

export const LOADING_TOTAL = 1 + OBJECT_DEFS.length; // table + every stage object
