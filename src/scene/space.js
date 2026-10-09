import * as THREE from 'three';
import { injectSkyboxFlow } from '../effects/skyboxFlow.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { matchFaceFiles, inspectFaces, isTga } from './skyboxUpload.js';

// The space background: skybox (built-in, custom upload or flat colour) and the
// fill light colour sampled from it. The star field is in stars.js.

// ─── Skybox ──────────────────────────────────────────────────────────────────
// Each option is a folder under asset/skybox/ with six files named as in
// SKYBOX_FACES. To add one: drop the folder in, rename its faces, add the folder
// name to SKYBOX_OPTIONS and an entry to LIGHTING_PRESETS.
export const SKYBOX_NONE         = 'None (solid color)';

// The flat background colour for SKYBOX_NONE (GUI colour picker).
export const voidColor = { hex: '#ffffff' };

export const SKYBOX_OPTIONS      = ['space_blue', 'space_red', 'sky', SKYBOX_NONE];

// Deep space: a hard, pure white key light (no atmosphere to tint it), pointed
// out of the nebula's brightest patch, plus a dim fill so the shadow sides keep
// their shape. ambientColor is only a fallback: buildSkybox() measures the
// skybox's average colour and uses that instead (see selectBackground in main.js).
const STARRY_SKY_LIGHTING = {
    ambientColor:         [0.34, 0.45, 0.72],
    ambientIntensity:     0.7,
    directionalColor:     [1.00, 1.00, 1.00],
    directionalIntensity: 5.4,
};

// Light colours and intensities the scene eases to in space, per skybox (keys
// match SKYBOX_OPTIONS; see scene/lighting.js). Add one for every new skybox.
export const LIGHTING_PRESETS = {
    space_blue: STARRY_SKY_LIGHTING,
    space_red:  STARRY_SKY_LIGHTING,
    // Hipshot's "Interstellar" starfield (keep asset/skybox/sky/README.TXT, the
    // author's attribution, with the images).
    sky:        STARRY_SKY_LIGHTING,
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

const SKYBOX_FACES = ['right', 'left', 'top', 'bottom', 'front', 'back'];

// Background brightness multiplier. 1.0 = the raw image. Lower it to push the
// sky behind the still life.
const SKYBOX_BRIGHTNESS = 0.45;

const textureLoader = new THREE.TextureLoader();
// Browsers can't display TGA, so those faces are decoded by three.js instead.
const tgaLoader = new TGALoader();

// ClampToEdge and no mipmaps prevent seam lines at the edges of the faces.
function applyFaceSettings(tex) {
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
}

// Loads one face. Non-square images are stretched, not cropped: cropping cuts
// off the borders that adjacent faces need to line up. onReady gets the image,
// or null if it couldn't be loaded.
function loadFaceTexture(url, { revokeAfter = false, tga = false, onReady = null } = {}) {
    const loader = tga ? tgaLoader : textureLoader;
    const tex = loader.load(url, (t) => {
        // The TGA loader sets its own filtering once loaded, so ours goes on again.
        applyFaceSettings(t);
        t.needsUpdate = true;
        if (revokeAfter) URL.revokeObjectURL(url);
        onReady?.(t.image);
    }, undefined, () => {
        if (revokeAfter) URL.revokeObjectURL(url);
        onReady?.(null); // count failures too, so we never hang
    });
    applyFaceSettings(tex);
    return tex;
}

// Something a 2D canvas can draw: the image itself, or for a TGA face (raw
// pixel data) a canvas holding those pixels.
function drawableImage(img) {
    if (!img.data) return img;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const pixels = new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length),
        img.width, img.height);
    c.getContext('2d').putImageData(pixels, 0, 0);
    return c;
}

// ── Ambient colour sampled from the background ──────────────────────────────
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
        ctx.drawImage(drawableImage(img), 0, 0, S, S);
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
            if (onReport) onReport(inspectFaces(images, SKYBOX_FACES));
        }
    };
}

export function buildSkybox(scene) {
    const skybox = new THREE.Mesh(
        new THREE.BoxGeometry(1000, 1000, 1000),
        SKYBOX_FACES.map((face) => {
            // The colour dims the texture (SKYBOX_BRIGHTNESS), so the objects stay
            // the brightest thing on screen.
            const mat = new THREE.MeshBasicMaterial({
                side: THREE.BackSide,                      // maps set by showFaces()
                color: new THREE.Color().setScalar(SKYBOX_BRIGHTNESS),
            });
            injectSkyboxFlow(mat, 'skybox_flow_' + face);
            return mat;
        })
    );
    scene.add(skybox);

    // Shows the skybox with a new image on each face (sourceForFace gives each
    // { url, tga }) and disposes the old ones, so switching repeatedly in the GUI
    // doesn't leak GPU memory. revokeAfter: the URLs are uploads, freed once loaded.
    function showFaces(sourceForFace, revokeAfter, onAverageColor, onReport = null) {
        scene.background = null; // let the skybox mesh show through again
        skybox.visible   = true;
        const face$ = collectFaces(onAverageColor, onReport);
        skybox.material.forEach((mat, i) => {
            const oldMap = mat.map;
            const { url, tga } = sourceForFace(SKYBOX_FACES[i]);
            mat.map = loadFaceTexture(url, { revokeAfter, tga, onReady: face$(i) });
            mat.needsUpdate = true;
            if (oldMap) oldMap.dispose();
        });
    }

    // Swaps all 6 face textures live, or switches to a flat colour background.
    function loadSkybox(folderName, onAverageColor) {
        if (folderName === SKYBOX_NONE) {
            skybox.visible   = false;
            const c = new THREE.Color(voidColor.hex);
            scene.background = c;
            onAverageColor?.(normalizeHue(c.r, c.g, c.b));
            return;
        }
        showFaces((face) => ({ url: `asset/skybox/${folderName}/${face}.png`, tga: false }), false, onAverageColor);
    }

    // Loads a user-supplied cube map from 6 local image files. Returns true on
    // success, or { missing, unsupported } (the faces it couldn't find, and files
    // in formats the browser can't open) — in that case the background is left
    // unchanged and the caller can say exactly what's wrong.
    function loadCustomSkybox(files, onAverageColor, onReport = null) {
        const { matched, missing, unsupported } = matchFaceFiles(files, SKYBOX_FACES);
        if (missing.length) return { missing, unsupported };
        const source = (face) => ({ url: URL.createObjectURL(matched[face]), tga: isTga(matched[face]) });
        showFaces(source, true, onAverageColor, onReport);
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
