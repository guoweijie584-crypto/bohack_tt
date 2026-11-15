// 伤害结算、状态效果、击退、击杀、死亡与复活。移植自 legacy L1157–1226、L1360–1376（状态部分）。
// 修正：普攻也能暴击；克制/穿透公式；状态叠层上限 + 施加时快照 DoT（#16）；击退不平方；护盾有时长和上限；
//       玩家也会中异常状态；Boss 控制抗性（眩晕递减）。
// 【契约】签名不可改；实现由 combat 代理完成。
//
// 与 legacy 的差异（逐条对应 code_part2 §2/§9 缺陷清单）：
// - 暴击统一由 rollDmg 掷骰，普攻也走 rollDmg；飘字显示的暴击就是实际暴击（legacy 显示与实际分离）。
// - 潜行：下一击必暴，直接命中后潜行结束（legacy 持续期间全暴、普攻不吃、命中不解除）。
// - elemPen：元素/克制伤害 ×(1+elemPen)（legacy 只 ×(1+elemPen×0.2)）；雷电天赋 st.shock 真正提高雷伤。
// - 状态：burn ≤3 层、poison ≤5 层，dps 施加时快照（legacy 读实时攻击力）；冰 = 迟缓 + 18% 冻结。
// - 控制：首领 ×0.35、精英/镜像 ×0.6，控制中不续时、结束后免控（legacy 首领可被冰系连控）。
// - 击退：初速度 + 指数衰减，只乘一次 st.knock（legacy 被平方），首领 ×0.2、精英 ×0.5，走 moveCircle。
// - 护盾：玩家护盾有时长（shieldT）和上限 maxHp×0.8（legacy 永不过期、无限叠加）。
// - 玩家会中异常（时长 50%）；竞技场落败不进死亡页且回满（legacy hp 停在 0）。
// - 职业隐藏被动（data/passives.ts）全部在这里生效。

import type { ElementId, StatusId } from '../data/types';
import type { Actor, Enemy, Player, PlayerStats, StatusSlot } from './types';
import { G, emit, floater, toast } from './state';
import { rng } from '../core/rng';
import { clamp } from '../core/util';
import { HIT_X, HIT_Y, moveCircle } from '../world/collision';
import {
  CC_RULES, DOT_RULES, ELEM, ELEM_SAME_MUL, ELEM_WEAK_MUL, ICE_RULE, KNOCK_RESIST, PLAYER_STATUS_MUL,
  SAME_RESIST_EXEMPT, SHOCK_RULE, STATUS, type CcRule,
} from '../data/elements';
import { PASSIVES } from '../data/passives';
import { gainExp } from './player';
import { dropLoot } from './drops';
import { enterCity, leaveArena } from './world';
import { saveGame } from './save';
import { cancelMotion } from './motion';
import { actorById, clearLine, hittable, isEnemyActor, isPlayerActor, nearestHostile } from './combatUtil';
import { collMap } from './enemyNav';

export interface HitOpts {
  el?: ElementId;
  crit?: boolean;
  knock?: number;
  stun?: number;
  status?: StatusId;
  /** 额外减速（0-1） */
  slow?: number;
  srcX?: number;
  srcY?: number;
  isSkill?: boolean;
  sourceId?: number;
  /** 不出飘字（DoT 批量结算） */
  silent?: boolean;
  /** （新增）普攻命中：结算 mpOnHit、元素法师交替加成 */
  basic?: boolean;
  /** （新增）次级伤害（溅射、连锁弹射、区域跳伤、被动电弧）：不触发潜行消耗/被动计数等命中特效 */
  proc?: boolean;
  /** （新增）出手序号：同一次普攻只回一次源能 */
  atkId?: number;
}

/* ------------------------------------------------------------------ */
/* 常量与模块内状态                                                      */
/* ------------------------------------------------------------------ */

/** 护盾上限（占最大生命） */
export const SHIELD_CAP = 0.8;
/** 击退速度指数衰减率（1/秒）：总位移 = 初速度 / 6 */
export const KNOCK_DECAY = 6;
const KNOCK_MAX = 900;
const CRIT_COLOR = '#ffe6a0';
const HURT_COLOR = '#ff9b7a';
const SHIELD_COLOR = '#9fd8ff';
const DODGE_COLOR = '#c9a2f0';

/** StatusSlot 的局部扩展：slow 的强度 mag（共享类型暂无该字段，见 sharedChangeRequests） */
interface SlotEx extends StatusSlot { mag?: number }

/** 每个实体的附加战斗状态（不进存档） */
interface ActorFx { ccImmune: number; dotAcc: number; dotT: number; dotCol: string }
const actorFx = new Map<number, ActorFx>();

/** 玩家侧被动计数（单机只有一个玩家） */
const pc = {
  /** 雷电魔法师·静电：直接命中计数 */
  stormHits: 0,
  /** 忍者·影步：冲刺后必暴窗口的截止时刻（G.time；sim 每步推进 G.time） */
  ninjaUntil: Number.NEGATIVE_INFINITY,
  /** 已结算 mpOnHit 的普攻序号 */
  mpAtkId: -1,
};
let atkSeq = 0;

/**
 * 镜像对手的 buff。对象同时挂在 Enemy.buffs 上（渲染层 ActorView 读 e.buffs.stealth 画半透明），
 * 这张表只用来登记“需要计时”的对手（tickRivalBuffs 递减同一个对象）。
 */
export interface RivalBuffs { overload: number; stealth: number }
const rivalBuffs = new Map<number, RivalBuffs>();

/** 命中音效节流：每个模拟步最多 2 个 */
let sfxStamp = Number.NaN;
let sfxCount = 0;

function fxOf(id: number): ActorFx {
  let f = actorFx.get(id);
  if (!f) {
    if (actorFx.size > 400) pruneFx();
    f = { ccImmune: 0, dotAcc: 0, dotT: 0, dotCol: '#fff3dd' };
    actorFx.set(id, f);
  }
  return f;
}

function pruneFx(): void {
  const alive = new Set<number>();
  if (G.player) alive.add(G.player.id);
  for (const e of G.enemies) if (!e.dead) alive.add(e.id);
  for (const id of [...actorFx.keys()]) if (!alive.has(id)) actorFx.delete(id);
  for (const id of [...rivalBuffs.keys()]) if (!alive.has(id)) rivalBuffs.delete(id);
}

/** 清空模块内战斗状态（新游戏/测试用） */
export function resetCombat(): void {
  actorFx.clear();
  rivalBuffs.clear();
  pc.stormHits = 0;
  pc.ninjaUntil = Number.NEGATIVE_INFINITY;
  pc.mpAtkId = -1;
  sfxStamp = Number.NaN;
  sfxCount = 0;
}

/** 新的出手序号（普攻每次 +1） */
export function nextAtkId(): number {
  return ++atkSeq;
}

/** 冲刺通知：忍者影步窗口（按 G.time 截止，不依赖谁每步调用） */
export function markDash(p: Player): void {
  if (p.cid === 'ninja') pc.ninjaUntil = G.time + PASSIVES.ninja.p.dur;
}

/** 镜像对手 buff（不存在时创建；与 e.buffs 是同一个对象，渲染层才看得到对手潜行） */
export function rivalBuff(e: Enemy): RivalBuffs {
  let b = rivalBuffs.get(e.id);
  if (!b) {
    b = e.buffs ?? { overload: 0, stealth: 0 };
    rivalBuffs.set(e.id, b);
  }
  e.buffs = b;
  return b;
}

/** 镜像对手 buff 计时（hazards.updateHazards 每步调用） */
export function tickRivalBuffs(dt: number): void {
  for (const [id, b] of rivalBuffs) {
    b.overload = Math.max(0, b.overload - dt);
    b.stealth = Math.max(0, b.stealth - dt);
    if (b.overload <= 0 && b.stealth <= 0) rivalBuffs.delete(id);
  }
}

/** 剩余控制免疫秒数（测试/渲染用） */
export function ccImmuneT(a: Actor): number {
  return actorFx.get(a.id)?.ccImmune ?? 0;
}

function hitSfx(crit: boolean, x: number, y: number): void {
  if (G.time !== sfxStamp) {
    sfxStamp = G.time;
    sfxCount = 0;
  }
  if (sfxCount >= 2) return;
  sfxCount++;
  emit({ t: 'sfx', name: crit ? 'crit' : 'hit', x, y });
}

/* ------------------------------------------------------------------ */
/* 掷骰                                                                 */
/* ------------------------------------------------------------------ */

/** 技能/普攻伤害掷骰：d = atk × mult × skillDmg(仅技能) × 暴击 × 过载 */
export function rollDmg(p: Player, mult: number, isSkill: boolean): { dmg: number; crit: boolean } {
  const st = p.stat;
  let crit = rng.next() < clamp(st.crit, 0, 0.95);
  // 潜行：下一击必暴（命中后在 damageEnemy 里结束潜行）
  if (p.buffs.stealth > 0) crit = true;
  // 忍者·影步：冲刺后窗口内的下一次攻击必暴（掷骰即消耗窗口）
  if (p.cid === 'ninja' && G.time <= pc.ninjaUntil) {
    crit = true;
    pc.ninjaUntil = Number.NEGATIVE_INFINITY;
  }
  const dmg = st.atk * mult
    * (isSkill ? st.skillDmg : 1)
    * (crit ? 2 : 1)
    * (isSkill && p.buffs.overload > 0 ? 1.45 : 1);
  return { dmg, crit };
}

/* ------------------------------------------------------------------ */
/* 对敌人造成伤害                                                         */
/* ------------------------------------------------------------------ */

/** 对敌人造成伤害，返回实际伤害 */
export function damageEnemy(e: Enemy, dmg: number, opts?: HitOpts): number {
  const o: HitOpts = opts ?? {};
  if (e.dead || e.spawnT > 0 || !(dmg > 0)) return 0;
  const p = G.player;
  const st: PlayerStats | null = p ? p.stat : null;
  const el: ElementId = o.el ?? st?.element ?? 'physical';
  const direct = !o.proc && !o.silent;
  const sx = o.srcX ?? p?.x ?? e.x;
  const sy = o.srcY ?? p?.y ?? e.y;

  // 镜像对手潜行：30% 闪避（与玩家潜行对称）
  if (e.rival && (rivalBuffs.get(e.id)?.stealth ?? 0) > 0 && rng.next() < 0.3) {
    if (!o.silent) floater(e.x, e.y - e.r - 8, '闪避', DODGE_COLOR, 11);
    return 0;
  }

  // 元素克制
  const weak = e.def.weak === el;
  let mul = weak ? ELEM_WEAK_MUL : (e.def.el === el && !SAME_RESIST_EXEMPT.includes(el) ? ELEM_SAME_MUL : 1);
  if (st) {
    if (st.elemPen > 0 && (weak || el !== 'physical')) mul *= 1 + st.elemPen;
    if (el === 'lightning' && st.shock > 0) mul *= 1 + st.shock;
  }

  // 职业隐藏被动（增伤 / 远距暴击）
  let d = dmg;
  let crit = !!o.crit;
  if (p) {
    const r = passiveBonus(p, e, el, d, crit, o, sx);
    d = r.d;
    crit = r.crit;
  }

  const armor = Math.max(0, e.armor) * (e.status.shock ? SHOCK_RULE.armorMul : 1);
  const pen = clamp(st?.pen ?? 0, 0, 0.9);
  let v = Math.max(1, d * mul - armor * (1 - pen) * 0.5);

  // 护盾 AI：先扣护盾（破盾表现与踉跄由 enemies 检测 e.shield 归零后统一发，这里不重复）
  let absorbed = 0;
  if (e.shield > 0) {
    absorbed = Math.min(e.shield, v);
    e.shield -= absorbed;
    v -= absorbed;
    if (e.shield < 0.5) e.shield = 0;
    if (!o.silent) floater(e.x, e.y - e.r - 14, '护盾', SHIELD_COLOR, 10);
  }
  e.flash = 0.12;
  // 仇恨不在这里改：enemies.checkHurt 按血量/护盾变化统一 setAggro（含它自己的仇恨状态初始化）
  if (v > 0) e.hp -= v;

  // 护盾未破时不吃异常与击退（“需要打破护盾才能扣血”）
  if (e.shield <= 0) {
    applyHitStatuses(e, el, o, st);
    if (o.knock && o.knock > 0) knockback(e, sx, sy, o.knock * (st ? Math.max(0, st.knock) : 1));
  }

  if (!o.silent && v > 0) {
    floater(e.x + rng.range(-6, 6), e.y - e.r - 6, `${Math.round(v)}${weak ? ' ✦' : ''}`,
      crit ? CRIT_COLOR : ELEM[el].c, crit ? 15 : 11, crit);
    emit({ t: 'impact', x: e.x, y: e.y, el, size: crit ? 12 : 7 });
    hitSfx(crit, e.x, e.y);
  }

  // 吸血 / 普攻回能
  if (p && p.hp > 0 && G.mode !== 'dead') {
    if (v > 0 && p.stat.lifesteal > 0) p.hp = Math.min(p.stat.maxHp, p.hp + v * p.stat.lifesteal);
    if (o.basic && p.stat.mpOnHit > 0 && v + absorbed > 0 && o.atkId !== undefined && o.atkId !== pc.mpAtkId) {
      pc.mpAtkId = o.atkId;
      p.mp = Math.min(p.stat.maxMp, p.mp + p.stat.mpOnHit);
    }
  }

  if (e.hp <= 0) killEnemy(e);
  if (p && direct && v + absorbed > 0) onHitProcs(p, e, d);
  return v;
}

/** 职业隐藏被动：返回修正后的伤害与暴击 */
function passiveBonus(p: Player, e: Enemy, el: ElementId, d: number, crit: boolean, o: HitOpts, sx: number): { d: number; crit: boolean } {
  switch (p.cid) {
    case 'pyro':
      if (e.status.burn) d *= 1 + PASSIVES.pyro.p.amp;
      break;
    case 'cryo':
      if (e.status.slow || e.status.freeze) d *= 1 + PASSIVES.cryo.p.amp;
      break;
    case 'ranger': {
      const P = PASSIVES.ranger.p;
      if (!crit && !o.proc && Math.hypot(e.x - p.x, e.y - p.y) > P.dist && rng.next() < P.crit) {
        crit = true;
        d *= 2;
      }
      break;
    }
    case 'assassin':
      // 背袭：攻击来源在敌人朝向的反侧（与朝向夹角 > 90°）
      if ((sx - e.x) * e.facing < 0) d *= 1 + PASSIVES.assassin.p.amp;
      break;
    case 'armored': {
      const P = PASSIVES.armored.p;
      const lost = clamp(1 - p.hp / Math.max(1, p.stat.maxHp), 0, 1);
      d *= 1 + Math.min(P.cap, lost * P.per);
      break;
    }
    case 'elemage':
      // 元素共鸣：冰打灼烧中的目标 / 火打迟缓冻结中的目标（普攻火冰交替时自然触发）
      if (o.basic && ((el === 'ice' && e.status.burn) || (el === 'fire' && (e.status.slow || e.status.freeze)))) {
        d *= 1 + PASSIVES.elemage.p.amp;
      }
      break;
    default:
      break;
  }
  return { d, crit };
}

/** 命中附带的元素异常（施加者为玩家） */
function applyHitStatuses(e: Enemy, el: ElementId, o: HitOpts, st: PlayerStats | null): void {
  const dur = st ? Math.max(0.2, st.elemDur) : 1;
  const atk = st ? st.atk : 10;
  if (el === 'fire' || o.status === 'burn') {
    const R = DOT_RULES.burn;
    applyStatus(e, 'burn', R.dur * dur, atk * (R.base + (st?.burn ?? 0) * R.per), R.maxStacks);
  }
  if (el === 'poison' || o.status === 'poison') {
    const R = DOT_RULES.poison;
    applyStatus(e, 'poison', R.dur * dur, atk * (R.base + (st?.poison ?? 0) * R.per), R.maxStacks);
  }
  if (el === 'lightning' || o.status === 'shock') applyStatus(e, 'shock', SHOCK_RULE.dur * dur);
  const icy = el === 'ice' || o.status === 'freeze';
  if (icy || o.status === 'slow') {
    const fz = Math.max(0, st?.freeze ?? 0);
    applySlow(e, ICE_RULE.slowDur * dur, Math.min(ICE_RULE.slowMagMax, ICE_RULE.slowMag * (1 + fz)));
    const chance = Math.min(ICE_RULE.freezeChanceMax, ICE_RULE.freezeChance + fz * ICE_RULE.freezeChancePer);
    if (icy && rng.next() < chance) applyStatus(e, 'freeze', ICE_RULE.freezeDur * dur);
  }
  if (o.slow && o.slow > 0) applySlow(e, 1.2 * dur, clamp(o.slow, 0, 0.9));
  if (o.stun && o.stun > 0) applyStatus(e, 'stun', o.stun);
}

/** 直接命中触发：潜行结束（风暴刺客雷影连锁）、雷电魔法师静电电弧 */
function onHitProcs(p: Player, e: Enemy, d: number): void {
  if (p.buffs.stealth > 0) {
    p.buffs.stealth = 0;
    if (p.cid === 'stormblade') {
      const P = PASSIVES.stormblade.p;
      const used = new Set<number>([e.id]);
      const pts: Array<[number, number]> = [[e.x, e.y]];
      let cur: Actor = e;
      for (let k = 0; k < P.n; k++) {
        const nx = nearestHostile('player', cur.x, cur.y, 190, used);
        if (!nx || !isEnemyActor(nx)) break;
        used.add(nx.id);
        pts.push([nx.x, nx.y]);
        damageEnemy(nx, d * P.mult, { el: 'lightning', proc: true, srcX: cur.x, srcY: cur.y });
        cur = nx;
      }
      if (pts.length > 1) emit({ t: 'chain', pts, color: ELEM.lightning.c });
    }
  }
  if (p.cid === 'storm') {
    const P = PASSIVES.storm.p;
    pc.stormHits++;
    if (pc.stormHits >= P.n) {
      pc.stormHits = 0;
      const nx = nearestHostile('player', e.x, e.y, 160, new Set([e.id]));
      const t = nx && isEnemyActor(nx) ? nx : (hittable(e) ? e : null);
      if (t) {
        emit({ t: 'chain', pts: [[e.x, e.y], [t.x, t.y]], color: ELEM.lightning.c });
        damageEnemy(t, p.stat.atk * P.mult, { el: 'lightning', proc: true, srcX: e.x, srcY: e.y });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对玩家造成伤害                                                         */
/* ------------------------------------------------------------------ */

/** 对玩家造成伤害，返回实际伤害 */
export function damagePlayer(p: Player, dmg: number, opts?: HitOpts): number {
  const o: HitOpts = opts ?? {};
  if (G.mode === 'dead' || p.dead || p.hp <= 0 || !(dmg > 0)) return 0;
  if (p.invuln > 0) return 0;
  if (p.buffs.stealth > 0 && rng.next() < 0.3) {
    if (!o.silent) floater(p.x, p.y - 26, '闪避', DODGE_COLOR, 11);
    return 0;
  }
  const st = p.stat;
  const el: ElementId = o.el ?? 'physical';
  let armor = Math.max(0, st.armor);
  // 骑士·骑士道：身边每个敌人护甲 +8%（最多 3 层）
  if (p.cid === 'knight') {
    const P = PASSIVES.knight.p;
    let n = 0;
    for (const e of G.enemies) if (!e.dead && Math.hypot(e.x - p.x, e.y - p.y) <= P.radius + e.r) n++;
    armor *= 1 + P.per * Math.min(n, P.max);
  }
  if (p.status.shock) armor *= SHOCK_RULE.armorMul;
  let v = Math.max(1, dmg - armor * 0.55);
  const field = p.buffs.field > 0, roar = p.buffs.roar > 0;
  if (field || roar) v *= 0.55;
  if (field && roar) v *= 0.75; // 不屈壁垒同时给两者：巨额减伤
  // 战士·不屈：低血减伤
  if (p.cid === 'warrior' && p.hp < st.maxHp * PASSIVES.warrior.p.hpPct) v *= 1 - PASSIVES.warrior.p.dr;

  const absorbed = absorbShield(p, v);
  v -= absorbed;
  if (absorbed > 0) {
    if (!o.silent) floater(p.x, p.y - 34, `护盾 -${Math.round(absorbed)}`, SHIELD_COLOR, 11);
    if (p.cid === 'stormguard') stormguardRetaliate(p, absorbed);
  }
  if (v > 0) {
    p.hp -= v;
    if (!o.silent) floater(p.x, p.y - 26, `-${Math.round(v)}`, HURT_COLOR, 13);
    // 受击硬直动画（不打断攻击/施法动作；sim 0.2s 后切回 idle）
    if (p.anim === 'idle' || p.anim === 'run') {
      p.anim = 'hurt';
      p.animT = 0;
    }
  }
  p.invuln = Math.max(p.invuln, 0.42);
  p.flash = 0.12;
  p.hurtT = 0;
  // 区域跳伤（proc）只轻震、不闪屏，避免冰原/毒雾每跳都满屏红闪
  emit({ t: 'shake', amt: o.proc ? 2 : v > 0 ? 6 : 3 });
  if (v > 0 && !o.proc) emit({ t: 'flash', amt: 0.16, color: '#df5f57' });
  emit({ t: 'sfx', name: v > 0 ? 'hurt' : 'shield', x: p.x, y: p.y });
  emit({ t: 'impact', x: p.x, y: p.y, el, size: 8 });

  // 异常与击退：被护盾完全吸收时不生效
  if (v > 0) {
    applyPlayerStatuses(p, el, dmg, o);
    if (o.knock && o.knock > 0) {
      const src = o.sourceId !== undefined ? actorById(o.sourceId) : null;
      const fx = o.srcX ?? src?.x, fy = o.srcY ?? src?.y;
      if (fx !== undefined && fy !== undefined) knockback(p, fx, fy, o.knock);
    }
  }
  if (p.hp <= 0) playerDie();
  return v;
}

/** 玩家中异常（时长为 legacy 敌人的 50%，DoT 按来源攻击力快照） */
function applyPlayerStatuses(p: Player, el: ElementId, rawDmg: number, o: HitOpts): void {
  const src = o.sourceId !== undefined ? actorById(o.sourceId) : null;
  const base = src && isEnemyActor(src) ? src.atk : rawDmg;
  const m = PLAYER_STATUS_MUL;
  if (el === 'fire' || o.status === 'burn') {
    const R = DOT_RULES.burn;
    applyStatus(p, 'burn', R.dur * m, base * R.base, R.maxStacks);
  }
  if (el === 'poison' || o.status === 'poison') {
    const R = DOT_RULES.poison;
    applyStatus(p, 'poison', R.dur * m, base * R.base, R.maxStacks);
  }
  if (el === 'lightning' || o.status === 'shock') applyStatus(p, 'shock', SHOCK_RULE.dur * m);
  if (el === 'ice' || o.status === 'slow' || o.status === 'freeze') applySlow(p, ICE_RULE.slowDur * m, ICE_RULE.slowMag);
  if (o.slow && o.slow > 0) applySlow(p, 1.2 * m, clamp(o.slow, 0, 0.9));
  if (o.stun && o.stun > 0) applyStatus(p, 'stun', o.stun);
}

/** 护盾吸收：过期护盾清零、超过上限截断；返回吸收量 */
function absorbShield(p: Player, v: number): number {
  const b = p.buffs;
  if (b.shieldT <= 0) b.shield = 0;
  b.shield = clamp(b.shield, 0, p.stat.maxHp * SHIELD_CAP);
  if (b.shield <= 0 || v <= 0) return 0;
  const ab = Math.min(b.shield, v);
  b.shield -= ab;
  if (b.shield <= 1e-6) {
    b.shield = 0;
    b.shieldT = 0;
    emit({ t: 'ring', x: p.x, y: p.y, r0: p.r, r1: p.r + 30, color: SHIELD_COLOR, dur: 0.3 });
  }
  return ab;
}

/** 增加护盾（上限 maxHp×0.8，时长取 max） */
export function addShield(p: Player, amount: number, dur: number): void {
  const b = p.buffs;
  if (b.shieldT <= 0) b.shield = 0;
  b.shield = Math.min(p.stat.maxHp * SHIELD_CAP, b.shield + Math.max(0, amount));
  b.shieldT = Math.max(b.shieldT, dur);
}

/** 风暴守卫·电磁壁垒：护盾吸收时对周围敌人造成吸收量 50% 的雷电反击 */
function stormguardRetaliate(p: Player, absorbed: number): void {
  const P = PASSIVES.stormguard.p;
  const dmg = absorbed * P.mult;
  let n = 0;
  for (const e of [...G.enemies]) {
    if (!hittable(e) || Math.hypot(e.x - p.x, e.y - p.y) > P.radius + e.r) continue;
    if (!clearLine(p.x, p.y, e.x, e.y)) continue;
    emit({ t: 'chain', pts: [[p.x, p.y], [e.x, e.y]], color: ELEM.lightning.c });
    damageEnemy(e, dmg, { el: 'lightning', proc: true, srcX: p.x, srcY: p.y });
    n++;
  }
  if (n) emit({ t: 'ring', x: p.x, y: p.y, r0: 10, r1: P.radius, color: ELEM.lightning.c, dur: 0.3 });
}

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */

function ccRuleOf(a: Actor): CcRule | null {
  if (isPlayerActor(a)) return CC_RULES.player;
  if (isEnemyActor(a)) {
    if (a.boss) return CC_RULES.boss;
    if (a.elite || a.rival) return CC_RULES.elite;
  }
  return null;
}

/** 施加状态（叠层上限 maxStacks，持续时间取 max 刷新） */
export function applyStatus(a: Actor, s: StatusId | 'stun', dur: number, dps?: number, maxStacks?: number): void {
  if (!(dur > 0) || a.dead) return;
  if (s === 'stun' || s === 'freeze') {
    const rule = ccRuleOf(a);
    if (rule) {
      // 控制抗性：免控期内无效；控制中不续时（递减）；时长 × mul
      if ((actorFx.get(a.id)?.ccImmune ?? 0) > 0) return;
      if (isStunned(a)) return;
      dur *= rule.mul;
    }
  }
  const cap = Math.max(1, Math.floor(maxStacks ?? 1));
  const cur = a.status[s];
  if (!cur) {
    a.status[s] = { t: dur, stacks: 1, dps: Math.max(0, dps ?? 0) };
    return;
  }
  cur.t = Math.max(cur.t, dur);
  cur.stacks = Math.max(cur.stacks, Math.min(cap, cur.stacks + 1));
  if (dps !== undefined) cur.dps = Math.max(cur.dps, dps);
}

/** 迟缓（mag = 减速比例 0-1，取强者） */
export function applySlow(a: Actor, dur: number, mag: number): void {
  if (!(dur > 0) || !(mag > 0) || a.dead) return;
  applyStatus(a, 'slow', dur);
  const s = a.status.slow as SlotEx | undefined;
  if (s) s.mag = Math.max(s.mag ?? 0, clamp(mag, 0, 0.9));
}

/** 额外叠一层 DoT（剧毒领域每跳多层等），dps 按玩家当前属性快照 */
export function addDotStack(a: Actor, kind: 'burn' | 'poison'): void {
  const st = G.player?.stat;
  const R = DOT_RULES[kind];
  const talent = st ? (kind === 'burn' ? st.burn : st.poison) : 0;
  applyStatus(a, kind, R.dur * (st?.elemDur ?? 1), (st?.atk ?? 10) * (R.base + talent * R.per), R.maxStacks);
}

const TICK_KEYS: ReadonlyArray<StatusId | 'stun'> = ['burn', 'poison', 'shock', 'slow', 'freeze', 'stun'];

/**
 * 推进状态计时与 DoT，返回本步 DoT 伤害（已扣在 hp 上；致死时内部调用 killEnemy / playerDie，
 * 调用方再判 hp≤0 → killEnemy 也安全，killEnemy 幂等）。受击闪白 flash 由调用方（enemies/sim）递减。
 */
export function tickStatus(a: Actor, dt: number): number {
  if (a.dead || !(dt > 0)) return 0;
  const wasCc = isStunned(a);
  let dot = 0;
  let col = '';
  for (const k of TICK_KEYS) {
    const s = a.status[k];
    if (!s) continue;
    if ((k === 'burn' || k === 'poison') && s.dps > 0 && s.t > 0) {
      dot += s.dps * s.stacks * Math.min(dt, s.t);
      col = STATUS[k].c;
    }
    s.t -= dt;
    if (s.t <= 0) delete a.status[k];
  }
  const fx = actorFx.get(a.id);
  if (fx && fx.ccImmune > 0) fx.ccImmune = Math.max(0, fx.ccImmune - dt);
  if (wasCc && !isStunned(a)) {
    const rule = ccRuleOf(a);
    if (rule && rule.immune > 0) fxOf(a.id).ccImmune = rule.immune;
  }
  if (dot > 0) applyDot(a, dot, col, dt);
  else if (fx && fx.dotAcc > 0) flushDot(a, fx, dt);
  return dot;
}

function applyDot(a: Actor, dot: number, col: string, dt: number): void {
  if (isEnemyActor(a)) {
    let v = dot;
    if (a.shield > 0) {
      const ab = Math.min(a.shield, v);
      a.shield -= ab;
      v -= ab;
    }
    a.hp -= v;
  } else if (isPlayerActor(a)) {
    if (G.mode === 'dead') return;
    const v = dot - absorbShield(a, dot);
    a.hp -= v;
    a.hurtT = 0;
  }
  const fx = fxOf(a.id);
  fx.dotAcc += dot;
  if (col) fx.dotCol = col;
  flushDot(a, fx, dt);
  if (a.hp <= 0) {
    if (isEnemyActor(a)) killEnemy(a);
    else if (isPlayerActor(a)) playerDie();
  }
}

/** DoT 飘字：每 0.5 秒合并一次 */
function flushDot(a: Actor, fx: ActorFx, dt: number): void {
  fx.dotT += dt;
  if (fx.dotT < 0.5) return;
  if (fx.dotAcc >= 1) floater(a.x, a.y - a.r - 4, Math.round(fx.dotAcc), fx.dotCol, 10);
  fx.dotAcc = 0;
  fx.dotT = 0;
}

/** 当前移速倍率（迟缓/冰冻） */
export function speedMul(a: Actor): number {
  if (isStunned(a)) return 0;
  const s = a.status.slow as SlotEx | undefined;
  if (!s || s.t <= 0) return 1;
  return 1 - clamp(s.mag ?? ICE_RULE.slowMag, 0, 0.9);
}

export function isStunned(a: Actor): boolean {
  return (a.status.stun?.t ?? 0) > 0 || (a.status.freeze?.t ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* 击退                                                                 */
/* ------------------------------------------------------------------ */

/** 从 (fromX,fromY) 方向击退，power 为初速度（世界单位/秒）；负数为拉拽 */
export function knockback(a: Actor, fromX: number, fromY: number, power: number): void {
  if (!power || a.dead) return;
  let dx = a.x - fromX, dy = a.y - fromY;
  let d = Math.hypot(dx, dy);
  if (d < 1e-6) {
    const ang = rng.range(0, Math.PI * 2);
    dx = Math.cos(ang);
    dy = Math.sin(ang);
    d = 1;
  }
  let pw = power;
  if (isEnemyActor(a)) pw *= a.boss ? KNOCK_RESIST.boss : (a.elite || a.rival ? KNOCK_RESIST.elite : 1);
  a.kx += (dx / d) * pw;
  a.ky += (dy / d) * pw;
  const sp = Math.hypot(a.kx, a.ky);
  if (sp > KNOCK_MAX) {
    a.kx *= KNOCK_MAX / sp;
    a.ky *= KNOCK_MAX / sp;
  }
}

/** 推进击退位移（带墙体碰撞）：v(t)=v0·e^(-6t)，本步位移取精确积分 */
export function tickKnockback(a: Actor, dt: number): void {
  if (!(dt > 0)) return;
  const sp = Math.hypot(a.kx, a.ky);
  if (sp < 3) {
    a.kx = 0;
    a.ky = 0;
    return;
  }
  const f = (1 - Math.exp(-KNOCK_DECAY * dt)) / KNOCK_DECAY;
  const dx = a.kx * f, dy = a.ky * f;
  if (G.map) {
    // 怪物按它自己的碰撞图（与 enemyNav.applyMove 一致）：飞行单位悬停在水/熔岩/深坑上方时，
    // 用原图会把这些格当墙——击退第一小步就被清零，还会被 resolveCircle 往岸边硬推
    const hit = moveCircle(isEnemyActor(a) ? collMap(a) : G.map, a, dx, dy);
    if (hit & HIT_X) a.kx = 0;
    if (hit & HIT_Y) a.ky = 0;
  } else {
    a.x += dx;
    a.y += dy;
  }
  const k = Math.exp(-KNOCK_DECAY * dt);
  a.kx *= k;
  a.ky *= k;
}

/* ------------------------------------------------------------------ */
/* 击杀 / 死亡 / 复活                                                    */
/* ------------------------------------------------------------------ */

export function killEnemy(e: Enemy): void {
  if (e.dead) return;
  e.dead = true;
  e.hp = Math.min(e.hp, 0);
  e.anim = 'dead';
  e.animT = 0;
  e.kx = 0;
  e.ky = 0;
  e.status = {};
  cancelMotion(e.id);
  actorFx.delete(e.id);
  rivalBuffs.delete(e.id);
  if (e.buffs) {
    e.buffs.overload = 0;
    e.buffs.stealth = 0;
  }
  const big = e.elite || e.boss;
  emit({ t: 'death', x: e.x, y: e.y, color: e.def.c, big, kind: e.kind });
  emit({ t: 'sfx', name: 'kill', x: e.x, y: e.y });
  const p = G.player;
  if (p) {
    p.kills++;
    // 经验通过 dropLoot 掉落的经验球拾取获得（legacy R50）；召唤物不掉落，直接给经验；
    // 镜像对手的金币/经验由 world.leaveArena(true) 结算。（修复：之前这里无条件 gainExp，经验翻倍）
    if (!e.rival && e.exp > 0 && e.summonedBy !== undefined) gainExp(p, e.exp);
  }
  if (!e.rival && e.summonedBy === undefined) dropLoot(e);
  if (e.boss) {
    if (p) p.bossKills++;
    emit({ t: 'shake', amt: 15 });
    emit({ t: 'flash', amt: 0.5, color: '#fff2dc' });
    emit({ t: 'banner', text: `击败 ${e.def.n}`, sub: '首领已被击溃', color: '#f0bd7c' });
    emit({ t: 'sfx', name: 'victory' });
  } else if (e.elite) {
    emit({ t: 'shake', amt: 6 });
  }
}

/** 复活/竞技场落败共用：回满、清 CD/buff/状态/位移 */
function restorePlayer(p: Player): void {
  p.hp = p.stat.maxHp;
  p.mp = p.stat.maxMp;
  p.invuln = 2;
  for (const k of Object.keys(p.cd) as Array<keyof Player['cd']>) p.cd[k] = 0;
  for (const k of Object.keys(p.buffs) as Array<keyof Player['buffs']>) p.buffs[k] = 0;
  p.status = {};
  p.kx = 0;
  p.ky = 0;
  p.vx = 0;
  p.vy = 0;
  p.dashT = 0;
  p.dashVx = 0;
  p.dashVy = 0;
  p.dead = false;
  p.anim = 'idle';
  p.animT = 0;
  p.flash = 0;
  cancelMotion(p.id);
  actorFx.delete(p.id);
  pc.ninjaUntil = Number.NEGATIVE_INFINITY;
  pc.stormHits = 0;
}

export function playerDie(): void {
  const p = G.player;
  if (!p || G.mode === 'dead' || p.dead) return;
  if (G.scene === 'arena' && !G.enemies.some(e => e.rival && !e.dead)) {
    // 镜像已被击败、world 正在等胜利结算（ARENA_WIN_DELAY）时被残留 DoT/区域磨到 0：
    // 不能判负（否则赢下的连胜被清零、胜利奖励丢失），回满后交给 world.updateArena 按胜利离场。
    restorePlayer(p);
    return;
  }
  p.hp = 0;
  cancelMotion(p.id);
  G.input.attack = false;
  emit({ t: 'sfx', name: 'death', x: p.x, y: p.y });
  if (G.scene === 'arena') {
    // 竞技场落败不进死亡页、不算真实死亡（legacy L1212），并修正 legacy“hp 停在 0”：回满后交给 world 回城、清连胜
    restorePlayer(p);
    emit({ t: 'shake', amt: 8 });
    leaveArena(false);
    saveGame();
    return;
  }
  p.deaths++;
  // 死亡惩罚在死亡瞬间结算并存档（legacy 在复活时才扣：死亡页刷新/关页面即可绕过，code_part3 §3.3-8）
  lastDeathLoss = p.gold - Math.floor(p.gold * 0.9);
  p.gold -= lastDeathLoss;
  p.dead = true;
  p.anim = 'dead';
  p.animT = 0;
  p.kx = 0;
  p.ky = 0;
  G.mode = 'dead';
  emit({ t: 'ui', what: 'dead' });
  saveGame();
}

/** 上一次死亡损失的金币（死亡页显示用） */
let lastDeathLoss = 0;
export function deathGoldLoss(): number { return lastDeathLoss; }

/** 复活：回主城（金币惩罚已在死亡时结算），2s 无敌 */
export function revive(): void {
  const p = G.player;
  if (!p || G.mode !== 'dead') return;
  restorePlayer(p);
  G.mode = 'play';
  enterCity('spawn');
  toast(lastDeathLoss > 0 ? `于曙光主城重生 · 已损失 ${lastDeathLoss} 金币` : '于曙光主城重生', '#a3c979');
  saveGame();
}
