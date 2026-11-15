// 怪物通用动作：构造怪物（spawnEnemy 的实现）、近战前摇、冲锋、射击/弹幕、召唤。普通 AI 与首领共用。
// 所有攻击都有前摇/预警（telegraph 环、冲锋路线 line、落点圈），伤害走 combat.damagePlayer，
// 敌弹走 projectiles.spawnProjectile(team 'enemy')。

import { rng } from '../core/rng';
import { ENEMIES } from '../data/enemies';
import type { ElementId, EnemyDef, StatusId } from '../data/types';
import { isFree, moveCircle, nearestFree } from '../world/collision';
import { lineOfSight, raycastDist } from '../world/los';
import { applyStatus, damagePlayer, speedMul } from './combat';
import type { SpawnOpts } from './enemies';
import { spawnProjectile } from './projectiles';
import { G, emit, nextId } from './state';
import type { Enemy, Player, ProjectileKind } from './types';
import { collMap, passMap, spotNear, walkLine, type Vec } from './enemyNav';
import {
  MELEE_REACH, SPAWN_FADE, SUMMON_COLOR, WARN_COLOR, blink, elemColor, ext, faceTo, newAct, setAnim, sfx, telegraph,
  type Act, type EnemyExt,
} from './enemyState';

/* ------------------------------------------------------------------ */
/* 构造                                                                  */
/* ------------------------------------------------------------------ */
/** 数值覆盖（镜像对手等动态怪物不走等级成长公式） */
export interface StatOverride {
  hp: number;
  atk: number;
  armor: number;
  /** 世界单位/秒 */
  spd: number;
  exp: number;
  gold: number;
}

/**
 * 构造并登记一只怪物（spawnEnemy / spawnRival / 召唤共用）。
 * 成长（legacy L1005–1013）：hp=def.hp×(1+lv×0.14)×mul，atk=def.atk×(1+lv×0.1)×mul，armor=def.armor+lv×0.4，
 * exp=def.exp×(1+lv×0.12)，gold=def.gold×(1+lv×0.1)，spd=def.spd×60（世界单位/秒）。
 * 普通怪被提升为精英：血 ×1.6（另加攻击 ×1.15、经验金币 ×1.8 作为风险回报）；首领只用传入的 mul。
 * 召唤物 exp/gold 为 0（不掉落）。多重血条：普通 1+floor(lv/15)，精英 +1，首领 3。
 */
export function buildEnemy(kind: string, def: EnemyDef, x: number, y: number, opts: SpawnOpts = {}, st?: StatOverride): Enemy {
  const p = G.player;
  const lv = Math.max(1, Math.round(opts.lv ?? p?.lv ?? 1));
  const mul = opts.mul ?? 1;
  const boss = opts.boss ?? !!def.boss;
  const elite = opts.elite ?? !!def.elite;
  const summoned = opts.summonedBy !== undefined;
  let hp = def.hp * (1 + lv * 0.14) * mul;
  let atk = def.atk * (1 + lv * 0.1) * mul;
  let armor = def.armor + lv * 0.4;
  let spd = def.spd * 60;
  let exp = def.exp * (1 + lv * 0.12);
  let gold = def.gold * (1 + lv * 0.1);
  if (st) {
    hp = st.hp;
    atk = st.atk;
    armor = st.armor;
    spd = st.spd;
    exp = st.exp;
    gold = st.gold;
  } else if (elite && !def.elite && !boss) {
    hp *= 1.6;
    atk *= 1.15;
    exp *= 1.8;
    gold *= 1.8;
  }
  if (summoned) {
    exp = 0;
    gold = 0;
  }
  const bars = boss ? 3 : 1 + Math.floor(lv / 15) + (elite ? 1 : 0);
  let px = x, py = y;
  if (G.map) {
    const f = nearestFree(G.map, x, y, def.r);
    px = f.x;
    py = f.y;
  }
  const aggro = opts.aggro ?? (elite || boss);
  const e: Enemy = {
    id: nextId(), team: 'enemy', x: px, y: py, r: def.r,
    hp, maxHp: hp, facing: p && p.x < px ? -1 : 1, aim: p ? Math.atan2(p.y - py, p.x - px) : 0,
    vx: 0, vy: 0, kx: 0, ky: 0, status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
    kind, def, lv, atk, armor, spd, exp: Math.round(exp), gold: Math.round(gold),
    elite, boss, bars, shield: 0, ai: aggro ? 'chase' : 'idle', aiT: 0,
    cdAtk: rng.range(0.4, 1.2), cdSkill: rng.range(1.2, 3), cdSkill2: rng.range(2, 4.5),
    orbitDir: rng.chance(0.5) ? 1 : -1, aggro, phase: boss ? 1 : 0, spawnT: SPAWN_FADE,
  };
  if (summoned) e.summonedBy = opts.summonedBy;
  const x0 = ext(e);
  x0.mul = mul;
  x0.lastHp = hp;
  G.enemies.push(e);
  emit({ t: 'spawn', x: px, y: py, boss });
  if (boss && !G.boss) G.boss = e;
  return e;
}

/** 按 kind 构造（未知 kind 回落为源泥怪，保留 kind 便于排查） */
export function createEnemy(kind: string, x: number, y: number, opts: SpawnOpts = {}): Enemy {
  return buildEnemy(kind, ENEMIES[kind] ?? ENEMIES.slime, x, y, opts);
}

/* ------------------------------------------------------------------ */
/* 近战                                                                  */
/* ------------------------------------------------------------------ */
/** 开始近战前摇（脚下预警环） */
export function startMelee(e: Enemy, x: EnemyExt, p: Player, wind: number, color = WARN_COLOR): void {
  x.act = newAct('melee', wind);
  telegraph(e, wind, color);
  faceTo(e, p.x, p.y);
  e.ai = 'windup';
  setAnim(e, 'attack');
}

/** 近战出手：判定距离内且无墙阻隔则伤害玩家，返回是否命中 */
export function meleeStrike(e: Enemy, p: Player, mult: number, extraReach = 0, knock = 0): boolean {
  faceTo(e, p.x, p.y);
  const heavy = e.r >= 16 || e.boss;
  emit({ t: 'slash', x: e.x, y: e.y, a: e.aim, r: e.r + 16 + extraReach, color: elemColor(e.def.el), style: heavy ? 'heavy' : 'claw', team: 'enemy' });
  sfx(heavy ? 'swingHeavy' : 'swing', e.x, e.y, 0.6);
  setAnim(e, 'attack');
  const d = Math.hypot(p.x - e.x, p.y - e.y);
  if (d > e.r + p.r + MELEE_REACH + extraReach) return false;
  if (G.map && !lineOfSight(G.map, e.x, e.y, p.x, p.y)) return false;
  damagePlayer(p, e.atk * mult, { el: e.def.el, srcX: e.x, srcY: e.y, knock: knock > 0 ? knock : undefined, sourceId: e.id });
  return true;
}

/** 推进近战动作（前摇结束出手、收招），结束返回 true。出手时比开始判定多 6 的宽容距离。 */
export function meleeTick(e: Enemy, x: EnemyExt, p: Player, a: Act, dt: number, mult: number, cd: number, extraReach = 0, knock = 0): boolean {
  if (a.ph === 'wind') {
    a.t -= dt;
    faceTo(e, p.x, p.y);
    e.ai = 'windup';
    setAnim(e, 'attack');
    if (a.t <= 0) {
      meleeStrike(e, p, mult, extraReach + 6, knock);
      e.cdAtk = cd;
      a.ph = 'rec';
      a.t = 0.18;
      e.ai = 'attack';
    }
    return false;
  }
  a.t -= dt;
  return a.t <= 0;
}

/* ------------------------------------------------------------------ */
/* 冲锋                                                                  */
/* ------------------------------------------------------------------ */
export interface ChargeOpts {
  /** 冲锋速度（世界单位/秒） */
  speed: number;
  /** 冲锋时长 */
  dur: number;
  /** 撞到玩家的伤害倍率（× atk） */
  mult: number;
  /** 击退初速度 */
  knock: number;
  /** 冲锋结束后写入 cdSkill */
  cd: number;
  /** 撞墙后自身眩晕秒数 */
  stun: number;
}

/** 两点之间是否适合冲锋（按体型的直线全程可走：大体型不会对着 1 格窄缝冲） */
export function laneClear(e: Enemy, p: Player): boolean {
  return !!G.map && walkLine(passMap(e), e.x, e.y, p.x, p.y);
}

/** 开始冲锋前摇：锁定方向，画出冲锋路线（lane 预警，持续整个前摇）+ 脚下预警环，前摇期间闪白 */
export function startCharge(e: Enemy, x: EnemyExt, p: Player, wind: number, o: ChargeOpts): void {
  const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  x.act = newAct('charge', wind, { dx: ux, dy: uy });
  const len = G.map ? Math.max(8, raycastDist(G.map, e.x, e.y, Math.atan2(uy, ux), o.speed * o.dur)) : o.speed * o.dur;
  // 用带时长的 telegraph 事件（之前发警告色 'line'，渲染层只能按固定 0.45s 画：首领 0.52–0.7s 的冲锋前摇后段没有路线预警）
  emit({
    t: 'telegraph', x: e.x, y: e.y, r: Math.max(6, e.r * 0.8), dur: Math.max(0.1, wind), shape: 'lane',
    x1: e.x + ux * len, y1: e.y + uy * len, color: WARN_COLOR,
  });
  telegraph(e, wind);
  faceTo(e, p.x, p.y);
  e.ai = 'windup';
  setAnim(e, 'attack');
}

/**
 * 推进冲锋：前摇（闪白）→ 带碰撞高速位移（撞到玩家伤害一次并停下；撞墙自身眩晕）→ 收招。结束返回 true。
 */
export function chargeTick(e: Enemy, x: EnemyExt, p: Player, a: Act, dt: number, o: ChargeOpts): boolean {
  void x;
  if (a.ph === 'wind') {
    a.t -= dt;
    blink(e, a, dt);
    e.ai = 'windup';
    if (a.t <= 0) {
      a.ph = 'go';
      a.t = o.dur;
      e.ai = 'charge';
      sfx('dash', e.x, e.y);
      emit({ t: 'afterimage', actorId: e.id });
    }
    return false;
  }
  if (a.ph === 'go') {
    const want = o.speed * speedMul(e) * dt;
    const x0 = e.x, y0 = e.y;
    moveCircle(collMap(e), e, a.dx * want, a.dy * want);
    const moved = Math.hypot(e.x - x0, e.y - y0);
    e.vx = (e.x - x0) / dt;
    e.vy = (e.y - y0) / dt;
    if (Math.abs(a.dx) > 0.05) e.facing = a.dx > 0 ? 1 : -1;
    e.aim = Math.atan2(a.dy, a.dx);
    e.ai = 'charge';
    setAnim(e, 'run');
    a.t -= dt;
    if (!a.hit && Math.hypot(p.x - e.x, p.y - e.y) < e.r + p.r + 6) {
      a.hit = true;
      damagePlayer(p, e.atk * o.mult, { el: e.def.el, srcX: e.x - a.dx * 12, srcY: e.y - a.dy * 12, knock: o.knock, sourceId: e.id });
      emit({ t: 'impact', x: (e.x + p.x) / 2, y: (e.y + p.y) / 2, el: e.def.el, size: e.r });
      emit({ t: 'shake', amt: e.boss ? 8 : 4 });
      a.t = Math.min(a.t, 0.05);
    } else if (want > 0.5 && moved < want * 0.35) {
      // 撞墙：碎石 + 震屏 + 自身短暂眩晕（玩家的反击窗口）
      emit({ t: 'burst', x: e.x + a.dx * e.r, y: e.y + a.dy * e.r, color: '#c8b49a', n: 14, spd: 120 });
      emit({ t: 'shake', amt: e.boss ? 7 : 3 });
      sfx('hit', e.x, e.y, 0.7);
      if (o.stun > 0) applyStatus(e, 'stun', o.stun);
      a.t = 0;
    }
    if (a.t <= 0) {
      a.ph = 'rec';
      a.t = 0.3;
      e.cdSkill = o.cd;
      e.ai = 'chase';
      e.vx = 0;
      e.vy = 0;
    }
    return false;
  }
  a.t -= dt;
  return a.t <= 0;
}

/* ------------------------------------------------------------------ */
/* 射击                                                                  */
/* ------------------------------------------------------------------ */
export interface OrbOpts {
  kind?: ProjectileKind;
  r?: number;
  life?: number;
  color?: string;
  el?: ElementId;
  status?: StatusId;
  stun?: number;
}

/** 发射一枚敌方弹（从怪物中心发出，保证不会生成在墙里） */
export function fireOrb(e: Enemy, ang: number, speed: number, dmg: number, o: OrbOpts = {}): void {
  const el = o.el ?? e.def.el;
  spawnProjectile({
    kind: o.kind ?? 'enemyOrb', team: 'enemy', x: e.x, y: e.y,
    vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, dmg, el, ownerId: e.id,
    r: o.r ?? 5, life: o.life ?? 2.6, color: o.color ?? elemColor(el), pierce: 0, homing: 0, hit: [], splash: 0,
    ...(o.status ? { status: o.status } : {}),
    ...(o.stun ? { stun: o.stun } : {}),
  });
}

/** 环形弹幕：n 发均匀分布，起始角 off */
export function ringVolley(e: Enemy, n: number, speed: number, dmg: number, off: number, o: OrbOpts = {}): void {
  for (let i = 0; i < n; i++) fireOrb(e, off + (i * Math.PI * 2) / n, speed, dmg, o);
}

/** 扇形弹幕：以 base 为中心、总张角 spread 的 n 发 */
export function fanVolley(e: Enemy, base: number, n: number, spread: number, speed: number, dmg: number, o: OrbOpts = {}): void {
  if (n <= 1) {
    fireOrb(e, base, speed, dmg, o);
    return;
  }
  for (let i = 0; i < n; i++) fireOrb(e, base - spread / 2 + (spread * i) / (n - 1), speed, dmg, o);
}

/* ------------------------------------------------------------------ */
/* 召唤                                                                  */
/* ------------------------------------------------------------------ */
/** 某召唤者当前存活的召唤物数量（可按 kind 过滤） */
export function countSummons(ownerId: number, kind?: string): number {
  let n = 0;
  for (const o of G.enemies) if (!o.dead && o.summonedBy === ownerId && (!kind || o.kind === kind)) n++;
  return n;
}

/** 在召唤者周围找 n 个合法落点（nearestFree + 与召唤者直线连通 + 互不重叠） */
export function summonSpots(e: Enemy, n: number, radius: number, r: number): Vec[] {
  const out: Vec[] = [];
  const base = rng.range(0, Math.PI * 2);
  const tries = Math.max(6, n * 4);
  for (let i = 0; i < tries && out.length < n; i++) {
    const ang = base + (i * Math.PI * 2) / tries * 2.3;
    const s = spotNear(e.x, e.y, ang, radius + rng.range(-8, 10), r);
    if (s && out.every(o => Math.hypot(o.x - s.x, o.y - s.y) > r * 2)) out.push(s);
  }
  return out;
}

/** 在落点召唤一只（召唤物：summonedBy=召唤者 id、出生即仇恨、不掉落）；落点失效会就近重找 */
export function summonAt(e: Enemy, kind: string, spot: Vec): Enemy | null {
  const map = G.map;
  const def = ENEMIES[kind];
  if (!map || !def) return null;
  let s: Vec | null = spot;
  if (!isFree(map, s.x, s.y, def.r) || !walkLine(map, e.x, e.y, s.x, s.y)) {
    s = spotNear(e.x, e.y, rng.range(0, Math.PI * 2), e.r + def.r + 8, def.r);
  }
  if (!s) return null;
  const m = buildEnemy(kind, def, s.x, s.y, { lv: e.lv, mul: ext(e).mul, summonedBy: e.id, aggro: true });
  emit({ t: 'burst', x: m.x, y: m.y, color: SUMMON_COLOR, n: 12, spd: 90 });
  return m;
}

/** 踉跄（破盾/被打断），期间不行动 */
export function startStagger(e: Enemy, x: EnemyExt, dur: number): void {
  x.act = newAct('stagger', dur);
  setAnim(e, 'hurt');
}
