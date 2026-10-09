import { uProgress, scrollSmoothing } from '../../scene/phaseMachine.js';
import { roomLighting, environmentMap, ambientTint } from '../../scene/lighting.js';

// ─── "Scene" folder: progress, scroll feel and lighting ──────────────────────
export function addSceneFolder(gui) {
    const folder = gui.addFolder('Scene');

    folder.add(uProgress, 'value', 0, 1, 0.01).name('Progress (p)').listen();
    // Scroll feel: how much the scene trails the wheel. Higher = objects drift
    // and coast (floaty); lower = they track the wheel closely (snappy, but the
    // float/bob gets swamped and reads as dragging). See scrollSmoothing.
    folder.add(scrollSmoothing, 'tau', 0.08, 0.6, 0.01).name('Scroll Drift (float ⇢)');

    // Room Key dims the key light for EVERYTHING; Object Key puts it back on the
    // table and the objects alone, via a light they have a layer for. Together
    // they darken the walls and floor without taking the still life with them.
    // 1.0 / 0.0 is the original lighting exactly.
    folder.add(roomLighting, 'roomKey',   0.05, 1.5, 0.05).name('Room Key Light');
    folder.add(roomLighting, 'objectKey', 0.0,  4.0, 0.05).name('Object Key Light');
    folder.add(roomLighting, 'ambient',   0.0,  1.5, 0.05).name('Room Ambient');
    folder.add(roomLighting, 'wallFill',  0.0,  1.5, 0.05).name('Room Wall Fill');
    // The spotlight matched to the visible shaft — this is what creates the
    // bright pool, so it is the one to raise for more contrast, not lower.
    folder.add(roomLighting, 'beam',      0.0,  25,  0.5 ).name('Beam Light');
    // Fade each light's shadow on its own: 0 = gone, 1 = full. The beam's is the
    // dark one inside the lit pool; the key's is the lighter one that reaches
    // beyond it. Only the shadow changes — the light stays. Capped at 1, see
    // roomLighting.beamShadow for why.
    folder.add(roomLighting, 'beamShadow', 0, 1, 0.01).name('Beam Shadow');
    folder.add(roomLighting, 'keyShadow',  0, 1, 0.01).name('Key Light Shadow');
    // How strongly objects reflect their surroundings in space (see lighting.js).
    folder.add(environmentMap, 'strength', 0, 3, 0.05).name('Env Map Strength');
    // How much the objects' shadow sides take the background's colour in space.
    folder.add(ambientTint, 'strength', 0, 1, 0.05).name('Background Tint');
    folder.add(roomLighting, 'beamWidth', 0.4,  2.5, 0.05).name('Beam Width');
    folder.add(roomLighting, 'beamShiftX', -4, 4, 0.1).name('Beam Shift X (→)');
    folder.add(roomLighting, 'beamShiftZ', -4, 4, 0.1).name('Beam Shift Z (back)');
    folder.add(roomLighting, 'beamSoftness', 0, 1, 0.05).name('Beam Softness');
    folder.add(roomLighting, 'beamHaze', 0, 1.5, 0.05).name('Beam Haze');
    return folder;
}
