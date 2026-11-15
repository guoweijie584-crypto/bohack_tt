// 装备/背包/商店/铁匠/仓库/药剂。移植自 legacy L632–648（rollItem/affixText）、L907–931（pickup）、L2861–2899（装备/出售/购买）。
// 【契约】签名不可改；实现由 progression 代理完成。
//
// 与 legacy 的差异：
// - 物品用字符串 uid（legacy 数字 id 读档后撞号，可能装备/卖错东西）；
// - 背包有格子上限，满了拒收（legacy 满 30 件丢弃最早的物品），卸装备也检查空位；
// - 武器分类型，只能被对应武器类型的职业装备；
// - 词条保护：至少 2 条、品质下限保护（见 itemgen.ts）；
// - 商店按 NPC 分货架（G.shops[shopKey]），铁匠强化消耗金币 + 材料。

import { BAG_SLOTS, MAX_LEVEL, STASH_SLOTS } from '../config';
import { rng } from '../core/rng';
import { clamp } from '../core/util';
import { clsOf } from '../data/classes';
import { RARITY, WEAPON_TYPE_NAMES } from '../data/items';
import type { SlotId, WeaponType } from '../data/types';
import {
  affixValue, formatAffix, generateItem, MAX_PLUS, newUid, pickWeighted, plusMul, powerOf, SLOT_IDS, weaponTypeOf,
} from './itemgen';
import { recalc } from './player';
import { saveGame } from './save';
import { emit, floater, G, toast } from './state';
import type { Item, ItemAffix, MaterialId, Player } from './types';

/**
 * 交易类操作（装备/卸下/买卖/刷新货架/买药/强化/存取仓库）成功后立即存档：UI 面板调用后不会存档，
 * 面板打开期间自动存档也暂停（legacy 每个操作都 saveGame）。只存当前角色（建角流程里 G.player 还不是 p）。
 */
function persist(p: Player): void {
  if (G.player === p) saveGame();
}

/** 词条实际值 = a.v × plusMul(it.plus)；比较/求和装备词条时请用 affixValue(it, a) */
export { MAX_PLUS, weaponTypeOf, newUid, plusMul, affixValue };

export interface RollOpts { rarity?: number; slot?: SlotId; weaponType?: WeaponType }
/**
 * 生成装备：每件至少 2 条有效词条；品质倍率下限保护（精良一定强于粗制）；带外观 sprite key。
 * - slot 不传则随机部位；weaponType 只在部位为武器时生效（不传则随机类型）；
 * - 想要一把指定类型的武器：rollItem(lv, { slot: 'weapon', weaponType })；
 * - 掉落（武器 60% 为当前职业类型）可直接用 rollDropItem(lv, cid, rarity)。
 */
export function rollItem(lv: number, opts: RollOpts = {}): Item { return generateItem(lv, opts); }

/** 词条文字（不含强化加成；含强化的整件文字用 itemAffixLines） */
export function affixText(a: ItemAffix): string { return formatAffix(a.k, a.v, a.n); }

/** 整件装备的词条文字（已乘强化倍率） */
export function itemAffixLines(it: Item): string[] {
  const m = plusMul(it.plus);
  return it.affixes.map(a => formatAffix(a.k, a.v * m, a.n));
}

/** 装备评分（用于比较、排序）：攻击当量，含强化加成 */
export function itemPower(it: Item): number { return powerOf(it); }

/** 掉落用：部位随机，若为武器则 60% 是该职业的武器类型 */
export function rollDropItem(lv: number, cid: string, rarity?: number): Item {
  const own = rng.chance(0.6) ? weaponTypeOf(cid) : undefined;
  return generateItem(lv, { rarity, weaponType: own });
}

/** 新角色的起始武器（粗制、职业对应类型） */
export function starterWeapon(cid: string): Item {
  return generateItem(1, { rarity: 0, slot: 'weapon', weaponType: weaponTypeOf(cid) });
}

/* ---------- 背包 ---------- */

function deny(text: string): false {
  toast(text, '#df8f7a');
  emit({ t: 'sfx', name: 'uiDeny' });
  return false;
}

/** 背包是否还有 n 格（改版意见 #21：满了装不进去） */
export function bagHasRoom(p: Player, n?: number): boolean {
  const k = n === undefined ? 1 : Math.max(0, Math.floor(n));
  return p.bag.length + k <= BAG_SLOTS;
}

/** 放入背包；满了返回 false（掉落留在地上并提示——提示已在这里发出，调用方不必重复） */
export function addToBag(p: Player, it: Item): boolean {
  if (!bagHasRoom(p)) return deny(`背包已满（${BAG_SLOTS} 格），整理或出售后再拾取`);
  delete it.cost;
  p.bag.push(it);
  return true;
}

/** 该职业能否装备这件物品（武器需武器类型一致；护甲/饰品不限） */
export function canEquip(p: Player, it: Item): boolean {
  return it.slot !== 'weapon' || it.weaponType === weaponTypeOf(p.cid);
}

export function equipItem(p: Player, uid: string): boolean {
  const i = p.bag.findIndex(it => it.uid === uid);
  if (i < 0) return false;
  const it = p.bag[i];
  if (!canEquip(p, it)) {
    const need = weaponTypeOf(p.cid);
    return deny(`职业不符：${clsOf(p.cid).name}只能装备${WEAPON_TYPE_NAMES[need]}`);
  }
  const old = p.equip[it.slot];
  p.equip[it.slot] = it;
  // 换下的装备放回原格子，背包顺序不乱
  if (old) p.bag[i] = old;
  else p.bag.splice(i, 1);
  recalc(p);
  emit({ t: 'sfx', name: 'pickupItem' });
  emit({ t: 'ui', what: 'hud' });
  toast(`已装备 ${it.name}`, RARITY[it.rarity]?.c);
  persist(p);
  return true;
}

export function unequip(p: Player, slot: SlotId): boolean {
  const it = p.equip[slot];
  if (!it) return false;
  if (!bagHasRoom(p)) return deny('背包已满，无法卸下装备');
  p.equip[slot] = null;
  p.bag.push(it);
  recalc(p);
  emit({ t: 'ui', what: 'hud' });
  persist(p);
  return true;
}

/** 出售价 = 基础价值 × 0.6 */
export const sellPrice = (it: Item): number => Math.round(it.value * 0.6);

export function sellItem(p: Player, uid: string): boolean {
  const i = p.bag.findIndex(it => it.uid === uid);
  if (i < 0) return false;
  const it = p.bag[i];
  const g = sellPrice(it);
  p.bag.splice(i, 1);
  p.gold += g;
  emit({ t: 'sfx', name: 'pickupCoin' });
  toast(`出售 ${it.name} · +${g} G`, '#f2cd8c');
  persist(p);
  return true;
}

/** 背包整理：按部位、评分降序 */
export function sortBag(p: Player): void {
  const order: Record<SlotId, number> = { weapon: 0, armor: 1, trinket: 2 };
  p.bag.sort((a, b) => order[a.slot] - order[b.slot] || powerOf(b) - powerOf(a) || b.rarity - a.rarity);
}

/* ---------- 商店 ---------- */

/** 商店品质权重（粗制/精良/稀有/史诗），比随机掉落略好 */
const SHOP_RARITY_W = [30, 35, 25, 10];
export const SHOP_REROLL_COST = 20;
/** 货架价格 = 基础价值 × 1.7 + 30 */
export const shopCost = (it: Item): number => Math.round(it.value * 1.7 + 30);

/**
 * 生成/刷新某个商店货架，同时写入 G.shops[shopKey]（buyItem 从这里找货）。
 * - 'smith'：6 件武器/护甲（3+3，前两把武器是当前角色可用的类型），等级≈玩家等级，品质 0–3；
 * - 'potion'：3 件饰品（药剂按 potionPrice 另售）；
 * - 其它 key（如补给房间）：4 件随机部位。
 */
export function rollShop(shopKey: string, lv: number): Item[] {
  const L = clamp(Math.floor(Number.isFinite(lv) ? lv : 1), 1, MAX_LEVEL);
  const own = G.player ? weaponTypeOf(G.player.cid) : undefined;
  const r = (): number => pickWeighted(SHOP_RARITY_W, () => rng.next());
  const ilv = (): number => clamp(L + rng.int(-1, 1), 1, MAX_LEVEL);
  const items: Item[] = [];
  if (shopKey === 'smith') {
    for (let i = 0; i < 3; i++) items.push(generateItem(ilv(), { slot: 'weapon', rarity: r(), weaponType: i < 2 ? own : undefined }));
    for (let i = 0; i < 3; i++) items.push(generateItem(ilv(), { slot: 'armor', rarity: r() }));
  } else if (shopKey === 'potion') {
    for (let i = 0; i < 3; i++) items.push(generateItem(ilv(), { slot: 'trinket', rarity: r() }));
  } else {
    for (let i = 0; i < 4; i++) items.push(generateItem(ilv(), { rarity: r() }));
  }
  for (const it of items) it.cost = shopCost(it);
  G.shops[shopKey] = items;
  return items;
}

/** 花 20 金币刷新货架 */
export function rerollShop(p: Player, shopKey: string): boolean {
  if (p.gold < SHOP_REROLL_COST) return deny('金币不足');
  p.gold -= SHOP_REROLL_COST;
  rollShop(shopKey, p.lv);
  emit({ t: 'sfx', name: 'buy' });
  persist(p);
  return true;
}

export function buyItem(p: Player, shopKey: string, uid: string): boolean {
  const shelf = G.shops[shopKey];
  if (!shelf) return false;
  const i = shelf.findIndex(it => it.uid === uid);
  if (i < 0) return false;
  const it = shelf[i];
  const cost = it.cost ?? shopCost(it);
  if (p.gold < cost) return deny('金币不足');
  if (!bagHasRoom(p)) return deny('背包已满');
  p.gold -= cost;
  shelf.splice(i, 1);
  delete it.cost;
  p.bag.push(it);
  emit({ t: 'sfx', name: 'buy' });
  toast(`购入 ${it.name} · -${cost} G`, RARITY[it.rarity]?.c);
  persist(p);
  return true;
}

/* ---------- 药剂 ---------- */

/** 每种药剂的携带上限 */
export const POTION_CAP = 99;
const potionPriceAt = (kind: 'hp' | 'mp', lv: number): number => (kind === 'hp' ? 40 : 35) + Math.max(1, lv) * 2;

/** 药剂单价：生命 40+lv×2、源能 35+lv×2（lv = 当前角色等级） */
export function potionPrice(kind: 'hp' | 'mp'): number { return potionPriceAt(kind, G.player?.lv ?? 1); }

export function buyPotion(p: Player, kind: 'hp' | 'mp', n?: number): boolean {
  if (kind !== 'hp' && kind !== 'mp') return false;
  const room = POTION_CAP - p.potions[kind];
  if (room <= 0) return deny('药剂已达携带上限');
  // 数量为 NaN 时按 1 瓶：clamp(NaN) 仍是 NaN，金币与药剂数会变成 NaN 并写进存档（±Infinity 由 clamp 夹到 1..99）
  const want = n === undefined || Number.isNaN(n) ? 1 : Math.floor(n);
  const k = Math.min(room, clamp(want, 1, POTION_CAP));
  const cost = potionPriceAt(kind, p.lv) * k;
  if (p.gold < cost) return deny('金币不足');
  p.gold -= cost;
  p.potions[kind] += k;
  emit({ t: 'sfx', name: 'buy' });
  toast(`购入${kind === 'hp' ? '生命' : '源能'}药剂 ×${k} · -${cost} G`, '#a3c979');
  persist(p);
  return true;
}

/** 喝药（满了不能喝）：生命 +40%、源能 +50% */
export function usePotion(p: Player, kind: 'hp' | 'mp'): boolean {
  if (p.dead || p.hp <= 0) return false;
  if (kind === 'hp') {
    if (p.potions.hp <= 0) return deny('没有生命药剂了');
    if (p.hp >= p.stat.maxHp) return deny('生命已满');
    const before = p.hp;
    p.hp = Math.min(p.stat.maxHp, p.hp + p.stat.maxHp * 0.4);
    p.potions.hp--;
    floater(p.x, p.y - 24, `+${Math.round(p.hp - before)}`, '#8fe08a', 12);
  } else if (kind === 'mp') {
    if (p.potions.mp <= 0) return deny('没有源能药剂了');
    if (p.mp >= p.stat.maxMp) return deny('源能已满');
    const before = p.mp;
    p.mp = Math.min(p.stat.maxMp, p.mp + p.stat.maxMp * 0.5);
    p.potions.mp--;
    floater(p.x, p.y - 24, `+${Math.round(p.mp - before)}`, '#7fb6d8', 12);
  } else {
    return false;
  }
  emit({ t: 'sfx', name: 'potion', x: p.x, y: p.y });
  return true;
}

/* ---------- 铁匠强化 ---------- */

/** 铁匠强化：消耗金币 + 材料，plus+1，数值提升 */
export function upgradeCost(it: Item): { gold: number; mats: Partial<Record<MaterialId, number>> } {
  const plus = clamp(Math.floor(it.plus || 0), 0, MAX_PLUS);
  const gold = Math.round(60 * (plus + 1) * (1 + it.rarity * 0.5));
  const mats: Partial<Record<MaterialId, number>> = { part: plus + 1 };
  if (plus >= 3) mats.gem = plus - 2;
  if (it.weaponType === 'staff') mats.essence = Math.ceil((plus + 1) / 2);
  return { gold, mats };
}

export const MAT_IDS: readonly MaterialId[] = ['gem', 'part', 'essence'];

/** 强化背包或身上的装备（仓库里的需先取出） */
export function upgradeItem(p: Player, uid: string): boolean {
  const f = findItem(p, uid);
  if (!f) return false;
  if (f.where === 'stash') return deny('请先从仓库取出再强化');
  const it = f.item;
  if (it.plus >= MAX_PLUS) return deny(`已达强化上限 +${MAX_PLUS}`);
  const cost = upgradeCost(it);
  if (p.gold < cost.gold) return deny('金币不足');
  for (const m of MAT_IDS) {
    const need = cost.mats[m] ?? 0;
    if (need > 0 && p.mats[m] < need) return deny(`${MAT_NAMES[m]}不足（需要 ${need}）`);
  }
  p.gold -= cost.gold;
  for (const m of MAT_IDS) p.mats[m] -= cost.mats[m] ?? 0;
  it.plus++;
  recalc(p);
  emit({ t: 'sfx', name: 'forge', x: p.x, y: p.y });
  emit({ t: 'ui', what: 'hud' });
  toast(`强化成功：${it.name} +${it.plus}`, '#f0bd7c');
  persist(p);
  return true;
}

/* ---------- 仓库 ---------- */

/** 仓库（新手村存储箱） */
export function toStash(p: Player, uid: string): boolean {
  const i = p.bag.findIndex(it => it.uid === uid);
  if (i < 0) return false;
  if (p.stash.length >= STASH_SLOTS) return deny(`仓库已满（${STASH_SLOTS} 格）`);
  p.stash.push(p.bag.splice(i, 1)[0]);
  persist(p);
  return true;
}

export function fromStash(p: Player, uid: string): boolean {
  const i = p.stash.findIndex(it => it.uid === uid);
  if (i < 0) return false;
  if (!bagHasRoom(p)) return deny('背包已满');
  p.bag.push(p.stash.splice(i, 1)[0]);
  persist(p);
  return true;
}

/** 按 uid 查找背包/装备/仓库里的物品 */
export function findItem(p: Player, uid: string): { item: Item; where: 'bag' | 'equip' | 'stash' } | null {
  for (const it of p.bag) if (it.uid === uid) return { item: it, where: 'bag' };
  for (const s of SLOT_IDS) {
    const it = p.equip[s];
    if (it && it.uid === uid) return { item: it, where: 'equip' };
  }
  for (const it of p.stash) if (it.uid === uid) return { item: it, where: 'stash' };
  return null;
}
export const MAT_NAMES: Record<MaterialId, string> = { gem: '源能宝石', part: '机械零件', essence: '元素精华' };
