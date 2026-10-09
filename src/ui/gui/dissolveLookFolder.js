import {
    uDissolveEdge, uObjectDissolveEdge, uNoiseFreq, uDissolveEdgeColor, uObjectDissolveEdgeColor,
    uObjectEdgeFollow, uObjectEdgeGain,
} from '../../effects/dissolve.js';
import {
    uParticleColor, uParticleSwirl, uParticleSize, uParticleLife, uParticleDrift, uParticleTwinkle,
    uParticleSpikes, uParticleSpikeSharp, uParticleSpikeLength, uParticleShrink,
} from '../../effects/dissolveParticles.js';
import { bloomSettings } from '../../effects/particleBloom.js';
import { dissolveDuration } from '../../scene/dissolveTimeline.js';
import { addUniformColor } from './controls.js';

// ─── "Dissolve Look" folder: edges, particles and their glow ─────────────────
export function addDissolveLookFolder(gui) {
    const folder = gui.addFolder('Dissolve Look');
    addEdgeControls(folder);
    addParticleControls(folder);
    addBloomFolder(folder);
    return folder;
}

function addEdgeControls(folder) {
    // Two edge widths, not one. The same number lands very differently on a
    // 10-unit wall and a 1-unit object — see uObjectDissolveEdge for the
    // arithmetic. The object range is finer because its useful band is smaller.
    folder.add(uDissolveEdge,       'value', 0, 0.8,  0.01 ).name('Edge Width (Room)');
    folder.add(uObjectDissolveEdge, 'value', 0, 0.5,  0.005).name('Edge Width (Objects)');
    folder.add(uNoiseFreq,    'value', 0.1, 1.5, 0.01).name('Noise Frequency');
    // The colour of the edge around the holes in the walls (black by default).
    addUniformColor(folder, uDissolveEdgeColor, 'Edge Color (Room)');
    // Edge colour for the table and objects, separate from the room's. White by
    // default, like the particles. Ignored while "Edge Uses Object Color" is on.
    addUniformColor(folder, uObjectDissolveEdgeColor, 'Edge Color (Objects)');

    // When on, the edge uses the object's own colour instead of the picker above,
    // so holes in the hollow models don't get a bright outline. Brightness: below
    // 1 the edge is darker than the object, above 1 it glows.
    const edgeFollowProxy = { on: uObjectEdgeFollow.value > 0.5 };
    folder.add(edgeFollowProxy, 'on').name('Edge Uses Object Color')
        .onChange((v) => { uObjectEdgeFollow.value = v ? 1.0 : 0.0; });
    folder.add(uObjectEdgeGain, 'value', 0, 2.5, 0.05).name('Edge Brightness (Objects)');
}

function addParticleControls(folder) {
    // Live picker so neon shades can be auditioned.
    addUniformColor(folder, uParticleColor, 'Particle Color');
    // How far the particle stream wanders sideways. 0 is a perfectly straight
    // stream — the calmest setting, and worth starting from when judging the feel.
    folder.add(uParticleSwirl, 'value', 0, 0.25, 0.005).name('Particle Sway');

    // Size is a particle's size on screen. Life is how long it lasts after the
    // dissolve edge passes it; Drift is how far it travels in that time.
    // Speed is Drift / Life, so raising Life alone slows them down.
    folder.add(uParticleSize,  'value', 0.3, 3.0, 0.05).name('Particle Size');
    folder.add(uParticleLife,  'value', 0.4, 4.0, 0.1 ).name('Particle Life');
    folder.add(uParticleDrift, 'value', 0.2, 8.0, 0.1 ).name('Particle Drift');

    // The time budget the whole effect is spent out of — see dissolveDuration.
    // Raising it slows the specks without narrowing the plume, which is the one
    // thing Drift and Life cannot do between them.
    folder.add(dissolveDuration, 'value', 1.5, 12, 0.5).name('Dissolve Duration (s)');
    folder.add(uParticleTwinkle, 'value', 0, 1, 0.05).name('Particle Twinkle');
    folder.add(uParticleSpikes,  'value', 0, 1, 0.05).name('Particle Spikes');
    // Sharpness is a ray WIDTH, and it is the control that decides whether the
    // star is visible at all: half-width in pixels = (1/value) * sprite radius,
    // against a sprite clamped to 3-8 px. Range stops at 40 because anything
    // beyond that is already thinner than a pixel and indistinguishable.
    folder.add(uParticleSpikeSharp,  'value', 2, 40, 0.5).name('Spike Sharpness');
    // Lower = longer rays (it is the exponent on the radial fade).
    folder.add(uParticleSpikeLength, 'value', 0.5, 4, 0.1).name('Spike Length');
    folder.add(uParticleShrink,  'value', 0, 5, 0.1 ).name('Particle Shrink');
}

// Only affects shiny mode. Sliders, because the right glow depends on the
// background (a bright nebula needs more than a black void).
function addBloomFolder(parent) {
    const folder = parent.addFolder('Particle Bloom (shiny only)');
    // Composite strength is the dial to reach for first — it scales the whole
    // glow after the fact, without touching what qualifies as bloom.
    folder.add(bloomSettings, 'composite', 0, 20, 0.1).name('Glow Strength');
    // How far the glow bleeds outward from each speck.
    folder.add(bloomSettings, 'radius', 0, 1, 0.01).name('Glow Radius');
    // Luminance a pixel has to reach before it blooms at all. Raise it to make
    // only the hottest particle cores glow; drop it and the dimmer trailing
    // specks start to as well.
    folder.add(bloomSettings, 'threshold', 0, 1, 0.01).name('Glow Threshold');
    folder.add(bloomSettings, 'strength', 0, 3, 0.01).name('Bloom Pass Strength');
}
