import * as THREE from 'three';
import { injectSkyboxFlow, uFlowStrength } from '../effects/skyboxFlow.js';

// The space background: skybox (built-in, custom upload or flat colour), the fill
// light colour sampled from it, and the star field.

// ─── Skybox ──────────────────────────────────────────────────────────────────
// Each option is a folder under asset/skybox/ with six files named as in
// SKYBOX_FACES. To add one: drop the folder in, rename its faces, add the folder
// name to SKYBOX_OPTIONS and an entry to LIGHTING_PRESETS.
// SKYBOX_NONE is a flat colour, with no folder.
export const SKYBOX_NONE         = 'None (solid color)';

// The flat background colour for SKYBOX_NONE (GUI colour picker).
export const voidColor = { hex: '#ffffff' };

export const SKYBOX_CUSTOM_LABEL = 'Add custom skybox…';
export const SKYBOX_OPTIONS      = ['space_blue', 'space_red', 'sky', SKYBOX_NONE, SKYBOX_CUSTOM_LABEL];

// Light colours and intensities the scene eases to in space, per skybox (keys
// match SKYBOX_OPTIONS; see scene/lighting.js). Add one for every new skybox.
export const LIGHTING_PRESETS = {
    space_blue: {
        // Deep space: a hard, pure white key light (no atmosphere to tint it),
        // pointed out of the nebula's brightest patch, plus a dim fill so the
        // shadow sides keep their shape.
        //
        // ambientColor is only a fallback: buildSkybox() measures the skybox's
        // average colour and uses that instead (see selectBackground in main.js).
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    space_red: {
        // Same as space_blue; the fill colour is measured from the red nebula.
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    sky: {
        // Hipshot's "Interstellar" starfield (keep asset/skybox/sky/README.TXT,
        // the author's attribution, with the images). Same as the nebulae.
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    [SKYBOX_NONE]: {
        // Flat colour: no ambient, because the environment map already lights the
        // objects evenly with the background's colour (a dark colour gives dark
        // objects). With an ambient as well, light objects were lit twice and
        // washed out. Weak key light, so objects have no dark sides.
        ambientColor:         [1.00, 1.00, 1.00],
        ambientIntensity:     0,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 1.2,
    },
};

export const SKYBOX_FACES = ['right', 'left', 'top', 'bottom', 'front', 'back'];

// Background brightness multiplier. 1.0 = the raw image. Lower it to push the
// sky behind the still life.
const SKYBOX_BRIGHTNESS = 0.45;

export function buildSkybox(scene) {
    const textureLoader = new THREE.TextureLoader();

    // Loads one face. ClampToEdge and no mipmaps prevent seam lines at the edges.
    // Non-square images are stretched, not cropped: cropping cuts off the borders
    // that adjacent faces need to line up.
    function loadFaceTexture(url, revokeAfter = false, onReady = null) {
        const tex = textureLoader.load(url, (t) => {
            t.needsUpdate = true;
            if (revokeAfter) URL.revokeObjectURL(url);
            onReady?.(t.image);
        }, undefined, () => onReady?.(null)); // count failures too, so we never hang
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        return tex;
    }
    // ── Ambient colour sampled from the background ──────────────────────────
    // The average colour of the whole cube map, a cheap stand-in for image-based
    // lighting, so any background (including uploads) gets a matching fill.
    // Drawing each face into a 32×32 canvas makes the GPU average it.
    // Only the hue is used: a starfield averages to nearly black and would light
    // nothing. The strength comes from the preset's ambientIntensity.
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
        // Canvas values are 0–255; normalizeHue works in 0–1.
        return normalizeHue(R / (255 * n), G / (255 * n), B / (255 * n));
    }

    // Keeps a colour's hue and drops its brightness (brightest channel → 1).
    // Used for both the cube-map average and the flat void colour.
    function normalizeHue(r, g, b) {
        const max = Math.max(r, g, b);
        if (max < 1 / 255) return [1, 1, 1]; // essentially black → neutral fill
        return [r / max, g / max, b / max];
    }

    // Wires the 6 per-face load callbacks up to one "all faces in" notification.
    function collectFaces(onAverage, onReport = null) {
        const images = new Array(6).fill(null);
        let remaining = 6;
        return (i) => (img) => {
            images[i] = img;
            if (--remaining === 0) {
                const avg = averageFaceColor(images);
                if (avg) onAverage?.(avg);
                if (onReport) onReport(inspectFaces(images));
            }
        };
    }

    // Explains seams in an uploaded skybox: non-square faces get stretched, and
    // faces of different sizes meet at different sharpness. It can't detect the
    // most common cause, faces rotated the wrong way, which has to be seen.
    function inspectFaces(images) {
        const notes = [];
        const dims = images.map((img, i) => img
            ? { face: SKYBOX_FACES[i], w: img.width, h: img.height }
            : { face: SKYBOX_FACES[i], w: 0, h: 0 });

        const nonSquare = dims.filter(d => d.w && d.h && d.w !== d.h);
        if (nonSquare.length) {
            notes.push(`${nonSquare.length} of 6 images are not square (`
                + nonSquare.map(d => `${d.face} ${d.w}×${d.h}`).join(', ')
                + '). They are stretched to fit, so straight lines in the sky will bend.');
        }

        const sizes = [...new Set(dims.filter(d => d.w).map(d => `${d.w}×${d.h}`))];
        if (sizes.length > 1) {
            notes.push(`The faces are different sizes (${sizes.join(', ')}). `
                + 'Neighbouring faces will meet at different sharpness, which reads as a line.');
        }

        return { notes, sizes };
    }

    const skybox = new THREE.Mesh(
        new THREE.BoxGeometry(1000, 1000, 1000),
        SKYBOX_FACES.map((face) => {
            // The colour dims the texture (SKYBOX_BRIGHTNESS), so the objects stay
            // the brightest thing on screen.
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
            const c = new THREE.Color(voidColor.hex);
            scene.background = c;
            onAverageColor?.(normalizeHue(c.r, c.g, c.b));
            return;
        }
        scene.background = null; // let the skybox mesh show through again
        skybox.visible    = true;
        const face$ = collectFaces(onAverageColor);
        skybox.material.forEach((mat, i) => {
            const face = SKYBOX_FACES[i];
            const oldMap = mat.map;
            mat.map = loadFaceTexture(`asset/skybox/${folderName}/${face}.png`, false, face$(i));
            mat.needsUpdate = true;
            if (oldMap) oldMap.dispose();
        });
    }

    // Filename words accepted for each face of an uploaded skybox, since every
    // pack names them differently: words, rt/lf/up/dn/ft/bk, posx/negx-style axis
    // names, compass directions. Bare numbers are left out on purpose: they can't
    // be told apart from sizes or versions, and a wrong guess scrambles the sky.
    const FACE_ALIASES = {
        right:  ['right',  'rt', 'east',  'posx', 'xpos', 'px', 'xp'],
        left:   ['left',   'lf', 'west',  'negx', 'xneg', 'nx', 'xn'],
        top:    ['top',    'up', 'zenith', 'posy', 'ypos', 'py', 'yp'],
        bottom: ['bottom', 'bot', 'dn', 'down', 'nadir', 'negy', 'yneg', 'ny', 'yn'],
        front:  ['front',  'ft', 'north', 'posz', 'zpos', 'pz', 'zp'],
        back:   ['back',   'bk', 'south', 'negz', 'zneg', 'nz', 'zn'],
    };

    // Strict match: whole words of the filename, split on non-alphanumerics, so
    // "cube_bot" can't match 'back' by accident.
    function faceByToken(name) {
        const tokens = name.toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/);
        for (const face of SKYBOX_FACES) {
            if (tokens.some(tok => FACE_ALIASES[face].includes(tok))) return face;
        }
        return null;
    }

    // Loose match for names without separators ("skyboxRT.png"): the face word at
    // the end or the start. Can misfire ("group" ends in "up"), so it only fills
    // faces the strict match left empty.
    function faceByEdge(name, mode) {
        const base = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
        for (const face of SKYBOX_FACES) {
            // Longest alias first, so 'xneg' wins over 'xn'.
            const aliases = [...FACE_ALIASES[face]].sort((a, b) => b.length - a.length);
            if (aliases.some(a => (mode === 'suffix' ? base.endsWith(a) : base.startsWith(a)))) return face;
        }
        return null;
    }

    // Matches uploaded files to the 6 faces in three passes, strictest first, so a
    // properly named file always wins over a stray file in the folder.
    // Returns { matched, missing }, so the caller can name the missing faces.
    function matchFaceFiles(files) {
        const list = Array.from(files);
        const matched = {};
        const claimed = new Set();
        const claim = (face, file) => {
            if (!face || matched[face]) return;
            matched[face] = file;
            claimed.add(file);
        };

        for (const f of list) claim(faceByToken(f.name), f);
        for (const f of list) if (!claimed.has(f)) claim(faceByEdge(f.name, 'suffix'), f);
        for (const f of list) if (!claimed.has(f)) claim(faceByEdge(f.name, 'prefix'), f);

        return { matched, missing: SKYBOX_FACES.filter(face => !matched[face]) };
    }

    // Loads a user-supplied cube map from 6 local image files. Returns true on
    // success, or the list of face names it couldn't find — in that case the
    // background is left unchanged and the caller can say exactly what's missing.
    function loadCustomSkybox(files, onAverageColor, onReport = null) {
        const { matched, missing } = matchFaceFiles(files);
        if (missing.length) return missing;

        scene.background = null;
        skybox.visible   = true;
        const face$ = collectFaces(onAverageColor, onReport);
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

    // Changes the flat background colour live (only shown when the skybox is
    // hidden), and reports the new hue.
    function setVoidColor(hex, onAmbientColor) {
        voidColor.hex = hex;
        const c = new THREE.Color(hex);
        if (!skybox.visible) scene.background = c;
        onAmbientColor?.(normalizeHue(c.r, c.g, c.b));
    }

    // `skybox` is also returned so main.js can render it into the environment map.
    return { loadSkybox, loadCustomSkybox, setVoidColor, skybox };
}

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
    ctx.fillRect(0, 0, 64, 64); // drawing from top-left corner (0,0) to bottom-right corner (64,64) using whatever fillStyle is currently loaded.
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
