import { builtinTableColor } from '../../objects/builtinTable.js';
import { STONE_NAMES } from '../../objects/objectSwap.js';
import { createFilePicker, addFileButton } from './controls.js';
import { addSkyboxControls } from './skyboxControls.js';

// ─── "Scene Contents" folder: skybox, table, stone ───────────────────────────
// The Table and Stone dropdown labels live here because they're only GUI text:
// the scene is told a table kind ('glb' | 'box' | 'cylinder') or a stone name.

// "Custom GLB…" in either dropdown opens a file picker.
const CUSTOM_GLB_LABEL = 'Custom GLB…';
// The Table dropdown: label → the table kind the scene builds. To add a shape:
// a label here and a case in loadTableGeometry() (objects/tableSetup.js).
const TABLE_KIND_BY_LABEL = {
    'Table (default)': 'glb',
    'Box':             'box',
    'Cylinder':        'cylinder',
};
const TABLE_OPTIONS = [...Object.keys(TABLE_KIND_BY_LABEL), CUSTOM_GLB_LABEL];

// The texture slots of the built-in tables: button label → material map.
const TABLE_TEXTURE_SLOTS = {
    'Color / Albedo…': 'map',
    'Normal…':         'normalMap',
    'Roughness…':      'roughnessMap',
    'Metalness…':      'metalnessMap',
    'Bump / Height…':  'bumpMap',
};

// Returns reportSkyboxImages (see skyboxControls.js) and the folder.
export function addSceneContentsFolder(gui, actions) {
    const folder = gui.addFolder('Scene Contents');
    const reportSkyboxImages = addSkyboxControls(folder, actions);
    addTableControls(folder, actions);
    addStoneControls(folder, actions);
    return { folder, reportSkyboxImages };
}

// Table picker — swaps the table geometry live. "Custom GLB…" opens a file
// picker instead of switching immediately; the swap happens once a .glb is
// picked (or never, if cancelled — the dropdown then shows "Custom GLB…" but
// nothing changes).
function addTableControls(folder, { onTableChange, onCustomTableFile, onTableTextureFile, onTableColorChange }) {
    const openTablePicker = createFilePicker({ accept: '.glb,.gltf', onPick: onCustomTableFile });
    const settings = { table: TABLE_OPTIONS[0] };
    folder.add(settings, 'table', TABLE_OPTIONS)
        .name('Table')
        .onChange((label) => {
            if (label === CUSTOM_GLB_LABEL) openTablePicker();
            else onTableChange(TABLE_KIND_BY_LABEL[label]);
            syncTableMatVisibility(label);
        });

    // Table material — only meaningful for the built-in Box/Cylinder tables, since
    // the GLB tables carry their own materials. A colour swatch for a plain painted
    // plinth, plus the full set of PBR map slots for anything richer. Maps mix
    // freely and persist across Box↔Cylinder swaps (objects/builtinTable.js keeps them).
    const tableMatFolder = folder.addFolder('Table Material (Box/Cyl)');

    // Colour applies only when no albedo map is loaded — a map is TINTED by
    // colour, so the two would fight. builtinTable.js whitens the tint in that case.
    tableMatFolder.addColor(builtinTableColor, 'hex').name('Plinth Color')
        .onChange(onTableColorChange);
    tableMatFolder.add({ reset: () => {
        builtinTableColor.hex = '#e8e4dc'; // gallery-plinth off-white
        tableMatFolder.controllers.forEach((c) => c.updateDisplay());
        onTableColorChange(builtinTableColor.hex);
    } }, 'reset').name('↺ Reset to plinth white');

    for (const [name, type] of Object.entries(TABLE_TEXTURE_SLOTS)) {
        addFileButton(tableMatFolder, name, { accept: 'image/*', onPick: (file) => onTableTextureFile(file, type) });
    }

    // Shown, and opened, only for Box/Cylinder (collapsed, nobody found it). GLB
    // tables have their own materials and ignore these.
    const syncTableMatVisibility = (label) => {
        if (label === 'Box' || label === 'Cylinder') {
            tableMatFolder.show();
            tableMatFolder.open();
        } else {
            tableMatFolder.hide();
        }
    };
    syncTableMatVisibility(TABLE_OPTIONS[0]);
}

// Stone picker — swap the gem on the table to see how each one sits with the
// rest of the still life. The same list drives the return-from-space cycle,
// so whatever is offered here is also what can come back (see STONE_VARIANTS).
function addStoneControls(folder, { onStoneChange, onCustomStoneFile }) {
    const openStonePicker = createFilePicker({ accept: '.glb,.gltf', onPick: onCustomStoneFile });
    const stoneOptions = [...STONE_NAMES, CUSTOM_GLB_LABEL];
    const settings = { stone: stoneOptions[0] };
    let lastStone = stoneOptions[0];
    const stoneCtrl = folder.add(settings, 'stone', stoneOptions)
        .name('Stone')
        .onChange((label) => {
            if (label === CUSTOM_GLB_LABEL) {
                // Snap back to the last real choice so picking "Custom" twice in
                // a row still re-opens the dialog — lil-gui only fires onChange
                // when the value actually changes.
                settings.stone = lastStone;
                stoneCtrl.updateDisplay();
                openStonePicker();
                return;
            }
            lastStone = label;
            onStoneChange(label);
        });
}
