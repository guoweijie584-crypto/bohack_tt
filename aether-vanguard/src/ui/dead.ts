// 死亡页（{t:'ui', what:'dead'}）：战绩 + 已损失的金币（死亡瞬间已结算，防刷新绕过）+ “复活” → combat.revive()；Enter 也可复活。

import { esc, fmt } from '../core/util';
import { clsOf } from '../data/classes';
import { deathGoldLoss, revive } from '../game/combat';
import { G } from '../game/state';
import type { Player } from '../game/types';
import { el, q } from './dom';
import { C_BAD, ensureAudio, errMsg, sfx, ui } from './shared';
import { fmtTime, zoneName } from './text';

let root: HTMLElement | null = null;
let shown = false;

/** 死亡页信息 HTML（纯函数） */
export function deathInfoHtml(p: Player | null, zone: string): string {
  if (!p) return '';
  const c = clsOf(p.cid);
  // 金币惩罚已在 combat.playerDie 结算（死亡瞬间扣除并存档），这里只展示实际损失
  const lost = deathGoldLoss();
  return `<div><b>${esc(p.name || c.name)}</b> · ${esc(c.name)} Lv.${p.lv}</div>`
    + `<div class="dim">倒在了 ${esc(zone)}</div>`
    + `<div class="d-stats"><span>击杀 <b>${p.kills}</b></span><span>死亡 <b>${p.deaths}</b></span>`
    + `<span>最深 <b>第 ${p.bestFloor} 层</b></span><span>金币 <b class="gold">${esc(fmt(p.gold))}</b></span>`
    + `<span>时长 <b>${esc(fmtTime(p.playTime))}</b></span></div>`
    + (G.scene === 'arena' ? '<div class="dim">竞技场落败</div>' : `<div class="dim">本次死亡损失 <b class="down">${lost}</b> 金币（10%）</div>`);
}

export function mountDead(parent: HTMLElement): void {
  root = el('div', 'dead',
    '<div class="d-title">源 能 溃 散</div><div class="d-info"></div>'
    + '<button class="btn primary" data-dead="revive">在主城复活</button><div class="d-tip dim">按 Enter 复活</div>');
  root.hidden = true;
  parent.appendChild(root);
  root.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target.closest('[data-dead]') : null;
    if (!t) return;
    ensureAudio();
    doRevive();
  });
}

export function showDead(): void {
  if (!root) return;
  shown = true;
  q(root, '.d-info').innerHTML = deathInfoHtml(G.player, zoneName());
  q(root, '[data-dead]').textContent = G.scene === 'arena' ? '返回主城' : '在主城复活';
  root.hidden = false;
}

export function hideDead(): void {
  shown = false;
  if (root) root.hidden = true;
}

export function deadShown(): boolean { return shown; }

export function doRevive(): void {
  if (G.mode !== 'dead') { hideDead(); return; }
  try {
    revive();
    sfx('portal');
  } catch (e) {
    ui.toast('复活失败：' + errMsg(e), C_BAD);
    return;
  }
  if (G.mode !== 'dead') hideDead();
}
