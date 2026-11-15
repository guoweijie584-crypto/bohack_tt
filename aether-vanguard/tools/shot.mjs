// 用本机 Chrome 无头打开页面，按顺序执行步骤并截图，同时收集控制台错误。
// 用法：node tools/shot.mjs <url> <out.png> [waitMs] [w] [h] [步骤...]
// 步骤：--eval "<js 表达式>"   --wait <ms>   --shot <file.png>   --key <按键>   --mouse x,y   --down   --up
// 末尾会再截一张 <out.png>。
import { chromium } from 'playwright-core';

const [, , url = 'http://localhost:5173/', out = '/tmp/shot.png', waitMs = '2500', w = '1280', h = '800', ...rest] = process.argv;

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
const seen = new Set();
page.on('console', m => {
  if (!['error', 'warning'].includes(m.type())) return;
  const t = `[${m.type()}] ${m.text()}`;
  if (seen.has(t)) return;
  seen.add(t);
  logs.push(t);
});
page.on('pageerror', e => {
  const t = `[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`;
  if (seen.has(t)) return;
  seen.add(t);
  logs.push(t);
});
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(+waitMs);
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  try {
    if (a === '--eval') {
      const r = await page.evaluate(rest[++i]);
      if (r !== undefined) console.log('eval>', typeof r === 'string' ? r : JSON.stringify(r));
      await page.waitForTimeout(300);
    } else if (a === '--wait') {
      await page.waitForTimeout(+rest[++i]);
    } else if (a === '--shot') {
      await page.screenshot({ path: rest[++i] });
    } else if (a === '--key') {
      await page.keyboard.press(rest[++i]);
    } else if (a === '--mouse') {
      const [mx, my] = rest[++i].split(',').map(Number);
      await page.mouse.move(mx, my);
    } else if (a === '--down') {
      await page.mouse.down();
    } else if (a === '--up') {
      await page.mouse.up();
    }
  } catch (e) { logs.push(`[step-error] ${a}: ${e.message}`); }
}
await page.screenshot({ path: out });
console.log(logs.length ? logs.join('\n') : 'no console errors');
await browser.close();
