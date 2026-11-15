// 世界观面板：序章、主城住民台词、已收集的记忆残页（无角色时也可打开）。

import { esc } from '../../core/util';
import { LORE } from '../../data/lore';
import { ico } from '../icons';
import { sec } from './common';
import type { PanelDef } from './types';

export const lorePanel: PanelDef = {
  title: () => '世界观 · 记忆残页',
  tabs: true,
  wide: true,
  body({ p }) {
    const got = new Set(p?.fragments ?? []);
    const frags = LORE.fragments.map((f, i) => got.has(i)
      ? `<div class="item frag">${ico('scroll', 1)}${esc(f)}</div>`
      : `<div class="item frag locked">${ico('lock', 1)}【残页 ${i + 1}】……尚未寻获（深入迷宫副本寻找）</div>`).join('');
    const npcs = LORE.npcs.map(n => `<div class="item npc-line"><b class="gold">${esc(n.n)}</b><div>「${esc(n.t)}」</div></div>`).join('');
    return `<div class="grid2">
      <div>
        ${sec('纪元 137 · 源能纪事')}
        <div class="soft lore-intro">${esc(LORE.intro)}</div>
        ${sec('曙光主城的住民')}
        ${npcs}
      </div>
      <div>
        ${sec(`记忆残页 ${got.size}/${LORE.fragments.length}`)}
        ${frags}
        <div class="soft dim">没有强制主线：世界观随探索逐步展开。残页在迷宫副本中拾得，可随时按 J 翻阅。</div>
      </div>
    </div>`;
  },
};
