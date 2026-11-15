// 视线与射线：Amanatides–Woo 网格遍历。用于索敌（不打墙后目标）、射击判定、光束截断、迷雾可见性。

import { TILE } from '../config';
import type { GridMap } from './grid';

/** (x0,y0)→(x1,y1) 之间是否没有不透明格 */
export function lineOfSight(map: GridMap, x0: number, y0: number, x1: number, y1: number): boolean {
  return raycastTo(map, x0, y0, x1, y1) >= 1;
}

/** 最近一次 raycastTo 命中的不透明格（未命中时为 -1） */
export const lastHit = { tx: -1, ty: -1 };

/**
 * 沿线段前进，返回到达第一个不透明格前走过的比例 t ∈ [0,1]（1 表示畅通）。
 */
export function raycastTo(map: GridMap, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  let tx = Math.floor(x0 / TILE), ty = Math.floor(y0 / TILE);
  const ex = Math.floor(x1 / TILE), ey = Math.floor(y1 / TILE);
  lastHit.tx = -1;
  lastHit.ty = -1;
  if (map.opaque(tx, ty)) { lastHit.tx = tx; lastHit.ty = ty; return 0; }
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx)) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy)) : Infinity;
  let guard = 0;
  while ((tx !== ex || ty !== ey) && guard++ < 512) {
    let t: number;
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; }
    else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; }
    if (t > 1) break;
    if (map.opaque(tx, ty)) { lastHit.tx = tx; lastHit.ty = ty; return Math.max(0, t); }
  }
  return 1;
}

/** 从 (x,y) 沿角度 a 射出最长 maxDist，返回实际可达距离 */
export function raycastDist(map: GridMap, x: number, y: number, a: number, maxDist: number): number {
  const t = raycastTo(map, x, y, x + Math.cos(a) * maxDist, y + Math.sin(a) * maxDist);
  return t * maxDist;
}

/**
 * 迷雾：以 (cx,cy) 为中心、半径 rTiles 更新 visible/explored（逐格视线判定，墙体本身可被看见）。
 * 替代 legacy revealFog 的“无视墙壁圆形点亮”。
 */
export function computeFov(map: GridMap, cx: number, cy: number, rTiles: number): void {
  if (!map.fog) return;
  map.visible.fill(0);
  const ctx = Math.floor(cx / TILE), cty = Math.floor(cy / TILE);
  const r2 = rTiles * rTiles;
  for (let ty = cty - rTiles; ty <= cty + rTiles; ty++) {
    for (let tx = ctx - rTiles; tx <= ctx + rTiles; tx++) {
      if (!map.inBounds(tx, ty)) continue;
      const ddx = tx - ctx, ddy = ty - cty;
      if (ddx * ddx + ddy * ddy > r2) continue;
      const px = tx * TILE + TILE / 2, py = ty * TILE + TILE / 2;
      // 目标若是墙：射线碰到的第一个不透明格就是它本身，则墙面可见
      const t = raycastTo(map, cx, cy, px, py);
      const seen = t >= 1 || (lastHit.tx === tx && lastHit.ty === ty);
      if (seen) {
        const i = ty * map.w + tx;
        map.visible[i] = 1;
        map.explored[i] = 1;
      }
    }
  }
}
