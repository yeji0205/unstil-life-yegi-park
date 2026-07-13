import * as THREE from 'three';
import { injectSkyboxFlow, uFlowStrength } from '../render/skyboxFlow.js';

// ─── Skybox ──────────────────────────────────────────────────────────────────
// Each entry is a folder under asset/ containing 6 faces named
// bkg1_right/left/top/bot/front/back.png (same convention as skybox_blue).
// Drop a new folder in with that naming and add its name here to make it
// selectable from the debug GUI dropdown. 'None (white)' is a special case
// handled directly below — no folder/textures involved.
export const SKYBOX_NONE    = 'None (white)';
export const SKYBOX_OPTIONS = ['skybox_blue', SKYBOX_NONE];

const SKYBOX_FACES = ['right', 'left', 'top', 'bot', 'front', 'back'];

export function buildSkybox(scene) {
    const textureLoader = new THREE.TextureLoader();
    const skybox = new THREE.Mesh(
        new THREE.BoxGeometry(1000, 1000, 1000),
        SKYBOX_FACES.map((face) => {
            const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide }); // maps set by loadSkybox()
            injectSkyboxFlow(mat, 'skybox_flow_' + face);
            return mat;
        })
    );
    scene.add(skybox);

    // Swaps all 6 face textures live, or switches to a flat white background.
    // Disposes previous textures so switching repeatedly in the GUI doesn't
    // leak GPU memory.
    function loadSkybox(folderName) {
        if (folderName === SKYBOX_NONE) {
            skybox.visible   = false;
            scene.background = new THREE.Color(0xffffff);
            return;
        }
        scene.background = null; // let the skybox mesh show through again
        skybox.visible    = true;
        skybox.material.forEach((mat, i) => {
            const face = SKYBOX_FACES[i];
            const oldMap = mat.map;
            mat.map = textureLoader.load(`asset/${folderName}/bkg1_${face}.png`);
            mat.needsUpdate = true;
            if (oldMap) oldMap.dispose();
        });
    }

    return { loadSkybox };
}

// ─── Stars ───────────────────────────────────────────────────────────────────
function makeStarTexture() {
    // Create a tiny invisible canvas (like a small blank drawing board)
    const c = document.createElement('canvas');
    c.width = c.height = 64; // 64x64 pixels, very small
    const ctx = c.getContext('2d'); // This gives the 2D drawing API

    // 32, 32, 0 = inner circle: center at (32,32), radius 0 (a single point)
    // 32, 32, 32 = outer circle: center at (32,32), radius 32 (reaches the edges)
    // gradient that starts from the exact center and expands outward to the edge.
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); // center: solid white
    g.addColorStop(1, 'rgba(255,255,255,0)'); // edge: fully transparent
    ctx.fillStyle = g; // loading the gradient definition
    ctx.fillRect(0, 0, 64, 64); // drawing from top-left corner (0,0) to bottom-right corner (64,64) using whatever fillStyle is currently loaded.
    return new THREE.CanvasTexture(c);
}

// Radians/sec the star field turns at full flow strength. Slow enough to
// read as drifting, not spinning.
const STAR_ROTATE_SPEED = 0.03;

export function buildStars(scene) {
    const STAR_COUNT = 1000;
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const starColor = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT * 3; i++) starPositions[i] = (Math.random() - 0.5) * 200;
    for (let i = 0; i < STAR_COUNT * 3; i += 3) { starColor[i] = 1; starColor[i + 1] = 0.9; starColor[i + 2] = 0.8; }

    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeometry.setAttribute('color',    new THREE.BufferAttribute(starColor, 3));

    const starPoints = new THREE.Points(starGeometry, new THREE.PointsMaterial({
        size: 1, sizeAttenuation: true, map: makeStarTexture(),
        transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, vertexColors: true,
    }));
    // Tilted rotation axis (rather than pure Y) so the drift reads as a
    // tumbling field rather than a flat carousel spin.
    starPoints.rotation.x = 0.4;
    starPoints.rotation.z = 0.15;
    scene.add(starPoints);

    // Star field turns together with the skybox warp — same toggle, same
    // eased uFlowStrength — so both read as one swirling motion instead of
    // a moving background behind motionless points.
    function updateStars(dt) {
        starPoints.rotation.y += STAR_ROTATE_SPEED * uFlowStrength.value * dt;
    }

    return { updateStars };
}
