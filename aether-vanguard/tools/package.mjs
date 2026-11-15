// 打包发布：在 `npm run build` 产出的 dist/ 基础上生成
//   release/AetherVanguard-offline.html  单文件离线版（JS、CSS、图片、字体全部内嵌，双击即玩，无需服务器）
//   release/AetherVanguard-offline.zip   单文件版 + 素材许可 + 说明
//   release/AetherVanguard-web.zip       网页版（dist 目录，上传到任意静态托管即可）
// 用法：npm run package（= npm run build && node tools/package.mjs）
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const REL = join(ROOT, 'release');
const NAME = 'AetherVanguard';

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('找不到 dist/index.html，请先运行 npm run build（或直接 npm run package）');
  process.exit(1);
}
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** 递归列出目录下的文件 */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 单文件版
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const jsTag = html.match(/<script type="module" crossorigin src="(\.\/assets\/[^"]+\.js)"><\/script>/);
const cssTag = html.match(/<link rel="stylesheet" crossorigin href="(\.\/assets\/[^"]+\.css)">/);
if (!jsTag) { console.error('dist/index.html 里没找到入口脚本'); process.exit(1); }
const js = readFileSync(join(DIST, jsTag[1]), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = cssTag ? readFileSync(join(DIST, cssTag[1]), 'utf8') : '';

// 运行时用到的素材：图片、字体、0x72 帧表（无扩展名）。许可证/说明文档不内嵌。
const MIME = { '.png': 'image/png', '.woff2': 'font/woff2', '': 'text/plain' };
const assets = {};
let rawBytes = 0;
for (const f of walk(join(DIST, 'assets'))) {
  const rel = relative(DIST, f).split(sep).join('/');
  const ext = extname(f).toLowerCase();
  const isTileList = basename(f) === 'tile_list_v1.7';
  if (!(ext === '.png' || ext === '.woff2' || isTileList)) continue;
  if (/Preview\.png$/.test(f)) continue; // 素材包自带的预览图，游戏不用
  const buf = readFileSync(f);
  rawBytes += buf.length;
  assets[rel] = `data:${MIME[isTileList ? '' : ext]};base64,${buf.toString('base64')}`;
}
const assetScript = `<script>window.__AV_ASSETS=${JSON.stringify(assets).replace(/<\//g, '<\\/')};</script>`;

let single = html
  .replace(jsTag[0], () => `${assetScript}\n<script type="module">\n${js}\n</script>`)
  .replace(/<title>[^<]*<\/title>/, `<title>源能斗士 · AETHER VANGUARD（离线版 v${version}）</title>`);
single = cssTag ? single.replace(cssTag[0], () => `<style>\n${css}\n</style>`) : single;

rmSync(REL, { recursive: true, force: true });
mkdirSync(REL, { recursive: true });
const singlePath = join(REL, `${NAME}-offline.html`);
writeFileSync(singlePath, single);

// ---------------------------------------------------------------- 说明与许可
const CONTROLS = `操作
  WASD / 方向键      移动
  鼠标               瞄准；按住左键攻击；左键点地上的装备拾取
  右键               奥义
  Q / E / R          职业技能
  空格               冲刺
  F                  与 NPC / 传送阵 / 补给泉 / 祭坛交互，拾取装备，开宝箱
  1 / 2              生命药 / 源能药
  Tab B K M J P H    角色 / 背包 / 技能 / 地图 / 日志 / 转职 / 帮助
  T                  自动攻击开关
  Esc                关闭面板 / 暂停
手机、平板会自动出现虚拟摇杆和技能按钮。`;

const LICENSE_NOTE = `素材许可（详见 LICENSES/ 目录）
  美术：0x72「16x16 DungeonTileset II」与 Pixel-boy & AAA「Ninja Adventure」，均为 CC0（可自由使用、修改、商用）
  字体：TakWolf「缝合像素字体 Fusion Pixel Font」，SIL Open Font License 1.1
  程序：Phaser 4（MIT）`;

const offlineReadme = `源能斗士 AETHER VANGUARD · 单文件离线版 v${version}
==================================================

直接双击 ${NAME}.html，用 Chrome / Edge / Firefox / Safari（较新版本）打开即可游玩。
不需要联网，不需要安装任何东西。需要浏览器支持 WebGL（近几年的电脑浏览器都支持）。

存档保存在浏览器本地：用同一台电脑、同一个浏览器打开会读到同一份存档（4 个角色槽位）。
换浏览器或清理浏览器数据会丢失存档。

${CONTROLS}

${LICENSE_NOTE}
`;

const webReadme = `源能斗士 AETHER VANGUARD · 网页版 v${version}
==============================================

部署：把 ${NAME} 文件夹整个上传到任意静态网站托管即可，入口是 index.html。
  例如 GitHub Pages、Gitee Pages、Netlify、Vercel、学校/公司的 Nginx 服务器。
  所有路径都是相对路径，放在子目录下也能用。

本地预览：在 ${NAME} 文件夹里运行
  python3 -m http.server 8000
然后浏览器打开 http://localhost:8000/

注意：网页版必须通过 http(s) 访问。直接双击 index.html 会被浏览器的安全策略拦下（黑屏）。
想在本地双击就玩，请用单文件离线版 ${NAME}-offline.html。

${CONTROLS}

${LICENSE_NOTE}
`;

function writeLicenses(dir) {
  const L = join(dir, 'LICENSES');
  mkdirSync(L, { recursive: true });
  const src = (p) => join(DIST, 'assets', p);
  if (existsSync(src('CREDITS.md'))) cpSync(src('CREDITS.md'), join(L, 'CREDITS.md'));
  if (existsSync(src('na/LICENSE.txt'))) cpSync(src('na/LICENSE.txt'), join(L, 'NinjaAdventure-CC0.txt'));
  if (existsSync(src('fonts/OFL.txt'))) cpSync(src('fonts/OFL.txt'), join(L, 'FusionPixelFont-OFL.txt'));
  writeFileSync(join(L, '0x72-DungeonTilesetII-CC0.txt'),
    '16x16 DungeonTileset II v1.7 by 0x72 — https://0x72.itch.io/dungeontileset-ii\n'
    + 'License: CC0 1.0 Universal (public domain dedication). "You can use this tileset for whatever you like (CC-0). Credit is not necessary."\n');
}

function zipDir(dir, zipPath) {
  // -X 去掉 macOS 扩展属性，-r 递归；文件名均为 ASCII，Windows 解压不会乱码
  execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: dir });
}

// 离线版 zip
const offDir = join(REL, '_offline');
mkdirSync(offDir, { recursive: true });
cpSync(singlePath, join(offDir, `${NAME}.html`));
writeFileSync(join(offDir, 'README.txt'), offlineReadme);
writeLicenses(offDir);
zipDir(offDir, join(REL, `${NAME}-offline.zip`));

// 网页版 zip（内含 AetherVanguard/ 文件夹）
const webRoot = join(REL, '_web');
const webDir = join(webRoot, NAME);
mkdirSync(webDir, { recursive: true });
cpSync(DIST, webDir, { recursive: true });
writeFileSync(join(webRoot, 'README.txt'), webReadme);
writeLicenses(webRoot);
zipDir(webRoot, join(REL, `${NAME}-web.zip`));

rmSync(offDir, { recursive: true, force: true });
rmSync(webRoot, { recursive: true, force: true });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2) + ' MB';
console.log(`内嵌素材 ${Object.keys(assets).length} 个（原始 ${(rawBytes / 1024).toFixed(0)} KB）`);
console.log(`release/${NAME}-offline.html  ${mb(singlePath)}`);
console.log(`release/${NAME}-offline.zip   ${mb(join(REL, `${NAME}-offline.zip`))}`);
console.log(`release/${NAME}-web.zip       ${mb(join(REL, `${NAME}-web.zip`))}`);
