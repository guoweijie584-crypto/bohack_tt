// 场景流转与交互：进主城/副本/竞技场、下一层、出口（走到出口即下一图，不必清怪）、F 交互（NPC/传送阵/出口/拾取）。
// 移植自 legacy L800–886（enterCity/enterDungeon/nextFloor/usePortalOrNpc）、L1016–1048（竞技场）。
// 修正：
//   - 交互提示半径与 F 交互半径一致（legacy 提示 90 / 交互 76，显示了提示按 F 却无效）；
//   - 竞技场输了回城时回满血（legacy hp 停在 0）；leaveArena 不再走永远到不了的迷宫分支；
//   - 怪物等级 = 副本推荐等级 + (层-1)×2 + rng(0..2)，不跟随玩家等级；
//   - 首领层击败首领后才生成回城传送阵；第 1–2 层出口一直开放，走进去即进入下一层。
// 新增：补给泉、事件祭坛（二选一）、秘境试炼（限时/限定条件）、地刺陷阱、可破坏木箱、村民闲逛。
// 【契约】签名不可改；实现由 world 代理完成。

import { TILE } from '../config';
import { Rng, hashStr, rng } from '../core/rng';
import { dist, wrapAngle } from '../core/util';
import { ALL_CLASSES, CLASSES } from '../data/classes';
import {
  DUNGEONS, TRIALS, floorBaseLevel, floorPool, globalFloor,
  type DungeonDef, type TrialDef,
} from '../data/dungeons';
import { ENEMIES } from '../data/enemies';
import { LORE } from '../data/lore';
import { T } from '../data/tiles';
import type { RouteId } from '../data/types';
import { isFree, moveCircle, nearestFree } from '../world/collision';
import { FlowField } from '../world/flowfield';
import type { GridMap } from '../world/grid';
import { DECOR_KINDS, INTERACT_DECOR, decorCenter, decorFootprint, genArena, genCity, genDungeon, type GenResult } from '../world/mapgen';
import { damagePlayer } from './combat';
import { INTERACT_R, areaLevel, interactPickup, isManualPickup, spawnDrop } from './drops';
import { spawnEnemy, spawnRival, type SpawnOpts } from './enemies';
import { bagHasRoom, rollItem, weaponTypeOf } from './items';
import { gainExp } from './player';
import { saveGame } from './save';
import { initSpawner } from './spawner';
import { G, clearWorld, emit, floater, nextId, toast } from './state';
import type { Decor, Drop, Enemy, Npc, NpcRole, PanelName, Player, Portal } from './types';

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */
/** 进入新场景后传送阵的冷却（防止落地即触发） */
const PORTAL_GRACE = 0.6;
/** 村民闲逛 */
const VILLAGER_SPD = 34;
const VILLAGER_RANGE = 3 * TILE;
/** 地刺：周期 / 升起时长（秒），v = 相位 0–9，每档 0.24s */
export const SPIKE_PERIOD = 2.4;
export const SPIKE_UP = 0.8;
/** 地刺每次伤害（占最大生命） */
const SPIKE_PCT = 0.06;
/** 竞技场胜利后的停顿（让镜像倒地动画播完） */
const ARENA_WIN_DELAY = 1.2;
/** 秘境试炼目标（精英守卫 / 守关者）的强度倍率（× 本层 mul，同时作用于血量与攻击） */
const TRIAL_ELITE_MUL = 1.4;
/** 守关者额外血量倍率：总血量 ≈ 本层 mul × 2.6；攻击只吃 TRIAL_ELITE_MUL（修复：之前攻击也 ×2.6，Lv8 法师被一下冲撞秒杀） */
const GUARDIAN_HP_MUL = 2.6 / TRIAL_ELITE_MUL;

/** NPC 角色 → DOM 面板 */
const NPC_PANEL: Record<NpcRole, PanelName> = {
  gate: 'portal', route: 'route', smith: 'shop_smith', fuse: 'fuse', scribe: 'lore', arena: 'arena',
  potion: 'shop_potion', stash: 'stash', villager: 'dialog', secret: 'secret',
};

/* ------------------------------------------------------------------ */
/* 模块内运行状态（切场景时重置）                                        */
/* ------------------------------------------------------------------ */
interface TrialRun {
  def: TrialDef;
  timeLeft: number;
  goal: number;
  kills0: number;
  targets: Enemy[];
  state: 'run' | 'won' | 'lost';
  warned: number;
  lv: number;
}
export interface TrialView {
  id: string;
  name: string;
  desc: string;
  goal: number;
  progress: number;
  timeLeft: number;
  state: 'run' | 'won' | 'lost';
}

let bossRef: Enemy | null = null;
let bossSpot: { x: number; y: number } | null = null;
let rivalRef: Enemy | null = null;
let arenaWinT = -1;
let trial: TrialRun | null = null;
let nextTrial: TrialDef = TRIALS[0];
let portalGrace = 0;
let spikeCd = 0;
let altarPending: Decor | null = null;
let spikes: Decor[] = [];
let breakables: Decor[] = [];
const homes = new Map<number, { x: number; y: number; stuck: number }>();
const lineIdx = new Map<number, number>();
const seenEvents = new WeakSet<object>();

function resetRunState(): void {
  bossRef = null;
  bossSpot = null;
  rivalRef = null;
  arenaWinT = -1;
  trial = null;
  portalGrace = PORTAL_GRACE;
  spikeCd = 0;
  altarPending = null;
  spikes = [];
  breakables = [];
  homes.clear();
  lineIdx.clear();
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                             */
/* ------------------------------------------------------------------ */
/** 把生成结果装进 G（实体换成全局 id），并初始化流场 */
function loadGen(gen: GenResult): void {
  G.map = gen.map;
  for (const n of gen.npcs) { n.id = nextId(); G.npcs.push(n); }
  for (const p of gen.portals) { p.id = nextId(); G.portals.push(p); }
  for (const d of gen.decor) {
    d.id = nextId();
    G.decor.push(d);
    if (d.kind === 'spikes') spikes.push(d);
    if (d.breakable) breakables.push(d);
  }
  G.spawnPoints = gen.spawnPoints.slice();
  G.flow = new FlowField(gen.map);
}

/** 把玩家放到 (x,y) 附近的空位，并清掉残余位移与异常状态 */
function placePlayer(x: number, y: number): void {
  const p = G.player, map = G.map;
  if (!p || !map) return;
  const f = nearestFree(map, x, y, p.r);
  p.x = f.x;
  p.y = f.y;
  p.vx = 0; p.vy = 0; p.kx = 0; p.ky = 0;
  p.dashT = 0; p.dashVx = 0; p.dashVy = 0;
  p.z = 0;
  // 异常状态（灼烧/中毒/迟缓/眩晕…全是负面）不带进新场景：
  // 修复：残血中毒时走传送阵回城，DoT 继续结算，玩家会死在没有敌人的主城里
  p.status = {};
  G.flow?.update(p.x, p.y);
}

function sceneChanged(): void {
  emit({ t: 'ui', what: 'hud' });
  emit({ t: 'ui', what: 'minimap' });
}

/** 怪物池过滤掉数据表里还不存在的 kind（新怪由 enemies 代理补充；缺失时回落到 legacy 怪） */
function validPool(pool: readonly string[]): string[] {
  const ok = pool.filter(k => ENEMIES[k] && !ENEMIES[k].boss);
  if (ok.length) return ok;
  return ['slime', 'goblin', 'bat'].filter(k => ENEMIES[k]);
}

/** 生成怪物（出生点校验 + 保证进入 G.enemies） */
function spawnFoe(kind: string, x: number, y: number, opts: SpawnOpts): Enemy | null {
  const def = ENEMIES[kind];
  if (!def || !G.map) return null;
  const r = def.r * (opts.boss ? 1.6 : opts.elite ? 1.3 : 1) + 2;
  const pos = nearestFree(G.map, x, y, r);
  const e = spawnEnemy(kind, pos.x, pos.y, opts);
  if (!G.enemies.includes(e)) G.enemies.push(e);
  return e;
}

/** 本层怪物等级（推荐等级 + (层-1)×2 + rng(0..2)） */
function rollLevel(base: number): number {
  return base + rng.int(0, 2);
}

function decorAt(d: Decor): { x: number; y: number } { return decorCenter(d); }

/* ------------------------------------------------------------------ */
/* 进入场景                                                             */
/* ------------------------------------------------------------------ */
export function enterCity(at?: 'spawn' | 'portal'): void {
  enterCityAt(at ?? 'spawn');
}

function enterCityAt(at: 'spawn' | 'portal' | 'arena'): void {
  clearWorld();
  resetRunState();
  const gen = genCity();
  loadGen(gen);
  G.scene = 'city';
  G.theme = 'city';
  G.floor = 0;
  G.spawnPoints = [];
  for (const n of G.npcs) if (n.role === 'villager') homes.set(n.id, { x: n.x, y: n.y, stuck: 0 });
  const spot = (at === 'portal' ? gen.points?.portals : at === 'arena' ? gen.points?.arena : undefined) ?? gen.spawn;
  placePlayer(spot.x, spot.y);
  // 预选下一次秘境试炼（秘境向导面板可提前展示）
  nextTrial = TRIALS[rng.int(0, TRIALS.length - 1)];
  emit({ t: 'banner', text: '曙光主城', sub: '与 NPC 交谈 · 东南传送阵广场前往各处副本', color: '#f0bd7c' });
  if (at !== 'spawn') emit({ t: 'sfx', name: 'portal' });
  sceneChanged();
  if (G.player) saveGame();
}

export function enterDungeon(dungeonId: string, floor: number): void {
  const def: DungeonDef | undefined = DUNGEONS[dungeonId];
  if (!def) { toast(`未知的副本：${dungeonId}`, '#df8f7a'); return; }
  const f = Math.max(1, Math.min(def.floors, Math.floor(floor) || 1));
  const p = G.player;
  clearWorld();
  resetRunState();
  const seed = (hashStr(def.id) + f * 7919 + G.seed) >>> 0;
  const gen = genDungeon(def.id, f, seed);
  loadGen(gen);
  G.scene = 'dungeon';
  G.theme = def.theme;
  G.dungeonId = def.id;
  G.floor = f;
  placePlayer(gen.spawn.x, gen.spawn.y);
  bossSpot = gen.bossSpot ?? null;

  const secret = def.theme === 'secret';
  const baseLv = floorBaseLevel(def.id, f, p?.bestFloor ?? 1);
  const mul = 1 + f * 0.12;
  const pool = validPool(floorPool(def.id, f));

  // 非起点房间预刷 1–3 只；精英房多刷精英；补给/事件房是安全屋
  // 位置与种类用地图种子派生的随机（联机各端一致），等级浮动用战斗随机 rng
  // 预刷的怪（含精英、首领）一律 aggro:false 守在房间里，等玩家进入视野再仇恨。
  // （修复：spawnEnemy 默认“精英/首领出生即仇恨”，导致每层开局 900 内的精英房精英直接冲向出生点，
  //   首领也离开首领房追 4 秒；那个默认值是给刷怪器“猎杀”怪用的）
  const prng = new Rng((seed ^ 0x6d2b79f5) >>> 0);
  for (const room of gen.rooms) {
    if (room.kind === 'start' || room.kind === 'supply' || room.kind === 'event') continue;
    const pts = gen.spawnPoints.filter(s => {
      const tx = Math.floor(s.x / TILE), ty = Math.floor(s.y / TILE);
      return tx >= room.x && tx < room.x + room.w && ty >= room.y && ty < room.y + room.h;
    });
    if (!pts.length) continue;
    const at = (): { x: number; y: number } => pts[Math.floor(prng.next() * pts.length)];
    let normal = 1 + Math.floor(prng.next() * 3);
    let elites = 0;
    if (room.kind === 'elite') { elites = 2; normal = 1 + Math.floor(prng.next() * 2); }
    if (room.kind === 'exit') normal = 1 + Math.floor(prng.next() * 2);
    if (room.kind === 'boss') normal = 2;
    for (let i = 0; i < normal; i++) {
      const s = at();
      spawnFoe(pool[Math.floor(prng.next() * pool.length)], s.x, s.y, { lv: rollLevel(baseLv), mul, aggro: false });
    }
    for (let i = 0; i < elites; i++) {
      const s = at();
      spawnFoe(pool[Math.floor(prng.next() * pool.length)], s.x, s.y, { lv: rollLevel(baseLv), mul, elite: true, aggro: false });
    }
  }

  // 刷怪器：无限补怪，存活上限随层数提高
  if (secret) startTrial(def, pool, baseLv, mul);
  else initSpawner(pool, 14 + f * 4, mul, baseLv);

  // 首领层：首领在首领房中心
  if (!secret && f >= def.floors && gen.bossSpot) {
    const kind = ENEMIES[def.boss] ? def.boss : (ENEMIES.boss ? 'boss' : pool[0]);
    const b = spawnFoe(kind, gen.bossSpot.x, gen.bossSpot.y, { lv: baseLv + 2, mul: 1 + f * 0.09, boss: true, aggro: false });
    if (b) {
      G.boss = b;
      bossRef = b;
      toast(`☠ ${b.def?.n ?? ENEMIES[kind]?.n ?? '首领'} 盘踞在本层深处`, '#e06858');
    }
  }

  // 宝箱
  for (const c of gen.chests) spawnDrop({ kind: 'chest', x: c.x, y: c.y, tier: c.tier });

  if (p) {
    // 剧情残页：每个主线副本的每一层各一张（首次到达时发放）
    const g = globalFloor(def.id, f);
    if (g > 0) {
      p.bestFloor = Math.max(p.bestFloor || 0, g);
      const fi = g - 1;
      if (fi < LORE.fragments.length && !p.fragments.includes(fi)) {
        p.fragments.push(fi);
        toast('▤ 拾得记忆残页 · 按 J 查看日志', '#a3c979');
      }
    }
  }

  const sub = secret
    ? (trial ? `${trial.def.name}：${trial.def.desc}` : def.desc)
    : f >= def.floors ? '首领层 · 击败首领开启回城传送阵' : '找到出口传送阵即可前往下一层，不必清怪';
  emit({ t: 'banner', text: secret ? def.name : `${def.name} · 第 ${f} 层`, sub, color: def.color });
  emit({ t: 'sfx', name: 'portal' });
  sceneChanged();
  saveGame();
}

/** 进入秘境·试炼回廊（单层短副本；UI 的秘境入口会优先调用它） */
export function enterSecret(): void {
  enterDungeon('secret', 1);
}

export function nextFloor(): void {
  const p = G.player;
  if (!p || G.scene !== 'dungeon') return;
  const def = DUNGEONS[G.dungeonId];
  if (!def) return;
  if (G.floor >= def.floors) { toast('这已经是最深的一层了', '#c4a78c'); return; }
  p.hp = Math.min(p.stat.maxHp, p.hp + p.stat.maxHp * 0.2);
  p.mp = p.stat.maxMp;
  const next = G.floor + 1;
  enterDungeon(def.id, next);
  toast(`✦ 通过第 ${next - 1} 层 · 生命与源能部分恢复`, '#a3c979');
}

export function enterArena(): void {
  const p = G.player;
  clearWorld();
  resetRunState();
  const gen = genArena();
  loadGen(gen);
  G.scene = 'arena';
  G.theme = 'arena';
  G.floor = 0;
  G.spawnPoints = [];
  placePlayer(gen.spawn.x, gen.spawn.y);
  if (!p) return;
  p.hp = p.stat.maxHp;
  p.mp = p.stat.maxMp;
  for (const k of Object.keys(p.cd) as Array<keyof Player['cd']>) p.cd[k] = 0;
  // 对手：除自己职业外随机一个职业 + 随机路线（使用玩家同一套技能）
  const foes = ALL_CLASSES.filter(c => c.id !== p.cid);
  const cls = rng.pick(foes.length ? foes : CLASSES);
  const route: RouteId = rng.chance(0.5) ? 'magic' : 'tech';
  const at = gen.points?.rival ?? { x: gen.spawn.x, y: gen.spawn.y - 260 };
  const e = spawnRival(cls.id, route, p.streak, at.x, at.y);
  if (!G.enemies.includes(e)) G.enemies.push(e);
  rivalRef = e;
  emit({ t: 'banner', text: `镜像竞技场 · 第 ${p.streak + 1} 轮`, sub: `对手：镜像 · ${cls.name}（${route === 'magic' ? '奥术' : '机械'}路线）`, color: '#f0bd7c' });
  emit({ t: 'sfx', name: 'portal' });
  sceneChanged();
}

export function leaveArena(win: boolean): void {
  const p = G.player;
  if (G.scene !== 'arena') return;
  // 镜像已倒下、正在胜利停顿中：此时玩家再被残留的灼烧/中毒带走（combat.playerDie → leaveArena(false)）仍算胜利
  if (arenaWinT >= 0) win = true;
  if (p) {
    if (win) {
      const g = 80 + p.streak * 40;
      p.gold += g;
      p.arenaWins++;
      p.streak++;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      gainExp(p, 60 + p.streak * 25);
      toast(`🏆 竞技场胜利 · +${g} G · 连胜 ${p.streak}`, '#f0bd7c');
      emit({ t: 'burst', x: p.x, y: p.y, color: '#f0bd7c', n: 40, spd: 160 });
      emit({ t: 'sfx', name: 'victory' });
    } else {
      p.streak = 0;
      toast('⚔ 竞技场落败 · 已在主城重整', '#df8f7a');
    }
    // 修 legacy：输了回城 hp 停在 0；死亡态也一并恢复（竞技场死亡不进死亡页）
    if (!win || p.hp <= 0 || p.dead) {
      p.hp = p.stat.maxHp;
      p.mp = p.stat.maxMp;
      p.invuln = Math.max(p.invuln, 1.5);
    }
    p.dead = false;
    p.anim = 'idle';
    if (G.mode === 'dead') G.mode = 'play';
  }
  enterCityAt('arena'); // 内部会存档
}

/* ------------------------------------------------------------------ */
/* 秘境试炼                                                             */
/* ------------------------------------------------------------------ */
function startTrial(def: DungeonDef, pool: string[], baseLv: number, mul: number): void {
  const p = G.player;
  const td = nextTrial;
  const run: TrialRun = {
    def: td, timeLeft: td.time, goal: td.goal, kills0: p?.kills ?? 0, targets: [], state: 'run', warned: Infinity, lv: baseLv,
  };
  trial = run;
  if (td.id === 'hunt') {
    initSpawner(pool, 18, mul * 1.05, baseLv);
  } else if (td.id === 'elite') {
    initSpawner(pool, 8, mul, baseLv);
    // 精英守卫分布在离起点最远的几个房间
    const spots = G.spawnPoints.slice();
    const sp = G.player ?? { x: 0, y: 0 };
    spots.sort((a, b) => dist(b.x, b.y, sp.x, sp.y) - dist(a.x, a.y, sp.x, sp.y));
    const picked: Array<{ x: number; y: number }> = [];
    for (const s of spots) {
      if (picked.length >= td.goal) break;
      if (picked.every(o => dist(o.x, o.y, s.x, s.y) > 8 * TILE)) picked.push(s);
    }
    for (const s of picked) {
      // 守卫守在远处房间等玩家找上门（“找到并击败”），不出生即仇恨
      const e = spawnFoe(rng.pick(pool), s.x, s.y, { lv: baseLv + 2, mul: mul * TRIAL_ELITE_MUL, elite: true, aggro: false });
      if (e) run.targets.push(e);
    }
    run.goal = Math.max(1, run.targets.length);
  } else {
    initSpawner(pool, 8, mul, baseLv);
    const spot = bossSpot ?? G.spawnPoints[G.spawnPoints.length - 1];
    const kind = ENEMIES[def.boss] ? def.boss : pool[0];
    if (spot) {
      const e = spawnFoe(kind, spot.x, spot.y, { lv: baseLv + 2, mul: mul * TRIAL_ELITE_MUL, elite: true, aggro: false });
      if (e) {
        // 守关者：血量加厚（≈ 本层 mul × 2.6），攻击保持精英守卫水平
        e.maxHp *= GUARDIAN_HP_MUL;
        e.hp = e.maxHp;
        run.targets.push(e);
        G.boss = e;
      }
    }
    run.goal = Math.max(1, run.targets.length);
  }
  emit({ t: 'toast', text: `秘境试炼「${td.name}」开始：${td.desc}`, color: '#f0d070' });
}

function trialProgress(t: TrialRun): number {
  if (t.def.id === 'hunt') return Math.max(0, (G.player?.kills ?? 0) - t.kills0);
  return t.targets.filter(e => e.dead || e.hp <= 0 || !G.enemies.includes(e)).length;
}

function updateTrial(dt: number): void {
  const t = trial;
  if (!t || t.state !== 'run') return;
  t.timeLeft = Math.max(0, t.timeLeft - dt);
  const prog = trialProgress(t);
  if (prog >= t.goal) { finishTrial(t, true); return; }
  for (const mark of [60, 30, 10]) {
    if (t.timeLeft <= mark && t.warned > mark && t.def.time > mark) {
      t.warned = mark;
      toast(`试炼剩余 ${mark} 秒 · 进度 ${prog}/${t.goal}`, mark <= 10 ? '#df8f7a' : '#f0d070');
    }
  }
  if (t.timeLeft <= 0) finishTrial(t, false);
}

function finishTrial(t: TrialRun, won: boolean): void {
  const p = G.player;
  t.state = won ? 'won' : 'lost';
  if (G.spawner) G.spawner.cap = 0;
  if (G.boss && t.targets.includes(G.boss)) G.boss = null;
  if (!p) return;
  if (won) {
    const gold = Math.round(t.def.gold * (1 + t.lv * 0.08));
    p.gold += gold;
    floater(p.x, p.y - 30, `+${gold} G`, '#f2cd8c', 14);
    // 遗物：一件传说饰品 + 大宝箱
    const relic = rollItem(t.lv + 2, { rarity: 4, slot: 'trinket' });
    relic.name = `遗物 · ${relic.name}`;
    spawnDrop({ kind: 'item', x: p.x + 24, y: p.y, item: relic });
    const c = spawnDrop({ kind: 'chest', x: p.x - 24, y: p.y + 8, tier: 2 });
    c.vz = 200;
    emit({ t: 'banner', text: '试炼完成', sub: `+${gold} 金币 · 获得遗物 · 传送阵可返回主城`, color: '#f0d070' });
    emit({ t: 'sfx', name: 'victory' });
    emit({ t: 'ring', x: p.x, y: p.y, r0: 10, r1: 160, color: '#f0d070', dur: 0.9 });
  } else {
    emit({ t: 'banner', text: '试炼失败', sub: '时间耗尽 · 传送阵可返回主城', color: '#df8f7a' });
    emit({ t: 'sfx', name: 'uiDeny' });
  }
  saveGame();
}

/** 当前秘境试炼（HUD 显示倒计时/进度用；不在秘境时为 null） */
export function getTrial(): TrialView | null {
  const t = trial;
  if (!t) return null;
  return {
    id: t.def.id, name: t.def.name, desc: t.def.desc, goal: t.goal,
    progress: Math.min(t.goal, trialProgress(t)), timeLeft: t.timeLeft, state: t.state,
  };
}

/** 下一次进入秘境将遇到的试炼（秘境向导面板展示用） */
export function peekTrial(): TrialDef { return nextTrial; }

/* ------------------------------------------------------------------ */
/* F 交互                                                               */
/* ------------------------------------------------------------------ */
type Target =
  | { k: 'npc'; npc: Npc; x: number; y: number; d: number }
  | { k: 'portal'; portal: Portal; x: number; y: number; d: number }
  | { k: 'decor'; decor: Decor; x: number; y: number; d: number }
  | { k: 'drop'; drop: Drop; x: number; y: number; d: number };

/** 闲逛村民 / 地上物的“优先级惩罚”（世界单位）：功能 NPC、传送阵优先于路过的村民和脚边的战利品 */
const VILLAGER_PENALTY = 40;
const DROP_PENALTY = 24;

/**
 * 交互半径内的目标（提示与 F 共用，半径一致）。实际距离必须在 INTERACT_R 内，
 * 按“有效距离 = 实际距离 + 优先级惩罚”取最优；背包已满时跳过地上装备（否则站在回城阵边永远只能“拾取”）。
 */
function findTarget(p: Player): Target | null {
  let best = Infinity, bestReal = 0;
  let npc: Npc | null = null, portal: Portal | null = null, decor: Decor | null = null, drop: Drop | null = null;
  const take = (real: number, penalty: number): boolean => {
    if (real >= INTERACT_R) return false;
    const eff = real + penalty;
    if (eff >= best) return false;
    best = eff;
    bestReal = real;
    npc = null; portal = null; decor = null; drop = null;
    return true;
  };
  const bagFull = !bagHasRoom(p);
  for (const n of G.npcs) if (take(dist(p.x, p.y, n.x, n.y), n.role === 'villager' ? VILLAGER_PENALTY : 0)) npc = n;
  for (const pt of G.portals) if (take(dist(p.x, p.y, pt.x, pt.y), 0)) portal = pt;
  for (const d of G.decor) {
    if (!INTERACT_DECOR[d.kind]) continue;
    const c = decorAt(d);
    if (take(dist(p.x, p.y, c.x, c.y), 0)) decor = d;
  }
  for (const d of G.drops) {
    if (!isManualPickup(d) || (bagFull && d.kind === 'item')) continue;
    if (take(dist(p.x, p.y, d.x, d.y), DROP_PENALTY)) drop = d;
  }
  if (npc) return { k: 'npc', npc, x: npc.x, y: npc.y, d: bestReal };
  if (portal) return { k: 'portal', portal, x: portal.x, y: portal.y, d: bestReal };
  if (decor) { const c = decorAt(decor); return { k: 'decor', decor, x: c.x, y: c.y, d: bestReal }; }
  if (drop) return { k: 'drop', drop, x: drop.x, y: drop.y, d: bestReal };
  return null;
}

function hintText(t: Target): string {
  switch (t.k) {
    case 'npc': return `F 与 ${t.npc.name} 交谈`;
    case 'portal': {
      const pt = t.portal;
      if (!pt.open) return `${pt.label}（未开启）`;
      switch (pt.kind) {
        case 'dungeon': return `F 进入传送阵 · ${pt.label}`;
        case 'secret': return `F 进入 ${pt.label}`;
        case 'arena': return 'F 进入镜像竞技场';
        case 'city': return trial?.state === 'run' ? 'F 放弃试炼并返回主城' : 'F 返回曙光主城';
        case 'next':
        case 'boss': return `走入传送阵 · ${pt.label}`;
        default: return `F ${pt.label}`;
      }
    }
    case 'decor': {
      const used = t.decor.v === 1;
      switch (INTERACT_DECOR[t.decor.kind]) {
        case 'fountain': return used ? '补给泉已经干涸' : 'F 饮用补给泉（回满生命与源能）';
        case 'altar': return used ? '祭坛已经沉寂' : `F 查看${LORE.altar.title}`;
        case 'stash': return 'F 打开仓库';
        default: return '';
      }
    }
    case 'drop': {
      const d = t.drop;
      if (d.kind === 'chest') return `F 打开${['小', '中', '大'][d.tier ?? 0] ?? ''}宝箱`;
      return `F 拾取 ${d.item?.name ?? '装备'}`;
    }
  }
}

export function interact(): void {
  const p = G.player;
  if (!p || !G.map) return;
  const t = findTarget(p);
  if (!t) {
    if (G.scene === 'city') toast('靠近 NPC、传送阵或物品再按 F', '#c4a78c');
    return;
  }
  switch (t.k) {
    case 'npc': talkTo(p, t.npc); break;
    case 'portal': usePortal(t.portal); break;
    case 'decor': useDecor(p, t.decor); break;
    case 'drop': interactPickup(); break;
  }
}

function talkTo(p: Player, npc: Npc): void {
  npc.facing = p.x < npc.x ? -1 : 1;
  p.facing = npc.x < p.x ? -1 : 1;
  if (npc.role === 'villager') {
    // 每次交谈轮换一句台词
    const lore = LORE.villagers.find(v => v.n === npc.name);
    if (lore && lore.lines.length) {
      const i = lineIdx.get(npc.id) ?? 0;
      npc.line = lore.lines[i % lore.lines.length];
      lineIdx.set(npc.id, i + 1);
    }
    npc.wanderT = Math.max(npc.wanderT ?? 0, 3);
    emit({ t: 'openPanel', panel: 'dialog', arg: String(npc.id) });
  } else {
    emit({ t: 'openPanel', panel: NPC_PANEL[npc.role] });
  }
  emit({ t: 'sfx', name: 'ui' });
}

function usePortal(pt: Portal): void {
  if (!pt.open) { toast(`${pt.label} 尚未开启`, '#c4a78c'); return; }
  switch (pt.kind) {
    case 'dungeon':
    case 'secret':
      emit({ t: 'openPanel', panel: 'portal', arg: pt.target ?? pt.kind });
      break;
    case 'arena':
      emit({ t: 'openPanel', panel: 'arena' });
      break;
    case 'city':
      if (trial?.state === 'run') toast('已放弃本次秘境试炼', '#c4a78c');
      enterCity('portal');
      break;
    case 'next':
    case 'boss':
      nextFloor();
      break;
  }
}

function useDecor(p: Player, d: Decor): void {
  switch (INTERACT_DECOR[d.kind]) {
    case 'fountain': {
      if (d.v === 1) { toast('补给泉已经干涸', '#c4a78c'); return; }
      d.v = 1;
      if (d.light) d.light = { ...d.light, intensity: d.light.intensity * 0.3 };
      const hp = Math.max(0, p.stat.maxHp - p.hp), mp = Math.max(0, p.stat.maxMp - p.mp);
      p.hp = p.stat.maxHp;
      p.mp = p.stat.maxMp;
      if (hp > 0) floater(p.x, p.y - 26, `+${Math.round(hp)}`, '#7fe07f', 12);
      if (mp > 0) floater(p.x + 10, p.y - 14, `+${Math.round(mp)}`, '#7fb6d8', 11);
      emit({ t: 'sfx', name: 'potion', x: d.x, y: d.y });
      emit({ t: 'ring', x: d.x, y: d.y - 32, r0: 8, r1: 90, color: '#6fe6df', dur: 0.6 });
      toast('泉水涌遍全身 · 生命与源能已回满', '#6fe6df');
      return;
    }
    case 'altar': {
      if (d.v === 1) { toast('祭坛已经沉寂', '#c4a78c'); return; }
      altarPending = d;
      emit({ t: 'openPanel', panel: 'dialog', arg: 'event' });
      emit({ t: 'sfx', name: 'arcane', x: d.x, y: d.y });
      return;
    }
    case 'stash':
      emit({ t: 'openPanel', panel: 'stash' });
      emit({ t: 'sfx', name: 'ui' });
      return;
    default:
      return;
  }
}

/**
 * 事件祭坛二选一（UI 的 dialog 面板以 arg='event' 打开，文本见 LORE.altar；玩家选择后调用）。
 * 0 = 以血为契：献出 30% 最大生命，掉落一件史诗以上武器；1 = 静心祈愿：30 秒过载 + 护盾 + 回复 30% 生命。
 * 返回是否生效（没有待处理的祭坛时 false）。
 */
export function resolveAltar(choice: 0 | 1): boolean {
  const p = G.player, d = altarPending;
  altarPending = null;
  if (!p || !d || d.v === 1 || !G.decor.includes(d)) return false;
  d.v = 1;
  if (d.light) d.light = { ...d.light, intensity: d.light.intensity * 0.3, flicker: false };
  const c = decorAt(d);
  if (choice === 0) {
    const cost = Math.round(p.stat.maxHp * 0.3);
    p.hp = Math.max(1, p.hp - cost);
    floater(p.x, p.y - 24, `-${cost}`, '#ff6b6b', 13);
    const it = rollItem(areaLevel() + 2, { rarity: rng.chance(0.35) ? 4 : 3, slot: 'weapon', weaponType: weaponTypeOf(p.cid) });
    spawnDrop({ kind: 'item', x: c.x, y: c.y + 30, item: it });
    toast(`以血为契 · 祭坛吐出了 ${it.name}`, '#c070ff');
  } else {
    p.buffs.overload = Math.max(p.buffs.overload, 30);
    p.buffs.shield = Math.max(p.buffs.shield, p.stat.maxHp * 0.3);
    p.buffs.shieldT = Math.max(p.buffs.shieldT, 30);
    p.hp = Math.min(p.stat.maxHp, p.hp + p.stat.maxHp * 0.3);
    toast('静心祈愿 · 获得 30 秒源能过载与护盾', '#c070ff');
  }
  emit({ t: 'burst', x: c.x, y: c.y, color: '#c070ff', n: 26, spd: 140 });
  emit({ t: 'sfx', name: 'arcane', x: c.x, y: c.y });
  return true;
}

/* ------------------------------------------------------------------ */
/* 陷阱 / 可破坏物                                                       */
/* ------------------------------------------------------------------ */
/** 地刺是否升起（渲染层用同一函数决定帧） */
export function spikesUp(d: Decor, time: number = G.time): boolean {
  const ph = (((time + (d.v ?? 0) * 0.24) % SPIKE_PERIOD) + SPIKE_PERIOD) % SPIKE_PERIOD;
  return ph < SPIKE_UP;
}

function updateSpikes(dt: number, p: Player): void {
  spikeCd = Math.max(0, spikeCd - dt);
  if (spikeCd > 0 || p.dead || p.invuln > 0 || p.z > 4 || !spikes.length) return;
  for (const s of spikes) {
    const cx = s.x, cy = s.y - 16;
    if (Math.abs(p.x - cx) > 16 + p.r * 0.5 || Math.abs(p.y - cy) > 16 + p.r * 0.5) continue;
    if (!spikesUp(s)) continue;
    // 每次扎 6% 最大生命。combat.damagePlayer 会先减 armor×0.55，这里把减免补回去——
    // 修复：之前护甲把它吃成 1–5 点（Lv1 游侠每次 1 点，还不如脱战回血快），陷阱形同虚设
    const pct = Math.max(3, Math.round(p.stat.maxHp * SPIKE_PCT));
    damagePlayer(p, pct + Math.max(0, p.stat.armor) * 0.55, { el: 'physical', srcX: cx, srcY: cy });
    spikeCd = 0.9;
    return;
  }
}

/** 破坏一个装饰（木箱/木桶）：移除、恢复地面、爆点小东西 */
function breakDecor(d: Decor): void {
  const i = G.decor.indexOf(d);
  if (i >= 0) G.decor.splice(i, 1);
  const j = breakables.indexOf(d);
  if (j >= 0) breakables.splice(j, 1);
  const map = G.map;
  if (map && DECOR_KINDS[d.kind]?.block) {
    const fp = decorFootprint(d);
    for (let y = fp.ty; y < fp.ty + fp.h; y++) for (let x = fp.tx; x < fp.tx + fp.w; x++) {
      if (map.get(x, y) === T.BLOCK) map.set(x, y, T.FLOOR);
    }
    if (G.flow) G.flow.targetX = -1; // 地形变了：下一次 update 强制重建流场
  }
  const c = decorAt(d);
  emit({ t: 'burst', x: c.x, y: c.y, color: '#a0703c', n: 14, spd: 110 });
  emit({ t: 'sfx', name: 'hit', x: c.x, y: c.y, vol: 0.6 });
  const lv = areaLevel();
  if (rng.chance(0.4)) spawnDrop({ kind: 'gold', x: c.x, y: c.y, value: 2 + Math.round(lv * 0.8) });
  if (rng.chance(0.1)) spawnDrop({ kind: 'hp', x: c.x, y: c.y, value: 1 });
  if (rng.chance(0.06)) spawnDrop({ kind: 'mat', x: c.x, y: c.y, mat: rng.pick(['gem', 'part', 'essence'] as const), value: 1 });
}

/**
 * 对 (x,y) 半径 r 内的可破坏装饰造成 dmg 次伤害（木箱 1 下、木桶 2 下）。返回被击中的数量。
 * combat 可以在 AoE/光束命中时直接调用；world 自己也会扫描本步的刀光/爆炸事件与玩家投射物。
 */
export function damageDecorAt(x: number, y: number, r: number, dmg = 1): number {
  let n = 0;
  for (const d of breakables.slice()) {
    const c = decorAt(d);
    if (dist(x, y, c.x, c.y) > r + 12) continue;
    n++;
    d.hp = (d.hp ?? 1) - dmg;
    if (d.hp <= 0) breakDecor(d);
    else emit({ t: 'sfx', name: 'hit', x: c.x, y: c.y, vol: 0.4 });
  }
  return n;
}

function updateBreakables(): void {
  if (!breakables.length) return;
  for (const ev of G.events) {
    if (seenEvents.has(ev)) continue;
    seenEvents.add(ev);
    // 只有玩家方的刀光/爆炸能打碎木箱木桶（怪物爪击、首领陨石不算，否则战利品白送）
    if ((ev.t === 'slash' || ev.t === 'explosion') && ev.team === 'enemy') continue;
    if (ev.t === 'slash') {
      for (const d of breakables.slice()) {
        const c = decorAt(d);
        const dd = dist(ev.x, ev.y, c.x, c.y);
        if (dd > ev.r + 14) continue;
        const da = Math.abs(wrapAngle(Math.atan2(c.y - ev.y, c.x - ev.x) - ev.a));
        if (dd < 26 || da < 1.2) damageDecorAt(c.x, c.y, 1, 1);
      }
    } else if (ev.t === 'explosion') {
      damageDecorAt(ev.x, ev.y, ev.r, 2);
    }
  }
  for (const pr of G.projectiles) {
    if (pr.team !== 'player' || pr.life <= 0) continue;
    for (const d of breakables) {
      const c = decorAt(d);
      if (dist(pr.x, pr.y, c.x, c.y) > pr.r + 13) continue;
      damageDecorAt(c.x, c.y, 1, 1);
      if (pr.pierce <= 0) pr.life = 0;
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 每步更新                                                             */
/* ------------------------------------------------------------------ */
function updateVillagers(dt: number, map: GridMap, p: Player | null): void {
  for (const n of G.npcs) {
    if (n.role !== 'villager') continue;
    const home = homes.get(n.id);
    if (!home) continue;
    // 玩家靠近：停下来看着玩家
    if (p && dist(p.x, p.y, n.x, n.y) < 56) {
      n.facing = p.x < n.x ? -1 : 1;
      n.wanderT = Math.max(n.wanderT ?? 0, 0.6);
      continue;
    }
    if ((n.wanderT ?? 0) > 0) { n.wanderT = (n.wanderT ?? 0) - dt; continue; }
    if (n.wx === undefined || n.wy === undefined) {
      // 在家附近找一个能站下的目标点
      for (let t = 0; t < 8; t++) {
        const a = rng.range(0, Math.PI * 2), r = rng.range(16, VILLAGER_RANGE);
        const tx = home.x + Math.cos(a) * r, ty = home.y + Math.sin(a) * r;
        if (isFree(map, tx, ty, n.r + 2)) { n.wx = tx; n.wy = ty; break; }
      }
      if (n.wx === undefined) n.wanderT = rng.range(1, 2);
      home.stuck = 0;
      continue;
    }
    const dx = n.wx - n.x, dy = (n.wy ?? n.y) - n.y, l = Math.hypot(dx, dy);
    if (l < 3) {
      n.wx = undefined; n.wy = undefined;
      n.wanderT = rng.range(1.5, 4.5);
      continue;
    }
    const step = Math.min(l, VILLAGER_SPD * dt);
    const ox = n.x, oy = n.y;
    moveCircle(map, n, (dx / l) * step, (dy / l) * step);
    if (Math.abs(dx) > 1) n.facing = dx < 0 ? -1 : 1;
    // 被挡住（撞到建筑/树）就换个目标
    home.stuck = Math.hypot(n.x - ox, n.y - oy) < step * 0.3 ? home.stuck + dt : 0;
    if (home.stuck > 0.8) {
      n.wx = undefined; n.wy = undefined;
      n.wanderT = rng.range(0.5, 1.5);
      home.stuck = 0;
    }
  }
}

function checkBoss(): void {
  const b = bossRef;
  if (!b || trial) return;
  if (!(b.dead || b.hp <= 0 || !G.enemies.includes(b))) return;
  bossRef = null;
  if (G.boss === b) G.boss = null;
  const map = G.map;
  // 传送阵开在首领房中心偏北 2 格（首领的大宝箱掉在尸体脚下，二者不重叠）
  const at = bossSpot ? { x: bossSpot.x, y: bossSpot.y - 2 * TILE } : { x: b.x, y: b.y - 2 * TILE };
  const pos = map ? nearestFree(map, at.x, at.y, 20) : at;
  G.portals.push({ id: nextId(), kind: 'city', x: pos.x, y: pos.y, r: 30, label: '回城传送阵', open: true, target: 'city' });
  if (G.spawner) G.spawner.cap = 0; // 本层已肃清，不再补怪
  const name = b.def?.n ?? '首领';
  // combat.killEnemy 已播“击败 xx”横幅与胜利音效，这里补充传送阵信息
  emit({ t: 'banner', text: '回城传送阵已开启', sub: `${name} 已被击溃 · 走到传送阵按 F 返回曙光主城`, color: '#a3c979' });
  emit({ t: 'ring', x: pos.x, y: pos.y, r0: 8, r1: 150, color: '#a3c979', dur: 0.8 });
  emit({ t: 'burst', x: pos.x, y: pos.y, color: '#a3c979', n: 30, spd: 150 });
  emit({ t: 'sfx', name: 'portal', x: pos.x, y: pos.y });
  saveGame();
}

/** 竞技场：镜像死亡 → 停顿后 leaveArena(true)；返回 true 表示已离开竞技场 */
function updateArena(dt: number, p: Player): boolean {
  const r = rivalRef;
  if (r && arenaWinT < 0 && (r.dead || r.hp <= 0 || !G.enemies.includes(r))) {
    arenaWinT = ARENA_WIN_DELAY;
    p.invuln = Math.max(p.invuln, ARENA_WIN_DELAY + 0.5);
    emit({ t: 'banner', text: '胜利！', sub: '镜像已被击碎', color: '#f0bd7c' });
  }
  if (arenaWinT >= 0) {
    arenaWinT -= dt;
    if (arenaWinT <= 0) { leaveArena(true); return true; }
  } else if ((p.hp <= 0 || p.dead) && G.mode === 'play') {
    // 兜底：combat.playerDie 在竞技场里应直接调用 leaveArena(false)
    leaveArena(false);
    return true;
  }
  return false;
}

/** 走进开启的 'next' 传送阵自动进入下一层（改版意见：地图增加出口，不用打完所有怪） */
function autoPortal(p: Player): boolean {
  for (const pt of G.portals) {
    if (pt.kind !== 'next' || !pt.open) continue;
    if (dist(p.x, p.y, pt.x, pt.y) < pt.r) { nextFloor(); return true; }
  }
  return false;
}

/** 每步更新交互提示 G.hint、出口触发、传送阵触发 */
export function updateWorld(dt: number): void {
  const p = G.player, map = G.map;
  if (!map) { G.hint = null; return; }
  portalGrace = Math.max(0, portalGrace - dt);
  if (G.scene === 'city') updateVillagers(dt, map, p);
  if (!p) { G.hint = null; return; }
  if (G.scene === 'arena' && updateArena(dt, p)) return;
  if (G.scene === 'dungeon') {
    checkBoss();
    updateTrial(dt);
    updateSpikes(dt, p);
    updateBreakables();
    if (portalGrace <= 0 && !p.dead && autoPortal(p)) return;
  }
  const t = findTarget(p);
  G.hint = t ? { text: hintText(t), x: t.x, y: t.y } : null;
}

