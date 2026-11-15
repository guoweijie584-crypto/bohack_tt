// 角色面板：档案、四维加点、战斗数值、装备三槽（卸下）、隐藏被动、战绩。

import { LORE } from '../../data/lore';
import { MAX_LEVEL } from '../../config';
import { clamp, esc, fmt } from '../../core/util';
import { clsOf, FUSIONS } from '../../data/classes';
import { ELEM } from '../../data/elements';
import { SLOTS } from '../../data/items';
import { PASSIVES } from '../../data/passives';
import { ROUTES } from '../../data/trees';
import type { SlotId } from '../../data/types';
import { unequip } from '../../game/items';
import { addStat, passiveOf } from '../../game/player';
import type { Player } from '../../game/types';
import { ico, type IconName } from '../icons';
import { cssColor, quiet, safe } from '../shared';
import { affixLine, fmtTime, pct, rarityColor } from '../text';
import { btn, emptyCell, itemCell, kv, num, portrait, sec } from './common';
import type { PanelDef } from './types';

type StatKey = 'str' | 'agi' | 'int' | 'vit';
const ATTRS: ReadonlyArray<{ k: StatKey; n: string; d: string; icon: IconName; color?: string }> = [
  { k: 'str', n: '力量', d: '攻击', icon: 'sword' }, // recalc：力量只加攻击（生命来自体质）
  { k: 'agi', n: '敏捷', d: '暴击 / 移速', icon: 'boot' },
  { k: 'int', n: '智力', d: '源能 / 冷却 / 攻击', icon: 'book' },
  { k: 'vit', n: '体质', d: '生命 / 护甲', icon: 'heart' },
];

/** 隐藏被动（progression 未实现时直接查数据表） */
export function passiveText(cid: string): { name: string; desc: string } {
  return safe(() => passiveOf(cid), PASSIVES[cid] ? { name: PASSIVES[cid].name, desc: PASSIVES[cid].desc } : { name: '—', desc: '' });
}

function statsHtml(p: Player): string {
  const s = p.stat;
  const rows: Array<[string, string, IconName]> = [
    ['攻击', String(Math.round(num(s.atk))), 'sword'],
    ['护甲', String(Math.round(num(s.armor))), 'shield'],
    ['生命', String(Math.round(num(s.maxHp))), 'heart'],
    ['源能', String(Math.round(num(s.maxMp))), 'drop'],
    ['移速', num(s.spd) < 10 ? num(s.spd).toFixed(2) : String(Math.round(num(s.spd))), 'boot'],
    ['暴击', pct(num(s.crit)), 'star'],
    ['冷却缩减', pct(num(s.cdr)), 'hourglass'],
    ['攻击距离', String(Math.round(num(s.range))), 'target'],
    ['攻击间隔', `${num(s.atkCd).toFixed(2)}s`, 'sword'],
    ['源能回复', `${num(s.mpRegen).toFixed(1)}/s`, 'drop'],
    ['生命回复', `${num(s.hpRegen).toFixed(1)}/s`, 'plus'],
    ['技能伤害', `×${num(s.skillDmg).toFixed(2)}`, 'star'],
    ['护甲穿透', pct(num(s.pen)), 'arrowRight'],
    ['吸血', pct(num(s.lifesteal)), 'heart'],
  ];
  const el = ELEM[s.element];
  return rows.map(([n, v, i]) => kv(n, esc(v), ico(i, 1))).join('')
    + kv('伤害元素', el ? `<span style="color:${cssColor(el.c)}">${esc(el.n)}</span>` : '—');
}

function equipHtml(p: Player): string {
  return (['weapon', 'armor', 'trinket'] as SlotId[]).map(k => {
    const it = p.equip[k];
    if (!it) {
      return `<div class="eq-row">${emptyCell(SLOTS[k])}<div class="eq-info"><b class="dim">${esc(SLOTS[k])} · 未装备</b></div></div>`;
    }
    return `<div class="eq-row">${itemCell(it)}<div class="eq-info">`
      + `<b style="color:${rarityColor(it.rarity)}">${esc(it.name)}${it.plus > 0 ? ` +${it.plus}` : ''}</b>`
      + `<div class="dim">${it.affixes.map(a => esc(affixLine(a, it.plus))).join(' · ')}</div></div>`
      + btn('卸下', 'unequip', k, { small: true })
      + '</div>';
  }).join('');
}

export const charPanel: PanelDef = {
  title: () => '角色档案',
  tabs: true,
  wide: true,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    const c = clsOf(p.cid);
    const rt = ROUTES[p.route];
    const ps = passiveText(p.cid);
    const fusion = FUSIONS.find(f => f.id === p.cid);
    const maxed = p.lv >= MAX_LEVEL;
    const ef = maxed ? 1 : clamp(p.exp / Math.max(1, p.expNext), 0, 1);
    const fuseLine = fusion
      ? `融合职业 · ${esc(clsOf(fusion.from[0]).name)} + ${esc(clsOf(fusion.from[1]).name)}`
      : p.fusedFrom ? '已完成融合转职' : '尚未融合转职（任一职业 Lv.10 可在转职殿融合，只能一次）';
    const attrs = ATTRS.map(a =>
      `<div class="row">${ico(a.icon, 1)}<b>${a.n}</b><span class="dim grow">${a.d}</span>`
      + `<b class="gold w3">${p.stats[a.k]}</b>${btn('+1', 'stat', a.k, { small: true, disabled: p.sp <= 0 })}</div>`).join('');
    const record = [
      kv('击杀 / 死亡', `${p.kills} / ${p.deaths}`),
      kv('首领击杀', String(p.bossKills)),
      kv('最深层数', `第 ${p.bestFloor} 层`),
      kv('竞技场', `${p.arenaWins} 胜 · 最高连胜 ${p.bestStreak}`),
      kv('记忆残页', `${p.fragments.length} / ${LORE.fragments.length}`),
      kv('游戏时长', esc(fmtTime(p.playTime))),
      kv('金币', `<span class="gold">${esc(fmt(p.gold))}</span>`, ico('coin', 1)),
    ].join('');
    return `<div class="grid2">
      <div>
        <div class="soft profile">
          <div class="pf-img">${portrait(p.cid, 3)}</div>
          <div class="pf-info">
            <div class="t24" style="color:${cssColor(c.color)}">${esc(p.name || c.name)}</div>
            <div>${esc(c.name)} <span class="dim">${esc(c.en)}${c.tag ? ' · ' + esc(c.tag) : ''}${c.core ? ' · 核心 ' + esc(c.core) : ''}</span></div>
            <div>Lv.${p.lv}/${MAX_LEVEL} · <span class="dim">${maxed ? '已满级' : `经验 ${Math.floor(p.exp)} / ${p.expNext}`}</span></div>
            <div class="bar exp"><i style="width:${(ef * 100).toFixed(1)}%"></i></div>
            <div class="dim">${fuseLine}</div>
            <div class="dim">技能路线 <span style="color:${cssColor(rt?.color)}">${esc(rt?.name ?? p.route)}</span></div>
          </div>
        </div>
        ${sec('属性加点', `剩余 <b class="gold">${p.sp}</b> 点 · 每级 +3`)}
        <div class="soft">${attrs}</div>
        ${sec('隐藏被动')}
        <div class="soft passive">${ico('star', 1, '#f2cd8c')}<b class="gold">${esc(ps.name)}</b><div>${esc(ps.desc)}</div></div>
      </div>
      <div>
        ${sec('战斗数值')}
        <div class="soft cols2">${statsHtml(p)}</div>
        ${sec('装备')}
        <div class="soft">${equipHtml(p)}</div>
        ${sec('战绩')}
        <div class="soft">${record}</div>
      </div>
    </div>`;
  },
  action(act, v, { p }) {
    if (!p) return;
    if (act === 'stat') quiet(() => addStat(p, v as StatKey));
    else if (act === 'unequip') quiet(() => unequip(p, v as SlotId));
  },
};
