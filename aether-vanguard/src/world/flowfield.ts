// 流场寻路：以目标格为源做 Dijkstra（正交 10 / 斜向 14，禁止切角），
// 所有怪共享一张距离场，沿梯度下降即可绕过墙角与 L 形走廊。修复改版意见 #1/#3。

import { TILE } from '../config';
import type { GridMap } from './grid';

const INF = 0x3fffffff;
const DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10],
  [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14],
];

/** 最小二叉堆（按 cost） */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number { return this.k.length; }
  push(key: number, val: number): void {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export class FlowField {
  readonly dist: Int32Array;
  targetX = -1;
  targetY = -1;

  constructor(private readonly map: GridMap) {
    this.dist = new Int32Array(map.w * map.h).fill(INF);
  }

  /** 以世界坐标 (x,y) 为目标重建；目标格没变时跳过。maxCost 限制搜索半径（10=1 格） */
  update(x: number, y: number, maxCost = 10 * 60): boolean {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx === this.targetX && ty === this.targetY) return false;
    this.build(tx, ty, maxCost);
    return true;
  }

  build(tx: number, ty: number, maxCost: number): void {
    const { map, dist } = this;
    this.targetX = tx;
    this.targetY = ty;
    dist.fill(INF);
    if (!map.inBounds(tx, ty)) return;
    const w = map.w;
    const heap = new Heap();
    const s = ty * w + tx;
    dist[s] = 0;
    heap.push(0, s);
    while (heap.size) {
      const cur = heap.pop();
      const cd = dist[cur];
      if (cd > maxCost) continue;
      const cx = cur % w, cy = (cur / w) | 0;
      for (const [ox, oy, c] of DIRS) {
        const nx = cx + ox, ny = cy + oy;
        if (!map.inBounds(nx, ny) || map.solid(nx, ny)) continue;
        // 斜向不允许切过墙角
        if (ox && oy && (map.solid(cx + ox, cy) || map.solid(cx, cy + oy))) continue;
        const ni = ny * w + nx;
        const nd = cd + c;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          heap.push(nd, ni);
        }
      }
    }
  }

  /** 世界坐标处的距离值（格内，INF=不可达） */
  costAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    return this.map.inBounds(tx, ty) ? this.dist[ty * this.map.w + tx] : INF;
  }

  reachable(x: number, y: number): boolean { return this.costAt(x, y) < INF; }

  /**
   * 下降方向（单位向量写入 out）。返回 false 表示已在目标格或不可达。
   * 取 8 邻中代价最低的格，朝该格中心前进；当前格中心偏移较大时会自然收敛。
   */
  dirAt(x: number, y: number, out: { x: number; y: number }): boolean {
    const { map, dist } = this;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (!map.inBounds(tx, ty)) return false;
    const here = dist[ty * map.w + tx];
    if (here === 0 || here >= INF) return false;
    let best = here, bx = 0, by = 0;
    for (const [ox, oy] of DIRS) {
      const nx = tx + ox, ny = ty + oy;
      if (!map.inBounds(nx, ny)) continue;
      if (ox && oy && (map.solid(tx + ox, ty) || map.solid(tx, ty + oy))) continue;
      const d = dist[ny * map.w + nx];
      if (d < best) { best = d; bx = ox; by = oy; }
    }
    if (best === here) return false;
    const gx = (tx + bx) * TILE + TILE / 2 - x;
    const gy = (ty + by) * TILE + TILE / 2 - y;
    const l = Math.hypot(gx, gy) || 1;
    out.x = gx / l;
    out.y = gy / l;
    return true;
  }
}
