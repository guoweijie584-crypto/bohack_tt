// 掉落与拾取：经验球/金币/药剂/材料自动吸附拾取；装备需左键点击或 F 拾取（背包满则留在地上）；宝箱（小/中/大）开箱。
// 移植自 legacy L907–931（dropLoot/pickup）、L1522–1536（updateDrops）。
// 修正：背包满时不再丢弃最早物品（改版意见 #21）；装备等级 = 怪物等级（不再取玩家等级）；
//       召唤物/镜像不掉落；掉落带弹出动画并走碰撞（不会掉进墙里）；点击拾取要求在可及范围内且无墙阻隔。
// 【契约】签名不可改；实现由 world 代理完成。

import { rng } from '../core/rng';
import { clamp, dist } from '../core/util';
import { DUNGEONS, floorBaseLevel } from '../data/dungeons';
import { RARITY } from '../data/items';
import type { SlotId, WeaponType } from '../data/types';
import { isFree, moveCircle, nearestFree } from '../world/collision';
import { lineOfSight } from '../world/los';
import { addToBag, bagHasRoom, MAT_NAMES, POTION_CAP, rollItem, weaponTypeOf } from './items';
import { gainExp } from './player';
import { saveGame } from './save';
import { G, emit, floater, nextId, toast } from './state';
import type { Drop, DropKind, Enemy, Item, MaterialId, Player } from './types';

export interface DropInit { kind: DropKind; x: number; y: number; value?: number; item?: Item; mat?: MaterialId; tier?: number }

/** 自动拾取半径（经验/金币/药剂/材料） */
export const PICK_R = 24;
/** 吸附半径 */
export const MAGNET_R = 130;
/** 经验/金币落地多少秒后全图吸附 */
export const VACUUM_AGE = 8;
/** 全图吸附飞行速度（世界单位/秒） */
export const VACUUM_SPD = 520;
/** 地上掉落超过该数量时，经验/金币立即全图吸附 */
export const CROWDED_DROPS = 150;
/** F 交互半径（与 world.ts 交互、提示一致） */
export const INTERACT_R = 76;
/** 点击判定半径（鼠标点到物品的距离） */
export const CLICK_R = 26;
/** 点击拾取时玩家与物品的最大距离 */
export const CLICK_REACH = 160;

/** 存在时长：装备 120s、其余 60s；宝箱不消失（开启后 25s 淡出） */
const LIFE: Record<DropKind, number> = { exp: 60, gold: 60, hp: 60, mp: 60, mat: 60, item: 120, chest: Infinity };
const AUTO: ReadonlySet<DropKind> = new Set<DropKind>(['exp', 'gold', 'hp', 'mp', 'mat']);
const MATS: readonly MaterialId[] = ['gem', 'part', 'essence'];
const WEAPONS: readonly WeaponType[] = ['sword', 'staff', 'bow', 'dagger'];
const SLOTS: readonly SlotId[] = ['weapon', 'armor', 'trinket'];
const GRAVITY = 560;
const BODY = { x: 0, y: 0, r: 5 };
/** 宝箱占地半径（不水平滑动、不走碰撞，生成时直接挪到空地） */
const CHEST_R = 8;

/** 当前区域的掉落等级（副本层基准等级；主城/竞技场取玩家等级） */
export function areaLevel(): number {
  const p = G.player;
  if (G.scene === 'dungeon' && DUNGEONS[G.dungeonId]) return floorBaseLevel(G.dungeonId, G.floor, p?.bestFloor ?? 1);
  return Math.max(1, p?.lv ?? 1);
}

/** 需要手动拾取/开启的地上物（装备、未开的宝箱） */
export function isManualPickup(d: Drop): boolean {
  return d.kind === 'item' || (d.kind === 'chest' && !d.opened);
}

/** 自动拾取物此刻能不能收（药剂到上限时留在地上，也不吸附） */
function canCollect(p: Player, d: Drop): boolean {
  if (d.kind === 'hp' || d.kind === 'mp') return p.potions[d.kind] < POTION_CAP;
  return true;
}

export function spawnDrop(init: DropInit): Drop {
  const chest = init.kind === 'chest';
  const a = rng.range(0, Math.PI * 2);
  const s = chest ? 0 : rng.range(24, 70);
  // 宝箱没有水平速度、不会被 moveCircle 推出墙：落点在墙里（贴南墙倒下的精英 e.y+14、试炼奖励 p.x-24）
  // 时挪到最近空地，否则箱子画在墙里、隔墙点不中（clickPickup 要求视线）
  let x = init.x, y = init.y;
  if (chest && G.map && !isFree(G.map, x, y, CHEST_R)) ({ x, y } = nearestFree(G.map, x, y, CHEST_R, 4));
  const d: Drop = {
    id: nextId(),
    kind: init.kind,
    x,
    y,
    z: 0,
    vz: chest ? 0 : rng.range(120, 180),
    vx: Math.cos(a) * s,
    vy: Math.sin(a) * s,
    value: init.value ?? 0,
    life: LIFE[init.kind],
  };
  if (init.item) d.item = init.item;
  if (init.mat) d.mat = init.mat;
  if (chest) { d.tier = clamp(Math.round(init.tier ?? 0), 0, 2); d.opened = false; }
  G.drops.push(d);
  return d;
}

/** 把一笔经验/金币拆成 n 颗（手感更好）；总量不变 */
function splitDrop(kind: 'exp' | 'gold', x: number, y: number, total: number, n: number): void {
  total = Math.max(1, Math.round(total));
  n = Math.max(1, Math.min(n, total));
  const each = Math.floor(total / n);
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? total - each * (n - 1) : each;
    spawnDrop({ kind, x: x + rng.range(-6, 6), y: y + rng.range(-6, 6), value: v });
  }
}

/** 掉一件装备：武器 60% 为当前职业武器类型 */
function dropItem(x: number, y: number, lv: number, rarity: number | undefined): Drop {
  const p = G.player;
  const slot = rng.pick(SLOTS);
  let weaponType: WeaponType | undefined;
  if (slot === 'weapon') weaponType = p && rng.chance(0.6) ? weaponTypeOf(p.cid) : rng.pick(WEAPONS);
  const it = rollItem(Math.max(1, Math.round(lv)), { rarity, slot, weaponType });
  const d = spawnDrop({ kind: 'item', x, y, item: it });
  floater(x, y - 20, '◆ ' + it.name, RARITY[clamp(it.rarity, 0, RARITY.length - 1)]?.c ?? '#fff3dd', 10);
  return d;
}

function dropChest(x: number, y: number, tier: number): void {
  const c = spawnDrop({ kind: 'chest', x, y, tier });
  c.vz = 200;
}

/** 敌人死亡掉落（经验、金币、药剂、材料、装备；精英/Boss 掉宝箱） */
export function dropLoot(e: Enemy): void {
  if (e.summonedBy !== undefined || e.rival) return; // 召唤物、镜像对手不掉落
  const boss = e.boss, elite = e.elite && !boss;
  // 必掉：经验球与金币
  splitDrop('exp', e.x, e.y, e.exp, boss ? 6 : elite ? 3 : 1);
  splitDrop('gold', e.x + 6, e.y, e.gold, boss ? 5 : elite ? 2 : 1);
  // 药剂：血 18%、蓝 14%（首领必掉）
  if (boss || rng.chance(0.18)) spawnDrop({ kind: 'hp', x: e.x - 8, y: e.y, value: 1 });
  if (boss || rng.chance(0.14)) spawnDrop({ kind: 'mp', x: e.x + 8, y: e.y, value: 1 });
  // 材料：普通 12%、精英 60%、首领必掉多份
  if (boss) {
    for (const m of MATS) spawnDrop({ kind: 'mat', x: e.x, y: e.y, mat: m, value: rng.int(1, 2) });
    for (let i = rng.int(1, 2); i > 0; i--) spawnDrop({ kind: 'mat', x: e.x, y: e.y, mat: rng.pick(MATS), value: 1 });
  } else if (rng.chance(elite ? 0.6 : 0.12)) {
    spawnDrop({ kind: 'mat', x: e.x, y: e.y, mat: rng.pick(MATS), value: elite ? rng.int(1, 2) : 1 });
  }
  // 装备：首领 95%（2 件史诗/传说）、精英 35%（精良–史诗）、普通 9%（按品质公式）；等级 = 怪物等级
  const lv = Math.max(1, Math.round(e.lv || G.player?.lv || 1));
  if (boss) {
    if (rng.chance(0.95)) for (let i = 0; i < 2; i++) dropItem(e.x, e.y, lv, rng.int(3, 4));
  } else if (elite) {
    if (rng.chance(0.35)) dropItem(e.x, e.y, lv, rng.int(1, 3));
  } else if (rng.chance(0.09)) {
    dropItem(e.x, e.y, lv, undefined);
  }
  // 宝箱：首领大宝箱、精英 35% 中宝箱
  if (boss) dropChest(e.x, e.y + 18, 2);
  else if (elite && rng.chance(0.35)) dropChest(e.x, e.y + 14, 1);
}

/* ------------------------------------------------------------------ */
/* 拾取                                                                 */
/* ------------------------------------------------------------------ */
let lastBagToast = -Infinity;

function removeDrop(d: Drop): void {
  const i = G.drops.indexOf(d);
  if (i >= 0) G.drops.splice(i, 1);
}

/** 自动拾取（经验/金币/药剂/材料） */
function collect(d: Drop): void {
  const p = G.player;
  if (!p) return;
  switch (d.kind) {
    case 'exp':
      gainExp(p, d.value);
      floater(d.x, d.y - 8, `+${d.value} EXP`, '#a3c979', 10);
      emit({ t: 'pickup', x: d.x, y: d.y, kind: 'exp', color: '#7ff0a8' });
      emit({ t: 'sfx', name: 'pickupExp', x: d.x, y: d.y, vol: 0.5 });
      break;
    case 'gold':
      p.gold += d.value;
      floater(d.x, d.y - 8, `+${d.value} G`, '#f2cd8c', 10);
      emit({ t: 'pickup', x: d.x, y: d.y, kind: 'gold', color: '#f2cd8c' });
      emit({ t: 'sfx', name: 'pickupCoin', x: d.x, y: d.y, vol: 0.6 });
      break;
    case 'hp':
    case 'mp':
      p.potions[d.kind] = Math.min(POTION_CAP, p.potions[d.kind] + Math.max(1, d.value));
      floater(d.x, d.y - 8, d.kind === 'hp' ? '+ 生命药剂' : '+ 源能药剂', d.kind === 'hp' ? '#df8f7a' : '#7fb6d8', 10);
      emit({ t: 'pickup', x: d.x, y: d.y, kind: d.kind, color: d.kind === 'hp' ? '#df8f7a' : '#7fb6d8' });
      emit({ t: 'sfx', name: 'pickupItem', x: d.x, y: d.y, vol: 0.5 });
      break;
    case 'mat': {
      const m: MaterialId = d.mat ?? 'gem';
      const n = Math.max(1, d.value);
      p.mats[m] = (p.mats[m] ?? 0) + n;
      floater(d.x, d.y - 8, `+${n} ${MAT_NAMES[m] ?? m}`, '#c9a2f0', 10);
      emit({ t: 'pickup', x: d.x, y: d.y, kind: 'mat', color: '#c9a2f0' });
      emit({ t: 'sfx', name: 'pickupItem', x: d.x, y: d.y, vol: 0.5 });
      break;
    }
    default:
      break;
  }
}

/** 装备入包；背包满则留在地上并提示（不再丢最早的物品） */
function pickItem(d: Drop): boolean {
  const p = G.player;
  if (!p || !d.item) return false;
  if (!bagHasRoom(p, 1) || !addToBag(p, d.item)) {
    if (G.realTime - lastBagToast > 1.2 || lastBagToast > G.realTime) {
      lastBagToast = G.realTime;
      toast('背包已满，装备留在原地 · 先去整理背包或存入仓库', '#df8f7a');
      emit({ t: 'sfx', name: 'uiDeny' });
    }
    return false;
  }
  const c = RARITY[clamp(d.item.rarity, 0, RARITY.length - 1)]?.c ?? '#f0bd7c';
  toast(`拾取 ${d.item.name}`, c);
  emit({ t: 'pickup', x: d.x, y: d.y, kind: 'item', color: c });
  emit({ t: 'sfx', name: 'pickupItem', x: d.x, y: d.y });
  removeDrop(d);
  saveGame();
  return true;
}

/** 开宝箱：品阶越高奖励越多（金币/经验/药剂/材料/装备爆一地，装备仍需拾取） */
function openChest(d: Drop): void {
  if (d.opened) return;
  d.opened = true;
  d.life = 25;
  const tier = clamp(d.tier ?? 0, 0, 2);
  const lv = areaLevel();
  emit({ t: 'chestOpen', id: d.id });
  emit({ t: 'sfx', name: 'chest', x: d.x, y: d.y });
  emit({ t: 'burst', x: d.x, y: d.y - 10, color: ['#f2cd8c', '#a3c9f0', '#f0bd7c'][tier], n: 16 + tier * 12, spd: 120 + tier * 40 });
  const mul = [1, 2.4, 5][tier];
  splitDrop('gold', d.x, d.y + 4, (12 + lv * 4) * mul * rng.range(0.85, 1.15), 2 + tier * 2);
  splitDrop('exp', d.x, d.y + 4, (8 + lv * 5) * [1, 2, 4][tier], 1 + tier);
  if (rng.chance([0.4, 0.65, 1][tier])) spawnDrop({ kind: rng.chance(0.55) ? 'hp' : 'mp', x: d.x, y: d.y + 4, value: 1 });
  const mats = [rng.chance(0.5) ? 1 : 0, rng.int(1, 2), 3][tier];
  for (let i = 0; i < mats; i++) spawnDrop({ kind: 'mat', x: d.x, y: d.y + 4, mat: rng.pick(MATS), value: 1 });
  const items = tier === 0 ? (rng.chance(0.3) ? 1 : 0) : tier;
  const rr: readonly [number, number] = ([[0, 2], [1, 3], [2, 4]] as const)[tier];
  for (let i = 0; i < items; i++) dropItem(d.x, d.y + 6, lv, rng.int(rr[0], rr[1]));
}

/** 处理一个手动拾取目标（装备入包 / 开宝箱） */
function handleManual(d: Drop): void {
  if (d.kind === 'chest') openChest(d);
  else if (d.kind === 'item') pickItem(d);
}

export function updateDrops(dt: number): void {
  const p = G.player, map = G.map;
  const list = G.drops;
  const crowded = list.length > CROWDED_DROPS;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    d.life -= dt;
    // 弹出：竖直方向抛物线 + 落地反弹
    if (d.z > 0 || d.vz !== 0) {
      d.vz -= GRAVITY * dt;
      d.z += d.vz * dt;
      if (d.z <= 0) {
        d.z = 0;
        d.vz = Math.abs(d.vz) > 90 ? -d.vz * 0.35 : 0;
      }
    }
    // 水平：阻尼滑行，带墙体碰撞
    if (d.vx !== 0 || d.vy !== 0) {
      const k = Math.max(0, 1 - dt * 3);
      if (map) {
        BODY.x = d.x; BODY.y = d.y;
        moveCircle(map, BODY, d.vx * dt, d.vy * dt);
        d.x = BODY.x; d.y = BODY.y;
      } else {
        d.x += d.vx * dt; d.y += d.vy * dt;
      }
      d.vx *= k; d.vy *= k;
      if (Math.abs(d.vx) < 1 && Math.abs(d.vy) < 1) { d.vx = 0; d.vy = 0; }
    }
    if (!p || p.dead || !AUTO.has(d.kind) || !canCollect(p, d)) continue;
    // 全图吸附：经验/金币存在超过 VACUUM_AGE 秒（或地上掉落过多）时直接飞向玩家，不受墙阻挡。
    // 避免高击杀率时地上堆积数百个掉落拖垮帧率（实机：600 个掉落 → 22fps）
    if ((d.kind === 'exp' || d.kind === 'gold') && (crowded || LIFE[d.kind] - d.life > VACUUM_AGE)) {
      const vx = p.x - d.x, vy = p.y - d.y, vd = Math.hypot(vx, vy);
      if (vd > 1) {
        const s = Math.min(vd, VACUUM_SPD * dt);
        d.x += (vx / vd) * s;
        d.y += (vy / vd) * s;
      }
      if (dist(d.x, d.y, p.x, p.y) < PICK_R) { collect(d); d.life = 0; }
      continue;
    }
    // 吸附 + 自动拾取
    const dd = dist(d.x, d.y, p.x, p.y);
    if (dd < MAGNET_R && dd > 4) {
      const s = Math.min(dd, (MAGNET_R - dd) * 3 * dt + 40 * dt);
      const mx = ((p.x - d.x) / dd) * s, my = ((p.y - d.y) / dd) * s;
      if (map) {
        BODY.x = d.x; BODY.y = d.y;
        moveCircle(map, BODY, mx, my);
        d.x = BODY.x; d.y = BODY.y;
      } else {
        d.x += mx; d.y += my;
      }
    }
    if (dist(d.x, d.y, p.x, p.y) < PICK_R) {
      collect(d);
      d.life = 0;
    }
  }
  // 原地压缩移除过期/已拾取的（保持数组引用不变，渲染层可长期持有）
  let w = 0;
  for (let i = 0; i < list.length; i++) if (list[i].life > 0) list[w++] = list[i];
  list.length = w;
}

/**
 * 点击世界坐标拾取装备/开宝箱。
 * 返回 true 表示点击命中了地上物并已处理（包括“背包已满”提示），调用方不要再普攻；
 * 没点中、或物品离玩家太远/隔着墙，返回 false。
 */
export function clickPickup(x: number, y: number): boolean {
  const p = G.player;
  if (!p) return false;
  let best: Drop | null = null, bd = Infinity;
  for (const d of G.drops) {
    if (!isManualPickup(d)) continue;
    const r = d.kind === 'chest' ? CLICK_R + 8 : CLICK_R;
    const dd = dist(d.x, d.y - d.z, x, y);
    if (dd < r && dd < bd) { bd = dd; best = d; }
  }
  if (!best) return false;
  if (dist(p.x, p.y, best.x, best.y) > CLICK_REACH) return false;
  if (G.map && !lineOfSight(G.map, p.x, p.y, best.x, best.y)) return false;
  handleManual(best);
  return true;
}

/** 玩家身边最近的可手动拾取物（装备/未开宝箱），在 INTERACT_R 内 */
export function nearestManualPickup(): Drop | null {
  const p = G.player;
  if (!p) return null;
  let best: Drop | null = null, bd = INTERACT_R;
  for (const d of G.drops) {
    if (!isManualPickup(d)) continue;
    const dd = dist(d.x, d.y, p.x, p.y);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

/** F 键：拾取/开启玩家身边最近的装备或宝箱（背包满时提示并返回 true） */
export function interactPickup(): boolean {
  const d = nearestManualPickup();
  if (!d) return false;
  handleManual(d);
  return true;
}
