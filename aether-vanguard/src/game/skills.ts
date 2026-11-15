// 普攻、冲刺、Q/E/R 技能、奥义。移植自 legacy L1121–1156（瞄准/冲刺/射击）、L1228–1348（basicAttack/cast*）。
// 修正：鼠标瞄准 + 软锁定（索敌过滤视线）；施法者通用（玩家与镜像对手共用，改版意见 #13）；
//       buff 按技能而不是职业分支；AoE 半径吃“范围 +%”；chain 选最近；beam 撞墙截断；冲刺插值 + 残影；
//       每种奥义独立表现（style）。
// 【契约】签名不可改；实现由 combat 代理完成。
//
// 其它修正：普攻走 rollDmg（能暴击），按武器类型分支（剑三段连击 / 匕首两段突刺 / 法杖元素法球 / 弓箭），
// 近战改为朝瞄准方向的扇形判定且不打墙后；冲刺 CD 1.1s；tech 路线冷却不重复乘；施法不再写存档；
// trap 真的减速并定身；charge 插值冲刺；连珠箭同一目标最多中 2 支；陨石落点不越墙。

import type { ElementId, SkillDef, UltDef } from '../data/types';
import type { Actor, Enemy, Player, ProjectileKind, SfxName, Team } from './types';
import { G, emit, toast } from './state';
import { clamp, distToSeg } from '../core/util';
import { rng } from '../core/rng';
import { raycastDist } from '../world/los';
import { isFree, moveCircle, nearestFree } from '../world/collision';
import { ELEM, ELEM_ORB, ELEM_SFX } from '../data/elements';
import {
  RIVAL_CRIT, RIVAL_SKILL_MUL, SKILL_FX, ULTS, ULT_FX,
  type BuffKind, type SkillFx, type UltFx, type ZoneSpec,
} from '../data/skills';
import { clsOf } from '../data/classes';
import { skillsOf } from './player';
import {
  addShield, applySlow, applyStatus, damageEnemy, damagePlayer, isStunned, knockback, markDash, nextAtkId,
  resetCombat, rivalBuff, rollDmg, type HitOpts,
} from './combat';
import { newVolley, resetProjectiles, spawnProjectile, tagProjectile } from './projectiles';
import { setHazardMeta, spawnHazard, type HazardInit, type HazardMeta } from './hazards';
import { advanceMotion, inMotion, resetMotions, startMotion, type MotionSeg } from './motion';
import { angDiff, clearLine, hittable, hostilesOf, isEnemyActor, isPlayerActor, nearestHostile } from './combatUtil';
import { ext } from './enemyState';

export type Caster = Player | Enemy;

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

export const DASH_DIST = 96;
export const DASH_DUR = 0.16;
export const DASH_CD = 1.1;
const DASH_INVULN = 0.2;
const ORB_SPEED = 420;
const ARROW_SPEED = 560;
const SHURIKEN_SPEED = 520;
const SHOT_LIFE = 1.7;
/** 落点类技能的最远施放距离 */
const CAST_RANGE = 420;

/** 连击段（剑 3 段 / 匕首 2 段） */
const combo = { step: 0 };
/** 元素法师普攻火冰交替（下一发是否为火） */
let elemageFire = true;

/** 新游戏 / 测试：清空 combat 代理所有模块内状态 */
export function resetCombatState(): void {
  resetCombat();
  resetMotions();
  resetProjectiles();
  combo.step = 0;
  elemageFire = true;
}

/** 实体是否处于技能位移中（冲刺/冲锋/闪烁）：怪物 AI 可据此跳过自身移动 */
export { inMotion } from './motion';

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function sfx(name: SfxName, x?: number, y?: number): void {
  emit({ t: 'sfx', name, x, y });
}

function face(c: Actor, a: number): void {
  const cx = Math.cos(a);
  if (Math.abs(cx) > 0.15) c.facing = cx < 0 ? -1 : 1;
}

function isMelee(p: Player): boolean {
  return p.stat.weapon === 'sword' || p.stat.weapon === 'dagger';
}

/** 软锁定距离 */
function softLockRange(p: Player): number {
  return p.stat.range + (isMelee(p) ? 80 : 110);
}

/**
 * 自动攻击的触发距离（sim 用：近战只在真正打得到时出手，修 legacy range+70 > 命中半径）。
 * autoTarget 判 d − t.r ≤ reach，近战扇形判 d ≤ range + t.r，两者必须相等；多给的余量会在打不到的距离空挥，
 * 白白吃一次攻击冷却（触屏默认开自动攻击，近战职业每次接敌第一刀都落空）。
 */
export function attackReach(p: Player): number {
  return p.stat.range + (isMelee(p) ? 0 : 70);
}

/** 玩家能否出手 */
function canAct(p: Player): boolean {
  return G.mode === 'play' && !G.paused && !G.panel && !p.dead && p.hp > 0 && !isStunned(p);
}

/** 投射物寿命：按射程给足飞行距离 */
function rangeLife(range: number, speed: number): number {
  return Math.max(0.8, (Math.max(60, range) * 1.6) / speed);
}

/** 枪口位置：施法者前方 off 处；贴墙时退回施法者中心（避免出生在墙里直接爆掉） */
function muzzle(c: Actor, a: number, off: number): { x: number; y: number } {
  const x = c.x + Math.cos(a) * off, y = c.y + Math.sin(a) * off;
  if (G.map && G.map.opaqueAtWorld(x, y)) return { x: c.x, y: c.y };
  return { x, y };
}

/** 散布落点：落进墙里时退回中心点（墙内爆炸视线全被挡，等于打空） */
function groundPoint(x: number, y: number, fallback: { x: number; y: number }): { x: number; y: number } {
  if (G.map && G.map.opaqueAtWorld(x, y)) return fallback;
  return { x, y };
}

/** 对目标结算（按阵营路由到 damageEnemy / damagePlayer） */
function strike(sourceId: number, t: Actor, dmg: number, opts: HitOpts): number {
  const o: HitOpts = { ...opts, sourceId };
  if (isEnemyActor(t)) return damageEnemy(t, dmg, o);
  if (isPlayerActor(t)) return damagePlayer(t, dmg, o);
  return 0;
}

/**
 * 敌方施法者（镜像对手）获得护盾。与 enemyAi.raiseShield 同一契约：必须同时写 ext(e).shieldT，
 * 否则 enemies.tickShieldTimer 会把“没有时长”的护盾当作到期，下一步就清零（铁壁/寒冰护盾形同虚设）。
 */
function enemyShield(e: Enemy, add: number, cap: number, dur: number): void {
  e.shield = Math.min(cap, e.shield + Math.max(0, add));
  const x = ext(e);
  x.shieldT = Math.max(x.shieldT, dur);
  x.lastShield = e.shield;
}

/** 命中后追加控制（敌人护盾未破时不生效，与 damageEnemy 规则一致） */
function ccAfterHit(t: Actor, s: 'stun' | 'freeze', dur: number): void {
  if (t.dead || (isEnemyActor(t) && t.shield > 0)) return;
  applyStatus(t, s, dur);
}

/** 扇形近战判定：半径 R + 目标半径，半角 half（贴身的目标无视角度），不打墙后 */
function meleeHits(c: Actor, team: Team, a: number, R: number, half: number, fn: (t: Actor) => void): number {
  let n = 0;
  for (const t of hostilesOf(team)) {
    const dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy);
    if (d > R + t.r) continue;
    if (d > c.r + t.r + 2) {
      const tol = half + Math.atan2(t.r, Math.max(1, d));
      if (angDiff(Math.atan2(dy, dx), a) > tol) continue;
    }
    if (!clearLine(c.x, c.y, t.x, t.y)) continue;
    fn(t);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 瞄准                                                                 */
/* ------------------------------------------------------------------ */

/** 玩家当前瞄准角：有鼠标瞄准用鼠标；否则软锁定最近可见敌人；再否则移动方向/朝向 */
export function aimAngle(p: Player): number {
  const inp = G.input;
  if (inp.hasAim) {
    const dx = inp.aimX - p.x, dy = inp.aimY - p.y;
    if (dx * dx + dy * dy > 1) return Math.atan2(dy, dx);
  }
  const t = autoTarget(p.x, p.y, softLockRange(p), 'player');
  if (t) return Math.atan2(t.y - p.y, t.x - p.x);
  if (inp.mx || inp.my) return Math.atan2(inp.my, inp.mx);
  // 上次瞄准角与朝向一致时沿用（保留上下方向），否则按左右朝向
  if (Number.isFinite(p.aim) && Math.cos(p.aim) * p.facing >= 0) return p.aim;
  return p.facing > 0 ? 0 : Math.PI;
}

/** 在 range 内找最近的、视线可达的敌对目标（team = 施法者阵营） */
export function autoTarget(x: number, y: number, range: number, team: 'player' | 'enemy'): Actor | null {
  const fog = team === 'player' ? G.map : null;
  let best: Actor | null = null;
  let bd = Infinity;
  for (const t of hostilesOf(team)) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d - t.r > range || d >= bd) continue;
    // 玩家方只锁定迷雾中当前可见格内的目标
    if (fog && !fog.isVisibleWorld(t.x, t.y)) continue;
    if (!clearLine(x, y, t.x, t.y)) continue;
    best = t;
    bd = d;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 普攻                                                                 */
/* ------------------------------------------------------------------ */

/** 普攻（按武器类型：sword 扇形劈砍 / dagger 快速突刺 / staff 元素法球 / bow 箭矢） */
export function basicAttack(p: Player): void {
  if (!canAct(p) || p.cd.atk > 0) return;
  const st = p.stat;
  const atkCd = st.atkCd > 0 ? st.atkCd : 0.5;
  p.cd.atk = Math.max(0.08, atkCd * (1 - clamp(st.cdr, 0, 0.6) * 0.4));
  const a = aimAngle(p);
  // 连击窗口：距上次出手太久则从第一段开始
  if (p.actT > Math.max(0.8, atkCd * 2.2)) combo.step = 0;
  p.aim = a;
  face(p, a);
  p.anim = 'attack';
  p.animT = 0;
  p.actT = 0;
  const el = basicElement(p);
  const base: HitOpts = {
    el,
    status: st.poison > 0 ? 'poison' : undefined,
    slow: st.slow > 0 ? clamp(0.2 + st.slow * 0.4, 0, 0.6) : undefined,
    basic: true,
    atkId: nextAtkId(),
    srcX: p.x,
    srcY: p.y,
  };
  switch (st.weapon) {
    case 'sword': swordSwing(p, a, el, base); break;
    case 'dagger': daggerThrust(p, a, el, base); break;
    case 'staff': staffOrb(p, a, el, base); break;
    case 'bow': bowShot(p, a, el, base); break;
  }
}

/** 普攻元素：元素法师火/冰交替，其余为职业元素 */
function basicElement(p: Player): ElementId {
  if (p.cid !== 'elemage') return p.stat.element;
  const el: ElementId = elemageFire ? 'fire' : 'ice';
  elemageFire = !elemageFire;
  return el;
}

/** 剑：三段连击（左挥 / 右挥 / 重劈 ×1.3 + 大击退），扇形半角 1.0 */
function swordSwing(p: Player, a: number, el: ElementId, base: HitOpts): void {
  const step = combo.step % 3;
  combo.step = (step + 1) % 3;
  const heavy = step === 2;
  const { dmg, crit } = rollDmg(p, heavy ? 1.3 : 1, false);
  const R = p.stat.range;
  meleeHits(p, 'player', a, R, 1.0, t => strike(p.id, t, dmg, { ...base, crit, knock: heavy ? 260 : 140 }));
  // 刀光：前两段角度交替偏置（左右挥），第三段正中重劈
  const off = heavy ? 0 : step === 0 ? -0.22 : 0.22;
  emit({ t: 'slash', x: p.x, y: p.y, a: a + off, r: R + 8, color: ELEM[el].c, style: heavy ? 'heavy' : 'sword' });
  sfx(heavy ? 'swingHeavy' : 'swing', p.x, p.y);
  if (heavy) emit({ t: 'shake', amt: 2 });
}

/** 匕首：两段快速突刺（半角 0.6）；忍者第二段改为手里剑（设计文档 S8） */
function daggerThrust(p: Player, a: number, el: ElementId, base: HitOpts): void {
  const step = combo.step % 2;
  combo.step = (step + 1) % 2;
  const { dmg, crit } = rollDmg(p, 1, false);
  if (p.cid === 'ninja' && step === 1) {
    const m = muzzle(p, a, 12);
    const q = spawnProjectile({
      kind: 'shuriken', team: 'player', x: m.x, y: m.y,
      vx: Math.cos(a) * SHURIKEN_SPEED, vy: Math.sin(a) * SHURIKEN_SPEED, dmg, el, ownerId: p.id, r: 4,
      life: rangeLife(p.stat.range, SHURIKEN_SPEED), pierce: p.stat.pierce + 1, crit, knock: 50,
      color: ELEM[el].c, status: base.status,
    });
    tagProjectile(q, { basic: true, atkId: base.atkId, slow: base.slow });
    sfx('stab', p.x, p.y);
    return;
  }
  const R = p.stat.range;
  meleeHits(p, 'player', a, R, 0.6, t => strike(p.id, t, dmg, { ...base, crit, knock: 90 }));
  emit({ t: 'slash', x: p.x, y: p.y, a: a + (step === 0 ? -0.1 : 0.1), r: R + 4, color: ELEM[el].c, style: 'dagger' });
  sfx('stab', p.x, p.y);
}

/** 法杖：按元素发射法球（弱追踪 + 小溅射） */
function staffOrb(p: Player, a: number, el: ElementId, base: HitOpts): void {
  const { dmg, crit } = rollDmg(p, 1, false);
  const m = muzzle(p, a, 14);
  const q = spawnProjectile({
    kind: ELEM_ORB[el], team: 'player', x: m.x, y: m.y,
    vx: Math.cos(a) * ORB_SPEED, vy: Math.sin(a) * ORB_SPEED, dmg, el, ownerId: p.id, r: 5,
    life: rangeLife(p.stat.range, ORB_SPEED), pierce: p.stat.pierce, homing: 2.4, splash: 35, crit, knock: 50,
    color: ELEM[el].c, status: base.status,
  });
  tagProjectile(q, { basic: true, atkId: base.atkId, slow: base.slow });
  // 法杖挥动的小幅杖光（渲染层 slash style 'staff'）
  emit({ t: 'slash', x: p.x, y: p.y, a, r: 18, color: ELEM[el].c, style: 'staff' });
  sfx(ELEM_SFX[el], p.x, p.y);
}

/** 弓：箭矢（不追踪，穿透 stat.pierce） */
function bowShot(p: Player, a: number, el: ElementId, base: HitOpts): void {
  const { dmg, crit } = rollDmg(p, 1, false);
  const m = muzzle(p, a, 12);
  const q = spawnProjectile({
    kind: 'arrow', team: 'player', x: m.x, y: m.y,
    vx: Math.cos(a) * ARROW_SPEED, vy: Math.sin(a) * ARROW_SPEED, dmg, el, ownerId: p.id, r: 3,
    life: rangeLife(p.stat.range, ARROW_SPEED), pierce: p.stat.pierce, homing: 0, splash: 0, crit, knock: 60,
    color: ELEM[el].c, status: base.status,
  });
  tagProjectile(q, { basic: true, atkId: base.atkId, slow: base.slow });
  sfx('bow', p.x, p.y);
}

/* ------------------------------------------------------------------ */
/* 冲刺                                                                 */
/* ------------------------------------------------------------------ */

/** 冲刺（沿移动方向插值位移，带无敌帧与残影） */
export function dash(p: Player): boolean {
  if (!canAct(p) || p.cd.dash > 0) return false;
  p.cd.dash = DASH_CD * (1 - clamp(p.stat.cdr, 0, 0.6) * 0.4);
  const inp = G.input;
  const a = inp.mx || inp.my ? Math.atan2(inp.my, inp.mx) : aimAngle(p);
  startMotion(p, {
    segs: [{ dir: { x: Math.cos(a), y: Math.sin(a) }, dur: DASH_DUR, speed: DASH_DIST / DASH_DUR }],
    afterimages: 3,
  });
  p.invuln = Math.max(p.invuln, DASH_INVULN);
  face(p, a);
  markDash(p);
  sfx('dash', p.x, p.y);
  return true;
}

/**
 * 推进冲刺插值（每步调用；sim 只在 p.dashT>0 时调用也可以：所有位移脚本进行中 dashT 都 >0）。
 * 位移脚本包括冲刺、突进/匕首突袭、雷霆冲锋、暗影绝杀的连续闪烁。
 */
export function tickDash(p: Player, dt: number): void {
  if (inMotion(p.id)) {
    advanceMotion(p, dt);
    return;
  }
  // 兼容：外部直接写了 dashT/dashVx/dashVy（无位移脚本）时按速度推进
  if (p.dashT > 0) {
    const step = Math.min(dt, p.dashT);
    const dx = p.dashVx * step, dy = p.dashVy * step;
    if (G.map) moveCircle(G.map, p, dx, dy);
    else { p.x += dx; p.y += dy; }
    p.dashT = Math.max(0, p.dashT - dt);
    if (p.dashT <= 0) {
      p.dashVx = 0;
      p.dashVy = 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 技能施放入口                                                           */
/* ------------------------------------------------------------------ */

/** 施放第 idx 个技能（0=Q,1=E,2=R），检查冷却与源能 */
export function castSkill(p: Player, idx: 0 | 1 | 2): boolean {
  if (!canAct(p)) return false;
  const sk = skillsOf(p)[idx];
  if (!sk) return false;
  const key = (['q', 'e', 'r'] as const)[idx];
  if (p.cd[key] > 0) return false;
  if (p.mp < sk.cost) {
    toast('源能不足', '#df8f7a');
    sfx('uiDeny');
    return false;
  }
  p.mp -= sk.cost;
  p.cd[key] = skillCooldown(p, sk.cd);
  castByKind(p, sk, null);
  return true;
}

/** 施放当前奥义（右键） */
export function castUlt(p: Player): boolean {
  if (!canAct(p)) return false;
  const u = p.ult ? ULTS[p.ult] : undefined;
  if (!p.ult || !u) {
    toast('尚未解锁奥义 · 在技能树 / 技能路线点亮终极节点', '#f0bd7c');
    sfx('uiDeny');
    return false;
  }
  if (p.cd.ult > 0) return false;
  if (p.mp < u.cost) {
    toast(`源能不足 · 需要 ${u.cost} 点`, '#df8f7a');
    sfx('uiDeny');
    return false;
  }
  p.mp -= u.cost;
  p.cd.ult = skillCooldown(p, u.cd);
  emit({ t: 'flash', amt: 0.3, color: ELEM[u.el].c });
  emit({ t: 'shake', amt: 9 });
  castByKind(p, u, p.ult);
  toast(`✦ 奥义 · ${u.n}`, '#f0bd7c');
  return true;
}

/** 技能实际冷却（cd × (1-cdr)，tech 路线不重复减：cdMul 已由 recalc 折进 cdr） */
export function skillCooldown(p: Player, baseCd: number): number {
  return Math.max(0, baseCd) * (1 - clamp(p.stat.cdr, 0, 0.6));
}

/* ------------------------------------------------------------------ */
/* 通用施法                                                              */
/* ------------------------------------------------------------------ */

/** 施法上下文：把玩家与镜像对手统一成同一组参数 */
interface Ctx {
  c: Caster;
  team: Team;
  /** 施法者若是玩家 */
  p: Player | null;
  sk: SkillDef | UltDef;
  el: ElementId;
  color: string;
  /** 施法角与瞄准点 */
  a: number;
  ax: number;
  ay: number;
  /** AoE 半径倍率（1 + 范围天赋） */
  aoe: number;
  range: number;
  pierce: number;
  chain: number;
  shieldMul: number;
  elemDur: number;
  stealth: number;
  fx: SkillFx;
}

function makeCtx(c: Caster, sk: SkillDef | UltDef, ultId: string | null): Ctx {
  const p = isPlayerActor(c) ? c : null;
  const e = isEnemyActor(c) ? c : null;
  const cls = e?.rival ? clsOf(e.rival.cid) : null;
  let a: number, ax: number, ay: number;
  if (p) {
    a = aimAngle(p);
    const inp = G.input;
    const t = inp.hasAim ? null : autoTarget(p.x, p.y, softLockRange(p), 'player');
    if (inp.hasAim) { ax = inp.aimX; ay = inp.aimY; }
    else if (t) { ax = t.x; ay = t.y; }
    else { ax = p.x + Math.cos(a) * 160; ay = p.y + Math.sin(a) * 160; }
  } else {
    const tp = G.player;
    ax = tp ? tp.x : c.x + c.facing * 100;
    ay = tp ? tp.y : c.y;
    a = Math.atan2(ay - c.y, ax - c.x);
  }
  const el = sk.el;
  return {
    c,
    team: c.team,
    p,
    sk,
    el,
    color: ELEM[el]?.c ?? '#f0bd7c',
    a, ax, ay,
    aoe: p ? 1 + Math.max(0, p.stat.eff.range ?? 0) : 1,
    range: p ? p.stat.range : (cls?.range ?? e?.def.range ?? 200),
    pierce: p ? p.stat.pierce : (e?.rival?.route === 'tech' ? 1 : 0),
    chain: p ? p.stat.chain : 2,
    shieldMul: p ? p.stat.shield : 1,
    elemDur: p ? Math.max(0.2, p.stat.elemDur) : 1,
    stealth: p ? p.stat.stealth : 0,
    fx: ultId ? {} : (SKILL_FX[sk.n] ?? {}),
  };
}

/** 施法伤害掷骰（玩家走 rollDmg；镜像对手按 e.atk × mult × 系数，有自己的过载/潜行） */
function roll(ctx: Ctx, mult: number, critBonus = 0): { dmg: number; crit: boolean } {
  if (ctx.p) {
    const r = rollDmg(ctx.p, mult, true);
    if (!r.crit && critBonus > 0 && rng.next() < critBonus) return { dmg: r.dmg * 2, crit: true };
    return r;
  }
  const e = ctx.c;
  if (!isEnemyActor(e)) return { dmg: 0, crit: false };
  const b = rivalBuff(e);
  let crit = rng.next() < RIVAL_CRIT + critBonus;
  if (b.stealth > 0) {
    crit = true;
    b.stealth = 0;
  }
  const dmg = e.atk * mult * RIVAL_SKILL_MUL * (crit ? 2 : 1) * (b.overload > 0 ? 1.45 : 1);
  return { dmg, crit };
}

/** 落点：瞄准点限制在 maxR 内，且不越过墙（沿施法线截到墙前） */
function targetPoint(ctx: Ctx, maxR: number): { x: number; y: number } {
  const { c } = ctx;
  const dx = ctx.ax - c.x, dy = ctx.ay - c.y;
  let d = Math.min(maxR, Math.hypot(dx, dy));
  const a = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : ctx.a;
  if (G.map) d = Math.min(d, Math.max(0, raycastDist(G.map, c.x, c.y, a, d) - 6));
  return { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
}

/** 冲锋方向：玩家有移动输入时沿移动方向（R24），否则朝瞄准方向；镜像对手朝玩家 */
function chargeAngle(ctx: Ctx): number {
  const inp = G.input;
  if (ctx.p && (inp.mx || inp.my)) return Math.atan2(inp.my, inp.mx);
  return ctx.a;
}

/** 通用施法：caster 可以是玩家或镜像对手；ultId 非空表示奥义（决定独立表现） */
export function castByKind(caster: Caster, sk: SkillDef | UltDef, ultId: string | null): void {
  if (caster.dead) return;
  const ctx = makeCtx(caster, sk, ultId);
  caster.aim = ctx.a;
  face(caster, ctx.a);
  caster.anim = 'cast';
  caster.animT = 0;
  if (ctx.p) ctx.p.actT = 0;
  emit({ t: 'cast', actorId: caster.id, el: ctx.el });
  const ufx = ultId ? ULT_FX[ultId] : undefined;
  if (ufx && castUltStyle(ctx, ufx)) return;
  const mult = sk.mult;
  switch (sk.kind) {
    case 'cleave': doCleave(ctx, mult); break;
    case 'charge': doCharge(ctx, mult, 160, 0.2); break;
    case 'buff': doBuff(ctx); break;
    case 'shot': doShot(ctx, mult); break;
    case 'beam': doBeam(ctx, mult, 760, 26); break;
    case 'multi': doMulti(ctx, mult); break;
    case 'meteor': doMeteor(ctx, mult, 1); break;
    case 'meteors': doMeteor(ctx, mult, 4); break;
    case 'nova': doNova(ctx, mult, 160); break;
    case 'chain': doChain(ctx, mult); break;
    case 'trap': doTrap(ctx, mult); break;
    case 'aura': doAura(ctx, mult); break;
  }
}

/* ------------------------------------------------------------------ */
/* 12 种 kind                                                           */
/* ------------------------------------------------------------------ */

/** cleave：前方扇形重劈（legacy 判定是 360° 圆、特效却是弧），击退 + 短眩晕 */
function doCleave(ctx: Ctx, mult: number): void {
  const { c } = ctx;
  const R = ctx.range + 70 * ctx.aoe;
  const { dmg, crit } = roll(ctx, mult, ctx.fx.critBonus);
  meleeHits(c, ctx.team, ctx.a, R, 1.25, t =>
    strike(c.id, t, dmg, { el: ctx.el, crit, knock: 330, stun: 0.3, isSkill: true, srcX: c.x, srcY: c.y }));
  emit({ t: 'slash', x: c.x, y: c.y, a: ctx.a, r: R, color: ctx.color, style: 'heavy' });
  emit({ t: 'burst', x: c.x + Math.cos(ctx.a) * 40, y: c.y + Math.sin(ctx.a) * 40, color: ctx.color, n: 22, spd: 150 });
  emit({ t: 'shake', amt: 5 });
  sfx('swingHeavy', c.x, c.y);
}

/** charge：插值冲撞（legacy 同帧瞬移 160px），沿途命中眩晕 + 击退 */
function doCharge(ctx: Ctx, mult: number, distance: number, dur: number): void {
  const { c } = ctx;
  const a = chargeAngle(ctx);
  const { dmg, crit } = roll(ctx, mult, ctx.fx.critBonus);
  const sx = c.x, sy = c.y;
  startMotion(c, {
    segs: [{ dir: { x: Math.cos(a), y: Math.sin(a) }, dur, speed: distance / dur }],
    sweep: {
      r: 28, team: ctx.team,
      fn: t => strike(c.id, t, dmg, { el: ctx.el, crit, stun: 1, knock: 240, isSkill: true, srcX: c.x, srcY: c.y }),
    },
    afterimages: 3,
    onEnd: () => {
      emit({ t: 'line', x0: sx, y0: sy, x1: c.x, y1: c.y, color: ctx.color, w: 6 });
      emit({ t: 'burst', x: c.x, y: c.y, color: ctx.color, n: 24, spd: 130 });
      emit({ t: 'shake', amt: 6 });
    },
  });
  if (ctx.p) ctx.p.invuln = Math.max(ctx.p.invuln, dur + 0.15);
  face(c, a);
  sfx('dash', c.x, c.y);
}

function buffKindOf(ctx: Ctx): BuffKind {
  if (ctx.fx.buff) return ctx.fx.buff;
  switch (ctx.el) {
    case 'lightning': return 'overload';
    case 'poison': return 'stealth';
    case 'ice': return 'iceShield';
    default: return 'ironwall';
  }
}

/** buff：按技能分支（铁壁 = 护盾+减伤；寒冰护盾 = 护盾+寒气；过载 = 8s；潜行 = 6+st.stealth） */
function doBuff(ctx: Ctx): void {
  const { c } = ctx;
  const kind = buffKindOf(ctx);
  if (ctx.p) {
    const p = ctx.p;
    switch (kind) {
      case 'ironwall':
        addShield(p, p.stat.maxHp * 0.4 * ctx.shieldMul, 6);
        p.buffs.roar = Math.max(p.buffs.roar, 6);
        toast('铁壁 · 护盾展开，减伤 6 秒', '#f0bd7c');
        sfx('shield', c.x, c.y);
        break;
      case 'iceShield': {
        addShield(p, p.stat.maxHp * 0.4 * ctx.shieldMul, 8);
        // 寒气外放：身边敌人迟缓
        for (const t of hostilesOf(ctx.team)) {
          if (Math.hypot(t.x - c.x, t.y - c.y) <= 110 + t.r && !(isEnemyActor(t) && t.shield > 0)) applySlow(t, 2, 0.4);
        }
        toast('寒冰护盾 · 吸收伤害', '#8fd8f0');
        sfx('shield', c.x, c.y);
        break;
      }
      case 'overload':
        p.buffs.overload = Math.max(p.buffs.overload, 8);
        toast('过载 · 技能伤害 +45%', '#f6d76e');
        sfx('zap', c.x, c.y);
        break;
      case 'stealth':
        p.buffs.stealth = Math.max(p.buffs.stealth, 6 + ctx.stealth);
        toast('潜行 · 下一击必定暴击', '#c9a2f0');
        sfx('stealth', c.x, c.y);
        break;
    }
  } else if (isEnemyActor(c)) {
    switch (kind) {
      case 'ironwall':
      case 'iceShield':
        // 时长与玩家同名技能一致：铁壁 6s、寒冰护盾 8s
        enemyShield(c, c.maxHp * 0.2, c.maxHp * 0.5, kind === 'iceShield' ? 8 : 6);
        sfx('shield', c.x, c.y);
        break;
      case 'overload':
        rivalBuff(c).overload = 8;
        sfx('zap', c.x, c.y);
        break;
      case 'stealth':
        rivalBuff(c).stealth = 6;
        sfx('stealth', c.x, c.y);
        break;
    }
  }
  emit({ t: 'ring', x: c.x, y: c.y, r0: 8, r1: 110, color: ctx.color, dur: 0.5 });
}

/** shot：追踪弹（精准射击 = 高速箭 + 额外暴击；火球 = 大溅射；冰箭 = 冰晶） */
function doShot(ctx: Ctx, mult: number): void {
  const { c, fx } = ctx;
  const kind: ProjectileKind = fx.proj ?? ELEM_ORB[ctx.el];
  const speed = fx.speed ?? ORB_SPEED;
  const homing = (fx.homing ?? 2.4) * (ctx.team === 'enemy' ? 0.5 : 1);
  const { dmg, crit } = roll(ctx, mult, fx.critBonus);
  const a = ctx.a;
  const m = muzzle(c, a, 14);
  const q = spawnProjectile({
    kind, team: ctx.team, x: m.x, y: m.y,
    vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, dmg, el: ctx.el, ownerId: c.id,
    r: kind === 'arrow' ? 3.5 : 6, life: SHOT_LIFE, pierce: ctx.pierce, homing, splash: fx.splash ?? 35,
    crit, knock: 80, color: ctx.color,
  });
  tagProjectile(q, { isSkill: true });
  sfx(kind === 'arrow' ? 'bow' : ELEM_SFX[ctx.el], c.x, c.y);
}

/** beam：瞬间直线判定，raycastDist 撞墙截断（legacy 760px 穿墙） */
function doBeam(ctx: Ctx, mult: number, len: number, w: number, extra?: { knock?: number; stun?: number }): { x1: number; y1: number } {
  const { c } = ctx;
  const a = ctx.a;
  const L = G.map ? raycastDist(G.map, c.x, c.y, a, len) : len;
  const x1 = c.x + Math.cos(a) * L, y1 = c.y + Math.sin(a) * L;
  const { dmg, crit } = roll(ctx, mult, ctx.fx.critBonus);
  for (const t of hostilesOf(ctx.team)) {
    if (distToSeg(t.x, t.y, c.x, c.y, x1, y1) > w * 0.85 + t.r) continue;
    strike(c.id, t, dmg, {
      el: ctx.el, crit, stun: extra?.stun ?? 0.6, knock: extra?.knock ?? 150, isSkill: true, srcX: c.x, srcY: c.y,
    });
  }
  emit({ t: 'beam', x0: c.x, y0: c.y, x1, y1, w, el: ctx.el, color: ctx.color });
  emit({ t: 'shake', amt: 4 });
  sfx(ctx.el === 'physical' ? 'bow' : ELEM_SFX[ctx.el], c.x, c.y);
  return { x1, y1 };
}

/** multi：扇形 7 支穿透箭（不追踪），同一齐射对同一目标最多命中 2 支 */
function doMulti(ctx: Ctx, mult: number): void {
  const { c, fx } = ctx;
  const { dmg, crit } = roll(ctx, mult, fx.critBonus);
  const speed = fx.speed ?? 480;
  const volley = newVolley();
  for (let j = 0; j < 7; j++) {
    const a = ctx.a + (j - 3) * 0.13;
    const m = muzzle(c, a, 12);
    const q = spawnProjectile({
      kind: fx.proj ?? 'arrow', team: ctx.team, x: m.x, y: m.y,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, dmg: dmg * 0.75, el: ctx.el, ownerId: c.id,
      r: 3, life: 1.4, pierce: ctx.pierce + 1, homing: 0, splash: 0, crit, knock: 60, color: ctx.color,
    });
    tagProjectile(q, { isSkill: true, volley });
  }
  sfx('bow', c.x, c.y);
}

/** 落地后持续区域的 HazardInit */
function zoneInit(ctx: Ctx, z: ZoneSpec, x: number, y: number, dmg: number): HazardInit {
  return {
    kind: 'zone', team: ctx.team, x, y, r: z.r * ctx.aoe, dmg: dmg * z.mul, el: ctx.el, style: z.style,
    ownerId: ctx.c.id, life: z.life, tick: z.tick, slow: z.slow,
  };
}

/** meteor / meteors：延迟落地（预警圈），落点 = 瞄准点（不越墙）；火焰风暴落地留下火海 */
function doMeteor(ctx: Ctx, mult: number, n: number): void {
  const { c, fx } = ctx;
  const pt = targetPoint(ctx, CAST_RANGE);
  const { dmg, crit } = roll(ctx, mult, fx.critBonus);
  const per = n > 1 ? dmg / 1.6 : dmg;
  const jit = n > 1 ? 50 : 18;
  for (let j = 0; j < n; j++) {
    const g = groundPoint(pt.x + rng.range(-jit, jit), pt.y + rng.range(-jit, jit), pt);
    const h = spawnHazard({
      kind: 'meteor', team: ctx.team, x: g.x, y: g.y,
      r: 88 * ctx.aoe, dmg: per, el: ctx.el, style: fx.style ?? 'meteor', ownerId: c.id,
      delay: 0.8 + j * 0.12, life: 0.35, stun: 0.5,
    });
    const meta: HazardMeta = { crit };
    if (fx.zone) meta.after = zoneInit(ctx, fx.zone, h.x, h.y, dmg);
    setHazardMeta(h, meta);
  }
  sfx(ELEM_SFX[ctx.el], c.x, c.y);
}

/** nova：以自身为中心的环形冲击；冰系冻结（不击退），其余击退 */
function doNova(ctx: Ctx, mult: number, baseR: number): void {
  const { c } = ctx;
  const R = baseR * ctx.aoe;
  const { dmg, crit } = roll(ctx, mult, ctx.fx.critBonus);
  const ice = ctx.el === 'ice';
  for (const t of hostilesOf(ctx.team)) {
    if (Math.hypot(t.x - c.x, t.y - c.y) > R + t.r || !clearLine(c.x, c.y, t.x, t.y)) continue;
    strike(c.id, t, dmg, { el: ctx.el, crit, knock: ice ? 0 : 200, isSkill: true, srcX: c.x, srcY: c.y });
    if (ice) ccAfterHit(t, 'freeze', 1.1 * ctx.elemDur);
  }
  emit({ t: 'ring', x: c.x, y: c.y, r0: 8, r1: R, color: ctx.color, dur: 0.45 });
  emit({ t: 'explosion', x: c.x, y: c.y, r: R, el: ctx.el });
  emit({ t: 'burst', x: c.x, y: c.y, color: ctx.color, n: 30, spd: 170 });
  emit({ t: 'shake', amt: 6 });
  sfx(ELEM_SFX[ctx.el], c.x, c.y);
}

/** chain 首个目标：鼠标瞄准时取瞄准方向 ±0.6rad 内最近的可见目标，否则软锁定最近 */
function chainFirst(ctx: Ctx, range: number): Actor | null {
  const { c } = ctx;
  if (ctx.p && G.input.hasAim) {
    let best: Actor | null = null;
    let bs = Infinity;
    for (const t of hostilesOf(ctx.team)) {
      const d = Math.hypot(t.x - c.x, t.y - c.y);
      if (d - t.r > range) continue;
      const da = angDiff(Math.atan2(t.y - c.y, t.x - c.x), ctx.a);
      if (da > 0.6 + Math.atan2(t.r, Math.max(1, d))) continue;
      if (G.map && !G.map.isVisibleWorld(t.x, t.y)) continue;
      const score = d + da * 160;
      if (score >= bs || !clearLine(c.x, c.y, t.x, t.y)) continue;
      best = t;
      bs = score;
    }
    if (best) return best;
  }
  return autoTarget(c.x, c.y, range, ctx.team);
}

/** chain：连锁闪电，每跳选离当前目标最近的（legacy 取数组第一个），伤害每跳 ×0.8 */
function doChain(ctx: Ctx, mult: number): void {
  const { c } = ctx;
  const pts: Array<[number, number]> = [[c.x, c.y]];
  const first = chainFirst(ctx, 360);
  if (!first) {
    // 空放：电弧打到瞄准方向的墙或 200 距离处
    const L = G.map ? raycastDist(G.map, c.x, c.y, ctx.a, 200) : 200;
    pts.push([c.x + Math.cos(ctx.a) * L, c.y + Math.sin(ctx.a) * L]);
    emit({ t: 'chain', pts, color: ctx.color });
    sfx('zap', c.x, c.y);
    return;
  }
  const r = roll(ctx, mult, ctx.fx.critBonus);
  let dmg = r.dmg;
  const used = new Set<number>();
  let cur: Actor | null = first;
  const hops = Math.max(1, Math.floor(ctx.chain));
  for (let j = 0; j < hops && cur; j++) {
    used.add(cur.id);
    pts.push([cur.x, cur.y]);
    strike(c.id, cur, dmg, { el: ctx.el, crit: r.crit, stun: 0.2, isSkill: true, proc: j > 0, srcX: c.x, srcY: c.y });
    cur = nearestHostile(ctx.team, cur.x, cur.y, 190, used);
    dmg *= 0.8;
  }
  emit({ t: 'chain', pts, color: ctx.color });
  sfx('zap', c.x, c.y);
}

/** trap：脚下布置，0.4s 后武装，踏入即对范围内定身 + 迟缓；每个施法者最多 3 个 */
function doTrap(ctx: Ctx, mult: number): void {
  const { c } = ctx;
  const { dmg, crit } = roll(ctx, mult, ctx.fx.critBonus);
  const mine = G.hazards.filter(h => h.kind === 'trap' && h.ownerId === c.id && h.life > 0);
  while (mine.length >= 3) {
    const old = mine.shift();
    if (old) old.life = 0;
  }
  const R = 72 * ctx.aoe;
  const h = spawnHazard({
    kind: 'trap', team: ctx.team, x: c.x, y: c.y, r: R, dmg, el: ctx.el, style: ctx.fx.style ?? 'trap',
    ownerId: c.id, delay: 0.4, life: 14, stun: 1.4, slow: 0.5,
  });
  setHazardMeta(h, { crit });
  emit({ t: 'ring', x: c.x, y: c.y, r0: 4, r1: R, color: ctx.color, dur: 0.4 });
  sfx('tech', c.x, c.y);
}

/** aura：跟随施法者的持续区域（毒雾 = 中毒 + 减速） */
function doAura(ctx: Ctx, mult: number): void {
  const { c } = ctx;
  const { dmg, crit } = roll(ctx, mult, ctx.fx.critBonus);
  const h = spawnHazard({
    kind: 'aura', team: ctx.team, x: c.x, y: c.y, r: 145 * ctx.aoe, dmg: dmg * 0.55, el: ctx.el,
    style: ctx.fx.style ?? 'aura', ownerId: c.id, followId: c.id, life: 4, tick: 0.4,
    slow: ctx.el === 'poison' ? 0.3 : undefined,
  });
  setHazardMeta(h, { crit });
  emit({ t: 'burst', x: c.x, y: c.y, color: ctx.color, n: 24, spd: 140 });
  sfx(ELEM_SFX[ctx.el], c.x, c.y);
}

/* ------------------------------------------------------------------ */
/* 15 个奥义的独立表现（每个都会生成 style === 奥义 id 的 hazard）          */
/* ------------------------------------------------------------------ */

function castUltStyle(ctx: Ctx, fx: UltFx): boolean {
  const mult = ctx.sk.mult;
  switch (fx.style) {
    case 'whirl': ultWhirl(ctx, mult, fx); return true;
    case 'bulwark': ultBulwark(ctx, fx); return true;
    case 'inferno': ultInferno(ctx, mult, fx); return true;
    case 'meteors': ultMeteors(ctx, mult, fx); return true;
    case 'piercer': ultPiercer(ctx, mult, fx); return true;
    case 'arrowRain': ultArrowRain(ctx, mult, fx); return true;
    case 'zero': ultZero(ctx, mult, fx); return true;
    case 'permafrost': ultPermafrost(ctx, mult, fx); return true;
    case 'thunderStorm': ultThunderStorm(ctx, mult, fx); return true;
    case 'thunderBolt': ultThunderBolt(ctx, mult, fx); return true;
    case 'execute': ultExecute(ctx, mult, fx); return true;
    case 'venom': ultVenom(ctx, mult, fx); return true;
    case 'cavalry': ultCavalry(ctx, mult, fx); return true;
    case 'storm': ultStorm(ctx, mult, fx); return true;
    case 'orbital': ultOrbital(ctx, mult, fx); return true;
    default: return false;
  }
}

/** 纯视觉 hazard（dmg=0），跟随施法者 */
function visualAura(ctx: Ctx, style: string, r: number, life: number): void {
  spawnHazard({
    kind: 'aura', team: ctx.team, x: ctx.c.x, y: ctx.c.y, r, dmg: 0, el: ctx.el, style,
    ownerId: ctx.c.id, followId: ctx.c.id, life, tick: 1,
  });
}

/** 狂怒旋风：跟随施法者的旋风刀刃，高频挥砍并外推 */
function ultWhirl(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'aura', team: ctx.team, x: c.x, y: c.y, r: (fx.r ?? 130) * ctx.aoe, dmg: dmg * (fx.mul ?? 0.4),
    el: ctx.el, style: fx.style, ownerId: c.id, followId: c.id, life: fx.life ?? 4, tick: fx.tick ?? 0.25,
  });
  setHazardMeta(h, { crit, knock: fx.knock });
  emit({ t: 'slash', x: c.x, y: c.y, a: ctx.a, r: h.r, color: ctx.color, style: 'heavy' });
  sfx('swingHeavy', c.x, c.y);
}

/** 不屈壁垒：巨额护盾 + 双重减伤，展开瞬间震退身边敌人，护盾穹顶 */
function ultBulwark(ctx: Ctx, fx: UltFx): void {
  const { c } = ctx;
  const life = fx.life ?? 6;
  if (ctx.p) {
    const p = ctx.p;
    addShield(p, p.stat.maxHp * (fx.extra ?? 0.6) * ctx.shieldMul, life);
    p.buffs.roar = Math.max(p.buffs.roar, life);
    p.buffs.field = Math.max(p.buffs.field, life);
  } else if (isEnemyActor(c)) {
    enemyShield(c, c.maxHp * 0.3, c.maxHp * 0.6, life);
  }
  const R = (fx.r ?? 120) * ctx.aoe;
  for (const t of hostilesOf(ctx.team)) {
    if (Math.hypot(t.x - c.x, t.y - c.y) > R + t.r || !clearLine(c.x, c.y, t.x, t.y)) continue;
    knockback(t, c.x, c.y, fx.knock ?? 300);
  }
  visualAura(ctx, fx.style, R, life);
  emit({ t: 'ring', x: c.x, y: c.y, r0: 10, r1: R, color: ctx.color, dur: 0.5 });
  emit({ t: 'shake', amt: 6 });
  sfx('shield', c.x, c.y);
}

/** 末日焚域：巨型陨星 → 大范围火海 */
function ultInferno(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const pt = targetPoint(ctx, CAST_RANGE);
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'meteor', team: ctx.team, x: pt.x, y: pt.y, r: (fx.r ?? 120) * ctx.aoe, dmg, el: ctx.el,
    style: fx.style, ownerId: c.id, delay: fx.delay ?? 0.9, life: 0.5, stun: fx.stun,
  });
  setHazardMeta(h, {
    crit,
    after: {
      kind: 'zone', team: ctx.team, x: pt.x, y: pt.y, r: (fx.zoneR ?? 160) * ctx.aoe,
      dmg: dmg * (fx.zoneMul ?? 0.18), el: ctx.el, style: fx.style, ownerId: c.id,
      life: fx.zoneLife ?? 5, tick: fx.zoneTick ?? 0.4,
    },
    afterMeta: { crit },
  });
  sfx('fire', c.x, c.y);
}

/** 陨火坠落：多颗陨石在目标区域依次落下 */
function ultMeteors(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const pt = targetPoint(ctx, CAST_RANGE);
  const { dmg, crit } = roll(ctx, mult);
  const n = fx.n ?? 6;
  const spread = (fx.spread ?? 80) * ctx.aoe;
  for (let j = 0; j < n; j++) {
    const ang = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.next()) * spread;
    const g = groundPoint(pt.x + Math.cos(ang) * rr, pt.y + Math.sin(ang) * rr, pt);
    const h = spawnHazard({
      kind: 'meteor', team: ctx.team, x: g.x, y: g.y,
      r: (fx.r ?? 70) * ctx.aoe, dmg: dmg * (fx.mul ?? 0.625), el: ctx.el, style: fx.style, ownerId: c.id,
      delay: (fx.delay ?? 0.7) + j * (fx.gap ?? 0.18), life: 0.35, stun: fx.stun,
    });
    setHazardMeta(h, { crit });
  }
  sfx('fire', c.x, c.y);
}

/** 千钧一射：贯穿直线的巨型箭矢光束（撞墙截断），终点冲击 */
function ultPiercer(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const end = doBeam(ctx, mult, fx.len ?? 1100, fx.w ?? 16, { knock: fx.knock ?? 300, stun: fx.stun ?? 0.3 });
  emit({ t: 'line', x0: c.x, y0: c.y, x1: end.x1, y1: end.y1, color: '#fff2d6', w: 3 });
  spawnHazard({
    kind: 'zone', team: ctx.team, x: end.x1, y: end.y1, r: 40, dmg: 0, el: ctx.el, style: fx.style,
    ownerId: c.id, life: 0.4, tick: 1,
  });
  emit({ t: 'shake', amt: 8 });
}

/** 箭雨：目标区域内连续落下多支箭（六成箭追着区域内的敌人落） */
function ultArrowRain(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const pt = targetPoint(ctx, CAST_RANGE);
  const { dmg, crit } = roll(ctx, mult);
  const n = fx.n ?? 16;
  const spread = (fx.spread ?? 110) * ctx.aoe;
  const inZone = hostilesOf(ctx.team).filter(t => Math.hypot(t.x - pt.x, t.y - pt.y) <= spread + t.r);
  for (let j = 0; j < n; j++) {
    let x: number, y: number;
    if (inZone.length && rng.next() < (fx.extra ?? 0.6)) {
      const t = inZone[Math.floor(rng.next() * inZone.length)];
      x = t.x + rng.range(-10, 10);
      y = t.y + rng.range(-10, 10);
    } else {
      const ang = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.next()) * spread;
      x = pt.x + Math.cos(ang) * rr;
      y = pt.y + Math.sin(ang) * rr;
    }
    ({ x, y } = groundPoint(x, y, pt));
    const h = spawnHazard({
      kind: 'meteor', team: ctx.team, x, y, r: fx.r ?? 30, dmg: dmg * (fx.mul ?? 0.35), el: ctx.el,
      style: fx.style, ownerId: c.id, delay: (fx.delay ?? 0.3) + j * (fx.gap ?? 0.1), life: 0.25,
    });
    setHazardMeta(h, { crit, light: true });
  }
  emit({ t: 'ring', x: pt.x, y: pt.y, r0: spread * 0.9, r1: spread, color: ctx.color, dur: (fx.delay ?? 0.3) + n * (fx.gap ?? 0.1) });
  sfx('bow', c.x, c.y);
}

/** 绝对零度：极寒爆发冻结周围全部敌人，留下冰原 */
function ultZero(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const R = (fx.r ?? 230) * ctx.aoe;
  const { dmg, crit } = roll(ctx, mult);
  for (const t of hostilesOf(ctx.team)) {
    if (Math.hypot(t.x - c.x, t.y - c.y) > R + t.r || !clearLine(c.x, c.y, t.x, t.y)) continue;
    strike(c.id, t, dmg, { el: ctx.el, crit, slow: fx.slow ?? 0.55, isSkill: true, srcX: c.x, srcY: c.y });
    ccAfterHit(t, 'freeze', (fx.stun ?? 1.6) * ctx.elemDur);
  }
  spawnHazard({
    kind: 'iceField', team: ctx.team, x: c.x, y: c.y, r: (fx.zoneR ?? 200) * ctx.aoe, dmg: dmg * (fx.zoneMul ?? 0.12),
    el: ctx.el, style: fx.style, ownerId: c.id, life: fx.zoneLife ?? 4, tick: fx.zoneTick ?? 0.6, slow: fx.slow ?? 0.55,
  });
  emit({ t: 'ring', x: c.x, y: c.y, r0: 8, r1: R, color: ctx.color, dur: 0.6 });
  emit({ t: 'explosion', x: c.x, y: c.y, r: R, el: ctx.el });
  emit({ t: 'shake', amt: 10 });
  sfx('ice', c.x, c.y);
}

/** 永冻领域：原地展开的冰域，持续冰伤 + 强减速 + 几率冻结；元素法师冰火交替 */
function ultPermafrost(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'iceField', team: ctx.team, x: c.x, y: c.y, r: (fx.r ?? 180) * ctx.aoe, dmg: dmg * (fx.mul ?? 0.35),
    el: ctx.el, style: fx.style, ownerId: c.id, life: fx.life ?? 6, tick: fx.tick ?? 0.5, slow: fx.slow ?? 0.6,
  });
  const meta: HazardMeta = { crit, freezeChance: fx.extra ?? 0.2 };
  if (ctx.p?.cid === 'elemage') meta.altEl = ctx.el === 'fire' ? 'ice' : 'fire';
  setHazardMeta(h, meta);
  emit({ t: 'ring', x: c.x, y: c.y, r0: 8, r1: h.r, color: ctx.color, dur: 0.5 });
  sfx('ice', c.x, c.y);
}

/** 雷霆风暴：跟随施法者，每跳在周围随机落雷 */
function ultThunderStorm(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'aura', team: ctx.team, x: c.x, y: c.y, r: (fx.r ?? 210) * ctx.aoe, dmg: dmg * (fx.mul ?? 0.9),
    el: ctx.el, style: fx.style, ownerId: c.id, followId: c.id, life: fx.life ?? 5, tick: fx.tick ?? 0.35,
    stun: fx.stun ?? 0.15,
  });
  setHazardMeta(h, { crit, strikes: fx.n ?? 2 });
  sfx('zap', c.x, c.y);
}

/** 天雷陨落：天降巨型雷柱单点轰击 */
function ultThunderBolt(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const pt = targetPoint(ctx, CAST_RANGE);
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'meteor', team: ctx.team, x: pt.x, y: pt.y, r: (fx.r ?? 70) * ctx.aoe, dmg, el: ctx.el,
    style: fx.style, ownerId: c.id, delay: fx.delay ?? 0.6, life: 0.4, stun: fx.stun ?? 1,
  });
  setHazardMeta(h, { crit, sky: true });
  sfx('zap', c.x, c.y);
}

/** 目标背后的落脚点（按目标朝向；被墙挡住时退而求其次站到侧前方） */
function behindPoint(c: Actor, t: Actor): { x: number; y: number } {
  const off = t.r + c.r + 6;
  const bx = t.x - t.facing * off, by = t.y;
  if (!G.map || isFree(G.map, bx, by, c.r)) return { x: bx, y: by };
  const p = nearestFree(G.map, bx, by, c.r, 2);
  if (isFree(G.map, p.x, p.y, c.r)) return p;
  const d = Math.hypot(c.x - t.x, c.y - t.y) || 1;
  return { x: t.x + ((c.x - t.x) / d) * off, y: t.y + ((c.y - t.y) / d) * off };
}

/** 暗影绝杀：连续闪烁到多个目标背后背刺（必暴），结束后潜行 */
function ultExecute(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const range = fx.len ?? 340;
  const fog = ctx.team === 'player' ? G.map : null;
  const cands = hostilesOf(ctx.team)
    .filter(t => Math.hypot(t.x - c.x, t.y - c.y) - t.r <= range
      && (!fog || fog.isVisibleWorld(t.x, t.y)) && clearLine(c.x, c.y, t.x, t.y))
    .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))
    .slice(0, Math.max(1, fx.n ?? 5));
  const r = roll(ctx, mult);
  // 必杀：玩家施放必定暴击；镜像对手施放只 ×1.25（否则约 7 倍攻击力，必定一击秒杀 1 级玩家，无法通过加点/走位应对）
  const dmg = r.crit ? r.dmg : ctx.team === 'player' ? r.dmg * 2 : r.dmg * 1.25;
  const finish = (): void => {
    if (ctx.p) ctx.p.buffs.stealth = Math.max(ctx.p.buffs.stealth, fx.extra ?? 2);
    else if (isEnemyActor(c)) rivalBuff(c).stealth = fx.extra ?? 2;
    emit({ t: 'burst', x: c.x, y: c.y, color: ctx.color, n: 18, spd: 120 });
  };
  let segs: MotionSeg[];
  if (!cands.length) {
    // 无目标：向瞄准方向影步一段
    segs = [{ dir: { x: Math.cos(ctx.a), y: Math.sin(ctx.a) }, dur: 0.12, speed: 900 }];
  } else {
    segs = cands.map((t, i): MotionSeg => ({
      speed: 1400,
      to: () => (hittable(t) ? behindPoint(c, t) : null),
      onArrive: () => {
        // 被墙挡住没闪到身边（或目标已死）就不出刀，杜绝隔墙背刺
        if (!hittable(t) || Math.hypot(t.x - c.x, t.y - c.y) > c.r + t.r + 24 || !clearLine(c.x, c.y, t.x, t.y)) return;
        strike(c.id, t, i === 0 ? dmg : dmg * (fx.mul ?? 0.6), {
          el: ctx.el, crit: true, stun: 0.3, isSkill: true, proc: i > 0, srcX: c.x, srcY: c.y,
        });
        emit({ t: 'slash', x: c.x, y: c.y, a: Math.atan2(t.y - c.y, t.x - c.x), r: c.r + t.r + 14, color: ctx.color, style: 'dagger' });
        emit({ t: 'afterimage', actorId: c.id });
      },
    }));
  }
  startMotion(c, { segs, afterimages: 1, onEnd: finish });
  const dur = cands.length ? cands.length * 0.1 + 0.25 : 0.3;
  if (ctx.p) ctx.p.invuln = Math.max(ctx.p.invuln, dur);
  visualAura(ctx, fx.style, c.r + 18, dur);
  sfx('stealth', c.x, c.y);
}

/** 蚀骨剧毒：在目标区域展开剧毒领域（每跳叠 2 层中毒 + 减速） */
function ultVenom(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const pt = targetPoint(ctx, fx.len ?? 360);
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'zone', team: ctx.team, x: pt.x, y: pt.y, r: (fx.r ?? 150) * ctx.aoe, dmg: dmg * (fx.mul ?? 0.35),
    el: ctx.el, style: fx.style, ownerId: c.id, life: fx.life ?? 6, tick: fx.tick ?? 0.5,
    slow: fx.slow ?? 0.3, status: 'poison',
  });
  setHazardMeta(h, { crit, stacks: fx.n ?? 2 });
  emit({ t: 'ring', x: pt.x, y: pt.y, r0: 10, r1: h.r, color: ctx.color, dur: 0.5 });
  sfx('poison', c.x, c.y);
}

/** 雷霆冲锋：长距离骑枪冲锋，践踏沿途，终点震地 */
function ultCavalry(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const a = chargeAngle(ctx);
  const distance = fx.len ?? 320, dur = fx.dur ?? 0.42;
  const { dmg, crit } = roll(ctx, mult);
  const sx = c.x, sy = c.y;
  startMotion(c, {
    segs: [{ dir: { x: Math.cos(a), y: Math.sin(a) }, dur, speed: distance / dur }],
    sweep: {
      r: fx.w ?? 34, team: ctx.team,
      fn: t => strike(c.id, t, dmg, { el: ctx.el, crit, stun: fx.stun ?? 0.8, knock: fx.knock ?? 420, isSkill: true, srcX: c.x, srcY: c.y }),
    },
    afterimages: 5,
    onEnd: () => {
      const R = (fx.zoneR ?? 110) * ctx.aoe;
      for (const t of hostilesOf(ctx.team)) {
        if (Math.hypot(t.x - c.x, t.y - c.y) > R + t.r || !clearLine(c.x, c.y, t.x, t.y)) continue;
        strike(c.id, t, dmg * (fx.zoneMul ?? 0.5), { el: ctx.el, crit, knock: 300, isSkill: true, proc: true, srcX: c.x, srcY: c.y });
      }
      emit({ t: 'line', x0: sx, y0: sy, x1: c.x, y1: c.y, color: ctx.color, w: 8 });
      emit({ t: 'ring', x: c.x, y: c.y, r0: 10, r1: R, color: ctx.color, dur: 0.4 });
      emit({ t: 'explosion', x: c.x, y: c.y, r: R, el: ctx.el });
      emit({ t: 'shake', amt: 10 });
      sfx('explosion', c.x, c.y);
    },
  });
  if (ctx.p) ctx.p.invuln = Math.max(ctx.p.invuln, dur + 0.2);
  face(c, a);
  visualAura(ctx, fx.style, (fx.w ?? 34) + c.r, dur + 0.1);
  sfx('dash', c.x, c.y);
}

/** 源能风暴：跟随施法者的源能漩涡，持续伤害并把敌人卷向中心 */
function ultStorm(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const { dmg, crit } = roll(ctx, mult);
  const h = spawnHazard({
    kind: 'aura', team: ctx.team, x: c.x, y: c.y, r: (fx.r ?? 190) * ctx.aoe, dmg: dmg * (fx.mul ?? 0.45),
    el: ctx.el, style: fx.style, ownerId: c.id, followId: c.id, life: fx.life ?? 5, tick: fx.tick ?? 0.3,
  });
  setHazardMeta(h, { crit, knock: fx.knock ?? -160 });
  sfx('arcane', c.x, c.y);
}

/** 天基轨道炮：天降光柱轰击目标点，随后周围落下余波光柱 */
function ultOrbital(ctx: Ctx, mult: number, fx: UltFx): void {
  const { c } = ctx;
  const pt = targetPoint(ctx, CAST_RANGE + 40);
  const { dmg, crit } = roll(ctx, mult);
  const delay = fx.delay ?? 0.6;
  const main = spawnHazard({
    kind: 'meteor', team: ctx.team, x: pt.x, y: pt.y, r: (fx.r ?? 90) * ctx.aoe, dmg, el: ctx.el,
    style: fx.style, ownerId: c.id, delay, life: 0.5, stun: 0.4,
  });
  setHazardMeta(main, { crit, sky: true });
  const n = fx.n ?? 4;
  for (let j = 0; j < n; j++) {
    const ang = (j / n) * Math.PI * 2 + rng.range(-0.3, 0.3), rr = (fx.spread ?? 95) * ctx.aoe;
    const g = groundPoint(pt.x + Math.cos(ang) * rr, pt.y + Math.sin(ang) * rr, pt);
    const h = spawnHazard({
      kind: 'meteor', team: ctx.team, x: g.x, y: g.y,
      r: (fx.zoneR ?? 50) * ctx.aoe, dmg: dmg * (fx.extra ?? 0.35), el: ctx.el, style: fx.style,
      ownerId: c.id, delay: delay + 0.25 + j * 0.12, life: 0.4,
    });
    setHazardMeta(h, { crit, sky: true, light: true });
  }
  sfx('tech', c.x, c.y);
}
