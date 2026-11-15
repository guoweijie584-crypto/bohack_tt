// 小地图 / 大地图：逐像素写 ImageData（整数倍放大，硬边像素）。
// 迷雾门控（改版意见 #19）：地形只画已探索格；普通敌人只画当前可见格；
// 首领位置“已知”（所在格已探索或当前可见）才画脉冲，未知时只在边缘画方向箭头 + “BOSS 在未探索区域”。

import { TILE } from '../config';
import { clamp } from '../core/util';
import { T, TILE_BASE } from '../data/tiles';
import { G } from '../game/state';
import type { PortalKind } from '../game/types';
import type { GridMap } from '../world/grid';

/* ------------------------------------------------------------------ */
/* 纯逻辑（单元测试覆盖）                                                */
/* ------------------------------------------------------------------ */

/** 迷雾查询接口（GridMap 满足） */
export interface FogLike {
  isExploredWorld(x: number, y: number): boolean;
  isVisibleWorld(x: number, y: number): boolean;
}
export type BossState = 'none' | 'known' | 'unknown';
export interface BossHint {
  state: BossState;
  /** 首领此刻在视野内 */
  visible: boolean;
  /** 玩家 → 首领 的角度（弧度） */
  angle: number;
  /** 距离（格） */
  distTiles: number;
  /** 八方位 */
  dir: string;
  /** 提示文字 */
  text: string;
}

const DIRS8 = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
/** 角度 → 八方位（屏幕坐标 y 向下） */
export function dir8(angle: number): string {
  const i = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS8[i];
}

export const BOSS_UNKNOWN_TEXT = 'BOSS 在未探索区域';

/**
 * 首领提示：
 * - 没有首领或已死亡 → none；
 * - 首领所在格已探索或当前可见 → known（可以画精确位置）；
 * - 否则 → unknown（只给方向，不暴露位置）。
 * map 为 null（无迷雾信息）时视为已知。
 */
export function bossHint(
  map: FogLike | null,
  boss: { x: number; y: number; dead: boolean } | null,
  px: number,
  py: number,
): BossHint {
  if (!boss || boss.dead) return { state: 'none', visible: false, angle: 0, distTiles: 0, dir: '', text: '' };
  const visible = !map || map.isVisibleWorld(boss.x, boss.y);
  const known = visible || !map || map.isExploredWorld(boss.x, boss.y);
  const angle = Math.atan2(boss.y - py, boss.x - px);
  const distTiles = Math.round(Math.hypot(boss.x - px, boss.y - py) / TILE);
  const dir = dir8(angle);
  return {
    state: known ? 'known' : 'unknown',
    visible,
    angle,
    distTiles,
    dir,
    text: known ? `首领在${dir}方 ${distTiles} 格` : BOSS_UNKNOWN_TEXT,
  };
}

/**
 * 从 (x0,y0) 沿 angle 射出，与内缩 inset 的画布边框 [inset, w-1-inset]×[inset, h-1-inset] 的交点（整数像素）。
 * 起点在框外时先夹回框内。用于小地图边缘的方向箭头。
 */
export function edgePoint(x0: number, y0: number, angle: number, w: number, h: number, inset: number): { x: number; y: number } {
  const minX = inset, maxX = w - 1 - inset, minY = inset, maxY = h - 1 - inset;
  const cx = clamp(x0, minX, maxX), cy = clamp(y0, minY, maxY);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let t = Infinity;
  if (dx > 1e-6) t = Math.min(t, (maxX - cx) / dx);
  else if (dx < -1e-6) t = Math.min(t, (minX - cx) / dx);
  if (dy > 1e-6) t = Math.min(t, (maxY - cy) / dy);
  else if (dy < -1e-6) t = Math.min(t, (minY - cy) / dy);
  if (!Number.isFinite(t)) t = 0;
  return { x: Math.round(clamp(cx + dx * t, minX, maxX)), y: Math.round(clamp(cy + dy * t, minY, maxY)) };
}

/** 首领“已被发现”（顶部血条显示条件）：见过一次即记住；或已进入战斗且距离不远 */
let seenBossId = -1;
export function bossDiscovered(hint: BossHint, boss: { id: number; aggro: boolean } | null): boolean {
  if (!boss || hint.state === 'none') return false;
  if (hint.visible) seenBossId = boss.id;
  return seenBossId === boss.id || (boss.aggro && hint.distTiles <= 12);
}
/** 换图时重置（测试也用） */
export function resetBossMemory(): void { seenBossId = -1; }

/* ------------------------------------------------------------------ */
/* 像素光栅                                                             */
/* ------------------------------------------------------------------ */
type RGB = readonly [number, number, number];
const rgbCache = new Map<string, RGB>();
export function rgbOf(hex: string): RGB {
  let v = rgbCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16) || 0;
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}
const dimOf = (c: RGB, k: number): RGB => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

class Raster {
  readonly img: ImageData;
  constructor(readonly ctx: CanvasRenderingContext2D, readonly w: number, readonly h: number) {
    this.img = ctx.createImageData(w, h);
  }
  clear(c: RGB): void {
    const d = this.img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
  }
  px(x: number, y: number, c: RGB): void {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.img.data;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }
  /** 中点画圆（空心） */
  circle(cx: number, cy: number, r: number, c: RGB): void {
    let x = r, y = 0, err = 1 - r;
    while (x >= y) {
      for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]] as const) this.px(cx + a, cy + b, c);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  }
  /** 实心三角箭头：尖端朝 angle（像素中心判定，无抗锯齿） */
  arrow(x: number, y: number, angle: number, size: number, c: RGB): void {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const tip: [number, number] = [x + dx * size, y + dy * size];
    const bx = x - dx * size * 0.6, by = y - dy * size * 0.6;
    const l: [number, number] = [bx - dy * size * 0.9, by + dx * size * 0.9];
    const r: [number, number] = [bx + dy * size * 0.9, by - dx * size * 0.9];
    const pts = [tip, l, r];
    const x0 = Math.floor(Math.min(tip[0], l[0], r[0])), x1 = Math.ceil(Math.max(tip[0], l[0], r[0]));
    const y0 = Math.floor(Math.min(tip[1], l[1], r[1])), y1 = Math.ceil(Math.max(tip[1], l[1], r[1]));
    const side = (a: [number, number], b: [number, number], px: number, py: number): number => (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const px = i + 0.5, py = j + 0.5;
      const s1 = side(pts[0], pts[1], px, py), s2 = side(pts[1], pts[2], px, py), s3 = side(pts[2], pts[0], px, py);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) this.px(i, j, c);
    }
  }
  flush(): void { this.ctx.putImageData(this.img, 0, 0); }
}

/* ------------------------------------------------------------------ */
/* 地图视口与绘制                                                        */
/* ------------------------------------------------------------------ */
interface View { s: number; ox: number; oy: number; tx0: number; ty0: number; tw: number; th: number }

/** 计算整数倍视口：放得下整张图就居中显示，否则以玩家为中心滚动 */
function computeView(map: GridMap, W: number, H: number, px: number, py: number, maxScale: number): View {
  const s = Math.max(1, Math.min(maxScale, Math.floor(Math.min(W / map.w, H / map.h))));
  const tw = Math.floor(W / s), th = Math.floor(H / s);
  let tx0 = 0, ty0 = 0, ox = 0, oy = 0;
  if (map.w <= tw) ox = Math.floor((W - map.w * s) / 2);
  else tx0 = clamp(Math.floor(px / TILE - tw / 2), 0, map.w - tw);
  if (map.h <= th) oy = Math.floor((H - map.h * s) / 2);
  else ty0 = clamp(Math.floor(py / TILE - th / 2), 0, map.h - th);
  return { s, ox, oy, tx0, ty0, tw: Math.min(tw, map.w), th: Math.min(th, map.h) };
}

const BG: RGB = rgbOf('#1a110b');
const UNEXPLORED: RGB = rgbOf('#100b08');
const TILE_RGB = new Map<number, { full: RGB; dim: RGB; top: RGB }>();
function tileRgb(v: number): { full: RGB; dim: RGB; top: RGB } {
  let e = TILE_RGB.get(v);
  if (!e) {
    const full = rgbOf(TILE_BASE[v] ?? '#241a13');
    e = { full, dim: dimOf(full, 0.6), top: [Math.min(255, full[0] + 34), Math.min(255, full[1] + 30), Math.min(255, full[2] + 24)] };
    TILE_RGB.set(v, e);
  }
  return e;
}

function drawTerrain(r: Raster, map: GridMap, v: View, wallTop: boolean): void {
  const tx1 = Math.min(map.w, v.tx0 + v.tw), ty1 = Math.min(map.h, v.ty0 + v.th);
  for (let ty = v.ty0; ty < ty1; ty++) {
    for (let tx = v.tx0; tx < tx1; tx++) {
      const x = v.ox + (tx - v.tx0) * v.s, y = v.oy + (ty - v.ty0) * v.s;
      if (!map.isExplored(tx, ty)) { r.rect(x, y, v.s, v.s, UNEXPLORED); continue; }
      const tile = map.tiles[ty * map.w + tx];
      const c = tileRgb(tile);
      const col = map.isVisible(tx, ty) ? c.full : c.dim;
      r.rect(x, y, v.s, v.s, col);
      if (wallTop && v.s >= 3 && tile === T.WALL && map.isExplored(tx, ty + 1) && !map.solid(tx, ty + 1)) r.rect(x, y, v.s, 1, c.top);
    }
  }
}

const PORTAL_COLOR: Record<PortalKind, string> = {
  dungeon: '#f0bd7c', arena: '#e8a765', secret: '#c29ae8', city: '#7fd6c4', next: '#a8e07c', boss: '#ff6b5f',
};
export function portalColor(kind: PortalKind, open: boolean): string {
  if (kind === 'next' && !open) return '#71805c';
  return PORTAL_COLOR[kind] ?? '#f0bd7c';
}

export interface MapLabel { x: number; y: number; text: string; color: string; cls?: string }

const C_PLAYER = rgbOf('#fff6e2'), C_PLAYER_D = rgbOf('#b08358');
const C_ENEMY = rgbOf('#d9705f'), C_ELITE = rgbOf('#f0a060'), C_RIVAL = rgbOf('#f0bd7c');
const C_BOSS = rgbOf('#ff6b5f'), C_BOSS_D = rgbOf('#8c2f2a'), C_BOSS_L = rgbOf('#ffd0bb');
const C_NPC = rgbOf('#ffe0a0'), C_DARK = rgbOf('#120b07');

interface DrawOpts { big: boolean; t: number }

/** 绘制标记（传送阵/NPC/敌人/首领/玩家），返回首领提示与（大地图用）标签 */
function drawMarkers(r: Raster, map: GridMap, v: View, o: DrawOpts): { hint: BossHint; labels: MapLabel[] } {
  const labels: MapLabel[] = [];
  const p = G.player;
  const toX = (wx: number): number => Math.floor(v.ox + (wx / TILE - v.tx0) * v.s);
  const toY = (wy: number): number => Math.floor(v.oy + (wy / TILE - v.ty0) * v.s);
  const k = o.big ? Math.max(1, Math.floor(v.s / 2)) : 1; // 标记放大倍数

  for (const pt of G.portals) {
    if (!map.isExploredWorld(pt.x, pt.y)) continue;
    const c = rgbOf(portalColor(pt.kind, pt.open));
    const x = toX(pt.x), y = toY(pt.y);
    r.rect(x - 1 * k, y - 1 * k, 3 * k, 3 * k, c);
    r.rect(x, y, k, k, C_DARK);
    if (o.big) labels.push({ x, y: y - 2 * k, text: pt.label || (pt.kind === 'next' ? '出口' : '传送阵'), color: portalColor(pt.kind, pt.open) });
  }
  for (const n of G.npcs) {
    if (!map.isExploredWorld(n.x, n.y)) continue;
    const x = toX(n.x), y = toY(n.y);
    r.rect(x, y, o.big ? 2 * k : 1, o.big ? 2 * k : 1, C_NPC);
    if (o.big && G.scene === 'city') labels.push({ x, y: y - k, text: n.name, color: '#f2dfc0', cls: 'npc' });
  }
  for (const e of G.enemies) {
    if (e.dead || e.boss) continue;
    if (!map.isVisibleWorld(e.x, e.y)) continue;
    const x = toX(e.x), y = toY(e.y);
    const c = e.rival ? C_RIVAL : e.elite ? C_ELITE : C_ENEMY;
    const sz = (e.elite || e.rival ? 2 : 1) * k;
    r.rect(x, y, sz, sz, c);
  }

  const boss = G.boss;
  const hint = p ? bossHint(map, boss, p.x, p.y) : bossHint(null, null, 0, 0);
  if (boss && p && hint.state === 'known') {
    const x = toX(boss.x), y = toY(boss.y);
    const step = Math.floor(o.t * 4) % 3;
    r.circle(x, y, (3 + step) * k, step === 2 ? C_BOSS_D : C_BOSS);
    r.rect(x - k, y - k, 3 * k, 3 * k, C_BOSS);
    r.rect(x, y, k, k, C_BOSS_L);
    if (o.big) labels.push({ x, y: y - 5 * k, text: boss.def?.n ?? '首领', color: '#ffd0bb', cls: 'boss' });
  }
  if (p) {
    const x = toX(p.x), y = toY(p.y);
    if (boss && hint.state === 'unknown') {
      // 未知：只在边框画方向箭头（闪烁），不暴露位置
      const e = edgePoint(x, y, hint.angle, r.w, r.h, 3 * k);
      if (Math.floor(o.t * 3) % 2 === 0) r.arrow(e.x, e.y, hint.angle, 2.6 * k, C_BOSS);
      else r.arrow(e.x, e.y, hint.angle, 2.6 * k, C_BOSS_D);
    }
    // 玩家：白色十字 + 朝向点
    r.rect(x - k, y, 3 * k, k, C_PLAYER);
    r.rect(x, y - k, k, 3 * k, C_PLAYER);
    const ax = Math.round(x + Math.cos(p.aim) * 2 * k), ay = Math.round(y + Math.sin(p.aim) * 2 * k);
    r.rect(ax, ay, k, k, C_PLAYER_D);
    if (o.big) labels.push({ x, y: y - 3 * k, text: '你', color: '#ffe9c9', cls: 'me' });
  }
  return { hint, labels };
}

/** 右上角小地图（内部 88×64，CSS 2 倍） */
export class MiniMap {
  static readonly W = 88;
  static readonly H = 64;
  private readonly r: Raster | null;
  constructor(cv: HTMLCanvasElement) {
    cv.width = MiniMap.W;
    cv.height = MiniMap.H;
    const ctx = cv.getContext('2d');
    this.r = ctx ? new Raster(ctx, MiniMap.W, MiniMap.H) : null;
  }
  draw(t: number): BossHint {
    const map = G.map, p = G.player;
    const none = bossHint(null, null, 0, 0);
    if (!this.r) return none;
    this.r.clear(BG);
    if (!map || !p) { this.r.flush(); return none; }
    const v = computeView(map, MiniMap.W, MiniMap.H, p.x, p.y, 4);
    drawTerrain(this.r, map, v, false);
    const { hint } = drawMarkers(this.r, map, v, { big: false, t });
    this.r.flush();
    return hint;
  }
}

/** 大地图：内部每格 3 像素，canvas 由面板按整数倍 CSS 放大；返回标签（内部像素坐标）供 DOM 叠加 */
export function drawBigMap(cv: HTMLCanvasElement, t: number): { hint: BossHint; labels: MapLabel[]; w: number; h: number } | null {
  const map = G.map, p = G.player;
  if (!map || !p) return null;
  const s = 3;
  const W = map.w * s, H = map.h * s;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const r = new Raster(ctx, W, H);
  r.clear(BG);
  const v: View = { s, ox: 0, oy: 0, tx0: 0, ty0: 0, tw: map.w, th: map.h };
  drawTerrain(r, map, v, true);
  const res = drawMarkers(r, map, v, { big: true, t });
  r.flush();
  return { ...res, w: W, h: H };
}
