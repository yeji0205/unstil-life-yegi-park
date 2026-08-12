import * as THREE from 'three';
import { injectSkyboxFlow, uFlowStrength } from '../render/skyboxFlow.js';

// ─── Skybox ──────────────────────────────────────────────────────────────────
// Each entry is a folder under asset/skybox/ holding exactly six files:
// right / left / top / bottom / front / back .png — the same six words
// SKYBOX_FACES lists, and the same ones the custom-upload matcher accepts.
//
// Adding a background is therefore: drop the folder in, rename its faces to
// those words, add the folder name here and a LIGHTING_PRESETS entry below.
// Nothing else in the code needs to know about it.
//
// Packs in the wild use every naming scheme going (bkg1_*, xpos/xneg, rt/lf/up),
// so the renaming step is unavoidable somewhere. It used to live in code as a
// per-folder prefix table, which meant a pack whose names differed in any way
// OTHER than a prefix — like the axis-named interstellar set — simply could not
// be added without new code. Normalising on disk instead costs one rename per
// file, once, and removes the table entirely.
//
// SKYBOX_NONE is a special case handled directly below — no folder or textures
// involved, just a flat colour.
export const SKYBOX_NONE         = 'None (solid color)';

// The flat background colour used when SKYBOX_NONE is selected. White to begin
// with — that's the plain gallery void the piece was designed against — but it's
// live, so the GUI can offer a swatch beside the dropdown. Kept out here rather
// than inside buildSkybox so the GUI can read the current value when it builds
// its colour picker, without needing the skybox to hand it over.
export const voidColor = { hex: '#ffffff' };

export const SKYBOX_CUSTOM_LABEL = 'Add custom skybox…';
export const SKYBOX_OPTIONS      = ['space_blue', 'space_red', 'sky', SKYBOX_NONE, SKYBOX_CUSTOM_LABEL];

// Ambient/directional tint the room lighting eases toward as it enters
// 'space' (see render/lighting.js updateLighting) — keyed by the same names
// as SKYBOX_OPTIONS. Lighting should match whatever the viewer can actually
// see behind the objects: the blue nebula implies a cool blue tint, while a
// flat void is lit by whatever colour it's set to (white by default). Add an
// entry here whenever a new skybox option is added above.
export const LIGHTING_PRESETS = {
    space_blue: {
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
    space_red: {
        // Same deep-space treatment as space_blue — hard white key light, dim
        // fill. The fill COLOUR isn't specified by hand: buildSkybox() samples
        // the red nebula's own average and overrides ambientColor, so shadowed
        // sides pick up that warm red rather than this fallback blue.
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    sky: {
        // Hipshot's "Interstellar" starfield (asset/skybox/sky/README.TXT
        // carries the author's attribution — keep it with the images). Same
        // deep-space treatment as the two nebulae: a hard white key with a low
        // fill, and the fill's COLOUR measured from the images themselves rather
        // than guessed here, so it tracks whatever that sky actually looks like.
        ambientColor:         [0.34, 0.45, 0.72],
        ambientIntensity:     0.7,
        directionalColor:     [1.00, 1.00, 1.00],
        directionalIntensity: 5.4,
    },
    [SKYBOX_NONE]: {
        // Plain coloured void: ambient light has no direction, so pushing it well
        // above the directional light (instead of just "bright-ish") is what
        // actually removes dark/shadowed sides from objects — a directional
        // light alone always leaves its non-facing side dim regardless of
        // ambient's absolute brightness, since only ambient reaches every
        // surface orientation equally.
        //
        // These are the values for a WHITE void. Pick another background colour
        // and setVoidColor overrides both: ambientColor takes that colour's hue,
        // on the same principle as the cube-map presets (whatever surrounds the
        // objects is what should be lighting them — a blue void that lit
        // everything white would read as a flat cut-out), and ambientIntensity is
        // scaled by how bright the colour is, so black genuinely goes dark instead
        // of falling back to a bright neutral fill. 3.2 is therefore the CEILING
        // reached at pure white, not a constant.
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

    // Loads one cube face. ClampToEdge + no mipmaps keeps the sampler from
    // reaching past a face's own border, which is what produced bright or
    // wrong-coloured seam lines under RepeatWrapping. Square, equal-size faces
    // still look best — see inspectFaces for what happens when they aren't.
    function loadFaceTexture(url, revokeAfter = false, onReady = null) {
        // Non-square images are STRETCHED to fill the face, not centre-cropped.
        //
        // Cropping was the wrong call for a cube map and is the main reason some
        // folders showed visible edges while others were fine. A cube's faces only
        // join invisibly if each one carries the sky right up to its own border —
        // the right face's left border has to continue exactly where the front
        // face's right border stops. Cropping to a square throws away precisely
        // those borders, so every seam becomes a jump-cut. Stretching keeps the
        // full image, so the edges still line up; the picture is squashed a little
        // instead, which is far less noticeable than six hard lines.
        //
        // (Square images, which is what most packs ship, are unaffected either way.)
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
        // Canvas pixels are 0–255; normalizeHue works in 0–1 like THREE.Color, so
        // the two callers hand it the same units.
        return normalizeHue(R / (255 * n), G / (255 * n), B / (255 * n));
    }

    // Takes the HUE of a colour and throws away its brightness, so a dim
    // background still produces a usable fill (see the note above
    // averageFaceColor — a starfield averages to almost black, and feeding that
    // in raw would light nothing at all). Intensity stays the preset's job.
    // Shared by the cube-map average and the flat void colour so both answer
    // "what colour is the light around the objects" the same way.
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

    // Why a given folder shows seams, answered from the images themselves rather
    // than left to guesswork. Only two properties of the FILES can cause it:
    //
    //  • non-square faces — a cube face is square by definition, so anything else
    //    has to be distorted to fit, and it usually means the images aren't a cube
    //    map at all (a single panorama sliced up, or six unrelated photos)
    //  • mismatched sizes — adjacent faces at different resolutions meet at
    //    slightly different levels of detail, which shows as a visible change in
    //    sharpness along the join even when the content is correct
    //
    // What this CANNOT detect is the third cause, and in practice the commonest:
    // face orientation. Cube-map conventions disagree about handedness and about
    // how the top and bottom faces are rotated, so a pack can be named perfectly
    // and still meet at right angles. That one has to be seen to be diagnosed,
    // which is why the report says so instead of pretending everything is fine.
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
            const c = new THREE.Color(voidColor.hex);
            scene.background = c;
            onAverageColor?.(normalizeHue(c.r, c.g, c.b), voidBrightness(c));
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

    // Accepted filename tokens per cube face. There is no standard here — every
    // skybox pack invents its own — so the list covers the conventions actually
    // in circulation rather than insisting on one:
    //   • words:        right / left / top / bottom / front / back
    //   • abbreviations: rt / lf / up / dn / ft / bk  (the Quake-era set, very
    //                    common in game-asset packs and free skybox downloads)
    //   • axis names:   posx / negx, xpos / xneg, px / nx, xp / xn
    //   • compass:      east / west / north / south
    // Deliberately NOT included: bare numbers (0–5, 1–6). They appear in plenty
    // of packs, but there's no way to tell a face index from an image size or a
    // version suffix, and guessing wrong would silently build a scrambled sky —
    // worse than saying the files couldn't be read.
    const FACE_ALIASES = {
        right:  ['right',  'rt', 'east',  'posx', 'xpos', 'px', 'xp'],
        left:   ['left',   'lf', 'west',  'negx', 'xneg', 'nx', 'xn'],
        top:    ['top',    'up', 'zenith', 'posy', 'ypos', 'py', 'yp'],
        bottom: ['bottom', 'bot', 'dn', 'down', 'nadir', 'negy', 'yneg', 'ny', 'yn'],
        front:  ['front',  'ft', 'north', 'posz', 'zpos', 'pz', 'zp'],
        back:   ['back',   'bk', 'south', 'negz', 'zneg', 'nz', 'zn'],
    };

    // Whole-token match: the filename is split on non-alphanumeric characters, so
    // "cube_bot" offers ['cube','bot'] and can't accidentally match 'back' through
    // a stray letter. This is the strict pass and runs first for every file.
    function faceByToken(name) {
        const tokens = name.toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/);
        for (const face of SKYBOX_FACES) {
            if (tokens.some(tok => FACE_ALIASES[face].includes(tok))) return face;
        }
        return null;
    }

    // Fallback for names with no separator at all — "skyboxRT.png", "BKsunset.jpg"
    // — where tokenising yields one unsplittable blob. The face word can sit at
    // either end, since packs use both: some append it, some lead with it.
    //
    // Looser by nature — "group.png" ends in "up", "background.png" starts with
    // "back" — so it only ever fills faces the strict pass left empty, and suffix
    // is tried before prefix because trailing face names are the commoner style.
    function faceByEdge(name, mode) {
        const base = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
        for (const face of SKYBOX_FACES) {
            // Longest alias first: for "xneg…" this tries 'xneg' before 'xn', so a
            // more specific spelling can't be pre-empted by a shorter one.
            const aliases = [...FACE_ALIASES[face]].sort((a, b) => b.length - a.length);
            if (aliases.some(a => (mode === 'suffix' ? base.endsWith(a) : base.startsWith(a)))) return face;
        }
        return null;
    }

    // Matches a set of user-picked files to the 6 cube faces by filename
    // (e.g. "myscene_right.png" -> right, "posx.png" -> right, "skyBK.png" -> back).
    //
    // Three passes, strictest first, and that ordering is the point: a folder
    // picker hands over EVERY file inside, including stray readme or preview
    // images. Each looser pass only fills faces still unclaimed and only
    // considers files not already spoken for, so a properly named file always
    // wins its slot over an accidental prefix/suffix collision.
    //
    // Returns { matched, missing }. `missing` lets the caller name the faces it
    // couldn't find instead of just refusing the whole folder.
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

    // Repaints the flat background live. Only touches scene.background when the
    // solid-colour option is actually showing — the skybox mesh covers it
    // otherwise, so writing there would silently change what you'd see the next
    // time None was picked, with no visible feedback now.
    //
    // Reports the new hue back the same way a cube map does, so the fill light
    // follows the background without a second control to keep in sync.
    function setVoidColor(hex, onAmbientColor) {
        voidColor.hex = hex;
        const c = new THREE.Color(hex);
        if (!skybox.visible) scene.background = c;
        onAmbientColor?.(normalizeHue(c.r, c.g, c.b), voidBrightness(c));
    }

    // How much fill a flat background is worth, 0–1, scaling the preset's ambient
    // intensity. This is the piece that makes a black void actually dark.
    //
    // It exists ONLY for the flat colour, not for cube maps, and the distinction
    // is intent. A starfield is mostly black by accident — it's empty space with
    // a few bright points — and dimming the scene to match would leave nothing
    // visible, so there the darkness is discarded and only hue is taken. But a
    // flat colour is chosen: picking #000 is a decision that the objects sit in
    // darkness, and answering it with a bright neutral fill (which is what
    // normalizeHue alone does, since black has no channel ratio to preserve)
    // contradicts the choice. That was the surprising part.
    //
    // The measure is the BRIGHTEST CHANNEL, not perceptual luminance. Rec.709
    // weights would call pure red 0.21 and pure green 0.72, so a vivid red
    // background would come out three times dimmer than a vivid green one —
    // technically true of emitted light, but not what someone means when they
    // pick a saturated swatch. Max-channel is HSV's "value": fully saturated
    // hues all read as fully bright, and only genuinely dark colours dim. It's
    // also exactly the divisor normalizeHue already uses, so hue and brightness
    // are two halves of the same decomposition.
    //
    // The key light is deliberately left alone. At ambient 0 the objects are
    // still lit from one side, so a black void reads as dramatic and directional
    // rather than as a blank screen.
    function voidBrightness(c) {
        return Math.max(c.r, c.g, c.b);
    }

    return { loadSkybox, loadCustomSkybox, setVoidColor };
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
