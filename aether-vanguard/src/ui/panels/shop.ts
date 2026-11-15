// 商店：药剂铺（药水、饰品货架、出售）与铁匠铺（武器/护甲货架 + 20 金币刷新、强化、出售）。
// items 模块的买/卖/强化/刷新函数自己会 toast + 音效（含“金币不足”“背包已满”等拒绝原因），UI 只负责展示与选中状态。

import { BAG_SLOTS } from '../../config';
import { esc, fmt } from '../../core/util';
import { SLOTS } from '../../data/items';
import {
  buyItem, buyPotion, MAT_NAMES, MAX_PLUS, potionPrice, rerollShop, rollShop, sellItem, upgradeCost, upgradeItem,
} from '../../game/items';
import { G } from '../../game/state';
import type { Item, MaterialId, Player } from '../../game/types';
import { ico } from '../icons';
import { C_GOLD, muteToasts, quiet, safe, ui } from '../shared';
import { itemTipHtml, rarityColor } from '../text';
import { matIcon } from './bag';
import { btn, cellGrid, itemCell, lookupItem, sec, sellPriceOf } from './common';
import type { PanelDef } from './types';

type Tab = 'buy' | 'forge' | 'sell';
const st = { tab: 'buy' as Tab, sel: null as string | null };
const REFRESH_COST = 20;

function goldLine(p: Player): string {
  return `<span class="mat">${ico('coin', 1)}金币 <b class="gold">${esc(fmt(p.gold))}</b></span>`
    + `<span class="mat">${ico('bag', 1)}背包 <b>${p.bag.length}/${BAG_SLOTS}</b></span>`;
}

function subtabs(tabs: ReadonlyArray<[Tab, string]>): string {
  return `<div class="subtabs">${tabs.map(([k, n]) => `<button class="stab${st.tab === k ? ' on' : ''}" data-act="tab" data-v="${k}">${esc(n)}</button>`).join('')}</div>`;
}

/** 货架为空时生成（rollShop 会同时写入 G.shops[key]） */
function ensureShelf(key: string, p: Player): Item[] {
  const cur = G.shops[key];
  // 只在从未生成过时补货；卖空后要花钱刷新（否则买空即可免费重刷，绕过 20 金币刷新费）
  if (cur) return cur;
  const fresh = safe(() => rollShop(key, p.lv), [] as Item[]);
  G.shops[key] = fresh;
  return fresh;
}

function priceOf(it: Item): number { return Math.round(it.cost ?? it.value); }

/** 货架：网格 + 选中详情 */
function shelfHtml(key: string, p: Player): string {
  const shelf = ensureShelf(key, p);
  if (!shelf.length) return '<div class="soft dim">货架已经卖空了。</div>';
  const cells = `<div class="cells" style="--cols:6">${shelf.map(it => itemCell(it, {
    act: 'sel', selected: st.sel === it.uid, tip: `shop:${key}:${it.uid}`, label: `${priceOf(it)}`, dim: p.gold < priceOf(it),
  })).join('')}</div>`;
  const it = st.sel ? shelf.find(x => x.uid === st.sel) : undefined;
  const detail = it
    ? `<div class="soft detail">${itemTipHtml(it, p, { compare: true, price: priceOf(it), priceLabel: '售价' })}`
      + `<div class="btns">${btn(`购买 ${priceOf(it)} 金币`, 'buy', it.uid, { primary: true, disabled: p.gold < priceOf(it) })}</div></div>`
    : '<div class="soft dim">点击货架上的物品查看详情并购买。</div>';
  return cells + detail;
}

/** 出售：背包网格 + 选中详情 */
function sellHtml(p: Player): string {
  const grid = cellGrid(p.bag, BAG_SLOTS, it => itemCell(it, { act: 'sel', selected: st.sel === it.uid, tip: `sell:${it.uid}` }), 6);
  const hit = st.sel ? lookupItem(p, st.sel) : null;
  const it = hit && hit.where === 'bag' ? hit.item : null;
  const junk = p.bag.filter(x => x.rarity === 0).length;
  const detail = it
    ? `<div class="soft detail">${itemTipHtml(it, p, { compare: true, price: sellPriceOf(it), priceLabel: '出售' })}`
      + `<div class="btns">${btn(`出售 +${sellPriceOf(it)} 金币`, 'sell', it.uid, { primary: true })}</div></div>`
    : '<div class="soft dim">点击背包物品选中后出售。已装备的物品需要先卸下。</div>';
  return grid + detail + `<div class="btns">${btn(`出售全部粗制（${junk}）`, 'sell-junk', '', { disabled: junk === 0 })}</div>`;
}

/** 强化：已装备 + 背包物品，选中后显示花费 */
function forgeHtml(p: Player): string {
  const equipped = (['weapon', 'armor', 'trinket'] as const).map(k => p.equip[k]).filter((x): x is Item => !!x);
  const eqCells = equipped.map(it => itemCell(it, { act: 'sel', selected: st.sel === it.uid })).join('');
  const bagCells = p.bag.map(it => itemCell(it, { act: 'sel', selected: st.sel === it.uid })).join('');
  const it = st.sel ? [...equipped, ...p.bag].find(x => x.uid === st.sel) : undefined;
  let detail = '<div class="soft dim">选择一件装备进行强化：消耗金币与怪物掉落的材料（机械零件、源能宝石、元素精华），强化后词条数值提升。</div>';
  if (it && it.plus >= MAX_PLUS) {
    // 已满级：不显示“+10 → +11”与可点的强化按钮（upgradeItem 会拒绝）
    detail = `<div class="soft detail">${itemTipHtml(it, p, { compare: false })}`
      + `<div class="forge-to">已达强化上限 <b class="gold">+${MAX_PLUS}</b></div>`
      + `<div class="btns">${btn('强化', 'forge', it.uid, { primary: true, disabled: true })}</div></div>`;
  } else if (it) {
    const cost = safe(() => upgradeCost(it), null);
    let costHtml = '<div class="dim">无法计算强化花费</div>';
    let ok = false;
    if (cost) {
      ok = p.gold >= cost.gold;
      const rows = [`<div class="row">${ico('coin', 1)}<span class="grow">金币</span><b class="${p.gold >= cost.gold ? 'up' : 'down'}">${esc(fmt(p.gold))} / ${cost.gold}</b></div>`];
      for (const m of ['part', 'gem', 'essence'] as MaterialId[]) {
        const n = cost.mats[m] ?? 0;
        if (!n) continue;
        const have = p.mats[m] ?? 0;
        if (have < n) ok = false;
        rows.push(`<div class="row">${matIcon(m)}<span class="grow">${esc(MAT_NAMES[m])}</span><b class="${have >= n ? 'up' : 'down'}">${have} / ${n}</b></div>`);
      }
      costHtml = rows.join('');
    }
    detail = `<div class="soft detail">${itemTipHtml(it, p, { compare: false })}`
      + `<div class="forge-to">强化 <b style="color:${rarityColor(it.rarity)}">+${it.plus}</b> → <b class="gold">+${it.plus + 1}</b></div>${costHtml}`
      + `<div class="btns">${btn('强化', 'forge', it.uid, { primary: true, disabled: !ok })}</div></div>`;
  }
  const cells = (html: string, empty: string): string => (html ? `<div class="cells" style="--cols:6">${html}</div>` : `<div class="soft dim">${empty}</div>`);
  return sec('已装备') + cells(eqCells, '未装备任何物品') + sec('背包') + cells(bagCells, '背包为空') + detail;
}

/* ---------- 动作 ---------- */
function sellJunk(p: Player): void {
  const junk = p.bag.filter(x => x.rarity === 0);
  if (!junk.length) return;
  ui.confirm({
    title: '出售粗制装备',
    html: `出售背包里全部 <b>${junk.length}</b> 件粗制装备？`,
    okText: '出售',
    onOk: () => {
      const before = p.gold;
      // 逐件 sellItem 会各发一条 toast，这里合并成一条汇总
      const n = muteToasts(() => junk.reduce((k, it) => k + (safe(() => sellItem(p, it.uid), false) ? 1 : 0), 0));
      ui.toast(`出售 ${n} 件粗制装备 · +${Math.max(0, p.gold - before)} 金币`, C_GOLD);
      st.sel = null;
      ui.rerender();
      ui.refreshHud();
    },
  });
}

function common(act: string, v: string, p: Player, shelfKey: string): void {
  switch (act) {
    case 'tab': st.tab = v === 'forge' ? 'forge' : v === 'sell' ? 'sell' : 'buy'; st.sel = null; return;
    case 'sel': st.sel = st.sel === v ? null : v; return;
    case 'buy': if (quiet(() => buyItem(p, shelfKey, v))) st.sel = null; return;
    case 'sell': if (quiet(() => sellItem(p, v))) st.sel = null; return;
    case 'sell-junk': sellJunk(p); return;
  }
}

/* ---------- 药剂铺 ---------- */
function potionRow(p: Player, kind: 'hp' | 'mp'): string {
  const price = safe(() => potionPrice(kind), kind === 'hp' ? 40 : 35);
  const name = kind === 'hp' ? '生命药水' : '源能药水';
  const effect = kind === 'hp' ? '回复 40% 生命' : '回复 50% 源能';
  return `<div class="row">${ico('potion', 2, kind === 'hp' ? '#df5f57' : '#5fa9d8')}<span class="grow"><b>${name}</b> <span class="dim">${effect} · 持有 ${p.potions[kind]} · 单价 ${price} 金币</span></span>`
    + btn('买 1', 'potion', `${kind}:1`, { small: true, disabled: p.gold < price })
    + btn('买 5', 'potion', `${kind}:5`, { small: true, disabled: p.gold < price * 5 }) + '</div>';
}

/** 药剂商名字：主城是苏芽，迷宫补给房是流浪药剂商（两处共用这个面板与 'potion' 货架），取最近的那位 */
export function potionShopTitle(): string {
  const p = G.player;
  let name = '', bd = Infinity;
  for (const n of G.npcs) {
    if (n.role !== 'potion') continue;
    const d = p ? Math.hypot(n.x - p.x, n.y - p.y) : 0;
    if (d < bd) { bd = d; name = n.name; }
  }
  return name || '药剂铺';
}

export const potionShopPanel: PanelDef = {
  title: () => potionShopTitle(),
  wide: true,
  needsPlayer: true,
  onOpen() { st.tab = 'buy'; st.sel = null; },
  body({ p }) {
    if (!p) return '';
    const head = `<div class="soft shop-head">${goldLine(p)}</div>` + subtabs([['buy', '购买'], ['sell', '出售']]);
    if (st.tab === 'sell') return head + sellHtml(p);
    return head + sec('药水') + `<div class="soft">${potionRow(p, 'hp')}${potionRow(p, 'mp')}</div>`
      + sec('饰品货架') + shelfHtml('potion', p);
  },
  action(act, v, { p }) {
    if (!p) return;
    if (act === 'potion') {
      const [k, n] = v.split(':');
      const cnt = Math.max(1, Math.min(99, Number(n) || 1));
      quiet(() => buyPotion(p, k === 'mp' ? 'mp' : 'hp', cnt));
      return;
    }
    common(act, v, p, 'potion');
  },
};

/* ---------- 铁匠铺 ---------- */
export const smithPanel: PanelDef = {
  title: () => '铁匠铺 · 老陶',
  wide: true,
  needsPlayer: true,
  onOpen() { st.tab = 'buy'; st.sel = null; },
  body({ p }) {
    if (!p) return '';
    const mats = (['part', 'gem', 'essence'] as MaterialId[]).map(m => `<span class="mat">${matIcon(m)}${esc(MAT_NAMES[m])} <b>${p.mats[m] ?? 0}</b></span>`).join('');
    const head = `<div class="soft shop-head">${goldLine(p)}${mats}</div>` + subtabs([['buy', '武器与护甲'], ['forge', '强化'], ['sell', '出售']]);
    if (st.tab === 'sell') return head + sellHtml(p);
    if (st.tab === 'forge') return head + forgeHtml(p);
    return head + sec('今日货架', btn(`刷新货架 ${REFRESH_COST} 金币`, 'reroll', '', { small: true, disabled: p.gold < REFRESH_COST }))
      + shelfHtml('smith', p)
      + `<div class="soft dim">装备品质：粗制 → 精良 → 稀有 → 史诗 → 传说。${esc(SLOTS.weapon)}与${esc(SLOTS.armor)}会显示在人物身上；武器需与职业的武器类型一致。</div>`;
  },
  action(act, v, { p }) {
    if (!p) return;
    if (act === 'reroll') {
      if (quiet(() => rerollShop(p, 'smith'))) { st.sel = null; ui.toast(`货架已刷新 -${REFRESH_COST} 金币`, C_GOLD); }
      return;
    }
    if (act === 'forge') { quiet(() => upgradeItem(p, v)); return; }
    common(act, v, p, 'smith');
  },
};
