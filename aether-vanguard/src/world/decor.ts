// 装饰词表 + 地图生成用的摆放工具。
//
// 【装饰坐标约定】（渲染层据此绘制，务必一致）
//   Decor.(x, y) = 脚印底边中点（世界坐标）：x = (tx + w/2)·TILE，y = (ty + h)·TILE。
//   渲染以 origin(0.5, 1) 贴在 (x, y)，按 y 做深度排序；脚印格 = [tx, tx+w) × [ty, ty+h)。
//   wall=true 的装饰（火把）放在“南邻为地面”的墙格上：(x, y) 为该墙格底边中点，渲染时自行上移到墙面。
//   block=true 的装饰，其脚印格在地图里写成 T.BLOCK（实心、不挡视线，渲染层不画墙）。
//
// 只能使用本表声明过的 kind。

import { TILE } from '../config';
import { T } from '../data/tiles';
import type { Decor } from '../game/types';
import type { GridMap } from './grid';

export interface DecorLight { color: number; radius: number; intensity: number; flicker: boolean }

export interface DecorKindDef {
  /** 脚印宽/高（格） */
  w: number;
  h: number;
  /** 阻挡移动（脚印写成 T.BLOCK） */
  block: boolean;
  /** 发光（火把/路灯/源能井/熔岩缝…） */
  light?: DecorLight;
  /** 挂在墙面上（放在墙格上，不占地面） */
  wall?: boolean;
  /** 建筑（门在底边正中：门格 = (tx + ⌊w/2⌋, ty + h - 1)，门前一格可走） */
  building?: boolean;
  /** 中文名（招牌/提示用） */
  label?: string;
}

const L = (color: number, radius: number, intensity: number, flicker: boolean): DecorLight => ({ color, radius, intensity, flicker });

const KINDS = {
  // —— 主城建筑 ——
  shop_potion: { w: 3, h: 2, block: true, building: true, label: '药剂铺' },
  shop_smith: { w: 3, h: 2, block: true, building: true, label: '铁匠铺' },
  hall: { w: 4, h: 2, block: true, building: true, label: '议会厅' },
  temple: { w: 4, h: 3, block: true, building: true, label: '转职殿' },
  library: { w: 4, h: 2, block: true, building: true, label: '书馆' },
  warehouse: { w: 4, h: 2, block: true, building: true, label: '仓库' },
  arena_gate: { w: 3, h: 1, block: true, building: true, label: '镜像竞技场' },
  house_a: { w: 4, h: 2, block: true, building: true, label: '民居' },
  house_b: { w: 3, h: 2, block: true, building: true, label: '民居' },
  // —— 主城摆设 ——
  well: { w: 2, h: 2, block: true, light: L(0x7fe0ff, 200, 1.2, false), label: '源能井' },
  statue: { w: 2, h: 2, block: true, label: '先驱者雕像' },
  anvil: { w: 1, h: 1, block: true, label: '铁砧' },
  stash: { w: 1, h: 1, block: true, label: '仓库箱' },
  tree: { w: 1, h: 1, block: true },
  bush: { w: 1, h: 1, block: false },
  flowers: { w: 1, h: 1, block: false },
  lamp: { w: 1, h: 1, block: true, light: L(0xffd890, 150, 1.0, false) },
  fence_h: { w: 1, h: 1, block: true },
  fence_v: { w: 1, h: 1, block: true },
  stall: { w: 2, h: 1, block: true, label: '摊位' },
  bench: { w: 2, h: 1, block: true },
  barrel: { w: 1, h: 1, block: true },
  crate: { w: 1, h: 1, block: true },
  sign: { w: 1, h: 1, block: true, label: '告示牌' },
  // —— 地牢 ——
  torch: { w: 1, h: 1, block: false, wall: true, light: L(0xffa040, 170, 1.3, true) },
  skull: { w: 1, h: 1, block: false },
  bones: { w: 1, h: 1, block: false },
  cobweb: { w: 1, h: 1, block: false },
  rubble: { w: 1, h: 1, block: false },
  column: { w: 1, h: 1, block: true },
  /** 地刺陷阱：v = 相位（0–9），升起判定见 game/world.ts spikesUp() */
  spikes: { w: 1, h: 1, block: false },
  crystal: { w: 1, h: 1, block: true, light: L(0x8fe0ff, 110, 0.9, false) },
  lava_vent: { w: 1, h: 1, block: false, light: L(0xff6020, 120, 1.1, true) },
  grave: { w: 1, h: 1, block: true },
  /** 补给泉：交互回满一次；用过后 v = 1（干涸） */
  fountain: { w: 2, h: 2, block: true, light: L(0x6fe6df, 150, 1.0, false), label: '补给泉' },
  /** 事件祭坛：交互二选一；用过后 v = 1（沉寂） */
  altar: { w: 2, h: 1, block: true, light: L(0xc070ff, 140, 1.0, true), label: '源能祭坛' },
  rune: { w: 1, h: 1, block: false, light: L(0xc9a2f0, 90, 0.8, false) },
  brazier: { w: 1, h: 1, block: true, light: L(0xff9030, 180, 1.3, true) },
} as const satisfies Record<string, DecorKindDef>;

export type DecorKind = keyof typeof KINDS;
export const DECOR_KINDS: Record<string, DecorKindDef> = KINDS;

/** 可交互装饰（F 键）：kind → 交互类别 */
export const INTERACT_DECOR: Readonly<Record<string, 'fountain' | 'altar' | 'stash'>> = {
  fountain: 'fountain', altar: 'altar', stash: 'stash',
};

/** 装饰脚印（格坐标，左上角 + 尺寸） */
export function decorFootprint(d: Pick<Decor, 'kind' | 'x' | 'y'>): { tx: number; ty: number; w: number; h: number } {
  const k = DECOR_KINDS[d.kind] ?? { w: 1, h: 1 };
  return { tx: Math.round(d.x / TILE - k.w / 2), ty: Math.round(d.y / TILE - k.h), w: k.w, h: k.h };
}

/** 装饰几何中心（世界坐标，交互/提示距离用） */
export function decorCenter(d: Pick<Decor, 'kind' | 'x' | 'y'>): { x: number; y: number } {
  const k = DECOR_KINDS[d.kind] ?? { w: 1, h: 1 };
  return { x: d.x, y: d.y - (k.h * TILE) / 2 };
}

/* ------------------------------------------------------------------ */
/* 摆放工具                                                             */
/* ------------------------------------------------------------------ */
/** 占用标记 */
export const OCC_BLOCK = 1;
/** 保留格：任何装饰都不能放（门口、走廊、NPC 站位、传送阵、出生点） */
export const OCC_RESERVED = 2;
/** 已有不阻挡的地面装饰 */
export const OCC_DECAL = 4;

export interface PlaceOpts {
  v?: number;
  breakable?: boolean;
  hp?: number;
  /** 要求脚印外 clear 圈内全是可走且未被占用的格 */
  clear?: number;
  /** 脚印外 spacing 圈内不能有其它阻挡装饰（墙除外）——阻挡物之间至少留 spacing 格，大体型怪不会卡在 1 格缝里 */
  spacing?: number;
  /** 必须成功（失败记入 failures，测试会检查） */
  required?: boolean;
}

/**
 * 摆放器：维护占用表；放阻挡物时做“连通保护”——
 * 放置后从锚点出发的可达格数必须恰好减少脚印格数，否则撤销（不会封死任何角落）。
 */
export class Placer {
  readonly decor: Decor[] = [];
  readonly occ: Uint8Array;
  readonly failures: string[] = [];
  private nid = 1;
  private readonly seen: Uint8Array;
  private readonly queue: Int32Array;
  private anchor = -1;
  private reach = 0;

  constructor(readonly map: GridMap) {
    const n = map.w * map.h;
    this.occ = new Uint8Array(n);
    this.seen = new Uint8Array(n);
    this.queue = new Int32Array(n);
  }

  /** 本地递增 id（world.ts 载入时会换成全局 id） */
  newId(): number { return this.nid++; }

  /** 设置连通锚点（通常是出生点）；之后放阻挡物会做连通保护 */
  setAnchor(tx: number, ty: number): void {
    this.anchor = ty * this.map.w + tx;
    this.reserve(tx, ty);
    this.reach = this.flood();
  }

  /** 直接改过地形后重新统计 */
  refresh(): void { if (this.anchor >= 0) this.reach = this.flood(); }

  reachable(tx: number, ty: number): boolean {
    return this.map.inBounds(tx, ty) && this.seen[ty * this.map.w + tx] === 1;
  }

  reserve(tx: number, ty: number, w = 1, h = 1): void {
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) {
      if (this.map.inBounds(x, y)) this.occ[y * this.map.w + x] |= OCC_RESERVED;
    }
  }

  isReserved(tx: number, ty: number): boolean {
    return this.map.inBounds(tx, ty) && (this.occ[ty * this.map.w + tx] & OCC_RESERVED) !== 0;
  }

  /** 该格是否空闲（可走、未被占用、未保留） */
  isOpen(tx: number, ty: number): boolean {
    if (!this.map.inBounds(tx, ty) || this.map.solid(tx, ty)) return false;
    return this.occ[ty * this.map.w + tx] === 0;
  }

  /** 检查 kind 能否以 (tx,ty) 为左上角放下 */
  canPlace(kind: DecorKind, tx: number, ty: number, clear = 0, spacing = 0): boolean {
    const def = KINDS[kind];
    for (let y = ty; y < ty + def.h; y++) for (let x = tx; x < tx + def.w; x++) {
      if (!this.isOpen(x, y)) return false;
    }
    return this.ringOk(tx, ty, def.w, def.h, clear, spacing);
  }

  /** 脚印外一圈的检查：clear 圈内可走且无阻挡；spacing 圈内无其它阻挡装饰 */
  private ringOk(tx: number, ty: number, w: number, h: number, clear: number, spacing: number): boolean {
    const m = this.map;
    const r = Math.max(clear, spacing);
    for (let y = ty - r; y < ty + h + r; y++) for (let x = tx - r; x < tx + w + r; x++) {
      if (x >= tx && x < tx + w && y >= ty && y < ty + h) continue;
      const dd = Math.max(tx - x, x - (tx + w - 1), ty - y, y - (ty + h - 1));
      const inB = m.inBounds(x, y);
      const blocked = inB && (this.occ[y * m.w + x] & OCC_BLOCK) !== 0;
      if (dd <= clear && (!inB || m.solid(x, y) || blocked)) return false;
      if (dd <= spacing && blocked) return false;
    }
    return true;
  }

  /** 放置地面装饰（左上角 tx,ty）；失败返回 null */
  place(kind: DecorKind, tx: number, ty: number, opts: PlaceOpts = {}): Decor | null {
    const def: DecorKindDef = KINDS[kind];
    if (def.wall) return this.placeOnWall(kind, tx, ty, opts);
    if (!this.canPlace(kind, tx, ty, opts.clear ?? 0, opts.spacing ?? 0) || (opts.breakable && !this.allTile(tx, ty, def.w, def.h, T.FLOOR))) {
      return this.fail(kind, tx, ty, opts);
    }
    if (def.block && !this.blockTiles(tx, ty, def.w, def.h, T.BLOCK)) return this.fail(kind, tx, ty, opts);
    const w = this.map.w;
    for (let y = ty; y < ty + def.h; y++) for (let x = tx; x < tx + def.w; x++) {
      this.occ[y * w + x] |= def.block ? OCC_BLOCK : OCC_DECAL;
    }
    return this.make(kind, def, tx, ty, opts);
  }

  /** 墙面装饰：墙格本身是 WALL，南邻必须是可走地面 */
  placeOnWall(kind: DecorKind, tx: number, ty: number, opts: PlaceOpts = {}): Decor | null {
    const m = this.map;
    const def: DecorKindDef = KINDS[kind];
    if (m.get(tx, ty) !== T.WALL || !m.inBounds(tx, ty + 1) || m.solid(tx, ty + 1) || (this.occ[ty * m.w + tx] & OCC_DECAL)) {
      return this.fail(kind, tx, ty, opts);
    }
    this.occ[ty * m.w + tx] |= OCC_DECAL;
    return this.make(kind, def, tx, ty, opts);
  }

  /**
   * 把矩形写成实心地形（T.BLOCK / T.LAVA …），带连通保护。
   * 只检查脚印是否可走；调用方负责占用/保留判断。
   */
  blockTiles(tx: number, ty: number, w: number, h: number, tile: number): boolean {
    const m = this.map;
    const old: number[] = [];
    let lost = 0;
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) {
      if (!m.inBounds(x, y) || m.solid(x, y)) return false;
      if (this.seen[y * m.w + x]) lost++;
    }
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) { old.push(m.get(x, y)); m.set(x, y, tile); }
    if (this.anchor >= 0) {
      const n = this.flood();
      if (n !== this.reach - lost) {
        let i = 0;
        for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) m.set(x, y, old[i++]);
        this.flood();
        return false;
      }
      this.reach = n;
    }
    return true;
  }

  /** 实心地形区域（岩浆池）：要求脚印空闲 + clear 圈可走 + spacing 圈无阻挡装饰，再写地形并标记占用 */
  placeTerrain(tx: number, ty: number, w: number, h: number, tile: number, clear = 1, spacing = 2): boolean {
    const m = this.map;
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (!this.isOpen(x, y)) return false;
    if (!this.ringOk(tx, ty, w, h, clear, spacing)) return false;
    if (!this.blockTiles(tx, ty, w, h, tile)) return false;
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) this.occ[y * m.w + x] |= OCC_BLOCK;
    return true;
  }

  private allTile(tx: number, ty: number, w: number, h: number, tile: number): boolean {
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (this.map.get(x, y) !== tile) return false;
    return true;
  }

  private make(kind: DecorKind, def: DecorKindDef, tx: number, ty: number, opts: PlaceOpts): Decor {
    const d: Decor = { id: this.nid++, kind, x: (tx + def.w / 2) * TILE, y: (ty + def.h) * TILE };
    if (def.light) d.light = { ...def.light };
    if (def.block) d.solid = true;
    if (opts.breakable) { d.breakable = true; d.hp = opts.hp ?? 1; }
    if (opts.v !== undefined) d.v = opts.v;
    this.decor.push(d);
    return d;
  }

  private fail(kind: DecorKind, tx: number, ty: number, opts: PlaceOpts): null {
    if (opts.required) this.failures.push(`${kind}@${tx},${ty}`);
    return null;
  }

  /** 从锚点 BFS（4 邻接）统计可达格数，并刷新 seen */
  private flood(): number {
    const m = this.map, w = m.w, seen = this.seen, q = this.queue;
    seen.fill(0);
    if (this.anchor < 0 || m.solid(this.anchor % w, (this.anchor / w) | 0)) return 0;
    let head = 0, tail = 0;
    q[tail++] = this.anchor;
    seen[this.anchor] = 1;
    while (head < tail) {
      const i = q[head++];
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && !seen[i - 1] && !m.solid(x - 1, y)) { seen[i - 1] = 1; q[tail++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && !m.solid(x + 1, y)) { seen[i + 1] = 1; q[tail++] = i + 1; }
      if (y > 0 && !seen[i - w] && !m.solid(x, y - 1)) { seen[i - w] = 1; q[tail++] = i - w; }
      if (y < m.h - 1 && !seen[i + w] && !m.solid(x, y + 1)) { seen[i + w] = 1; q[tail++] = i + w; }
    }
    return tail;
  }
}

/** BFS 距离场（4 邻接，按可走格）；不可达为 -1 */
export function bfsDistance(map: GridMap, sx: number, sy: number): Int32Array {
  const w = map.w, n = w * map.h;
  const dist = new Int32Array(n).fill(-1);
  if (!map.inBounds(sx, sy) || map.solid(sx, sy)) return dist;
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  const s = sy * w + sx;
  q[tail++] = s;
  dist[s] = 0;
  while (head < tail) {
    const i = q[head++];
    const x = i % w, y = (i / w) | 0, d = dist[i] + 1;
    if (x > 0 && dist[i - 1] < 0 && !map.solid(x - 1, y)) { dist[i - 1] = d; q[tail++] = i - 1; }
    if (x < w - 1 && dist[i + 1] < 0 && !map.solid(x + 1, y)) { dist[i + 1] = d; q[tail++] = i + 1; }
    if (y > 0 && dist[i - w] < 0 && !map.solid(x, y - 1)) { dist[i - w] = d; q[tail++] = i - w; }
    if (y < map.h - 1 && dist[i + w] < 0 && !map.solid(x, y + 1)) { dist[i + w] = d; q[tail++] = i + w; }
  }
  return dist;
}
