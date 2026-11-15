// 副本表（改版意见：主城传送阵去往不同副本；每个副本 3 层，第 3 层为首领层；秘境为单层短副本）。
// 怪物等级 = 副本推荐等级 + (层-1)×2 + rng(0..2)，不再跟随玩家等级缩放（改版意见：怪物加等级）。
// 怪物 kind 引用 data/enemies.ts（新怪由 enemies 代理补充；缺失的 kind 在 world.ts 里会安全回落）。

import { LORE } from './lore';

export type DungeonTheme = 'ruins' | 'magma' | 'frost' | 'crypt' | 'secret';

export interface DungeonDef {
  id: string;
  name: string;
  /** 地面主题（渲染层据此选瓦片/色调/光照） */
  theme: DungeonTheme;
  /** 每层怪物池（pools[floor-1]） */
  pools: string[][];
  /** 首领 kind（最后一层）；秘境里是“守关者”试炼的目标 */
  boss: string;
  /** 推荐等级（第 1 层怪物等级基准） */
  lv: number;
  desc: string;
  /** 层数（普通副本 3，秘境 1） */
  floors: number;
  /** 主题色（传送阵、横幅、地图标记） */
  color: string;
}

export const DUNGEONS: Record<string, DungeonDef> = {
  ruins: {
    id: 'ruins', name: '遗迹迷宫', theme: 'ruins', lv: 1, floors: 3, boss: 'warden', color: '#d8b48a',
    pools: [
      ['slime', 'goblin', 'bat', 'tiny_zombie'],
      ['goblin', 'bat', 'skeleton', 'eye', 'masked_orc'],
      ['skeleton', 'eye', 'orc_warrior', 'orc_shaman', 'golem'],
    ],
    desc: LORE.dungeons.ruins,
  },
  magma: {
    id: 'magma', name: '熔核裂隙', theme: 'magma', lv: 12, floors: 3, boss: 'boss', color: '#ff8a4a',
    pools: [
      ['wisp', 'spark', 'goblin', 'bat'],
      ['wisp', 'spark', 'venom', 'masked_orc', 'brute'],
      ['wisp', 'spark', 'orc_warrior', 'orc_shaman', 'brute'],
    ],
    desc: LORE.dungeons.magma,
  },
  frost: {
    id: 'frost', name: '霜寂深渊', theme: 'frost', lv: 22, floors: 3, boss: 'lich', color: '#8fd8f0',
    pools: [
      ['frost', 'bat', 'skeleton', 'eye'],
      ['frost', 'zombie', 'orc_warrior', 'necromancer'],
      ['frost', 'shade', 'golem', 'necromancer'],
    ],
    desc: LORE.dungeons.frost,
  },
  crypt: {
    id: 'crypt', name: '幽影墓穴', theme: 'crypt', lv: 32, floors: 3, boss: 'shadow_lord', color: '#b08ad8',
    pools: [
      ['zombie', 'skeleton', 'shade', 'venom'],
      ['shade', 'necromancer', 'muddy', 'masked_orc'],
      ['shade', 'brute', 'golem', 'necromancer', 'orc_shaman'],
    ],
    desc: LORE.dungeons.crypt,
  },
  secret: {
    id: 'secret', name: '秘境·试炼回廊', theme: 'secret', lv: 8, floors: 1, boss: 'golem', color: '#f0d070',
    pools: [['goblin', 'skeleton', 'masked_orc', 'eye', 'orc_warrior', 'shade', 'spark']],
    desc: LORE.dungeons.secret,
  },
};

/** 主线副本顺序（决定剧情残页编号与全局进度 bestFloor） */
export const DUNGEON_ORDER: readonly string[] = ['ruins', 'magma', 'frost', 'crypt'];

/** 全局层号：遗迹 1–3、熔核 4–6、霜寂 7–9、墓穴 10–12；秘境/未知返回 0 */
export function globalFloor(id: string, floor: number): number {
  const i = DUNGEON_ORDER.indexOf(id);
  return i < 0 ? 0 : i * 3 + Math.max(1, Math.min(3, floor));
}

/** 秘境等级跟随主线进度（不是角色等级）：已到达的最深一层的怪物等级 + 2 */
export function secretLevel(bestFloor: number): number {
  const g = Math.max(1, Math.floor(bestFloor) || 1);
  const order = Math.min(DUNGEON_ORDER.length - 1, Math.floor((g - 1) / 3));
  const f = ((g - 1) % 3) + 1;
  const def = DUNGEONS[DUNGEON_ORDER[order]];
  return Math.max(DUNGEONS.secret.lv, def.lv + (f - 1) * 2 + 2);
}

/** 某层怪物等级基准（不含 0..2 的随机浮动）；bestFloor 仅用于秘境 */
export function floorBaseLevel(id: string, floor: number, bestFloor = 1): number {
  if (id === 'secret') return secretLevel(bestFloor);
  const def = DUNGEONS[id];
  if (!def) return 1;
  return def.lv + (Math.max(1, floor) - 1) * 2;
}

/** 某层的怪物池（越界时取最后一层） */
export function floorPool(id: string, floor: number): string[] {
  const def = DUNGEONS[id];
  if (!def) return [];
  return def.pools[Math.max(0, Math.min(def.pools.length - 1, floor - 1))] ?? [];
}

/* ------------------------------------------------------------------ */
/* 秘境试炼（改版意见：短副本，限定条件战斗，完成后拿特殊遗物、金币）     */
/* ------------------------------------------------------------------ */
export type TrialKind = 'hunt' | 'elite' | 'guardian';

export interface TrialDef {
  id: TrialKind;
  name: string;
  desc: string;
  /** 限时（秒） */
  time: number;
  /** 目标数量（击杀数 / 精英数 / 守关者数） */
  goal: number;
  /** 金币奖励基数（实际 = gold × (1 + 等级×0.08)） */
  gold: number;
}

export const TRIALS: TrialDef[] = [
  { id: 'hunt', name: '限时歼灭', desc: '在 120 秒内击败 30 个敌人，敌人会源源不断地涌来。', time: 120, goal: 30, gold: 300 },
  { id: 'elite', name: '精英讨伐', desc: '在 150 秒内找到并击败 3 名精英守卫。', time: 150, goal: 3, gold: 360 },
  { id: 'guardian', name: '守关者', desc: '在 180 秒内击败盘踞在回廊深处的守关者。', time: 180, goal: 1, gold: 420 },
];
