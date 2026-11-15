// 多角色存档槽（改版意见：不能转职，但可以开不同的人物；登录后不用每次重新开始）。
// 存档只保存持久字段（剔除派生 stat、坐标、冷却），并保存 uid 计数；兼容迁移 legacy v2/v1 存档。
// 【契约】签名不可改；实现由 progression 代理完成。
//
// 说明：
// - 槽位 key：`${SAVE_PREFIX}_slot_<n>`，内容 { v:3, savedAt, p:<持久字段> }；
// - 物品 uid 是随机 UUID（不再依赖递增计数），读档时校验并去重；
// - 无 localStorage（Node/隐私模式/禁用存储）时所有函数安全降级：读返回空，写静默失败；
// - 读档会补默认字段并 recalc(refill)，因此旧版本/手改的存档也能载入。

import { BAG_SLOTS, LEGACY_SAVE_KEYS, MAX_LEVEL, SAVE_PREFIX, STASH_SLOTS } from '../config';
import { clamp } from '../core/util';
import { clsOf, fusionOf, isBaseClass, isClassId } from '../data/classes';
import { ROUTES, TREES } from '../data/trees';
import type { RouteId } from '../data/types';
import { normalizeItem, SLOT_IDS, weaponTypeOf } from './itemgen';
import { expForLevel, FUSE_TP, makePlayer, recalc, SP_PER_LEVEL, TP_PER_LEVEL } from './player';
import { arr, int, isObj, nonNeg, str, type Obj } from './sanitize';
import { G } from './state';
import type { Item, MaterialId, Player } from './types';

export const SLOT_COUNT = 4;
export interface SlotInfo { slot: number; name: string; cid: string; lv: number; bestFloor: number; playTime: number; updatedAt: number }

/** 存档格式版本 */
export const SAVE_VERSION = 3;
export const slotKey = (n: number): string => `${SAVE_PREFIX}_slot_${n}`;
const validSlot = (n: number): boolean => Number.isInteger(n) && n >= 0 && n < SLOT_COUNT;

/** legacy v1 职业 id 映射（legacy L651） */
export const V1MAP: Readonly<Record<string, string>> = { vanguard: 'warrior', astromancer: 'pyro', ranger: 'ranger', machinist: 'storm' };

/** 落盘字段：剔除 stat、坐标、速度、status、anim、cd、buffs、无敌/冲刺计时等运行态（读档后由 makePlayer/recalc 重建） */
const PERSIST_KEYS = [
  'name', 'cid', 'route', 'lv', 'exp', 'sp', 'tp', 'stats', 'tree', 'routeTree', 'ultList', 'ult',
  'gold', 'kills', 'bossKills', 'deaths', 'playTime', 'bestFloor', 'fragments', 'fusedFrom',
  'equip', 'bag', 'stash', 'potions', 'mats', 'arenaWins', 'streak', 'bestStreak',
] as const satisfies ReadonlyArray<keyof Player>;
export type SavedPlayer = Pick<Player, (typeof PERSIST_KEYS)[number]>;

const POTION_MAX = 99;
const MAT_IDS: readonly MaterialId[] = ['gem', 'part', 'essence'];

/* ---------- 存储访问（全部 try/catch，安全降级） ---------- */

function storage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls && typeof ls.getItem === 'function' ? ls : null;
  } catch {
    return null; // 某些浏览器禁用存储时访问 localStorage 本身就会抛 SecurityError
  }
}
function readJson(key: string): unknown {
  const ls = storage();
  if (!ls) return null;
  try {
    const s = ls.getItem(key);
    return s ? (JSON.parse(s) as unknown) : null;
  } catch {
    return null;
  }
}

/* ---------- 写 ---------- */

/** 持久字段的浅视图（不拷贝） */
function persistView(p: Player): Partial<Record<keyof SavedPlayer, unknown>> {
  const o: Partial<Record<keyof SavedPlayer, unknown>> = {};
  for (const k of PERSIST_KEYS) o[k] = p[k];
  return o;
}
/** JSON 序列化时剔除货架价格 */
const stripCost = (key: string, v: unknown): unknown => (key === 'cost' ? undefined : v);

/** 只取持久字段（深拷贝；剔除货架价格）——联机同步/导出备份可复用 */
export function serializePlayer(p: Player): SavedPlayer {
  return JSON.parse(JSON.stringify(persistView(p), stripCost)) as SavedPlayer;
}

/** 把任意角色写入指定槽位（不看 G.mode；导入旧档、建角时用），成功返回 true */
export function writeSlot(slot: number, p: Player): boolean {
  const ls = storage();
  if (!ls || !validSlot(slot)) return false;
  try {
    ls.setItem(slotKey(slot), JSON.stringify({ v: SAVE_VERSION, savedAt: Date.now(), p: persistView(p) }, stripCost));
    return true;
  } catch {
    return false; // 配额满、循环引用等
  }
}

/** 保存当前 G.player 到 G.slot（G.mode==='title' 时不保存；死亡也要保存死亡计数） */
export function saveGame(): void {
  if (G.mode === 'title' || !G.player) return;
  writeSlot(G.slot, G.player);
}

/* ---------- 读 ---------- */

/** 列出所有槽位（空槽为 null） */
export function listSlots(): Array<SlotInfo | null> {
  const out: Array<SlotInfo | null> = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const d = readJson(slotKey(i));
    if (!isObj(d) || !isObj(d.p)) { out.push(null); continue; }
    const p = d.p;
    const cid = isClassId(p.cid) ? p.cid : 'warrior';
    out.push({
      slot: i,
      name: str(p.name) || clsOf(cid).name,
      cid,
      lv: int(p.lv, 1, MAX_LEVEL, 1),
      bestFloor: int(p.bestFloor, 0, 9999, 0),
      playTime: nonNeg(p.playTime),
      updatedAt: nonNeg(d.savedAt),
    });
  }
  return out;
}

/** 第一个空槽（没有返回 -1） */
export function firstEmptySlot(): number {
  const s = listSlots();
  return s.findIndex(x => x === null);
}

/** 读取槽位并迁移成完整 Player（含 recalc），失败返回 null */
export function loadSlot(slot: number): Player | null {
  if (!validSlot(slot)) return null;
  const d = readJson(slotKey(slot));
  if (!isObj(d) || !isObj(d.p)) return null;
  try {
    return hydrate(d.p, false);
  } catch {
    return null;
  }
}

export function deleteSlot(slot: number): void {
  const ls = storage();
  if (!ls || !validSlot(slot)) return;
  try { ls.removeItem(slotKey(slot)); } catch { /* 忽略 */ }
}

/* ---------- legacy 导入 ---------- */

/** 检测并导入 legacy 存档（aether_vanguard_save_v2 / v1）为一个新角色，返回导入的 Player。
 *  只读不写：调用方用 firstEmptySlot()+writeSlot() 落盘（不会删除旧档）。 */
export function importLegacy(): Player | null {
  for (const key of LEGACY_SAVE_KEYS) {
    const d = readJson(key);
    if (!isObj(d) || !isObj(d.p)) continue;
    try {
      return hydrate(d.p, true);
    } catch {
      /* 损坏的旧档：试下一个 key */
    }
  }
  return null;
}

export function hasLegacy(): boolean {
  return LEGACY_SAVE_KEYS.some(k => {
    const d = readJson(k);
    return isObj(d) && isObj(d.p);
  });
}

/* ---------- 迁移 ---------- */

/** 融合来源：v3 存档直接读 fusedFrom；legacy 没有该字段，按（技能树点数、职业档案等级）推断 */
function resolveFusedFrom(cid: string, raw: unknown, tree: Obj | null, classLv: Obj | null): string | null {
  const f = fusionOf(cid);
  if (!f) return null;
  if (typeof raw === 'string' && f.from.includes(raw)) return raw;
  const score = (id: string): number => {
    const t = tree && isObj(tree[id]) ? tree[id] as Obj : null;
    const pts = t ? int(t.A, 0, 4, 0) + int(t.B, 0, 4, 0) : 0;
    const lv = classLv ? int(classLv[id], 0, MAX_LEVEL, 0) : 0;
    return pts * 1000 + lv;
  };
  return score(f.from[1]) > score(f.from[0]) ? f.from[1] : f.from[0];
}

function readTree(raw: Obj | null, cid: string): { A: number; B: number } {
  const rec = raw && isObj(raw[cid]) ? raw[cid] as Obj : null;
  const t = TREES[cid];
  const nA = t ? t.A.nodes.length : 4, nB = t ? t.B.nodes.length : 4;
  return { A: rec ? int(rec.A, 0, nA, 0) : 0, B: rec ? int(rec.B, 0, nB, 0) : 0 };
}

/**
 * 把存档对象（v3 或 legacy v1/v2 的 p）迁移成完整 Player。
 * legacy=true 时：职业 id 走 V1MAP；单一 routeTree 数字 → 当前路线计数；旧武器转成职业可用类型；
 * sp/tp 按新规则重算（等级发放 − 已用点数，去掉旧版重复融合 +6 与切职业多练的点数）。
 */
function hydrate(o: Obj, legacy: boolean): Player {
  const rawCid = str(o.cid);
  const mapped = legacy && Object.hasOwn(V1MAP, rawCid) ? V1MAP[rawCid] : rawCid;
  const cid = isClassId(mapped) ? mapped : 'warrior';
  const route: RouteId = o.route === 'tech' ? 'tech' : 'magic';
  const name = legacy ? `${clsOf(cid).name}·旧档` : str(o.name);
  const p = makePlayer(cid, route, name);

  const rawTree = isObj(o.tree) ? o.tree : null;
  p.fusedFrom = resolveFusedFrom(cid, o.fusedFrom, rawTree, isObj(o.classLv) ? o.classLv : null);
  if (p.fusedFrom && !isBaseClass(p.fusedFrom)) p.fusedFrom = null;

  // 等级与经验
  p.lv = int(o.lv, 1, MAX_LEVEL, 1);
  p.expNext = expForLevel(p.lv);
  p.exp = p.lv >= MAX_LEVEL ? 0 : clamp(Math.floor(nonNeg(o.exp)), 0, p.expNext - 1);

  // 属性点分配
  const st = isObj(o.stats) ? o.stats : {};
  p.stats = { str: int(st.str, 0, 9999, 0), agi: int(st.agi, 0, 9999, 0), int: int(st.int, 0, 9999, 0), vit: int(st.vit, 0, 9999, 0) };

  // 技能树：只保留当前职业（与融合来源）的树
  p.tree = { [cid]: readTree(rawTree, cid) };
  if (p.fusedFrom) p.tree[p.fusedFrom] = readTree(rawTree, p.fusedFrom);

  // 路线树：legacy 是共用的单个数字（bug），记到当前路线上
  const nMagic = ROUTES.magic.nodes.length, nTech = ROUTES.tech.nodes.length;
  if (typeof o.routeTree === 'number') {
    p.routeTree = { magic: 0, tech: 0 };
    p.routeTree[route] = int(o.routeTree, 0, route === 'magic' ? nMagic : nTech, 0);
  } else if (isObj(o.routeTree)) {
    p.routeTree = { magic: int(o.routeTree.magic, 0, nMagic, 0), tech: int(o.routeTree.tech, 0, nTech, 0) };
  }

  // 点数
  if (legacy) {
    const spent = (['A', 'B'] as const).reduce((s, br) => s + Object.values(p.tree).reduce((a, t) => a + t[br], 0), 0)
      + p.routeTree.magic + p.routeTree.tech;
    const statSum = p.stats.str + p.stats.agi + p.stats.int + p.stats.vit;
    p.tp = Math.max(0, (p.lv - 1) * TP_PER_LEVEL + (p.fusedFrom ? FUSE_TP : 0) - spent);
    p.sp = Math.max(0, (p.lv - 1) * SP_PER_LEVEL - statSum);
  } else {
    p.tp = int(o.tp, 0, 99999, 0);
    p.sp = int(o.sp, 0, 99999, 0);
  }

  // 奥义：ultList 由树状态派生（recalc→syncUlts），这里只保留玩家选择的那个
  p.ultList = arr(o.ultList).filter((u): u is string => typeof u === 'string');
  p.ult = typeof o.ult === 'string' ? o.ult : null;

  // 统计
  p.gold = Math.floor(nonNeg(o.gold));
  p.kills = Math.floor(nonNeg(o.kills));
  p.bossKills = Math.floor(nonNeg(o.bossKills));
  p.deaths = Math.floor(nonNeg(o.deaths));
  p.playTime = nonNeg(o.playTime);
  p.bestFloor = int(o.bestFloor, 0, 9999, 0);
  p.fragments = [...new Set(arr(o.fragments).filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0))];
  p.arenaWins = Math.floor(nonNeg(o.arenaWins));
  p.streak = Math.floor(nonNeg(o.streak));
  p.bestStreak = Math.max(p.streak, Math.floor(nonNeg(legacy ? o.best : o.bestStreak)));

  if (isObj(o.potions)) p.potions = { hp: int(o.potions.hp, 0, POTION_MAX, 0), mp: int(o.potions.mp, 0, POTION_MAX, 0) };
  if (isObj(o.mats)) {
    const m = o.mats;
    for (const k of MAT_IDS) p.mats[k] = Math.floor(nonNeg(m[k]));
  }

  // 物品：校验、补 uid/sprite/weaponType、去重 uid
  const uids = new Set<string>();
  const force = legacy ? weaponTypeOf(cid) : undefined;
  const norm = (raw: unknown): Item | null => normalizeItem(raw, { forceWeaponType: force, uids });
  const bag: Item[] = [];
  const stash: Item[] = [];
  const equipRaw = isObj(o.equip) ? o.equip : {};
  for (const s of SLOT_IDS) {
    const it = norm(equipRaw[s]);
    if (!it) continue;
    const fits = it.slot === s && (s !== 'weapon' || it.weaponType === weaponTypeOf(cid));
    if (fits) p.equip[s] = it;
    else bag.push(it); // 部位或武器类型不符：放回背包
  }
  for (const raw of arr(o.bag)) {
    const it = norm(raw);
    if (it) bag.push(it);
  }
  for (const raw of arr(o.stash)) {
    const it = norm(raw);
    if (it) stash.push(it);
  }
  // 背包超出格子上限（legacy 上限 30 > 24）：多出的移进仓库；仓库也满则仍留在背包，不丢物品
  while (bag.length > BAG_SLOTS && stash.length < STASH_SLOTS) {
    const it = bag.pop();
    if (it) stash.unshift(it);
  }
  p.bag = bag;
  p.stash = stash;

  recalc(p, true);
  return p;
}
