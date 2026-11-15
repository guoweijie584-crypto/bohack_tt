// 怪物 AI 的模块内扩展状态与通用小工具。
// - 扩展状态放在 WeakMap<Enemy, EnemyExt>，不改共享类型（game/types.ts），怪物对象被移除后自动回收；
// - 分层（无循环依赖）：enemyState ← enemyNav ← enemyActs ← (enemyAi | bosses) ← enemies ← spawner。
// 纯模拟层：不引用 Phaser、不碰 DOM；表现一律 emit()。

import { ELEM } from '../data/elements';
import type { ElementId } from '../data/types';
import { emit } from './state';
import type { AnimState, Enemy, SfxName } from './types';

/* ------------------------------------------------------------------ */
/* 常量（世界单位 / 秒）                                                 */
/* ------------------------------------------------------------------ */
/** 发现玩家的距离（还需视线可达） */
export const AGGRO_R = 360;
/** 与玩家距离超过 LEASH_R 持续 LEASH_T 秒 → 脱战回 idle */
export const LEASH_R = 900;
export const LEASH_T = 4;
/** 出生淡入（期间不行动；无敌由 combat 判定 spawnT>0） */
export const SPAWN_FADE = 0.5;
/** 贴身停步的间隙 / 近战判定的额外距离（legacy r+p.r+4 / r+p.r+10） */
export const CONTACT_GAP = 4;
export const MELEE_REACH = 10;
/** 普通敌方法球速度：legacy 3.8 px/帧 × 60 */
export const ORB_SPEED = 228;
/** 召唤者同时存在的召唤物上限 */
export const SUMMON_CAP = 6;
/** 全图普通召唤者的召唤物总上限（首领召唤不受此限） */
export const SUMMON_GLOBAL_CAP = 24;
/** 预警色 */
export const WARN_COLOR = '#ff5a3c';
export const SHIELD_COLOR = '#8fe0ff';
export const SUMMON_COLOR = '#b48cff';

/* ------------------------------------------------------------------ */
/* 动作（前摇 → 生效 → 收招）                                            */
/* ------------------------------------------------------------------ */
export type ActPhase = 'wind' | 'go' | 'rec';

export interface Act {
  /** 动作类型（melee / charge / shot / summon / raise / stagger / 首领技能 id …） */
  k: string;
  ph: ActPhase;
  /** 当前阶段剩余秒 */
  t: number;
  /** 前摇总时长 */
  dur: number;
  /** 目标点（落点/锁定位置） */
  x: number;
  y: number;
  /** 锁定方向（单位向量） */
  dx: number;
  dy: number;
  /** 本次动作是否已命中（冲锋/突进只伤一次） */
  hit: boolean;
  /** 计数器（弹幕波次等） */
  n: number;
  /** 辅助计时器（闪烁/连发间隔） */
  t2: number;
  /** 角度累加（螺旋弹幕） */
  a: number;
  /** 预先校验过的落点（召唤/瞬移） */
  spots: Array<{ x: number; y: number }>;
  /** 附加字符串（技能下标、奥义 id 等） */
  s: string;
}

export function newAct(k: string, wind: number, extra?: Partial<Act>): Act {
  return { k, ph: 'wind', t: wind, dur: wind, x: 0, y: 0, dx: 0, dy: 0, hit: false, n: 0, t2: 0, a: 0, spots: [], s: '', ...extra };
}

/* ------------------------------------------------------------------ */
/* 扩展状态                                                              */
/* ------------------------------------------------------------------ */
/** 震地冲击波（遗迹执守者）：从中心向外扩张，波前扫过玩家时结算一次 */
export interface Wave {
  x: number;
  y: number;
  r: number;
  maxR: number;
  spd: number;
  dmg: number;
  el: ElementId;
  hit: boolean;
}

/** 首领记忆：各技能冷却、上一招、使用次数（调试/测试）、冲击波、杂项计时 */
export interface BossMem {
  cds: Record<string, number>;
  last: string;
  used: Record<string, number>;
  waves: Wave[];
  /** 移速倍率（二阶段加速） */
  spdMul: number;
  /** 杂项计时器 */
  t1: number;
}

export interface EnemyExt {
  /** 上一步结束时的生命/护盾/仇恨：据此检测受击（护盾吸收兜底）与仇恨上升沿（呼叫同伴） */
  lastHp: number;
  lastShield: number;
  lastAggro: boolean;
  /** 强度倍率（召唤物继承召唤者） */
  mul: number;
  /** 脱战计时 */
  farT: number;
  /** 视线缓存（每 ~0.1s 刷新一次） */
  los: boolean;
  losT: number;
  /** 最后一次看见玩家的位置（玩家潜行时只能追到这里） */
  lkx: number;
  lky: number;
  /** 闲逛中心与当前闲逛目标 */
  homeX: number;
  homeY: number;
  wanderT: number;
  wx: number;
  wy: number;
  /** 卡住检测：采样计时、采样起点、期望位移累计、侧移自救剩余时间 */
  probeT: number;
  px: number;
  py: number;
  want: number;
  unstuckT: number;
  /** 当前动作 */
  act: Act | null;
  /** 通用计时器（各 AI 自定义含义） */
  t1: number;
  t2: number;
  t3: number;
  /** 子状态（迂回 AI 的阶段等）与其计时 */
  sub: number;
  subT: number;
  /** 护盾剩余时间（>0 时护盾归零视为“被打破”） */
  shieldT: number;
  /** 本步期望移动：单位方向 + 速度（世界单位/秒），由 applyMove 统一结算 */
  mx: number;
  my: number;
  mspd: number;
  /** 首领记忆（非首领为 null） */
  boss: BossMem | null;
  /** 死亡后已保留秒数（首领死亡保留给 world 检测） */
  deadT: number;
}

const EXT = new WeakMap<Enemy, EnemyExt>();

function newExt(e: Enemy): EnemyExt {
  return {
    // 出生即仇恨（精英/首领/召唤物/猎杀刷怪）不算“上升沿”，不会一出生就把整屋怪叫醒
    lastHp: e.hp, lastShield: e.shield, lastAggro: e.aggro, mul: 1,
    farT: 0, los: false, losT: 0, lkx: e.x, lky: e.y,
    homeX: e.x, homeY: e.y, wanderT: 0.5 + (e.id % 7) * 0.3, wx: e.x, wy: e.y,
    probeT: 0, px: e.x, py: e.y, want: 0, unstuckT: 0,
    act: null, t1: 0, t2: 0, t3: 0, sub: 0, subT: 0, shieldT: 0,
    mx: 0, my: 0, mspd: 0, boss: null, deadT: 0,
  };
}

/** 取怪物的扩展状态（不存在时按默认值创建，所以测试里手搓的 Enemy 也能直接用） */
export function ext(e: Enemy): EnemyExt {
  let x = EXT.get(e);
  if (!x) {
    x = newExt(e);
    EXT.set(e, x);
  }
  return x;
}

export function bossMem(x: EnemyExt): BossMem {
  if (!x.boss) x.boss = { cds: {}, last: '', used: {}, waves: [], spdMul: 1, t1: 0 };
  return x.boss;
}

/** 本步感知到的目标：known=知道玩家在哪（潜行时只能追到最后见到的位置） */
export interface Tgt {
  x: number;
  y: number;
  d: number;
  known: boolean;
  los: boolean;
}

/* ------------------------------------------------------------------ */
/* 表现小工具                                                            */
/* ------------------------------------------------------------------ */
export function elemColor(el: ElementId): string {
  return ELEM[el]?.c ?? '#fff3dd';
}

export const EL_SFX: Record<ElementId, SfxName> = {
  physical: 'swing', fire: 'fire', ice: 'ice', lightning: 'zap', poison: 'poison', arcane: 'arcane', tech: 'tech',
};

export function sfx(name: SfxName, x: number, y: number, vol?: number): void {
  emit({ t: 'sfx', name, x, y, vol });
}

/** 切换动画状态（变化时重置 animT） */
export function setAnim(e: Enemy, a: AnimState): void {
  if (e.anim !== a) {
    e.anim = a;
    e.animT = 0;
  }
}

/** 朝向某点：facing 只看水平分量（1 右 / -1 左），aim 为精确角度 */
export function faceTo(e: Enemy, x: number, y: number): void {
  const dx = x - e.x, dy = y - e.y;
  if (Math.abs(dx) > 0.5) e.facing = dx > 0 ? 1 : -1;
  if (dx !== 0 || dy !== 0) e.aim = Math.atan2(dy, dx);
}

/** 前摇预警：怪物脚下扩张的环 */
export function telegraph(e: Enemy, dur: number, color = WARN_COLOR, grow = 16): void {
  emit({ t: 'ring', x: e.x, y: e.y, r0: e.r * 0.6, r1: e.r + grow, color, dur: Math.max(0.1, dur) });
}

/** 地面范围预警（落点/冲击范围）：近乎静止的圈，持续 dur 秒 */
export function warnArea(x: number, y: number, r: number, dur: number, color = WARN_COLOR): void {
  emit({ t: 'ring', x, y, r0: r * 0.9, r1: r, color, dur: Math.max(0.1, dur) });
}

/** 前摇闪光：每 0.12s 闪一下白（复用 Actor.flash，渲染层按受击闪白画） */
export function blink(e: Enemy, a: Act, dt: number): void {
  a.t2 -= dt;
  if (a.t2 <= 0) {
    a.t2 = 0.12;
    e.flash = Math.max(e.flash, 0.05);
  }
}
