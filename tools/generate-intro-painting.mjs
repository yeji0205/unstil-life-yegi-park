// Regenerates asset/intro_painting.jpeg by sending a screenshot of the
// starting scene to Google's Nano Banana image model (gemini-2.5-flash-image).
//
// Usage:
//   1. Get an API key at https://aistudio.google.com (free tier works).
//   2. export GEMINI_API_KEY=your-key-here
//   3. npm run dev            (in another terminal — the scene must be live)
//   4. node tools/generate-intro-painting.mjs
//
// Or skip the live capture and stylize an existing screenshot instead:
//   node tools/generate-intro-painting.mjs path/to/screenshot.png
//
// The prompt asks the model to KEEP THE COMPOSITION IDENTICAL — that matters,
// because the painting-intro transition (src/render/paintingIntro.js) merges
// the painting into the real render per-pixel; if the painted objects sit in
// different screen positions than the real ones, the dot-soak reveal won't
// line up.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH  = resolve(PROJECT_ROOT, 'asset/intro_painting.jpeg');
const DEV_URL      = process.env.SCENE_URL ?? 'http://localhost:5173';
const MODEL        = 'gemini-2.5-flash-image';

const PROMPT = `Repaint this exact scene as an oil painting in the style of
Vincent van Gogh: thick impasto brushstrokes, swirling expressive linework in
the background, rich blues, purples and warm golds. IMPORTANT: keep the
composition, framing, and the position and size of every object (round wooden
table, vase with orange tulips, drinking glass, wooden artist mannequin, teddy
bear) exactly the same as in the input image — only change the artistic style,
not the layout. No text, no signature, no border.`;

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
    // Wait out the loading screen + painting intro so we capture the real
    // scene at p=0. Generous fixed wait — simpler than instrumenting the app.
    await page.waitForTimeout(45000);
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
        console.error(`API error ${res.status}: ${await res.text()}`);
        process.exit(1);
    }

    const json = await res.json();
    // Response parts use camelCase (inlineData); find the image part.
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find(p => p.inlineData?.data ?? p.inline_data?.data);
    if (!imagePart) {
        console.error('No image in response. Full response:\n' + JSON.stringify(json, null, 2));
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
console.log('Reload the app to see the new intro painting.');
