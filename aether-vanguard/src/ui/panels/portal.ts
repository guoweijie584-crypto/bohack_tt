// 传送阵 / 议会 / 竞技场 / 秘境：进副本、竞技场必须经传送阵或对应 NPC（改版意见），面板只做选择与确认。

import { esc } from '../../core/util';
import { secretLevel } from '../../data/dungeons';
import { ENEMIES } from '../../data/enemies';
import { LORE } from '../../data/lore';
import { ROUTES } from '../../data/trees';
import type { RouteId } from '../../data/types';
import { setRoute } from '../../game/player';
import { G } from '../../game/state';
import type { Player } from '../../game/types';
import * as worldMod from '../../game/world';
import { enterArena, enterCity, enterDungeon, peekTrial } from '../../game/world';
import { DUNGEONS } from '../../world/mapgen';
import { ico, type IconName, routeIcon } from '../icons';
import { C_BAD, cssColor, errMsg, quiet, safe, sfx, ui } from '../shared';
import { THEME_NAME } from '../text';
import { btn, kv, sec } from './common';
import type { PanelDef } from './types';

type Dungeon = (typeof DUNGEONS)[string];
const THEME_ICON: Record<string, IconName> = { ruins: 'stairs', magma: 'flame', frost: 'snow', crypt: 'skull' };

/** 进入秘境：world 若提供 enterSecret 就用它，否则按副本 id 'secret' 进入 */
export function startSecret(): void {
  let fn: (() => void) | undefined;
  try {
    const ext = worldMod as unknown as { enterSecret?: () => void };
    fn = typeof ext.enterSecret === 'function' ? ext.enterSecret : undefined;
  } catch {
    fn = undefined;
  }
  if (fn) fn();
  else enterDungeon('secret', 1);
}

/** 关闭面板后执行传送（出错时提示） */
function travel(fn: () => void): void {
  ui.closePanel();
  try {
    fn();
    sfx('portal');
  } catch (e) {
    ui.toast('传送失败：' + errMsg(e), C_BAD);
  }
}

function dungeonList(): Dungeon[] {
  return Object.values(DUNGEONS).filter(d => d.id !== 'secret').sort((a, b) => a.lv - b.lv);
}

let sel = '';

function destCard(id: string, icon: string, name: string, tags: string, desc: string, on: boolean): string {
  return `<div class="card dest${on ? ' on' : ''}" data-act="pick" data-v="${esc(id)}">`
    + `<div class="dest-h">${icon}<b>${esc(name)}</b>${tags}</div><div class="dim">${desc}</div></div>`;
}

function lvTag(p: Player, lv: number): string {
  const cls = p.lv + 2 < lv ? 'down' : p.lv >= lv ? 'up' : 'gold';
  return `<span class="tag ${cls}">推荐 Lv.${lv}</span>`;
}

export const portalPanel: PanelDef = {
  title: () => '传送阵',
  wide: true,
  needsPlayer: true,
  onOpen({ arg }) {
    const ids = [...dungeonList().map(d => d.id), 'arena', 'secret', 'city'];
    sel = arg && ids.includes(arg) ? arg : (dungeonList()[0]?.id ?? 'arena');
  },
  body({ p }) {
    if (!p) return '';
    const ds = dungeonList();
    const cards = ds.map(d => {
      const boss = ENEMIES[d.boss]?.n ?? d.boss;
      return destCard(d.id, ico(THEME_ICON[d.theme] ?? 'portal', 2), d.name,
        `${lvTag(p, d.lv)}<span class="tag">${esc(THEME_NAME[d.theme] ?? d.theme)}</span>`,
        `${esc(d.desc)}<br>共 ${d.floors} 层 · 第 ${d.floors} 层首领：<span class="down">${esc(boss)}</span>`, sel === d.id);
    });
    cards.push(destCard('arena', ico('swords', 2), '镜像竞技场', '<span class="tag">PVP 演武</span>',
      `与随机职业的镜像斗士对决，连胜越高奖励越多。当前连胜 ${p.streak}`, sel === 'arena'));
    const sd = DUNGEONS.secret;
    const tr = safe(() => peekTrial(), null);
    cards.push(destCard('secret', ico('portal', 2, '#f0d070'), sd?.name ?? '秘境', `${lvTag(p, safe(() => secretLevel(p.bestFloor), sd?.lv ?? 8))}<span class="tag">短副本</span>`,
      `${esc(sd?.desc ?? '独立小地图的限定条件战斗，完成后获得特殊遗物与金币。')}${tr ? `<br>本次试炼：<span class="gold">${esc(tr.name)}</span>` : ''}`, sel === 'secret'));
    if (G.scene !== 'city') cards.push(destCard('city', ico('portal', 2, '#7fd6c4'), '曙光主城', '', '返回主城（补给、强化、仓库）。', sel === 'city'));
    const target = sel === 'arena' ? '竞技场' : sel === 'city' ? '主城' : (DUNGEONS[sel]?.name ?? '');
    return `<div class="soft">选择目的地。迷宫副本每个 3 层：走到出口即进入下一层（不必清完怪），第 3 层为首领层，击败首领后开启回城传送阵。</div>
      ${ds.length ? '' : '<div class="soft dim">（副本数据尚未加载）</div>'}
      <div class="dest-list">${cards.join('')}</div>
      <div class="btns">${btn(target ? `进入 ${target}` : '请选择目的地', 'go', sel, { primary: true, disabled: !target })}</div>`;
  },
  action(act, v) {
    if (act === 'pick') { sel = v; return; }
    if (act !== 'go' || !sel) return;
    const id = sel;
    if (id === 'arena') travel(() => enterArena());
    else if (id === 'secret') travel(() => startSecret());
    else if (id === 'city') travel(() => enterCity('portal'));
    else if (DUNGEONS[id]) travel(() => enterDungeon(id, 1));
  },
};

/* ---------- 议会：路线说明与切换 ---------- */
export const routePanel: PanelDef = {
  title: () => '源能议会 · 技能路线',
  wide: true,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    const cards = (Object.keys(ROUTES) as RouteId[]).map(id => {
      const r = ROUTES[id];
      const on = p.route === id;
      const done = p.routeTree[id] ?? 0;
      const nodes = r.nodes.map((n, i) => `<div class="${i < done ? 'up' : 'dim'}">${ico(i < done ? 'check' : 'dot', 1, i < done ? undefined : '#7a5940')}${esc(n.n)} · ${esc(n.d)}</div>`).join('');
      return `<div class="card route${on ? ' on' : ''}">
        <div class="dest-h">${routeIcon(id, 2)}<b class="t24" style="color:${cssColor(r.color)}">${esc(r.name)}</b> <span class="dim">${esc(r.en)}</span></div>
        <div>${esc(r.desc)}</div>
        <div class="soft">${kv('源能回复', `+${r.mpRegen}/s`)}${kv('技能伤害', `×${r.skillDmg}`)}${kv('冷却', `×${r.cdMul}`)}${kv('穿透', `+${r.pierce}`)}${kv('移速', `×${r.spdMul}`)}</div>
        ${sec(`路线节点 ${done}/${r.nodes.length}`)}<div class="lines">${nodes}</div>
        <div class="btns">${btn(on ? '当前路线' : `改走${r.name}路线`, 'route', id, { primary: !on, disabled: on })}</div>
      </div>`;
    }).join('');
    return `<div class="soft">「奥术与机械从来不是两种装饰，而是两条截然不同的技能路线。」<br>`
      + '<span class="dim">两条路线的节点分别计数，切换不会清空已点进度；路线奥义需要在技能面板重新选择。</span></div>'
      + `<div class="grid2">${cards}</div>`;
  },
  action(act, v, { p }) {
    if (!p || act !== 'route') return;
    const r = ROUTES[v as RouteId];
    if (!r || p.route === v) return;
    quiet(() => setRoute(p, v as RouteId));
  },
};

/* ---------- 竞技场 ---------- */
export const arenaPanel: PanelDef = {
  title: () => '镜像竞技场',
  wide: true,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    return `<div class="grid2">
      <div>
        ${sec('镜像竞技场')}
        <div class="soft">系统会生成一名随机职业、随机路线的<b>镜像斗士</b>，它会使用与玩家同一套 Q/E/R 技能。击败对手获得金币与经验，连胜越高奖励越丰厚；落败则连胜归零。</div>
        <div class="soft">${kv('总胜场', String(p.arenaWins))}${kv('当前连胜', `<span class="gold">${p.streak}</span>`)}${kv('最高连胜', String(p.bestStreak))}</div>
        <div class="btns">${btn(`开始第 ${p.streak + 1} 轮挑战`, 'start', '', { primary: true })}</div>
      </div>
      <div>
        ${sec('规则')}
        <div class="soft lines">
          <div>· 进入后生命与源能回满，技能冷却清零</div>
          <div>· 圆形擂台，无法离开边界</div>
          <div>· 药水、技能、装备与技能树照常生效</div>
          <div>· 落败不算真实死亡，会回到主城</div>
        </div>
      </div>
    </div>`;
  },
  action(act) {
    if (act === 'start') travel(() => enterArena());
  },
};

/* ---------- 秘境 ---------- */
export const secretPanel: PanelDef = {
  title: () => DUNGEONS.secret?.name ?? '秘境',
  wide: false,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    const tr = safe(() => peekTrial(), null);
    const lv = safe(() => secretLevel(p.bestFloor), DUNGEONS.secret?.lv ?? 8);
    const trial = tr
      ? `<div class="soft"><b class="gold">本次试炼 · ${esc(tr.name)}</b><div>${esc(tr.desc)}</div>`
        + `<div class="dim">限时 ${tr.time} 秒 · 目标 ${tr.goal} · 奖励金币 ${tr.gold} 起 + 特殊遗物</div></div>`
      : '';
    return `${sec('秘境 · 试炼回廊')}
      <div class="soft">${esc(LORE.dungeons.secret ?? '独立小地图的限定条件战斗。')}</div>
      ${trial}
      <div class="soft lines">
        <div>· 单层地图，怪物等级约 <b class="${p.lv + 2 < lv ? 'down' : 'up'}">Lv.${lv}</b>（跟随你到过的最深层数）</div>
        <div>· 限时内完成目标即可领取奖励；失败也只会被送回主城</div>
        <div>· 建议备好药水再出发（当前 生命 ×${p.potions.hp} / 源能 ×${p.potions.mp}）</div>
      </div>
      <div class="btns">${btn('开启秘境', 'start', '', { primary: true })}</div>`;
  },
  action(act) {
    if (act === 'start') travel(() => startSecret());
  },
};
