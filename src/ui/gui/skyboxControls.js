import { SKYBOX_OPTIONS, SKYBOX_NONE, voidColor } from '../../scene/space.js';
import { createFilePicker, showModal } from './controls.js';

// ─── Skybox picker and background colour (in "Scene Contents") ───────────────

// Opens a folder picker instead of choosing a built-in skybox.
const SKYBOX_CUSTOM_LABEL = 'Add custom skybox…';

// Shown before the folder picker: a skybox needs 6 face images, matched to the
// faces by filename (see matchFaceFiles in scene/space.js).
const CUSTOM_SKYBOX_HELP_HTML = `
    <p style="margin:0 0 12px;">The background is a <b>box around the whole
    scene</b>, so it needs <b>6 images</b> — one per side — not a single
    picture.</p>
    <p style="margin:0 0 6px;"><b>Name each file for its face</b> (the
    name just has to <i>contain</i> the word):</p>
    <ul style="margin:0 0 12px;padding-left:20px;">
      <li><code>right</code> &amp; <code>left</code> — the two sides</li>
      <li><code>top</code> &amp; <code>bot</code> — up &amp; down</li>
      <li><code>front</code> &amp; <code>back</code> — ahead &amp; behind</li>
    </ul>
    <p style="margin:0 0 12px;font-size:14px;color:#6a6155;">Most skybox packs
    are already named this way and will just work. Also accepted:
    <code>rt/lf/up/dn/ft/bk</code>, <code>posx/negx…</code>,
    <code>px/nx…</code>, east/west/north/south — with or without a prefix,
    e.g. <code>myscene_rt.png</code>.</p>
    <p style="margin:0 0 12px;"><b>Formats:</b> PNG, JPEG, WebP, AVIF, GIF, BMP or
    TGA. HDR/EXR, TIFF and PSD can't be read: convert them to PNG first.</p>
    <p style="margin:0 0 4px;"><b>Size:</b> all 6 the <b>same square size</b>
    (e.g. 1024×1024 or 2048×2048). Non-square images are center-cropped, so
    very wide/tall ones lose their edges.</p>
    <p style="margin:8px 0 0;">Next, pick the <b>folder</b> that contains the
    6 images.</p>`;

// Shown when a picked folder doesn't give all 6 faces; `missing` names the faces
// it couldn't find, which is far more actionable than "something was wrong", and
// `unsupported` the files in formats the browser can't open.
function missingFacesHtml(missing, unsupported) {
    return `
        ${missing.length ? `<p style="margin:0 0 10px;">No image found for:
        <strong>${missing.join(', ')}</strong>.</p>` : ''}
        ${unsupported.length ? `<p style="margin:0 0 10px;">These files are in a format the
        browser can't open: <strong>${unsupported.join(', ')}</strong>. Convert them to PNG
        or JPEG.</p>` : ''}
        <p style="margin:0 0 10px;">Each of the six images needs a filename that
        says which face it is. Any of these spellings work:</p>
        <table style="margin:0 0 10px;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:2px 14px 2px 0;"><strong>right</strong></td><td><code>right</code> · <code>rt</code> · <code>posx</code> · <code>px</code> · <code>east</code></td></tr>
          <tr><td style="padding:2px 14px 2px 0;"><strong>left</strong></td><td><code>left</code> · <code>lf</code> · <code>negx</code> · <code>nx</code> · <code>west</code></td></tr>
          <tr><td style="padding:2px 14px 2px 0;"><strong>top</strong></td><td><code>top</code> · <code>up</code> · <code>posy</code> · <code>py</code></td></tr>
          <tr><td style="padding:2px 14px 2px 0;"><strong>bottom</strong></td><td><code>bottom</code> · <code>bot</code> · <code>dn</code> · <code>down</code> · <code>negy</code> · <code>ny</code></td></tr>
          <tr><td style="padding:2px 14px 2px 0;"><strong>front</strong></td><td><code>front</code> · <code>ft</code> · <code>posz</code> · <code>pz</code> · <code>north</code></td></tr>
          <tr><td style="padding:2px 14px 2px 0;"><strong>back</strong></td><td><code>back</code> · <code>bk</code> · <code>negz</code> · <code>nz</code> · <code>south</code></td></tr>
        </table>
        <p style="margin:0;font-size:14px;opacity:0.75;">Prefixes and suffixes are fine
        — <code>myscene_rt.png</code> and <code>skyBK.jpg</code> both work. Files
        numbered <code>0</code>–<code>5</code> can't be matched, since there's no way
        to tell a face number from an image size.</p>`;
}

// Shown once a custom cube map has loaded, if anything about the images will make
// the joins visible.
function skyboxCaveatsHtml({ notes, unreadable }) {
    const seams = notes.length ? seamsHtml(notes) : '';
    return (unreadable ? `<p style="margin:0 0 12px;">${unreadable}</p>` : '') + seams;
}

function seamsHtml(notes) {
    return `
        <p style="margin:0 0 10px;">The six faces were found and applied, but
        these will show as edges between them:</p>
        <ul style="margin:0 0 12px;padding-left:20px;">
          ${notes.map(n => `<li style="margin-bottom:6px;">${n}</li>`).join('')}
        </ul>
        <p style="margin:0;font-size:14px;opacity:0.8;">A cube map only joins
        invisibly when all six faces are <b>square and the same size</b>, and when
        they came from one cube map rather than being assembled by hand. If the
        sizes look right and you still see edges, the pack is most likely using a
        different face <b>orientation</b> convention — top and bottom are the usual
        culprits, and that can only be fixed by rotating those two images.</p>`;
}

// Adds the Skybox dropdown and the background colour (shown only for the solid
// colour option). Returns reportSkyboxImages, called once a custom cube map
// has loaded.
export function addSkyboxControls(folder, { onSkyboxChange, onCustomSkyboxFiles, onVoidColorChange }) {
    const openFolderPicker = createFilePicker({
        folder: true,
        onPick: (files) => {
            // true on success; otherwise { missing, unsupported } (see loadCustomSkybox).
            const result = onCustomSkyboxFiles(files);
            if (result === true) return;
            showModal({
                title: "Couldn't read all 6 faces",
                bodyHTML: missingFacesHtml(result.missing ?? [], result.unsupported ?? []),
                confirmLabel: 'Got it',
                cancelLabel: null,
            });
        },
    });

    const settings = { cubemap: SKYBOX_OPTIONS[0] };
    let lastSkybox = settings.cubemap;
    const skyboxCtrl = folder.add(settings, 'cubemap', [...SKYBOX_OPTIONS, SKYBOX_CUSTOM_LABEL])
        .name('Skybox')
        .onChange((folderName) => {
            if (folderName === SKYBOX_CUSTOM_LABEL) {
                // Reset the dropdown, or choosing "Add custom skybox…" a second
                // time wouldn't fire onChange (the value wouldn't change).
                settings.cubemap = lastSkybox;
                skyboxCtrl.updateDisplay();
                showModal({
                    title: 'Custom background (cube map)',
                    bodyHTML: CUSTOM_SKYBOX_HELP_HTML,
                    confirmLabel: 'Choose folder…',
                    onConfirm: openFolderPicker,
                });
                return;
            }
            lastSkybox = folderName;
            onSkyboxChange(folderName);
            syncVoidColorVisibility(folderName);
        });

    // Background colour: only shown for the solid-colour option, since it does
    // nothing while a skybox is showing. (Table Material works the same way.)
    const voidColorCtrl = folder.addColor(voidColor, 'hex').name('Background Color')
        .onChange(onVoidColorChange);
    const voidResetCtrl = folder.add({ reset: () => {
        voidColor.hex = '#ffffff';
        voidColorCtrl.updateDisplay();
        onVoidColorChange(voidColor.hex);
    } }, 'reset').name('↺ Reset to white');
    const syncVoidColorVisibility = (label) => {
        if (label === SKYBOX_NONE) { voidColorCtrl.show(); voidResetCtrl.show(); }
        else                       { voidColorCtrl.hide(); voidResetCtrl.hide(); }
    };
    syncVoidColorVisibility(settings.cubemap);

    // Shown only when there's something to say; a clean folder loads silently.
    return function reportSkyboxImages(report) {
        if (!report?.notes?.length && !report?.unreadable) return;
        showModal({
            title: 'Background loaded, with caveats',
            bodyHTML: skyboxCaveatsHtml(report),
            confirmLabel: 'Got it',
            cancelLabel: null,
        });
    };
}
