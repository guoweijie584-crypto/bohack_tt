// 仓库（新手村存储箱）：背包 ↔ 仓库双栏网格，点击即转移。

import { BAG_SLOTS, STASH_SLOTS } from '../../config';
import { fromStash, toStash } from '../../game/items';
import { cellGrid, itemCell, sec } from './common';
import type { PanelDef } from './types';
import { quiet } from '../shared';
import { matsHtml } from './bag';

export const stashPanel: PanelDef = {
  title: () => '仓库 · 存储箱',
  wide: true,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    const bagFull = p.bag.length >= BAG_SLOTS, stashFull = p.stash.length >= STASH_SLOTS;
    return `<div class="soft dim">点击背包里的物品存入仓库，点击仓库里的物品取回背包。仓库在所有副本之间共享当前角色的物品。</div>
      <div class="grid2 stash">
        <div>
          ${sec(`背包 ${p.bag.length}/${BAG_SLOTS}`, bagFull ? '<span class="down">已满</span>' : '')}
          ${cellGrid(p.bag, BAG_SLOTS, it => itemCell(it, { act: 'put' }), 6)}
          ${sec('材料')}
          <div class="soft mats">${matsHtml(p)}</div>
        </div>
        <div>
          ${sec(`仓库 ${p.stash.length}/${STASH_SLOTS}`, stashFull ? '<span class="down">已满</span>' : '')}
          ${cellGrid(p.stash, STASH_SLOTS, it => itemCell(it, { act: 'take' }), 8)}
        </div>
      </div>`;
  },
  action(act, v, { p }) {
    if (!p) return;
    if (act === 'put') quiet(() => toStash(p, v));
    else if (act === 'take') quiet(() => fromStash(p, v));
  },
};
