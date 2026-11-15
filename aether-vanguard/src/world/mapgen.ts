// 地图生成：主城（新手村）、迷宫副本（多主题、3 层、变体房间、出口远离起点）、竞技场。
// 移植自 legacy L713–798（genCity/genDungeon）、L1644（genArenaMap），按改版意见扩充。
// 纯函数：只返回数据，不写全局 G；随机只用 new Rng(seed)。
// 实现拆在 citygen.ts / dungeongen.ts / decor.ts，这里是对外契约。

import { TILE } from '../config';
import { Rng } from '../core/rng';
import { DUNGEONS } from '../data/dungeons';
import { T } from '../data/tiles';
import type { Decor, Npc, Portal } from '../game/types';
import { buildCity } from './citygen';
import { Placer } from './decor';
import { buildDungeon } from './dungeongen';
import { GridMap } from './grid';

export type RoomKind = 'start' | 'normal' | 'elite' | 'supply' | 'event' | 'boss' | 'exit';
export interface Room { x: number; y: number; w: number; h: number; cx: number; cy: number; kind: RoomKind }

/** 副本定义与副本表在 data/dungeons.ts（这里 re-export，保持原契约） */
export type { DungeonDef, DungeonTheme } from '../data/dungeons';
export { DUNGEONS } from '../data/dungeons';
/** 装饰词表（渲染层据此绘制；坐标约定见 decor.ts 文件头） */
export { DECOR_KINDS, INTERACT_DECOR, decorCenter, decorFootprint } from './decor';
export type { DecorKindDef, DecorLight } from './decor';

export interface GenResult {
  map: GridMap;
  spawn: { x: number; y: number };
  npcs: Npc[];
  portals: Portal[];
  decor: Decor[];
  rooms: Room[];
  /** 刷怪候选点（世界坐标） */
  spawnPoints: Array<{ x: number; y: number }>;
  bossSpot?: { x: number; y: number };
  /** 宝箱位置（世界坐标）与品阶 0 小 / 1 中 / 2 大（world.ts 生成为 kind 'chest' 的掉落物） */
  chests: Array<{ x: number; y: number; tier: number }>;
  /** 显示名（横幅 / 小地图标题） */
  name?: string;
  /** 出口（第 1–2 层 'next' 传送阵 / 首领房中心）世界坐标 */
  exit?: { x: number; y: number };
  /** 具名地点（主城：plaza 广场 / portals 传送阵广场 / arena 竞技场门口；竞技场：rival 对手出生点、center 中心） */
  points?: Record<string, { x: number; y: number }>;
  /** 必需摆放失败的记录（调试/测试用，正常为空） */
  failures?: string[];
}

/** 主城（确定性：每次生成完全一样） */
export function genCity(): GenResult {
  return buildCity().gen;
}

/** 迷宫：dungeonId 见 DUNGEONS（含秘境 'secret'），floor 1..floors；同种子同图 */
export function genDungeon(dungeonId: string, floor: number, seed: number): GenResult {
  const def = DUNGEONS[dungeonId] ?? DUNGEONS.ruins;
  const f = Math.max(1, Math.min(def.floors, Math.floor(floor) || 1));
  return buildDungeon(def, f, seed >>> 0);
}

/** 竞技场：34×24 格，圆形场地（半径 9 格 = 288），外圈遗迹地面环；柱子 + 火把 + 火盆 */
export const ARENA_W = 34;
export const ARENA_H = 24;
export const ARENA_RADIUS = 9 * TILE;

export function genArena(): GenResult {
  const W = ARENA_W, H = ARENA_H, cx = W / 2, cy = H / 2;
  const map = new GridMap(W, H, 'arena', T.WALL);
  map.fog = false;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    // 用格中心计算，圆心 (17,12) 格 = 世界 (544,384)，场地左右/上下对称
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d < 9) map.set(x, y, d > 8.1 ? T.RUIN : T.FLOOR);
  }
  const P = new Placer(map);
  const spawnT = { tx: 17, ty: 16 }, rivalT = { tx: 17, ty: 7 };
  P.reserve(spawnT.tx - 1, spawnT.ty - 1, 2, 2);
  P.reserve(rivalT.tx - 1, rivalT.ty - 1, 2, 2);
  P.setAnchor(spawnT.tx, spawnT.ty);
  // 四根石柱（掩体），关于圆心对称
  for (const [x, y] of [[12, 8], [21, 8], [12, 15], [21, 15]] as const) P.place('column', x, y, { required: true });
  // 南侧两只火盆（南面的墙看不到立面，挂不了火把）
  for (const [x, y] of [[10, 16], [23, 16]] as const) P.place('brazier', x, y, { required: true });
  // 北侧墙面火把：南邻是地面的墙格，隔 3 格一支
  let last = -99;
  for (let x = 1; x < W - 1; x++) {
    for (let y = 1; y < cy; y++) {
      if (map.get(x, y) !== T.WALL || map.solid(x, y + 1)) continue;
      if (x - last >= 3 && P.place('torch', x, y)) last = x;
      break;
    }
  }
  const vr = new Rng(0xa7e1a);
  for (let i = 0; i < map.variant.length; i++) map.variant[i] = vr.int(0, 255);
  const center = { x: cx * TILE, y: cy * TILE };
  return {
    map,
    // legacy：玩家在圆心下方 130，对手在上方 130
    spawn: { x: center.x, y: center.y + 130 },
    npcs: [],
    portals: [],
    decor: P.decor,
    rooms: [],
    spawnPoints: [],
    chests: [],
    name: '镜像竞技场',
    points: { center, rival: { x: center.x, y: center.y - 130 } },
    failures: P.failures,
  };
}
