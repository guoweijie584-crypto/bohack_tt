// 装备生成与规范化（progression 辅助模块）。纯数据函数：不读写 G、不调用 recalc，
// 因此 player.ts（融合时重铸武器）与 items.ts（背包/商店）都能依赖它而不产生循环引用。
//
// 设计要点（修正 legacy L637–648）：
// - 词条数 = clamp(2+品质, 2, 6)，同一件不重复；第一条是部位主词条（武器=攻击、护甲=护甲、饰品按类型）。
// - 单条数值 v = lerp(min,max, 0.35+0.65·rand) × (1+lv×0.075) × 品质倍率。
// - 品质下限保护：整件评分低于“低一档品质的理论上限”时整体抬升，保证同等级下精良一定强于粗制。
// - 掉落品质按等级插值的权重表（legacy Lv1 就有 13% 传说，过高）。

import { MAX_LEVEL } from '../config';
import { rng } from '../core/rng';
import { clamp, lerp } from '../core/util';
import { clsOf } from '../data/classes';
import {
  AFFIX, ARMOR_NAMES, ARMOR_TYPES, DAGGER_EXTRA, DAGGER_EXTRA_CHANCE, HEAVY_CHANCE, HEAVY_LOOKS, PRIMARY_AFFIX,
  RARITY, TRINKET_NAMES, TRINKET_TYPES, WEAPON_LOOKS,
  type ArmorType, type ItemLook, type TrinketType,
} from '../data/items';
import type { AffixDef, AffixKey, SlotId, WeaponType } from '../data/types';
import { arr, int, isObj, nonNeg, num, str } from './sanitize';
import type { Item, ItemAffix } from './types';

export const SLOT_IDS: readonly SlotId[] = ['weapon', 'armor', 'trinket'];
export const WEAPON_TYPES: readonly WeaponType[] = ['sword', 'staff', 'bow', 'dagger'];
/** 铁匠强化上限与每级词条加成 */
export const MAX_PLUS = 10;
export const PLUS_STEP = 0.08;

/** 以百分比表示、保留 3 位小数的词条 */
const PCT_KEYS: ReadonlySet<AffixKey> = new Set<AffixKey>(['crit', 'cdr', 'spd']);
const PCT_LABEL: Record<string, string> = { crit: '暴击', cdr: '冷却缩减', spd: '移速' };
const AFFIX_BY_KEY = new Map<AffixKey, AffixDef>(AFFIX.map(a => [a.k, a]));

/** 随机源：默认用全局战斗 rng；测试或联机可以传入种子实例的 next */
export type RandFn = () => number;
const defRand: RandFn = () => rng.next();

const pick = <T>(a: readonly T[], rand: RandFn): T => a[Math.min(a.length - 1, Math.floor(rand() * a.length))];

/** 按权重抽下标 */
export function pickWeighted(w: readonly number[], rand: RandFn = defRand): number {
  const total = w.reduce((s, x) => s + Math.max(0, x), 0);
  let x = rand() * total;
  for (let i = 0; i < w.length; i++) {
    x -= Math.max(0, w[i]);
    if (x < 0) return i;
  }
  return w.length - 1;
}

/** 物品 uid：优先 crypto.randomUUID（非安全上下文/旧环境不可用时退化为随机串） */
export function newUid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  try {
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch { /* 非安全上下文可能抛错，走下面的退化方案 */ }
  const r = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `it-${Date.now().toString(36)}-${r()}${r()}`;
}

/** 职业对应的武器类型（战士/骑士/甲士/风暴守卫=剑，法师系=法杖，游侠=弓，刺客/忍者/风暴刺客=匕首） */
export const weaponTypeOf = (cid: string): WeaponType => clsOf(cid).weapon;

/** 等级倍率（legacy 1+lv×0.075） */
export const lvMul = (lv: number): number => 1 + Math.max(0, lv) * 0.075;
/** 强化倍率：每 +1 让该件所有词条 ×(1+0.08) 线性叠加 */
export const plusMul = (plus: number): number => 1 + PLUS_STEP * clamp(Math.floor(num(plus, 0)), 0, MAX_PLUS);

/* ---------- 品质 ---------- */

/** 掉落品质权重：Lv1 → Lv50 线性插值（粗制/精良/稀有/史诗/传说） */
const RARITY_W_LO = [62, 26, 9, 2.6, 0.4];
const RARITY_W_HI = [22, 34, 27, 13, 4];
export function rarityWeights(lv: number): number[] {
  const t = clamp((lv - 1) / (MAX_LEVEL - 1), 0, 1);
  return RARITY_W_LO.map((w, i) => lerp(w, RARITY_W_HI[i], t));
}
export function rollRarity(lv: number, rand: RandFn = defRand): number {
  return pickWeighted(rarityWeights(lv), rand);
}

/* ---------- 词条 ---------- */

export const affixMax = (k: AffixKey): number => AFFIX_BY_KEY.get(k)?.max ?? 1;
export const affixName = (k: AffixKey): string => AFFIX_BY_KEY.get(k)?.n ?? k;
export const isAffixKey = (k: unknown): k is AffixKey => typeof k === 'string' && AFFIX_BY_KEY.has(k as AffixKey);
export const roundAffix = (k: AffixKey, v: number): number => (PCT_KEYS.has(k) ? Math.round(v * 1000) / 1000 : Math.round(v));
const ceilAffix = (k: AffixKey, v: number): number => (PCT_KEYS.has(k) ? Math.ceil(v * 1000 - 1e-9) / 1000 : Math.ceil(v - 1e-9));

/** 词条数：至少 2 条，品质越高越多（粗制 2 → 传说 6），且不超过词条种类数 */
export const affixCount = (r: number): number => clamp(2 + clamp(r, 0, 4), 2, Math.min(6, AFFIX.length));

/** 单条词条的“攻击当量”评分：每种词条在表内上限 = 10 分 */
export const affixScore = (k: AffixKey, v: number): number => (v / affixMax(k)) * 10;

/** 某品质在某等级下的理论最高评分（每条词条都 roll 到上限） */
export const powerCap = (r: number, lv: number): number =>
  affixCount(r) * 10 * lvMul(lv) * RARITY[clamp(r, 0, 4)].mul;

/** 品质下限：低一档理论上限 ×1.02 + 2（绝对余量抵消整数词条的四舍五入） */
export const powerFloor = (r: number, lv: number): number => (r <= 0 ? 0 : powerCap(r - 1, lv) * 1.02 + 2);

/** 词条文字：+12 攻击 / +5.4% 暴击 */
export function formatAffix(k: AffixKey, v: number, n?: string): string {
  if (PCT_KEYS.has(k)) return `+${Math.round(v * 1000) / 10}% ${PCT_LABEL[k]}`;
  return `+${Math.round(v)} ${n || affixName(k)}`;
}

/**
 * 掷词条：主词条（可空）+ 随机不重复的其余词条，最后做品质下限保护。
 * 下限保护只在整件评分不足时按比例抬升（向上取整），绝大多数情况下保持公式原样。
 */
export function rollAffixes(lv: number, r: number, primary: AffixKey | null, rand: RandFn = defRand): ItemAffix[] {
  const rr = clamp(Math.round(r), 0, 4);
  const n = affixCount(rr);
  const keys: AffixKey[] = primary ? [primary] : [];
  const rest = AFFIX.map(a => a.k).filter(k => k !== primary);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  for (const k of rest) {
    if (keys.length >= n) break;
    keys.push(k);
  }
  const mul = lvMul(lv) * RARITY[rr].mul;
  const out: ItemAffix[] = keys.map(k => {
    const d = AFFIX_BY_KEY.get(k);
    const lo = d ? d.min : 1, hi = d ? d.max : 1;
    return { k, n: affixName(k), v: roundAffix(k, lerp(lo, hi, 0.35 + 0.65 * rand()) * mul) };
  });
  const floor = powerFloor(rr, lv);
  const pow = out.reduce((s, a) => s + affixScore(a.k, a.v), 0);
  if (floor > 0 && pow < floor) {
    const s = floor / Math.max(pow, 1e-6);
    for (const a of out) a.v = ceilAffix(a.k, a.v * s);
  }
  return out;
}

/** 装备评分（攻击当量，含强化加成），保留 1 位小数 */
export function powerOf(it: Pick<Item, 'affixes' | 'plus'>): number {
  const m = plusMul(it.plus);
  let s = 0;
  for (const a of it.affixes) s += affixScore(a.k, a.v * m);
  return Math.round(s * 10) / 10;
}

/** 某件装备某条词条的实际数值（含强化） */
export const affixValue = (it: Pick<Item, 'plus'>, a: ItemAffix): number => a.v * plusMul(it.plus);

/* ---------- 外观与名字 ---------- */

/** 品质映射到外观档位（档位数不足 5 时按比例：2 档 → 粗制/精良/稀有用第 0 档，史诗/传说用第 1 档） */
const tierIndex = (r: number, n: number): number => Math.min(n - 1, Math.floor((clamp(r, 0, 4) * n) / 5));

export function weaponLook(type: WeaponType, r: number, rand: RandFn = defRand): ItemLook {
  const rr = clamp(Math.round(r), 0, 4);
  if (type === 'sword' && rand() < HEAVY_CHANCE) return pick(HEAVY_LOOKS[rr], rand);
  if (type === 'dagger' && rand() < DAGGER_EXTRA_CHANCE) return DAGGER_EXTRA;
  const tiers = WEAPON_LOOKS[type];
  return tiers[tierIndex(rr, tiers.length)];
}
export const armorSprite = (t: ArmorType, r: number): string => `armor_${t}_${clamp(Math.round(r), 0, 4)}`;
export const trinketSprite = (t: TrinketType, r: number): string => `trinket_${t}_${clamp(Math.round(r), 0, 4)}`;
export const itemName = (r: number, base: string): string => `「${RARITY[clamp(Math.round(r), 0, 4)].n}」${base}`;
/** 基础价值（legacy 公式）；出售 ×0.6，商店 ×1.7+30 */
export const itemValue = (r: number, lv: number): number => Math.round(24 + r * 38 + lv * 8);

/** 武器改换类型：外观与名字一起换，保留 uid/品质/词条/强化（融合转职时武器类型变化用） */
export function reforgeWeapon(it: Item, type: WeaponType, rand: RandFn = defRand): void {
  if (it.slot !== 'weapon') return;
  const look = weaponLook(type, it.rarity, rand);
  it.weaponType = type;
  it.sprite = look.sprite;
  it.name = itemName(it.rarity, pick(look.names, rand));
}

/* ---------- 生成 ---------- */

export interface GenOpts { rarity?: number; slot?: SlotId; weaponType?: WeaponType }

/**
 * 生成一件装备。部位：opts.slot，否则随机；weaponType 只在部位为武器时生效（不指定则随机类型）。
 * 想要“一把指定类型的武器”请同时传 slot:'weapon'。
 */
export function generateItem(lv: number, opts: GenOpts = {}, rand: RandFn = defRand): Item {
  const L = clamp(Math.floor(num(lv, 1)), 1, MAX_LEVEL);
  const r = opts.rarity !== undefined && Number.isFinite(opts.rarity)
    ? clamp(Math.round(opts.rarity), 0, 4)
    : rollRarity(L, rand);
  const slot: SlotId = opts.slot && SLOT_IDS.includes(opts.slot) ? opts.slot : pick(SLOT_IDS, rand);
  let sprite: string, base: string, primary: AffixKey;
  let weaponType: WeaponType | undefined;
  if (slot === 'weapon') {
    weaponType = opts.weaponType && WEAPON_TYPES.includes(opts.weaponType) ? opts.weaponType : pick(WEAPON_TYPES, rand);
    const look = weaponLook(weaponType, r, rand);
    sprite = look.sprite;
    base = pick(look.names, rand);
    primary = PRIMARY_AFFIX.weapon;
  } else if (slot === 'armor') {
    const t = pick(ARMOR_TYPES, rand);
    sprite = armorSprite(t, r);
    base = pick(ARMOR_NAMES[t], rand);
    primary = PRIMARY_AFFIX.armor;
  } else {
    const t = pick(TRINKET_TYPES, rand);
    sprite = trinketSprite(t, r);
    base = pick(TRINKET_NAMES[t], rand);
    primary = PRIMARY_AFFIX.trinket[t];
  }
  const it: Item = {
    uid: newUid(), slot, rarity: r, affixes: rollAffixes(L, r, primary, rand), lv: L,
    name: itemName(r, base), value: itemValue(r, L), plus: 0, sprite,
  };
  if (weaponType) it.weaponType = weaponType;
  return it;
}

/* ---------- 读档规范化 ---------- */

/** 从（legacy）名字推断武器类型；推断不出返回 null（如“脉动铳”） */
export function inferWeaponType(name: string): WeaponType | null {
  if (/弓/.test(name)) return 'bow';
  if (/杖/.test(name)) return 'staff';
  if (/剑|锤|斧|棒/.test(name)) return 'sword';
  if (/刃|匕|刀/.test(name)) return 'dagger';
  return null;
}
export function inferArmorType(name: string): ArmorType {
  if (/皮|软甲|轻甲/.test(name)) return 'leather';
  if (/袍|斗篷/.test(name)) return 'robe';
  return 'plate';
}
export function inferTrinketType(name: string): TrinketType {
  if (/指环|戒/.test(name)) return 'ring';
  if (/芯片|核心/.test(name)) return 'chip';
  return 'amulet';
}

export interface NormalizeOpts {
  /** 强制武器类型（legacy 导入：旧武器一律转成当前职业可用的类型） */
  forceWeaponType?: WeaponType;
  /** 已用 uid（去重：legacy 数字 id 读档后会撞号） */
  uids?: Set<string>;
}

/**
 * 把存档里的物品（v3 或 legacy v1/v2）规范成完整 Item：校验字段、补 uid/sprite/weaponType、剔除货架价格。
 * 无法识别的数据返回 null。
 */
export function normalizeItem(raw: unknown, o: NormalizeOpts = {}): Item | null {
  if (!isObj(raw)) return null;
  const slot = SLOT_IDS.find(s => s === raw.slot);
  if (!slot) return null;
  const r = int(raw.rarity, 0, 4, 0);
  const lv = int(raw.lv, 1, MAX_LEVEL, 1);
  const affixes: ItemAffix[] = [];
  for (const a of arr(raw.affixes)) {
    if (!isObj(a) || !isAffixKey(a.k)) continue;
    const v = num(a.v, 0);
    if (v <= 0) continue;
    affixes.push({ k: a.k, n: affixName(a.k), v: roundAffix(a.k, v) });
  }
  let uid = str(raw.uid);
  if (!uid || o.uids?.has(uid)) uid = newUid();
  o.uids?.add(uid);
  const rawName = str(raw.name).slice(0, 40);
  const it: Item = {
    uid, slot, rarity: r, affixes, lv,
    name: rawName,
    value: Math.round(nonNeg(raw.value)) || itemValue(r, lv),
    plus: int(raw.plus, 0, MAX_PLUS, 0),
    sprite: str(raw.sprite),
  };
  if (slot === 'weapon') {
    const declared = WEAPON_TYPES.find(t => t === raw.weaponType);
    const inferred = inferWeaponType(rawName);
    const type = o.forceWeaponType ?? declared ?? inferred ?? 'sword';
    if (declared === type && it.sprite && it.name) {
      it.weaponType = type;
    } else if (!declared && inferred === type && it.name) {
      // 旧名字与类型相符：保留旧名，只补外观
      it.weaponType = type;
      it.sprite = WEAPON_LOOKS[type][tierIndex(r, WEAPON_LOOKS[type].length)].sprite;
    } else {
      reforgeWeapon(it, type);
    }
  } else if (slot === 'armor') {
    if (!/^armor_(plate|robe|leather)_[0-4]$/.test(it.sprite)) it.sprite = armorSprite(inferArmorType(rawName), r);
    if (!it.name) it.name = itemName(r, ARMOR_NAMES[inferArmorType(rawName)][0]);
  } else {
    if (!/^trinket_(ring|amulet|chip)_[0-4]$/.test(it.sprite)) it.sprite = trinketSprite(inferTrinketType(rawName), r);
    if (!it.name) it.name = itemName(r, TRINKET_NAMES[inferTrinketType(rawName)][0]);
  }
  return it;
}
