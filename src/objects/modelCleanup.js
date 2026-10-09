import { forgetDissolveMaterials } from '../effects/dissolve.js';

// ─── Removing a loaded model ─────────────────────────────────────────────────
// Used when the table or a still-life object is swapped for another model.

// A mesh can have one material or a list of them; this always gives a list.
export function materialsOf(mesh) {
    return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

// Takes a model out of the scene and frees its GPU memory (geometry, materials,
// textures, particles), so swapping models again and again doesn't leak.
export function removeModel(scene, root) {
    scene.remove(root);
    forgetDissolveMaterials(root);
    root.traverse((child) => {
        if (!child.isMesh && !child.isPoints) return;
        child.geometry?.dispose();
        materialsOf(child).forEach((m) => { m?.map?.dispose(); m?.dispose(); });
    });
}
