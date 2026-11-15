// 面板公共片段：物品格子、键值行、按钮、立绘、物品查找与提示框 provider。

import { esc } from '../../core/util';
import * as itemsMod from '../../game/items';
import { findItem } from '../../game/items';
import { G } from '../../game/state';
import type { Item, Player } from '../../game/types';
import { iconHtml, skinUrl } from '../bridge';
import { registerTip } from '../feedback';
import { classIcon, ico, type IconName } from '../icons';
import { safe } from '../shared';
import { itemTipHtml, rarityColor } from '../text';

/** 部位兜底图标 */
const SLOT_ICON: Record<Item['slot'], IconName> = { weapon: 'sword', armor: 'shield', trinket: 'gem' };

/** 物品图标：优先渲染层登记的精灵（0x72 帧或程序化图标），未登记时用像素兜底图标 */
export function itemIcon(it: Item, scale = 2): string {
  const h = it.sprite ? iconHtml(it.sprite, scale) : '';
  if (h && !h.includes('px-missing')) return h;
  return ico(SLOT_ICON[it.slot] ?? 'gem', scale, it.slot === 'trinket' ? rarityColor(it.rarity) : undefined);
}

export interface CellOpts {
  act?: string;
  /** data-tip（默认 item:uid） */
  tip?: string;
  selected?: boolean;
  /** 底部小字（价格等） */
  label?: string;
  dim?: boolean;
}

/** 物品格子（品质色边框 + 强化等级角标） */
export function itemCell(it: Item, o: CellOpts = {}): string {
  const rc = rarityColor(it.rarity);
  const cls = ['cell', `r${it.rarity}`, o.selected ? 'sel' : '', o.dim ? 'dim' : ''].filter(Boolean).join(' ');
  return `<button class="${cls}" style="--rc:${rc}"${o.act ? ` data-act="${esc(o.act)}" data-v="${esc(it.uid)}"` : ''} data-tip="${esc(o.tip ?? 'item:' + it.uid)}">`
    + `<span class="cell-ico">${itemIcon(it, 2)}</span>`
    + (it.plus > 0 ? `<span class="cell-plus">+${it.plus}</span>` : '')
    + (o.label ? `<span class="cell-lb">${esc(o.label)}</span>` : '')
    + '</button>';
}
export function emptyCell(label = ''): string {
  return `<div class="cell empty">${label ? `<span class="cell-lb dim">${esc(label)}</span>` : ''}</div>`;
}
/** 固定格数的网格（不足补空格） */
export function cellGrid(items: readonly Item[], slots: number, cell: (it: Item) => string, cols = 6): string {
  const parts = items.slice(0, slots).map(cell);
  for (let i = items.length; i < slots; i++) parts.push(emptyCell());
  return `<div class="cells" style="--cols:${cols}">${parts.join('')}</div>`;
}

export function kv(label: string, valueHtml: string, icon = ''): string {
  return `<div class="kv"><span class="dim">${icon}${esc(label)}</span><b>${valueHtml}</b></div>`;
}

export function btn(label: string, act: string, v = '', o: { primary?: boolean; danger?: boolean; disabled?: boolean; small?: boolean; tip?: string } = {}): string {
  const cls = ['btn', o.primary ? 'primary' : '', o.danger ? 'danger' : '', o.small ? 'sm' : ''].filter(Boolean).join(' ');
  return `<button class="${cls}" data-act="${esc(act)}" data-v="${esc(v)}"${o.disabled ? ' disabled' : ''}${o.tip ? ` data-tip="text:${esc(o.tip)}"` : ''}>${esc(label)}</button>`;
}

export function sec(title: string, extra = ''): string {
  return `<h4>${esc(title)}${extra ? ` <span class="h4x">${extra}</span>` : ''}</h4>`;
}

/** 职业/NPC 立绘：渲染层登记了皮肤就用图片，否则用像素徽记（带 pt-fallback 标记，皮肤就绪后可替换） */
export function portrait(id: string, scale = 3, isClass = true): string {
  const url = skinUrl(id);
  if (url) return `<img class="portrait" alt="" src="${esc(url)}" style="--s:${scale}">`;
  return isClass ? classIcon(id, scale, 'pt-fallback') : ico('person', scale, undefined, 'pt-fallback');
}

/** NPC 立绘：英雄皮肤 → 0x72 帧（xxx_idle_anim_f0 / xxx_anim_f0）→ 像素兜底 */
export function npcPortrait(sprite: string, scale = 3): string {
  const url = skinUrl(sprite);
  if (url) return `<img class="portrait" alt="" src="${esc(url)}" style="--s:${scale}">`;
  for (const k of [`${sprite}_idle_anim_f0`, `${sprite}_anim_f0`, sprite]) {
    const h = iconHtml(k, scale);
    if (!h.includes('px-missing')) return h;
  }
  return ico('person', scale);
}

/** 在背包/装备/仓库里找物品 */
export function lookupItem(p: Player, uid: string): { item: Item; where: 'bag' | 'equip' | 'stash' } | null {
  const hit = safe(() => findItem(p, uid), null);
  if (hit) return hit;
  // 兜底：items.findItem 未实现时本地查找
  const inBag = p.bag.find(i => i.uid === uid);
  if (inBag) return { item: inBag, where: 'bag' };
  for (const k of ['weapon', 'armor', 'trinket'] as const) if (p.equip[k]?.uid === uid) return { item: p.equip[k]!, where: 'equip' };
  const inStash = p.stash.find(i => i.uid === uid);
  return inStash ? { item: inStash, where: 'stash' } : null;
}

/** 出售价格展示（items 模块若导出 sellPrice 则以其为准，否则按 legacy 估算 60%） */
export function sellPriceOf(it: Item): number {
  const fallback = Math.max(1, Math.round((it.value || 0) * 0.6));
  return safe(() => {
    const fn = (itemsMod as unknown as { sellPrice?: (x: Item) => number }).sellPrice;
    return typeof fn === 'function' ? Math.round(fn(it)) : fallback;
  }, fallback);
}

/** 注册物品类提示框 */
export function registerItemTips(): void {
  registerTip('item', uid => {
    const p = G.player;
    if (!p) return null;
    const hit = lookupItem(p, uid);
    if (!hit) return null;
    return itemTipHtml(hit.item, p, { compare: hit.where !== 'equip' });
  });
  registerTip('sell', uid => {
    const p = G.player;
    if (!p) return null;
    const hit = lookupItem(p, uid);
    if (!hit) return null;
    return itemTipHtml(hit.item, p, { compare: true, price: sellPriceOf(hit.item), priceLabel: '出售约', note: '点击选中后出售' });
  });
  registerTip('shop', spec => {
    const p = G.player;
    const i = spec.indexOf(':');
    if (!p || i < 0) return null;
    const key = spec.slice(0, i), uid = spec.slice(i + 1);
    const it = (G.shops[key] ?? []).find(x => x.uid === uid);
    if (!it) return null;
    return itemTipHtml(it, p, { compare: true, price: it.cost ?? it.value, priceLabel: '售价' });
  });
}

/** 数值安全显示（未定义字段显示 0） */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
