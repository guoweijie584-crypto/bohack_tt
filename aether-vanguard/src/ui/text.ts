// 文本/格式化工具与物品提示框 HTML（纯函数，便于测试）。所有动态文本都经过 esc()。

import { DUNGEON_FLOORS } from '../config';
import { esc } from '../core/util';
import { AFFIX, RARITY, SLOTS } from '../data/items';
import type { AffixKey, WeaponType } from '../data/types';
import { affixText, itemPower, plusMul } from '../game/items';
import { G } from '../game/state';
import type { Item, ItemAffix, Player } from '../game/types';
import { DUNGEONS } from '../world/mapgen';
import { cssColor, safe } from './shared';

export const WEAPON_NAME: Record<WeaponType, string> = { sword: '剑', staff: '法杖', bow: '弓', dagger: '匕首' };
export const THEME_NAME: Record<string, string> = {
  city: '主城', ruins: '遗迹', magma: '熔岩', frost: '霜原', crypt: '墓穴', arena: '竞技场', secret: '秘境',
};

/** 百分比类词条（数值是小数） */
const PCT_KEYS = new Set<AffixKey>(['crit', 'cdr', 'spd']);

export function affixName(k: AffixKey): string {
  return AFFIX.find(a => a.k === k)?.n ?? k;
}

/** 词条数值格式：百分比类保留 1 位小数，其它取整 */
export function fmtAffixVal(k: AffixKey, v: number, sign = true): string {
  const s = sign && v >= 0 ? '+' : '';
  if (PCT_KEYS.has(k)) return `${s}${(v * 100).toFixed(1)}%`;
  return `${s}${Math.round(v)}`;
}

/** 强化倍率（与 player.recalc / items.powerOf 一致：词条实际值 = a.v × plusMul(plus)） */
function plusFactor(plus: number | undefined): number {
  const m = safe(() => plusMul(plus ?? 0), 1);
  return Number.isFinite(m) && m > 0 ? m : 1;
}

/**
 * 单条词条文字（优先用 items.affixText，未实现时本地格式化）。
 * plus 为该件装备的强化等级：显示含强化加成的实际数值（否则强化后提示框里的数字一点不变）。
 */
export function affixLine(a: ItemAffix, plus = 0): string {
  const v = a.v * plusFactor(plus);
  return safe(() => affixText({ ...a, v }), `${a.n || affixName(a.k)} ${fmtAffixVal(a.k, v)}`);
}

/** 整件装备各词条的实际数值之和（含强化加成，与 recalc 一致） */
export function sumAffixes(it: Item | null | undefined): Partial<Record<AffixKey, number>> {
  const out: Partial<Record<AffixKey, number>> = {};
  if (!it) return out;
  const m = plusFactor(it.plus);
  for (const a of it.affixes) out[a.k] = (out[a.k] ?? 0) + a.v * m;
  return out;
}

export interface AffixDiff { k: AffixKey; n: string; d: number }
/** 物品与当前装备的词条差值（非零项） */
export function compareItems(it: Item, cur: Item | null | undefined): AffixDiff[] {
  const a = sumAffixes(it), b = sumAffixes(cur);
  const keys = new Set<AffixKey>([...(Object.keys(a) as AffixKey[]), ...(Object.keys(b) as AffixKey[])]);
  const out: AffixDiff[] = [];
  for (const k of AFFIX.map(x => x.k)) {
    if (!keys.has(k)) continue;
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    const eps = PCT_KEYS.has(k) ? 0.0005 : 0.5;
    if (Math.abs(d) >= eps) out.push({ k, n: affixName(k), d });
  }
  return out;
}

export function rarityColor(r: number): string {
  return cssColor(RARITY[Math.max(0, Math.min(RARITY.length - 1, r))]?.c, '#c9b9a2');
}
export function rarityName(r: number): string {
  return RARITY[Math.max(0, Math.min(RARITY.length - 1, r))]?.n ?? '';
}

export function itemTitle(it: Item): string {
  return esc(it.name) + (it.plus > 0 ? ` <span class="gold">+${it.plus}</span>` : '');
}

export function itemPowerOf(it: Item | null | undefined): number {
  if (!it) return 0;
  return safe(() => Math.round(itemPower(it)), 0);
}

export interface TipOpts {
  /** 价格（商店/出售） */
  price?: number;
  priceLabel?: string;
  /** 与当前同部位装备对比 */
  compare?: boolean;
  /** 额外一行提示（操作说明） */
  note?: string;
}

/** 物品提示框 HTML：名字、品质、部位、等级、词条、与当前装备的差值、评分、价格 */
export function itemTipHtml(it: Item, p: Player | null, opts: TipOpts = {}): string {
  const rc = rarityColor(it.rarity);
  const sub = [rarityName(it.rarity), SLOTS[it.slot] + (it.weaponType ? '·' + WEAPON_NAME[it.weaponType] : ''), 'Lv.' + it.lv];
  const affixes = it.affixes.map(a => `<div class="tt-a">${esc(affixLine(a, it.plus))}</div>`).join('') || '<div class="tt-a dim">无词条</div>';
  let cmp = '';
  if (opts.compare && p) {
    const cur = p.equip[it.slot];
    if (cur && cur.uid === it.uid) {
      cmp = '<div class="tt-c dim">当前已装备</div>';
    } else if (!cur) {
      cmp = `<div class="tt-c dim">当前未装备${esc(SLOTS[it.slot])}</div>`;
    } else {
      const diffs = compareItems(it, cur);
      const rows = diffs.map(d => `<span class="${d.d > 0 ? 'up' : 'down'}">${esc(fmtAffixVal(d.k, d.d))} ${esc(d.n)}</span>`).join(' ');
      cmp = `<div class="tt-c"><span class="dim">对比 ${esc(cur.name)}：</span>${rows || '<span class="dim">无差别</span>'}</div>`;
    }
  }
  const pw = itemPowerOf(it);
  let pwTxt = `评分 ${pw}`;
  if (opts.compare && p) {
    const cur = p.equip[it.slot];
    if (cur && cur.uid !== it.uid) {
      const d = pw - itemPowerOf(cur);
      if (d !== 0) pwTxt += ` <span class="${d > 0 ? 'up' : 'down'}">(${d > 0 ? '+' : ''}${d})</span>`;
    }
  }
  const price = opts.price !== undefined
    ? `<div class="tt-p">${esc(opts.priceLabel ?? '价格')} <span class="gold">${Math.max(0, Math.round(opts.price))} 金币</span></div>` : '';
  const note = opts.note ? `<div class="tt-note dim">${esc(opts.note)}</div>` : '';
  return `<div class="tt-n" style="color:${rc}">${itemTitle(it)}</div>`
    + `<div class="tt-s dim">${sub.map(esc).join(' · ')}</div>`
    + affixes + cmp + `<div class="tt-pw">${pwTxt}</div>` + price + note;
}

/** 游戏时长：1 时 05 分 / 12 分 30 秒 */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h} 时 ${String(m).padStart(2, '0')} 分`;
  if (m > 0) return `${m} 分 ${String(r).padStart(2, '0')} 秒`;
  return `${r} 秒`;
}

/** m:ss（buff 剩余） */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 存档时间：11-15 01:23 */
export function fmtDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/** 当前区域名 */
export function zoneName(): string {
  if (G.scene === 'city') return '曙光主城';
  if (G.scene === 'arena') return '镜像竞技场';
  const d = DUNGEONS[G.dungeonId];
  if (!d) {
    if (G.dungeonId === 'secret' || G.theme === 'secret') return '秘境';
    return G.dungeonId || '迷宫';
  }
  const floors = typeof d.floors === 'number' && d.floors > 0 ? d.floors : DUNGEON_FLOORS;
  return floors <= 1 ? d.name : `${d.name} · 第 ${G.floor}/${floors} 层`;
}

/** 键帽 HTML */
export function kc(k: string): string {
  return `<span class="kc">${esc(k)}</span>`;
}
