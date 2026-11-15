// 圆形 vs 瓦片网格碰撞：分步移动 + 逐格推出，能贴墙滑动、绕过凸角。
// 替代 legacy moveEnt 的「每轴整步或不动」，并提供“嵌墙自救”，修复改版意见 #1 怪物卡墙。

import { TILE } from '../config';
import { clamp } from '../core/util';
import type { GridMap } from './grid';

export interface Body { x: number; y: number; r: number }

export const HIT_X = 1;
export const HIT_Y = 2;

/** 把圆推出所有重叠的实心格，返回碰撞方向标记 */
export function resolveCircle(map: GridMap, b: Body): number {
  let hit = 0;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    const x0 = Math.floor((b.x - b.r) / TILE), x1 = Math.floor((b.x + b.r) / TILE);
    const y0 = Math.floor((b.y - b.r) / TILE), y1 = Math.floor((b.y + b.r) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!map.solid(tx, ty)) continue;
        const rx = tx * TILE, ry = ty * TILE;
        const cx = clamp(b.x, rx, rx + TILE), cy = clamp(b.y, ry, ry + TILE);
        const nx = b.x - cx, ny = b.y - cy;
        const d2 = nx * nx + ny * ny;
        if (d2 >= b.r * b.r - 1e-6) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = b.r - d + 0.01;
          b.x += (nx / d) * push;
          b.y += (ny / d) * push;
          hit |= Math.abs(nx) > Math.abs(ny) ? HIT_X : HIT_Y;
        } else {
          // 圆心已在格内：朝“邻格可走”的最近边推出
          const opts: Array<[number, number, number]> = [
            [b.x - rx, -1, 0], [rx + TILE - b.x, 1, 0], [b.y - ry, 0, -1], [ry + TILE - b.y, 0, 1],
          ];
          opts.sort((a, c) => a[0] - c[0]);
          const pick = opts.find(o => !map.solid(tx + o[1], ty + o[2])) ?? opts[0];
          b.x += pick[1] * (pick[0] + b.r + 0.01);
          b.y += pick[2] * (pick[0] + b.r + 0.01);
          hit |= pick[1] ? HIT_X : HIT_Y;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return hit;
}

/** 带碰撞的位移（每小步不超过半径的一半，防止高速穿墙） */
export function moveCircle(map: GridMap, b: Body, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const maxStep = Math.max(2, b.r * 0.5);
  const steps = Math.max(1, Math.ceil(len / maxStep));
  const sx = dx / steps, sy = dy / steps;
  let hit = 0;
  for (let i = 0; i < steps; i++) {
    b.x += sx;
    b.y += sy;
    hit |= resolveCircle(map, b);
  }
  return hit;
}

/** 圆是否完全落在可走区域 */
export function isFree(map: GridMap, x: number, y: number, r: number): boolean {
  // NaN/Infinity 坐标不是合法落点（否则循环一次都不执行，误判为“空地”）
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
  const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!map.solid(tx, ty)) continue;
      const rx = tx * TILE, ry = ty * TILE;
      const cx = clamp(x, rx, rx + TILE), cy = clamp(y, ry, ry + TILE);
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return false;
    }
  }
  return true;
}

/** 从 (x,y) 出发 BFS 找最近的、能容纳半径 r 的位置（用于召唤/击退后嵌墙自救/出生点校验） */
export function nearestFree(map: GridMap, x: number, y: number, r: number, maxTiles = 12): { x: number; y: number } {
  // 非法坐标：从地图中心重新找（大范围），绝不把 NaN 当成落点返回
  if (!Number.isFinite(x) || !Number.isFinite(y)) return nearestFree(map, map.pixelW / 2, map.pixelH / 2, r, Math.max(map.w, map.h));
  if (isFree(map, x, y, r)) return { x, y };
  const sx = Math.floor(x / TILE), sy = Math.floor(y / TILE);
  const seen = new Set<number>();
  const q: Array<[number, number, number]> = [[sx, sy, 0]];
  seen.add(sy * map.w + sx);
  while (q.length) {
    const [tx, ty, d] = q.shift()!;
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    if (!map.solid(tx, ty) && isFree(map, cx, cy, r)) return { x: cx, y: cy };
    if (d >= maxTiles) continue;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = tx + ox, ny = ty + oy;
      if (!map.inBounds(nx, ny)) continue;
      const k = ny * map.w + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nx, ny, d + 1]);
    }
  }
  return { x, y };
}
