// 主城「曙光主城」生成（改版意见 #22：新手村人物太少、建筑单调；新手村加药剂商与商铺；存储箱；传送阵去往不同副本）。
// 移植自 legacy genCity（L713–748），重新设计为 64×44 的小镇：
//   外围城墙；草地 / 石板路 / 城石板；中央广场 + 源能井；水池 + 木桥；
//   建筑用装饰表示，脚印写成 T.BLOCK，门在建筑底边正中（门前格可走且与出生点连通）；
//   每个副本一座传送阵（东南传送阵广场）+ 秘境传送阵；竞技场入口有独立传送阵；6+ 个闲逛村民。
// 纯函数、确定性：只用固定种子的 Rng，不写全局状态。

import { TILE } from '../config';
import { Rng } from '../core/rng';
import { DUNGEONS, DUNGEON_ORDER } from '../data/dungeons';
import { LORE } from '../data/lore';
import { T } from '../data/tiles';
import type { Npc, NpcRole, Portal } from '../game/types';
import { DECOR_KINDS, Placer, type DecorKind } from './decor';
import { GridMap } from './grid';
import type { GenResult } from './mapgen';

export const CITY_W = 64;
export const CITY_H = 44;
const CITY_SEED = 0xc17a5eed;

const C = (t: number): number => t * TILE + TILE / 2;

/** 建筑（左上角格坐标）。脚印与 NA 建筑精灵尺寸一致（像素密度统一，改版文档 P0-A），底边中点（门）保持原布局 */
const BUILDINGS: ReadonlyArray<{ kind: DecorKind; tx: number; ty: number; v?: number }> = [
  { kind: 'library', tx: 10, ty: 6 },
  { kind: 'hall', tx: 30, ty: 6 },
  { kind: 'temple', tx: 51, ty: 5 },
  { kind: 'shop_potion', tx: 6, ty: 15 },
  { kind: 'shop_smith', tx: 16, ty: 15 },
  { kind: 'arena_gate', tx: 56, ty: 24 },
  { kind: 'warehouse', tx: 5, ty: 29 },
  { kind: 'house_a', tx: 14, ty: 28, v: 0 },
  { kind: 'house_b', tx: 20, ty: 28, v: 1 },
  { kind: 'house_a', tx: 4, ty: 37, v: 2 },
  { kind: 'house_b', tx: 11, ty: 37, v: 3 },
  { kind: 'house_a', tx: 18, ty: 37, v: 1 },
  { kind: 'house_b', tx: 25, ty: 37, v: 0 },
];

/** 功能 NPC（格坐标；台词取自 LORE.npcs 同名条目） */
const NPCS: ReadonlyArray<{ role: NpcRole; name: string; tx: number; ty: number; sprite: string; facing: 1 | -1 }> = [
  { role: 'gate', name: '守门人 · 迦南', tx: 37, ty: 33, sprite: 'knight_m', facing: 1 },
  { role: 'route', name: '源能议会 · 薇拉', tx: 34, ty: 9, sprite: 'wizzard_f', facing: -1 },
  { role: 'smith', name: '铁匠 · 老陶', tx: 19, ty: 17, sprite: 'dwarf_m', facing: -1 },
  { role: 'fuse', name: '转职师 · 无面', tx: 54, ty: 9, sprite: 'doc', facing: -1 },
  { role: 'scribe', name: '书记官 · 阿禾', tx: 13, ty: 9, sprite: 'wizzard_m', facing: -1 },
  { role: 'potion', name: '药剂商 · 苏芽', tx: 9, ty: 17, sprite: 'elf_f', facing: -1 },
  { role: 'stash', name: '仓库管理员 · 石墩', tx: 10, ty: 31, sprite: 'dwarf_f', facing: -1 },
  { role: 'arena', name: '竞技场管理员 · 铁蔷薇', tx: 59, ty: 26, sprite: 'knight_f', facing: -1 },
  { role: 'secret', name: '秘境向导 · 灰鸦', tx: 60, ty: 39, sprite: 'angel', facing: -1 },
];

/** 闲逛村民的“家”（台词取自 LORE.villagers 同下标） */
const VILLAGERS: ReadonlyArray<{ tx: number; ty: number; sprite: string }> = [
  { tx: 27, ty: 21, sprite: 'elf_m' },
  { tx: 36, ty: 21, sprite: 'knight_m' },
  { tx: 40, ty: 24, sprite: 'pumpkin_dude' },
  { tx: 28, ty: 13, sprite: 'lizard_f' },
  { tx: 43, ty: 22, sprite: 'wogol' },
  { tx: 20, ty: 11, sprite: 'knight_f' },
  { tx: 11, ty: 19, sprite: 'dwarf_m' },
  { tx: 18, ty: 33, sprite: 'elf_f' },
];

/** 传送阵广场：4 座副本传送阵一字排开 + 秘境传送阵 */
const DUNGEON_PORTAL_TX = [39, 44, 49, 54];
const DUNGEON_PORTAL_TY = 35;
const SECRET_PORTAL = { tx: 58, ty: 39 };
const ARENA_PORTAL = { tx: 57, ty: 27 };
const SPAWN = { tx: 31, ty: 25 };
const ARRIVAL = { tx: 49, ty: 38 };
const ARENA_RETURN = { tx: 56, ty: 29 };

export interface CityBuild { gen: GenResult; failures: string[] }

/** 生成主城（返回结果 + 必需摆放的失败列表，测试用） */
export function buildCity(): CityBuild {
  const rng = new Rng(CITY_SEED);
  const W = CITY_W, H = CITY_H;
  const map = new GridMap(W, H, 'city', T.WALL);
  map.fog = false;

  // ---- 1. 地表：草地 + 城墙（北墙 2 格厚，立面更好看）----
  map.fillRect(1, 2, W - 2, H - 3, T.GRASS);
  // 主干道（东西向 / 南北向）
  map.fillRect(2, 10, W - 4, 2, T.PATH);
  map.fillRect(30, 8, 3, H - 9, T.PATH);
  // 中央广场
  map.fillRect(24, 15, 15, 13, T.CITY);
  // 市集街、两条居民巷
  map.fillRect(2, 18, 22, 2, T.PATH);
  map.fillRect(2, 31, 28, 2, T.PATH);
  map.fillRect(2, 40, 28, 2, T.PATH);
  // 传送阵广场 + 连通小路
  map.fillRect(35, 30, 27, 12, T.CITY);
  map.fillRect(33, 28, 3, 2, T.PATH);
  // 各建筑门前小路
  map.fillRect(11, 8, 1, 2, T.PATH); // 书馆
  map.fillRect(52, 8, 1, 2, T.PATH); // 转职殿
  map.fillRect(7, 17, 1, 1, T.PATH); // 药剂铺
  map.fillRect(17, 17, 1, 1, T.PATH); // 铁匠铺
  map.fillRect(15, 30, 1, 1, T.PATH);
  map.fillRect(21, 30, 1, 1, T.PATH);
  map.fillRect(57, 25, 1, 4, T.PATH); // 竞技场入口 → 传送阵
  map.fillRect(53, 29, 9, 1, T.PATH);
  // 水池（圆角）+ 南北向木桥
  for (let y = 13; y <= 20; y++) for (let x = 41; x <= 50; x++) {
    const cornerX = x === 41 || x === 50, cornerY = y === 13 || y === 20;
    if (cornerX && cornerY) continue;
    map.set(x, y, T.WATER);
  }
  map.fillRect(45, 13, 2, 8, T.BRIDGE);
  map.fillRect(45, 12, 2, 1, T.PATH);
  map.fillRect(45, 21, 2, 9, T.PATH);

  const P = new Placer(map);

  // ---- 2. 保留格：出生点、到达点、门口、NPC 站位、传送阵 ----
  P.reserve(SPAWN.tx - 1, SPAWN.ty - 1, 3, 3);
  P.reserve(ARRIVAL.tx - 1, ARRIVAL.ty - 1, 3, 3);
  P.reserve(ARENA_RETURN.tx - 1, ARENA_RETURN.ty - 1, 3, 3);
  for (const b of BUILDINGS) {
    const def = DECOR_KINDS[b.kind];
    const dx = b.tx + Math.floor(def.w / 2), dy = b.ty + def.h;
    P.reserve(dx, dy, 1, 2); // 门前两格
  }
  for (const n of NPCS) P.reserve(n.tx, n.ty);
  for (const tx of DUNGEON_PORTAL_TX) P.reserve(tx - 1, DUNGEON_PORTAL_TY - 1, 3, 3);
  P.reserve(SECRET_PORTAL.tx - 1, SECRET_PORTAL.ty - 1, 3, 3);
  P.reserve(ARENA_PORTAL.tx - 1, ARENA_PORTAL.ty - 1, 3, 3);
  for (const v of VILLAGERS) P.reserve(v.tx, v.ty);
  P.setAnchor(SPAWN.tx, SPAWN.ty);

  // ---- 3. 建筑（必需）----
  for (const b of BUILDINGS) P.place(b.kind, b.tx, b.ty, { required: true, v: b.v });

  // ---- 4. 固定摆设 ----
  const req = { required: true } as const;
  P.place('well', 31, 21, req);
  P.place('statue', 46, 38, req);
  P.place('anvil', 21, 17, req);
  P.place('stash', 9, 29, req);
  for (const [x, y] of [[26, 18], [36, 18], [26, 25], [36, 25]] as const) P.place('bench', x, y, req);
  for (const [x, y] of [[24, 15], [38, 15], [24, 27], [38, 27]] as const) P.place('lamp', x, y, req);
  for (const x of [4, 9, 14]) P.place('stall', x, 21, req);
  P.place('barrel', 3, 16, req);
  P.place('barrel', 22, 14, req);
  P.place('crate', 11, 16, req);
  P.place('crate', 10, 28, req);
  P.place('sign', 33, 13, req);
  P.place('sign', 36, 29, req);
  P.place('sign', 55, 26, req);
  // 东北花园：栅栏围三面，南面敞开
  for (let x = 53; x <= 61; x++) P.place('fence_h', x, 12, req);
  for (let y = 13; y <= 18; y++) P.place('fence_v', 52, y, req);
  for (let y = 13; y <= 18; y += 2) for (let x = 54; x <= 60; x += 2) P.place('flowers', x, y, { v: (x + y) & 3 });
  // 路灯（软摆放：失败不报错）
  for (const [x, y] of [[5, 9], [18, 9], [24, 9], [37, 9], [44, 9], [60, 9], [12, 12], [21, 12], [38, 12],
    [12, 20], [24, 20], [9, 33], [23, 33], [8, 42], [22, 42], [35, 30], [61, 30], [35, 41], [61, 41], [53, 25], [61, 25]] as const) {
    P.place('lamp', x, y);
  }
  // 水池边的花与灌木
  for (const [x, y] of [[40, 14], [40, 17], [51, 15], [51, 19], [42, 21], [49, 21], [44, 12], [48, 12]] as const) {
    P.place(((x + y) & 1) ? 'flowers' : 'bush', x, y, { v: (x * 3 + y) & 3 });
  }

  // ---- 5. 随机点缀（只在草地上；不挡门口/道路；不贴建筑）----
  const noScatter = new Uint8Array(W * H);
  for (const b of BUILDINGS) {
    const def = DECOR_KINDS[b.kind];
    // 建筑周围 1 格、屋顶上方 3 格不种树（屋顶会向上遮挡）
    for (let y = b.ty - 3; y <= b.ty + def.h + 1; y++) for (let x = b.tx - 1; x <= b.tx + def.w; x++) {
      if (map.inBounds(x, y)) noScatter[y * W + x] = 1;
    }
  }
  const grassOk = (x: number, y: number): boolean =>
    map.get(x, y) === T.GRASS && !noScatter[y * W + x] && P.isOpen(x, y);
  const nearKind = (x: number, y: number, kinds: ReadonlySet<string>, r: number): boolean =>
    P.decor.some(d => kinds.has(d.kind) && Math.abs(d.x / TILE - 0.5 - x) <= r && Math.abs(d.y / TILE - 1 - y) <= r);
  const TREES = new Set(['tree']);
  const scatter = (kind: DecorKind, count: number, spacing: number, variants: number): void => {
    let placed = 0;
    for (let tries = 0; tries < count * 40 && placed < count; tries++) {
      const x = rng.int(1, W - 2), y = rng.int(2, H - 2);
      if (!grassOk(x, y)) continue;
      if (spacing > 0 && nearKind(x, y, TREES, spacing)) continue;
      // 树冠精灵约 2×2 格（脚印只有 1 格）：与路灯/告示牌/摊位/长椅等阻挡摆设至少隔 1 格，避免树冠盖住它们
      const gap = DECOR_KINDS[kind].block ? 1 : 0;
      if (P.place(kind, x, y, { v: rng.int(0, variants - 1), spacing: gap })) placed++;
    }
  };
  scatter('tree', 48, 1, 3);
  scatter('bush', 24, 0, 3);
  scatter('flowers', 44, 0, 4);

  // ---- 6. NPC、村民、传送阵 ----
  const npcs: Npc[] = [];
  for (const n of NPCS) {
    const lore = LORE.npcs.find(l => l.n === n.name);
    npcs.push({
      id: P.newId(), role: n.role, name: n.name, line: lore?.t ?? '……',
      x: C(n.tx), y: C(n.ty), r: 10, sprite: n.sprite, facing: n.facing,
    });
  }
  VILLAGERS.forEach((v, i) => {
    const lore = LORE.villagers[i % LORE.villagers.length];
    npcs.push({
      id: P.newId(), role: 'villager', name: lore.n, line: lore.lines[0] ?? '……',
      x: C(v.tx), y: C(v.ty), r: 10, sprite: v.sprite, facing: i % 2 ? -1 : 1, wanderT: 1 + (i % 4) * 0.7,
    });
  });

  const portals: Portal[] = [];
  DUNGEON_ORDER.forEach((id, i) => {
    const def = DUNGEONS[id];
    portals.push({
      id: P.newId(), kind: 'dungeon', x: C(DUNGEON_PORTAL_TX[i]), y: C(DUNGEON_PORTAL_TY), r: 30,
      label: def.name, open: true, target: id,
    });
  });
  portals.push({
    id: P.newId(), kind: 'secret', x: C(SECRET_PORTAL.tx), y: C(SECRET_PORTAL.ty), r: 30,
    label: DUNGEONS.secret.name, open: true, target: 'secret',
  });
  portals.push({
    id: P.newId(), kind: 'arena', x: C(ARENA_PORTAL.tx), y: C(ARENA_PORTAL.ty), r: 30,
    label: '镜像竞技场', open: true, target: 'arena',
  });

  // ---- 7. 地砖变体 ----
  const vr = new Rng(CITY_SEED ^ 0x5f3759df);
  for (let i = 0; i < map.variant.length; i++) map.variant[i] = vr.int(0, 255);

  const gen: GenResult = {
    map,
    spawn: { x: C(SPAWN.tx), y: C(SPAWN.ty) },
    npcs,
    portals,
    decor: P.decor,
    rooms: [],
    spawnPoints: [],
    chests: [],
    name: '曙光主城',
    points: {
      plaza: { x: C(SPAWN.tx), y: C(SPAWN.ty) },
      portals: { x: C(ARRIVAL.tx), y: C(ARRIVAL.ty) },
      arena: { x: C(ARENA_RETURN.tx), y: C(ARENA_RETURN.ty) },
    },
  };
  return { gen, failures: P.failures };
}
