// 模拟层实体类型。约定：
// - 模拟层（src/game、src/world）只读写这些纯数据，不碰 Phaser；
// - 渲染层（src/view）按 id 同步精灵，一次性特效通过 FxEvent 队列传递；
// - 速度单位统一为 世界单位/秒（legacy 敌人速度是“每帧像素”，移植时 ×60）。

import type { ElementId, EnemyDef, RouteId, SkillKind, SlotId, AffixKey, StatusId } from '../data/types';
import type { Body } from '../world/collision';

export type Team = 'player' | 'enemy';
export type AnimState = 'idle' | 'run' | 'attack' | 'cast' | 'hurt' | 'dead';

/** 状态效果：持续时间 + 层数（改版意见 #16：叠层有上限，DoT 施加时快照伤害） */
export interface StatusSlot {
  t: number;      // 剩余秒
  stacks: number; // 当前层数
  dps: number;    // 每层每秒伤害（施加时快照）
  /** 迟缓强度 0-1（缺省 0.45） */
  mag?: number;
}
export type StatusMap = Partial<Record<StatusId | 'stun', StatusSlot>>;

export interface Actor extends Body {
  id: number;
  team: Team;
  hp: number;
  maxHp: number;
  /** 朝向：1 右 / -1 左（渲染用） */
  facing: 1 | -1;
  /** 瞄准/攻击角度（弧度） */
  aim: number;
  /** 当前速度（渲染判断 run/idle、残影用） */
  vx: number;
  vy: number;
  /** 击退速度（每秒衰减） */
  kx: number;
  ky: number;
  status: StatusMap;
  /** 受击闪白剩余秒 */
  flash: number;
  /** 渲染动画提示 */
  anim: AnimState;
  /** 动画状态已持续秒数（attack/cast 等一次性动作用） */
  animT: number;
  dead: boolean;
  /** 高度（跳跃/击飞，渲染时上移 + 影子缩放） */
  z: number;
}

export interface ItemAffix { k: AffixKey; n: string; v: number }

export interface Item {
  /** 字符串 uid（legacy 数字 id 读档后会撞号） */
  uid: string;
  slot: SlotId;
  rarity: number;
  affixes: ItemAffix[];
  lv: number;
  name: string;
  value: number;
  /** 铁匠强化等级 */
  plus: number;
  /** 外观：武器/护甲/饰品的精灵 key（装备显示在人物身上） */
  sprite: string;
  /** 武器类型（决定普攻形态）；护甲/饰品为 undefined */
  weaponType?: 'sword' | 'staff' | 'bow' | 'dagger';
  /** 商店价格（货架物品） */
  cost?: number;
}

export type MaterialId = 'gem' | 'part' | 'essence';

export interface PlayerStats {
  atk: number; armor: number; maxHp: number; maxMp: number; spd: number; crit: number; cdr: number;
  range: number; atkCd: number; weapon: 'sword' | 'staff' | 'bow' | 'dagger'; element: ElementId;
  mpRegen: number; hpRegen: number; skillDmg: number; elemDur: number; elemPen: number; pen: number;
  pierce: number; chain: number; shield: number; knock: number; lifesteal: number; mpOnHit: number;
  burn: number; freeze: number; shock: number; poison: number; slow: number; stealth: number;
  /** 汇总的技能树/路线效果（原始 eff 值） */
  eff: Record<string, number>;
}

export interface Player extends Actor {
  team: 'player';
  /** 角色名（多角色槽） */
  name: string;
  cid: string;
  route: RouteId;
  mp: number;
  lv: number;
  exp: number;
  expNext: number;
  /** 属性点 / 技能点 */
  sp: number;
  tp: number;
  stats: { str: number; agi: number; int: number; vit: number };
  /** 技能树：tree[cid] = {A: 已点数, B: 已点数} */
  tree: Record<string, { A: number; B: number }>;
  /** 路线树分开计数（legacy 共用一个计数是 bug） */
  routeTree: Record<RouteId, number>;
  ultList: string[];
  ult: string | null;
  gold: number;
  kills: number;
  bossKills: number;
  deaths: number;
  playTime: number;
  bestFloor: number;
  fragments: number[];
  /** 已融合到的职业 id（改版意见：融合一次） */
  fusedFrom: string | null;
  equip: Record<SlotId, Item | null>;
  bag: Item[];
  stash: Item[];
  potions: { hp: number; mp: number };
  mats: Record<MaterialId, number>;
  cd: { q: number; e: number; r: number; ult: number; dash: number; atk: number };
  buffs: { shield: number; shieldT: number; roar: number; stealth: number; field: number; overload: number };
  invuln: number;
  /** 距上次受伤的秒数（脱战回血、战斗状态判定） */
  hurtT: number;
  /** 距上次攻击/施法的秒数 */
  actT: number;
  arenaWins: number;
  streak: number;
  bestStreak: number;
  stat: PlayerStats;
  /** 冲刺中（插值位移）剩余秒与速度 */
  dashT: number;
  dashVx: number;
  dashVy: number;
}

export type AiState = 'idle' | 'chase' | 'attack' | 'windup' | 'charge' | 'retreat' | 'strafe' | 'summon' | 'shield' | 'flank';

export interface Enemy extends Actor {
  team: 'enemy';
  kind: string;
  def: EnemyDef;
  /** 怪物等级（改版意见：怪物加等级，高等级多重血条） */
  lv: number;
  atk: number;
  armor: number;
  spd: number;
  exp: number;
  gold: number;
  elite: boolean;
  boss: boolean;
  /** 血条层数（每层 maxHp/bars），渲染多重血条 */
  bars: number;
  /** 护盾 AI：当前护盾值 */
  shield: number;
  ai: AiState;
  aiT: number;
  cdAtk: number;
  cdSkill: number;
  cdSkill2: number;
  /** 绕行方向（迂回/扫射用） */
  orbitDir: 1 | -1;
  /** 是否已发现玩家（仇恨），脱战会回到 idle */
  aggro: boolean;
  /** 二阶段（Boss） */
  phase: number;
  /** 镜像对手：职业与路线（使用玩家同一套技能） */
  rival?: { cid: string; route: RouteId; cdQ: number; cdE: number; cdR: number };
  /** 镜像对手的增益（过载/潜行），渲染层用于半透明等表现 */
  buffs?: { overload: number; stealth: number };
  /** 召唤者 id（召唤物死亡不掉落） */
  summonedBy?: number;
  /** 出生无敌/淡入 */
  spawnT: number;
}

export type ProjectileKind = 'arrow' | 'orb' | 'bolt' | 'shuriken' | 'dagger' | 'enemyOrb' | 'enemyArrow' | 'fireball' | 'iceShard';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  el: ElementId;
  life: number;
  pierce: number;
  homing: number;
  targetId: number;
  /** 已命中的 id，防止穿透时重复伤害 */
  hit: number[];
  splash: number;
  status?: StatusId;
  stun?: number;
  knock?: number;
  crit?: boolean;
  color: string;
  ownerId: number;
}

export type HazardKind = 'meteor' | 'aura' | 'trap' | 'zone' | 'iceField';

/** 伤害区域（与纯视觉特效分离；legacy effects 数组混用两者） */
export interface Hazard {
  id: number;
  kind: HazardKind;
  team: Team;
  x: number;
  y: number;
  r: number;
  /** 延迟生效（陨石预警） */
  delay: number;
  life: number;
  maxLife: number;
  /** 周期结算间隔与计时 */
  tick: number;
  tickT: number;
  dmg: number;
  el: ElementId;
  status?: StatusId;
  stun?: number;
  slow?: number;
  /** 跟随的实体 id（光环） */
  followId?: number;
  /** 视觉变体（rain/meteor/thunder/whirl/frost/venom/arcane 等） */
  style: string;
  ownerId: number;
  triggered?: boolean;
}

export type DropKind = 'exp' | 'gold' | 'hp' | 'mp' | 'item' | 'mat' | 'chest';

export interface Drop {
  id: number;
  kind: DropKind;
  x: number;
  y: number;
  /** 弹出高度动画 */
  z: number;
  vz: number;
  vx: number;
  vy: number;
  value: number;
  item?: Item;
  mat?: MaterialId;
  /** 宝箱品阶 0 小 / 1 中 / 2 大 */
  tier?: number;
  opened?: boolean;
  life: number;
}

export type NpcRole = 'gate' | 'route' | 'smith' | 'fuse' | 'scribe' | 'arena' | 'potion' | 'stash' | 'villager' | 'secret';

export interface Npc {
  id: number;
  role: NpcRole;
  name: string;
  line: string;
  x: number;
  y: number;
  r: number;
  sprite: string;
  facing: 1 | -1;
  /** 闲逛村民的游走目标 */
  wx?: number;
  wy?: number;
  wanderT?: number;
}

export type PortalKind = 'dungeon' | 'arena' | 'city' | 'next' | 'secret' | 'boss';

export interface Portal {
  id: number;
  kind: PortalKind;
  x: number;
  y: number;
  r: number;
  label: string;
  /** 是否可用（出口未开启时 false） */
  open: boolean;
  /** 目标参数（副本 id、层号等） */
  target?: string;
}

export interface Decor {
  id: number;
  kind: string;
  x: number;
  y: number;
  /** 发光装饰（火把、源能井、熔岩缝）：光源颜色/半径 */
  light?: { color: number; radius: number; intensity: number; flicker: boolean };
  /** 可破坏（木箱、罐子） */
  breakable?: boolean;
  hp?: number;
  /** 阻挡移动（柱子、树）——同时写入地图为墙格的不需要此字段 */
  solid?: boolean;
  /** 变体（帧 / 颜色） */
  v?: number;
}

/** 一次性表现事件：模拟层 push，渲染/音频层每帧消费后清空 */
export type FxEvent =
  /** team：发出方阵营（缺省视为玩家方；敌方攻击不会打碎木箱等可破坏物） */
  | { t: 'slash'; x: number; y: number; a: number; r: number; color: string; style: 'sword' | 'dagger' | 'heavy' | 'staff' | 'claw'; flip?: boolean; team?: Team }
  | { t: 'burst'; x: number; y: number; color: string; n: number; spd: number }
  | { t: 'ring'; x: number; y: number; r0: number; r1: number; color: string; dur: number; style?: string }
  | { t: 'beam'; x0: number; y0: number; x1: number; y1: number; w: number; el: ElementId; color: string; style?: string }
  /** 攻击预警（地面范围圈 / 冲锋路线），持续 dur 秒 */
  | { t: 'telegraph'; x: number; y: number; r: number; dur: number; shape: 'circle' | 'lane'; x1?: number; y1?: number; color?: string }
  | { t: 'chain'; pts: Array<[number, number]>; color: string }
  | { t: 'line'; x0: number; y0: number; x1: number; y1: number; color: string; w: number }
  | { t: 'impact'; x: number; y: number; el: ElementId; size: number }
  | { t: 'explosion'; x: number; y: number; r: number; el: ElementId; style?: string; team?: Team }
  | { t: 'floater'; x: number; y: number; text: string; color: string; size: number; crit?: boolean }
  | { t: 'shake'; amt: number }
  | { t: 'flash'; amt: number; color?: string }
  | { t: 'afterimage'; actorId: number }
  | { t: 'cast'; actorId: number; el: ElementId }
  | { t: 'spawn'; x: number; y: number; boss?: boolean }
  | { t: 'death'; x: number; y: number; color: string; big?: boolean; kind?: string }
  | { t: 'pickup'; x: number; y: number; kind: DropKind; color: string }
  | { t: 'levelup'; x: number; y: number }
  | { t: 'chestOpen'; id: number }
  | { t: 'sfx'; name: SfxName; x?: number; y?: number; vol?: number }
  | { t: 'toast'; text: string; color?: string }
  | { t: 'banner'; text: string; sub?: string; color?: string }
  | { t: 'ui'; what: 'hud' | 'skillbar' | 'panel' | 'minimap' | 'dead' | 'fuseReady' | 'map' }
  /** 模拟层请求打开某个 DOM 面板（NPC 交互、传送阵选择等）；arg 为附加参数（如 NPC 角色、传送阵 id） */
  | { t: 'openPanel'; panel: PanelName; arg?: string };

export type PanelName =
  | 'char' | 'bag' | 'skill' | 'fuse' | 'map' | 'lore' | 'help'
  | 'shop_potion' | 'shop_smith' | 'stash' | 'portal' | 'route' | 'arena' | 'secret' | 'dialog';

export type SfxName =
  | 'swing' | 'swingHeavy' | 'stab' | 'bow' | 'cast' | 'fire' | 'ice' | 'zap' | 'poison' | 'arcane' | 'tech'
  | 'hit' | 'crit' | 'hurt' | 'kill' | 'bossRoar' | 'explosion' | 'dash' | 'pickupCoin' | 'pickupExp'
  | 'pickupItem' | 'potion' | 'levelup' | 'chest' | 'portal' | 'door' | 'ui' | 'uiDeny' | 'buy' | 'forge'
  | 'shield' | 'stealth' | 'summon' | 'death' | 'victory' | 'step';

export type { SkillKind, StatusId, ElementId, RouteId };
