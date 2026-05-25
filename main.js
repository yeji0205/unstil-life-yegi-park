import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ─── Renderer ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
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
        new THREE.MeshBasicMaterial({
            map: texLoader.load(`asset/skybox_blue/bkg1_${face}.png`),
            side: THREE.BackSide,
        })
    )
);
scene.add(skybox);

// ─── Stars ───────────────────────────────────────────────────────────────────
function makeStarTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0,'rgba(255,255,255,1)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0,0,64,64);
    return new THREE.CanvasTexture(c);
}

const STAR_COUNT = 1500;
const starPos = new Float32Array(STAR_COUNT * 3);
const starCol = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT * 3; i++) starPos[i] = (Math.random() - 0.5) * 200;
for (let i = 0; i < STAR_COUNT * 3; i += 3) { starCol[i] = 1; starCol[i+1] = 0.9; starCol[i+2] = 0.8; }
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
starGeo.setAttribute('color',    new THREE.BufferAttribute(starCol, 3));
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
        shader.uniforms.uProgress  = uProgress;
        shader.uniforms.uEdge      = uEdge;
        shader.uniforms.uFreq      = uFreq;
        shader.uniforms.uEdgeColor = uEdgeColor;

        // Pass world position from vertex shader
        shader.vertexShader =
            'varying vec3 vWorldPos;\n' +
            shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
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

// ─── Dissolve Particles ──────────────────────────────────────────────────────
// Particles sit on the 6 inner faces of the room box.
// Only those near the dissolve edge become visible and drift inward + upward.

const PARTICLE_COUNT = 5000;
const pPositions  = new Float32Array(PARTICLE_COUNT * 3); // current (init)
const pVelocities = new Float32Array(PARTICLE_COUNT * 3); // drift direction

const BOX = { x: 6.9, y: 3.4, z: 6.9 }; // slightly inset so particles are visible

for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3   = i * 3;
    const face = Math.floor(Math.random() * 6);
    let px, py, pz, vx, vy, vz;

    const ru = () => Math.random();
    const rs = () => (Math.random() - 0.5);

    switch (face) {
        case 0: // right wall  x = +BOX.x
            px =  BOX.x; py = rs() * BOX.y * 2; pz = rs() * BOX.z * 2;
            vx = -ru() * 1.5; vy = ru() * 1.5 + 0.5; vz = rs() * 0.5;
            break;
        case 1: // left wall   x = -BOX.x
            px = -BOX.x; py = rs() * BOX.y * 2; pz = rs() * BOX.z * 2;
            vx =  ru() * 1.5; vy = ru() * 1.5 + 0.5; vz = rs() * 0.5;
            break;
        case 2: // ceiling      y = +BOX.y
            px = rs() * BOX.x * 2; py =  BOX.y; pz = rs() * BOX.z * 2;
            vx = rs() * 0.5; vy = ru() * 0.5 + 0.3; vz = rs() * 0.5;
            break;
        case 3: // floor        y = -BOX.y
            px = rs() * BOX.x * 2; py = -BOX.y; pz = rs() * BOX.z * 2;
            vx = rs() * 0.5; vy = ru() * 2.0 + 1.0; vz = rs() * 0.5;
            break;
        case 4: // front wall   z = +BOX.z
            px = rs() * BOX.x * 2; py = rs() * BOX.y * 2; pz =  BOX.z;
            vx = rs() * 0.5; vy = ru() * 1.5 + 0.5; vz = -ru() * 1.5;
            break;
        default: // back wall   z = -BOX.z
            px = rs() * BOX.x * 2; py = rs() * BOX.y * 2; pz = -BOX.z;
            vx = rs() * 0.5; vy = ru() * 1.5 + 0.5; vz =  ru() * 1.5;
    }

    pPositions[i3]   = px; pPositions[i3+1]   = py; pPositions[i3+2]   = pz;
    pVelocities[i3]  = vx; pVelocities[i3+1]  = vy; pVelocities[i3+2]  = vz;
}

const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute('position',   new THREE.BufferAttribute(pPositions,  3));
particleGeo.setAttribute('aVelocity',  new THREE.BufferAttribute(pVelocities, 3));

// Shared uniform references for particles
const uParticleProgress  = uProgress;   // same reference as room — stay in sync
const uParticleTime      = { value: 0.0 };

const particleVertexShader = /* glsl */`
    attribute vec3 aVelocity;

    uniform float uProgress;
    uniform float uEdge;
    uniform float uFreq;
    uniform float uTime;

    varying float vAlpha;
    varying float vEdgeFactor;

    ${NOISE_GLSL}

    void main(){
        float threshold = mix(-1.2, 1.2, uProgress);
        float noise     = snoise3(position * uFreq);

        float distFromEdge = noise - threshold; // >0 = not yet dissolved
        float driftBand    = uEdge * 1.5;       // how far past the edge particles travel

        // Only show particles in [−driftBand, uEdge] range around threshold
        if(distFromEdge > uEdge || distFromEdge < -driftBand){
            gl_Position  = vec4(9999., 9999., 9999., 1.); // clip off screen
            gl_PointSize = 0.;
            vAlpha       = 0.;
            return;
        }

        // t: 0 = particle just at the dissolve edge, 1 = fully drifted away
        float t = clamp(-distFromEdge / driftBand, 0., 1.);

        vec3 pos = position + aVelocity * t;

        // Subtle wave wiggle (Codrops sine-wave motion)
        pos.x += sin(position.y * 2.0 + uTime * 2.0) * 0.08 * t;
        pos.z += cos(position.x * 2.5 + uTime * 1.7) * 0.08 * t;

        vAlpha      = 1. - t;
        vEdgeFactor = clamp(distFromEdge / uEdge, 0., 1.); // 0=at edge,1=intact

        vec4 mvPos   = modelViewMatrix * vec4(pos, 1.);
        gl_PointSize = max(2., 80. / -mvPos.z);
        gl_Position  = projectionMatrix * mvPos;
    }
`;

const particleFragmentShader = /* glsl */`
    uniform vec3 uEdgeColor;

    varying float vAlpha;
    varying float vEdgeFactor;

    void main(){
        if(vAlpha < 0.01) discard;

        // Circular soft point
        vec2  uv = gl_PointCoord - .5;
        float d  = length(uv);
        if(d > .5) discard;

        float alpha = vAlpha * (1. - d * 2.);
        gl_FragColor = vec4(uEdgeColor, alpha);
    }
`;

const particleMat = new THREE.ShaderMaterial({
    uniforms: {
        uProgress:  uParticleProgress,
        uEdge,
        uFreq,
        uEdgeColor,
        uTime:      uParticleTime,
    },
    vertexShader:   particleVertexShader,
    fragmentShader: particleFragmentShader,
    transparent:    true,
    depthWrite:     false,
    blending:       THREE.AdditiveBlending,
});

scene.add(new THREE.Points(particleGeo, particleMat));

// ─── Lighting ────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 1.5));

const dirLight = new THREE.DirectionalLight(0xfff5e0, 2.0);
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

// ─── Cylinder (placeholder object on floor) ──────────────────────────────────
const cylinderHeight = 1.2;
const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, cylinderHeight, 32),
    new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.7 })
);
// Floor is at y = -3.5; sit cylinder on it
const CYLINDER_FLOOR_Y = -3.5 + cylinderHeight / 2; // resting position
cylinder.position.set(0, CYLINDER_FLOOR_Y, -1);
cylinder.castShadow    = true;
cylinder.receiveShadow = true;
scene.add(cylinder);

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

function applyControlMode() {
    const inSpace = uProgress.value >= 0.95;
    controls.minAzimuthAngle = inSpace ? -Infinity         : ROOM_LIMITS.minAzimuth;
    controls.maxAzimuthAngle = inSpace ?  Infinity         : ROOM_LIMITS.maxAzimuth;
    controls.minPolarAngle   = inSpace ?  0                : ROOM_LIMITS.minPolar;
    controls.maxPolarAngle   = inSpace ?  Math.PI          : ROOM_LIMITS.maxPolar;
}
applyControlMode();

// ─── Scroll ──────────────────────────────────────────────────────────────────
window.addEventListener('wheel', (e) => {
    uProgress.value = Math.min(1.0, Math.max(0.0, uProgress.value + e.deltaY * 0.001));
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
    const t    = clock.getElapsedTime();
    const p    = uProgress.value;           // 0 = full room, 1 = full space
    uParticleTime.value = t;

    // ── Cylinder floating ────────────────────────────────────────────────────
    // Rise from floor toward room centre as room dissolves
    const rise   = p * 3.5;                            // lifts 3.5 units at full progress
    const bob    = Math.sin(t * 1.2) * 0.12 * p;      // gentle bobbing, only when floating
    const drift  = Math.sin(t * 0.6) * 0.08 * p;      // subtle horizontal sway
    cylinder.position.y = CYLINDER_FLOOR_Y + rise + bob;
    cylinder.position.x = drift;
    cylinder.rotation.y += 0.004 * p;                  // slow spin, only when floating
    cylinder.rotation.z  = Math.sin(t * 0.5) * 0.06 * p; // slight tilt

    controls.update();
    renderer.render(scene, camera);
}
animate();
