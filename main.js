import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }   from 'three/addons/loaders/GLTFLoader.js';
import GUI from 'lil-gui';

// ─── Renderer ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// ─── Loading Screen ──────────────────────────────────────────────────────────
// State machine:  'showing' → (GLBs ready + 1.2 s min hold) → 'dissolving' → 'done'
//
// 'showing'   — particles are static at their home positions; "Unstil Life" is readable.
// 'dissolving'— each particle drifts from home to its scatter position with a staggered
//               left-to-right delay so each letter dissolves in sequence.
// 'done'      — overlay fades out and is removed, revealing the Three.js scene.
const loadingOverlay = document.createElement('div');
Object.assign(loadingOverlay.style, {
    position: 'fixed', inset: '0', background: '#fff',
    zIndex: '100', transition: 'opacity 1.2s ease',
});

const loadingCanvas = document.createElement('canvas');
loadingCanvas.width  = window.innerWidth;
loadingCanvas.height = window.innerHeight;
Object.assign(loadingCanvas.style, { position: 'absolute', inset: '0' });
loadingOverlay.appendChild(loadingCanvas);
document.body.appendChild(loadingOverlay);

const lCtx          = loadingCanvas.getContext('2d');
let loadingParticles = [];
let loadingAnimId    = null;

let loadingState    = 'showing';   // 'showing' | 'dissolving' | 'done'
let dissolveStartMs = 0;           // rAF timestamp captured on first dissolving frame
let textReady       = false;
let allGLBsReady    = false;
let showStartMs     = 0;           // performance.now() when text first became visible
const MIN_SHOW_MS   = 1200;        // always display text for at least this long

function maybeStartDissolve() {
    if (!textReady || !allGLBsReady || loadingState !== 'showing') return;
    const waited = performance.now() - showStartMs;
    const delay  = Math.max(0, MIN_SHOW_MS - waited);
    setTimeout(() => { if (loadingState === 'showing') loadingState = 'dissolving'; }, delay);
}

// Sample "Unstil Life" glyph pixels after the Google Font is guaranteed loaded.
document.fonts.ready.then(() => {
    const W = loadingCanvas.width;
    const H = loadingCanvas.height;

    const off    = document.createElement('canvas');
    off.width = W; off.height = H;
    const offCtx = off.getContext('2d');

    const fontSize = Math.min(W * 0.08, 86);
    offCtx.font          = `300 ${fontSize}px 'Cormorant Garamond', Garamond, serif`;
    offCtx.textAlign     = 'center';
    offCtx.textBaseline  = 'middle';
    offCtx.letterSpacing = `${fontSize * 0.12}px`;
    offCtx.fillStyle     = '#000';
    offCtx.fillText('Unstil Life', W / 2, H / 2);

    const imgData    = offCtx.getImageData(0, 0, W, H).data;
    const textPixels = [];
    const STEP = 3;
    for (let y = 0; y < H; y += STEP)
        for (let x = 0; x < W; x += STEP)
            if (imgData[(y * W + x) * 4 + 3] > 120) textPixels.push([x, y]);

    // Shuffle so the 900-particle cap samples evenly across all letters
    for (let i = textPixels.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [textPixels[i], textPixels[j]] = [textPixels[j], textPixels[i]];
    }

    loadingParticles = textPixels.slice(0, 900).map(([hx, hy]) => {
        const angle = Math.random() * Math.PI * 2;
        const dist  = Math.random() * 90 + 30;
        return {
            homeX:        hx,
            homeY:        hy,
            scatterX:     hx + Math.cos(angle) * dist,
            scatterY:     hy + Math.sin(angle) * dist - Math.random() * 25, // slight upward drift
            // dissolveDelay: left letters start first, staggered over 0.55 s + per-particle noise
            dissolveDelay: (hx / W) * 0.55 + Math.random() * 0.08,
            r:            Math.random() * 1.0 + 0.6,
        };
    });

    showStartMs = performance.now();
    textReady   = true;
    maybeStartDissolve();
});

function animateLoadingScreen(time) {
    loadingAnimId = requestAnimationFrame(animateLoadingScreen);
    lCtx.clearRect(0, 0, loadingCanvas.width, loadingCanvas.height);

    if (loadingState === 'showing') {
        // Static: every particle sits exactly at its home position
        for (const p of loadingParticles) {
            lCtx.beginPath();
            lCtx.arc(p.homeX, p.homeY, p.r, 0, Math.PI * 2);
            lCtx.fillStyle = 'rgba(0,0,0,0.88)';
            lCtx.fill();
        }
        return;
    }

    if (loadingState === 'dissolving') {
        if (dissolveStartMs === 0) dissolveStartMs = time; // latch on first dissolving frame
        const elapsed = (time - dissolveStartMs) * 0.001; // seconds since dissolve began

        let allSettled = true;
        for (const p of loadingParticles) {
            // Each particle waits for its dissolveDelay, then moves over 1.1 s
            const localT = Math.min(Math.max((elapsed - p.dissolveDelay) / 1.1, 0), 1);
            if (localT < 1) allSettled = false;

            const x     = p.homeX + (p.scatterX - p.homeX) * localT;
            const y     = p.homeY + (p.scatterY - p.homeY) * localT;
            const alpha = Math.pow(1 - localT, 1.8) * 0.88 + 0.02;

            lCtx.beginPath();
            lCtx.arc(x, y, p.r, 0, Math.PI * 2);
            lCtx.fillStyle = `rgba(0,0,0,${alpha})`;
            lCtx.fill();
        }

        if (allSettled) {
            loadingState = 'done';
            gui.show(); // reveal debug panel only after loading screen is gone
            loadingOverlay.style.opacity = '0';
            setTimeout(() => {
                loadingOverlay.remove();
                cancelAnimationFrame(loadingAnimId);
            }, 1200);
        }
    }
}
loadingAnimId = requestAnimationFrame(animateLoadingScreen);

// Called once per GLB that finishes loading.
const LOADING_TOTAL = 4; // table + tulip + dummy + teddy
let loadedCount = 0;
function onGLBLoaded() {
    loadedCount++;
    if (loadedCount >= LOADING_TOTAL) {
        allGLBsReady = true;
        maybeStartDissolve();
    }
}
// Safety net: if GLBs haven't finished after 15 s (slow network / 404), force proceed.
setTimeout(() => {
    if (!allGLBsReady) {
        console.warn('GLB load timeout — forcing loading screen to proceed.');
        allGLBsReady = true;
        maybeStartDissolve();
    }
}, 15000);

// ─── Scene & Camera ──────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(-0.2, -0.29, 5.52);

// ─── Skybox ──────────────────────────────────────────────────────────────────
const textureLoader = new THREE.TextureLoader();
const skybox = new THREE.Mesh(
    new THREE.BoxGeometry(1000, 1000, 1000),
    ['right','left','top','bot','front','back'].map(face =>
        new THREE.MeshBasicMaterial({   // the universe/space should not
            map: textureLoader.load(`asset/skybox_blue/bkg1_${face}.png`),
            side: THREE.BackSide,
        })
    )
);
scene.add(skybox);

// ─── Stars ───────────────────────────────────────────────────────────────────
function makeStarTexture() {
    // Create a tiny invisible canvas (like a small blank drawing board)
    const c = document.createElement('canvas');
    c.width = c.height = 64;// 64x64 pixels, very small
    const ctx = c.getContext('2d'); // This gives the 2D drawing API

    // 32, 32, 0 = inner circle: center at (32,32), radius 0 (a single point)
    // 32, 32, 32 = outer circle: center at (32,32), radius 32 (reaches the edges)
    // gradient that starts from the exact center and expands outward to the edge.
    const g = ctx.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0,'rgba(255,255,255,1)'); // center: solid white
    g.addColorStop(1,'rgba(255,255,255,0)'); // edge: fully transparent
    ctx.fillStyle = g; // loading the gradient definition
    ctx.fillRect(0,0,64,64); // drawing from top-left corner (0,0) to bottom-right corner (64,64) using whatever fillStyle is currently loaded.
    return new THREE.CanvasTexture(c);
}

const STAR_COUNT = 1000;
const starPositions = new Float32Array(STAR_COUNT * 3);
const starColor = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT * 3; i++) starPositions[i] = (Math.random() - 0.5) * 200;
for (let i = 0; i < STAR_COUNT * 3; i += 3) { starColor[i] = 1; starColor[i+1] = 0.9; starColor[i+2] = 0.8; }
const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
starGeometry.setAttribute('color',    new THREE.BufferAttribute(starColor, 3));
scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({
    size: 1, sizeAttenuation: true, map: makeStarTexture(),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, vertexColors: true,
})));

// ─── Shared GLSL: 3D Simplex Noise ───────────────────────────────────────────
// Based on Ashima Arts / Stefan Gustavson implementation
const NOISE_GLSL = /* glsl */`
    vec3  _m289v3(vec3  x){return x-floor(x*(1./289.))*289.;}
    vec4  _m289v4(vec4  x){return x-floor(x*(1./289.))*289.;}
    vec4  _perm(vec4   x){return _m289v4(((x*34.)+1.)*x);}
    vec4  _tis(vec4    r){return 1.79284291400159-0.85373472095314*r;}

    float snoise3(vec3 v){
        const vec2 C=vec2(1./6.,1./3.);
        const vec4 D=vec4(0.,.5,1.,2.);
        vec3 i =floor(v+dot(v,C.yyy));
        vec3 x0=v-i+dot(i,C.xxx);
        vec3 g =step(x0.yzx,x0.xyz);
        vec3 l =1.-g;
        vec3 i1=min(g.xyz,l.zxy);
        vec3 i2=max(g.xyz,l.zxy);
        vec3 x1=x0-i1+C.xxx;
        vec3 x2=x0-i2+C.yyy;
        vec3 x3=x0-D.yyy;
        i=_m289v3(i);
        vec4 p=_perm(_perm(_perm(
            i.z+vec4(0.,i1.z,i2.z,1.))
           +i.y+vec4(0.,i1.y,i2.y,1.))
           +i.x+vec4(0.,i1.x,i2.x,1.));
        float n_=.142857142857;
        vec3 ns=n_*D.wyz-D.xzx;
        vec4 j =p-49.*floor(p*ns.z*ns.z);
        vec4 x_=floor(j*ns.z);
        vec4 y_=floor(j-7.*x_);
        vec4 x =x_*ns.x+ns.yyyy;
        vec4 y =y_*ns.x+ns.yyyy;
        vec4 h =1.-abs(x)-abs(y);
        vec4 b0=vec4(x.xy,y.xy);
        vec4 b1=vec4(x.zw,y.zw);
        vec4 s0=floor(b0)*2.+1.;
        vec4 s1=floor(b1)*2.+1.;
        vec4 sh=-step(h,vec4(0.));
        vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
        vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
        vec3 p0=vec3(a0.xy,h.x);
        vec3 p1=vec3(a0.zw,h.y);
        vec3 p2=vec3(a1.xy,h.z);
        vec3 p3=vec3(a1.zw,h.w);
        vec4 norm=_tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
        p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
        vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
        m=m*m;
        return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }
`;

// ─── Room ────────────────────────────────────────────────────────────────────
// MeshStandardMaterial — Three.js lights work normally.
// Dissolve is injected via onBeforeCompile so we keep the noise-based transition.
// onBeforeCompile is for modifying Three.js's built-in materials (MeshStandardMaterial, etc.)
// materials where you want to keep the lighting but add something.

const uProgress          = { value: 0.0 };
const uDissolveEdge      = { value: 0.25 };
const uNoiseFreq         = { value: 0.35 };
const uDissolveEdgeColor = { value: new THREE.Color(0x000000) };

// Dissolve snippet injected into every face material
const DISSOLVE_FRAG_INJECT = /* glsl */`
    uniform float uProgress;
    uniform float uEdge;
    uniform float uFreq;
    uniform vec3  uEdgeColor;
    varying vec3  vWorldPos;

    ${NOISE_GLSL}
`;

function makeRoomMaterial(hex) {
    const mat = new THREE.MeshStandardMaterial({
        color: hex,
        side:  THREE.FrontSide,
        transparent: true,
        roughness: 0.9,
        metalness: 0.0,
    });

    mat.onBeforeCompile = (shader) => {
        // Share dissolve uniforms
        shader.uniforms.uProgress  = uProgress;           // how dissolved (0→1)
        shader.uniforms.uEdge      = uDissolveEdge;       // thickness of the glow edge band
        shader.uniforms.uFreq      = uNoiseFreq;          // noise scale (smaller = bigger blobs)
        shader.uniforms.uEdgeColor = uDissolveEdgeColor;  // colour of the dissolve edge

        // Pass world position from vertex shader
        shader.vertexShader =
            'varying vec3 vWorldPos;\n' +
            shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;` // converts local position to world space position
            );

        // Inject dissolve uniforms + noise at top of fragment shader
        shader.fragmentShader =
            DISSOLVE_FRAG_INJECT +
            shader.fragmentShader;

        // Apply dissolve after Three.js computes the lit colour
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>

            if(uProgress > 0.01){
                float threshold = mix(-1.2, 1.2, uProgress);
                float noise     = snoise3(vWorldPos * uFreq);

                if(noise < threshold) discard;

                float edgeEnd = threshold + uEdge;
                if(noise < edgeEnd){
                    float t     = (noise - threshold) / uEdge;
                    float alpha = mix(0.5, 1.0, t);
                    gl_FragColor = vec4(mix(uEdgeColor, gl_FragColor.rgb, t), alpha);
                }
            }`
        );
    };

    // Ensure each colour gets its own compiled program
    mat.customProgramCacheKey = () => String(hex);
    return mat;
}

// Individual planes — FrontSide with inward-pointing normals so DirectionalLight works
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

// Room dissolve uses shader only — no particles on room walls.

// ─── Lighting ────────────────────────────────────────────────────────────────
// Low-intensity warm ambient — just enough to lift the deepest shadows off pure black
const ambientLight = new THREE.AmbientLight(0x3d2010, 0.15);
scene.add(ambientLight);

// Single key light from upper-left-front — matches the photo's Rembrandt-style raking light
const directionalLight = new THREE.DirectionalLight(0xffe8b0, 2.2);
directionalLight.position.set(-6, 7, 5);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.set(1024, 1024);
directionalLight.shadow.bias       = -0.003; // prevents shadow acne (self-shadowing stripes)
directionalLight.shadow.normalBias =  0.02;  // extra offset along surface normal for curved meshes
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far  = 30;
directionalLight.shadow.camera.left = -8;
directionalLight.shadow.camera.right = 8;
directionalLight.shadow.camera.top  = 8;
directionalLight.shadow.camera.bottom = -8;
scene.add(directionalLight);

// ─── Fake volumetric light beam ──────────────────────────────────────────────
// Single cone with a custom gradient shader: full brightness at the tip (light
// source) fading to fully transparent at the base (floor). The cone stretches
// all the way down to the floor plane so there is no abrupt cut-off.
//
// ConeGeometry: apex at local +Y, base at local -Y.
// We rotate so +Y points toward the light source (upper-left, near ceiling)
// and -Y reaches the floor.
const BEAM_TIP  = new THREE.Vector3(-4.5,  2.8,  2.0); // upper-left, light entry
const BEAM_BASE = new THREE.Vector3( 0.8, -3.4, -2.3); // floor intersection

const _beamAxis    = new THREE.Vector3().subVectors(BEAM_TIP, BEAM_BASE).normalize();
const _beamLen     = BEAM_TIP.distanceTo(BEAM_BASE);          // ~9.2 units
const _beamHalfLen = _beamLen * 0.5;
const _beamCenter  = new THREE.Vector3().addVectors(BEAM_TIP, BEAM_BASE).multiplyScalar(0.5);
const _beamQuat    = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _beamAxis);

// uBeamFade driven each frame in the animate loop to dissolve with the room
const uBeamFade = { value: 1.0 };

const beamMat = new THREE.ShaderMaterial({
    uniforms: { uBeamFade },
    vertexShader: /* glsl */`
        varying float vTipness;
        varying float vEdgeFade;
        void main() {
            // Axis fade: 0 at floor base, 1 at light-source tip
            vTipness = clamp(position.y / ${_beamHalfLen.toFixed(4)} * 0.5 + 0.5, 0.0, 1.0);

            // Edge fade: how much the surface faces the camera.
            // normalMatrix transforms model normals → view space.
            // In view space the camera looks down -Z, so the Z component of the
            // view-space normal equals cos(angle between normal and view direction).
            // At the silhouette edge the normal is perpendicular to view → Z≈0 → fade to 0.
            // Facing the camera directly → Z≈1 → full contribution.
            vec3 viewNormal = normalize(normalMatrix * normal);
            vEdgeFade = abs(viewNormal.z); // abs handles DoubleSide back-faces

            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform float uBeamFade;
        varying float vTipness;
        varying float vEdgeFade;
        void main() {
            // Tip-to-base fall-off (quadratic) × soft silhouette edge × room fade
            float edge  = smoothstep(0.0, 0.5, vEdgeFade); // transparent at edge, solid toward centre
            float alpha = vTipness * vTipness * 0.18 * edge * uBeamFade;
            gl_FragColor = vec4(1.0, 0.91, 0.65, alpha);
        }
    `,
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
    side:        THREE.DoubleSide,
});

const beamMesh = new THREE.Mesh(
    new THREE.ConeGeometry(2.2, _beamLen, 48, 1, true), // 48 segments → smooth circle
    beamMat
);
beamMesh.position.copy(_beamCenter);
beamMesh.quaternion.copy(_beamQuat);
beamMesh.renderOrder = 1;
scene.add(beamMesh);

// ─── Table (GLB model) ───────────────────────────────────────────────────────
const TABLE_PARTICLE_COUNT = 2000;
const uTableProgress       = { value: 0.0 };
const uTableTime           = { value: 0.0 };
let tableObject      = null;  // set once GLB loads
let TABLE_FLOOR_Y    = -3.5;  // resting Y, updated after GLB loads
let TABLE_FLOOR_Z    =  0.0;  // resting Z, updated after GLB loads
let TABLE_TOP_OFFSET =  0.0;  // table surface Y above pivot — used for sphere-plane collision

const gltfLoader = new GLTFLoader();

gltfLoader.load('asset/table.glb', (gltf) => {
    tableObject = gltf.scene;

    // ── Dissolve shader on every submesh ─────────────────────────────────────
    // GLB files contain a tree of Mesh children. We traverse every one and
    // inject the same dissolve logic used on the cylinder — local position so
    // the noise pattern stays fixed on the object as it floats.
    tableObject.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = child.receiveShadow = true;

        // Clone the material so each submesh owns its shader independently.
        // Without cloning, all meshes would share one compiled program and
        // the first mesh to compile would overwrite the others.
        const mat = child.material.clone();
        mat.transparent = true;

        mat.onBeforeCompile = (shader) => {
            shader.uniforms.uTableProgress = uTableProgress;
            shader.uniforms.uEdge          = uDissolveEdge;
            shader.uniforms.uFreq          = uNoiseFreq;
            shader.uniforms.uEdgeColor     = uDissolveEdgeColor;

            // Capture local-space vertex position and pass it to the fragment shader.
            // Local position stays constant on the mesh surface regardless of where
            // the table floats — the noise pattern "rides" with the object.
            shader.vertexShader =
                'varying vec3 vLocalPos;\n' +
                shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>
                    vLocalPos = position;`
                );

            shader.fragmentShader =
                `uniform float uTableProgress;
                 uniform float uEdge;
                 uniform float uFreq;
                 uniform vec3  uEdgeColor;
                 varying vec3  vLocalPos;
                 ${NOISE_GLSL}` +
                shader.fragmentShader;

            // Inject after PBR lighting so dissolve punches through the lit colour.
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                if (uTableProgress > 0.01) {
                    float threshold = mix(-1.2, 1.2, uTableProgress);
                    float noise     = snoise3(vLocalPos * uFreq * 4.0);
                    if (noise < threshold) discard;
                    float edgeEnd = threshold + uEdge;
                    if (noise < edgeEnd) {
                        float t = (noise - threshold) / uEdge;
                        gl_FragColor = vec4(mix(uEdgeColor, gl_FragColor.rgb, t), mix(0.5, 1.0, t));
                    }
                }`
            );
        };
        // Unique key per submesh prevents Three.js from reusing another mesh's
        // compiled shader program (which would skip our onBeforeCompile injection).
        mat.customProgramCacheKey = () => 'table_dissolve_' + child.uuid;
        child.material = mat;
    });

    // ── Position table: bottom face on the floor ──────────────────────────────
    // Add to scene first (at origin), then measure the bounding box.
    // Shifting position.y by (-3.5 - box.min.y) drops the lowest vertex to y=-3.5.
    tableObject.scale.setScalar(1.0);
    scene.add(tableObject);
    tableObject.updateWorldMatrix(true, true); // every mesh inside the table has a correct matrixWorld, so our vertex position sampling is accurate.

    const tableBox = new THREE.Box3().setFromObject(tableObject);
    tableObject.position.y = -3.5 - tableBox.min.y;
    tableObject.position.z = -1.2; // move table back so it sits under the light cone
    TABLE_FLOOR_Y = tableObject.position.y;
    TABLE_FLOOR_Z = tableObject.position.z;

    console.log('Table size (units):', tableBox.getSize(new THREE.Vector3()));

    // ── Load stage objects now that table surface Y is known ─────────────────
    tableBox.setFromObject(tableObject);
    const tableSurfaceY = tableBox.max.y;
    TABLE_TOP_OFFSET = tableSurfaceY - TABLE_FLOOR_Y; // fixed offset from pivot to surface top
    OBJECT_DEFS.forEach(def => loadStageObject(def, tableSurfaceY));

    // ── Build particle positions from GLB geometry ────────────────────────────
    // Each submesh has its own local coordinate system. We transform every vertex
    // into the table root's local space so particles sit on the actual mesh surface
    // and follow the table correctly as it floats (attached as a child below).
    const tableWorldInverse = new THREE.Matrix4().copy(tableObject.matrixWorld).invert();
    const rawPositions = [];

    tableObject.traverse((child) => {
        if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
        const posAttr = child.geometry.getAttribute('position');
        // toLocal converts: child world space → table local space
        const toLocal = new THREE.Matrix4().multiplyMatrices(tableWorldInverse, child.matrixWorld);
        const v = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i).applyMatrix4(toLocal);
            rawPositions.push(v.x, v.y, v.z);
        }
    });

    if (rawPositions.length === 0) return; // guard: GLB had no geometry

    const tableParticlePositions  = new Float32Array(TABLE_PARTICLE_COUNT * 3);
    const tableParticleVelocities = new Float32Array(TABLE_PARTICLE_COUNT * 3);
    const vertexCount = rawPositions.length / 3;

    for (let i = 0; i < TABLE_PARTICLE_COUNT; i++) {
        // Pick a random vertex from the collected geometry as a particle origin.
        const src = Math.floor(Math.random() * vertexCount) * 3;
        const px  = rawPositions[src];
        const py  = rawPositions[src + 1];
        const pz  = rawPositions[src + 2];
        // Store this position as the particle's starting position
        tableParticlePositions[i * 3]     = px;
        tableParticlePositions[i * 3 + 1] = py;
        tableParticlePositions[i * 3 + 2] = pz;

        // Velocity: scatter outward radially (xz) and upward (y).
        // Radial length prevents division by zero at the exact center.
        const radial = Math.sqrt(px * px + pz * pz) || 1;
        tableParticleVelocities[i * 3]     = (px / radial) * (Math.random() * 1.2 + 0.4);
        tableParticleVelocities[i * 3 + 1] = Math.random() * 2.0 + 0.3;
        tableParticleVelocities[i * 3 + 2] = (pz / radial) * (Math.random() * 1.2 + 0.4);
    }

    const tableParticleGeometry = new THREE.BufferGeometry();
    tableParticleGeometry.setAttribute('position',  new THREE.BufferAttribute(tableParticlePositions, 3));
    tableParticleGeometry.setAttribute('aVelocity', new THREE.BufferAttribute(tableParticleVelocities, 3));

    const tableParticleMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uObjectProgress: uTableProgress, // same GLSL name as cylinder; different { value } reference
            uEdge:           uDissolveEdge,
            uFreq:           uNoiseFreq,
            uParticleColor,
            uTime:           uTableTime,
        },
        vertexShader:   objectParticleVertexShader,   // shared shader — uObjectProgress is the only variable
        fragmentShader: objectParticleFragmentShader,
        transparent:    true,
        depthWrite:     false,
        blending:       THREE.AdditiveBlending,
    });

    // Attach as child so particles inherit the table's position/rotation automatically.
    tableObject.add(new THREE.Points(tableParticleGeometry, tableParticleMaterial));
    onGLBLoaded(); // table is ready
}, undefined, (err) => {
    console.error('Failed to load table.glb:', err);
    onGLBLoaded(); // still advance the counter so loading screen doesn't hang
});

// ─── Stage Objects (GLB models placed on the table) ──────────────────────────
// Each entry defines one still-life object: its file, visual scale, table position,
// floating motion params, and when it starts dissolving after the button is clicked.
const OBJECT_PARTICLE_COUNT = 750;

const OBJECT_DEFS = [
    // offsetX/Z are relative to the table centre (world 0,0).
    // offsetY (optional): extra height added on top of the surface-flush position.
    // dissolveStart: seconds after button click when this object begins dissolving.
    // phaseOffset: shifts the sin/cos waves so every object drifts independently in space.
    // Vase + tulip are separate meshes; tulip offsetY lifts it into the vase opening.
    // Tulip has a higher H so it rises faster and pulls away from the vase naturally.
    { file: 'asset/vase.glb',         label: 'vase',  targetHeight: 0.864, offsetX: -0.39, offsetZ: -1.55, rotYOffset: -0.9515, H: 2.2, phaseOffset: 0.0, dissolveStart:  0 },
    { file: 'asset/tulip.glb',        label: 'tulip', targetHeight: 1.056, offsetX: -0.39, offsetZ: -1.57, offsetY: 0.85, rotYOffset: 0, H: 3.2, phaseOffset: 0.0, dissolveStart:  0 },
    { file: 'asset/glass_cup.glb',    label: 'cup',   targetHeight: 0.55,  offsetX: -0.24, offsetZ: -0.76, rotYOffset: 0, H: 1.8, phaseOffset: 0.6, dissolveStart:  3 },
    { file: 'asset/Wooden_dummy.glb', label: 'dummy', targetHeight: 1.04,  offsetX:  0.42, offsetZ: -1.50, rotYOffset: -1.7216, H: 2.0, phaseOffset: 1.2, dissolveStart:  5 },
    { file: 'asset/bear_skeleton.glb',label: 'teddy', targetHeight: 0.84,  offsetX:  0.35, offsetZ: -0.76, rotYOffset: -0.6415, H: 2.2, phaseOffset: 2.4, dissolveStart: 10 },
];

// Filled as each GLB loads. Each entry: mesh, uProgress, uTime, restY, restX, restZ,
// H, phaseOffset, dissolveStart, shadowsKilled.
const stageObjects = [];

// Shared particle vertex shader — used by every dissolving object.
// The progress uniform is always bound as 'uObjectProgress' in the material;
// each object supplies its own { value } reference so they dissolve independently.
const objectParticleVertexShader = /* glsl */`
    attribute vec3  aVelocity;
    uniform float   uObjectProgress;
    uniform float   uEdge;
    uniform float   uFreq;
    uniform float   uTime;
    varying float   vAlpha;
    ${NOISE_GLSL}

    void main(){
        float threshold    = mix(-1.2, 1.2, uObjectProgress);
        float noise        = snoise3(position * uFreq * 4.0);
        float distFromEdge = noise - threshold;
        float driftBand    = uEdge * 1.5;

        if(distFromEdge > uEdge || distFromEdge < -driftBand){
            gl_Position  = vec4(9999., 9999., 9999., 1.);
            gl_PointSize = 0.;
            vAlpha       = 0.;
            return;
        }

        float t   = clamp(-distFromEdge / driftBand, 0., 1.);
        vec3  pos = position + aVelocity * t;

        // Sine-wave wiggle (Codrops)
        pos.x += sin(position.y * 3.0 + uTime * 2.0) * 0.05 * t;
        pos.z += cos(position.x * 3.0 + uTime * 1.7) * 0.05 * t;

        vAlpha = 1. - t;

        vec4 mvPos   = modelViewMatrix * vec4(pos, 1.);
        gl_PointSize = max(2., 60. / -mvPos.z);
        gl_Position  = projectionMatrix * mvPos;
    }
`;

const uParticleColor = { value: new THREE.Color(0xffffff) }; // bright white

const objectParticleFragmentShader = /* glsl */`
    uniform vec3  uParticleColor;
    varying float vAlpha;

    void main(){
        if(vAlpha < 0.01) discard;
        vec2  uv = gl_PointCoord - .5;
        if(length(uv) > .5) discard;
        float alpha = vAlpha * (1. - length(uv) * 2.);// = 1 at center, 0 at edge → makes the particle fade out at the edges (soft circle).
        gl_FragColor = vec4(uParticleColor, alpha);
    }
`;

// ─── loadStageObject ──────────────────────────────────────────────────────────
// Called once per entry in OBJECT_DEFS, after the table surface Y is known.
// Loads the GLB, applies dissolve shader + particle system, and registers the
// object in stageObjects so the animate loop can drive its floating + dissolve.
function loadStageObject(def, surfaceY) {
    const uObjProgress = { value: 0.0 };
    const uObjTime     = { value: 0.0 };

    gltfLoader.load(def.file, (gltf) => {
        const mesh = gltf.scene;

        // ── Dissolve shader on every submesh (same pattern as table) ───────────
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
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uObjProgress = uObjProgress;
                shader.uniforms.uEdge        = uDissolveEdge;
                shader.uniforms.uFreq        = uNoiseFreq;
                shader.uniforms.uEdgeColor   = uDissolveEdgeColor;

                shader.vertexShader =
                    'varying vec3 vLocalPos;\n' +
                    shader.vertexShader.replace(
                        '#include <begin_vertex>',
                        `#include <begin_vertex>
                        vLocalPos = position;`
                    );

                shader.fragmentShader =
                    `uniform float uObjProgress;
                     uniform float uEdge;
                     uniform float uFreq;
                     uniform vec3  uEdgeColor;
                     varying vec3  vLocalPos;
                     ${NOISE_GLSL}` +
                    shader.fragmentShader;

                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_fragment>',
                    `#include <dithering_fragment>
                    if (uObjProgress > 0.01) {
                        float threshold = mix(-1.2, 1.2, uObjProgress);
                        float noise     = snoise3(vLocalPos * uFreq * 4.0);
                        if (noise < threshold) discard;
                        float edgeEnd = threshold + uEdge;
                        if (noise < edgeEnd) {
                            float t = (noise - threshold) / uEdge;
                            gl_FragColor = vec4(mix(uEdgeColor, gl_FragColor.rgb, t), mix(0.5, 1.0, t));
                        }
                    }`
                );
            };
            mat.customProgramCacheKey = () => def.label + '_dissolve_' + child.uuid;
            child.material = mat;
        });

        // ── Scale to target height and position on table ───────────────────────
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

        // ── Build particle positions from GLB geometry (in mesh local space) ───
        mesh.updateWorldMatrix(true, true);
        const meshWorldInv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
        const rawPositions = [];

        mesh.traverse((child) => {
            if (!child.isMesh || !child.geometry?.getAttribute('position')) return;
            const posAttr = child.geometry.getAttribute('position');
            const toLocal = new THREE.Matrix4().multiplyMatrices(meshWorldInv, child.matrixWorld);
            const v = new THREE.Vector3();
            for (let i = 0; i < posAttr.count; i++) {
                v.fromBufferAttribute(posAttr, i).applyMatrix4(toLocal);
                rawPositions.push(v.x, v.y, v.z);
            }
        });

        if (rawPositions.length === 0) return;

        const particlePositions  = new Float32Array(OBJECT_PARTICLE_COUNT * 3);
        const particleVelocities = new Float32Array(OBJECT_PARTICLE_COUNT * 3);
        const vertexCount = rawPositions.length / 3;

        // velocityCompensation undoes the GLB's scaleFactor shrink.
        // The vertex shader applies modelViewMatrix (which includes scale), so a velocity
        // of 1.0 local = scaleFactor world. Multiplying by 1/scale restores world-space spread.
        const velocityCompensation = 1.0 / scaleFactor;
        for (let i = 0; i < OBJECT_PARTICLE_COUNT; i++) {
            const src = Math.floor(Math.random() * vertexCount) * 3;
            const px = rawPositions[src], py = rawPositions[src+1], pz = rawPositions[src+2];
            particlePositions[i*3] = px; particlePositions[i*3+1] = py; particlePositions[i*3+2] = pz;
            // Random spread angle instead of radial — avoids thin objects (tulip stem) clustering
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 1.5 + 0.5;
            particleVelocities[i*3]   = Math.cos(angle) * speed * velocityCompensation;
            particleVelocities[i*3+1] = (Math.random() * 2.5 + 0.5) * velocityCompensation;
            particleVelocities[i*3+2] = Math.sin(angle) * speed * velocityCompensation;
        }

        const particleGeom = new THREE.BufferGeometry();
        particleGeom.setAttribute('position',  new THREE.BufferAttribute(particlePositions, 3));
        particleGeom.setAttribute('aVelocity', new THREE.BufferAttribute(particleVelocities, 3));

        const particleMat = new THREE.ShaderMaterial({
            uniforms: {
                uObjectProgress: uObjProgress, // bound to THIS object's progress
                uEdge: uDissolveEdge, uFreq: uNoiseFreq,
                uParticleColor, uTime: uObjTime,
            },
            vertexShader:   objectParticleVertexShader,
            fragmentShader: objectParticleFragmentShader,
            transparent: true, depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        mesh.add(new THREE.Points(particleGeom, particleMat));

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
            spinY:        0,                        // cumulative auto-rotation (driven by animate loop)
            rotYOffset:   def.rotYOffset ?? 0,     // initial facing direction baked from GUI
            radius,                // sphere radius for collision detection
            sphereCenterLocalY,    // sphere centre Y above mesh pivot (for table collision)
            repelX:       0,       // accumulated repulsion offset, decays each frame
            repelY:       0,
            repelZ:       0,
        };
        stageObjects.push(entry);

        // ── Skeleton bone animation (bear_skeleton.glb) ────────────────────────
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

            // Sitting = rest pose folded backward -90° in the bone's parent space
            const fold = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), -Math.PI / 2
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
            mesh.position.y = surfaceY + Math.abs(box1.min.y) * 0.3;
            entry.restY = mesh.position.y;

            legBones = { bR, bL, standR, standL, sitR, sitL };
        });
        entry.legBones = legBones; // null for non-skeleton objects

        onGLBLoaded(); // this object is ready

        // ── Per-object debug folder ───────────────────────────────────────────
        // gui is module-level; it is defined synchronously before GLBs can load,
        // so it is always available here inside the async callback.
        const objFolder = gui.addFolder(def.label);
        const scaleProxy = { scale: scaleFactor };
        objFolder.add(scaleProxy, 'scale', 0.05, 5.0, 0.01).name('Scale')
            .onChange(v => mesh.scale.setScalar(v));
        const resetRepel = () => { entry.repelX = entry.repelY = entry.repelZ = 0; };
        objFolder.add(entry, 'restX', -3, 3, 0.01).name('Pos X').listen().onChange(resetRepel);
        objFolder.add(entry, 'restY', -5, 8, 0.01).name('Pos Y').listen().onChange(resetRepel);
        objFolder.add(entry, 'restZ', -3, 3, 0.01).name('Pos Z').listen().onChange(resetRepel);
        objFolder.add(entry, 'rotYOffset', -Math.PI, Math.PI, 0.01).name('Rot Y offset');
        objFolder.close();
        entry.guiFolder = objFolder; // saved so we can hide it after permanent dissolve
    }, undefined, (err) => {
        console.error(`Failed to load ${def.file}:`, err);
        onGLBLoaded(); // still advance counter so loading screen doesn't hang
    });
}

// ─── Orbit Controls ──────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.08;
controls.enablePan        = false;
controls.enableZoom       = false;
controls.rotateSpeed      = 1.0;
controls.target.set(0, -0.69, -0.5); // aimed at scene center, shifted up with camera

// Room-mode limits (applied initially, relaxed when in space)
// Limits calculated from orbital radius (r≈6.1) and room bounds
// maxPolar: acos((-3.3 - targetY) / r) = 1.70 rad — keeps camera above floor
// azimuth ±0.55π: keeps camera away from back wall at z=-7
const ROOM_LIMITS = {
    minAzimuth: -Math.PI * 0.55,
    maxAzimuth:  Math.PI * 0.55,
    minPolar:    Math.PI * 0.1,
    maxPolar:    1.65,
};

// Camera is "at the starting point" when within this distance of the target.
// Original orbit radius ≈ 6.1; add a small margin so the switch feels natural.
const ROOM_RETURN_DIST = 5.5; // orbit radius from new camera (~3.8 units); 5.5 gives comfortable margin

// Armed once the user zooms out past ROOM_RETURN_DIST after entering space.
// Prevents the room from immediately re-appearing when the room first dissolves
// (camera starts at ~6.1, already inside the threshold).
let hasZoomedOut = false;

// ─── Phase state machine ──────────────────────────────────────────────────────
// 'room'       — room visible, scroll controls uProgress
// 'space'      — room gone, zoom active, 5s timer counting
// 'dissolving' — objects dissolving automatically, scroll blocked
// 'done'       — all objects gone, scroll re-enabled to restore room
let phase         = 'room';
let targetP       = 0;     // raw scroll destination; uProgress.value lerps toward this
let phaseStart    = 0;   // clock time when current phase began
let scrollBlocked = false;

function applyControlMode() {
    const inSpace = uProgress.value >= 0.95;
    controls.minAzimuthAngle = inSpace ? -Infinity : ROOM_LIMITS.minAzimuth;
    controls.maxAzimuthAngle = inSpace ?  Infinity : ROOM_LIMITS.maxAzimuth;
    controls.minPolarAngle   = inSpace ?  0        : ROOM_LIMITS.minPolar;
    controls.maxPolarAngle   = inSpace ?  Math.PI  : ROOM_LIMITS.maxPolar;
    controls.minDistance = 2;
    controls.maxDistance = 200;
    // enableZoom managed every frame in animate loop
}
applyControlMode();

// ─── Scroll ──────────────────────────────────────────────────────────────────
// uProgress < 1              → scroll dissolves / restores room
// uProgress = 1, not yet zoomed out OR still far → OrbitControls zooms
// uProgress = 1, zoomed out AND back to start    → scroll restores room
window.addEventListener('wheel', (e) => {
    // Block scroll entirely during object dissolve phase
    if (scrollBlocked) return;

    if (targetP >= 1.0) {
        const dist = camera.position.distanceTo(controls.target);
        if (!hasZoomedOut || dist > ROOM_RETURN_DIST) return;
    }
    targetP = Math.min(1.0, Math.max(0.0, targetP + e.deltaY * 0.001));
    if (targetP < 0.95) {
        hasZoomedOut = false;
        phase = 'room';
        uTableProgress.value = 0;
        if (tableObject) {
            tableObject.userData.shadowsKilled = false;
            tableObject.traverse(c => { if (c.isMesh) c.castShadow = true; });
        }
        for (const obj of stageObjects) {
            obj.uProgress.value = 0;
            if (obj.shadowsKilled) {
                obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = true; });
                obj.shadowsKilled = false;
            }
        }
        dissolveController.disable();
    }
    applyControlMode();
});

// ─── Debug GUI ───────────────────────────────────────────────────────────────
// Comment out the gui block before final release
const gui = new GUI({ title: 'Unstil Life Debug' });
gui.hide(); // hidden during loading screen; shown in animateLoadingScreen when dissolve completes
gui.add(uProgress,      'value', 0, 1, 0.01).name('Progress (p)').listen();
gui.add(uDissolveEdge,  'value', 0, 0.8, 0.01).name('Dissolve Edge');
gui.add(uNoiseFreq,     'value', 0.1, 1.5, 0.01).name('Noise Frequency');
gui.add(uDissolveEdgeColor.value, 'r', 0, 1, 0.01).name('Edge R');
gui.add(uDissolveEdgeColor.value, 'g', 0, 1, 0.01).name('Edge G');
gui.add(uDissolveEdgeColor.value, 'b', 0, 1, 0.01).name('Edge B');
const lightFolder = gui.addFolder('Lighting');
lightFolder.add(ambientLight, 'intensity', 0, 3, 0.05).name('Ambient');
lightFolder.add(directionalLight, 'intensity', 0, 10, 0.1).name('Directional');
lightFolder.close();

// Camera position display — read-only, updated every frame in the animate loop.
// Only meaningful when inside the room (p < 0.95); numbers freeze in space mode.
const cameraDebug = { x: 0, y: 0, z: 0 };
const cameraFolder = gui.addFolder('Camera position (room)');
cameraFolder.add(cameraDebug, 'x').name('Cam X').listen().disable();
cameraFolder.add(cameraDebug, 'y').name('Cam Y').listen().disable();
cameraFolder.add(cameraDebug, 'z').name('Cam Z').listen().disable();

// Button lives in the GUI panel. Disabled until phase === 'space'.
const dissolveActions = {
    dissolve: () => {
        if (phase !== 'space') return;
        phase         = 'dissolving';
        phaseStart    = clock.getElapsedTime();
        scrollBlocked = true;
        dissolveController.disable();
    },
};
const dissolveController = gui.add(dissolveActions, 'dissolve').name('▶ Dissolve Objects');
dissolveController.disable(); // enabled by phase machine when room is fully gone

// ─── Resize ──────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
});

// ─── Animate ─────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // Lerp uProgress.value toward targetP — absorbs trackpad deltaY spikes.
    // Snap when within 0.001 so it actually reaches 0 and 1 exactly.
    uProgress.value += (targetP - uProgress.value) * 0.05;
    if (Math.abs(targetP - uProgress.value) < 0.001) uProgress.value = targetP;
    const p    = uProgress.value; // smooth — drives all visuals and shaders
    const rawP = targetP;         // instant — used only for state-machine thresholds

    uTableTime.value = t;

    // ── Phase state machine ──────────────────────────────────────────────────
    // room → (uProgress=1) → space → (GUI button) → dissolving → done
    if (phase === 'room' && rawP >= 1.0) {
        phase         = 'space';
        phaseStart    = t;
        scrollBlocked = false;
        dissolveController.enable(); // button becomes clickable when fully in space
    }

    if (phase === 'dissolving') {
        const elapsed = t - phaseStart;
        // Objects dissolve sequentially: tulip 0s, dummy 5s, teddy 10s (each over 3s)
        for (const obj of stageObjects) {
            const objElapsed = elapsed - obj.dissolveStart;
            obj.uProgress.value = Math.min(1.0, Math.max(0.0, objElapsed / 3.0));
            if (obj.uProgress.value >= 1.0 && !obj.shadowsKilled) {
                obj.mesh.traverse(c => { if (c.isMesh) c.castShadow = false; });
                obj.shadowsKilled = true;
            }
        }
        // Table dissolves last: starts at 15s, ends at 18s
        uTableProgress.value = Math.min(1.0, Math.max(0.0, (elapsed - 15.0) / 3.0));
        if (uTableProgress.value >= 1.0 && tableObject && !tableObject.userData.shadowsKilled) {
            tableObject.traverse(c => { if (c.isMesh) c.castShadow = false; });
            tableObject.userData.shadowsKilled = true;
        }
        if (elapsed >= 18.0) {
            phase         = 'done';
            scrollBlocked = false;
            // Permanently remove the 3 stage objects — only table returns on room restore
            for (const obj of stageObjects) {
                scene.remove(obj.mesh);
                if (obj.guiFolder) obj.guiFolder.hide();
            }
            stageObjects.length = 0; // clear array so animate loop and scroll handler skip them
        }
    }

    // ── Zoom toggle ──────────────────────────────────────────────────────────
    // Zoom is ON whenever fully in space AND (not yet zoomed out OR still far).
    // Turns OFF only after the user zoomed out past ROOM_RETURN_DIST and has
    // now zoomed back in — at that point scroll restores the room instead.
    if (uProgress.value >= 1.0) {
        const dist = camera.position.distanceTo(controls.target);
        if (dist > ROOM_RETURN_DIST) hasZoomedOut = true;
        controls.enableZoom = !hasZoomedOut || dist > ROOM_RETURN_DIST;
    } else {
        controls.enableZoom = false;
    }

    // ── Beam fade — disappears as room dissolves ─────────────────────────────
    // Fade quickly in the first 40 % of the scroll so the beam is gone well
    // before the room walls fully dissolve.
    uBeamFade.value = Math.max(0, 1 - p / 0.4);

    // ── Lighting transition: warm room → cold cosmos ─────────────────────────
    // Only update lighting during transition — skip when fully settled at p=0 or p=1
    if (p > 0.001 && p < 0.999) {
        // Ambient: dark warm brown (room) → faint deep blue (space)
        ambientLight.color.setRGB(
            THREE.MathUtils.lerp(0.24, 0.05, p),   // R  (0x3d = 61 → 0.24)
            THREE.MathUtils.lerp(0.13, 0.08, p),   // G  (0x20 = 32 → 0.13)
            THREE.MathUtils.lerp(0.06, 0.22, p)    // B  (0x10 = 16 → 0.06)
        );
        ambientLight.intensity = THREE.MathUtils.lerp(0.15, 0.0, p);

        // Directional: warm amber key (0xffe8b0) → pure white harsh sunlight in space
        directionalLight.color.setRGB(
            THREE.MathUtils.lerp(1.00, 1.00, p),
            THREE.MathUtils.lerp(0.91, 1.00, p),   // 0xe8 = 232 → 0.91
            THREE.MathUtils.lerp(0.69, 1.00, p)    // 0xb0 = 176 → 0.69
        );
        directionalLight.intensity = THREE.MathUtils.lerp(2.2, 3.5, p);
    }

    // ── Stage objects floating + collision ───────────────────────────────────
    // Split into 4 steps so collision resolution sees all positions at once.

    // Step 1 — compute base position for each object (no mesh write yet)
    for (const obj of stageObjects) {
        obj.uTime.value = t;
        const phi  = obj.phaseOffset;
        const rise = p * obj.H;
        // Bob: vertical oscillation gives the main floating rhythm
        const bob  = Math.sin(t * 0.75 + phi) * 0.25 * p;
        // Micro-sway: very small horizontal drift so objects feel weightless,
        // not like they're on a vertical rail. Amplitude is ~10× smaller than
        // the old driftX to avoid visible sliding.
        const swayX = Math.sin(t * 0.28 + phi * 1.1) * 0.04 * p;
        const swayZ = Math.cos(t * 0.21 + phi * 0.9) * 0.03 * p;
        obj._baseX = obj.restX + swayX;
        obj._baseY = obj.restY + rise + bob;
        obj._baseZ = obj.restZ + swayZ;
    }

    // Step 2 — decay / reset repulsion
    for (const obj of stageObjects) {
        if (p < 0.01) {
            // Fully back on the table: snap repelY to 0 so objects return to
            // exact rest position and don't hover after scrolling back.
            obj.repelY = 0;
        } else {
            obj.repelY *= 0.92;
        }
        obj.repelX = obj.repelZ = 0;
    }

    // Only vertical collision: table surface pushes objects upward when they overlap it.
    const collisionStrengthY = Math.min(1, p / 0.15);

    // Step 3b — table surface keeps objects from sinking through the table.
    if (tableObject && collisionStrengthY > 0) {
        const tableTopY = tableObject.position.y + TABLE_TOP_OFFSET;
        for (const obj of stageObjects) {
            const sphereBottomY = (obj._baseY + obj.repelY) + obj.sphereCenterLocalY - obj.radius;
            if (sphereBottomY < tableTopY) {
                obj.repelY += (tableTopY - sphereBottomY) * collisionStrengthY;
            }
        }
    }

    // Step 4 — write final position + rotation to each mesh
    for (const obj of stageObjects) {
        obj.mesh.position.x = obj._baseX + obj.repelX;
        obj.mesh.position.y = obj._baseY + obj.repelY;
        obj.mesh.position.z = obj._baseZ + obj.repelZ;
        obj.spinY += 0.002 * p;
        obj.mesh.rotation.y = obj.spinY + obj.rotYOffset;
        obj.mesh.rotation.z = Math.sin(t * 0.42 + obj.phaseOffset) * 0.06 * p;
        obj.mesh.rotation.x = Math.sin(t * 0.31 + obj.phaseOffset * 1.3) * 0.04 * p;

        // Skeleton leg animation: sitting → standing as p goes 0 → 0.3
        if (obj.legBones) {
            const { bR, bL, sitR, sitL, standR, standL } = obj.legBones;
            const boneT = Math.min(1, p / 0.3);
            bR.quaternion.slerpQuaternions(sitR, standR, boneT);
            bL.quaternion.slerpQuaternions(sitL, standL, boneT);
        }
    }

    // ── Table floating ───────────────────────────────────────────────────────
    // Different H, A, ω values from cylinder → independent drift in space.
    // Guard with null check because the GLB loads asynchronously.
    if (tableObject) {
        const tableRise   = p * 1.5;
        const tableBob    = Math.sin(t * 0.62 + 1.2) * 0.18 * p;
        tableObject.position.y = TABLE_FLOOR_Y + tableRise + tableBob;
        tableObject.position.x = 0;
        tableObject.position.z = TABLE_FLOOR_Z;
        tableObject.rotation.y += 0.0015 * p;
        tableObject.rotation.z  = Math.sin(t * 0.38) * 0.04 * p;
    }

    // Update camera debug display (capped to 2 decimal places for readability)
    cameraDebug.x = +camera.position.x.toFixed(2);
    cameraDebug.y = +camera.position.y.toFixed(2);
    cameraDebug.z = +camera.position.z.toFixed(2);

    controls.update();
    renderer.render(scene, camera);
}
animate();
