// ─── Performance HUD (diagnostic) ─────────────────────────────────────────────
// A small readout in the corner, toggled with "t": fps, frame time, resolution,
// draw calls and which GPU is used. If the GPU reads "SwiftShader" or "Software",
// the browser is rendering on the CPU and nothing will run well; that's a
// browser/driver problem, not the scene.
//
// Delete this file and its two lines in main.js to remove it.

export function createPerfHud(renderer) {
    const el = document.createElement('div');
    Object.assign(el.style, {
        position: 'fixed', left: '10px', bottom: '10px', zIndex: '9999',
        font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#cfe8ff', background: 'rgba(0,0,0,0.62)',
        padding: '7px 10px', borderRadius: '5px', whiteSpace: 'pre',
        pointerEvents: 'none', userSelect: 'none',
        // Hidden until "t" is pressed. It keeps updating while hidden, so the
        // numbers are ready when it appears.
        display: 'none',
    });
    document.body.appendChild(el);

    // "t" shows/hides the readout.
    window.addEventListener('keydown', (e) => {
        if (e.key !== 't' && e.key !== 'T') return;
        // Ignored while typing in a GUI field.
        const target = e.target;
        if (target instanceof HTMLElement
            && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        el.style.display = el.style.display === 'none' ? '' : 'none';
    });

    // The GPU string is only exposed through this debug extension.
    let gpu = 'unknown';
    try {
        const gl = renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) gpu = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch { /* extension blocked — leave as unknown */ }
    const software = /swiftshader|software|llvmpipe|basic render/i.test(gpu);

    let frames = 0, acc = 0, worst = 0, last = performance.now();

    // Called once per frame from the render loop.
    function update() {
        const now = performance.now();
        const ms  = now - last;
        last = now;
        frames++; acc += ms; if (ms > worst) worst = ms;

        if (acc >= 500) { // refresh twice a second so the numbers are readable
            const avg = acc / frames;
            el.textContent =
                `${(1000 / avg).toFixed(0)} fps   ${avg.toFixed(1)} ms  (worst ${worst.toFixed(0)})\n` +
                `${renderer.domElement.width}×${renderer.domElement.height}\n` +
                `calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}\n` +
                `${software ? '⚠ SOFTWARE RENDERER — ' : ''}${gpu}`;
            el.style.color = software ? '#ffb3b3' : '#cfe8ff';
            frames = 0; acc = 0; worst = 0;
        }
    }

    return { update, el };
}
