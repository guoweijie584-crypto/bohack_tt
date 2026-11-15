// 背包面板：网格背包（BAG_SLOTS 格，品质色边框，悬停提示含与当前装备的差值）、装备栏、整理、丢弃确认、喝药。
// 出售只能在商店面板进行（改版意见：按 NPC 拆分商店）。装备/卸下/喝药等动作函数自己会提示，这里不重复 toast。

import { BAG_SLOTS } from '../../config';
import { esc, fmt } from '../../core/util';
import { SLOTS } from '../../data/items';
import type { SlotId } from '../../data/types';
import { canEquip, equipItem, MAT_NAMES, sortBag, unequip, usePotion } from '../../game/items';
import { saveGame } from '../../game/save';
import type { MaterialId, Player } from '../../game/types';
import { ico } from '../icons';
import { C_BAD, C_INFO, quiet, safe, sfx, ui } from '../shared';
import { itemTipHtml } from '../text';
import { btn, cellGrid, emptyCell, itemCell, lookupItem, sec } from './common';
import type { PanelDef } from './types';

let sel: string | null = null;

/** 从背包移除（丢弃）。items 模块没有丢弃接口，这里直接改背包数组并存档 */
export function discardItem(p: Player, uid: string): boolean {
  const i = p.bag.findIndex(it => it.uid === uid);
  if (i < 0) return false;
  p.bag.splice(i, 1);
  safe(() => saveGame(), undefined);
  return true;
}

export function matIcon(m: MaterialId, scale = 1): string {
  return ico(m === 'part' ? 'gear' : m, scale, m === 'gem' ? '#b98ae8' : m === 'part' ? '#9a958e' : '#7fd6c4');
}

export function matsHtml(p: Player): string {
  return (['gem', 'part', 'essence'] as MaterialId[]).map(m =>
    `<span class="mat">${matIcon(m)}${esc(MAT_NAMES[m])} <b>${p.mats[m] ?? 0}</b></span>`).join('');
}

function detailHtml(p: Player): string {
  if (!sel) return '<div class="soft dim">点击物品查看详情；悬停可对比当前装备。装备可在铁匠铺强化，出售请到药剂铺或铁匠铺。</div>';
  const hit = lookupItem(p, sel);
  if (!hit || hit.where === 'stash') { sel = null; return detailHtml(p); }
  const it = hit.item;
  let btns: string;
  let warn = '';
  if (hit.where === 'equip') {
    btns = btn('卸下', 'unequip', it.slot);
  } else {
    const ok = safe(() => canEquip(p, it), true);
    if (!ok) warn = '<div class="down">当前职业无法装备这类武器</div>';
    btns = btn(`装备到${SLOTS[it.slot]}`, 'equip', it.uid, { primary: true, disabled: !ok }) + btn('丢弃', 'discard', it.uid, { danger: true });
  }
  return `<div class="soft detail">${itemTipHtml(it, p, { compare: hit.where !== 'equip' })}${warn}<div class="btns">${btns}</div></div>`;
}

export const bagPanel: PanelDef = {
  title: () => '背包',
  tabs: true,
  wide: true,
  needsPlayer: true,
  onOpen() { sel = null; },
  body({ p }) {
    if (!p) return '';
    const full = p.bag.length >= BAG_SLOTS;
    const eq = (['weapon', 'armor', 'trinket'] as SlotId[]).map(k => {
      const it = p.equip[k];
      return `<div class="eq-slot"><span class="dim">${esc(SLOTS[k])}</span>${it ? itemCell(it, { act: 'sel', selected: sel === it.uid }) : emptyCell()}</div>`;
    }).join('');
    const grid = cellGrid(p.bag, BAG_SLOTS, it => itemCell(it, { act: 'sel', selected: sel === it.uid }), 6);
    return `<div class="grid2 bag">
      <div>
        ${sec('装备中')}
        <div class="soft eq-slots">${eq}</div>
        ${sec('药水')}
        <div class="soft">
          <div class="row">${ico('potion', 2, '#df5f57')}<span class="grow">生命药水 <b>×${p.potions.hp}</b> <span class="dim">（1）回复 40% 生命</span></span>${btn('喝', 'drink', 'hp', { small: true, disabled: p.potions.hp <= 0 })}</div>
          <div class="row">${ico('potion', 2, '#5fa9d8')}<span class="grow">源能药水 <b>×${p.potions.mp}</b> <span class="dim">（2）回复 50% 源能</span></span>${btn('喝', 'drink', 'mp', { small: true, disabled: p.potions.mp <= 0 })}</div>
        </div>
        ${sec('材料与金币')}
        <div class="soft mats">${matsHtml(p)}<span class="mat">${ico('coin', 1)}金币 <b class="gold">${esc(fmt(p.gold))}</b></span></div>
      </div>
      <div>
        ${sec(`背包 ${p.bag.length}/${BAG_SLOTS}`, (full ? '<span class="down">已满：新装备会留在地上</span> ' : '') + btn('整理', 'sort', '', { small: true, disabled: p.bag.length < 2 }))}
        ${grid}
        ${detailHtml(p)}
      </div>
    </div>`;
  },
  action(act, v, { p }) {
    if (!p) return;
    switch (act) {
      case 'sel': sel = sel === v ? null : v; return;
      case 'equip': if (quiet(() => equipItem(p, v))) sel = null; return;
      case 'unequip': quiet(() => unequip(p, v as SlotId)); return;
      case 'drink': quiet(() => usePotion(p, v === 'mp' ? 'mp' : 'hp')); return;
      case 'sort': if (quiet(() => sortBag(p))) sfx('ui'); return;
      case 'discard': {
        const hit = lookupItem(p, v);
        if (!hit || hit.where !== 'bag') return;
        ui.confirm({
          title: '丢弃物品',
          html: `确定丢弃 <b>${esc(hit.item.name)}</b>？丢弃后无法找回。<br><span class="dim">想换金币请到药剂铺或铁匠铺出售。</span>`,
          okText: '丢弃',
          danger: true,
          onOk: () => {
            if (discardItem(p, v)) { sel = null; ui.toast(`已丢弃 ${hit.item.name}`, C_INFO); }
            else ui.toast('丢弃失败', C_BAD);
            ui.rerender();
            ui.refreshHud();
          },
        });
        return;
      }
    }
  },
};
