// ─── A short line of text over the scene ─────────────────────────────────────
// Light text on the dark room, fading in and out (used by topHint.js). Clicks go
// through it to the page.

const FADE_MS = 900;

// Puts the text in el. A second line (after a line break) is a smaller note
// under the main sentence, e.g. 'press P to begin the journey\n(auto play)'.
function fillText(el, text) {
    const [main, note] = text.split('\n');
    el.textContent = main;
    if (!note) return;
    const noteLine = document.createElement('div');
    noteLine.textContent = note;
    Object.assign(noteLine.style, { fontSize: '0.7em', marginTop: '6px', opacity: '0.8' });
    el.appendChild(noteLine);
}

// style: CSS that places it and may override the look, e.g. { top: '88px' } or
// { top: '124px', fontSize: '14px' }.
export function createScreenHint(text, style) {
    const el = document.createElement('div');
    fillText(el, text);
    Object.assign(el.style, {
        position: 'fixed', left: '50%', transform: 'translateX(-50%)',
        zIndex: '50',
        fontFamily: "'Cormorant Garamond', Garamond, serif", fontWeight: '300', fontSize: '19px',
        letterSpacing: '0.3em',
        // Light text on the dark room; the shadow keeps it readable over the beam.
        color: 'rgba(255, 248, 236, 0.72)',
        textShadow: '0 1px 6px rgba(0,0,0,0.55)',
        opacity: '0', transition: `opacity ${FADE_MS}ms ease`,
        // Let clicks through to the page (they unlock the audio).
        pointerEvents: 'none',
        whiteSpace: 'nowrap', userSelect: 'none', textAlign: 'center',
        ...style,
    });
    document.body.appendChild(el);

    let visible = false;
    let targetText = text;  // the text it shows, or is about to show
    let changing = null;    // the timer while it fades out to change the text
    const fadeTo = (opacity) => { el.style.opacity = String(opacity); };
    // While the text is changing, it stays faded out until the new one is in.
    const show = () => { visible = true; if (!changing) fadeTo(1); };
    const hide = () => { visible = false; fadeTo(0); };

    // Fades out, changes the text, fades back in (if it's meant to be shown).
    function setText(newText) {
        if (newText === targetText) return;
        targetText = newText;
        clearTimeout(changing);
        fadeTo(0);
        changing = setTimeout(() => {
            changing = null;
            fillText(el, targetText);
            if (visible) fadeTo(1);
        }, FADE_MS);
    }

    // Fade in on the next frame, or the transition wouldn't run.
    requestAnimationFrame(show);
    return { show, hide, setText };
}
