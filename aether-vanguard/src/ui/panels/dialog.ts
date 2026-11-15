// 对话：村民台词（arg = NPC id，从 G.npcs 查找）；arg==='event' 时为事件房祭坛的二选一（改版意见：迷宫变体房间）。
// 祭坛结算由 world.resolveAltar(choice) 完成（扣血/掉落/buff/标记祭坛已用 + toast），文本来自 LORE.altar。

import { esc } from '../../core/util';
import { LORE } from '../../data/lore';
import { G } from '../../game/state';
import type { Npc, NpcRole, PanelName } from '../../game/types';
import { resolveAltar } from '../../game/world';
import { ico } from '../icons';
import { C_INFO, quiet, ui } from '../shared';
import { btn, npcPortrait } from './common';
import type { PanelDef } from './types';

/** 功能型 NPC 的快捷入口（正常情况下 world 会直接打开对应面板；这里兜底） */
const ROLE_PANEL: Partial<Record<NpcRole, [PanelName, string]>> = {
  gate: ['portal', '打开传送阵'], route: ['route', '选择技能路线'], smith: ['shop_smith', '铁匠铺'],
  fuse: ['fuse', '融合转职'], scribe: ['lore', '翻阅日志'], arena: ['arena', '竞技场'],
  potion: ['shop_potion', '药剂铺'], stash: ['stash', '打开仓库'], secret: ['secret', '秘境'],
};

export function findNpc(arg: string | undefined): Npc | null {
  if (!arg) return null;
  return G.npcs.find(n => String(n.id) === arg) ?? null;
}

/** 祭坛二选一 HTML（纯函数） */
export function altarHtml(): string {
  const a = LORE.altar;
  const cards = a.choices.map((c, i) =>
    `<div class="card choice"><b class="${i === 0 ? 'down' : 'up'}">${ico(i === 0 ? 'heart' : 'star', 1, i === 0 ? undefined : '#c070ff')}${esc(c.n)}</b>`
    + `<div>${esc(c.d)}</div><div class="btns">${btn(c.n, 'altar', String(i), { danger: i === 0, primary: i === 1 })}</div></div>`).join('');
  return `<div class="dialog">${ico('portal', 4, '#c070ff')}<div class="dlg-text"><b class="gold">${esc(a.title)}</b>`
    + `<div>${esc(a.desc)}</div><div class="dim">两个选择只能取其一；离开不会消耗祭坛。</div></div></div>`
    + `<div class="grid2 choices">${cards}</div><div class="btns">${btn('暂不选择', 'bye', '')}</div>`;
}

export const dialogPanel: PanelDef = {
  title: ({ arg }) => (arg === 'event' ? LORE.altar.title : findNpc(arg)?.name ?? '对话'),
  needsPlayer: true,
  body({ p, arg }) {
    if (!p) return '';
    if (arg === 'event') return altarHtml();
    const n = findNpc(arg);
    if (!n) return `<div class="dialog">${ico('bubble', 3)}<div class="dlg-text">……</div></div><div class="btns">${btn('离开', 'bye', '')}</div>`;
    const go = ROLE_PANEL[n.role];
    return `<div class="dialog"><div class="dlg-img">${npcPortrait(n.sprite, 3)}</div>`
      + `<div class="dlg-text"><b class="gold">${esc(n.name)}</b><div>「${esc(n.line)}」</div></div></div>`
      + `<div class="btns">${go ? btn(go[1], 'goto', go[0], { primary: true }) : ''}${btn('再见', 'bye', '')}</div>`;
  },
  action(act, v) {
    if (act === 'bye') { ui.closePanel(); return; }
    if (act === 'goto') { ui.openPanel(v as PanelName); return; }
    if (act === 'altar') {
      const ok = quiet(() => resolveAltar(v === '0' ? 0 : 1));
      if (!ok) ui.toast('祭坛已经沉寂', C_INFO);
      ui.closePanel();
    }
  },
};
