import * as THREE from 'three';
import { injectSkyboxFlow, uFlowStrength } from '../render/skyboxFlow.js';

// ─── Skybox ──────────────────────────────────────────────────────────────────
// Each entry is a folder under asset/ containing 6 faces named
// bkg1_right/left/top/bot/front/back.png (same convention as skybox_blue).
// Drop a new folder in with that naming and add its name here to make it
// selectable from the debug GUI dropdown. 'None (white)' is a special case
// handled directly below — no folder/textures involved.
export const SKYBOX_NONE         = 'None (white)';
export const SKYBOX_CUSTOM_LABEL = 'Custom images…';
export const SKYBOX_OPTIONS      = ['skybox_blue', 'skybox_red', SKYBOX_NONE, SKYBOX_CUSTOM_LABEL];

// Face filenames aren't uniform across packs: skybox_blue ships bkg1_*.png while
// skybox_red ships bkg3_*.png. Rather than rename the assets, each folder
// declares its prefix here (default 'bkg1_' keeps existing folders working).
const SKYBOX_FILE_PREFIX = { skybox_blue: 'bkg1_', skybox_red: 'bkg3_' };

// Ambient/directional tint the room lighting eases toward as it enters
// 'space' (see render/lighting.js updateLighting) — keyed by the same names
// as SKYBOX_OPTIONS. Lighting should match whatever the viewer can actually
// see behind the objects: the blue nebula implies a cool blue tint, but a
// plain white void has no light source to tint anything, so it gets a
// neutral studio-white preset instead. Add an entry here whenever a new
// skybox option is added above.
export const LIGHTING_PRESETS = {
    skybox_blue: {
        // Deep space, lit BY the nebula.
        //
        // KEY: hard, pure white and strong. In vacuum there's no atmosphere to
        // scatter, tint or soften sunlight, so it arrives at full energy and
        // uncoloured. Its DIRECTION is matched to the skybox texture — sampling
        // the six faces puts the nebula's brightest region at azimuth ≈ −50°,
        // elevation ≈ 55°, which is where render/lighting.js aims it and where
        // the visible sun sits.
        //
        // FILL: ambient used to be 0.0 here, which is why every surface facing
        // away from the key light went pure black — there was no fill in space at
        // all. At 0.7 against the 5.4 key the contrast is ~7.7:1: lit sides read
        // as sunstruck while shadowed sides keep their shape.
        //
        // ambientColor is only a FALLBACK. buildSkybox() measures the average
        // colour of the loaded cube map and overrides it (see selectBackground in
        // main.js), so the fill always matches the background actually on screen
        // — including user-supplied custom ones.
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    skybox_red: {
        // Same deep-space treatment as skybox_blue — hard white key light, dim
        // fill. The fill COLOUR isn't specified by hand: buildSkybox() samples
        // the red nebula's own average and overrides ambientColor, so shadowed
        // sides pick up that warm red rather than this fallback blue.
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    [SKYBOX_NONE]: {
        // Plain white void: ambient light has no direction, so pushing it well
        // above the directional light (instead of just "bright-ish") is what
        // actually removes dark/shadowed sides from objects — a directional
        // light alone always leaves its non-facing side dim regardless of
        // ambient's absolute brightness, since only ambient reaches every
        // surface orientation equally.
        ambientColor:         [1.00, 1.00, 1.00],
        ambientIntensity:     3.2,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 1.2,
    },
};

export const SKYBOX_FACES = ['right', 'left', 'top', 'bottom', 'front', 'back'];

// How bright the background renders, as a multiplier on its own texture.
// 1.0 = the raw image. Lower it to push the sky behind the still life.
const SKYBOX_BRIGHTNESS = 0.45;

export function buildSkybox(scene) {
    const textureLoader = new THREE.TextureLoader();

    // Loads one cube face and makes it robust to arbitrary user images:
    //  • ClampToEdge + no mipmaps → no bright/wrong-colour seam lines where two
    //    faces meet (the "edges" a custom cubemap showed with RepeatWrapping).
    //  • center-crop to a SQUARE via the UV transform → a non-square photo is
    //    cropped, not stretched, onto the square face (the "stretched textures").
    // Square, equal-size faces still look best, but this keeps odd sizes usable.
    function loadFaceTexture(url, revokeAfter = false, onReady = null) {
        const tex = textureLoader.load(url, (t) => {
            const w = t.image.width, h = t.image.height;
            if (w > h)      { t.repeat.set(h / w, 1); t.offset.set((1 - h / w) / 2, 0); }
            else if (h > w) { t.repeat.set(1, w / h); t.offset.set(0, (1 - w / h) / 2); }
            t.needsUpdate = true;
            if (revokeAfter) URL.revokeObjectURL(url);
            onReady?.(t.image);
        }, undefined, () => onReady?.(null)); // count failures too, so we never hang
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        return tex;
    }
    // ── Ambient colour sampled FROM the background ──────────────────────────
    // Averages the whole cube map into one colour: the mean light arriving from
    // the environment. This is a cheap stand-in for image-based lighting — for a
    // matte surface the correct ambient term really is the average of the
    // surrounding radiance, so this is principled rather than a trick, and it
    // means ANY background (including a user's custom cube map) automatically
    // gets a matching fill light instead of needing a hand-written preset.
    //
    // Every pixel is averaged, not a random subset: drawing each face into a
    // 32×32 canvas makes the GPU box-filter it, so those 6×1024 pixels already
    // ARE the average of the full 2048² images. It costs a few ms once per
    // skybox change, so there's no reason to sample randomly.
    //
    // IMPORTANT: only the HUE is taken, not the brightness. A starfield averages
    // to nearly black (measured mean luminance ≈ 9/255), so feeding the raw mean
    // in as a colour would light nothing at all. Scaling the brightest channel to
    // 1 keeps the colour cast and leaves overall strength to ambientIntensity —
    // which is what the GUI's "Ambient ×" slider then scales.
    function averageFaceColor(images) {
        const S = 32;
        const c = document.createElement('canvas');
        c.width = c.height = S;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        let R = 0, G = 0, B = 0, n = 0;
        for (const img of images) {
            if (!img) continue;
            ctx.clearRect(0, 0, S, S);
            ctx.drawImage(img, 0, 0, S, S);
            const d = ctx.getImageData(0, 0, S, S).data;
            for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
        }
        if (!n) return null;
        R /= n; G /= n; B /= n;
        const max = Math.max(R, G, B);
        if (max < 1) return [1, 1, 1]; // essentially black sky → neutral fill
        return [R / max, G / max, B / max];
    }

    // Wires the 6 per-face load callbacks up to one "all faces in" notification.
    function collectFaces(onAverage) {
        const images = new Array(6).fill(null);
        let remaining = 6;
        return (i) => (img) => {
            images[i] = img;
            if (--remaining === 0) {
                const avg = averageFaceColor(images);
                if (avg) onAverage?.(avg);
            }
        };
    }

    const skybox = new THREE.Mesh(
        new THREE.BoxGeometry(1000, 1000, 1000),
        SKYBOX_FACES.map((face) => {
            // color acts as a multiplier over the cube-map texture, so a value
            // below white dims the whole background. The raw nebula images read
            // far too bright behind a dim, candle-lit still life and flattened
            // the contrast between the scene and its backdrop; SKYBOX_BRIGHTNESS
            // pushes the sky back so the objects stay the brightest thing on
            // screen. (The ambient light sampled from the sky is unaffected —
            // that normalises hue separately, see averageFaceColor.)
            const mat = new THREE.MeshBasicMaterial({
                side: THREE.BackSide,                      // maps set by loadSkybox()
                color: new THREE.Color().setScalar(SKYBOX_BRIGHTNESS),
            });
            injectSkyboxFlow(mat, 'skybox_flow_' + face);
            return mat;
        })
    );
    scene.add(skybox);

    // Swaps all 6 face textures live, or switches to a flat white background.
    // Disposes previous textures so switching repeatedly in the GUI doesn't
    // leak GPU memory.
    function loadSkybox(folderName, onAverageColor) {
        if (folderName === SKYBOX_NONE) {
            skybox.visible   = false;
            scene.background = new THREE.Color(0xffffff);
            onAverageColor?.([1, 1, 1]); // plain white void → white fill
            return;
        }
        scene.background = null; // let the skybox mesh show through again
        skybox.visible    = true;
        const face$ = collectFaces(onAverageColor);
        skybox.material.forEach((mat, i) => {
            const face = SKYBOX_FACES[i];
            const oldMap = mat.map;
            const prefix = SKYBOX_FILE_PREFIX[folderName] ?? 'bkg1_';
            mat.map = loadFaceTexture(`asset/${folderName}/${prefix}${face}.png`, false, face$(i));
            mat.needsUpdate = true;
            if (oldMap) oldMap.dispose();
        });
    }

    // Accepted filename tokens per cube face — covers the common skybox naming
    // conventions (right/left/top/bot/front/back, compass, posx/negx, px/nx).
    // Matched as whole tokens (filename split on non-alphanumeric), NOT
    // substrings, so e.g. "cube_bot" can't also match "back" via a stray "_b".
    const FACE_ALIASES = {
        right:  ['right', 'east',  'posx', 'px'],
        left:   ['left',  'west',  'negx', 'nx'],
        top:    ['top',   'up',    'posy', 'py'],
        bottom: ['bot',   'bottom','down', 'negy', 'ny'],
        front:  ['front', 'north', 'posz', 'pz'],
        back:   ['back',  'south', 'negz', 'nz'],
    };
    function faceKeyForName(name) {
        const tokens = name.toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/);
        for (const face of SKYBOX_FACES) {
            if (tokens.some(tok => FACE_ALIASES[face].includes(tok))) return face;
        }
        return null;
    }

    // Matches a set of user-picked files to the 6 cube faces by filename token
    // (e.g. "myscene_right.png" -> right, "posx.png" -> right). Returns null if
    // any of the 6 faces isn't covered — the caller tells the user what to fix.
    function matchFaceFiles(files) {
        const matched = {};
        for (const f of Array.from(files)) {
            const face = faceKeyForName(f.name);
            if (face && !matched[face]) matched[face] = f;
        }
        for (const face of SKYBOX_FACES) if (!matched[face]) return null;
        return matched;
    }

    // Loads a user-supplied cube map from 6 local image files. Returns true
    // on success, false if the files couldn't be matched to the 6 faces —
    // in that case the background is left unchanged.
    function loadCustomSkybox(files, onAverageColor) {
        const matched = matchFaceFiles(files);
        if (!matched) return false;

        scene.background = null;
        skybox.visible   = true;
        const face$ = collectFaces(onAverageColor);
        skybox.material.forEach((mat, i) => {
            const face = SKYBOX_FACES[i];
            const url  = URL.createObjectURL(matched[face]);
            const oldMap = mat.map;
            mat.map = loadFaceTexture(url, true, face$(i));
            mat.needsUpdate = true;
            if (oldMap) oldMap.dispose();
        });
        return true;
    }

    return { loadSkybox, loadCustomSkybox };
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
    // Stars used to be scattered through a ±100 CUBE centred on the origin, which
    // put a share of them inside the room — visible as bright specks floating in
    // front of the walls and through the table. Spawning them on a spherical
    // SHELL instead (well outside the 14 × 7 × 14 room) keeps the field looking
    // the same from the centre while guaranteeing none can be indoors.
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

    // Star field turns together with the skybox warp — same toggle, same
    // eased uFlowStrength — so both read as one swirling motion instead of
    // a moving background behind motionless points.
    function updateStars(dt) {
        starPoints.rotation.y += STAR_ROTATE_SPEED * uFlowStrength.value * dt;
    }

    return { updateStars };
}
