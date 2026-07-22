// Regenerates asset/intro_painting.jpeg by sending a screenshot of the starting
// scene to Google's "Nano Banana" image model and asking it to repaint the
// scene in a Caravaggio (Baroque chiaroscuro) style. The painting-intro
// (src/render/paintingIntro.js) then shows this image first and dissolves it
// into the live 3D render.
//
// MODEL: defaults to Nano Banana Pro (Gemini 3 Pro Image = "gemini-3-pro-image").
// Override with GEMINI_IMAGE_MODEL, e.g. the original Nano Banana:
//     GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
//
// ⚠️  BILLING: image generation is NOT available on the Gemini free tier — it
// returns HTTP 429 (this is why the intro was blank before). You need an API
// key on a project with billing enabled. Enable it at
// https://aistudio.google.com  →  Get API key  →  (project) billing, or in the
// Google Cloud console. Nano Banana Pro is the pricier of the two models.
//
// Usage:
//   1. Put your key in a .env file at the project root (already gitignored):
//          GEMINI_API_KEY=AIza...
//      (or:  export GEMINI_API_KEY=...)
//   2. npm run dev            (in another terminal — the scene must be live)
//   3. node tools/generate-intro-painting.mjs
//
// Or skip the live capture and stylize an existing screenshot instead:
//   node tools/generate-intro-painting.mjs path/to/screenshot.png
//
// The prompt asks the model to KEEP THE COMPOSITION IDENTICAL — that matters,
// because the painting-intro transition merges the painting into the real
// render per-pixel; if the painted objects sit in different screen positions
// than the real ones, the dot-soak reveal won't line up.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// public/asset is vite's publicDir — the ONLY asset folder copied into the
// build/deploy. (The top-level asset/ is served by the dev server too, which is
// why dev-only placement silently breaks the deployed site.)
const OUTPUT_PATH  = resolve(PROJECT_ROOT, 'public/asset/intro_painting.png');
// The dev server serves under vite's base path (see vite.config).
const DEV_URL      = process.env.SCENE_URL ?? 'http://localhost:5173/unstil-life-yegi-park/';
const MODEL        = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image';

const PROMPT = `Repaint this exact scene as a Caravaggio-style Baroque oil painting.
Dramatic chiaroscuro / tenebrism: a single strong light raking in from the upper
left, the objects emerging from deep near-black shadow, luminous highlights, rich
earthy palette (warm umber, ochre, deep crimson, aged gold, soft flesh tones).
Photorealistic Baroque realism with subtle oil glazes, in the spirit of
Caravaggio's still lifes. IMPORTANT: keep the composition, framing, and the exact
position and size of every object — round wooden table, ceramic vase with orange
tulips, a rough natural stone/gem, wooden artist mannequin, and teddy bear —
identical to the input image. Change only the artistic style, lighting mood and
palette, never the layout. No text, no signature, no border.`;

// ── 1. Get the input screenshot ───────────────────────────────────────────────
// Either a path passed on the command line, or a live capture of the dev
// server via Playwright (optional dependency — install with `npm i -D playwright`).
async function getScreenshot() {
    const argPath = process.argv[2];
    if (argPath) {
        console.log(`Using provided screenshot: ${argPath}`);
        return readFile(argPath);
    }

    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch {
        console.error(
            'No screenshot path given and Playwright is not installed.\n' +
            'Either:  node tools/generate-intro-painting.mjs <screenshot.png>\n' +
            'Or:      npm i -D playwright   (enables automatic capture from the dev server)'
        );
        process.exit(1);
    }

    console.log(`Capturing starting scene from ${DEV_URL} ...`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(DEV_URL, { waitUntil: 'load', timeout: 60000 });
    // Wait out the loading screen (and any intro) so we capture the real scene
    // at p=0. Generous fixed wait — simpler than instrumenting the app.
    await page.waitForTimeout(30000);
    await page.evaluate(() => {
        document.querySelectorAll('.lil-gui').forEach(el => el.style.display = 'none');
    });
    await page.waitForTimeout(300);
    const buf = await page.screenshot({ type: 'png' });
    await browser.close();
    return buf;
}

// ── 2. Send to Nano Banana ────────────────────────────────────────────────────
// The key is read from the GEMINI_API_KEY environment variable, or from a
// `.env` file at the project root containing a line like:
//     GEMINI_API_KEY=AIzaSy...
// `.env` is in .gitignore, so the key can live inside the project folder
// without ever being committed to the public GitHub repo.
async function getApiKey() {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    try {
        const env = await readFile(resolve(PROJECT_ROOT, '.env'), 'utf8');
        const match = env.match(/^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
        if (match) return match[1];
    } catch { /* no .env file — fall through to the error below */ }
    return null;
}

async function stylize(imageBuffer) {
    const apiKey = await getApiKey();
    if (!apiKey) {
        console.error(
            'No API key found. Either:\n' +
            '  export GEMINI_API_KEY=your-key       (shell profile), or\n' +
            '  create a .env file at the project root containing:\n' +
            '      GEMINI_API_KEY=your-key\n' +
            'Get a key at https://aistudio.google.com'
        );
        process.exit(1);
    }

    console.log(`Sending to ${MODEL} ...`);
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { inline_data: { mime_type: 'image/png', data: imageBuffer.toString('base64') } },
                        { text: PROMPT },
                    ],
                }],
            }),
        }
    );

    if (!res.ok) {
        const body = await res.text();
        if (res.status === 429) {
            console.error(
                `\n❌  Quota error (429) from ${MODEL}.\n` +
                'Image generation does NOT work on the Gemini free tier. Enable billing on\n' +
                "the API key's Google Cloud project (https://aistudio.google.com → Get API key\n" +
                '→ set up billing), then re-run. This is almost certainly why the intro was\n' +
                'blank before.\n\n' + body
            );
        } else if (res.status === 404) {
            console.error(
                `\n❌  Model "${MODEL}" not found (404). The model id may have changed, or the\n` +
                'legacy generateContent endpoint may not serve it. Try the original Nano Banana:\n' +
                '    GEMINI_IMAGE_MODEL=gemini-2.5-flash-image node tools/generate-intro-painting.mjs\n\n' + body
            );
        } else {
            console.error(`API error ${res.status}: ${body}`);
        }
        process.exit(1);
    }

    const json = await res.json();
    // Response parts use camelCase (inlineData); find the image part.
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find(p => p.inlineData?.data ?? p.inline_data?.data);
    if (!imagePart) {
        console.error('No image in response (the model may have refused or returned only text).\nFull response:\n' + JSON.stringify(json, null, 2));
        process.exit(1);
    }
    const data = imagePart.inlineData?.data ?? imagePart.inline_data?.data;
    return Buffer.from(data, 'base64');
}

// ── 3. Save ───────────────────────────────────────────────────────────────────
const screenshot = await getScreenshot();
const painting   = await stylize(screenshot);
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, painting);
console.log(`Saved ${painting.length} bytes → ${OUTPUT_PATH}`);
console.log('Reload the app to see the new Caravaggio intro painting dissolve into the scene.');
