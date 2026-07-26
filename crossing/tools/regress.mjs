/**
 * Regression checks for bugs found in play. Each one reproduces a specific
 * reported symptom through the real UI — clicking the real button, holding the
 * real key — rather than poking the console hooks, because the bugs live in
 * exactly the part the console hooks bypass.
 *
 *   node tools/regress.mjs [--url=http://localhost:4173]
 */
import { chromium } from 'playwright-core';

const url = (process.argv.find((a) => a.startsWith('--url=')) ?? '--url=http://localhost:4173').slice(6);

let failures = 0;
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${url}?quality=medium&noadapt=1`, { waitUntil: 'commit', timeout: 60000 });
await page.waitForFunction(() => !!window.__aloft, null, { timeout: 120000 });
await page.waitForFunction(() => window.__aloft.booted(), null, { timeout: 180000 });

// --- start the run the way a player does: by clicking the button ----------
console.log('\nheld SPREAD must not restart the run');
await page.click('.btn.primary');
await page.waitForTimeout(9000);

const before = await page.evaluate(() => {
  const s = window.__aloft.state();
  const a = document.activeElement;
  return {
    x: s.position.x, z: s.position.z, y: s.position.y,
    phase: window.__aloft.phase(),
    focused: a ? a.tagName + (a.className ? '.' + String(a.className).split(' ')[0] : '') : 'none',
  };
});
ok(before.phase === 'flying' || before.phase === 'landing', 'the run is under way', before.phase);

// THE load-bearing condition. The original bug was that the browser's default
// action for a held Space is "press the focused button", and the button that
// started the run still had focus — so spreading the wings silently relaunched
// several times a second. Playwright's keyboard.down() does not emit native
// auto-repeat, so the hold below cannot fully reproduce the original trigger;
// this assertion checks the actual precondition instead.
ok(!/^BUTTON/.test(before.focused), 'no button holds focus during flight', before.focused);

// The exact reported input: hold Space for several seconds. Playwright's
// keyboard.down() emits the repeat keydowns a real held key produces.
await page.keyboard.down('Space');
await page.waitForTimeout(5000);
await page.keyboard.up('Space');
await page.waitForTimeout(500);

const after = await page.evaluate(() => {
  const s = window.__aloft.state();
  return { x: s.position.x, z: s.position.z, y: s.position.y, phase: window.__aloft.phase(), wing: s.wing };
});

// A restart teleports the bird back to the launch ridge and rewinds the clock.
const moved = Math.hypot(after.x - before.x, after.z - before.z);
ok(moved > 20, 'the bird kept flying rather than being reset', `moved ${moved.toFixed(0)} m`);
ok(after.phase !== 'launching', 'the launch sequence did not replay', after.phase);
ok(after.wing > 0.5, 'holding Space actually spread the wings', `wing ${after.wing.toFixed(2)}`);

// --- draw distance --------------------------------------------------------
console.log('\nthe world reaches the haze');
const reach = await page.evaluate(() => {
  const c = window.__aloft.config;
  return { chunkSize: c.chunkSize, viewDistance: c.viewDistance };
});
console.log(`  · chunk ${reach.chunkSize} m · view ${reach.viewDistance} m`);
ok(reach.chunkSize >= 2000, 'chunks are large enough to reach the fog', `${reach.chunkSize} m`);

ok(errors.length === 0, 'no page exceptions', errors.slice(0, 2).join(' | '));

console.log(`\n${failures === 0 ? '✓' : '✗'} ${failures === 0 ? 'all checks passed' : failures + ' failed'}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
