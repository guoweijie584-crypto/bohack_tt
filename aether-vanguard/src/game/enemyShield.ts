// 护盾 AI（改版意见：阶段性生成护盾，需要打破护盾才能扣血）的伤害吸收。
// 本文件只依赖 state，任何模块都可以无循环地调用：
//   const left = absorbShield(e, v); e.hp -= left;
// 现状：combat.damageEnemy / DoT 已内置“先扣护盾”；enemies.updateEnemies 另有兜底——护盾仍在而生命掉了时，
// 下一步从护盾里把（非致命的）伤害补回。破盾的踉跄与提示由 enemies 统一检测（护盾在持续时间内归零）。

import { emit, floater } from './state';
import type { Enemy } from './types';

const SHIELD_COLOR = '#8fe0ff';

/** 护盾吸收伤害：返回穿透护盾后剩余的伤害 */
export function absorbShield(e: Enemy, dmg: number): number {
  if (e.shield <= 0 || dmg <= 0) return dmg;
  const ab = Math.min(e.shield, dmg);
  e.shield -= ab;
  if (e.shield < 0.5) e.shield = 0;
  floater(e.x, e.y - e.r - 10, `-${Math.round(ab)}`, SHIELD_COLOR, 10);
  return dmg - ab;
}

/** 破盾提示（碎片 + 飘字；combat 破盾时已发 ring/sfx，这里不重复） */
export function shieldBreakFx(e: Enemy): void {
  emit({ t: 'burst', x: e.x, y: e.y, color: SHIELD_COLOR, n: 18, spd: 140 });
  floater(e.x, e.y - e.r - 14, '破盾!', SHIELD_COLOR, 13, true);
}
