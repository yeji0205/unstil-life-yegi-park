// ─── Reading an uploaded skybox folder ───────────────────────────────────────
// Matches the uploaded image files to the 6 faces by filename, and explains what
// in the images will show as seams. Used by loadCustomSkybox in space.js;
// `faces` is its list of face names (SKYBOX_FACES), in order.

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
function faceByToken(name, faces) {
    const tokens = name.toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/);
    for (const face of faces) {
        if (tokens.some(tok => FACE_ALIASES[face].includes(tok))) return face;
    }
    return null;
}

// Loose match for names without separators ("skyboxRT.png"): the face word at
// the end or the start. Can misfire ("group" ends in "up"), so it only fills
// faces the strict match left empty.
function faceByEdge(name, mode, faces) {
    const base = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    for (const face of faces) {
        // Longest alias first, so 'xneg' wins over 'xn'.
        const aliases = [...FACE_ALIASES[face]].sort((a, b) => b.length - a.length);
        if (aliases.some(a => (mode === 'suffix' ? base.endsWith(a) : base.startsWith(a)))) return face;
    }
    return null;
}

// Image formats an uploaded face can be in: what browsers display, plus TGA
// (loaded with three.js's TGALoader in space.js).
const SUPPORTED_IMAGE = /\.(png|jpe?g|webp|avif|gif|bmp|tga)$/i;
// Image formats browsers can't open; named in the error so the user can convert them.
const UNREADABLE_IMAGE = /\.(exr|hdr|tiff?|psd|dds|ktx2?|heic|heif)$/i;

export function isTga(file) {
    return /\.tga$/i.test(file.name);
}

// Matches uploaded files to the 6 faces in three passes, strictest first, so a
// properly named file always wins over a stray file in the folder. Only image
// files take part, so e.g. "top_notes.txt" can't become the top face.
// Returns { matched, missing, unsupported }: the caller can name the missing
// faces and the files in formats the browser can't open.
export function matchFaceFiles(files, faces) {
    const all = Array.from(files);
    const list = all.filter((f) => SUPPORTED_IMAGE.test(f.name));
    const unsupported = all.filter((f) => UNREADABLE_IMAGE.test(f.name)).map((f) => f.name);
    const matched = {};
    const claimed = new Set();
    const claim = (face, file) => {
        if (!face || matched[face]) return;
        matched[face] = file;
        claimed.add(file);
    };

    for (const f of list) claim(faceByToken(f.name, faces), f);
    for (const f of list) if (!claimed.has(f)) claim(faceByEdge(f.name, 'suffix', faces), f);
    for (const f of list) if (!claimed.has(f)) claim(faceByEdge(f.name, 'prefix', faces), f);

    return { matched, missing: faces.filter(face => !matched[face]), unsupported };
}

// Explains problems in an uploaded skybox. `unreadable`: faces whose file
// couldn't be read. `notes`: causes of seams (non-square faces get stretched,
// faces of different sizes meet at different sharpness). It can't detect the
// most common seam cause, faces rotated the wrong way, which has to be seen.
export function inspectFaces(images, faces) {
    const notes = [];
    let unreadable = null;
    const dims = images.map((img, i) => img
        ? { face: faces[i], w: img.width, h: img.height }
        : { face: faces[i], w: 0, h: 0 });

    // A face whose file couldn't be read (damaged, or not really that format).
    const failed = dims.filter(d => !d.w).map(d => d.face);
    if (failed.length) {
        unreadable = (`The ${failed.join(', ')} image${failed.length > 1 ? 's' : ''} couldn't be read, `
            + `so ${failed.length > 1 ? 'those sides stay' : 'that side stays'} black. The file may be `
            + 'damaged or in a format the browser can\'t open: PNG or JPEG always work.');
    }

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

    return { notes, sizes, unreadable };
}
