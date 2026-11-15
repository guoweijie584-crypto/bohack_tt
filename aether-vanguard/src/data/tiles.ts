// 数据移植自 legacy index(1).html（源能斗士 II），行号见各段注释。改数值请保持 id 不变以兼容存档。
// L539-542；新增 PATH（主城石板路）、BLOCK（不可见实心占位：建筑/树/雕像的碰撞脚印，渲染层不画墙）、
// BRIDGE（可走的桥）、PIT（深坑，阻挡移动但不挡视线与投射物）。
export const T = {
  VOID: 0, WALL: 1, FLOOR: 2, CITY: 3, GRASS: 4, WATER: 5, EXIT: 6, LAVA: 7, RUIN: 8, DECO: 9,
  PATH: 10, BLOCK: 11, BRIDGE: 12, PIT: 13,
} as const;
export type TileId = (typeof T)[keyof typeof T];
/** legacy 底色（小地图/大地图配色仍沿用） */
export const TILE_BASE: Record<number, string> = {
  0: '#20170f', 1: '#8a6747', 2: '#6f5339', 3: '#bd9a6e', 4: '#7c9660', 5: '#4f8a9e',
  6: '#8fc07a', 7: '#c2623c', 8: '#93775a', 9: '#6f5339', 10: '#a88a62', 11: '#5b4a3a', 12: '#9a7a52', 13: '#120c08',
};
/** 阻挡移动 */
export const SOLID: Record<number, boolean> = { 0: true, 1: true, 5: true, 7: true, 11: true, 13: true };
/** 阻挡视线与投射物 */
export const OPAQUE: Record<number, boolean> = { 0: true, 1: true };
