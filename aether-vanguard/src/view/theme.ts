// 场景主题：统一“世界色温”（改版文档 §1.3：主城/迷宫/熔核三段配色彼此不协调）。
// tint 乘到地面与墙体；ambient 为 Phaser 光照环境色；particles 为氛围飘屑。

export interface ThemeDef {
  /** 地面/墙体乘色 */
  tint: number;
  /** 光照环境色（越暗越依赖火把/技能光） */
  ambient: number;
  /** 玩家随身光：半径 / 颜色 / 强度 */
  playerLight: [number, number, number];
  /** 氛围粒子：贴图 key、颜色、数量、方向（'up' 上飘 / 'down' 下落 / 'drift' 漂浮） */
  particles?: { tex: string; tint: number; count: number; dir: 'up' | 'down' | 'drift' };
  /** 辉光阈值与强度 */
  bloom: [number, number];
  /** 暗角强度 */
  vignette: number;
  /** 迷雾颜色（未探索） */
  fog: string;
  /** 小地图/背景底色 */
  bg: string;
}

export const THEMES: Record<string, ThemeDef> = {
  city: {
    tint: 0xffffff, ambient: 0xc8beb0, playerLight: [220, 0xfff0d8, 0.6],
    particles: { tex: 'pt_leaf', tint: 0xffffff, count: 14, dir: 'drift' },
    bloom: [0.82, 0.35], vignette: 0.22, fog: '#0b0907', bg: '#1d2a18',
  },
  ruins: {
    tint: 0xfff4e8, ambient: 0x6a6276, playerLight: [270, 0xffe6c0, 1.2],
    particles: { tex: 'px', tint: 0xc8b89a, count: 22, dir: 'drift' },
    bloom: [0.74, 0.32], vignette: 0.3, fog: '#07060a', bg: '#0d0a0f',
  },
  magma: {
    tint: 0xffc8a8, ambient: 0x76463a, playerLight: [260, 0xffc890, 1.1],
    particles: { tex: 'pt_fire', tint: 0xffffff, count: 26, dir: 'up' },
    bloom: [0.7, 0.4], vignette: 0.32, fog: '#0c0504', bg: '#140806',
  },
  frost: {
    tint: 0xc8e0ff, ambient: 0x5a6884, playerLight: [270, 0xd8ecff, 1.15],
    particles: { tex: 'pt_snow', tint: 0xffffff, count: 34, dir: 'down' },
    bloom: [0.72, 0.36], vignette: 0.3, fog: '#05070c', bg: '#080b12',
  },
  crypt: {
    tint: 0xd0bce8, ambient: 0x4a405e, playerLight: [250, 0xe6d8ff, 1.25],
    particles: { tex: 'px', tint: 0xa0e0a0, count: 18, dir: 'up' },
    bloom: [0.7, 0.4], vignette: 0.34, fog: '#06040a', bg: '#0b0810',
  },
  arena: {
    tint: 0xffe8d0, ambient: 0x86705a, playerLight: [240, 0xfff0d8, 1.0],
    particles: { tex: 'pt_spark', tint: 0xffd070, count: 14, dir: 'up' },
    bloom: [0.74, 0.34], vignette: 0.3, fog: '#0b0907', bg: '#120d08',
  },
  secret: {
    tint: 0xd8ffe0, ambient: 0x4a6658, playerLight: [260, 0xd8ffe8, 1.2],
    particles: { tex: 'pt_spark', tint: 0x9affc8, count: 22, dir: 'drift' },
    bloom: [0.7, 0.42], vignette: 0.32, fog: '#040806', bg: '#060c09',
  },
};

export function themeOf(id: string): ThemeDef {
  return THEMES[id] ?? THEMES.ruins;
}

/** 元素色（技能/投射物/光源） */
export const ELEM_COLOR: Record<string, number> = {
  physical: 0xf0e2c4, fire: 0xff8a3a, ice: 0x8fe0ff, lightning: 0xffe36a, poison: 0x9fe06a, arcane: 0xc9a2f0, tech: 0x7fe6d4,
};
