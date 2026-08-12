// ─── Performance HUD (diagnostic) ─────────────────────────────────────────────
// A small always-on readout in the corner. Its job is to turn "it feels slow"
// into numbers we can act on, and to answer the single most important question
// about a slow WebGL page: is the browser actually using the GPU?
//
// If UNMASKED_RENDERER reads something like "SwiftShader" or "Software", Chrome
// has fallen back to CPU rasterisation and NOTHING in the scene will run well no
// matter how it's optimised — that's a browser/driver problem, not a scene one.
// A real answer looks like "Apple M-series" or "AMD/Intel …".
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
    });
    document.body.appendChild(el);

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
