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

// ─── Scene & Camera ──────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 2.0, 6.0); // elevated for still-life angle (~30° down at table)

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
    // floor   — normal points up   (+y)
    { w: 14, h: 14, pos: [0, -3.5,  0], rx: -Math.PI / 2, ry: 0,            color: 0x9e7450 },
    // ceiling — normal points down (-y)
    { w: 14, h: 14, pos: [0,  3.5,  0], rx:  Math.PI / 2, ry: 0,            color: 0xf0e6d2 },
    // back wall  — normal points +z (toward camera)
    { w: 14, h:  7, pos: [0,  0,   -7], rx: 0,            ry: 0,            color: 0x777541 },
    // front wall — normal points -z (toward back wall)
    { w: 14, h:  7, pos: [0,  0,    7], rx: 0,            ry: Math.PI,      color: 0x777541 },
    // left wall  — normal points +x
    { w: 14, h:  7, pos: [-7, 0,    0], rx: 0,            ry:  Math.PI / 2, color: 0x777541 },
    // right wall — normal points -x
    { w: 14, h:  7, pos: [ 7, 0,    0], rx: 0,            ry: -Math.PI / 2, color: 0x777541 },
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
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xfff5e0, 1.05);
directionalLight.position.set(-5, 8, 3);
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.set(2048, 2048);
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far  = 30;
directionalLight.shadow.camera.left = -8;
directionalLight.shadow.camera.right = 8;
directionalLight.shadow.camera.top  = 8;
directionalLight.shadow.camera.bottom = -8;
scene.add(directionalLight);

// ─── Table (GLB model) ───────────────────────────────────────────────────────
const TABLE_PARTICLE_COUNT = 2000;
const uTableProgress       = { value: 0.0 };
const uTableTime           = { value: 0.0 };
let tableObject   = null; // set once GLB loads
let TABLE_FLOOR_Y = -3.5; // resting Y of the table mesh root; updated after GLB positions itself

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
    TABLE_FLOOR_Y = tableObject.position.y; // save resting Y for floating animation

    console.log('Table size (units):', tableBox.getSize(new THREE.Vector3()));

    // ── Load stage objects now that table surface Y is known ─────────────────
    tableBox.setFromObject(tableObject);
    const tableSurfaceY = tableBox.max.y;
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
});

// ─── Stage Objects (GLB models placed on the table) ──────────────────────────
// Each entry defines one still-life object: its file, visual scale, table position,
// floating motion params, and when it starts dissolving after the button is clicked.
const OBJECT_PARTICLE_COUNT = 1500;

const OBJECT_DEFS = [
    // offsetX/Z are relative to the table centre (world 0,0).
    // dissolveStart: seconds after button click when this object begins dissolving.
    // phaseOffset: shifts the sin/cos waves so every object drifts independently in space.
    { file: 'asset/the_lonely_tulip.glb', label: 'tulip', targetHeight: 0.8,  offsetX: -0.5, offsetZ: -0.5, H: 2.5, phaseOffset: 0.0, dissolveStart:  0 },
    { file: 'asset/Wooden_dummy.glb',      label: 'dummy', targetHeight: 0.55, offsetX:  0.0, offsetZ:  0.1, H: 2.0, phaseOffset: 1.2, dissolveStart:  5 },
    { file: 'asset/teddy_bear.glb',        label: 'teddy', targetHeight: 0.45, offsetX:  0.5, offsetZ: -0.4, H: 2.2, phaseOffset: 2.4, dissolveStart: 10 },
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

            const mat = child.material.clone();
            mat.transparent = true;
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
        // Place so bottom of mesh sits exactly on the table surface
        mesh.position.set(def.offsetX, surfaceY - box1.min.y, def.offsetZ);

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

        for (let i = 0; i < OBJECT_PARTICLE_COUNT; i++) {
            const src = Math.floor(Math.random() * vertexCount) * 3;
            const px = rawPositions[src], py = rawPositions[src+1], pz = rawPositions[src+2];
            particlePositions[i*3] = px; particlePositions[i*3+1] = py; particlePositions[i*3+2] = pz;
            const r = Math.sqrt(px*px + pz*pz) || 1;
            particleVelocities[i*3]   = (px/r) * (Math.random() * 1.2 + 0.4);
            particleVelocities[i*3+1] = Math.random() * 2.0 + 0.3;
            particleVelocities[i*3+2] = (pz/r) * (Math.random() * 1.2 + 0.4);
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

        stageObjects.push({
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
        });
    });
}

// ─── Orbit Controls ──────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.08;
controls.enablePan        = false;
controls.enableZoom       = false;
controls.rotateSpeed      = 1.0;
controls.target.set(0, -2.0, -1); // aimed at table surface for still-life view

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
const ROOM_RETURN_DIST = 9.5; // new camera radius ≈ 8.1 units; 9.5 gives comfortable margin

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

    if (uProgress.value >= 1.0) {
        const dist = camera.position.distanceTo(controls.target);
        if (!hasZoomedOut || dist > ROOM_RETURN_DIST) return;
    }
    uProgress.value = Math.min(1.0, Math.max(0.0, uProgress.value + e.deltaY * 0.001));
    if (uProgress.value < 0.95) {
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
gui.add(uProgress,      'value', 0, 1, 0.01).name('Progress (p)').listen();
gui.add(uDissolveEdge,  'value', 0, 0.8, 0.01).name('Dissolve Edge');
gui.add(uNoiseFreq,     'value', 0.1, 1.5, 0.01).name('Noise Frequency');
gui.add(uDissolveEdgeColor.value, 'r', 0, 1, 0.01).name('Edge R');
gui.add(uDissolveEdgeColor.value, 'g', 0, 1, 0.01).name('Edge G');
gui.add(uDissolveEdgeColor.value, 'b', 0, 1, 0.01).name('Edge B');
const lightFolder = gui.addFolder('Lighting');
lightFolder.add(ambientLight, 'intensity', 0, 3, 0.05).name('Ambient');
lightFolder.add(directionalLight, 'intensity', 0, 10, 0.1).name('Directional');

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
    const p = uProgress.value;           // 0 = full room, 1 = full space

    uTableTime.value = t;

    // ── Phase state machine ──────────────────────────────────────────────────
    // room → (uProgress=1) → space → (GUI button) → dissolving → done
    if (phase === 'room' && p >= 1.0) {
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

    // ── Lighting transition: warm room → cold cosmos ─────────────────────────
    // Only update lighting during transition — skip when fully settled at p=0 or p=1
    if (p > 0.001 && p < 0.999) {
        // Ambient: bright warm white (room) → faint deep blue (space)
        ambientLight.color.setRGB(
            THREE.MathUtils.lerp(1.00, 0.05, p),   // R
            THREE.MathUtils.lerp(1.00, 0.08, p),   // G
            THREE.MathUtils.lerp(1.00, 0.22, p)    // B
        );
        ambientLight.intensity = THREE.MathUtils.lerp(0.7, 0.0, p);

        // Directional: warm sunlight (0xfff5e0) → pure white harsh sunlight in space
        directionalLight.color.setRGB(
            THREE.MathUtils.lerp(1.00, 1.00, p),
            THREE.MathUtils.lerp(0.96, 1.00, p),
            THREE.MathUtils.lerp(0.88, 1.00, p)
        );
        directionalLight.intensity = THREE.MathUtils.lerp(1.05, 3.5, p);
    }

    // ── Stage objects floating ────────────────────────────────────────────────
    // Each object uses the same formula but with a unique phaseOffset so they
    // drift independently (phase-shifted sin/cos waves → never in sync).
    for (const obj of stageObjects) {
        obj.uTime.value = t;
        const phi    = obj.phaseOffset;
        const rise   = p * obj.H;
        const bob    = Math.sin(t * 0.75 + phi) * 0.25 * p;
        const driftX = Math.sin(t * 0.40 + phi * 0.7) * 0.4 * p;
        const driftZ = Math.cos(t * 0.33 + phi * 0.9) * 0.3 * p;
        obj.mesh.position.y = obj.restY + rise + bob;
        obj.mesh.position.x = obj.restX + driftX;
        obj.mesh.position.z = obj.restZ + driftZ;
        obj.mesh.rotation.y += 0.002 * p;
        obj.mesh.rotation.z  = Math.sin(t * 0.42 + phi) * 0.06 * p;
    }

    // ── Table floating ───────────────────────────────────────────────────────
    // Different H, A, ω values from cylinder → independent drift in space.
    // Guard with null check because the GLB loads asynchronously.
    if (tableObject) {
        const tableRise   = p * 1.5;
        const tableBob    = Math.sin(t * 0.62 + 1.2) * 0.18 * p;
        const tableDriftX = Math.sin(t * 0.37 + 0.7) * 0.55 * p;
        const tableDriftZ = Math.cos(t * 0.29 + 1.5) * 0.40 * p;
        tableObject.position.y = TABLE_FLOOR_Y + tableRise + tableBob;
        tableObject.position.x = tableDriftX;
        tableObject.position.z = tableDriftZ;
        tableObject.rotation.y += 0.0015 * p;
        tableObject.rotation.z  = Math.sin(t * 0.38) * 0.04 * p;
    }

    controls.update();
    renderer.render(scene, camera);
}
animate();
