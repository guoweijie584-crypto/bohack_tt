// 大地图：迷雾门控（只画已探索；敌人只画视野内；首领位置已知才标注，未知只给边缘箭头），面板打开期间持续刷新脉冲。

import { esc } from '../../core/util';
import { G } from '../../game/state';
import { ico } from '../icons';
import { BOSS_UNKNOWN_TEXT, drawBigMap, type MapLabel, portalColor } from '../minimap';
import { cssColor } from '../shared';
import { zoneName } from '../text';
import { kv, sec } from './common';
import type { PanelDef } from './types';

let redrawT = 0;
/** 面板自己的动画时钟（模拟暂停时 G.realTime 不一定在走） */
let animT = 0;

function legend(): string {
  const dot = (c: string, t: string): string => `<span class="lg"><i style="background:${cssColor(c)}"></i>${esc(t)}</span>`;
  return [
    dot('#fff6e2', '你'), dot('#d9705f', '视野内敌人'), dot('#f0a060', '精英'), dot('#ff6b5f', '首领（已发现）'),
    dot(portalColor('next', true), '出口'), dot(portalColor('dungeon', true), '传送阵'), dot('#ffe0a0', 'NPC'), dot('#100b08', '未探索'),
  ].join('');
}

/** 标签宽度估算（12px 像素字体：中日韩字符 12px，其余约 7px） */
function labelWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[⺀-￿]/.test(ch) ? 12 : 7;
  return w + 4;
}

/**
 * 大地图标签避让（纯函数）：按优先级（你 > 首领 > 传送阵 > NPC）依次放置，
 * 与已放置的标签重叠时上下交替错开一行；NPC 只显示「·」后的名字。返回标签的底边中点坐标（CSS px）。
 */
export function layoutLabels(labels: readonly MapLabel[], k: number): Array<{ l: MapLabel; x: number; y: number; text: string }> {
  const rank = (l: MapLabel): number => (l.cls === 'me' ? 0 : l.cls === 'boss' ? 1 : l.cls === 'npc' ? 3 : 2);
  const order = [...labels].sort((a, b) => rank(a) - rank(b));
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const lh = 14;
  const out: Array<{ l: MapLabel; x: number; y: number; text: string }> = [];
  for (const l of order) {
    const text = l.cls === 'npc' && l.text.includes('·') ? (l.text.split('·').pop() ?? l.text).trim() : l.text;
    const w = labelWidth(text);
    const x = l.x * k;
    let y = l.y * k;
    for (let i = 0; i < 8; i++) {
      const box = { x0: x - w / 2, x1: x + w / 2, y0: y - lh, y1: y };
      if (!placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) break;
      const step = Math.floor(i / 2) + 1;
      y = l.y * k + (i % 2 === 0 ? -step * lh : step * lh);
    }
    placed.push({ x0: x - w / 2, x1: x + w / 2, y0: y - lh, y1: y });
    out.push({ l, x, y, text });
  }
  return out;
}

function draw(body: HTMLElement, t: number): void {
  const cv = body.querySelector<HTMLCanvasElement>('.bm-cv');
  const wrap = body.querySelector<HTMLElement>('.bm-wrap');
  const lbBox = body.querySelector<HTMLElement>('.bm-labels');
  const info = body.querySelector<HTMLElement>('.bm-boss');
  if (!cv || !wrap || !lbBox) return;
  const res = drawBigMap(cv, t);
  if (!res) return;
  // 整数倍放大
  const maxW = Math.max(200, (wrap.parentElement?.clientWidth ?? 600) - 8);
  const k = Math.max(1, Math.floor(Math.min(maxW / res.w, 440 / res.h)));
  const cw = `${res.w * k}px`, ch = `${res.h * k}px`;
  if (cv.style.width !== cw) { cv.style.width = cw; cv.style.height = ch; wrap.style.width = cw; wrap.style.height = ch; }
  lbBox.innerHTML = layoutLabels(res.labels, k).map(({ l, x, y, text }) =>
    `<span class="bm-lb${l.cls ? ' ' + l.cls : ''}" style="left:${x}px;top:${y}px;color:${cssColor(l.color)}">${esc(text)}</span>`).join('');
  if (info) {
    const h = res.hint;
    const html = h.state === 'none'
      ? '<span class="dim">当前区域没有首领（每个副本第 3 层为首领层）。</span>'
      : h.state === 'unknown'
        ? `<span class="down">${ico('skull', 1)}${esc(BOSS_UNKNOWN_TEXT)}</span><br><span class="dim">大致方向：${esc(h.dir)}方（地图边缘的红色箭头）</span>`
        : `<span class="up">${ico('skull', 1)}${esc(G.boss?.def?.n ?? '首领')}</span> · ${esc(h.dir)}方 ${h.distTiles} 格`
          + (G.boss ? `<br><span class="dim">生命 ${Math.ceil(G.boss.hp)} / ${Math.ceil(G.boss.maxHp)}${G.boss.phase >= 2 ? ' · 二阶段' : ''}</span>` : '');
    if (info.innerHTML !== html) info.innerHTML = html;
  }
}

export const mapPanel: PanelDef = {
  title: () => '区域地图',
  tabs: true,
  wide: true,
  needsPlayer: true,
  body() {
    const m = G.map;
    const explored = m ? (m.fog ? `${Math.round(m.exploredRatio() * 100)}%` : '全图可见') : '—';
    const alive = G.enemies.filter(e => !e.dead && m?.isVisibleWorld(e.x, e.y)).length;
    const exit = G.portals.find(pt => pt.kind === 'next');
    const exitTxt = G.scene === 'dungeon'
      ? (exit ? (m?.isExploredWorld(exit.x, exit.y) ? (exit.open ? '已发现 · 已开启' : '已发现 · 未开启') : '尚未发现') : (G.floor >= 3 ? '击败首领后开启回城传送阵' : '—'))
      : '—';
    return `<div class="bigmap"><div class="bm-wrap"><canvas class="bm-cv"></canvas><div class="bm-labels"></div></div></div>
      <div class="legend">${legend()}</div>
      <div class="grid2">
        <div class="soft">
          ${kv('当前区域', esc(zoneName()))}
          ${kv('探索度', esc(explored))}
          ${kv('地图尺寸', m ? `${m.w} × ${m.h} 格` : '—')}
          ${kv('视野内敌人', String(alive))}
          ${kv('出口', esc(exitTxt))}
        </div>
        <div class="soft">${sec('首领')}<div class="bm-boss"></div></div>
      </div>`;
  },
  mounted(body) { redrawT = 0; draw(body, animT); },
  tick(dt, body) {
    animT += dt;
    redrawT -= dt;
    if (redrawT > 0) return;
    redrawT = 0.12;
    draw(body, animT);
  },
};
