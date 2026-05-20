import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// --- Scene & Camera ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 1.6, 3);

// --- Skybox ---
const textureLoader = new THREE.TextureLoader();
const skyboxMaterials = [
    new THREE.MeshBasicMaterial({ map: textureLoader.load('asset/skybox_blue/bkg1_right.png'), side: THREE.BackSide }),
    new THREE.MeshBasicMaterial({ map: textureLoader.load('asset/skybox_blue/bkg1_left.png'),  side: THREE.BackSide }),
    new THREE.MeshBasicMaterial({ map: textureLoader.load('asset/skybox_blue/bkg1_top.png'),   side: THREE.BackSide }),
    new THREE.MeshBasicMaterial({ map: textureLoader.load('asset/skybox_blue/bkg1_bot.png'),   side: THREE.BackSide }),
    new THREE.MeshBasicMaterial({ map: textureLoader.load('asset/skybox_blue/bkg1_front.png'), side: THREE.BackSide }),
    new THREE.MeshBasicMaterial({ map: textureLoader.load('asset/skybox_blue/bkg1_back.png'),  side: THREE.BackSide }),
];
const skybox = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), skyboxMaterials);
scene.add(skybox);

// --- Stars ---
function makeStarTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
}

const starCount = 300;
const starPositions = new Float32Array(starCount * 3);
const starColors = new Float32Array(starCount * 3);

for (let i = 0; i < starCount * 3; i++) {
    starPositions[i] = (Math.random() - 0.5) * 200;
}
for (let i = 0; i < starCount * 3; i += 3) {
    starColors[i]     = 1.0;
    starColors[i + 1] = 0.9;
    starColors[i + 2] = 0.8;
}

const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
starGeo.setAttribute('color',    new THREE.BufferAttribute(starColors, 3));

const starMat = new THREE.PointsMaterial({
    size: 1,
    sizeAttenuation: true,
    map: makeStarTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
});
scene.add(new THREE.Points(starGeo, starMat));

// --- Room shader ---
// vPosition lets the fragment shader know where on the surface it is,
// so we can simulate light falling from above without Three.js lighting.
const vertexShader = `
    varying vec2 vUv;
    varying vec3 vPosition;
    void main() {
        vUv = uv;
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const fragmentShader = `
    varying vec2 vUv;
    varying vec3 vPosition;
    uniform float uProgress;
    uniform vec3 uColor;

    // --- Simplex Noise (Gustavson) ---
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

    float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy));
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
        vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
        m = m * m * m * m;
        vec3 x  = 2.0 * fract(p * C.www) - 1.0;
        vec3 h  = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
        vec3 g;
        g.x  = a0.x  * x0.x   + h.x  * x0.y;
        g.yz = a0.yz * x12.xz  + h.yz * x12.yw;
        return 130.0 * dot(m, g); // returns [-1, 1]
    }

    float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) {
            v += a * (snoise(p) * 0.5 + 0.5); // remap [-1,1] → [0,1]
            p *= 2.0;
            a *= 0.5;
        }
        return v;
    }

    void main() {
        // room is BoxGeometry(14, 7, 14): y goes -3.5 (floor) to +3.5 (ceiling)
        float heightGrad = clamp((vPosition.y + 3.5) / 7.0, 0.0, 1.0);

        float light;

        if (vPosition.y > 3.0) {
            // ceiling: bright at centre (lamp), fades toward edges
            float radial = clamp(length(vUv - vec2(0.5)) * 1.8, 0.0, 1.0);
            light = mix(1.0, 0.72, radial);

        } else if (vPosition.y < -3.0) {
            // floor: softer centre highlight from overhead lamp
            float radial = clamp(length(vUv - vec2(0.5)) * 1.4, 0.0, 1.0);
            light = mix(0.85, 0.55, radial);

        } else {
            // walls: bright near ceiling, darker near floor
            // slight horizontal fade toward corners
            float hFade = 1.0 - abs(vUv.x - 0.5) * 0.28;
            light = mix(0.45, 1.0, heightGrad) * hFade;
        }

        vec3 lit = uColor * light;

        float threshold = mix(1.2, -0.2, uProgress);
        float n = fbm(vUv * 3.0);
        float alpha = 1.0 - smoothstep(threshold - 0.2, threshold + 0.2, n);
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(lit, alpha);
    }
`;

// BoxGeometry face order: +x, -x, +y, -y, +z, -z
const faceColors = [
    0xc8a87c, // right wall
    0xc8a87c, // left wall
    0xf0e6d2, // ceiling — warm cream
    0x9e7450, // floor   — warm mid-brown
    0xc8a87c, // front wall
    0xc8a87c, // back wall
];

const roomMaterials = faceColors.map(color => new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    uniforms: {
        uProgress: { value: 0.0 },
        uColor:    { value: new THREE.Color(color) },
    },
    vertexShader,
    fragmentShader,
}));

scene.add(new THREE.Mesh(new THREE.BoxGeometry(14, 7, 14), roomMaterials));

// --- Warm lighting ---
scene.add(new THREE.AmbientLight(0xffd9a0, 0.6));
const ceilingLight = new THREE.PointLight(0xffc97a, 2.5, 20);
ceilingLight.position.set(0, 3.2, 0);
scene.add(ceilingLight);

// Soft fill from below to reduce harsh floor shadows
const fillLight = new THREE.PointLight(0xffb347, 0.4, 12);
fillLight.position.set(0, -2, 0);
scene.add(fillLight);

// --- Orbit Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.enableZoom = false;
controls.rotateSpeed = 2.0;
controls.target.set(0, 1.6, 0);
controls.minPolarAngle = Math.PI * 0.15;
controls.maxPolarAngle = Math.PI * 0.82;

// --- Scroll ---
let scrollProgress = 0;
window.addEventListener('wheel', (e) => {
    scrollProgress = Math.min(1.0, Math.max(0.0, scrollProgress + e.deltaY * 0.001));
    roomMaterials.forEach(m => m.uniforms.uProgress.value = scrollProgress);
});

// --- Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// --- Animate ---
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();
