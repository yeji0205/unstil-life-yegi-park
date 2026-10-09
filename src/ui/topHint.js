import { createScreenHint } from './screenHint.js';

// ─── The line of text at the top of the room ─────────────────────────────────
// One sentence at a time. Normally the invitation to the journey; pressing P
// also turns the sound on (browsers play nothing before a click or key press).
// Scrolling doesn't count as that, so if someone scrolls by hand while the sound
// is still off, the line becomes the sound note until the sound is on. Hidden
// while the journey plays.
const JOURNEY_TEXT = 'press P to begin the journey\n(auto play)';
const SOUND_TEXT   = 'click anywhere to turn on sound';

// onAudioStarted(fn): runs fn once the sound is playing (ambientSound.onStarted).
export function createTopHint(onAudioStarted) {
    // On the empty upper wall, where it's easy to see.
    const line = createScreenHint(JOURNEY_TEXT, { top: '88px' });
    let soundOn = false;
    let scrolled = false;
    let journeyPlaying = false;

    function refresh() {
        line.setText(scrolled && !soundOn ? SOUND_TEXT : JOURNEY_TEXT);
        if (journeyPlaying) line.hide();
        else line.show();
    }

    window.addEventListener('wheel', () => {
        if (scrolled || soundOn) return;
        scrolled = true;
        refresh();
    });
    onAudioStarted(() => {
        soundOn = true;
        refresh();
    });

    return {
        setJourneyPlaying(playing) {
            journeyPlaying = playing;
            refresh();
        },
    };
}
