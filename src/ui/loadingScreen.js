// State machine:  'showing' → (assets ready + 1.2 s min hold) → 'dissolving' → 'done'
//
// 'showing'   — particles are static at their home positions; "Unstil Life" is readable.
// 'dissolving'— each particle drifts from home to its scatter position with a staggered
//               left-to-right delay so each letter dissolves in sequence.
// 'done'      — overlay fades out and is removed, revealing the Three.js scene.
const MIN_SHOW_MS = 1200; // always display text for at least this long

// Creates the loading overlay, samples the "Unstil Life" glyph into particles,
// and runs its own animation loop. Call `markAssetLoaded()` once per asset as
// it finishes; `onDone` fires once the dissolve animation completes and the
// overlay is removed.
export function createLoadingScreen(totalAssets, onDone) {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
        position: 'fixed', inset: '0', background: '#fff',
        zIndex: '100', transition: 'opacity 1.2s ease',
    });

    const canvas = document.createElement('canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, { position: 'absolute', inset: '0' });
    overlay.appendChild(canvas);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    let particles      = [];
    let animId         = null;
    let state          = 'showing'; // 'showing' | 'dissolving' | 'done'
    let dissolveStartMs = 0;        // rAF timestamp captured on first dissolving frame
    let textReady      = false;
    let assetsReady    = false;
    let showStartMs    = 0;         // performance.now() when text first became visible
    let loadedCount    = 0;

    function maybeStartDissolve() {
        if (!textReady || !assetsReady || state !== 'showing') return;
        const waited = performance.now() - showStartMs;
        const delay  = Math.max(0, MIN_SHOW_MS - waited);
        setTimeout(() => { if (state === 'showing') state = 'dissolving'; }, delay);
    }

    // (Re)samples the "Unstil Life" glyph into particles at the CURRENT canvas
    // size and re-centers it. Called once the font is ready, and again on every
    // window resize while the text is still static — so the title stays centered
    // and correctly sized instead of being clipped/off-center after a resize.
    function sampleParticles() {
        const W = canvas.width;
        const H = canvas.height;

        const off    = document.createElement('canvas');
        off.width = W; off.height = H;
        const offCtx = off.getContext('2d');

        const fontSize = Math.min(W * 0.08, 86);
        offCtx.font          = `300 ${fontSize}px 'Cormorant Garamond', Garamond, serif`;
        offCtx.textAlign     = 'center';
        offCtx.textBaseline  = 'middle';
        offCtx.letterSpacing = `${fontSize * 0.12}px`;
        offCtx.fillStyle     = '#000';
        offCtx.fillText('Unstil Life', W / 2, H / 2);

        const imgData    = offCtx.getImageData(0, 0, W, H).data;
        const textPixels = [];
        const STEP = 3;
        for (let y = 0; y < H; y += STEP)
            for (let x = 0; x < W; x += STEP)
                if (imgData[(y * W + x) * 4 + 3] > 120) textPixels.push([x, y]);

        // Shuffle so the 900-particle cap samples evenly across all letters
        for (let i = textPixels.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [textPixels[i], textPixels[j]] = [textPixels[j], textPixels[i]];
        }

        particles = textPixels.slice(0, 900).map(([hx, hy]) => {
            const angle = Math.random() * Math.PI * 2;
            const dist  = Math.random() * 90 + 30;
            return {
                homeX:        hx,
                homeY:        hy,
                scatterX:     hx + Math.cos(angle) * dist,
                scatterY:     hy + Math.sin(angle) * dist - Math.random() * 25, // slight upward drift
                // dissolveDelay: left letters start first, staggered over 0.55 s + per-particle noise
                dissolveDelay: (hx / W) * 0.55 + Math.random() * 0.08,
                r:            Math.random() * 1.0 + 0.6,
            };
        });
    }

    // Keep the overlay full-screen and the title centered when the window is
    // resized mid-load. Re-sampling is only safe while the text is still static
    // ('showing'); once it's dissolving we leave the in-flight particles alone
    // (a resize during the ~1 s dissolve is unlikely and not worth a re-layout).
    function onResize() {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        if (textReady && state === 'showing') sampleParticles();
    }
    window.addEventListener('resize', onResize);

    // Sample "Unstil Life" glyph pixels after the Google Font is guaranteed loaded.
    document.fonts.ready.then(() => {
        sampleParticles();
        showStartMs = performance.now();
        textReady   = true;
        maybeStartDissolve();
    });

    function animateFrame(time) {
        animId = requestAnimationFrame(animateFrame);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (state === 'showing') {
            // Static: every particle sits exactly at its home position
            for (const p of particles) {
                ctx.beginPath();
                ctx.arc(p.homeX, p.homeY, p.r, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0,0,0,0.88)';
                ctx.fill();
            }
            return;
        }

        if (state === 'dissolving') {
            if (dissolveStartMs === 0) dissolveStartMs = time; // latch on first dissolving frame
            const elapsed = (time - dissolveStartMs) * 0.001; // seconds since dissolve began

            let allSettled = true;
            for (const p of particles) {
                // Each particle waits for its dissolveDelay, then moves over 1.1 s
                const localT = Math.min(Math.max((elapsed - p.dissolveDelay) / 1.1, 0), 1);
                if (localT < 1) allSettled = false;

                const x     = p.homeX + (p.scatterX - p.homeX) * localT;
                const y     = p.homeY + (p.scatterY - p.homeY) * localT;
                const alpha = Math.pow(1 - localT, 1.8) * 0.88 + 0.02;

                ctx.beginPath();
                ctx.arc(x, y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0,0,0,${alpha})`;
                ctx.fill();
            }

            if (allSettled) {
                state = 'done';
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.remove();
                    cancelAnimationFrame(animId);
                    window.removeEventListener('resize', onResize);
                }, 1200);
                onDone();
            }
        }
    }
    animId = requestAnimationFrame(animateFrame);

    // Safety net: if assets haven't finished after 15 s (slow network / 404), force proceed.
    setTimeout(() => {
        if (!assetsReady) {
            console.warn('Asset load timeout — forcing loading screen to proceed.');
            assetsReady = true;
            maybeStartDissolve();
        }
    }, 15000);

    function markAssetLoaded() {
        loadedCount++;
        if (loadedCount >= totalAssets) {
            assetsReady = true;
            maybeStartDissolve();
        }
    }

    return { markAssetLoaded };
}
