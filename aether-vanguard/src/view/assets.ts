// 素材加载与运行时加工：
// - 0x72 DungeonTileset II（CC0）：按 tile_list 注册帧与动画；
// - 2.5D 墙块合成（墙顶上移一格 + 南向砖面，按 N/E/S/W 邻接 16 种 × 立面变体）；
// - 12 职业换色皮肤（同一模板换色，符合改版文档“融合职业换色复用”）；
// - 程序化特效贴图（影子、光斑、像素粒子、刀光、法球、火把火焰、传送门…）。

import * as Phaser from 'phaser';
import { preloadNA, registerNA } from './assets_na';
import { buildProcAssets } from './assets_proc';
import { registerIcon, registerSheet, registerSkin } from '../ui/bridge';
import { assetCssUrl, assetUrl } from '../core/assetUrl';

/** 每个美术像素 = 2 世界单位（16px 美术瓦片 = 32 世界单位） */
export const ART = 2;
export const DT = 'dt';
const DT_URL = 'assets/0x72/0x72_DungeonTilesetII_v1.7.png';

export function preloadAssets(scene: Phaser.Scene): void {
  scene.load.image(DT, assetUrl(DT_URL));
  scene.load.text('dt_list', assetUrl('assets/0x72/tile_list_v1.7'));
  preloadNA(scene);
}

export function registerAssets(scene: Phaser.Scene): void {
  registerDtFrames(scene);
  buildAnimations(scene);
  buildWallTiles(scene);
  buildFloorTiles(scene);
  buildSkins(scene);
  buildFxTextures(scene);
  buildDigitFont(scene);
  registerNA(scene);
  buildProcAssets(scene);
  exportToUi(scene);
}

/* ------------------------------------------------------------------ */
/* 导出给 DOM UI：图集帧坐标、程序化图标 dataURL、职业/NPC 立绘 dataURL   */
/* ------------------------------------------------------------------ */
function canvasOf(scene: Phaser.Scene, key: string): HTMLCanvasElement | null {
  if (!scene.textures.exists(key)) return null;
  const src = scene.textures.get(key).getSourceImage();
  return src instanceof HTMLCanvasElement ? src : null;
}

function exportToUi(scene: Phaser.Scene): void {
  registerSheet(assetCssUrl(DT_URL), dtFrames.entries());
  const iconKeys = scene.textures.getTextureKeys().filter(k => /^(armor_|trinket_|mat_|expgem|shield_)/.test(k));
  for (const k of iconKeys) {
    const c = canvasOf(scene, k);
    if (c) registerIcon(k, c.toDataURL());
  }
  for (const id of [...Object.keys(SKINS), ...PLAIN_HEROES]) {
    const c = canvasOf(scene, skinKey(id));
    if (!c) continue;
    const fw = c.width / SKIN_FRAMES.length;
    const out = document.createElement('canvas');
    out.width = fw;
    out.height = c.height;
    out.getContext('2d')!.drawImage(c, 0, 0, fw, c.height, 0, 0, fw, c.height);
    registerSkin(id, out.toDataURL());
  }
}

/* ------------------------------------------------------------------ */
/* 伤害数字像素字体（5×7 字形 + 1px 深色描边，RetroFont）                 */
/* ------------------------------------------------------------------ */
const GLYPHS: Record<string, string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '%': ['##..#', '##.#.', '...#.', '..#..', '.#...', '.#.##', '#..##'],
  x: ['.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};
export const DIGIT_FONT = 'font_dmg';

function buildDigitFont(scene: Phaser.Scene): void {
  if (scene.cache.bitmapFont.exists(DIGIT_FONT)) return;
  const chars = Object.keys(GLYPHS).join('');
  const cw = 7, ch = 9;
  const t = scene.textures.createCanvas(DIGIT_FONT, cw * chars.length, ch)!;
  const c = t.getContext();
  [...chars].forEach((k, i) => {
    const g = GLYPHS[k];
    const ox = i * cw + 1, oy = 1;
    // 描边：字形像素向 8 邻域扩一圈深色
    c.fillStyle = '#1a0f0a';
    g.forEach((row, y) => [...row].forEach((p, x) => {
      if (p !== '#') return;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) c.fillRect(ox + x + dx, oy + y + dy, 1, 1);
    }));
    c.fillStyle = '#ffffff';
    g.forEach((row, y) => [...row].forEach((p, x) => { if (p === '#') c.fillRect(ox + x, oy + y, 1, 1); }));
  });
  t.refresh();
  // 注意：Phaser 4 的 RetroFont.Parse 直接返回缓存条目 {data, texture, frame}，不要再包一层
  const entry = Phaser.GameObjects.RetroFont.Parse(scene, {
    image: DIGIT_FONT, width: cw, height: ch, chars, charsPerRow: chars.length,
    'offset.x': 0, 'offset.y': 0, 'spacing.x': 0, 'spacing.y': 0, lineSpacing: 0,
  });
  scene.cache.bitmapFont.add(DIGIT_FONT, entry);
}

/* ------------------------------------------------------------------ */
/* 0x72 帧注册                                                          */
/* ------------------------------------------------------------------ */
const dtFrames = new Map<string, { x: number; y: number; w: number; h: number }>();

function registerDtFrames(scene: Phaser.Scene): void {
  const tex = scene.textures.get(DT);
  const list = scene.cache.text.get('dt_list') as string;
  for (const line of list.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const [rawName, xs, ys, ws, hs] = p;
    // 0x72 v1.7 帧表笔误：zombie 的第 0 帧写成了 zombie_anim_f10
    const name = rawName === 'zombie_anim_f10' ? 'zombie_anim_f0' : rawName;
    const f = { x: +xs, y: +ys, w: +ws, h: +hs };
    dtFrames.set(name, f);
    if (!tex.has(name)) tex.add(name, 0, f.x, f.y, f.w, f.h);
  }
}

export function hasDtFrame(name: string): boolean { return dtFrames.has(name); }
export function dtFrame(name: string): { x: number; y: number; w: number; h: number } | undefined { return dtFrames.get(name); }

/* ------------------------------------------------------------------ */
/* 动画：xxx_anim_f0..fN → 动画 key xxx                                  */
/* ------------------------------------------------------------------ */
function buildAnimations(scene: Phaser.Scene): void {
  const groups = new Map<string, string[]>();
  for (const name of dtFrames.keys()) {
    const m = /^(.*)_anim_f(\d+)$/.exec(name);
    if (!m) continue;
    const arr = groups.get(m[1]) ?? [];
    arr[+m[2]] = name;
    groups.set(m[1], arr);
  }
  for (const [key, frames] of groups) {
    if (scene.anims.exists(key)) continue;
    const once = /open|hit/.test(key);
    // 改版文档：idle 8fps、walk 10fps
    const rate = /run/.test(key) ? 10 : /spikes/.test(key) ? 5 : /coin/.test(key) ? 10 : 8;
    scene.anims.create({
      key,
      frames: frames.filter(Boolean).map(frame => ({ key: DT, frame })),
      frameRate: rate,
      repeat: once ? 0 : -1,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 画布工具                                                             */
/* ------------------------------------------------------------------ */
function srcImage(scene: Phaser.Scene): CanvasImageSource {
  return scene.textures.get(DT).getSourceImage() as CanvasImageSource;
}
function blit(ctx: CanvasRenderingContext2D, img: CanvasImageSource, name: string, dx: number, dy: number, sx0 = 0, sy0 = 0, sw?: number, sh?: number): void {
  const f = dtFrames.get(name);
  if (!f) return;
  const w = sw ?? f.w, h = sh ?? f.h;
  ctx.drawImage(img, f.x + sx0, f.y + sy0, w, h, dx, dy, w, h);
}

/* ------------------------------------------------------------------ */
/* 2.5D 墙块：每个“贴地”实心格合成一张 16×32 贴图                        */
/* 上半 = 墙顶（画在上一格位置），下半 = 南向砖面（南邻是地面时）            */
/* mask bit：1=N 可走 2=E 可走 4=S 可走 8=W 可走                          */
/* ------------------------------------------------------------------ */
export const WALL_FACES = ['wall_mid', 'wall_mid', 'wall_mid', 'wall_mid', 'wall_hole_1', 'wall_hole_2', 'wall_banner_red', 'wall_banner_blue', 'wall_banner_green', 'wall_banner_yellow', 'wall_goo'] as const;
export const WALL_TOP = '#1d1621';

function buildWallTiles(scene: Phaser.Scene): void {
  if (scene.textures.exists('walls')) return;
  const img = srcImage(scene);
  const variants = WALL_FACES.length;
  // 列：16 种 mask；行：立面变体（对 S 可走的 mask 有意义）
  const tex = scene.textures.createCanvas('walls', 16 * 16, 32 * variants)!;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  const edgeL = dtFrames.get('wall_edge_mid_left');
  const edgeR = dtFrames.get('wall_edge_mid_right');
  for (let v = 0; v < variants; v++) {
    for (let mask = 0; mask < 16; mask++) {
      const ox = mask * 16, oy = v * 32;
      const n = mask & 1, e = mask & 2, s = mask & 4, w = mask & 8;
      // 墙顶：深色实心
      ctx.fillStyle = WALL_TOP;
      ctx.fillRect(ox, oy, 16, 16);
      // 西/东侧边线（取 edge_mid 的竖线）
      if (w && edgeL) ctx.drawImage(img, edgeL.x, edgeL.y, 4, 16, ox, oy, 4, 16);
      if (e && edgeR) ctx.drawImage(img, edgeR.x + 12, edgeR.y, 4, 16, ox + 12, oy, 4, 16);
      // 北侧边线：用 wall_top_mid 的石沿（顶部 4px）
      if (n) {
        const f = dtFrames.get('wall_top_mid')!;
        ctx.drawImage(img, f.x, f.y + 12, 16, 4, ox, oy, 16, 4);
      }
      if (s) {
        // 墙顶靠南的石沿 + 砖面
        const top = w && e ? 'wall_top_mid' : w ? 'wall_top_left' : e ? 'wall_top_right' : 'wall_top_mid';
        blit(ctx, img, top, ox, oy);
        const face = v === 0 ? (w ? 'wall_left' : e ? 'wall_right' : 'wall_mid') : WALL_FACES[v];
        blit(ctx, img, face, ox, oy + 16);
      }
      tex.add(`w${mask}_${v}`, 0, ox, oy, 16, 32);
    }
  }
  tex.refresh();
}

/* ------------------------------------------------------------------ */
/* 地砖：floor_1..8 + 主城石板/草地/水面（程序化，取 0x72 色调）              */
/* ------------------------------------------------------------------ */
function buildFloorTiles(scene: Phaser.Scene): void {
  if (scene.textures.exists('floors')) return;
  const img = srcImage(scene);
  // 0..7 地牢地砖；8 虚空；9 城石板；10 草地；11 水；12 熔岩；13 遗迹地面；14 出口；15 石板路；16 桥；
  // 17..21 NA 草地变体；22..26 NA 沙土路变体；27 水面第二帧（波纹动画）
  const n = 28;
  const tex = scene.textures.createCanvas('floors', 16 * n, 16)!;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  for (let i = 0; i < 8; i++) blit(ctx, img, `floor_${i + 1}`, i * 16, 0);
  const px = (x: number, y: number, c: string): void => { ctx.fillStyle = c; ctx.fillRect(x, y, 1, 1); };
  const fill = (i: number, c: string): void => { ctx.fillStyle = c; ctx.fillRect(i * 16, 0, 16, 16); };
  fill(8, '#0d0a0f');
  // 城石板：暖色石砖 + 缝
  fill(9, '#8c7356');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const ox = 9 * 16;
    if (y === 7 || y === 15 || (x === ((y < 8) ? 7 : 15))) px(ox + x, y, '#6b563f');
    else if ((x * 7 + y * 13) % 11 === 0) px(ox + x, y, '#9a8061');
  }
  // 草地
  fill(10, '#4f7a3a');
  for (let k = 0; k < 22; k++) { const x = (k * 7) % 16, y = (k * 11) % 16; px(10 * 16 + x, y, k % 3 ? '#5f8c44' : '#3f6630'); }
  // 水
  fill(11, '#2f5f7a');
  for (let x = 0; x < 16; x++) { px(11 * 16 + x, 4 + (x % 4 === 0 ? 1 : 0), '#4f87a3'); px(11 * 16 + x, 11 + (x % 5 === 0 ? 1 : 0), '#3f7591'); }
  // 水面第二帧：波纹错位
  fill(27, '#2f5f7a');
  for (let x = 0; x < 16; x++) { px(27 * 16 + x, 6 + (x % 4 === 2 ? 1 : 0), '#4f87a3'); px(27 * 16 + x, 13 + (x % 5 === 2 ? 1 : 0), '#3f7591'); }
  // 熔岩
  fill(12, '#a8381e');
  for (let k = 0; k < 18; k++) { const x = (k * 5) % 16, y = (k * 9) % 16; px(12 * 16 + x, y, k % 2 ? '#f08a3a' : '#ffcf5a'); }
  // 遗迹地面：地牢地砖叠裂纹
  blit(ctx, img, 'floor_3', 13 * 16, 0);
  for (let k = 0; k < 6; k++) px(13 * 16 + 3 + k * 2, 5 + (k % 3), '#3a2a22');
  // 出口：地牢阶梯
  blit(ctx, img, 'floor_stairs', 14 * 16, 0);
  // 石板路
  fill(15, '#a08463');
  for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x++) if ((x + (y >> 2) * 3) % 6 === 0) px(15 * 16 + x, y, '#7d6549');
  // 桥：木板
  fill(16, '#7a5534');
  for (let y = 0; y < 16; y += 3) for (let x = 0; x < 16; x++) px(16 * 16 + x, y, '#5a3d24');
  // NA 地砖（CC0）：草地第 12 行、沙土第 5 行，各 5 种变体
  if (scene.textures.exists('na_floor')) {
    const na = scene.textures.get('na_floor').getSourceImage() as CanvasImageSource;
    for (let i = 0; i < 5; i++) {
      ctx.drawImage(na, i * 16, 12 * 16, 16, 16, (17 + i) * 16, 0, 16, 16);
      ctx.drawImage(na, i * 16, 5 * 16, 16, 16, (22 + i) * 16, 0, 16, 16);
    }
  }
  // 城石板：重画成错缝圆石（比纯色砖更有质感）
  {
    const ox = 9 * 16;
    ctx.fillStyle = '#8f7a5e';
    ctx.fillRect(ox, 0, 16, 16);
    const stones = [[0, 0, 7, 5], [8, 0, 8, 5], [0, 6, 4, 5], [5, 6, 7, 5], [13, 6, 3, 5], [0, 12, 9, 4], [10, 12, 6, 4]];
    for (const [sx, sy, sw, sh] of stones) {
      ctx.fillStyle = (sx + sy) % 3 === 0 ? '#a48c6c' : (sx + sy) % 3 === 1 ? '#9a8364' : '#ae9676';
      ctx.fillRect(ox + sx, sy, sw - 1, sh - 1);
      ctx.fillStyle = '#bba27f';
      ctx.fillRect(ox + sx, sy, sw - 1, 1);
      ctx.fillStyle = '#6f5d45';
      ctx.fillRect(ox + sx, sy + sh - 1, sw, 1);
      ctx.fillRect(ox + sx + sw - 1, sy, 1, sh);
    }
  }
  for (let i = 0; i < n; i++) tex.add(`f${i}`, 0, i * 16, 0, 16, 16);
  tex.refresh();
}

/* ------------------------------------------------------------------ */
/* 职业皮肤：基于 0x72 英雄模板换色                                      */
/* ------------------------------------------------------------------ */
interface HueShift {
  from: [number, number]; to: number; sat?: number; light?: number;
  /** 只改饱和度 ≥ minSat 的像素（默认 0.18） */
  minSat?: number;
  /** 只改亮度在 [minL, maxL] 内的像素（用来避开皮肤/高光） */
  minL?: number; maxL?: number;
  yMax?: number; yMin?: number;
}
export interface SkinSpec { base: string; shifts: HueShift[] }

/**
 * 改版文档 §4.1 职业主色（底图色相实测：knight 盔甲 175/200、羽饰 8/30 或 339/350；wizzard 法袍 206/241；
 * elf 衣服 117/140、头发 45/30、皮肤 26(l0.81)；lizard 皮肤 117 或 165；dwarf 胡子兜帽 8(红)/45(黄)、皮肤 26/20）
 */
export const SKINS: Record<string, SkinSpec> = {
  // 战士：铁灰 + 暗红羽饰
  warrior: { base: 'knight_m', shifts: [{ from: [165, 215], to: 212, sat: 0.16, light: 0.95 }, { from: [0, 40], to: 356, sat: 1.0, light: 0.82 }] },
  // 火焰魔法师：橙红法袍 + 暗紫内衬
  pyro: { base: 'wizzard_m', shifts: [{ from: [195, 225], to: 12, sat: 1.25, light: 1.0 }, { from: [226, 260], to: 288, sat: 0.9, light: 0.72 }] },
  // 游侠：橄榄绿 + 皮革棕
  ranger: { base: 'elf_m', shifts: [{ from: [105, 125], to: 74, sat: 0.85, light: 0.9 }, { from: [126, 150], to: 32, sat: 0.6, light: 0.85 }] },
  // 冰霜魔法师：冰青 + 银白
  cryo: { base: 'wizzard_f', shifts: [{ from: [195, 225], to: 186, sat: 1.15, light: 1.02 }, { from: [226, 260], to: 205, sat: 0.55, light: 1.2 }] },
  // 雷电魔法师：紫 + 亮黄（皮肤不动）
  storm: { base: 'wizzard_m', shifts: [{ from: [195, 225], to: 272, sat: 0.95, light: 0.85 }, { from: [226, 260], to: 50, sat: 1.4, light: 1.25 }] },
  // 刺客：近黑紫衣 + 暗发（避开皮肤 l>0.76）
  assassin: { base: 'elf_f', shifts: [{ from: [100, 150], to: 282, sat: 0.5, light: 0.5 }, { from: [25, 60], to: 290, sat: 0.45, light: 0.42, minSat: 0.5, maxL: 0.76 }, { from: [0, 15], to: 300, sat: 0.9, light: 0.7 }] },
  // 骑士：铁灰绿甲 + 金色羽饰
  knight: { base: 'knight_f', shifts: [{ from: [165, 215], to: 150, sat: 0.28, light: 0.92 }, { from: [330, 360], to: 45, sat: 1.15, light: 1.0 }] },
  // 甲士：铁灰紫（胡子/兜帽）+ 暗红（避开皮肤 s<0.6）
  armored: { base: 'dwarf_m', shifts: [{ from: [0, 14], to: 266, sat: 0.32, light: 0.78, minSat: 0.6 }, { from: [15, 24], to: 352, sat: 0.95, light: 0.7, minSat: 0.6 }] },
  // 元素法师：冰青帽 + 橙红袍（双主色）
  elemage: { base: 'wizzard_f', shifts: [{ from: [195, 260], to: 186, sat: 1.1, light: 1.0, yMax: 11 }, { from: [195, 260], to: 14, sat: 1.2, light: 1.0, yMin: 11 }] },
  // 忍者：深蓝紫 + 红
  ninja: { base: 'lizard_f', shifts: [{ from: [150, 185], to: 236, sat: 0.62, light: 0.6 }, { from: [330, 360], to: 356, sat: 1.25, light: 1.05 }] },
  // 风暴刺客：紫黑 + 亮黄电弧（光环粒子）
  stormblade: { base: 'lizard_m', shifts: [{ from: [100, 150], to: 274, sat: 0.62, light: 0.58 }] },
  // 风暴守卫：铁灰紫甲 + 亮黄羽饰
  stormguard: { base: 'knight_m', shifts: [{ from: [165, 215], to: 262, sat: 0.42, light: 0.86 }, { from: [0, 40], to: 52, sat: 1.25, light: 1.22 }] },
};
/** 非职业角色直接用原皮（NPC/镜像等） */
export const SKIN_FRAMES = ['idle_0', 'idle_1', 'idle_2', 'idle_3', 'run_0', 'run_1', 'run_2', 'run_3', 'hit_0'] as const;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

/** 皮肤贴图 key：skin_<id>，帧 idle_0..3 / run_0..3 / hit_0；动画 <key>_idle / _run / _hit */
export function skinKey(id: string): string { return `skin_${id}`; }

function makeSkin(scene: Phaser.Scene, id: string, spec: SkinSpec | null, base: string): void {
  const key = skinKey(id);
  if (scene.textures.exists(key)) return;
  const img = srcImage(scene);
  const f0 = dtFrames.get(`${base}_idle_anim_f0`);
  if (!f0) return;
  const fw = f0.w, fh = f0.h;
  const tex = scene.textures.createCanvas(key, fw * SKIN_FRAMES.length, fh)!;
  const ctx = tex.getContext();
  ctx.imageSmoothingEnabled = false;
  SKIN_FRAMES.forEach((fr, i) => {
    const [kind, idx] = fr.split('_');
    const src = `${base}_${kind}_anim_f${idx}`;
    blit(ctx, img, dtFrames.has(src) ? src : `${base}_idle_anim_f0`, i * fw, 0);
  });
  if (spec) {
    const data = ctx.getImageData(0, 0, tex.width, fh);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const y = Math.floor(i / 4 / tex.width);
      const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      for (const sh of spec.shifts) {
        if (sh.yMax !== undefined && y >= sh.yMax) continue;
        if (sh.yMin !== undefined && y < sh.yMin) continue;
        if (s < (sh.minSat ?? 0.18) || l < 0.08 || l > 0.96) continue;
        if ((sh.minL !== undefined && l < sh.minL) || (sh.maxL !== undefined && l > sh.maxL)) continue;
        const inBand = sh.from[0] <= sh.from[1] ? h >= sh.from[0] && h <= sh.from[1] : h >= sh.from[0] || h <= sh.from[1];
        if (!inBand) continue;
        const [r, g, b] = hslToRgb(sh.to, Math.min(1, s * (sh.sat ?? 1)), Math.min(0.97, l * (sh.light ?? 1)));
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
        break;
      }
    }
    ctx.putImageData(data, 0, 0);
  }
  SKIN_FRAMES.forEach((fr, i) => tex.add(fr, 0, i * fw, 0, fw, fh));
  tex.refresh();
  const mk = (suffix: string, frames: string[], rate: number, repeat: number): void => {
    const k = `${key}_${suffix}`;
    if (!scene.anims.exists(k)) scene.anims.create({ key: k, frames: frames.map(frame => ({ key, frame })), frameRate: rate, repeat });
  };
  mk('idle', ['idle_0', 'idle_1', 'idle_2', 'idle_3'], 8, -1);
  mk('run', ['run_0', 'run_1', 'run_2', 'run_3'], 10, -1);
  mk('hit', ['hit_0'], 8, 0);
}

/** NPC/其它可用的英雄原皮（doc/angel/pumpkin_dude 只有 idle/run，hit 帧回落到 idle） */
export const PLAIN_HEROES = ['knight_m', 'knight_f', 'elf_m', 'elf_f', 'wizzard_m', 'wizzard_f', 'lizard_m', 'lizard_f', 'dwarf_m', 'dwarf_f', 'doc', 'angel', 'pumpkin_dude'] as const;

function buildSkins(scene: Phaser.Scene): void {
  for (const [id, spec] of Object.entries(SKINS)) makeSkin(scene, id, spec, spec.base);
  for (const h of PLAIN_HEROES) makeSkin(scene, h, null, h);
}

/* ------------------------------------------------------------------ */
/* 程序化特效贴图                                                        */
/* ------------------------------------------------------------------ */
function canvasTex(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): void {
  if (scene.textures.exists(key)) return;
  const t = scene.textures.createCanvas(key, w, h)!;
  const c = t.getContext();
  c.imageSmoothingEnabled = false;
  draw(c);
  t.refresh();
}

function buildFxTextures(scene: Phaser.Scene): void {
  // 椭圆硬影（像素台阶）
  canvasTex(scene, 'shadow', 16, 6, c => {
    c.fillStyle = 'rgba(0,0,0,1)';
    c.fillRect(3, 0, 10, 6);
    c.fillRect(1, 1, 14, 4);
    c.fillRect(0, 2, 16, 2);
  });
  // 白色像素块（粒子/飘屑，tint 着色）
  canvasTex(scene, 'px', 2, 2, c => { c.fillStyle = '#fff'; c.fillRect(0, 0, 2, 2); });
  canvasTex(scene, 'px3', 3, 3, c => { c.fillStyle = '#fff'; c.fillRect(0, 0, 3, 3); });
  canvasTex(scene, 'spark', 5, 5, c => { c.fillStyle = '#fff'; c.fillRect(2, 0, 1, 5); c.fillRect(0, 2, 5, 1); c.fillRect(1, 1, 3, 3); });
  // 柔光斑（加色混合用于发光/光晕）
  canvasTex(scene, 'glow', 64, 64, c => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
  });
  // 像素圆环（技能波纹/范围提示）
  canvasTex(scene, 'ring', 64, 64, c => {
    c.fillStyle = '#fff';
    for (let a = 0; a < 360; a += 1.5) {
      const r = 30;
      const x = Math.round(32 + Math.cos((a * Math.PI) / 180) * r), y = Math.round(32 + Math.sin((a * Math.PI) / 180) * r);
      c.fillRect(x - 1, y - 1, 2, 2);
    }
  });
  canvasTex(scene, 'disc', 64, 64, c => {
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(32, 32, 31, 0, Math.PI * 2); c.fill();
  });
  // 刀光：三种弧（剑 / 重劈 / 匕首），白色带亮芯，tint 着色
  const arc = (key: string, w: number, h: number, r: number, thick: number, span: number): void =>
    canvasTex(scene, key, w, h, c => {
      const cx = 4, cy = h / 2;
      for (let a = -span; a <= span; a += 0.02) {
        const t = 1 - Math.abs(a) / span;
        const th = Math.max(1, Math.round(thick * t));
        for (let k = 0; k < th; k++) {
          const rr = r - k;
          const x = Math.round(cx + Math.cos(a) * rr), y = Math.round(cy + Math.sin(a) * rr);
          c.fillStyle = k < 2 ? '#ffffff' : 'rgba(255,255,255,0.55)';
          c.fillRect(x, y, 1, 1);
        }
      }
    });
  arc('slash_sword', 32, 48, 26, 7, 1.15);
  arc('slash_heavy', 40, 64, 34, 10, 1.5);
  arc('slash_dagger', 24, 24, 17, 4, 0.7);
  arc('slash_claw', 24, 28, 18, 3, 0.9);
  // 突刺（匕首/长枪）
  canvasTex(scene, 'thrust', 28, 8, c => {
    c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(0, 2, 26, 4);
    c.fillStyle = '#fff'; c.fillRect(4, 3, 24, 2);
  });
  // 法球（白核 + tint 外圈）
  canvasTex(scene, 'orb', 10, 10, c => {
    c.fillStyle = 'rgba(255,255,255,0.45)'; c.fillRect(2, 0, 6, 10); c.fillRect(0, 2, 10, 6);
    c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillRect(2, 2, 6, 6);
    c.fillStyle = '#fff'; c.fillRect(3, 3, 3, 3);
  });
  canvasTex(scene, 'bolt', 14, 6, c => {
    c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(0, 1, 14, 4);
    c.fillStyle = '#fff'; c.fillRect(3, 2, 11, 2);
  });
  canvasTex(scene, 'shard', 12, 6, c => {
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(0, 2, 12, 2);
    c.fillStyle = '#fff'; c.fillRect(6, 1, 6, 4); c.fillRect(9, 0, 2, 6);
  });
  canvasTex(scene, 'shuriken', 9, 9, c => {
    c.fillStyle = '#d8dce8';
    c.fillRect(4, 0, 1, 9); c.fillRect(0, 4, 9, 1); c.fillRect(3, 3, 3, 3);
    c.fillStyle = '#7d8496'; c.fillRect(4, 4, 1, 1);
  });
  // 火把（4 帧火焰）
  canvasTex(scene, 'flame', 8 * 4, 12, c => {
    const pal = ['#fff2b0', '#ffc94a', '#ff8a2a', '#d4401c'];
    for (let f = 0; f < 4; f++) {
      const ox = f * 8;
      const sway = [0, 1, 0, -1][f];
      c.fillStyle = pal[3]; c.fillRect(ox + 1, 4, 6, 8);
      c.fillStyle = pal[2]; c.fillRect(ox + 2 + sway, 2, 4, 9);
      c.fillStyle = pal[1]; c.fillRect(ox + 3 + sway, 4, 2, 6);
      c.fillStyle = pal[0]; c.fillRect(ox + 3, 7, 2, 3);
      c.fillStyle = pal[2]; c.fillRect(ox + 3 + sway, 0 + (f % 2), 1, 2);
    }
  });
  const flameTex = scene.textures.get('flame');
  for (let f = 0; f < 4; f++) if (!flameTex.has(`fl${f}`)) flameTex.add(`fl${f}`, 0, f * 8, 0, 8, 12);
  if (!scene.anims.exists('flame')) scene.anims.create({ key: 'flame', frames: [0, 1, 2, 3].map(i => ({ key: 'flame', frame: `fl${i}` })), frameRate: 10, repeat: -1 });
  // 火把底座
  canvasTex(scene, 'torch', 6, 10, c => {
    c.fillStyle = '#3a2618'; c.fillRect(2, 2, 2, 8);
    c.fillStyle = '#6b4a2c'; c.fillRect(1, 0, 4, 3);
    c.fillStyle = '#8a8a96'; c.fillRect(1, 3, 4, 1);
  });
  // 传送阵（像素同心环 + 符文点）
  canvasTex(scene, 'portal', 48, 24, c => {
    const ring = (rx: number, ry: number, col: string): void => {
      c.fillStyle = col;
      for (let a = 0; a < 360; a += 3) {
        const x = Math.round(24 + Math.cos((a * Math.PI) / 180) * rx), y = Math.round(12 + Math.sin((a * Math.PI) / 180) * ry);
        c.fillRect(x, y, 1, 1);
      }
    };
    ring(23, 11, '#ffffff'); ring(19, 9, 'rgba(255,255,255,0.7)'); ring(14, 6, 'rgba(255,255,255,0.45)');
    c.fillStyle = '#fff';
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      c.fillRect(Math.round(24 + Math.cos(a) * 21), Math.round(12 + Math.sin(a) * 10), 2, 2);
    }
  });
  // 准星
  canvasTex(scene, 'crosshair', 11, 11, c => {
    c.fillStyle = '#fff';
    c.fillRect(5, 0, 1, 3); c.fillRect(5, 8, 1, 3); c.fillRect(0, 5, 3, 1); c.fillRect(8, 5, 3, 1);
    c.fillRect(5, 5, 1, 1);
  });
  // 经验晶体
  canvasTex(scene, 'expgem', 7, 9, c => {
    c.fillStyle = '#2f8a5a'; c.fillRect(1, 2, 5, 5); c.fillRect(2, 1, 3, 7); c.fillRect(3, 0, 1, 9);
    c.fillStyle = '#7ff0a8'; c.fillRect(2, 2, 2, 3);
    c.fillStyle = '#ffffff'; c.fillRect(2, 2, 1, 1);
  });
  // 材料：宝石 / 零件 / 精华
  canvasTex(scene, 'mat_gem', 9, 9, c => {
    c.fillStyle = '#5a2a8a'; c.fillRect(1, 3, 7, 4); c.fillRect(2, 2, 5, 6); c.fillRect(3, 1, 3, 8);
    c.fillStyle = '#c070ff'; c.fillRect(3, 3, 3, 3); c.fillStyle = '#fff'; c.fillRect(3, 3, 1, 1);
  });
  canvasTex(scene, 'mat_part', 9, 9, c => {
    c.fillStyle = '#6b7280'; c.fillRect(1, 1, 7, 7); c.fillStyle = '#9ca3af'; c.fillRect(2, 2, 5, 5);
    c.fillStyle = '#374151'; c.fillRect(4, 0, 1, 9); c.fillRect(0, 4, 9, 1); c.fillStyle = '#1f2937'; c.fillRect(3, 3, 3, 3);
  });
  canvasTex(scene, 'mat_essence', 9, 9, c => {
    c.fillStyle = '#1d6f8a'; c.fillRect(2, 1, 5, 7); c.fillRect(1, 3, 7, 4);
    c.fillStyle = '#6fe6df'; c.fillRect(3, 2, 3, 5); c.fillStyle = '#fff'; c.fillRect(3, 3, 1, 2);
  });
  // 元素图标（状态点）
  canvasTex(scene, 'pip', 4, 4, c => { c.fillStyle = '#fff'; c.fillRect(1, 0, 2, 4); c.fillRect(0, 1, 4, 2); });
}
