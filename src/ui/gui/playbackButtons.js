import { flowState } from '../../effects/skyboxFlow.js';
import { uParticleShiny } from '../../effects/dissolveParticles.js';
import { addToggleButton } from './controls.js';

// ─── The buttons at the top of the panel ─────────────────────────────────────
// Only the controls you press (buttons and the scrub bar) sit at the top level;
// everything else is in folders. Returns two functions main.js calls when the
// state changes elsewhere: setDissolveAvailable (the phase machine decides when
// Dissolve works) and setJourneyPlaying (the journey can also start and stop
// from the P key, or stop when the viewer takes over).
export function addPlaybackButtons(gui, {
    onJourneyToggle, onDissolveClick, onDissolvePauseToggle, onDissolveSeek, getDissolveFraction,
}) {
    // The whole artwork playing by itself (see scene/journey.js).
    const journeyLabel = (playing) => (playing ? '■ Stop Journey' : '▶ Play Journey (P)');
    const journeyController = gui.add({ toggle: () => onJourneyToggle() }, 'toggle')
        .name(journeyLabel(false));

    // Disabled until phase === 'space'.
    const dissolveController = gui.add({ dissolve: () => onDissolveClick() }, 'dissolve')
        .name('▶ Dissolve Objects');
    dissolveController.disable(); // enabled once the room is fully gone (setDissolveAvailable)

    // Freezes the dissolve, to look at one moment of it. Can be pressed before
    // Dissolve too, which then holds at the very start.
    let dissolvePaused = false;
    const togglePause = addToggleButton(gui, {
        isOn: () => dissolvePaused,
        toggle: () => {
            dissolvePaused = !dissolvePaused;
            onDissolvePauseToggle(dissolvePaused);
        },
        labelWhenOn: '▶ Resume Dissolve',
        labelWhenOff: '⏸ Pause Dissolve',
    });

    // Scrub bar: drag back to rewind, forward to advance. It reads the phase
    // machine every frame (.listen()), so it also follows playback and the return.
    // Dragging pauses, so the bar holds the moment, but only if the seek applied
    // (mid-dissolve); otherwise the next Dissolve would start paused.
    const dissolveScrub = {
        get position() { return getDissolveFraction(); },
        set position(v) {
            if (onDissolveSeek(v) && !dissolvePaused) togglePause();
        },
    };
    gui.add(dissolveScrub, 'position', 0, 1, 0.001).name('⏯ Dissolve Position').listen();

    // Toggles the swirling curl-noise UV warp on the skybox texture (see
    // effects/skyboxFlow.js).
    addToggleButton(gui, {
        isOn: () => flowState.enabled,
        toggle: () => { flowState.enabled = !flowState.enabled; },
        labelWhenOn: '⏸ Stop Background Motion',
        labelWhenOff: '🌀 Animate Background',
    });

    // Flat/shiny particle switch, at the top level so it can be flipped during a
    // dissolve; it takes effect on the next frame. Flat mode skips the glow pass,
    // so it's also faster. The label names what the NEXT click does.
    addToggleButton(gui, {
        isOn: () => uParticleShiny.value > 0.5,
        toggle: () => { uParticleShiny.value = uParticleShiny.value > 0.5 ? 0.0 : 1.0; },
        labelWhenOn: '⚪ Flat White Particles',
        labelWhenOff: '✨ Shiny Particles',
    });

    return {
        setDissolveAvailable: (available) => dissolveController.enable(available),
        setJourneyPlaying: (playing) => journeyController.name(journeyLabel(playing)),
    };
}
