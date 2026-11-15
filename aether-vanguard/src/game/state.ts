// 全局游戏状态（对应 legacy G）。模拟层唯一的“真相来源”，渲染/UI 只读。

import type { GridMap } from '../world/grid';
import type { FlowField } from '../world/flowfield';
import type { Decor, Drop, Enemy, FxEvent, Hazard, Item, Npc, Player, Portal, Projectile } from './types';

export type GameMode = 'title' | 'play' | 'dead';
export type SceneKind = 'city' | 'dungeon' | 'arena';

export interface InputState {
  /** 移动方向（已归一化，键盘或虚拟摇杆） */
  mx: number;
  my: number;
  /** 鼠标世界坐标 */
  aimX: number;
  aimY: number;
  /** 是否有有效鼠标/右摇杆瞄准（触屏无瞄准时走软锁定） */
  hasAim: boolean;
  /** 按住攻击（左键） */
  attack: boolean;
  /** 本帧触发的动作（模拟层消费后清空） */
  pressed: Set<'q' | 'e' | 'r' | 'ult' | 'dash' | 'interact' | 'potionHp' | 'potionMp'>;
}

export interface SpawnerState {
  /** 当前存活上限（随层数增长） */
  cap: number;
  /** 刷新计时 */
  t: number;
  /** 本层已刷出的总数 */
  total: number;
  /** 可用怪物池 */
  pool: string[];
  /** 强度倍率 */
  mul: number;
  /** 怪物等级基准 */
  lv: number;
}

export interface GameState {
  mode: GameMode;
  scene: SceneKind;
  /** 模拟时间（暂停时不走） */
  time: number;
  /** 表现时间（一直走，用于动画） */
  realTime: number;
  player: Player | null;
  map: GridMap | null;
  flow: FlowField | null;
  enemies: Enemy[];
  projectiles: Projectile[];
  hazards: Hazard[];
  drops: Drop[];
  npcs: Npc[];
  portals: Portal[];
  decor: Decor[];
  boss: Enemy | null;
  /** 当前副本 id 与层号（主城为 0） */
  dungeonId: string;
  floor: number;
  /** 当前地图主题（渲染层据此选色调/光照/装饰）：city / ruins / magma / frost / crypt / arena / secret */
  theme: string;
  spawner: SpawnerState | null;
  /** 刷怪候选点（mapgen 产出，世界坐标） */
  spawnPoints: Array<{ x: number; y: number }>;
  /** 地图种子（联机时各端一致） */
  seed: number;
  /** 打开的 DOM 面板（打开时单机暂停） */
  panel: string | null;
  paused: boolean;
  /** 自动攻击开关（改版意见 #20：默认关闭，左键攻击） */
  autoAttack: boolean;
  /** 当前存档槽 */
  slot: number;
  /** 当前商店货架（按 NPC 角色区分） */
  shops: Record<string, Item[]>;
  input: InputState;
  /** 一次性表现事件队列 */
  events: FxEvent[];
  /** 递增 id */
  nextId: number;
  /** 自动存档计时 */
  saveT: number;
  /** 当前可交互目标提示（渲染层显示 “F 交互”） */
  hint: { text: string; x: number; y: number } | null;
}

export function createInput(): InputState {
  return { mx: 0, my: 0, aimX: 0, aimY: 0, hasAim: false, attack: false, pressed: new Set() };
}

export const G: GameState = {
  mode: 'title',
  scene: 'city',
  time: 0,
  realTime: 0,
  player: null,
  map: null,
  flow: null,
  enemies: [],
  projectiles: [],
  hazards: [],
  drops: [],
  npcs: [],
  portals: [],
  decor: [],
  boss: null,
  dungeonId: 'ruins',
  floor: 0,
  theme: 'city',
  spawner: null,
  spawnPoints: [],
  seed: 1,
  panel: null,
  paused: false,
  autoAttack: false,
  slot: 0,
  shops: {},
  input: createInput(),
  events: [],
  nextId: 1,
  saveT: 0,
  hint: null,
};

export const nextId = (): number => G.nextId++;

/** 推送表现事件（上限保护，防止暂停时堆积） */
export function emit(e: FxEvent): void {
  if (G.events.length < 600) G.events.push(e);
}

/** 便捷：飘字 */
export function floater(x: number, y: number, text: string | number, color = '#fff3dd', size = 11, crit = false): void {
  emit({ t: 'floater', x, y, text: String(text), color, size, crit });
}

/** 便捷：提示条 */
export function toast(text: string, color?: string): void {
  emit({ t: 'toast', text, color });
}

/** 清空关卡实体（切场景时） */
export function clearWorld(): void {
  G.enemies.length = 0;
  G.projectiles.length = 0;
  G.hazards.length = 0;
  G.drops.length = 0;
  G.npcs.length = 0;
  G.portals.length = 0;
  G.decor.length = 0;
  G.boss = null;
  G.spawner = null;
  G.spawnPoints = [];
  G.hint = null;
  G.flow = null;
}
