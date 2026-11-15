import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GridMap } from '../src/world/grid';
import { moveCircle, isFree, nearestFree } from '../src/world/collision';
import { FlowField } from '../src/world/flowfield';
import { lineOfSight, raycastDist, computeFov } from '../src/world/los';
import { T } from '../src/data/tiles';
import { TILE } from '../src/config';
import { DECOR_KINDS, decorFootprint, genArena, genCity, genDungeon, DUNGEONS, type GenResult, type Room } from '../src/world/mapgen';
import { buildCity } from '../src/world/citygen';
import { DUNGEON_ORDER, floorPool, globalFloor, secretLevel } from '../src/data/dungeons';
import { ENEMIES } from '../src/data/enemies';
import { LORE } from '../src/data/lore';
import { rng } from '../src/core/rng';
import { G, clearWorld } from '../src/game/state';
import type { Decor, Enemy, Item, Player } from '../src/game/types';

/* ------------------------------------------------------------------ */
/* 跨模块依赖打桩（其它代理的模块此刻可能还是 TODO）                       */
/* ------------------------------------------------------------------ */
const H = vi.hoisted(() => {
  let id = 100000;
  const fakeEnemy = (kind: string, x: number, y: number, opts: { lv?: number; elite?: boolean; boss?: boolean } = {}): Record<string, unknown> => ({
    id: id++, team: 'enemy', kind, x, y, r: 12, hp: 100, maxHp: 100, facing: 1, aim: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0, def: { n: `怪物:${kind}` }, lv: opts.lv ?? 1,
    atk: 10, armor: 0, spd: 60, exp: 30, gold: 12, elite: !!opts.elite, boss: !!opts.boss, bars: 1, shield: 0,
    ai: 'idle', aiT: 0, cdAtk: 0, cdSkill: 0, cdSkill2: 0, orbitDir: 1, aggro: false, phase: 0, spawnT: 0,
  });
  let uid = 1;
  const fakeItem = (lv: number, opts: { rarity?: number; slot?: string; weaponType?: string } = {}): Record<string, unknown> => ({
    uid: `t${uid++}`, slot: opts.slot ?? 'weapon', rarity: opts.rarity ?? 0, affixes: [], lv, name: `测试装备${uid}`,
    value: 10, plus: 0, sprite: 'weapon_knight_sword', weaponType: opts.weaponType,
  });
  return { fakeEnemy, fakeItem };
});

vi.mock('../src/game/enemies', () => ({
  spawnEnemy: vi.fn((kind: string, x: number, y: number, opts?: { lv?: number; elite?: boolean; boss?: boolean }) => H.fakeEnemy(kind, x, y, opts)),
  spawnRival: vi.fn((_cid: string, _route: string, _streak: number, x: number, y: number) => H.fakeEnemy('rival', x, y)),
  updateEnemies: vi.fn(),
}));
vi.mock('../src/game/spawner', () => ({ initSpawner: vi.fn(), updateSpawner: vi.fn() }));
vi.mock('../src/game/save', () => ({ saveGame: vi.fn(), SLOT_COUNT: 4 }));
vi.mock('../src/game/combat', () => ({ damagePlayer: vi.fn(() => 0) }));
vi.mock('../src/game/player', () => ({ gainExp: vi.fn((p: { exp: number }, n: number) => { p.exp += n; }) }));
vi.mock('../src/game/items', () => ({
  rollItem: vi.fn((lv: number, opts?: { rarity?: number; slot?: string; weaponType?: string }) => H.fakeItem(lv, opts)),
  bagHasRoom: vi.fn((p: { bag: unknown[] }, n = 1) => p.bag.length + n <= 24),
  addToBag: vi.fn((p: { bag: unknown[] }, it: unknown) => { if (p.bag.length >= 24) return false; p.bag.push(it); return true; }),
  weaponTypeOf: vi.fn(() => 'sword'),
  POTION_CAP: 99,
  MAT_NAMES: { gem: '源能宝石', part: '机械零件', essence: '元素精华' },
}));

import {
  damageDecorAt, enterArena, enterCity, enterDungeon, enterSecret, getTrial, interact, leaveArena, peekTrial, resolveAltar, spikesUp, updateWorld,
} from '../src/game/world';
import { clickPickup, dropLoot, interactPickup, spawnDrop, updateDrops, INTERACT_R } from '../src/game/drops';
import { spawnEnemy, spawnRival } from '../src/game/enemies';
import { initSpawner } from '../src/game/spawner';
import { addToBag } from '../src/game/items';
import { saveGame } from '../src/game/save';

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */
/** 用字符画建图：# 墙 . 地面 */
function mapFrom(rows: string[]): GridMap {
  const m = new GridMap(rows[0].length, rows.length, 'dungeon', T.WALL);
  rows.forEach((r, y) => [...r].forEach((c, x) => m.set(x, y, c === '#' ? T.WALL : T.FLOOR)));
  return m;
}
const C = (t: number) => t * TILE + TILE / 2;
const tileOf = (v: number) => Math.floor(v / TILE);

/** 4 邻接 BFS 距离（-1 不可达） */
function bfs(m: GridMap, sx: number, sy: number): Int32Array {
  const d = new Int32Array(m.w * m.h).fill(-1);
  const q: number[] = [sy * m.w + sx];
  d[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % m.w, y = (i / m.w) | 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox, ny = y + oy;
      if (!m.inBounds(nx, ny) || m.solid(nx, ny)) continue;
      const j = ny * m.w + nx;
      if (d[j] >= 0) continue;
      d[j] = d[i] + 1;
      q.push(j);
    }
  }
  return d;
}

/** 大体型怪（r ≤ 32）通行图：格角节点，四周 2×2 格全可走才算可站 */
function fatReach(m: GridMap, sx: number, sy: number): Uint8Array {
  const W = m.w + 1;
  const ok = (x: number, y: number) => x >= 1 && y >= 1 && x < m.w && y < m.h &&
    !m.solid(x - 1, y - 1) && !m.solid(x, y - 1) && !m.solid(x - 1, y) && !m.solid(x, y);
  const seen = new Uint8Array(W * (m.h + 1));
  const start = [[sx, sy], [sx + 1, sy], [sx, sy + 1], [sx + 1, sy + 1]].find(([x, y]) => ok(x, y));
  if (!start) return seen;
  const q: Array<[number, number]> = [[start[0], start[1]]];
  seen[start[1] * W + start[0]] = 1;
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h];
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ox, ny = y + oy;
      if (!ok(nx, ny) || seen[ny * W + nx]) continue;
      seen[ny * W + nx] = 1;
      q.push([nx, ny]);
    }
  }
  return seen;
}

const inRoom = (r: Room, tx: number, ty: number) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;

function fakePlayer(): Player {
  return {
    id: 1, team: 'player', x: 0, y: 0, r: 11, hp: 100, maxHp: 200, facing: 1, aim: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0, name: '测试', cid: 'warrior', route: 'magic',
    mp: 20, lv: 5, exp: 0, expNext: 100, sp: 0, tp: 0, stats: { str: 0, agi: 0, int: 0, vit: 0 }, tree: {},
    routeTree: { magic: 0, tech: 0 }, ultList: [], ult: null, gold: 100, kills: 0, bossKills: 0, deaths: 0, playTime: 0,
    bestFloor: 0, fragments: [], fusedFrom: null, equip: { weapon: null, armor: null, trinket: null }, bag: [], stash: [],
    potions: { hp: 0, mp: 0 }, mats: { gem: 0, part: 0, essence: 0 },
    cd: { q: 3, e: 3, r: 3, ult: 3, dash: 1, atk: 1 }, buffs: { shield: 0, shieldT: 0, roar: 0, stealth: 0, field: 0, overload: 0 },
    invuln: 0, hurtT: 99, actT: 99, arenaWins: 0, streak: 0, bestStreak: 0,
    stat: { maxHp: 200, maxMp: 100 } as Player['stat'], dashT: 0, dashVx: 0, dashVy: 0,
  } as Player;
}

function resetG(): Player {
  clearWorld();
  G.events.length = 0;
  G.mode = 'play';
  G.seed = 1;
  G.time = 0;
  G.realTime = 0;
  G.map = null;
  const p = fakePlayer();
  G.player = p;
  return p;
}

/** 默认 5 个种子；WORLD_STRESS=N 时跑 N 个种子做压力测试 */
const STRESS = Number(process.env.WORLD_STRESS ?? 0);
const SEEDS = STRESS > 0 ? Array.from({ length: STRESS }, (_, i) => (i * 2654435761) >>> 0) : [1, 7, 42, 1337, 90210];

/* ------------------------------------------------------------------ */
/* 基础：碰撞 / 流场 / 视线（主代理已有用例）                              */
/* ------------------------------------------------------------------ */
describe('collision', () => {
  const m = mapFrom([
    '##########',
    '#........#',
    '#........#',
    '#...##...#',
    '#........#',
    '##########',
  ]);
  it('slides along a wall instead of stopping (legacy moveEnt bug)', () => {
    const b = { x: C(2), y: C(1) + 4, r: 11 };
    moveCircle(m, b, 40, -40); // 斜着撞上方墙
    expect(b.y).toBeGreaterThanOrEqual(TILE + 11 - 0.1); // 没进墙
    expect(b.x).toBeGreaterThan(C(2) + 30); // 但 x 方向继续滑动
  });
  it('never tunnels through walls at high speed', () => {
    const b = { x: C(2), y: C(2), r: 11 };
    moveCircle(m, b, 0, -500);
    expect(isFree(m, b.x, b.y, b.r)).toBe(true);
    expect(b.y).toBeGreaterThan(TILE);
  });
  it('nearestFree rescues an embedded body', () => {
    const p = nearestFree(m, C(4) + 3, C(3), 11);
    expect(isFree(m, p.x, p.y, 11)).toBe(true);
  });
});

describe('flow field', () => {
  // U 形：目标在墙另一侧，直线追击会顶墙
  const m = mapFrom([
    '#########',
    '#.......#',
    '#.#####.#',
    '#.#...#.#',
    '#.#.#.#.#',
    '#...#...#',
    '#########',
  ]);
  it('routes around walls to reach target', () => {
    const ff = new FlowField(m);
    ff.update(C(3), C(5)); // 目标在左下内侧
    const b = { x: C(5), y: C(5), r: 10 };
    const d = { x: 0, y: 0 };
    let steps = 0;
    while (steps++ < 2000) {
      if (!ff.dirAt(b.x, b.y, d)) break;
      moveCircle(m, b, d.x * 2, d.y * 2);
    }
    expect(Math.floor(b.x / TILE)).toBe(3);
    expect(Math.floor(b.y / TILE)).toBe(5);
  });
});

describe('line of sight', () => {
  const m = mapFrom(['#######', '#.....#', '#..#..#', '#.....#', '#######']);
  it('blocks through walls, passes in open space', () => {
    expect(lineOfSight(m, C(1), C(2), C(5), C(2))).toBe(false);
    expect(lineOfSight(m, C(1), C(1), C(5), C(1))).toBe(true);
    expect(raycastDist(m, C(1), C(2), 0, 400)).toBeLessThan(C(3) - C(1));
  });
  it('fov marks walls visible but not tiles behind them', () => {
    computeFov(m, C(1), C(2), 8);
    expect(m.isVisible(3, 2)).toBe(true); // 墙本身
    expect(m.isVisible(5, 2)).toBe(false); // 墙后
    expect(m.isExplored(1, 1)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 副本表                                                               */
/* ------------------------------------------------------------------ */
describe('dungeon table', () => {
  it('4 main dungeons × 3 floors + single-floor secret; mapgen re-exports the same table', () => {
    expect(DUNGEON_ORDER).toEqual(['ruins', 'magma', 'frost', 'crypt']);
    for (const id of DUNGEON_ORDER) {
      expect(DUNGEONS[id].floors).toBe(3);
      expect(DUNGEONS[id].pools).toHaveLength(3);
    }
    expect(DUNGEONS.secret.floors).toBe(1);
    expect(DUNGEONS.ruins.lv).toBe(1);
    expect(DUNGEONS.magma.lv).toBe(12);
    expect(DUNGEONS.frost.lv).toBe(22);
    expect(DUNGEONS.crypt.lv).toBe(32);
    expect(DUNGEONS.ruins.boss).toBe('warden');
    expect(floorPool('frost', 2)).toEqual(['frost', 'zombie', 'orc_warrior', 'necromancer']);
    expect(globalFloor('magma', 2)).toBe(5);
    expect(globalFloor('secret', 1)).toBe(0);
    expect(secretLevel(1)).toBeGreaterThanOrEqual(DUNGEONS.secret.lv);
    expect(secretLevel(12)).toBeGreaterThan(secretLevel(4));
  });
  it('lore keeps the legacy fragments and adds one per main-dungeon floor', () => {
    expect(LORE.fragments[0]).toContain('源能井第一次喷发');
    expect(LORE.fragments[5]).toContain('井底有什么');
    expect(LORE.fragments.length).toBe(12);
    expect(LORE.villagers.length).toBeGreaterThanOrEqual(6);
    for (const id of Object.keys(DUNGEONS)) expect(LORE.dungeons[id]).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 迷宫生成                                                             */
/* ------------------------------------------------------------------ */
describe('genDungeon', () => {
  it('is deterministic: same seed → same map; different seed → different map', () => {
    const a = genDungeon('ruins', 1, 777), b = genDungeon('ruins', 1, 777), c = genDungeon('ruins', 1, 778);
    expect(Array.from(a.map.tiles)).toEqual(Array.from(b.map.tiles));
    expect(Array.from(a.map.variant)).toEqual(Array.from(b.map.variant));
    expect(a.rooms).toEqual(b.rooms);
    expect(a.decor).toEqual(b.decor);
    expect(a.chests).toEqual(b.chests);
    expect(a.portals).toEqual(b.portals);
    expect(a.npcs).toEqual(b.npcs);
    expect(a.spawnPoints).toEqual(b.spawnPoints);
    expect(a.spawn).toEqual(b.spawn);
    expect(Array.from(a.map.tiles)).not.toEqual(Array.from(c.map.tiles));
  });

  for (const id of [...DUNGEON_ORDER, 'secret']) {
    const floors = DUNGEONS[id].floors;
    for (let floor = 1; floor <= floors; floor++) {
      it(`${id} F${floor}: connected, 3-wide corridors, big-monster passable, exit far, valid spawns`, () => {
        for (const seed of SEEDS) {
          const g = genDungeon(id, floor, seed);
          const m = g.map;
          const tag = `${id} F${floor} seed ${seed}`;
          expect(g.failures ?? [], tag).toEqual([]);
          expect(m.fog).toBe(true);
          const sx = tileOf(g.spawn.x), sy = tileOf(g.spawn.y);
          expect(m.walkable(sx, sy), tag).toBe(true);
          const start = g.rooms.filter(r => r.kind === 'start');
          expect(start, tag).toHaveLength(1);
          expect(inRoom(start[0], sx, sy)).toBe(true);

          // 1) 所有房间连通（每个房间至少有一格从出生点可达）
          const d = bfs(m, sx, sy);
          for (const r of g.rooms) {
            let ok = false;
            for (let y = r.y; y < r.y + r.h && !ok; y++) for (let x = r.x; x < r.x + r.w && !ok; x++) if (d[y * m.w + x] >= 0) ok = true;
            expect(ok, `${tag} room ${r.kind}@${r.x},${r.y}`).toBe(true);
          }

          // 2) 走廊宽度 ≥ 3：房间外的每个可走格都落在某个全可走的 3×3 窗口里
          for (let y = 1; y < m.h - 1; y++) for (let x = 1; x < m.w - 1; x++) {
            if (m.solid(x, y) || g.rooms.some(r => inRoom(r, x, y))) continue;
            let covered = false;
            for (let y0 = y - 2; y0 <= y && !covered; y0++) for (let x0 = x - 2; x0 <= x && !covered; x0++) {
              let all = true;
              for (let yy = y0; yy < y0 + 3 && all; yy++) for (let xx = x0; xx < x0 + 3 && all; xx++) if (m.solid(xx, yy)) all = false;
              if (all) covered = true;
            }
            expect(covered, `${tag} narrow corridor at ${x},${y}`).toBe(true);
          }

          // 3) 大体型怪（r ≤ 32，Boss r=26）能从起点走到每个房间
          const fat = fatReach(m, sx, sy);
          for (const r of g.rooms) {
            let ok = false;
            for (let y = r.y + 1; y < r.y + r.h && !ok; y++) for (let x = r.x + 1; x < r.x + r.w && !ok; x++) if (fat[y * (m.w + 1) + x]) ok = true;
            expect(ok, `${tag} big monster cannot reach ${r.kind}@${r.x},${r.y}`).toBe(true);
          }

          // 4) 出口/首领房远离起点
          const roomDist = (r: Room): number => {
            const c = d[r.cy * m.w + r.cx];
            if (c >= 0) return c;
            let best = -1;
            for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) best = Math.max(best, d[y * m.w + x]);
            return best;
          };
          const maxD = Math.max(...g.rooms.map(roomDist));
          const last = floor >= floors || id === 'secret';
          const next = g.portals.filter(p => p.kind === 'next');
          if (last) {
            expect(next, tag).toHaveLength(0);
            expect(g.bossSpot, tag).toBeDefined();
            const boss = g.rooms.filter(r => r.kind === 'boss');
            expect(boss, tag).toHaveLength(1);
            expect(inRoom(boss[0], tileOf(g.bossSpot!.x), tileOf(g.bossSpot!.y))).toBe(true);
            // 首领房是最大的房间
            for (const r of g.rooms) if (r !== boss[0]) expect(r.w * r.h, tag).toBeLessThan(boss[0].w * boss[0].h);
            // 起点 = 离首领房最远的房间（从首领出发 BFS），且距离足够远
            const bd = d[tileOf(g.bossSpot!.y) * m.w + tileOf(g.bossSpot!.x)];
            const fromBoss = bfs(m, tileOf(g.bossSpot!.x), tileOf(g.bossSpot!.y));
            const farthestFromBoss = Math.max(...g.rooms.map(r => {
              let best = -1;
              for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) best = Math.max(best, fromBoss[y * m.w + x]);
              return best;
            }));
            expect(bd, tag).toBeGreaterThanOrEqual(id === 'secret' ? 25 : 40);
            expect(bd, tag).toBeGreaterThanOrEqual(0.75 * farthestFromBoss);
            expect(maxD).toBeGreaterThan(0);
          } else {
            expect(next, tag).toHaveLength(1);
            expect(next[0].open).toBe(true);
            expect(next[0].target).toBe(String(floor + 1));
            const exitRoom = g.rooms.filter(r => r.kind === 'exit');
            expect(exitRoom, tag).toHaveLength(1);
            expect(inRoom(exitRoom[0], tileOf(next[0].x), tileOf(next[0].y))).toBe(true);
            const ed = d[tileOf(next[0].y) * m.w + tileOf(next[0].x)];
            expect(ed, tag).toBeGreaterThanOrEqual(30);
            expect(ed, tag).toBeGreaterThanOrEqual(0.75 * maxD);
          }
          // 起点房有回城传送阵
          expect(g.portals.filter(p => p.kind === 'city' && inRoom(start[0], tileOf(p.x), tileOf(p.y))), tag).toHaveLength(1);

          // 5) 刷怪点都可走（且能站下 r=16 的怪），不在起点房
          expect(g.spawnPoints.length, tag).toBeGreaterThan(50);
          for (const s of g.spawnPoints) {
            expect(m.walkable(tileOf(s.x), tileOf(s.y)), tag).toBe(true);
            expect(isFree(m, s.x, s.y, 16), tag).toBe(true);
            expect(inRoom(start[0], tileOf(s.x), tileOf(s.y)), tag).toBe(false);
            expect(d[tileOf(s.y) * m.w + tileOf(s.x)], tag).toBeGreaterThanOrEqual(0);
          }

          // 6) 装饰：只用词表里的 kind；阻挡物脚印是 T.BLOCK；火把在“南邻为地面”的墙上
          for (const dc of g.decor) {
            const k = DECOR_KINDS[dc.kind];
            expect(k, `${tag} unknown decor ${dc.kind}`).toBeDefined();
            const fp = decorFootprint(dc);
            if (k.wall) {
              expect(m.get(fp.tx, fp.ty)).toBe(T.WALL);
              expect(m.walkable(fp.tx, fp.ty + 1)).toBe(true);
            } else if (k.block) {
              for (let y = fp.ty; y < fp.ty + fp.h; y++) for (let x = fp.tx; x < fp.tx + fp.w; x++) expect(m.get(x, y)).toBe(T.BLOCK);
            } else {
              expect(m.walkable(fp.tx, fp.ty), `${tag} decal ${dc.kind} on solid`).toBe(true);
            }
            if (k.light) expect(dc.light).toEqual(k.light);
          }
          expect(g.decor.some(dc => dc.kind === 'torch'), tag).toBe(true);

          // 7) 宝箱：可走且可达，品阶 0–2
          for (const c of g.chests) {
            expect(c.tier).toBeGreaterThanOrEqual(0);
            expect(c.tier).toBeLessThanOrEqual(2);
            expect(d[tileOf(c.y) * m.w + tileOf(c.x)], tag).toBeGreaterThanOrEqual(0);
          }
          if (id !== 'secret') expect(g.chests.length, tag).toBeGreaterThanOrEqual(1);

          // 8) 变体房间：补给泉 + 药剂商、事件祭坛
          if (id !== 'secret') {
            const supply = g.rooms.filter(r => r.kind === 'supply');
            const event = g.rooms.filter(r => r.kind === 'event');
            expect(supply, tag).toHaveLength(1);
            expect(event, tag).toHaveLength(1);
            expect(g.rooms.filter(r => r.kind === 'elite').length, tag).toBe(floor >= 2 ? 2 : 1);
            const inSupply = (x: number, y: number) => inRoom(supply[0], tileOf(x), tileOf(y - 1));
            expect(g.decor.some(dc => dc.kind === 'fountain' && inSupply(dc.x, dc.y)), tag).toBe(true);
            expect(g.npcs.some(n => n.role === 'potion' && inRoom(supply[0], tileOf(n.x), tileOf(n.y))), tag).toBe(true);
            expect(g.decor.some(dc => dc.kind === 'altar' && inRoom(event[0], tileOf(dc.x), tileOf(dc.y - 1))), tag).toBe(true);
          }
        }
      });
    }
  }

  it('themes place their signature decor (magma lava + vents, frost crystals, crypt graves)', () => {
    const count = (id: string, pred: (g: GenResult) => boolean) =>
      SEEDS.flatMap(s => [1, 2, 3].map(f => genDungeon(id, f, s))).filter(pred).length;
    const n = SEEDS.length * 3;
    expect(count('magma', g => g.decor.some(d => d.kind === 'lava_vent') && Array.from(g.map.tiles).includes(T.LAVA))).toBeGreaterThan(n * 0.4);
    expect(count('frost', g => g.decor.some(d => d.kind === 'crystal'))).toBeGreaterThan(n * 0.7);
    expect(count('crypt', g => g.decor.some(d => d.kind === 'grave' || d.kind === 'cobweb'))).toBeGreaterThan(n * 0.7);
    expect(count('ruins', g => Array.from(g.map.tiles).includes(T.RUIN))).toBe(n);
  });
});

/* ------------------------------------------------------------------ */
/* 主城生成                                                             */
/* ------------------------------------------------------------------ */
describe('genCity', () => {
  const { gen: g, failures } = buildCity();
  const m = g.map;
  const sx = tileOf(g.spawn.x), sy = tileOf(g.spawn.y);
  const d = bfs(m, sx, sy);
  const reach = (x: number, y: number) => d[tileOf(y) * m.w + tileOf(x)] >= 0;

  it('is a 64×44 fog-free town and deterministic', () => {
    expect(failures).toEqual([]);
    expect(m.w).toBe(64);
    expect(m.h).toBe(44);
    expect(m.fog).toBe(false);
    expect(m.kind).toBe('city');
    const again = genCity();
    expect(Array.from(again.map.tiles)).toEqual(Array.from(m.tiles));
    expect(again.decor.length).toBe(g.decor.length);
    for (const t of [T.GRASS, T.PATH, T.CITY, T.WATER, T.BRIDGE, T.BLOCK]) expect(Array.from(m.tiles)).toContain(t);
  });

  it('has every shop/NPC/portal the redesign asks for', () => {
    const roles = new Set(g.npcs.map(n => n.role));
    for (const r of ['gate', 'route', 'smith', 'fuse', 'scribe', 'arena', 'potion', 'stash', 'secret'] as const) expect(roles.has(r), r).toBe(true);
    expect(g.npcs.filter(n => n.role === 'villager').length).toBeGreaterThanOrEqual(6);
    for (const n of g.npcs) expect(n.line.length).toBeGreaterThan(0);
    const dun = g.portals.filter(p => p.kind === 'dungeon');
    expect(dun.map(p => p.target)).toEqual([...DUNGEON_ORDER]);
    expect(g.portals.filter(p => p.kind === 'secret' && p.target === 'secret')).toHaveLength(1);
    expect(g.portals.filter(p => p.kind === 'arena')).toHaveLength(1);
    const kinds = new Set(g.decor.map(x => x.kind));
    for (const k of ['shop_potion', 'shop_smith', 'anvil', 'hall', 'temple', 'library', 'arena_gate', 'warehouse', 'stash', 'house_a', 'house_b',
      'well', 'tree', 'bush', 'flowers', 'lamp', 'fence_h', 'fence_v', 'stall', 'bench', 'statue', 'barrel', 'crate', 'sign']) {
      expect(kinds.has(k), k).toBe(true);
    }
    expect(g.decor.filter(x => x.kind === 'lamp').every(x => x.light)).toBe(true);
    // 守门人在传送阵旁
    const gate = g.npcs.find(n => n.role === 'gate')!;
    expect(Math.min(...dun.map(p => Math.hypot(p.x - gate.x, p.y - gate.y)))).toBeLessThan(6 * TILE);
  });

  it('NPCs, portals and building footprints never overlap', () => {
    const owner = new Map<number, string>();
    for (const dc of g.decor) {
      const k = DECOR_KINDS[dc.kind];
      expect(k, dc.kind).toBeDefined();
      if (!k.block) continue;
      const fp = decorFootprint(dc);
      for (let y = fp.ty; y < fp.ty + fp.h; y++) for (let x = fp.tx; x < fp.tx + fp.w; x++) {
        const i = y * m.w + x;
        expect(owner.has(i), `${dc.kind} overlaps ${owner.get(i)} at ${x},${y}`).toBe(false);
        owner.set(i, dc.kind);
        expect(m.get(x, y)).toBe(T.BLOCK);
      }
    }
    const things = [...g.npcs.map(n => ({ x: n.x, y: n.y, r: n.r, k: `npc ${n.name}` })), ...g.portals.map(p => ({ x: p.x, y: p.y, r: p.r, k: `portal ${p.label}` }))];
    for (const t of things) {
      expect(owner.has(tileOf(t.y) * m.w + tileOf(t.x)), `${t.k} inside a footprint`).toBe(false);
      expect(isFree(m, t.x, t.y, 10), `${t.k} not free`).toBe(true);
    }
    for (let i = 0; i < things.length; i++) for (let j = i + 1; j < things.length; j++) {
      const a = things[i], b = things[j];
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.k} vs ${b.k}`).toBeGreaterThanOrEqual(TILE);
    }
    for (const p of g.portals) for (const q of g.portals) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(2 * TILE);
  });

  it('scattered trees keep a 1-tile gap from other blocking props (2×2 canopy must not cover lamps/signs/stalls)', () => {
    const trees = g.decor.filter(x => x.kind === 'tree');
    expect(trees.length).toBeGreaterThanOrEqual(30);
    for (const t of trees) {
      const a = decorFootprint(t);
      for (const o of g.decor) {
        if (o === t || !DECOR_KINDS[o.kind].block) continue;
        const b = decorFootprint(o);
        const dx = Math.max(b.tx - (a.tx + a.w - 1), a.tx - (b.tx + b.w - 1), 0);
        const dy = Math.max(b.ty - (a.ty + a.h - 1), a.ty - (b.ty + b.h - 1), 0);
        expect(Math.max(dx, dy), `tree@${a.tx},${a.ty} touches ${o.kind}@${b.tx},${b.ty}`).toBeGreaterThan(1);
      }
    }
  });

  it('every door, NPC and portal is reachable from the spawn', () => {
    const buildings = g.decor.filter(x => DECOR_KINDS[x.kind].building);
    expect(buildings.length).toBeGreaterThanOrEqual(12);
    for (const b of buildings) {
      const fp = decorFootprint(b);
      const doorX = fp.tx + Math.floor(fp.w / 2), stepY = fp.ty + fp.h; // 门在底边正中，门前一格
      expect(m.walkable(doorX, stepY), `${b.kind} doorstep`).toBe(true);
      expect(d[stepY * m.w + doorX], `${b.kind} doorstep unreachable`).toBeGreaterThanOrEqual(0);
    }
    for (const n of g.npcs) expect(reach(n.x, n.y), n.name).toBe(true);
    for (const p of g.portals) expect(reach(p.x, p.y), p.label).toBe(true);
    for (const pt of Object.values(g.points ?? {})) expect(reach(pt.x, pt.y)).toBe(true);
    // 没有被封死的角落：所有可走格都与出生点连通
    for (let i = 0; i < m.tiles.length; i++) if (!m.solid(i % m.w, (i / m.w) | 0)) expect(d[i], `pocket at ${i % m.w},${(i / m.w) | 0}`).toBeGreaterThanOrEqual(0);
  });
});

describe('genArena', () => {
  it('is a 34×24 circular arena of radius 288 with columns and torches', () => {
    const a = genArena();
    const m = a.map;
    expect(m.w).toBe(34);
    expect(m.h).toBe(24);
    expect(m.fog).toBe(false);
    expect(a.failures).toEqual([]);
    const cx = 17 * TILE, cy = 12 * TILE;
    expect(m.walkable(tileOf(cx), tileOf(cy))).toBe(true);
    expect(m.solidAtWorld(cx + 300, cy)).toBe(true);
    expect(m.solidAtWorld(cx, cy - 300)).toBe(true);
    expect(m.walkable(tileOf(cx + 270), tileOf(cy))).toBe(true);
    expect(isFree(m, a.spawn.x, a.spawn.y, 11)).toBe(true);
    expect(isFree(m, a.points!.rival.x, a.points!.rival.y, 12)).toBe(true);
    expect(a.decor.filter(x => x.kind === 'column')).toHaveLength(4);
    expect(a.decor.some(x => x.kind === 'torch')).toBe(true);
    const d = bfs(m, tileOf(a.spawn.x), tileOf(a.spawn.y));
    expect(d[tileOf(a.points!.rival.y) * m.w + tileOf(a.points!.rival.x)]).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 场景流转与交互                                                        */
/* ------------------------------------------------------------------ */
describe('world flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetG();
  });

  it('enterCity sets up the town and places the player on a free tile', () => {
    enterCity();
    const p = G.player!;
    expect(G.scene).toBe('city');
    expect(G.theme).toBe('city');
    expect(G.floor).toBe(0);
    expect(G.flow).not.toBeNull();
    expect(G.spawnPoints).toEqual([]);
    expect(isFree(G.map!, p.x, p.y, p.r)).toBe(true);
    expect(G.events.some(e => e.t === 'banner' && e.text === '曙光主城')).toBe(true);
    expect(G.events.some(e => e.t === 'ui' && e.what === 'hud')).toBe(true);
    // 传送阵到达点在传送阵广场
    enterCity('portal');
    const gate = G.npcs.find(n => n.role === 'gate')!;
    expect(Math.hypot(G.player!.x - gate.x, G.player!.y - gate.y)).toBeLessThan(14 * TILE);
    // 实体 id 全局唯一
    const ids = [...G.npcs, ...G.portals, ...G.decor].map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('enterDungeon spawns by the level rule, starts the spawner, chests, fragments, save', () => {
    const p = G.player!;
    enterDungeon('ruins', 1);
    expect(G.scene).toBe('dungeon');
    expect(G.theme).toBe('ruins');
    expect(G.dungeonId).toBe('ruins');
    expect(G.floor).toBe(1);
    expect(G.map!.fog).toBe(true);
    expect(G.spawnPoints.length).toBeGreaterThan(50);
    expect(isFree(G.map!, p.x, p.y, p.r)).toBe(true);
    const calls = vi.mocked(spawnEnemy).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const [kind, , , opts] of calls) {
      expect(ENEMIES[kind]).toBeDefined();
      expect(DUNGEONS.ruins.pools[0]).toContain(kind);
      expect(opts!.lv).toBeGreaterThanOrEqual(1);
      expect(opts!.lv).toBeLessThanOrEqual(1 + 2); // 推荐等级 + (层-1)×2 + rng(0..2)
    }
    expect(calls.some(c => c[3]?.elite)).toBe(true); // 精英房
    expect(G.enemies.length).toBe(calls.length);
    expect(initSpawner).toHaveBeenCalledTimes(1);
    const [pool, cap, mul, lv] = vi.mocked(initSpawner).mock.calls[0];
    expect(pool.length).toBeGreaterThan(0);
    expect(cap).toBe(14 + 4);
    expect(mul).toBeCloseTo(1.12);
    expect(lv).toBe(1);
    expect(G.drops.filter(d => d.kind === 'chest').length).toBeGreaterThanOrEqual(1);
    expect(p.fragments).toEqual([0]);
    expect(p.bestFloor).toBe(1);
    expect(G.events.some(e => e.t === 'banner' && e.text === '遗迹迷宫 · 第 1 层')).toBe(true);
    expect(saveGame).toHaveBeenCalled();
    // 不再跟随玩家等级：同一层，玩家 50 级时怪物等级不变
    vi.clearAllMocks();
    p.lv = 50;
    enterDungeon('crypt', 2);
    for (const [, , , opts] of vi.mocked(spawnEnemy).mock.calls) {
      expect(opts!.lv).toBeGreaterThanOrEqual(34);
      expect(opts!.lv).toBeLessThanOrEqual(36);
    }
  });

  it('walking into the open next-floor portal enters the next floor (no need to clear)', () => {
    const p = G.player!;
    enterDungeon('ruins', 1);
    expect(G.enemies.length).toBeGreaterThan(0); // 怪还活着
    const exit = G.portals.find(pt => pt.kind === 'next')!;
    expect(exit.open).toBe(true);
    // 站在旁边（交互半径内、触发半径外）：只有提示
    p.x = exit.x + exit.r + 8; p.y = exit.y;
    updateWorld(1);
    expect(G.floor).toBe(1);
    expect(G.hint?.text).toContain('第 2 层');
    // 走进去
    p.hp = 100;
    vi.clearAllMocks();
    p.x = exit.x; p.y = exit.y;
    updateWorld(1 / 60);
    expect(G.floor).toBe(2);
    expect(G.dungeonId).toBe('ruins');
    expect(p.hp).toBe(140); // 回复 20% 最大生命
    expect(initSpawner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(initSpawner).mock.calls[0][1]).toBe(14 + 8);
    expect(vi.mocked(initSpawner).mock.calls[0][3]).toBe(3);
    // 新层落地后有传送阵冷却，不会立刻再次触发
    const exit2 = G.portals.find(pt => pt.kind === 'next')!;
    p.x = exit2.x; p.y = exit2.y;
    updateWorld(1 / 60);
    expect(G.floor).toBe(2);
  });

  it('boss floor: no exit until the boss dies, then a city portal opens', () => {
    enterDungeon('magma', 3);
    expect(G.portals.some(pt => pt.kind === 'next')).toBe(false);
    expect(G.boss).not.toBeNull();
    const bossCall = vi.mocked(spawnEnemy).mock.calls.find(c => c[3]?.boss);
    expect(bossCall).toBeDefined();
    expect(bossCall![3]!.lv).toBe(12 + 4 + 2);
    const cities = G.portals.filter(pt => pt.kind === 'city').length;
    updateWorld(1 / 60);
    expect(G.portals.filter(pt => pt.kind === 'city').length).toBe(cities);
    (G.boss as Enemy).dead = true;
    updateWorld(1 / 60);
    expect(G.boss).toBeNull();
    expect(G.portals.filter(pt => pt.kind === 'city').length).toBe(cities + 1);
    expect(G.events.some(e => e.t === 'banner' && e.text === '回城传送阵已开启')).toBe(true);
    const portal = G.portals.filter(pt => pt.kind === 'city').pop()!;
    expect(isFree(G.map!, portal.x, portal.y, 11)).toBe(true);
  });

  it('F on NPCs opens their panels; villagers open a dialog with their id', () => {
    enterCity();
    const p = G.player!;
    const want: Record<string, string> = { gate: 'portal', route: 'route', smith: 'shop_smith', fuse: 'fuse', scribe: 'lore', arena: 'arena', potion: 'shop_potion', stash: 'stash', secret: 'secret' };
    for (const [role, panel] of Object.entries(want)) {
      const n = G.npcs.find(x => x.role === role)!;
      G.events.length = 0;
      p.x = n.x + 20; p.y = n.y + 20;
      interact();
      const ev = G.events.find(e => e.t === 'openPanel');
      expect(ev, role).toEqual({ t: 'openPanel', panel });
    }
    const v = G.npcs.find(x => x.role === 'villager')!;
    G.events.length = 0;
    p.x = v.x + 10; p.y = v.y;
    interact();
    expect(G.events.find(e => e.t === 'openPanel')).toEqual({ t: 'openPanel', panel: 'dialog', arg: String(v.id) });
  });

  it('F on portals: dungeon/secret → portal panel, arena → arena panel', () => {
    enterCity();
    const p = G.player!;
    for (const pt of G.portals) {
      G.events.length = 0;
      p.x = pt.x; p.y = pt.y + 10;
      interact();
      const ev = G.events.find(e => e.t === 'openPanel');
      if (pt.kind === 'arena') expect(ev).toEqual({ t: 'openPanel', panel: 'arena' });
      else expect(ev).toEqual({ t: 'openPanel', panel: 'portal', arg: pt.target });
    }
  });

  it('hint radius equals interact radius (legacy showed hints it could not act on)', () => {
    enterCity();
    const p = G.player!;
    const n = G.npcs.find(x => x.role === 'smith')!;
    p.x = n.x; p.y = n.y + INTERACT_R - 6;
    updateWorld(1 / 60);
    expect(G.hint?.text).toBe(`F 与 ${n.name} 交谈`);
    p.y = n.y + INTERACT_R + 6;
    updateWorld(1 / 60);
    expect(G.hint?.text ?? '').not.toContain(n.name);
    G.events.length = 0;
    interact();
    expect(G.events.some(e => e.t === 'openPanel' && e.panel === 'shop_smith')).toBe(false);
  });

  it('supply fountain refills once; event altar offers a one-time choice', () => {
    const p = G.player!;
    enterDungeon('frost', 1);
    const f = G.decor.find(d => d.kind === 'fountain')!;
    p.x = f.x; p.y = f.y + 20; p.hp = 10; p.mp = 1;
    interact();
    expect(p.hp).toBe(200);
    expect(p.mp).toBe(100);
    expect(f.v).toBe(1);
    p.hp = 10;
    interact();
    expect(p.hp).toBe(10);

    const a = G.decor.find(d => d.kind === 'altar')!;
    p.x = a.x; p.y = a.y + 20; p.hp = 200;
    G.events.length = 0;
    interact();
    expect(G.events.find(e => e.t === 'openPanel')).toEqual({ t: 'openPanel', panel: 'dialog', arg: 'event' });
    const before = G.drops.filter(d => d.kind === 'item').length;
    expect(resolveAltar(0)).toBe(true);
    expect(p.hp).toBe(140);
    expect(G.drops.filter(d => d.kind === 'item').length).toBe(before + 1);
    expect(resolveAltar(1)).toBe(false); // 已用过
    interact();
    expect(resolveAltar(1)).toBe(false);
  });

  it('arena: rival death → win rewards after a short pause; loss returns home at full HP', () => {
    const p = G.player!;
    enterCity();
    enterArena();
    expect(G.scene).toBe('arena');
    expect(G.theme).toBe('arena');
    expect(spawnRival).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnRival).mock.calls[0][0]).not.toBe(p.cid);
    expect(p.hp).toBe(200);
    const rival = G.enemies[0];
    rival.dead = true;
    updateWorld(0.1);
    expect(G.scene).toBe('arena');
    updateWorld(2);
    expect(G.scene).toBe('city');
    expect(p.streak).toBe(1);
    expect(p.arenaWins).toBe(1);
    expect(p.gold).toBe(100 + 80);
    expect(p.bestStreak).toBe(1);
    const arena = G.portals.find(pt => pt.kind === 'arena')!;
    expect(Math.hypot(p.x - arena.x, p.y - arena.y)).toBeLessThan(5 * TILE);

    enterArena();
    p.hp = 0;
    p.dead = true;
    G.mode = 'dead';
    leaveArena(false);
    expect(G.scene).toBe('city');
    expect(p.hp).toBe(200);
    expect(p.dead).toBe(false);
    expect(G.mode).toBe('play');
    expect(p.streak).toBe(0);
  });

  it('villagers wander around but always stay on free ground', () => {
    enterCity();
    const p = G.player!;
    p.x = 2 * TILE; p.y = 3 * TILE; // 远离村民
    const v = G.npcs.filter(n => n.role === 'villager');
    const start = v.map(n => ({ x: n.x, y: n.y }));
    for (let i = 0; i < 1200; i++) updateWorld(1 / 30);
    let moved = 0;
    v.forEach((n, i) => {
      expect(isFree(G.map!, n.x, n.y, n.r - 0.5), n.name).toBe(true);
      expect(Math.hypot(n.x - start[i].x, n.y - start[i].y)).toBeLessThan(5 * TILE);
      if (Math.hypot(n.x - start[i].x, n.y - start[i].y) > 4) moved++;
    });
    expect(moved).toBeGreaterThan(v.length / 2);
  });

  it('secret trial: single floor, timed goal, rewards a relic + big chest on success', () => {
    const p = G.player!;
    enterCity();
    const td = peekTrial();
    enterSecret();
    expect(G.scene).toBe('dungeon');
    expect(G.dungeonId).toBe('secret');
    expect(G.theme).toBe('secret');
    expect(G.portals.some(pt => pt.kind === 'next')).toBe(false);
    expect(G.portals.some(pt => pt.kind === 'city' && pt.open)).toBe(true);
    const t = getTrial()!;
    expect(t.id).toBe(td.id);
    expect(t.state).toBe('run');
    expect(t.timeLeft).toBe(td.time);
    // 完成：击杀数达标 + 目标全部倒下
    p.kills += 999;
    for (const e of G.enemies) e.dead = true;
    const gold = p.gold;
    updateWorld(1 / 60);
    expect(getTrial()!.state).toBe('won');
    expect(p.gold).toBeGreaterThan(gold);
    expect(G.drops.some(d => d.kind === 'item' && d.item!.name.startsWith('遗物') && d.item!.rarity === 4)).toBe(true);
    expect(G.drops.some(d => d.kind === 'chest' && d.tier === 2)).toBe(true);
    expect(G.events.some(e => e.t === 'banner' && e.text === '试炼完成')).toBe(true);
  });

  it('secret trial fails when time runs out', () => {
    enterCity();
    enterDungeon('secret', 1);
    updateWorld(1000);
    expect(getTrial()!.state).toBe('lost');
    expect(G.events.some(e => e.t === 'banner' && e.text === '试炼失败')).toBe(true);
    // 回城传送阵始终可用
    const back = G.portals.find(pt => pt.kind === 'city')!;
    const p = G.player!;
    p.x = back.x; p.y = back.y + 8;
    interact();
    expect(G.scene).toBe('city');
    expect(getTrial()).toBeNull();
  });

  it('breakable crates/barrels shatter from slashes and free their tile', () => {
    let crate: Decor | undefined;
    for (const id of DUNGEON_ORDER) {
      for (let f = 1; f <= 3 && !crate; f++) {
        enterDungeon(id, f);
        crate = G.decor.find(d => d.breakable);
      }
      if (crate) break;
    }
    expect(crate).toBeDefined();
    const c = crate!;
    const fp = decorFootprint(c);
    expect(G.map!.get(fp.tx, fp.ty)).toBe(T.BLOCK);
    for (let i = 0; i < 3 && G.decor.includes(c); i++) {
      G.events.push({ t: 'slash', x: c.x - 30, y: c.y - 16, a: 0, r: 40, color: '#fff', style: 'sword' });
      updateWorld(1 / 60);
    }
    expect(G.decor).not.toContain(c);
    expect(G.map!.get(fp.tx, fp.ty)).toBe(T.FLOOR);
    expect(damageDecorAt(0, 0, 1)).toBe(0);
  });

  it('spikes go up and down on a fixed cycle', () => {
    const d = { id: 1, kind: 'spikes', x: 0, y: 0, v: 0 };
    expect(spikesUp(d, 0.1)).toBe(true);
    expect(spikesUp(d, 1.5)).toBe(false);
    expect(spikesUp(d, 2.5)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 掉落与拾取                                                           */
/* ------------------------------------------------------------------ */
describe('drops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    resetG();
    enterCity();
    G.drops.length = 0;
    G.events.length = 0;
  });
  const item = (): Item => ({ uid: 'x1', slot: 'weapon', rarity: 2, affixes: [], lv: 3, name: '测试长剑', value: 10, plus: 0, sprite: 's' });

  it('bag full: equipment stays on the ground with a toast', () => {
    const p = G.player!;
    for (let i = 0; i < 24; i++) p.bag.push(item());
    const d = spawnDrop({ kind: 'item', x: p.x + 20, y: p.y, item: item() });
    d.vx = 0; d.vy = 0; d.vz = 0;
    expect(clickPickup(d.x, d.y)).toBe(true);
    expect(G.drops).toContain(d);
    expect(p.bag).toHaveLength(24);
    expect(G.events.some(e => e.t === 'toast' && e.text.includes('背包已满'))).toBe(true);
    expect(interactPickup()).toBe(true);
    expect(G.drops).toContain(d);
    expect(p.bag).toHaveLength(24);
    // 腾出位置后可以捡
    p.bag.pop();
    expect(interactPickup()).toBe(true);
    expect(G.drops).not.toContain(d);
    expect(p.bag).toHaveLength(24);
    expect(addToBag).toHaveBeenCalled();
  });

  it('click pickup needs to be on the item and within reach', () => {
    const p = G.player!;
    const d = spawnDrop({ kind: 'item', x: p.x + 400, y: p.y, item: item() });
    d.vx = 0; d.vy = 0; d.vz = 0;
    expect(clickPickup(d.x, d.y)).toBe(false); // 太远
    expect(clickPickup(p.x + 40, p.y + 40)).toBe(false); // 没点中
    expect(G.drops).toContain(d);
  });

  it('exp/gold/potions/materials are magnetised and auto-picked; items are not', () => {
    const p = G.player!;
    const gold = spawnDrop({ kind: 'gold', x: p.x + 60, y: p.y, value: 7 });
    const mat = spawnDrop({ kind: 'mat', x: p.x - 60, y: p.y, mat: 'gem', value: 2 });
    const pot = spawnDrop({ kind: 'hp', x: p.x, y: p.y + 50, value: 1 });
    const it = spawnDrop({ kind: 'item', x: p.x + 10, y: p.y, item: item() });
    for (const x of [gold, mat, pot, it]) { x.vx = 0; x.vy = 0; }
    for (let i = 0; i < 180; i++) updateDrops(1 / 60);
    expect(p.gold).toBe(107);
    expect(p.mats.gem).toBe(2);
    expect(p.potions.hp).toBe(1);
    expect(G.drops).toEqual([it]);
    // 药剂到上限：留在地上，不吸附
    p.potions.mp = 99;
    const full = spawnDrop({ kind: 'mp', x: p.x + 60, y: p.y, value: 1 });
    full.vx = 0; full.vy = 0;
    for (let i = 0; i < 120; i++) updateDrops(1 / 60);
    expect(p.potions.mp).toBe(99);
    expect(G.drops).toContain(full);
    expect(Math.hypot(full.x - p.x, full.y - p.y)).toBeGreaterThan(50);
  });

  it('equipment lasts 120s, everything else 60s; chests stay', () => {
    const p = G.player!;
    p.x = 5 * TILE; p.y = 5 * TILE;
    const far = (k: 'gold' | 'item' | 'chest') => {
      const d = spawnDrop({ kind: k, x: 40 * TILE, y: 36 * TILE, value: 1, item: k === 'item' ? item() : undefined });
      d.vx = 0; d.vy = 0;
      return d;
    };
    const g = far('gold'), i = far('item'), c = far('chest');
    updateDrops(61);
    expect(G.drops).not.toContain(g);
    expect(G.drops).toContain(i);
    updateDrops(60);
    expect(G.drops).not.toContain(i);
    expect(G.drops).toContain(c);
  });

  it('boss loot: exp, gold, potions, several materials, 2 epic+ items and a big chest; summons drop nothing', () => {
    vi.spyOn(rng, 'next').mockReturnValue(0.01);
    const boss = H.fakeEnemy('boss', 20 * TILE, 20 * TILE, { boss: true, lv: 18 }) as unknown as Enemy;
    dropLoot(boss);
    const by = (k: string) => G.drops.filter(d => d.kind === k);
    expect(by('exp').reduce((s, d) => s + d.value, 0)).toBe(30);
    expect(by('gold').reduce((s, d) => s + d.value, 0)).toBe(12);
    expect(by('hp').length).toBe(1);
    expect(by('mp').length).toBe(1);
    expect(by('mat').length).toBeGreaterThanOrEqual(3);
    const items = by('item');
    expect(items).toHaveLength(2);
    for (const d of items) {
      expect(d.item!.rarity).toBeGreaterThanOrEqual(3);
      expect(d.item!.lv).toBe(18);
    }
    expect(by('chest').map(d => d.tier)).toEqual([2]);
    G.drops.length = 0;
    const minion = H.fakeEnemy('slime', 0, 0) as unknown as Enemy;
    minion.summonedBy = 5;
    dropLoot(minion);
    expect(G.drops).toHaveLength(0);
  });

  it('opening a chest bursts out rewards and emits chestOpen', () => {
    const p = G.player!;
    const c = spawnDrop({ kind: 'chest', x: p.x + 30, y: p.y, tier: 1 });
    expect(interactPickup()).toBe(true);
    expect(c.opened).toBe(true);
    expect(G.events.some(e => e.t === 'chestOpen' && e.id === c.id)).toBe(true);
    expect(G.events.some(e => e.t === 'sfx' && e.name === 'chest')).toBe(true);
    expect(G.drops.filter(d => d.kind === 'gold').length).toBeGreaterThan(0);
    expect(G.drops.filter(d => d.kind === 'item').length).toBeGreaterThanOrEqual(1);
    // 已开过的宝箱不会再被交互
    const n = G.drops.length;
    G.drops.filter(d => d.kind === 'item').forEach(d => { d.x = 0; d.y = 0; });
    expect(interactPickup()).toBe(false);
    expect(G.drops.length).toBe(n);
  });
});
