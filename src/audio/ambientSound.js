// ─── Ambient sound ────────────────────────────────────────────────────────────
// Two looping tracks and a one-shot, sharing one Web Audio graph:
//  - room track:  café ambience, gain = volume × (1 − p), fading out toward space
//  - space track: fades in over a few seconds once space is reached (volume 0 by default)
//  - dissolve:    a recording that plays in step with the dissolve: it pauses,
//                 resumes and jumps with it (see follow())
//
// Browsers play no sound until a click, tap or key press (Chrome ignores
// scrolling), so the audio unlock retries on every gesture until it succeeds.

const SOUND_NONE = 'None';

export const ROOM_SOUND_OPTIONS     = ['Café ambience', SOUND_NONE];
export const SPACE_SOUND_OPTIONS    = ['Space ambience', SOUND_NONE];
export const DISSOLVE_SOUND_OPTIONS = [
    'Slowly Whoosh', 'Slowly Whoosh Short', 'Sparkle', 'Sparkle Slowed', 'Star Sparkle', SOUND_NONE,
];

// .m4a (AAC) for fast loading; the larger mp3/wav originals stay in asset/sound/.
const ROOM_SOUND_URLS     = { 'Café ambience':  'asset/sound/cafe-music.m4a' };
const SPACE_SOUND_URLS    = { 'Space ambience': 'asset/sound/space-ambient.m4a' };
// Dissolve sounds. The sparkles were stretched to the dissolve's full 5.2 s;
// the whoosh only 1.5x (3.13 s), since a longer stretch sounded artificial.
const DISSOLVE_SOUND_URLS = {
    'Slowly Whoosh':       'asset/sound/whoosh-1_5x.m4a',     // 1.5x stretch: 3.13 s, covers ~60% of the dissolve
    'Slowly Whoosh Short': 'asset/sound/slowly-whoosh.mp3',   // the 2.1 s original, ends well before the particles do
    'Sparkle':             'asset/sound/sparkle-5s-tail.m4a',
    'Sparkle Slowed':      'asset/sound/sparkle-5s-full.m4a',
    'Star Sparkle':        'asset/sound/star-sparkle.m4a',
};

// The shared audio context and the gesture unlock. Every track gets this object.
function createSoundSystem() {
    let ctx     = null;
    let started = false;
    const pendingStarts = []; // queued track-start callbacks, run once unlocked

    // The AudioContext, created on first use.
    function context() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        return ctx;
    }

    async function unlock() {
        if (started) return;
        try { await context().resume(); } catch { /* not an accepted activation yet */ }
        if (ctx.state !== 'running') return; // keep listeners armed, retry on next gesture
        started = true;
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('wheel', unlock);
        pendingStarts.forEach(fn => fn());
        pendingStarts.length = 0;
    }

    // Runs fn now if the context is already unlocked, otherwise queues it for
    // the first accepted gesture.
    function whenStarted(fn) {
        if (started) fn();
        else pendingStarts.push(fn);
    }
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('wheel', unlock);

    return { context, unlock, whenStarted, isStarted: () => started };
}

// A looping track. urlMap: label → file; defaultLabel: what plays first;
// gainOf(p, t): its volume curve. It streams through an <audio> element, so it
// starts as soon as enough has buffered instead of after the whole file is
// downloaded and decoded. Routed into the Web Audio graph for the volume curve.
function createTrack(audio, { urlMap, defaultLabel, gainOf, defaultVolume = 0.5 }) {
    let gainNode = null;
    let el        = null; // current <audio> element
    let mediaNode = null; // its MediaElementAudioSourceNode
    let desiredUrl = urlMap[defaultLabel];

    // Each load gets a number, so an older load finishing late can't start
    // playing over a newer one.
    let loadGeneration = 0;

    const volume = { value: defaultVolume }; // object so lil-gui can bind a slider to .value directly

    function stopCurrent() {
        if (el) { el.pause(); el.removeAttribute('src'); el.load(); el = null; }
        if (mediaNode) { mediaNode.disconnect(); mediaNode = null; }
    }

    function load(url) {
        const ctx = audio.context();
        if (!gainNode) {
            gainNode = ctx.createGain();
            gainNode.gain.value = 0; // update() takes over from the next frame
            gainNode.connect(ctx.destination);
        }
        loadGeneration++; // invalidate any earlier pending play
        const generation = loadGeneration;
        stopCurrent();

        const element = new Audio();
        // preload must be set BEFORE src, or buffering only starts at the first
        // click and the sound comes in late.
        element.preload = 'auto';
        element.loop    = true;
        element.src     = url;
        element.load();
        element.addEventListener('error', () => {
            if (generation === loadGeneration) {
                console.warn(`Ambient sound: couldn't load "${url}" — staying silent.`);
            }
        });
        el = element;
        // A MediaElementSource can only be created once per element, which is
        // why each load builds a fresh one.
        mediaNode = ctx.createMediaElementSource(element);
        mediaNode.connect(gainNode);

        // play() fails before the first click, so it waits for whenStarted.
        // Buffering continues meanwhile.
        audio.whenStarted(() => {
            if (generation !== loadGeneration) return; // superseded by a newer load
            element.play().catch(() => { /* still not permitted; next gesture retries */ });
        });
    }

    // Start buffering at creation, on the still-suspended context. gain stays
    // 0 until update() ramps it, so nothing is audible before the gesture.
    if (desiredUrl) load(desiredUrl);

    // GUI dropdown: switch to a named preset, or silence.
    function setSound(label) {
        if (label === SOUND_NONE) {
            desiredUrl = null;
            loadGeneration++; // cancel any in-flight load
            stopCurrent();
            return;
        }
        desiredUrl = urlMap[label] ?? desiredUrl;
        load(desiredUrl); // safe pre-gesture: buffers now, plays via whenStarted
    }

    // GUI "Custom audio…": plays a user's file (mp3/wav/ogg/m4a). The URL is
    // kept, not revoked: the <audio> element keeps reading from it.
    function setCustomFile(file) {
        const url = URL.createObjectURL(file);
        desiredUrl = url;
        load(url);
        // Picking a file was a click, so the audio can unlock now.
        audio.unlock();
    }

    // Every frame: sets the volume from the scroll progress (and time, for the
    // space track's fade-in). setTargetAtTime smooths it, so fast scrolling
    // doesn't crackle.
    function update(p, t) {
        if (!gainNode) return;
        const target = volume.value * gainOf(p, t);
        gainNode.gain.setTargetAtTime(target, audio.context().currentTime, 0.1);
    }

    return { setSound, setCustomFile, update, volume };
}

// The dissolve sound: decoded once, at load (decoding works before the audio
// is unlocked), so it's ready when Dissolve is pressed. Its playback position
// is tied to the dissolve (see follow()).
function createOneShot(audio, { urlMap, defaultLabel }) {
    let buffer     = null;
    let desiredUrl = urlMap[defaultLabel];
    let loadGeneration = 0;
    const volume = { value: 0.8 };

    async function load(url) {
        const generation = ++loadGeneration;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const decoded = await audio.context().decodeAudioData(await res.arrayBuffer());
            if (generation !== loadGeneration) return; // superseded
            buffer = decoded;
        } catch (err) {
            if (generation === loadGeneration) {
                console.warn(`Dissolve sound: couldn't load "${url}" — staying silent.`, err);
            }
        }
    }

    if (desiredUrl) load(desiredUrl); // preload the default immediately

    function setSound(label) {
        if (label === SOUND_NONE) { desiredUrl = null; loadGeneration++; buffer = null; return; }
        desiredUrl = urlMap[label] ?? desiredUrl;
        load(desiredUrl);
    }
    function setCustomFile(file) {
        const url = URL.createObjectURL(file);
        desiredUrl = url;
        load(url).then(() => URL.revokeObjectURL(url));
    }
    // The sound currently playing, if any.
    let current = null;
    let lastSeekCount = 0;
    // True once the recording has played to its end, so it isn't restarted
    // (on a slow machine the dissolve's clock can lag behind the audio).
    let finished = false;

    // Plays from `offset` seconds into the recording. Web Audio sources can't
    // pause or jump, so every start makes a new one. A 20 ms fade-in avoids a click.
    function startAt(offset) {
        const ctx = audio.context();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const g = ctx.createGain();
        const now = ctx.currentTime;
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(volume.value, now + 0.02);
        src.connect(g);
        g.connect(ctx.destination);
        src.start(now, offset);
        current = { src, gain: g };
        // Only a natural end counts as finished; stopCurrent() clears `current` first.
        src.onended = () => {
            if (current?.src === src) { current = null; finished = true; }
            g.disconnect();
        };
    }

    // Stops with a 40 ms fade-out, so it doesn't click.
    function stopCurrent() {
        if (!current) return;
        const { src, gain } = current;
        const now = audio.context().currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.04);
        src.stop(now + 0.05);
        current = null;
    }

    // Called every frame with the dissolve's state (getDissolvePlayback):
    // starts when it plays, stops when it's paused or over, continues from the
    // right point on resume, and jumps when the scrub bar is used.
    function follow({ playing, time, seekCount }) {
        const jumped = seekCount !== lastSeekCount;
        lastSeekCount = seekCount;
        if (!buffer || !audio.isStarted()) return;
        if (!playing) { stopCurrent(); finished = false; return; }
        if (jumped) { stopCurrent(); finished = false; }
        // Past the end of the recording: nothing left to play.
        if (time >= buffer.duration - 0.05) { stopCurrent(); return; }
        if (!current && !finished) startAt(time);
    }

    return { setSound, setCustomFile, follow, volume };
}

// Space track: delay after reaching space, then fade-in time, in seconds. The
// café is already silent by then (its gain is 1 − p).
const SPACE_START_DELAY = 0.0;
const SPACE_FADE_IN     = 2.5;

export function createAmbientSoundTracks() {
    const system = createSoundSystem();

    // Space track gain is time-based: silent until p reaches 1, then fades in.
    // Leaving space resets it for the next arrival.
    let spaceArrivalT = null;
    const spaceGainOf = (p, t) => {
        if (p < 0.999) { spaceArrivalT = null; return 0; }
        if (spaceArrivalT === null) spaceArrivalT = t;
        const since = t - spaceArrivalT - SPACE_START_DELAY;
        return Math.min(1, Math.max(0, since / SPACE_FADE_IN));
    };

    const room     = createTrack(system, {
        urlMap: ROOM_SOUND_URLS, defaultLabel: 'Café ambience', gainOf: (p) => 1 - p,
    });
    // Volume 0 by default (silence in space is deliberate). It still loads, so
    // raising the slider brings it in without reloading.
    const space    = createTrack(system, {
        urlMap: SPACE_SOUND_URLS, defaultLabel: 'Space ambience', gainOf: spaceGainOf, defaultVolume: 0,
    });
    const dissolve = createOneShot(system, { urlMap: DISSOLVE_SOUND_URLS, defaultLabel: 'Slowly Whoosh' });
    return {
        room, space, dissolve,
        // Runs once audio is actually playing; the top hint (ui/topHint.js) uses it to
        // stop asking for a click.
        onStarted: system.whenStarted,
        // dissolvePlayback: from phaseMachine.getDissolvePlayback().
        update(p, t, dissolvePlayback) {
            room.update(p, t);
            space.update(p, t);
            if (dissolvePlayback) dissolve.follow(dissolvePlayback);
        },
    };
}
