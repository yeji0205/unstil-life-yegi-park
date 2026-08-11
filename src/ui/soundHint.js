// ─── "click to play sound" hint ───────────────────────────────────────────────
// Browsers refuse to produce sound until the page receives a genuine user
// gesture, and Chrome does NOT count scrolling as one — so a viewer who only
// scrolls through this piece would never hear the café ambience without being
// told. This is that nudge.
//
// It lives in the ROOM rather than gating the landing page: the title screen
// gets to dissolve on its own, uninterrupted, and the hint then fades in over
// the scene at the top of the frame, out of the still life's way. The moment
// audio actually starts it fades itself out for good — so it's only ever
// present while it's still true.

const FADE_MS = 900;

export function createSoundHint(onStarted) {
    const el = document.createElement('div');
    el.textContent = 'click to play sound';
    Object.assign(el.style, {
        // Sat at 26px it hugged the very top edge and was easy to miss (and can
        // collide with browser UI). 88px drops it clear of the edge into the
        // room's empty upper wall, where the eye actually lands.
        position: 'fixed', top: '88px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '50',
        font: "300 19px 'Cormorant Garamond', Garamond, serif",
        letterSpacing: '0.3em',
        // Light type: the room behind it is dark. A soft shadow keeps it legible
        // if it ever lands over the bright shaft of the light beam.
        color: 'rgba(255, 248, 236, 0.72)',
        textShadow: '0 1px 6px rgba(0,0,0,0.55)',
        opacity: '0', transition: `opacity ${FADE_MS}ms ease`,
        // Never intercept clicks: the whole point is that the viewer's click
        // reaches the page, where the audio system's own listeners unlock it.
        pointerEvents: 'none',
        whiteSpace: 'nowrap', userSelect: 'none',
    });
    document.body.appendChild(el);

    // Fade in on the next frame so the transition actually runs (setting opacity
    // in the same frame the element is added would just snap to the end value).
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
