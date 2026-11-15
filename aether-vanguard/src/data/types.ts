// 游戏数据的类型定义（与 legacy 数据表一一对应）

export type ElementId = 'physical' | 'fire' | 'ice' | 'lightning' | 'poison' | 'arcane' | 'tech';
export interface ElementDef { n: string; c: string }

export type StatusId = 'burn' | 'freeze' | 'shock' | 'poison' | 'slow';
export interface StatusDef { n: string; c: string }

export type WeaponType = 'sword' | 'staff' | 'bow' | 'dagger';

export interface ClassDef {
  id: string;
  name: string;
  en: string;
  icon: string;
  tag?: string;
  core?: string;
  element: ElementId;
  weapon: WeaponType;
  hp: number;
  mp: number;
  atk: number;
  armor: number;
  spd: number;
  crit: number;
  range: number;
  atkCd: number;
  color: string;
  hair?: string;
  desc: string;
  from?: [string, string];
}
export interface FusionDef extends ClassDef { from: [string, string] }

export type SkillKind =
  | 'cleave' | 'charge' | 'buff' | 'shot' | 'meteor' | 'nova' | 'multi'
  | 'trap' | 'chain' | 'beam' | 'aura' | 'meteors';

export interface SkillDef {
  key: 'Q' | 'E' | 'R';
  n: string;
  i: string;
  cd: number;
  cost: number;
  kind: SkillKind;
  mult: number;
  el: ElementId;
  d: string;
}
export interface UltDef {
  n: string;
  i: string;
  cd: number;
  cost: number;
  kind: SkillKind;
  mult: number;
  el: ElementId;
}

export type EffKey =
  | 'atk' | 'range' | 'pen' | 'shield' | 'armor' | 'hp' | 'burn' | 'elemDur' | 'skillDmg'
  | 'crit' | 'pierce' | 'cdr' | 'spd' | 'freeze' | 'chain' | 'shock' | 'mpRegen' | 'knock'
  | 'stealth' | 'poison' | 'slow' | 'lifesteal' | 'elemPen' | 'mpOnHit';
export type EffMap = Partial<Record<EffKey, number>>;

export interface TreeNode { n: string; d: string; eff: EffMap; ult: string | null }
export interface TreeBranch { n: string; nodes: TreeNode[] }
export interface ClassTree { A: TreeBranch; B: TreeBranch }

export type RouteId = 'magic' | 'tech';
export interface RouteDef {
  id: RouteId;
  name: string;
  en: string;
  icon: string;
  color: string;
  desc: string;
  mpRegen: number;
  skillDmg: number;
  cdMul: number;
  pierce: number;
  spdMul: number;
  nodes: TreeNode[];
}

/** legacy AI + 改版意见新增的 flank（迂回）/ summoner（召唤）/ shield（护盾） */
export type AiType = 'chase' | 'shooter' | 'charger' | 'boss' | 'rival' | 'flank' | 'summoner' | 'shield';

export interface EnemyDef {
  n: string;
  hp: number;
  atk: number;
  spd: number;
  armor: number;
  exp: number;
  gold: number;
  r: number;
  el: ElementId;
  weak: ElementId;
  /** legacy 绘制类型（slime/goblin/bat/eye/golem/wisp/boss），新版用 sprite 字段映射素材 */
  s: string;
  c: string;
  ai: AiType;
  range?: number;
  elite?: boolean;
  boss?: boolean;
  /** 新版外观：0x72 精灵基名（如 'goblin'、'big_demon'）或程序化精灵（'proc_eye' 等） */
  sprite?: string;
  /** 换色（乘色 tint，0xRRGGBB） */
  tint?: number;
  /** 显示缩放（在 ART 基础上再乘） */
  scale?: number;
  /** 飞行单位（无脚底影子贴地、可越过深坑/水面） */
  flying?: boolean;
  /** 召唤 AI 可召唤的怪物 kind */
  summons?: string[];
  /** 护盾 AI 的护盾值（占最大生命比例） */
  shieldPct?: number;
  /** 首领专属技能组 id（渲染/AI 用） */
  bossKit?: string;
  /** 图鉴描述 */
  desc?: string;
}

export interface RarityDef { n: string; c: string; mul: number }
export type SlotId = 'weapon' | 'armor' | 'trinket';
export type AffixKey = 'atk' | 'armor' | 'hp' | 'crit' | 'cdr' | 'spd';
export interface AffixDef { k: AffixKey; n: string; min: number; max: number }
