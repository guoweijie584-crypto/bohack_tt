// 数据移植自 legacy index(1).html（源能斗士 II），行号见各段注释。改数值请保持 id 不变以兼容存档。
import type { ElementDef, ElementId, StatusDef, StatusId } from './types';

// L324-330
export const ELEM: Record<ElementId, ElementDef> = {
 physical:{n:'物理',c:'#e8d6b4'},fire:{n:'火焰',c:'#ff9a55'},ice:{n:'冰霜',c:'#8fd8f0'},
 lightning:{n:'雷电',c:'#f6d76e'},poison:{n:'剧毒',c:'#a8d06a'},
 arcane:{n:'奥术',c:'#c9a2f0'},tech:{n:'机械',c:'#7fd6c4'}};
export const STATUS: Record<StatusId, StatusDef> = {
 burn:{n:'灼烧',c:'#ff9a55'},freeze:{n:'冻结',c:'#8fd8f0'},shock:{n:'感电',c:'#f6d76e'},
 poison:{n:'中毒',c:'#a8d06a'},slow:{n:'迟缓',c:'#b0b8c8'}};

/* ------------------------------------------------------------------ */
/* 元素克制与状态规则（combat 结算用，集中在这里方便调数值）              */
/* legacy L1167–1178 / L1367–1373；改版意见 #16：叠层有上限、DoT 施加时快照 */
/* ------------------------------------------------------------------ */

/** 克制倍率：攻击元素 = 目标弱点 */
export const ELEM_WEAK_MUL = 1.35;
/** 同元素抗性：攻击元素 = 目标自身元素 */
export const ELEM_SAME_MUL = 0.8;
/**
 * 不吃“同元素抗性”的元素。物理不是元素属性：legacy 中物理职业（战士/游侠/骑士/甲士）
 * 打 12 种怪里的 5 种（含最常见的源泥怪、掠夺者）都要 ×0.8，属于数值失调，这里豁免。
 */
export const SAME_RESIST_EXEMPT: readonly ElementId[] = ['physical'];

/** 灼烧/中毒：每层 dps = 施加者攻击 × (base + 天赋值 × per)，施加时快照；持续时间取 max 刷新 */
export interface DotRule { dur: number; maxStacks: number; base: number; per: number }
export const DOT_RULES: Record<'burn' | 'poison', DotRule> = {
  burn: { dur: 2.5, maxStacks: 3, base: 0.12, per: 0.15 },
  poison: { dur: 3.5, maxStacks: 5, base: 0.08, per: 0.12 },
};
/** 感电：护甲 ×armorMul */
export const SHOCK_RULE = { dur: 2, armorMul: 0.75 } as const;
/** 冰：迟缓（移速 ×(1-mag)）+ 几率冻结（完全定身） */
export const ICE_RULE = {
  slowDur: 2.5,
  slowMag: 0.45,
  slowMagMax: 0.7,
  freezeDur: 0.7,
  freezeChance: 0.18,
  /** 每点冰霜天赋（st.freeze）额外冻结几率 */
  freezeChancePer: 0.1,
  freezeChanceMax: 0.35,
} as const;
/** 玩家中异常时长倍率（legacy 玩家完全不中异常；新版会中，但只有 50%） */
export const PLAYER_STATUS_MUL = 0.5;

/** 控制规则：mul = 眩晕/冻结时长倍率，immune = 控制结束后的免控秒数（控制中不续时 = 递减） */
export interface CcRule { mul: number; immune: number }
export const CC_RULES: { boss: CcRule; elite: CcRule; player: CcRule } = {
  boss: { mul: 0.35, immune: 3 },
  elite: { mul: 0.6, immune: 1.5 },
  player: { mul: 0.6, immune: 2 },
};
/** 击退抗性（乘在初速度上） */
export const KNOCK_RESIST = { boss: 0.2, elite: 0.5 } as const;

/** 元素 → 法杖普攻/技能法球外形（ProjectileKind 子集） */
export const ELEM_ORB: Record<ElementId, 'fireball' | 'iceShard' | 'bolt' | 'orb'> = {
  physical: 'orb', fire: 'fireball', ice: 'iceShard', lightning: 'bolt', poison: 'orb', arcane: 'orb', tech: 'orb',
};
/** 元素 → 施法音效（SfxName 子集） */
export const ELEM_SFX: Record<ElementId, 'cast' | 'fire' | 'ice' | 'zap' | 'poison' | 'arcane' | 'tech'> = {
  physical: 'cast', fire: 'fire', ice: 'ice', lightning: 'zap', poison: 'poison', arcane: 'arcane', tech: 'tech',
};
