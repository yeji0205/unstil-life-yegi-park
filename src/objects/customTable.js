import * as THREE from 'three';
import { BUILTIN_TABLE_HEIGHT } from './builtinTable.js';

// ─── Normalising a user-supplied table ───────────────────────────────────────
// Uploaded models can be any scale (e.g. exported in millimetres) or have their
// pivot far away, which put the table surface, and every object on it, far off
// screen. So custom tables are scaled to the built-in tables' height and centred.
//
// Many free models also include a big ground plane the artist posed them on,
// which would dissolve along with the table. A mesh is removed as a ground plane
// only if it is BOTH almost flat (thickness < 2% of its width) AND much wider
// than the model is tall (2.5x), so a real tabletop is never removed. Nothing is
// removed if it would remove everything.
const BACKDROP_FLATNESS = 0.02; // thickness as a fraction of own width
const BACKDROP_SPREAD   = 2.5;  // width as a multiple of total model height

function stripBackdropPlanes(root) {
    root.updateWorldMatrix(true, true);
    const modelHeight = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
    if (!(modelHeight > 0)) return [];

    const meshes = [];
    root.traverse((c) => { if (c.isMesh && c.geometry) meshes.push(c); });

    const doomed = meshes.filter((m) => {
        const s = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
        const width = Math.max(s.x, s.z);
        return width > 0
            && s.y   <  BACKDROP_FLATNESS * width
            && width >  BACKDROP_SPREAD   * modelHeight;
    });
    if (!doomed.length || doomed.length === meshes.length) return [];

    for (const m of doomed) {
        m.removeFromParent();
        m.geometry.dispose();
    }
    return doomed.map((m) => m.name || '(unnamed mesh)');
}

export function normalizeCustomTable(root) {
    // Remove ground planes first, or they'd distort the measurements below.
    const stripped = stripBackdropPlanes(root);
    if (stripped.length) {
        console.info(`Custom table: removed ${stripped.length} backdrop/ground plane(s) — ${stripped.join(', ')}`);
    }

    root.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(root);
    // Nothing visible to measure: reject, and the caller keeps the old table.
    if (box.isEmpty()) throw new Error('the GLB contains no visible geometry');
    const size = box.getSize(new THREE.Vector3());
    if (size.y < 1e-6) throw new Error('the GLB has no measurable height');

    const center = box.getCenter(new THREE.Vector3());
    const k = BUILTIN_TABLE_HEIGHT / size.y;

    // Scale, then move so the bottom is at y=0 and the centre at x=z=0. The
    // offsets were measured before scaling, so they're scaled by k too.
    root.scale.multiplyScalar(k);
    root.position.multiplyScalar(k)
        .sub(new THREE.Vector3(center.x, box.min.y, center.z).multiplyScalar(k));

    // Wrapped in a group, because setupTableObject resets the scale of what it's
    // given, which would undo the scaling above.
    const wrapper = new THREE.Group();
    wrapper.add(root);
    return wrapper;
}
