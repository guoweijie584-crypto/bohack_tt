// 瓦片网格地图：地形 + 迷雾（explored 已探索 / visible 当前可见 双掩码）

import { TILE } from '../config';
import { OPAQUE, SOLID, T } from '../data/tiles';

/** 阻挡移动的瓦片（VOID/WALL/WATER/LAVA/BLOCK/PIT） */
const SOLID_SET = new Set<number>(Object.keys(SOLID).map(Number));
/** 阻挡视线与投射物的瓦片（只有墙和虚空；水、岩浆、深坑可以隔着射击） */
const OPAQUE_SET = new Set<number>(Object.keys(OPAQUE).map(Number));

export type MapKind = 'city' | 'dungeon' | 'arena';

export class GridMap {
  readonly tiles: Uint8Array;
  /** 已探索（永久） */
  readonly explored: Uint8Array;
  /** 当前可见（每次 revealFog 重算） */
  readonly visible: Uint8Array;
  /** 地砖变体（0-255，渲染用，生成时写入） */
  readonly variant: Uint8Array;
  /** 是否启用迷雾（主城/竞技场全亮） */
  fog = true;

  constructor(
    readonly w: number,
    readonly h: number,
    readonly kind: MapKind,
    fill: number = T.WALL,
  ) {
    this.tiles = new Uint8Array(w * h).fill(fill);
    this.explored = new Uint8Array(w * h);
    this.visible = new Uint8Array(w * h);
    this.variant = new Uint8Array(w * h);
  }

  get pixelW(): number { return this.w * TILE; }
  get pixelH(): number { return this.h * TILE; }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h;
  }
  idx(tx: number, ty: number): number { return ty * this.w + tx; }

  /** 越界视为墙（与 legacy tileAt 一致） */
  get(tx: number, ty: number): number {
    return this.inBounds(tx, ty) ? this.tiles[ty * this.w + tx] : T.WALL;
  }
  set(tx: number, ty: number, v: number): void {
    if (this.inBounds(tx, ty)) this.tiles[ty * this.w + tx] = v;
  }
  fillRect(x: number, y: number, w: number, h: number, v: number): void {
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) this.set(tx, ty, v);
  }

  solid(tx: number, ty: number): boolean { return SOLID_SET.has(this.get(tx, ty)); }
  opaque(tx: number, ty: number): boolean { return OPAQUE_SET.has(this.get(tx, ty)); }
  walkable(tx: number, ty: number): boolean { return !this.solid(tx, ty); }

  solidAtWorld(x: number, y: number): boolean { return this.solid(Math.floor(x / TILE), Math.floor(y / TILE)); }
  opaqueAtWorld(x: number, y: number): boolean { return this.opaque(Math.floor(x / TILE), Math.floor(y / TILE)); }

  isExplored(tx: number, ty: number): boolean {
    return !this.fog || (this.inBounds(tx, ty) && this.explored[ty * this.w + tx] === 1);
  }
  isVisible(tx: number, ty: number): boolean {
    return !this.fog || (this.inBounds(tx, ty) && this.visible[ty * this.w + tx] === 1);
  }
  isExploredWorld(x: number, y: number): boolean { return this.isExplored(Math.floor(x / TILE), Math.floor(y / TILE)); }
  isVisibleWorld(x: number, y: number): boolean { return this.isVisible(Math.floor(x / TILE), Math.floor(y / TILE)); }

  /** 统计可走格探索比例（legacy 分母含墙，永远到不了 100%） */
  exploredRatio(): number {
    let walk = 0, seen = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      if (SOLID_SET.has(this.tiles[i])) continue;
      walk++;
      if (this.explored[i]) seen++;
    }
    return walk ? seen / walk : 1;
  }
}

export const tileOf = (v: number): number => Math.floor(v / TILE);
export const tileCenter = (t: number): number => t * TILE + TILE / 2;
