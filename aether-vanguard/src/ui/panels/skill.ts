// 技能面板：Q/E/R 技能卡、职业技能树 A/B、当前路线树、奥义单选（同时只能装备一个）。

import { esc } from '../../core/util';
import { clsOf } from '../../data/classes';
import { ELEM } from '../../data/elements';
import { SKILLS, ULTS } from '../../data/skills';
import { ROUTES, TREES } from '../../data/trees';
import type { TreeNode } from '../../data/types';
import { buyRouteNode, buyTreeNode, setUlt, skillsOf } from '../../game/player';
import { skillCooldown } from '../../game/skills';
import type { Player } from '../../game/types';
import { ico, routeIcon, skillIcon } from '../icons';
import { cssColor, quiet, safe } from '../shared';
import { kc } from '../text';
import { sec } from './common';
import type { PanelDef } from './types';

function nodeHtml(node: TreeNode, i: number, cur: number, total: number, canBuy: boolean, act: string, v: string): string {
  const state = i < cur ? 'done' : i === cur ? 'can' : 'lock';
  const st = i < cur ? '<span class="up">已点亮</span>'
    : i === cur ? (canBuy ? '<span class="gold">点击消耗 1 技能点</span>' : '<span class="dim">技能点不足</span>')
      : '<span class="dim">需先点亮前一节点</span>';
  const clickable = i === cur && canBuy;
  const ult = node.ult ? ULTS[node.ult] : null;
  return (i ? '<div class="tline"></div>' : '')
    + `<div class="node ${state}${node.ult ? ' ult' : ''}"${clickable ? ` data-act="${esc(act)}" data-v="${esc(v)}"` : ''}>`
    + `<div class="nt">${node.ult ? ico('star', 1, '#f2cd8c') : ico('dot', 1, i < cur ? '#a3c979' : '#7a5940')}${esc(node.n)}`
    + `<span class="nl">${i + 1}/${total}</span></div>`
    + `<div class="nd">${esc(node.d)}${ult ? ` <span class="gold">→ 奥义「${esc(ult.n)}」</span>` : ''}</div>`
    + `<div class="ns">${st}</div></div>`;
}

function cdLabel(p: Player, base: number): string {
  const real = safe(() => skillCooldown(p, base), base);
  return Math.abs(real - base) > 0.05 ? `${base}s → ${real.toFixed(1)}s` : `${base}s`;
}

export const skillPanel: PanelDef = {
  title: () => '技能 · 技能树 · 奥义',
  tabs: true,
  wide: true,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    const c = clsOf(p.cid);
    const sks = safe(() => skillsOf(p), SKILLS[p.cid] ?? SKILLS.warrior);
    const rt = ROUTES[p.route];
    const tree = TREES[p.cid] ?? TREES.warrior;
    const tcount = p.tree[p.cid] ?? { A: 0, B: 0 };
    const rcount = p.routeTree[p.route] ?? 0;
    const canBuy = p.tp > 0;
    const skHtml = sks.map(s => {
      const el = ELEM[s.el];
      return `<div class="skcard">${skillIcon(s.kind, s.el, 2)}<div class="grow">`
        + `<div>${kc(s.key)} <b style="color:${cssColor(el?.c)}">${esc(s.n)}</b> <span class="tag" style="color:${cssColor(el?.c)}">${esc(el?.n ?? '')}</span></div>`
        + `<div class="dim">${esc(s.d)}</div>`
        + `<div class="dim">伤害 ×${s.mult} · 冷却 ${esc(cdLabel(p, s.cd))} · 源能 ${s.cost}</div></div></div>`;
    }).join('');
    const branch = (br: 'A' | 'B'): string => {
      const b = tree[br];
      const cur = tcount[br] ?? 0;
      return `<div class="branch"><h5>${esc(b.n)} <span class="dim">${cur}/${b.nodes.length}</span></h5>`
        + b.nodes.map((n, i) => nodeHtml(n, i, cur, b.nodes.length, canBuy, 'tree', br)).join('') + '</div>';
    };
    const ults = p.ultList.filter(k => ULTS[k]);
    const ultHtml = ults.length
      ? ults.map(k => {
        const u = ULTS[k];
        const on = p.ult === k;
        return `<button class="ultbtn${on ? ' on' : ''}" data-act="ult" data-v="${esc(k)}">${skillIcon(u.kind, u.el, 2, true)}`
          + `<span><b>${esc(u.n)}</b><br><span class="dim">冷却 ${esc(cdLabel(p, u.cd))} · 源能 ${u.cost}</span></span>`
          + `${on ? '<span class="tag up">装备中</span>' : ''}</button>`;
      }).join('')
      : '<div class="dim">尚未解锁奥义：点亮任一分支或路线的终极节点即可获得。</div>';
    return `<div class="soft">当前职业 <b style="color:${cssColor(c.color)}">${esc(c.name)}</b> · 可用技能点 <b class="gold">${p.tp}</b>（每升一级 +2）`
      + ` · 路线 <b style="color:${cssColor(rt?.color)}">${esc(rt?.name ?? '')}</b>（在主城议会更换，两条路线的节点分别计数）</div>
      <div class="grid2 skill">
        <div>
          ${sec('主动技能')}
          ${skHtml}
          ${sec('奥义', '鼠标右键释放 · 同时只能装备一个')}
          <div class="soft ults">${ultHtml}</div>
        </div>
        <div>
          ${sec(`${c.name} · 双分支技能树`)}
          <div class="tree2">${branch('A')}${branch('B')}</div>
        </div>
      </div>
      ${sec(`源能路线 · ${rt?.name ?? ''}`)}
      <div class="grid2">
        <div class="branch">
          <h5>${routeIcon(p.route, 1)}${esc(rt?.name ?? '')}路线 <span class="dim">${rcount}/${rt?.nodes.length ?? 0}</span></h5>
          ${(rt?.nodes ?? []).map((n, i) => nodeHtml(n, i, rcount, rt.nodes.length, canBuy, 'routenode', p.route)).join('')}
        </div>
        <div class="soft">
          <b>路线固有特性</b><br>
          源能回复 +${rt?.mpRegen ?? 0}/s · 技能伤害 ×${rt?.skillDmg ?? 1} · 冷却 ×${rt?.cdMul ?? 1} · 穿透 +${rt?.pierce ?? 0} · 移速 ×${rt?.spdMul ?? 1}<br><br>
          <span class="dim">${esc(rt?.desc ?? '')}</span>
        </div>
      </div>`;
  },
  action(act, v, { p }) {
    if (!p) return;
    // 这些动作函数自己会 toast + 音效，UI 不重复提示
    if (act === 'tree') quiet(() => buyTreeNode(p, v === 'B' ? 'B' : 'A'));
    else if (act === 'routenode') quiet(() => buyRouteNode(p));
    else if (act === 'ult' && p.ult !== v && ULTS[v]) quiet(() => setUlt(p, v));
  },
};
