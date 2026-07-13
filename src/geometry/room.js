import * as THREE from 'three';
import { uProgress, injectDissolve } from '../render/dissolve.js';

// Individual planes — FrontSide with inward-pointing normals so DirectionalLight works.
// See architecture.md "Why not BoxGeometry" for the lighting reasoning.
const roomParts = [
    // floor   — dark worn wood
    { w: 14, h: 14, pos: [0, -3.5,  0], rx: -Math.PI / 2, ry: 0,            color: 0x2e1c0e },
    // ceiling — dark, mostly invisible above the key light
    { w: 14, h: 14, pos: [0,  3.5,  0], rx:  Math.PI / 2, ry: 0,            color: 0x1e1810 },
    // back wall  — dark olive-brown, enough surface to catch edge light and shadows
    { w: 14, h:  7, pos: [0,  0,   -7], rx: 0,            ry: 0,            color: 0x3d3520 },
    // front wall
    { w: 14, h:  7, pos: [0,  0,    7], rx: 0,            ry: Math.PI,      color: 0x3d3520 },
    // left wall
    { w: 14, h:  7, pos: [-7, 0,    0], rx: 0,            ry:  Math.PI / 2, color: 0x3d3520 },
    // right wall
    { w: 14, h:  7, pos: [ 7, 0,    0], rx: 0,            ry: -Math.PI / 2, color: 0x3d3520 },
];

function makeRoomMaterial(hex) {
    const mat = new THREE.MeshStandardMaterial({
        color: hex,
        side:  THREE.FrontSide,
        transparent: true,
        roughness: 0.9,
        metalness: 0.0,
    });

    // Room dissolve uses world position — the hole sweeps through the wall in
    // place, unlike floating objects whose noise pattern rides with the mesh.
    injectDissolve(mat, uProgress, { space: 'world', freqScale: 1.0 });

    // Ensure each colour gets its own compiled program
    mat.customProgramCacheKey = () => String(hex);
    return mat;
}

// Room dissolve uses shader only — no particles on room walls (see architecture.md).
export function buildRoom(scene) {
    roomParts.forEach(({ w, h, pos, rx, ry, color }) => {
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            makeRoomMaterial(color)
        );
        mesh.position.set(...pos);
        mesh.rotation.x = rx;
        mesh.rotation.y = ry;
        mesh.receiveShadow = true;
        scene.add(mesh);
    });
}
