// 怪物生成与 AI。移植自 legacy L1005–1015（spawnEnemy）、L1016（spawnArena 的镜像数值）、L1355–1442（updateEnemies）。
// 修正：速度改为 世界单位/秒（legacy 每帧像素 ×60）；流场寻路 + 视线 + 仇恨半径/脱战；带碰撞的互推；
//       召唤/瞬移点校验；冲锋前摇；镜像对手使用 castByKind 放 QER；新增 flank（迂回）/summoner（召唤）/shield（护盾）AI；
//       怪物等级与多重血条；Boss 技能更丰富（多种弹幕 + 二阶段）；击退在眩晕中也会推进；远程不隔墙开火；
//       玩家潜行时怪物只能追到最后见到的位置（legacy AI 完全无视潜行）。
// 【契约】签名不可改；实现由 enemies 代理完成。
//
// 模块拆分（无循环依赖）：enemyState（扩展状态/常量）← enemyNav（流场/转向/位移/互推/落点）
//   ← enemyActs（构造/近战/冲锋/弹幕/召唤）← enemyAi（普通 AI + 镜像）/ bosses（首领技能组）← 本文件。

import { rng } from '../core/rng';
import { clsOf } from '../data/classes';
import type { EnemyDef, RouteId } from '../data/types';
import { lineOfSight } from '../world/los';
import { isStunned, killEnemy, tickKnockback, tickStatus } from './combat';
import { inMotion } from './motion';
import { G, floater } from './state';
import type { Enemy, Player } from './types';
import { buildEnemy, createEnemy, startStagger } from './enemyActs';
import { aiCharger, aiChase, aiFlank, aiRival, aiShield, aiShooter, aiSummoner, wander } from './enemyAi';
import { shieldBreakFx } from './enemyShield';
import { aiBoss, tickBoss } from './bosses';
import { applyMove, prepareNav, separate } from './enemyNav';
import { AGGRO_R, LEASH_R, LEASH_T, ext, faceTo, setAnim, type EnemyExt, type Tgt } from './enemyState';

export interface SpawnOpts {
  lv?: number;
  /** 强度倍率（层数/副本） */
  mul?: number;
  elite?: boolean;
  boss?: boolean;
  summonedBy?: number;
  /** 出生即仇恨玩家 */
  aggro?: boolean;
}

/**
 * 生成怪物：等级 lv（默认玩家等级）成长、精英/首领倍率、多重血条、出生点 nearestFree、0.5s 淡入，
 * emit spawn 并加入 G.enemies。首领在 G.boss 为空时同时登记为 G.boss。
 */
export function spawnEnemy(kind: string, x: number, y: number, opts?: SpawnOpts): Enemy {
  return createEnemy(kind, x, y, opts ?? {});
}

/** 竞技场镜像对手（使用玩家同一套技能） */
export function spawnRival(cid: string, route: RouteId, streak: number, x: number, y: number): Enemy {
  const cls = clsOf(cid);
  const p = G.player;
  const st = p?.stat;
  // legacy L1027–1030：hp=(玩家 maxHp×0.9+180)×(1+连胜×0.12)，atk=玩家 atk×0.9+8，armor×0.7，spd 1.9，range 270
  const hp = ((st?.maxHp ?? cls.hp) * 0.9 + 180) * (1 + Math.max(0, streak) * 0.12);
  const atk = (st?.atk ?? cls.atk) * 0.9 + 8;
  const armor = (st?.armor ?? cls.armor) * 0.7;
  const def: EnemyDef = {
    n: `镜像 · ${cls.name}`, hp, atk, spd: 1.9, armor, exp: 0, gold: 0, r: 12, el: cls.element, weak: 'physical',
    s: 'rival', c: cls.color, ai: 'rival', range: 270, sprite: `skin_${cls.id}`,
    desc: `与你实力相当的镜像斗士，会使用${cls.name}的全部技能。`,
  };
  const e = buildEnemy('rival', def, x, y, { lv: p?.lv ?? 1, aggro: true }, { hp, atk, armor, spd: 1.9 * 60, exp: 0, gold: 0 });
  e.rival = { cid: cls.id, route, cdQ: rng.range(1.5, 3), cdE: rng.range(3, 5), cdR: rng.range(5, 8) };
  const x0 = ext(e);
  x0.t1 = 1.4; // 首次普攻
  x0.t2 = 5; // 首次冲刺
  x0.subT = 8; // 奥义冷却
  return e;
}

/* ------------------------------------------------------------------ */
/* 主循环                                                                */
/* ------------------------------------------------------------------ */
export function updateEnemies(dt: number): void {
  const map = G.map;
  if (!map) return;
  const p = G.player;
  if (p) prepareNav(p.x, p.y);
  const list = G.enemies;
  // 本步新召唤的怪物（加在末尾）下一步才行动
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const e = list[i];
    if (!e || e.dead) continue;
    stepEnemy(e, p, dt);
  }
  separate(list, p, dt);
  for (const e of list) {
    if (e.dead) continue;
    const x = ext(e);
    x.lastHp = e.hp;
    x.lastShield = e.shield;
    x.lastAggro = e.aggro;
  }
  removeDead(list, dt);
}

/**
 * 原地移除死亡怪物（保持数组引用不变）。首领死亡时只要还是 G.boss 就保留（最多 2 秒），
 * 让 world 有机会检测 G.boss.dead（开传送阵等）并把 G.boss 置空。
 */
function removeDead(list: Enemy[], dt: number): void {
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    let keep = !e.dead;
    if (!keep && e === G.boss) {
      const x = ext(e);
      x.deadT += dt;
      keep = x.deadT <= 2;
    }
    if (keep) list[w++] = e;
  }
  list.length = w;
}

function stepEnemy(e: Enemy, p: Player | null, dt: number): void {
  const x = ext(e);
  e.animT += dt;
  e.aiT += dt;
  // 1) 上一步以来受到的外部伤害：护盾兜底吸收 + 受击仇恨
  checkHurt(e, x);
  if (e.dead) return;
  // 2) 出生淡入：不行动
  if (e.spawnT > 0) {
    e.spawnT = Math.max(0, e.spawnT - dt);
    if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);
    e.vx = 0;
    e.vy = 0;
    setAnim(e, 'idle');
    return;
  }
  // 3) 状态与 DoT（tickStatus 负责扣血、DoT 致死时内部 killEnemy；这里再兜底检查一次）
  const flash0 = e.flash;
  tickStatus(e, dt);
  // 受击闪白：combat.tickStatus 已顺带衰减时不重复衰减
  if (e.flash > 0 && e.flash === flash0) e.flash = Math.max(0, e.flash - dt);
  checkHurt(e, x);
  if (e.hp <= 0 && !e.dead) killEnemy(e);
  if (e.dead) return;
  // 4) 护盾计时、首领被动（冷却/冲击波/二阶段）、击退（眩晕中也推进，修正 legacy 击退挂起）
  tickShieldTimer(e, x, dt);
  if (e.boss) tickBoss(e, p, dt);
  tickKnockback(e, dt);
  e.cdAtk -= dt;
  e.cdSkill -= dt;
  e.cdSkill2 -= dt;
  // 5) 眩晕：打断前摇（怒吼除外），跳过 AI
  if (isStunned(e)) {
    if (x.act && x.act.k !== 'roar') x.act = null;
    if (e.ai === 'windup' || e.ai === 'charge' || e.ai === 'summon' || e.ai === 'attack') e.ai = e.aggro ? 'chase' : 'idle';
    e.vx = 0;
    e.vy = 0;
    setAnim(e, 'hurt');
    return;
  }
  x.mspd = 0;
  // 技能位移脚本（镜像对手的冲锋类技能，由 combat 的 motion 在 updateHazards 中推进）期间不叠加 AI 走位
  if (inMotion(e.id)) return;
  if (!p || p.dead || p.hp <= 0) {
    // 玩家倒下：收手闲逛
    x.act = null;
    if (e.aggro) dropAggro(e, x);
    wander(e, x, dt);
    applyMove(e, x, dt);
    orient(e, x, null, null);
    return;
  }
  const t = perceive(e, x, p, dt);
  // 仇恨上升沿（视野发现 / 受击——combat 会直接置 aggro / 被同伴呼叫除外）
  if (e.aggro && !x.lastAggro) onAggroStart(e, x);
  if (!e.aggro) wander(e, x, dt);
  else runAi(e, x, p, t, dt);
  applyMove(e, x, dt);
  orient(e, x, p, t);
}

function runAi(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  if (e.rival) {
    aiRival(e, x, p, t, dt);
    return;
  }
  switch (e.def.ai) {
    case 'charger': aiCharger(e, x, p, t, dt); break;
    case 'shooter': aiShooter(e, x, p, t, dt); break;
    case 'flank': aiFlank(e, x, p, t, dt); break;
    case 'summoner': aiSummoner(e, x, p, t, dt); break;
    case 'shield': aiShield(e, x, p, t, dt); break;
    case 'boss': aiBoss(e, x, p, t, dt); break;
    case 'rival': aiRival(e, x, p, t, dt); break;
    default: aiChase(e, x, p, t, dt);
  }
}

/* ------------------------------------------------------------------ */
/* 受击检测 / 护盾                                                        */
/* ------------------------------------------------------------------ */
/**
 * 比较上一步结束时的生命/护盾：
 * - 受到伤害 → 获得仇恨（随后的仇恨上升沿会呼叫附近同伴）；
 * - 护盾仍在但生命掉了（伤害来源没走“先扣护盾”时的兜底）→ 从护盾里把这部分补回（打破护盾才扣血）；
 * - 护盾在持续时间内归零 → 判定“被打破”：提示 + 踉跄 0.6s（首领 0.8s）。
 */
function checkHurt(e: Enemy, x: EnemyExt): void {
  const dHp = x.lastHp - e.hp;
  const dSh = x.lastShield - e.shield;
  if (dHp > 0.01 || dSh > 0.01) {
    if (dHp > 0.01 && e.shield > 0 && !e.dead && e.hp > 0) {
      const back = Math.min(e.shield, dHp);
      e.shield -= back;
      e.hp += back;
      if (e.shield < 0.5) e.shield = 0;
      floater(e.x, e.y - e.r - 10, `-${Math.round(back)}`, '#8fe0ff', 10);
    }
    if (!e.aggro && !e.dead) setAggro(e, x);
  }
  if (x.lastShield > 0 && e.shield <= 0 && x.shieldT > 0 && !e.dead) {
    // 护盾在持续时间内归零 = 被打破：提示 + 踉跄（首领怒吼中不打断）
    x.shieldT = 0;
    shieldBreakFx(e);
    if (e.boss) {
      if (!x.act || x.act.k !== 'roar') startStagger(e, x, 0.8);
    } else startStagger(e, x, 0.6);
  }
  x.lastHp = e.hp;
  x.lastShield = e.shield;
}

/**
 * 外部护盾的默认持续秒数：镜像对手的铁壁/寒冰护盾/不屈壁垒由 skills.castByKind 直接写 e.shield，不带计时
 * （与玩家铁壁/不屈壁垒的 6 秒一致）。
 */
const EXT_SHIELD_DUR = 6;

function tickShieldTimer(e: Enemy, x: EnemyExt, dt: number): void {
  if (e.shield <= 0) {
    x.shieldT = 0;
    return;
  }
  // 有护盾却没有计时 = 外部直接加的（本模块 raiseShield 一定写 shieldT；计时到期/破盾都会把护盾清零）：
  // 给默认时长。修复：之前下一步就 shieldT<0 → 护盾被当成“到期”清零，镜像的护盾技能完全无效。
  if (x.shieldT <= 0) x.shieldT = EXT_SHIELD_DUR;
  x.shieldT -= dt;
  if (x.shieldT <= 0) {
    // 自然到期：不算破盾
    e.shield = 0;
    x.shieldT = 0;
    x.lastShield = 0;
  }
}

/* ------------------------------------------------------------------ */
/* 感知与仇恨                                                            */
/* ------------------------------------------------------------------ */
/**
 * 感知：视线每 ~0.1s 刷新；距离 < 360 且视线可达 → 仇恨（潜行时只有 70 内才会被发现）；
 * 距离 > 900 持续 4s → 脱战回 idle（镜像对手不脱战）。玩家潜行且不在 120 内时，只能追到最后见到的位置。
 */
function perceive(e: Enemy, x: EnemyExt, p: Player, dt: number): Tgt {
  const map = G.map!;
  const d = Math.hypot(p.x - e.x, p.y - e.y);
  x.losT -= dt;
  if (x.losT <= 0) {
    // 未仇恨且在发现距离外的怪不需要视线：省掉远处闲逛怪的射线检测
    const need = e.aggro || d < AGGRO_R + 40;
    x.los = need && lineOfSight(map, e.x, e.y, p.x, p.y);
    x.losT = need ? 0.08 + rng.next() * 0.06 : 0.25 + rng.next() * 0.1;
  }
  const stealth = p.buffs.stealth > 0;
  if (!e.aggro) {
    if (x.los && d < (stealth ? 70 : AGGRO_R)) setAggro(e, x);
  } else if (!e.rival) {
    if (d > LEASH_R) {
      x.farT += dt;
      if (x.farT >= LEASH_T) dropAggro(e, x);
    } else x.farT = 0;
  }
  const known = !stealth || d < 120;
  if (known && x.los) {
    x.lkx = p.x;
    x.lky = p.y;
  }
  if (known) return { x: p.x, y: p.y, d, known: true, los: x.los };
  return { x: x.lkx, y: x.lky, d: Math.hypot(x.lkx - e.x, x.lky - e.y), known: false, los: false };
}

function setAggro(e: Enemy, x: EnemyExt): void {
  if (e.aggro) return;
  e.aggro = true;
  x.farT = 0;
  x.losT = 0; // 下一步立即重测视线
  if (e.ai === 'idle') e.ai = 'chase';
}

/**
 * 仇恨上升沿：头顶“!” + 记下玩家位置 + 呼叫附近（220 内、彼此可见）的同伴。
 * 被呼叫者直接记为“已在仇恨中”，不会再连锁呼叫，避免半张地图被一只怪叫醒。
 */
function onAggroStart(e: Enemy, x: EnemyExt): void {
  x.lastAggro = true;
  x.farT = 0;
  x.losT = 0;
  if (e.ai === 'idle') e.ai = 'chase';
  const p = G.player;
  if (p) {
    x.lkx = p.x;
    x.lky = p.y;
  }
  floater(e.x, e.y - e.r - 12, '!', '#ffd24a', 13);
  const map = G.map;
  for (const o of G.enemies) {
    if (o === e || o.dead || o.aggro) continue;
    if (Math.hypot(o.x - e.x, o.y - e.y) > 220) continue;
    if (map && !lineOfSight(map, e.x, e.y, o.x, o.y)) continue;
    const ox = ext(o);
    setAggro(o, ox);
    ox.lastAggro = true;
    if (p) {
      ox.lkx = p.x;
      ox.lky = p.y;
    }
  }
}

function dropAggro(e: Enemy, x: EnemyExt): void {
  e.aggro = false;
  e.ai = 'idle';
  x.lastAggro = false;
  x.act = null;
  x.farT = 0;
  x.sub = 0;
  x.homeX = e.x;
  x.homeY = e.y;
  x.wanderT = 0;
}

/* ------------------------------------------------------------------ */
/* 朝向与动画                                                            */
/* ------------------------------------------------------------------ */
function orient(e: Enemy, x: EnemyExt, p: Player | null, t: Tgt | null): void {
  const a = x.act;
  const dashing = !!a && a.ph === 'go' && (a.k === 'charge' || a.k === 'strike' || a.k === 'dash');
  if (!dashing) {
    if (p && t && e.aggro && t.known) faceTo(e, p.x, p.y);
    else if (Math.abs(e.vx) > 2 || Math.abs(e.vy) > 2) {
      if (Math.abs(e.vx) > 2) e.facing = e.vx > 0 ? 1 : -1;
      e.aim = Math.atan2(e.vy, e.vx);
    }
  }
  if (!a) setAnim(e, Math.hypot(e.vx, e.vy) > 6 ? 'run' : 'idle');
}

/* ------------------------------------------------------------------ */
/* 其它对外工具                                                          */
/* ------------------------------------------------------------------ */
export { absorbShield } from './enemyShield';

/** 调试/测试：怪物的 AI 扩展状态（只读用途） */
export function enemyDebug(e: Enemy): Readonly<EnemyExt> {
  return ext(e);
}
