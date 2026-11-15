// 全局常量。世界坐标沿用 legacy 单位：1 格 = 32 世界单位，保证移植来的射程/速度/半径数值不用换算。

/** 每格世界单位 */
export const TILE = 32;
/** 期望可见的最小世界范围（legacy 640×400，约 20×12.5 格） */
export const VIEW_W = 640;
export const VIEW_H = 400;
/** 固定模拟步长（秒） */
export const SIM_DT = 1 / 60;
/** 单帧最多补几步模拟，防止掉帧后“死亡螺旋” */
export const SIM_MAX_STEPS = 5;
/** 存档 key 前缀（v3 = 引擎重制版；会尝试迁移 legacy v2/v1 存档） */
export const SAVE_PREFIX = 'aether_vanguard_v3';
export const LEGACY_SAVE_KEYS = ['aether_vanguard_save_v2', 'aether_vanguard_save_v1'];

/** 迷宫层数（改版意见 #11：改成 3 层，第 3 层为首领层） */
export const DUNGEON_FLOORS = 3;
/** 背包格子上限（改版意见 #21） */
export const BAG_SLOTS = 24;
/** 仓库格子上限（新手村存储箱） */
export const STASH_SLOTS = 48;
/** 等级上限 */
export const MAX_LEVEL = 50;

/** 深度分层：同一层内按脚底 y 排序 */
export const DEPTH = {
  floor: 0,
  floorDecal: 5,
  shadow: 8,
  /** y 排序对象：DEPTH.sorted + y */
  sorted: 100,
  overFx: 1_000_000,
  floaters: 1_100_000,
  worldUi: 1_200_000,
} as const;
