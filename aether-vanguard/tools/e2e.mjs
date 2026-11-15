// 端到端冒烟：标题 → 建角 → 主城 → 面板 → 迷宫战斗 → 首领层 → 竞技场。每步截图并收集控制台错误与帧率。
// 用法：先 npm run dev，再 node tools/e2e.mjs [输出目录] [职业中文名]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/aether-e2e';
const CLASS = process.argv[3] ?? '火焰魔法师';
const URL = process.env.URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(`[pageerror] ${e.message} :: ${(e.stack ?? '').split('\n')[1] ?? ''}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

let n = 0;
const shot = async name => { await page.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}_${name}.png` }); };
const evalLog = async (label, js) => { const r = await page.evaluate(js); console.log(label, typeof r === 'string' ? r : JSON.stringify(r)); return r; };
const fps = () => page.evaluate('Math.round(window.__game.loop.actualFps)');

await page.goto(URL);
await page.waitForTimeout(4500);
await shot('title');

// 建角
await page.getByText('新建角色').first().click();
await page.waitForTimeout(500);
await page.getByPlaceholder('为你的斗士命名').fill('测试斗士');
await page.getByText(CLASS, { exact: true }).first().click();
await page.waitForTimeout(300);
await shot('create');
await page.getByText('开始征程').click();
await page.waitForTimeout(2500);
await shot('city');
await evalLog('city:', '({scene: __G.scene, cid: __G.player?.cid, lv: __G.player?.lv, npcs: __G.npcs.length, portals: __G.portals.length})');

// 面板
for (const [key, name] of [['b', 'bag'], ['k', 'skill'], ['c', 'char'], ['m', 'map']]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
  await shot(`panel_${name}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

// 迷宫第 1 层：在玩家附近刷怪，鼠标朝右按住攻击并移动
await page.evaluate("window.__dev.enterDungeon('ruins', 1)");
await page.waitForTimeout(1200);
await page.evaluate(`(() => { const p = __G.player; for (const k of ['goblin','slime','bat','skeleton','masked_orc','orc_shaman']) window.__dev.spawnEnemy(k, p.x + 110 + Math.random() * 90, p.y - 70 + Math.random() * 140, { aggro: true }); })()`);
await page.mouse.move(1000, 430);
await page.mouse.down();
await page.waitForTimeout(700);
await shot('combat_1');
await page.keyboard.press('q');
await page.waitForTimeout(500);
await page.keyboard.press('e');
await page.waitForTimeout(600);
await shot('combat_2');
await page.keyboard.down('d');
await page.waitForTimeout(900);
await page.keyboard.up('d');
await page.keyboard.press('r');
await page.waitForTimeout(900);
await shot('combat_3');
await page.mouse.up();
console.log('fps(combat):', await fps());
await evalLog('after combat:', '({hp: Math.round(__G.player.hp), maxHp: __G.player.stat.maxHp, kills: __G.player.kills, exp: __G.player.exp, lv: __G.player.lv, enemies: __G.enemies.length, drops: __G.drops.length, mode: __G.mode})');
await page.waitForTimeout(1500);
await shot('combat_loot');

// 首领层
await page.evaluate("window.__dev.enterDungeon('ruins', 3)");
await page.waitForTimeout(800);
await page.evaluate(`(() => { const b = __G.boss; const p = __G.player; if (b) { p.x = b.x - 160; p.y = b.y + 40; p.invuln = 99; } })()`);
await page.waitForTimeout(2200);
await shot('boss');
await evalLog('boss:', '({boss: __G.boss?.def?.n, hp: Math.round(__G.boss?.hp ?? 0), phase: __G.boss?.phase})');
console.log('fps(boss):', await fps());

// 其它副本主题
for (const id of ['magma', 'frost', 'crypt']) {
  await page.evaluate(`window.__dev.enterDungeon('${id}', 1)`);
  await page.waitForTimeout(1300);
  await shot(`theme_${id}`);
}

// 竞技场
await page.evaluate('window.__dev.enterArena()');
await page.waitForTimeout(2200);
await shot('arena');

console.log('errors:', errors.length ? '\n' + [...new Set(errors)].slice(0, 30).join('\n') : 'none');
await browser.close();
