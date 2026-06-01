import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
camera.position.set(0, 1.0, 4);

// ─── Skybox ──────────────────────────────────────────────────────────────────
const texLoader = new THREE.TextureLoader();
const skybox = new THREE.Mesh(
    new THREE.BoxGeometry(1000, 1000, 1000),
    ['right','left','top','bot','front','back'].map(face =>
        new THREE.MeshBasicMaterial({   // the universe/space should not
            map: texLoader.load(`asset/skybox_blue/bkg1_${face}.png`),
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
const starPos = new Float32Array(STAR_COUNT * 3);
const starColor = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT * 3; i++) starPos[i] = (Math.random() - 0.5) * 200;
for (let i = 0; i < STAR_COUNT * 3; i += 3) { starColor[i] = 1; starColor[i+1] = 0.9; starColor[i+2] = 0.8; }
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
starGeo.setAttribute('color',    new THREE.BufferAttribute(starColor, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
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

const uProgress  = { value: 0.0 };
const uEdge      = { value: 0.25 };
const uFreq      = { value: 0.35 };
const uEdgeColor = { value: new THREE.Color(0x000000) };

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
        shader.uniforms.uProgress  = uProgress;     // how dissolved (0→1)
        shader.uniforms.uEdge      = uEdge;         // thickness of the glow edge band
        shader.uniforms.uFreq      = uFreq;         // noise scale (smaller = bigger blobs)
        shader.uniforms.uEdgeColor = uEdgeColor;    // colour of the dissolve edge

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

const dirLight = new THREE.DirectionalLight(0xfff5e0, 1.05);
dirLight.position.set(-5, 8, 3);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far  = 30;
dirLight.shadow.camera.left = -8;
dirLight.shadow.camera.right = 8;
dirLight.shadow.camera.top  = 8;
dirLight.shadow.camera.bottom = -8;
scene.add(dirLight);

// ─── Cylinder (placeholder object) ───────────────────────────────────────────
const cylinderHeight = 1.2;
const CYL_RADIUS     = 0.3;

// Individual progress uniform — driven by uProgress for testing.
// Later: replaced by a timer-based value in the object-dissolve phase.
const uCylinderProgress = { value: 0.0 };
const uCylinderTime     = { value: 0.0 };

// Dissolve shader injected into cylinder PBR material (same technique as room,
// but uses LOCAL position for noise so pattern stays fixed on the object as it floats)
const cylinderMat = new THREE.MeshStandardMaterial({
    color: 0x8b7355, roughness: 0.7, transparent: true,
});
cylinderMat.onBeforeCompile = (shader) => {
    shader.uniforms.uCylinderProgress = uCylinderProgress;
    shader.uniforms.uEdge             = uEdge;
    shader.uniforms.uFreq             = uFreq;
    shader.uniforms.uEdgeColor        = uEdgeColor;

    shader.vertexShader =
        'varying vec3 vLocalPos;\n' +
        shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vLocalPos = position;`
        );

    shader.fragmentShader =
        `uniform float uCylinderProgress;
         uniform float uEdge;
         uniform float uFreq;
         uniform vec3  uEdgeColor;
         varying vec3  vLocalPos;
         ${NOISE_GLSL}` +
        shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if(uCylinderProgress > 0.01){
            float threshold = mix(-1.2, 1.2, uCylinderProgress);
            float noise     = snoise3(vLocalPos * uFreq * 4.0);
            if(noise < threshold) discard;
            float edgeEnd = threshold + uEdge;
            if(noise < edgeEnd){
                float t = (noise - threshold) / uEdge;
                gl_FragColor = vec4(mix(uEdgeColor, gl_FragColor.rgb, t), mix(0.5, 1.0, t));
            }
        }`
    );
};

const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(CYL_RADIUS, CYL_RADIUS, cylinderHeight, 32),
    cylinderMat
);
const CYLINDER_FLOOR_Y = -3.5 + cylinderHeight / 2;
cylinder.position.set(0, CYLINDER_FLOOR_Y, -1);
cylinder.castShadow    = true;
cylinder.receiveShadow = true;
scene.add(cylinder);

// ─── Cylinder particles ───────────────────────────────────────────────────────
// Sampled on cylinder surface in local space — attached as child so they
// automatically follow the cylinder as it floats.
const CYL_P_COUNT = 1500;
const cylPosArr   = new Float32Array(CYL_P_COUNT * 3);
const cylVelArr   = new Float32Array(CYL_P_COUNT * 3);

for (let i = 0; i < CYL_P_COUNT; i++) {
    const i3    = i * 3;
    const theta = Math.random() * Math.PI * 2;
    const type  = Math.random();

    if (type < 0.8) {
        // side surface — drift radially outward + upward
        const y = (Math.random() - 0.5) * cylinderHeight;
        cylPosArr[i3]   = Math.cos(theta) * CYL_RADIUS;
        cylPosArr[i3+1] = y;
        cylPosArr[i3+2] = Math.sin(theta) * CYL_RADIUS;
        cylVelArr[i3]   = Math.cos(theta) * (Math.random() * 1.0 + 0.5);
        cylVelArr[i3+1] = Math.random() * 1.5 + 0.3;
        cylVelArr[i3+2] = Math.sin(theta) * (Math.random() * 1.0 + 0.5);
    } else {
        // top / bottom caps — drift upward + sideways
        const rad   = Math.random() * CYL_RADIUS;
        const isTop = type > 0.9;
        cylPosArr[i3]   = Math.cos(theta) * rad;
        cylPosArr[i3+1] = isTop ? cylinderHeight / 2 : -cylinderHeight / 2;
        cylPosArr[i3+2] = Math.sin(theta) * rad;
        cylVelArr[i3]   = (Math.random() - 0.5) * 1.0;
        cylVelArr[i3+1] = Math.random() * 2.0 + 0.5;
        cylVelArr[i3+2] = (Math.random() - 0.5) * 1.0;
    }
}

const cylParticleGeo = new THREE.BufferGeometry();
cylParticleGeo.setAttribute('position',  new THREE.BufferAttribute(cylPosArr, 3));
cylParticleGeo.setAttribute('aVelocity', new THREE.BufferAttribute(cylVelArr, 3));

const cylParticleVertShader = /* glsl */`
    attribute vec3  aVelocity;
    uniform float   uCylinderProgress;
    uniform float   uEdge;
    uniform float   uFreq;
    uniform float   uTime;
    varying float   vAlpha;
    ${NOISE_GLSL}

    void main(){
        float threshold    = mix(-1.2, 1.2, uCylinderProgress);
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

const uCylParticleColor = { value: new THREE.Color(0xffffff) }; // bright white

const cylParticleFragShader = /* glsl */`
    uniform vec3  uCylParticleColor;
    varying float vAlpha;

    void main(){
        if(vAlpha < 0.01) discard;
        vec2  uv = gl_PointCoord - .5;
        if(length(uv) > .5) discard;
        float alpha = vAlpha * (1. - length(uv) * 2.);
        gl_FragColor = vec4(uCylParticleColor, alpha);
    }
`;

const cylParticleMat = new THREE.ShaderMaterial({
    uniforms: {
        uCylinderProgress,
        uEdge, uFreq,
        uCylParticleColor,
        uTime: uCylinderTime,
    },
    vertexShader:   cylParticleVertShader,
    fragmentShader: cylParticleFragShader,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.AdditiveBlending,
});

// Attach particles as child — they follow cylinder position/rotation automatically
cylinder.add(new THREE.Points(cylParticleGeo, cylParticleMat));

// ─── Orbit Controls ──────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping    = true;
controls.dampingFactor    = 0.08;
controls.enablePan        = false;
controls.enableZoom       = false;
controls.rotateSpeed      = 1.0;
controls.target.set(0, -2.5, -1);

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
const ROOM_RETURN_DIST = 7.0;

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
        // reset phase if user scrolls back to room
        phase = 'room';
        uCylinderProgress.value = 0;
    }
    applyControlMode();
});

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

    uCylinderTime.value = t;

    // ── Phase state machine ──────────────────────────────────────────────────
    // room → (uProgress=1) → space → (5s timer) → dissolving → done
    if (phase === 'room' && p >= 1.0) {
        phase      = 'space';
        phaseStart = t;
        scrollBlocked = false;
    }

    if (phase === 'space' && t - phaseStart >= 5.0) {
        phase      = 'dissolving';
        phaseStart = t;
        scrollBlocked = true;
    }

    if (phase === 'dissolving') {
        // Cylinder dissolves over 3 seconds
        uCylinderProgress.value = Math.min(1.0, (t - phaseStart) / 3.0);
        if (uCylinderProgress.value >= 1.0) {
            phase         = 'done';
            scrollBlocked = false; // re-enable scroll to restore room
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
    // Ambient: bright warm white (room) → faint deep blue (space)
    ambientLight.color.setRGB(
        THREE.MathUtils.lerp(1.00, 0.05, p),   // R
        THREE.MathUtils.lerp(1.00, 0.08, p),   // G
        THREE.MathUtils.lerp(1.00, 0.22, p)    // B
    );
    ambientLight.intensity = THREE.MathUtils.lerp(0.7, 0.0, p);

    // Directional: warm sunlight (0xfff5e0) → pure white harsh sunlight in space
    dirLight.color.setRGB(
        THREE.MathUtils.lerp(1.00, 1.00, p),
        THREE.MathUtils.lerp(0.96, 1.00, p),
        THREE.MathUtils.lerp(0.88, 1.00, p)
    );
    dirLight.intensity = THREE.MathUtils.lerp(1.05, 3.5, p);

    // ── Cylinder floating ────────────────────────────────────────────────────
    // Rise to room centre, then drift weightlessly in a slow orbital pattern
    const rise   = p * 2.0;                                    // lifts to near centre (y ≈ -0.9)
    const bob    = Math.sin(t * 0.8) * 0.25 * p;              // slow vertical bob
    const driftX = Math.sin(t * 0.5) * 0.35 * p;              // slow left-right sway
    const driftZ = Math.cos(t * 0.4) * 0.25 * p;              // slow front-back drift
    cylinder.position.y = CYLINDER_FLOOR_Y + rise + bob;
    cylinder.position.x = driftX;
    cylinder.position.z = -1 + driftZ;
    cylinder.rotation.y += 0.003 * p;                          // slow lazy spin
    cylinder.rotation.z  = Math.sin(t * 0.45) * 0.08 * p;    // gentle tilt

    controls.update();
    renderer.render(scene, camera);
}
animate();
