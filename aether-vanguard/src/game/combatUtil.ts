// 战斗通用工具（combat 代理内部模块）：阵营目标、视线、实体查找、角度。
// 只读 G，不产生副作用；combat / skills / projectiles / hazards / motion 共用，避免互相循环引用。

import { G } from './state';
import type { Actor, Enemy, Player, Team } from './types';
import { lineOfSight } from '../world/los';
import { wrapAngle } from '../core/util';

export function isPlayerActor(a: Actor): a is Player { return a.team === 'player'; }
export function isEnemyActor(a: Actor): a is Enemy { return a.team === 'enemy'; }

/** 是否可被命中：存活；敌人还要求出生无敌（spawnT）已结束 */
export function hittable(a: Actor): boolean {
  if (a.dead || a.hp <= 0) return false;
  if (isEnemyActor(a)) return a.spawnT <= 0;
  return G.mode !== 'dead';
}

/** 施法者阵营 team 的敌对目标（玩家方 → 存活敌人；敌方 → 玩家） */
export function hostilesOf(team: Team): Actor[] {
  const out: Actor[] = [];
  if (team === 'player') {
    for (const e of G.enemies) if (hittable(e)) out.push(e);
  } else {
    const p = G.player;
    if (p && hittable(p)) out.push(p);
  }
  return out;
}

/** 两点之间无不透明格（没有地图时视为畅通） */
export function clearLine(x0: number, y0: number, x1: number, y1: number): boolean {
  return !G.map || lineOfSight(G.map, x0, y0, x1, y1);
}

/** 按 id 查找玩家或敌人 */
export function actorById(id: number): Actor | null {
  const p = G.player;
  if (p && p.id === id) return p;
  for (const e of G.enemies) if (e.id === id) return e;
  return null;
}

/** 两角之差的绝对值（0..π） */
export function angDiff(a: number, b: number): number {
  return Math.abs(wrapAngle(a - b));
}

/** 从 (x,y) 起离 (x,y) 最近、未在 exclude 中、视线可达的敌对目标 */
export function nearestHostile(team: Team, x: number, y: number, range: number, exclude?: ReadonlySet<number>): Actor | null {
  let best: Actor | null = null;
  let bd = Infinity;
  for (const t of hostilesOf(team)) {
    if (exclude?.has(t.id)) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d - t.r > range || d >= bd) continue;
    if (!clearLine(x, y, t.x, t.y)) continue;
    best = t;
    bd = d;
  }
  return best;
}
