/**
 * Visual verification harness.
 *
 * Drives a real browser against the dev server, flies the game from the
 * console hooks, and writes screenshots at a set of times of day. This is the
 * only honest way to iterate on a look — reading a shader and imagining the
 * output is how you ship a brown screen.
 *
 *   node tools/shoot.mjs [outDir] [--url=http://localhost:5180] [--seed=20873]
 *
 * Also reports every console error and page exception, which catches the
 * WebGL shader-compile failures that TypeScript cannot.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const outDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'shots');
const url = (args.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:5180').slice(6);
const seed = Number((args.find((a) => a.startsWith('--seed=')) ?? '--seed=20873').slice(7));
const wide = args.includes('--wide');
const tier = (args.find((a) => a.startsWith('--quality=')) ?? '--quality=high').slice(10);
/**
 * The harness runs on a software rasteriser, so the adaptive quality monitor
 * would honestly drop the tier to 'low' within seconds and every reference
 * frame would be of a game nobody actually plays. Pin the tier instead.
 */
const pageUrl = `${url}${url.includes('?') ? '&' : '?'}quality=${tier}&noadapt=1`;

/** The moments worth looking at. Each is a different art-direction problem. */
const MOMENTS = [
  { t: 0.055, name: '01-first-light', note: 'cold, misty, ridge lift only' },
  { t: 0.085, name: '02-sunrise', note: 'the sun on the horizon' },
  { t: 0.2, name: '03-morning', note: 'first thermals, cumulus popping' },
  { t: 0.45, name: '04-noon', note: 'high cloudbase, hard light' },
  { t: 0.63, name: '05-afternoon', note: 'cloud streets — the best air' },
  { t: 0.78, name: '06-golden', note: 'golden hour, backlit cumulus' },
  { t: 0.84, name: '07-sunset', note: 'the sun going down' },
  { t: 0.9, name: '08-blue-hour', note: 'thermals dead, wave only' },
  { t: 0.95, name: '09-night', note: 'stars, aurora, the wave' },
];

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
});

const page = await browser.newPage({
  viewport: wide ? { width: 1920, height: 900 } : { width: 1600, height: 900 },
  deviceScaleFactor: 1,
});

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

console.log(`→ ${pageUrl}`);
await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the game to expose its hooks and finish booting.
try {
  await page.waitForFunction(() => !!window.__aloft, null, { timeout: 90000 });
} catch {
  console.error('!! the game never booted. Problems so far:');
  for (const p of problems) console.error('   ' + p);
  await page.screenshot({ path: resolve(outDir, '00-failed-boot.png') });
  await browser.close();
  process.exit(1);
}

await page.evaluate((s) => window.__aloft.setSeed(s), seed);
await page.waitForTimeout(2500);
await page.screenshot({ path: resolve(outDir, '00-title.png') });
console.log('  · title');

await page.evaluate(() => window.__aloft.start('crossing'));
// Let the launch sweep finish and the world stream in.
await page.waitForTimeout(6000);

for (const m of MOMENTS) {
  await page.evaluate((t) => window.__aloft.setTime(t), m.t);
  // Give the streamers a moment to catch up with the new light, and let the
  // bird actually move so the frame isn't a static pose.
  await page.waitForTimeout(2200);
  await page.screenshot({ path: resolve(outDir, `${m.name}.png`) });
  const st = await page.evaluate(() => {
    const s = window.__aloft.state();
    return {
      alt: Math.round(s.position.y),
      agl: Math.round(s.agl),
      ias: +s.airspeed.toFixed(1),
      climb: +s.climbRate.toFixed(2),
      kind: s.airKind,
      fps: Math.round(window.__aloft.fps()),
      thermals: window.__aloft.wind.thermals().length,
      waves: window.__aloft.wind.waves().length,
    };
  });
  console.log(
    `  · ${m.name.padEnd(18)} alt ${String(st.alt).padStart(5)}m  agl ${String(st.agl).padStart(5)}m  ` +
      `ias ${String(st.ias).padStart(5)}  vz ${String(st.climb).padStart(6)}  air ${st.kind}  ` +
      `${st.fps} fps  (th ${st.thermals} / wv ${st.waves})  — ${m.note}`,
  );
}

writeFileSync(
  resolve(outDir, 'problems.txt'),
  problems.length ? problems.join('\n') : 'no console errors or warnings',
);
console.log(problems.length ? `\n!! ${problems.length} console problem(s) — see problems.txt` : '\n✓ clean console');
for (const p of problems.slice(0, 25)) console.log('   ' + p);

await browser.close();
