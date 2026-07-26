import { chromium } from 'playwright-core';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const p = await b.newPage({ viewport: { width: 900, height: 500 } });
const problems = [];
p.on('console', m => { if (m.type()==='error'||m.type()==='warning') problems.push(`[${m.type()}] ${m.text()}`); });
p.on('pageerror', e => problems.push(`[pageerror] ${e.message}`));
const tier = process.argv[2] ?? 'high';
await p.goto('http://localhost:5180/probe.html?q=' + tier, { waitUntil: 'domcontentloaded', timeout: 60000 });
try { await p.waitForFunction(() => window.__probe, null, { timeout: 120000 }); }
catch { console.log('PROBE NEVER FINISHED'); }
const r = await p.evaluate(() => window.__probe ?? null);
console.log(JSON.stringify(r, null, 2));
await p.screenshot({ path: '/home/user/Aloft/crossing/tools/probe/probe-' + tier + '.png' });
console.log('--- console ---');
for (const x of problems.slice(0, 6)) console.log(x.slice(0, 4000));
await b.close();
