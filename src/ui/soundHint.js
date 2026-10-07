// ─── "click to play sound" hint ───────────────────────────────────────────────
// Browsers play no sound until the user clicks or presses a key, and Chrome
// doesn't count scrolling. This hint appears over the room after the loading
// screen and fades out as soon as audio starts.

const FADE_MS = 900;

export function createSoundHint(onStarted) {
    const el = document.createElement('div');
    el.textContent = 'click to play sound';
    Object.assign(el.style, {
        // On the empty upper wall, clear of the screen edge.
        position: 'fixed', top: '88px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '50',
        font: "300 19px 'Cormorant Garamond', Garamond, serif",
        letterSpacing: '0.3em',
        // Light text on the dark room; the shadow keeps it readable over the beam.
        color: 'rgba(255, 248, 236, 0.72)',
        textShadow: '0 1px 6px rgba(0,0,0,0.55)',
        opacity: '0', transition: `opacity ${FADE_MS}ms ease`,
        // Let clicks through to the page, where they unlock the audio.
        pointerEvents: 'none',
        whiteSpace: 'nowrap', userSelect: 'none',
    });
    document.body.appendChild(el);

    // Fade in on the next frame, or the transition wouldn't run.
    requestAnimationFrame(() => { el.style.opacity = '1'; });

    let removed = false;
    const dismiss = () => {
        if (removed) return;
        removed = true;
        el.style.opacity = '0';
        setTimeout(() => el.remove(), FADE_MS);
    };

    // Sound is playing — the hint has served its purpose.
    onStarted(dismiss);

    return { dismiss };
}
