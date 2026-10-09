// ─── Building blocks the GUI folders share ───────────────────────────────────
// Each pattern is written once here and reused by the folder files.

// A button whose label says what the next click does. Returns the toggle, so
// another control can press it too.
export function addToggleButton(folder, { isOn, toggle, labelWhenOn, labelWhenOff }) {
    const label = () => (isOn() ? labelWhenOn : labelWhenOff);
    const action = {
        toggle: () => {
            toggle();
            controller.name(label());
        },
    };
    const controller = folder.add(action, 'toggle').name(label());
    return action.toggle;
}

// A colour picker for a THREE.Color uniform. lil-gui edits a hex string, so a
// small proxy holds it and writes it back into the uniform.
export function addUniformColor(folder, uniform, name) {
    const proxy = { color: '#' + uniform.value.getHexString() };
    return folder.addColor(proxy, 'color').name(name)
        .onChange((hex) => uniform.value.set(hex));
}

// A hidden file input, opened from a GUI button or dropdown entry. Returns the
// function that opens it. onPick gets the chosen file, or for a folder every
// file in it. The input is reset afterwards, so picking the same file again
// still works.
export function createFilePicker({ accept, folder = false, onPick }) {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    if (folder) input.webkitdirectory = true; // pick a folder, get all files inside
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
        const files = input.files;
        if (files && files.length) onPick(folder ? files : files[0]);
        input.value = '';
    });
    return () => input.click();
}

// A button that opens a file picker.
export function addFileButton(folder, name, { accept, onPick }) {
    const open = createFilePicker({ accept, onPick });
    return folder.add({ pick: open }, 'pick').name(name);
}

// A centred dialog with a dimmed backdrop and up to two buttons, used instead
// of alert() for the custom-skybox instructions. Buttons close it and run their
// callback.
export function showModal({ title, bodyHTML, confirmLabel, onConfirm, cancelLabel = 'Cancel' }) {
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
        position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.55)',
        zIndex: '10000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
        background: '#f7f4ef', color: '#2a2622', width: 'min(90vw, 460px)',
        maxHeight: '85vh', overflowY: 'auto', borderRadius: '10px',
        padding: '26px 28px', boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
        font: "15px/1.55 'Cormorant Garamond', Garamond, Georgia, serif",
    });
    box.innerHTML = `
        <h2 style="margin:0 0 12px;font-size:22px;font-weight:600;letter-spacing:0.3px;">${title}</h2>
        <div style="font-size:15px;">${bodyHTML}</div>`;

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' });
    const mkBtn = (label, primary) => {
        const b = document.createElement('button');
        b.textContent = label;
        Object.assign(b.style, {
            padding: '9px 18px', borderRadius: '6px', cursor: 'pointer',
            border: primary ? 'none' : '1px solid #bdb4a6',
            background: primary ? '#3d2f22' : 'transparent',
            color: primary ? '#f7f4ef' : '#5a5145',
            font: "600 14px 'Cormorant Garamond', Garamond, serif", letterSpacing: '0.4px',
        });
        return b;
    };
    const close = () => backdrop.remove();
    if (cancelLabel) { const c = mkBtn(cancelLabel, false); c.onclick = close; row.appendChild(c); }
    if (confirmLabel) {
        const ok = mkBtn(confirmLabel, true);
        ok.onclick = () => { close(); onConfirm?.(); };
        row.appendChild(ok);
    }
    box.appendChild(row);
    backdrop.appendChild(box);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.body.appendChild(backdrop);
}
