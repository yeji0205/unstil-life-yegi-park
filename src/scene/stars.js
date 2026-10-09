import * as THREE from 'three';
import { uFlowStrength } from '../effects/skyboxFlow.js';

// The star field in space: 500 soft dots on a shell around the scene, turning
// slowly with the skybox swirl.

// ─── Stars ───────────────────────────────────────────────────────────────────
// Soft round dot: a white radial gradient fading to transparent.
function makeStarTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64; // 64x64 pixels, very small
    const ctx = c.getContext('2d'); // This gives the 2D drawing API

    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); // center: solid white
    g.addColorStop(1, 'rgba(255,255,255,0)'); // edge: fully transparent
    ctx.fillStyle = g; // loading the gradient definition
    // Fills the whole 64×64 canvas with the gradient set above.
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
}

// Radians/sec the star field turns at full flow strength. Slow enough to
// read as drifting, not spinning.
const STAR_ROTATE_SPEED = 0.03;

export function buildStars(scene) {
    // The skybox already has painted stars; more than this competes with it.
    const STAR_COUNT = 500;
    // Stars sit on a shell well outside the room (14 × 7 × 14), so none can
    // appear indoors.
    const STAR_MIN_RADIUS = 45;   // comfortably beyond the room's far corner (~10)
    const STAR_MAX_RADIUS = 110;
    const starPositions = new Float32Array(STAR_COUNT * 3);
    const starColor = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
        // Uniform direction: taking z uniformly in [-1,1] avoids the clustering
        // at the poles you get from picking two angles at random.
        const z     = Math.random() * 2 - 1;
        const theta = Math.random() * Math.PI * 2;
        const r     = Math.sqrt(1 - z * z);
        const dist  = STAR_MIN_RADIUS + Math.random() * (STAR_MAX_RADIUS - STAR_MIN_RADIUS);
        starPositions[i * 3]     = Math.cos(theta) * r * dist;
        starPositions[i * 3 + 1] = z * dist;
        starPositions[i * 3 + 2] = Math.sin(theta) * r * dist;
    }
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

    // Turns with the skybox swirl (same toggle and strength), so both move as one.
    function updateStars(dt) {
        starPoints.rotation.y += STAR_ROTATE_SPEED * uFlowStrength.value * dt;
    }

    return { updateStars };
}
