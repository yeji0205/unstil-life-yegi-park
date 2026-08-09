// ─── Ambient sound ────────────────────────────────────────────────────────────
// Two independent looping tracks sharing one Web Audio graph:
//  - room track:  café ambience, gain = volume × (1 − p) — full in the room, fades out into space
//  - space track: space ambience, gain = volume × p       — silent in the room, fades in as it dissolves
// Each is a separate "track" (own gain node, own file, own volume) created
// from one shared AudioContext/gesture-unlock system, so adding more layers
// later doesn't mean spinning up a whole new audio graph per layer.
//
// Browser constraint that shapes this whole module: autoplay policy. An
// AudioContext refuses to produce sound until the page receives a user
// gesture — and Chrome specifically does NOT count wheel/scroll as one, only
// clicks/taps/keys. Since this app is scroll-driven, a naive "unlock on first
// interaction" would permanently fail for scroll-only viewers, so onGesture
// retries on every gesture until ctx.resume() actually reports 'running'.

export const SOUND_NONE         = 'None';
export const SOUND_CUSTOM_LABEL = 'Custom audio…';

export const ROOM_SOUND_OPTIONS     = ['Café ambience', SOUND_NONE, SOUND_CUSTOM_LABEL];
export const SPACE_SOUND_OPTIONS    = ['Space ambience', SOUND_NONE, SOUND_CUSTOM_LABEL];
export const DISSOLVE_SOUND_OPTIONS = ['Slowly Whoosh', 'Spooky Air', SOUND_NONE, SOUND_CUSTOM_LABEL];

// AAC (.m4a) rather than the original mp3/wav: the café loop was a 9.0 MB mp3
// and the space bed a 5.5 MB wav, and the room ambience simply couldn't start
// until enough of that had arrived. Re-encoded at 64 kbps they're 3.3 MB and
// 169 KB — same audio, a fraction of the wait. The originals are still in
// asset/sound/ if a higher-quality master is ever needed.
const ROOM_SOUND_URLS     = { 'Café ambience':  'asset/sound/cafe.m4a' };
const SPACE_SOUND_URLS    = { 'Space ambience': 'asset/sound/space-ambient.m4a' };
const DISSOLVE_SOUND_URLS = { 'Slowly Whoosh': 'asset/sound/slowly-whoosh.mp3', 'Spooky Air': 'asset/sound/spooky-air.wav' };

// One shared AudioContext + gesture-unlock, reused by every track created
// from it via .createTrack().
function createSoundSystem() {
    let ctx     = null;
    let started = false;
    const pendingStarts = []; // queued track-start callbacks, run once unlocked

    function ensureContext() {
        if (ctx) return;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
    }

    async function onGesture() {
        if (started) return;
        ensureContext();
        try { await ctx.resume(); } catch { /* not an accepted activation yet */ }
        if (ctx.state !== 'running') return; // keep listeners armed, retry on next gesture
        started = true;
        window.removeEventListener('pointerdown', onGesture);
        window.removeEventListener('keydown', onGesture);
        window.removeEventListener('wheel', onGesture);
        pendingStarts.forEach(fn => fn());
        pendingStarts.length = 0;
    }

    // Runs fn now if the context is already unlocked, otherwise queues it for
    // the first accepted gesture.
    function whenStarted(fn) {
        if (started) fn();
        else pendingStarts.push(fn);
    }
    window.addEventListener('pointerdown', onGesture);
    window.addEventListener('keydown', onGesture);
    window.addEventListener('wheel', onGesture);

    // urlMap: preset label -> asset URL. defaultLabel: which preset plays
    // initially. gainOf(p): this track's own volume curve across scroll progress.
    // Looping ambience STREAMS through an <audio> element rather than being
    // fetched and decoded up front.
    //
    // The old path was fetch(whole file) → decodeAudioData(whole file) →
    // start(), so nothing could be heard until every byte had arrived AND been
    // decoded to PCM. For the 9 MB café loop that's a long wait twice over: the
    // download, plus decoding ~9 minutes of audio into a few hundred MB of raw
    // samples. That's why the room ambience came in seconds late.
    //
    // An <audio> element begins playing as soon as it has buffered enough to
    // start, and keeps fetching in the background — so the room sound now starts
    // essentially immediately. Routing it through createMediaElementSource keeps
    // it inside the same gain graph, so the p-driven crossfade and the volume
    // sliders behave exactly as before. Trade-off: element looping isn't
    // sample-accurate like an AudioBufferSourceNode, but these tracks are minutes
    // long and broadband, so a loop seam is a non-issue in practice.
    function createTrack({ urlMap, defaultLabel, gainOf }) {
        let gainNode = null;
        let el        = null; // current <audio> element
        let mediaNode = null; // its MediaElementAudioSourceNode
        let desiredUrl = urlMap[defaultLabel];

        // Guards against async races: if the user switches sounds while an
        // older fetch/decode is still in flight, the stale result must not
        // start playing over the newer one. Each load bumps the generation;
        // only the newest wins.
        let loadGeneration = 0;

        const volume = { value: 0.5 }; // object so lil-gui can bind a slider to .value directly

        function stopCurrent() {
            if (el) { el.pause(); el.removeAttribute('src'); el.load(); el = null; }
            if (mediaNode) { mediaNode.disconnect(); mediaNode = null; }
        }

        function load(url) {
            ensureContext();
            if (!gainNode) {
                gainNode = ctx.createGain();
                gainNode.gain.value = 0; // update() takes over from the next frame
                gainNode.connect(ctx.destination);
            }
            loadGeneration++; // invalidate any earlier pending play
            const generation = loadGeneration;
            stopCurrent();

            const audio = new Audio();
            audio.src     = url;
            audio.loop    = true;
            audio.preload = 'auto';
            audio.addEventListener('error', () => {
                if (generation === loadGeneration) {
                    console.warn(`Ambient sound: couldn't load "${url}" — staying silent.`);
                }
            });
            el = audio;
            // A MediaElementSource can only be created once per element, which is
            // why each load builds a fresh one.
            mediaNode = ctx.createMediaElementSource(audio);
            mediaNode.connect(gainNode);

            // play() is rejected until the page has an accepted user gesture, so
            // defer it to whenStarted rather than letting it throw. Buffering
            // still proceeds in the meantime (preload='auto'), so by the time the
            // gesture lands the track is ready to sound instantly.
            whenStarted(() => {
                if (generation !== loadGeneration) return; // superseded by a newer load
                audio.play().catch(() => { /* still not permitted; next gesture retries */ });
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

        // GUI "Custom audio…": play a user-picked local file (any format the
        // browser can decode — mp3/wav/ogg/m4a). Object URL is revoked after
        // decode; the decoded buffer lives in memory independently of it.
        function setCustomFile(file) {
            // The object URL is NOT revoked here: unlike a decoded buffer, the
            // streaming element reads from it for as long as it plays.
            const url = URL.createObjectURL(file);
            desiredUrl = url;
            load(url);
            // Picking a file involved clicks (a real activation), so resuming
            // should succeed here even if the viewer never clicked the canvas.
            onGesture();
        }

        // Called once per frame with the smoothed scroll progress and the
        // elapsed clock time (t) — t lets a track schedule time-based fades
        // (e.g. the space track's delayed entry) instead of pure p curves.
        // setTargetAtTime smooths steps so rapid scroll doesn't zipper.
        function update(p, t) {
            if (!gainNode || !ctx) return;
            const target = volume.value * gainOf(p, t);
            gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.1);
        }

        return { setSound, setCustomFile, update, volume };
    }

    // A one-shot sound (e.g. the dissolve whoosh): decoded once and kept ready,
    // then played from the start each time play() is called — no looping, no
    // per-frame gain curve. The buffer is preloaded EAGERLY (not deferred to
    // the first gesture like the looping tracks) because the dissolve happens
    // exactly once per session: if the buffer weren't already decoded when the
    // user clicks Dissolve, the sound would simply never be heard. decodeAudioData
    // works on a suspended context, so eager decode is safe before any gesture;
    // only playback needs the context running, which it is by dissolve time.
    function createOneShot({ urlMap, defaultLabel }) {
        let buffer     = null;
        let desiredUrl = urlMap[defaultLabel];
        let loadGeneration = 0;
        const volume = { value: 0.8 };

        async function load(url) {
            ensureContext();
            const generation = ++loadGeneration;
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
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
        // Fires the sound from the beginning. Each call spins up a fresh
        // BufferSource (sources are single-use in Web Audio) through its own
        // gain node so the volume slider applies at trigger time.
        function play() {
            if (!buffer || !ctx) return;
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            const g = ctx.createGain();
            g.gain.value = volume.value;
            src.connect(g);
            g.connect(ctx.destination);
            src.start();
        }

        return { setSound, setCustomFile, play, volume };
    }

    return { createTrack, createOneShot };
}

// Seconds to wait after fully entering space (p reaches ~1) before the space
// music begins, then how long it takes to fade in. The delay stops the space
// track and the café track from overlapping: café fades out with (1−p) and is
// silent by p=1, then a beat of quiet, then space fades in on its own.
const SPACE_START_DELAY = 5.0;
const SPACE_FADE_IN     = 3.0;

export function createAmbientSoundTracks() {
    const system = createSoundSystem();

    // Space track gain is time-based, not a pure p curve: it stays silent
    // until p is fully at 1, records the arrival time, waits SPACE_START_DELAY,
    // then ramps in over SPACE_FADE_IN. Scrolling back out of space (p < ~1)
    // resets the timer so it re-arms cleanly on the next entry.
    let spaceArrivalT = null;
    const spaceGainOf = (p, t) => {
        if (p < 0.999) { spaceArrivalT = null; return 0; }
        if (spaceArrivalT === null) spaceArrivalT = t;
        const since = t - spaceArrivalT - SPACE_START_DELAY;
        return Math.min(1, Math.max(0, since / SPACE_FADE_IN));
    };

    const room     = system.createTrack({ urlMap: ROOM_SOUND_URLS,  defaultLabel: 'Café ambience',  gainOf: (p) => 1 - p });
    const space    = system.createTrack({ urlMap: SPACE_SOUND_URLS, defaultLabel: 'Space ambience', gainOf: spaceGainOf });
    const dissolve = system.createOneShot({ urlMap: DISSOLVE_SOUND_URLS, defaultLabel: 'Slowly Whoosh' });
    return {
        room, space, dissolve,
        update(p, t) { room.update(p, t); space.update(p, t); },
    };
}
