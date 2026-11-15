// 普通怪物 AI（legacy L1379–1423 移植并修正）+ 改版意见新增的迂回 / 召唤 / 护盾 AI + 镜像对手。
// 约定：每个 AI 只决定“动作”和“期望移动”（setMove），实际位移由 enemyNav.applyMove 统一结算；
// 所有攻击都有前摇/预警；远程只在视线可达时开火（legacy 不判视线会隔墙射击）。

import { rng } from '../core/rng';
import { SKILLS, ULTS } from '../data/skills';
import { TREES } from '../data/trees';
import type { SkillDef, SkillKind, UltDef } from '../data/types';
import { wrapAngle } from '../core/util';
import { castByKind } from './skills';
import { emit, floater } from './state';
import type { Enemy, Player } from './types';
import {
  chargeTick, countSummons, fanVolley, fireOrb, laneClear, meleeStrike, meleeTick, startCharge, startMelee, summonAt,
  summonSpots, type ChargeOpts,
} from './enemyActs';
import { approach, kite, moveToTarget, setMove, spotNear } from './enemyNav';
import {
  CONTACT_GAP, EL_SFX, MELEE_REACH, ORB_SPEED, SHIELD_COLOR, SUMMON_CAP, SUMMON_COLOR, SUMMON_GLOBAL_CAP, elemColor,
  faceTo, newAct, setAnim, sfx, telegraph, warnArea, type Act, type EnemyExt, type Tgt,
} from './enemyState';
import { G } from './state';

/** 全图存活的普通召唤物（召唤者不是首领）数量 */
function countAllSummons(): number {
  const bossIds = new Set<number>();
  for (const o of G.enemies) if (o.boss) bossIds.add(o.id);
  let n = 0;
  for (const o of G.enemies) if (!o.dead && o.summonedBy !== undefined && !bossIds.has(o.summonedBy)) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* 公共                                                                  */
/* ------------------------------------------------------------------ */
/** 满足条件就开始近战前摇（需知道玩家位置、视线可达、进入判定距离、攻击冷却好） */
function tryMelee(e: Enemy, x: EnemyExt, p: Player, t: Tgt, wind: number): boolean {
  if (!t.known || !t.los || e.cdAtk > 0) return false;
  if (t.d > e.r + p.r + MELEE_REACH) return false;
  startMelee(e, x, p, wind);
  return true;
}

/** 通用动作推进（近战/踉跄），返回 true 表示本步已被动作占用 */
function tickCommon(e: Enemy, x: EnemyExt, p: Player, a: Act, dt: number, mult: number, cd: number): boolean {
  if (a.k === 'melee') {
    if (meleeTick(e, x, p, a, dt, mult, cd)) x.act = null;
    return true;
  }
  if (a.k === 'stagger') {
    a.t -= dt;
    setAnim(e, 'hurt');
    if (a.t <= 0) x.act = null;
    return true;
  }
  return false;
}

/** 闲逛（未发现玩家）：出生点附近慢走/发呆 */
export function wander(e: Enemy, x: EnemyExt, dt: number): void {
  e.ai = 'idle';
  x.wanderT -= dt;
  if (x.wanderT <= 0) {
    x.wanderT = rng.range(2.2, 4.8);
    const s = rng.chance(0.35) ? null : spotNear(x.homeX, x.homeY, rng.range(0, Math.PI * 2), rng.range(20, 72), e.r);
    x.wx = s ? s.x : e.x;
    x.wy = s ? s.y : e.y;
  }
  const dx = x.wx - e.x, dy = x.wy - e.y;
  if (dx * dx + dy * dy > 36) setMove(x, dx, dy, e.spd * 0.35);
}

/* ------------------------------------------------------------------ */
/* chase：贴身攻击，前摇 0.25s，cd 1.1s                                   */
/* ------------------------------------------------------------------ */
export function aiChase(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  if (x.act) {
    if (!tickCommon(e, x, p, x.act, dt, 1, 1.1)) x.act = null;
    return;
  }
  e.ai = 'chase';
  if (tryMelee(e, x, p, t, 0.25)) return;
  approach(e, x, p, t, 1);
}

/* ------------------------------------------------------------------ */
/* charger：60–240 距离前摇 0.45s（闪白 + 路线预警）后冲锋 0.35s           */
/* ------------------------------------------------------------------ */
export const CHARGER: ChargeOpts = { speed: 520, dur: 0.35, mult: 1.3, knock: 260, cd: 2.6, stun: 0.6 };

export function aiCharger(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const a = x.act;
  if (a) {
    if (a.k === 'charge') {
      if (chargeTick(e, x, p, a, dt, CHARGER)) x.act = null;
    } else if (!tickCommon(e, x, p, a, dt, 1, 1.2)) x.act = null;
    return;
  }
  e.ai = 'chase';
  if (t.known && t.los && e.cdSkill <= 0 && t.d > 60 && t.d < 240 && laneClear(e, p)) {
    startCharge(e, x, p, 0.45, CHARGER);
    return;
  }
  if (tryMelee(e, x, p, t, 0.3)) return;
  approach(e, x, p, t, 1);
}

/* ------------------------------------------------------------------ */
/* shooter：保持 0.55–0.85×射程绕圈，视线可达每 2s 射击                    */
/* ------------------------------------------------------------------ */
export function aiShooter(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const range = e.def.range ?? 220;
  const a = x.act;
  if (a) {
    if (a.k === 'shot') {
      if (a.ph === 'wind') {
        a.t -= dt;
        faceTo(e, p.x, p.y);
        e.ai = 'windup';
        setAnim(e, 'attack');
        if (a.t <= 0) {
          if (t.known && t.los) {
            fireOrb(e, Math.atan2(p.y - e.y, p.x - e.x), ORB_SPEED, e.atk * 0.85);
            sfx(EL_SFX[e.def.el], e.x, e.y, 0.5);
          }
          e.cdAtk = 2;
          a.ph = 'rec';
          a.t = 0.2;
        }
      } else {
        a.t -= dt;
        if (a.t <= 0) x.act = null;
      }
    } else if (!tickCommon(e, x, p, a, dt, 1, 1.2)) x.act = null;
    return;
  }
  // 不定期换绕圈方向，避免所有远程怪同向打转
  x.t1 -= dt;
  if (x.t1 <= 0) {
    x.t1 = rng.range(2.5, 5);
    if (rng.chance(0.4)) e.orbitDir = e.orbitDir === 1 ? -1 : 1;
  }
  if (t.known && t.los && e.cdAtk <= 0 && t.d < range + 60) {
    x.act = newAct('shot', 0.3);
    telegraph(e, 0.3, elemColor(e.def.el), 10);
    e.ai = 'windup';
    return;
  }
  const mode = kite(e, x, p, t, range * 0.7, range * 0.15, 1);
  e.ai = mode === 'strafe' ? 'strafe' : mode === 'retreat' ? 'retreat' : 'chase';
}

/* ------------------------------------------------------------------ */
/* flank（新）：接近到 ~140 → 绕到玩家侧后方 → 前摇突进 → 撤开 → 再绕       */
/* ------------------------------------------------------------------ */
const FLANK_R = 92;

export function aiFlank(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const a = x.act;
  if (a) {
    if (a.k === 'strike') {
      if (a.ph === 'wind') {
        a.t -= dt;
        faceTo(e, p.x, p.y);
        e.ai = 'windup';
        setAnim(e, 'attack');
        if (a.t <= 0) {
          const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 1;
          a.dx = dx / d;
          a.dy = dy / d;
          a.ph = 'go';
          a.t = 0.3;
          emit({ t: 'afterimage', actorId: e.id });
          sfx('dash', e.x, e.y, 0.5);
        }
        return;
      }
      if (a.ph === 'go') {
        e.ai = 'charge';
        setAnim(e, 'run');
        setMove(x, a.dx, a.dy, Math.max(380, e.spd * 2.6));
        a.t -= dt;
        if (!a.hit && Math.hypot(p.x - e.x, p.y - e.y) < e.r + p.r + MELEE_REACH) {
          // 突进命中走与近战相同的结算（含视线校验），伤害略高、带小击退
          a.hit = true;
          meleeStrike(e, p, 1.25, 4, 120);
          a.t = 0;
        }
        if (a.t <= 0) {
          x.act = null;
          x.sub = 2;
          x.subT = rng.range(0.6, 0.9);
          e.cdAtk = 1.4;
        }
        return;
      }
      x.act = null;
      return;
    }
    if (!tickCommon(e, x, p, a, dt, 1, 1.2)) x.act = null;
    return;
  }
  if (!t.known) {
    x.sub = 0;
    e.ai = 'chase';
    moveToTarget(e, x, p, t, 1);
    return;
  }
  switch (x.sub) {
    case 1: {
      // 绕侧后：目标角 = 玩家瞄准方向的背面偏一侧；切向绕行 + 径向收敛到 FLANK_R
      e.ai = 'flank';
      x.subT += dt;
      if (!t.los || t.d > 240) {
        x.sub = 0;
        break;
      }
      const cur = Math.atan2(e.y - p.y, e.x - p.x);
      const want = p.aim + Math.PI + e.orbitDir * 0.55;
      const diff = wrapAngle(want - cur);
      if ((Math.abs(diff) < 0.45 || x.subT > 2.0) && e.cdAtk <= 0) {
        x.act = newAct('strike', 0.22);
        telegraph(e, 0.22);
        e.ai = 'windup';
        break;
      }
      const dir = diff >= 0 ? 1 : -1;
      const ox = Math.cos(cur), oy = Math.sin(cur);
      const radial = (t.d - FLANK_R) / FLANK_R;
      setMove(x, -oy * dir - ox * radial * 1.2, ox * dir - oy * radial * 1.2, e.spd * 1.15);
      break;
    }
    case 2: {
      // 撤开：远离玩家并向侧面拉开
      e.ai = 'retreat';
      x.subT -= dt;
      const cur = Math.atan2(e.y - p.y, e.x - p.x);
      setMove(x, Math.cos(cur) - Math.sin(cur) * e.orbitDir * 0.6, Math.sin(cur) + Math.cos(cur) * e.orbitDir * 0.6, e.spd * 1.1);
      if (x.subT <= 0) {
        x.sub = 1;
        x.subT = 0;
        if (rng.chance(0.5)) e.orbitDir = e.orbitDir === 1 ? -1 : 1;
      }
      break;
    }
    default: {
      e.ai = 'chase';
      if (t.los && t.d < 150) {
        x.sub = 1;
        x.subT = 0;
        break;
      }
      approach(e, x, p, t, 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* summoner（新）：保持距离；每 7s 召唤 2 只（上限 6）；间隔射弱弹          */
/* ------------------------------------------------------------------ */
export function aiSummoner(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const range = e.def.range ?? 240;
  const a = x.act;
  if (a) {
    if (a.k === 'summon') {
      if (a.ph === 'wind') {
        a.t -= dt;
        e.ai = 'summon';
        setAnim(e, 'cast');
        if (a.t <= 0) {
          const kinds = e.def.summons?.length ? e.def.summons : ['skeleton'];
          for (const s of a.spots) {
            if (countSummons(e.id) >= SUMMON_CAP) break;
            summonAt(e, rng.pick(kinds), s);
          }
          e.cdSkill = 7;
          a.ph = 'rec';
          a.t = 0.3;
        }
      } else {
        a.t -= dt;
        if (a.t <= 0) x.act = null;
      }
      return;
    }
    if (a.k === 'shot') {
      if (a.ph === 'wind') {
        a.t -= dt;
        faceTo(e, p.x, p.y);
        e.ai = 'windup';
        setAnim(e, 'cast');
        if (a.t <= 0) {
          if (t.known && t.los) {
            fireOrb(e, Math.atan2(p.y - e.y, p.x - e.x), ORB_SPEED * 0.9, e.atk * 0.5);
            sfx(EL_SFX[e.def.el], e.x, e.y, 0.4);
          }
          e.cdAtk = 2.4;
          a.ph = 'rec';
          a.t = 0.2;
        }
      } else {
        a.t -= dt;
        if (a.t <= 0) x.act = null;
      }
      return;
    }
    if (!tickCommon(e, x, p, a, dt, 0.8, 1.4)) x.act = null;
    return;
  }
  if (t.known && e.cdSkill <= 0 && t.d < range + 160) {
    const room = Math.min(SUMMON_CAP - countSummons(e.id), SUMMON_GLOBAL_CAP - countAllSummons());
    const spots = room > 0 ? summonSpots(e, Math.min(2, room), e.r + 30, 12) : [];
    if (spots.length) {
      x.act = newAct('summon', 0.8, { spots });
      for (const s of spots) warnArea(s.x, s.y, 14, 0.8, SUMMON_COLOR);
      telegraph(e, 0.8, SUMMON_COLOR, 20);
      emit({ t: 'cast', actorId: e.id, el: e.def.el });
      sfx('summon', e.x, e.y);
      e.ai = 'summon';
      setAnim(e, 'cast');
      return;
    }
    e.cdSkill = 1.5;
  }
  if (t.known && t.los && e.cdAtk <= 0 && t.d < range + 40) {
    x.act = newAct('shot', 0.35);
    telegraph(e, 0.35, elemColor(e.def.el), 8);
    e.ai = 'windup';
    return;
  }
  const mode = kite(e, x, p, t, range * 0.75, range * 0.2, 0.9);
  e.ai = mode === 'strafe' ? 'strafe' : mode === 'retreat' ? 'retreat' : 'chase';
}

/* ------------------------------------------------------------------ */
/* shield（新）：周期性举盾（护盾=shieldPct×maxHp，5s，期间移速减半）       */
/* 伤害先扣护盾（enemyShield.absorbShield / enemies 兜底吸收），破盾后踉跄    */
/* ------------------------------------------------------------------ */
export const SHIELD_DUR = 5;

export function aiShield(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const a = x.act;
  if (a) {
    if (a.k === 'raise') {
      a.t -= dt;
      e.ai = 'windup';
      setAnim(e, 'cast');
      if (a.t <= 0) {
        raiseShield(e, x, (e.def.shieldPct ?? 0.35) * e.maxHp, SHIELD_DUR);
        e.cdSkill = SHIELD_DUR + 6;
        x.act = null;
      }
      return;
    }
    if (!tickCommon(e, x, p, a, dt, 1.1, 1.3)) x.act = null;
    return;
  }
  e.ai = e.shield > 0 ? 'shield' : 'chase';
  if (e.shield <= 0 && e.cdSkill <= 0 && t.known && t.d < 320) {
    x.act = newAct('raise', 0.4);
    telegraph(e, 0.4, SHIELD_COLOR, 22);
    floater(e.x, e.y - e.r - 12, '举盾', SHIELD_COLOR, 11);
    e.ai = 'windup';
    setAnim(e, 'cast');
    return;
  }
  if (tryMelee(e, x, p, t, 0.3)) return;
  approach(e, x, p, t, e.shield > 0 ? 0.5 : 1);
}

/** 生成护盾（护盾 AI 与首领岩甲共用） */
export function raiseShield(e: Enemy, x: EnemyExt, amount: number, dur: number): void {
  e.shield = Math.max(e.shield, amount);
  x.shieldT = dur;
  x.lastShield = e.shield;
  emit({ t: 'ring', x: e.x, y: e.y, r0: e.r, r1: e.r + 18, color: SHIELD_COLOR, dur: 0.35 });
  sfx('shield', e.x, e.y);
}

/* ------------------------------------------------------------------ */
/* rival（镜像对手）：保持 190±45；castByKind 放 Q/E/R；三连发普攻；偶尔冲刺 */
/* ------------------------------------------------------------------ */
const RIVAL_WANT = 190;
const RIVAL_BAND = 45;

/** 某技能形态在当前距离/视线下是否值得放 */
function rivalCanUse(kind: SkillKind, d: number, los: boolean): boolean {
  switch (kind) {
    case 'cleave': return los && d < 130;
    case 'nova': return los && d < 150;
    case 'aura': return d < 170;
    case 'trap': return d < 110;
    case 'charge': return los && d > 70 && d < 260;
    case 'buff': return d < 420;
    case 'meteor': case 'meteors': return los && d < 460;
    default: return los && d < 420;
  }
}

/** 镜像对手的奥义：该职业技能树里第一个奥义 */
function rivalUlt(cid: string): string | null {
  const tr = TREES[cid];
  if (!tr) return null;
  for (const n of [...tr.A.nodes, ...tr.B.nodes]) if (n.ult && ULTS[n.ult]) return n.ult;
  return null;
}

function rivalCast(e: Enemy, p: Player, sk: SkillDef | UltDef, ultId: string | null): void {
  // castByKind 对敌方施法者按 aim/速度方向出招：先对准玩家
  faceTo(e, p.x, p.y);
  const d = Math.hypot(p.x - e.x, p.y - e.y) || 1;
  e.vx = ((p.x - e.x) / d) * e.spd;
  e.vy = ((p.y - e.y) / d) * e.spd;
  castByKind(e, sk, ultId);
}

export function aiRival(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const rv = e.rival;
  if (!rv) {
    aiShooter(e, x, p, t, dt);
    return;
  }
  rv.cdQ -= dt;
  rv.cdE -= dt;
  rv.cdR -= dt;
  x.t1 -= dt; // 普攻
  x.t2 -= dt; // 冲刺
  x.t3 -= dt; // 施法公共间隔
  x.subT -= dt; // 奥义
  const skills = SKILLS[rv.cid] ?? SKILLS.warrior;
  const a = x.act;
  if (a) {
    if (a.k === 'cast' || a.k === 'ult') {
      if (a.ph === 'wind') {
        a.t -= dt;
        faceTo(e, p.x, p.y);
        e.ai = 'windup';
        setAnim(e, 'cast');
        if (a.t <= 0) {
          if (a.k === 'ult') {
            const u = ULTS[a.s];
            if (u) rivalCast(e, p, u, a.s);
          } else {
            const sk = skills[a.n];
            if (sk) rivalCast(e, p, sk, null);
          }
          a.ph = 'rec';
          a.t = 0.25;
        }
      } else {
        a.t -= dt;
        e.ai = 'attack';
        if (a.t <= 0) x.act = null;
      }
      return;
    }
    if (a.k === 'shot') {
      if (a.ph === 'wind') {
        a.t -= dt;
        faceTo(e, p.x, p.y);
        e.ai = 'windup';
        setAnim(e, 'attack');
        if (a.t <= 0) {
          if (t.los) {
            fanVolley(e, Math.atan2(p.y - e.y, p.x - e.x), 3, 0.32, 264, e.atk * 0.55, { color: e.def.c });
            sfx(EL_SFX[e.def.el], e.x, e.y, 0.5);
          }
          x.t1 = 1.5;
          a.ph = 'rec';
          a.t = 0.15;
        }
      } else {
        a.t -= dt;
        if (a.t <= 0) x.act = null;
      }
      return;
    }
    if (a.k === 'dash') {
      if (a.ph === 'wind') {
        a.t -= dt;
        if (a.t <= 0) {
          a.ph = 'go';
          a.t = 0.24;
          emit({ t: 'afterimage', actorId: e.id });
          sfx('dash', e.x, e.y, 0.6);
        }
        return;
      }
      e.ai = 'charge';
      setAnim(e, 'run');
      setMove(x, a.dx, a.dy, 430);
      a.t -= dt;
      // 前扑冲刺（a.n=1）撞上玩家：legacy L1419 落点 50 内造成 atk×0.9
      if (a.n === 1 && !a.hit && Math.hypot(p.x - e.x, p.y - e.y) < e.r + p.r + 14) {
        a.hit = true;
        meleeStrike(e, p, 0.9, 8, 140);
      }
      if (a.t <= 0) x.act = null;
      return;
    }
    if (!tickCommon(e, x, p, a, dt, 1, 1.2)) x.act = null;
    return;
  }

  // 奥义：半血以下，长前摇 + 横幅提示
  if (t.known && e.hp < e.maxHp * 0.5 && x.subT <= 0 && x.t3 <= 0) {
    const uid = rivalUlt(rv.cid);
    const u = uid ? ULTS[uid] : undefined;
    if (uid && u && rivalCanUse(u.kind, t.d, t.los)) {
      x.act = newAct('ult', 0.7, { s: uid });
      telegraph(e, 0.7, '#f0bd7c', 30);
      emit({ t: 'cast', actorId: e.id, el: u.el });
      emit({ t: 'banner', text: `镜像奥义 · ${u.n}`, color: '#f0bd7c' });
      x.subT = 22;
      x.t3 = 1.2;
      return;
    }
  }
  // Q/E/R：按各自冷却，选当前距离合适的；施法公共间隔 0.9s 防止一口气连放
  if (t.known && x.t3 <= 0) {
    const cds = [rv.cdQ, rv.cdE, rv.cdR];
    for (const i of [2, 1, 0]) {
      const sk = skills[i];
      if (!sk || cds[i] > 0 || !rivalCanUse(sk.kind, t.d, t.los)) continue;
      x.act = newAct('cast', 0.35, { n: i });
      telegraph(e, 0.35, elemColor(sk.el), 18);
      emit({ t: 'cast', actorId: e.id, el: sk.el });
      const cd = sk.cd * 1.15 + rng.range(0, 1);
      if (i === 0) rv.cdQ = cd;
      else if (i === 1) rv.cdE = cd;
      else rv.cdR = cd;
      x.t3 = 0.9;
      return;
    }
  }
  // 三连发普攻（legacy：每 1.5s，±0.16rad，atk×0.55）
  if (t.known && t.los && x.t1 <= 0 && t.d < 380) {
    x.act = newAct('shot', 0.2);
    telegraph(e, 0.2, elemColor(e.def.el), 8);
    return;
  }
  // 偶尔冲刺：太近往后闪，太远往前扑，否则侧闪
  if (t.known && x.t2 <= 0 && t.d < 320) {
    const cur = Math.atan2(e.y - p.y, e.x - p.x);
    let ang: number;
    let lunge = 0;
    if (t.d < RIVAL_WANT - RIVAL_BAND) ang = cur + e.orbitDir * 0.5;
    else if (t.d > RIVAL_WANT + RIVAL_BAND + 30) {
      ang = cur + Math.PI;
      lunge = 1;
    } else ang = cur + (Math.PI / 2) * e.orbitDir;
    x.act = newAct('dash', 0.12, { dx: Math.cos(ang), dy: Math.sin(ang), n: lunge });
    telegraph(e, 0.12, elemColor(e.def.el), 8);
    x.t2 = rng.range(4.5, 7);
    return;
  }
  // 被贴脸时顺手肘击（其余时间保持距离）
  if (t.d <= e.r + p.r + CONTACT_GAP + 2 && tryMelee(e, x, p, t, 0.25)) return;
  const mode = kite(e, x, p, t, RIVAL_WANT, RIVAL_BAND, 1);
  e.ai = mode === 'strafe' ? 'strafe' : mode === 'retreat' ? 'retreat' : 'chase';
}
