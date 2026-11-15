// combat 代理模块测试：combat / skills / projectiles / hazards（跨模块依赖用 vi.mock 打桩）
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

vi.mock('../src/game/player', async () => {
  const { SKILLS } = await import('../src/data/skills');
  return {
    gainExp: vi.fn(),
    skillsOf: vi.fn((p: { cid: string }) => SKILLS[p.cid] ?? []),
  };
});
vi.mock('../src/game/drops', () => ({ dropLoot: vi.fn() }));
vi.mock('../src/game/world', () => ({ enterCity: vi.fn(), leaveArena: vi.fn() }));
vi.mock('../src/game/save', () => ({ saveGame: vi.fn() }));

import { G, createInput } from '../src/game/state';
import type { Enemy, FxEvent, Player, PlayerStats } from '../src/game/types';
import { GridMap } from '../src/world/grid';
import { isFree } from '../src/world/collision';
import { computeFov } from '../src/world/los';
import { T } from '../src/data/tiles';
import { TILE } from '../src/config';
import { clsOf } from '../src/data/classes';
import { ENEMIES } from '../src/data/enemies';
import { SKILLS, ULTS } from '../src/data/skills';
import { rng } from '../src/core/rng';
import {
  applyStatus, ccImmuneT, damageEnemy, damagePlayer, isStunned, killEnemy, knockback, revive, rollDmg,
  speedMul, tickKnockback, tickStatus,
} from '../src/game/combat';
import {
  aimAngle, autoTarget, basicAttack, castByKind, castSkill, dash, resetCombatState, skillCooldown, tickDash,
} from '../src/game/skills';
import { spawnProjectile, updateProjectiles } from '../src/game/projectiles';
import { spawnHazard, updateHazards } from '../src/game/hazards';
import { gainExp } from '../src/game/player';
import { dropLoot } from '../src/game/drops';
import { enterCity, leaveArena } from '../src/game/world';

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

const C = (t: number): number => t * TILE + TILE / 2;
const DT = 1 / 60;

/** 用字符画建图：# 墙 . 地面 */
function mapFrom(rows: string[]): GridMap {
  const m = new GridMap(rows[0].length, rows.length, 'dungeon', T.WALL);
  rows.forEach((r, y) => [...r].forEach((c, x) => m.set(x, y, c === '#' ? T.WALL : T.FLOOR)));
  m.fog = false;
  return m;
}
/** 30×14 的空房间 */
const OPEN = Array.from({ length: 14 }, (_, y) => (y === 0 || y === 13 ? '#'.repeat(30) : '#' + '.'.repeat(28) + '#'));
/** 第 10 列整列是墙 */
const WALLED = OPEN.map((r, y) => (y === 0 || y === 13 ? r : r.slice(0, 10) + '#' + r.slice(11)));

let nid = 1000;
function mkStats(cid: string, over: Partial<PlayerStats> = {}): PlayerStats {
  const c = clsOf(cid);
  return {
    atk: c.atk, armor: 0, maxHp: c.hp, maxMp: c.mp, spd: c.spd, crit: 0, cdr: 0, range: c.range, atkCd: c.atkCd,
    weapon: c.weapon, element: c.element, mpRegen: 0, hpRegen: 0, skillDmg: 1, elemDur: 1, elemPen: 0, pen: 0,
    pierce: 0, chain: 2, shield: 1, knock: 1, lifesteal: 0, mpOnHit: 0, burn: 0, freeze: 0, shock: 0, poison: 0,
    slow: 0, stealth: 0, eff: {}, ...over,
  };
}
function mkPlayer(cid = 'warrior', over: Partial<PlayerStats> = {}, x = C(5), y = C(6)): Player {
  const stat = mkStats(cid, over);
  return {
    id: nid++, team: 'player', x, y, r: 11, hp: stat.maxHp, maxHp: stat.maxHp, facing: 1, aim: 0, vx: 0, vy: 0,
    kx: 0, ky: 0, status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
    name: '测试', cid, route: 'magic', mp: stat.maxMp, lv: 1, exp: 0, expNext: 65, sp: 0, tp: 0,
    stats: { str: 0, agi: 0, int: 0, vit: 0 }, tree: {}, routeTree: { magic: 0, tech: 0 }, ultList: [], ult: null,
    gold: 1000, kills: 0, bossKills: 0, deaths: 0, playTime: 0, bestFloor: 1, fragments: [], fusedFrom: null,
    equip: { weapon: null, armor: null, trinket: null }, bag: [], stash: [], potions: { hp: 0, mp: 0 },
    mats: { gem: 0, part: 0, essence: 0 }, cd: { q: 0, e: 0, r: 0, ult: 0, dash: 0, atk: 0 },
    buffs: { shield: 0, shieldT: 0, roar: 0, stealth: 0, field: 0, overload: 0 },
    invuln: 0, hurtT: 0, actT: 0, arenaWins: 0, streak: 0, bestStreak: 0, stat, dashT: 0, dashVx: 0, dashVy: 0,
  };
}
function mkEnemy(kind: string, x: number, y: number, over: Partial<Enemy> = {}): Enemy {
  const def = ENEMIES[kind];
  const e: Enemy = {
    id: nid++, team: 'enemy', x, y, r: def.r, hp: 10000, maxHp: 10000, facing: 1, aim: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
    kind, def, lv: 1, atk: def.atk, armor: 0, spd: def.spd * 60, exp: def.exp, gold: def.gold,
    elite: !!def.elite, boss: !!def.boss, bars: 1, shield: 0, ai: 'idle', aiT: 0, cdAtk: 0, cdSkill: 0,
    cdSkill2: 0, orbitDir: 1, aggro: false, phase: 1, spawnT: 0, ...over,
  };
  G.enemies.push(e);
  return e;
}
function aimAt(x: number, y: number): void {
  G.input.hasAim = true;
  G.input.aimX = x;
  G.input.aimY = y;
}
function events<K extends FxEvent['t']>(t: K): Array<Extract<FxEvent, { t: K }>> {
  return G.events.filter((e): e is Extract<FxEvent, { t: K }> => e.t === t);
}
function player(): Player {
  if (!G.player) throw new Error('no player');
  return G.player;
}
function steps(n: number, fn: () => void): void {
  for (let i = 0; i < n; i++) fn();
}

let rngSpy: MockInstance<() => number>;

beforeEach(() => {
  vi.clearAllMocks();
  resetCombatState();
  G.mode = 'play';
  G.scene = 'dungeon';
  G.panel = null;
  G.paused = false;
  G.time = 0;
  G.enemies.length = 0;
  G.projectiles.length = 0;
  G.hazards.length = 0;
  G.events.length = 0;
  G.map = mapFrom(OPEN);
  G.input = createInput();
  G.player = mkPlayer();
  // 默认掷骰 0.99：不暴击、不冻结、不闪避
  rngSpy = vi.spyOn(rng, 'next').mockReturnValue(0.99);
});
afterEach(() => {
  rngSpy.mockRestore();
});

/* ------------------------------------------------------------------ */
/* 掷骰与暴击                                                            */
/* ------------------------------------------------------------------ */

describe('rollDmg / 暴击', () => {
  it('普攻也能暴击：伤害 ×2，飘字显示的暴击与实际一致', () => {
    const p = mkPlayer('warrior', { crit: 0.5 });
    G.player = p;
    rngSpy.mockReturnValue(0.1);
    const r = rollDmg(p, 1, false);
    expect(r.crit).toBe(true);
    expect(r.dmg).toBeCloseTo(p.stat.atk * 2);

    const e = mkEnemy('slime', p.x + 40, p.y);
    aimAt(C(20), p.y);
    basicAttack(p);
    expect(e.hp).toBeCloseTo(10000 - p.stat.atk * 2);
    const fl = events('floater').find(f => f.crit);
    expect(fl?.text).toBe(String(p.stat.atk * 2));
  });

  it('技能伤害吃 skillDmg 与过载，普攻不吃', () => {
    const p = mkPlayer('storm', { skillDmg: 1.2 });
    p.buffs.overload = 5;
    expect(rollDmg(p, 2, true).dmg).toBeCloseTo(p.stat.atk * 2 * 1.2 * 1.45);
    expect(rollDmg(p, 2, false).dmg).toBeCloseTo(p.stat.atk * 2);
  });

  it('潜行：下一击必暴，直接命中后潜行结束', () => {
    const p = mkPlayer('assassin');
    G.player = p;
    p.buffs.stealth = 5;
    // 敌人面朝玩家（排除刺客背袭被动的干扰）
    const e = mkEnemy('slime', p.x + 30, p.y, { facing: -1 });
    aimAt(C(20), p.y);
    basicAttack(p);
    expect(e.hp).toBeCloseTo(10000 - p.stat.atk * 2);
    expect(p.buffs.stealth).toBe(0);
    // 潜行结束后不再必暴
    p.cd.atk = 0;
    basicAttack(p);
    expect(e.hp).toBeCloseTo(10000 - p.stat.atk * 3);
  });

  it('忍者冲刺后下一击必暴（窗口被消耗）', () => {
    const p = mkPlayer('ninja');
    G.player = p;
    dash(p);
    expect(rollDmg(p, 1, false).crit).toBe(true);
    expect(rollDmg(p, 1, false).crit).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 普攻                                                                 */
/* ------------------------------------------------------------------ */

describe('basicAttack 按武器类型分支', () => {
  it('sword：朝瞄准方向扇形劈砍，背后不中；三段连击，第三段 heavy ×1.3', () => {
    const p = player();
    const front = mkEnemy('slime', p.x + 50, p.y);
    const back = mkEnemy('slime', p.x - 50, p.y);
    aimAt(C(20), p.y);
    const styles: string[] = [];
    const hp: number[] = [];
    for (let i = 0; i < 3; i++) {
      p.cd.atk = 0;
      G.events.length = 0;
      const before = front.hp;
      basicAttack(p);
      const sl = events('slash')[0];
      styles.push(sl.style);
      hp.push(before - front.hp);
    }
    expect(styles).toEqual(['sword', 'sword', 'heavy']);
    expect(hp[0]).toBeCloseTo(p.stat.atk);
    expect(hp[2]).toBeCloseTo(p.stat.atk * 1.3);
    expect(back.hp).toBe(10000);
    expect(p.cd.atk).toBeCloseTo(p.stat.atkCd);
    expect(p.anim).toBe('attack');
    expect(p.facing).toBe(1);
  });

  it('sword：不打墙后的敌人', () => {
    G.map = mapFrom(WALLED);
    const p = mkPlayer('knight', {}, C(9), C(6)); // 骑士剑 range 120
    G.player = p;
    const behind = mkEnemy('slime', C(11), C(6));
    aimAt(C(20), p.y);
    basicAttack(p);
    expect(Math.hypot(behind.x - p.x, behind.y - p.y)).toBeLessThan(p.stat.range);
    expect(behind.hp).toBe(10000);
  });

  it('dagger：半角 0.6 的快速突刺，style dagger', () => {
    const p = mkPlayer('assassin');
    G.player = p;
    aimAt(C(20), p.y);
    const inFront = mkEnemy('slime', p.x + 40, p.y);
    const offAxis = mkEnemy('slime', p.x + Math.cos(1.0) * 45, p.y + Math.sin(1.0) * 45);
    basicAttack(p);
    expect(events('slash')[0].style).toBe('dagger');
    expect(inFront.hp).toBeLessThan(10000);
    expect(offAxis.hp).toBe(10000);
  });

  it('staff：按职业元素发射法球（速度 420、弱追踪 2.4、溅射 35）', () => {
    const cases: Array<[string, string]> = [['pyro', 'fireball'], ['cryo', 'iceShard'], ['storm', 'bolt']];
    for (const [cid, kind] of cases) {
      G.projectiles.length = 0;
      const p = mkPlayer(cid);
      G.player = p;
      aimAt(C(20), p.y);
      basicAttack(p);
      const q = G.projectiles[0];
      expect(q.kind).toBe(kind);
      expect(Math.hypot(q.vx, q.vy)).toBeCloseTo(420);
      expect(q.homing).toBeCloseTo(2.4);
      expect(q.splash).toBe(35);
      expect(q.team).toBe('player');
    }
  });

  it('staff：元素法师普攻在火焰与冰霜之间交替', () => {
    const p = mkPlayer('elemage');
    G.player = p;
    aimAt(C(20), p.y);
    basicAttack(p);
    p.cd.atk = 0;
    basicAttack(p);
    expect(G.projectiles.map(q => q.kind)).toEqual(['fireball', 'iceShard']);
  });

  it('bow：箭矢速度 560，穿透 = stat.pierce', () => {
    const p = mkPlayer('ranger', { pierce: 2 });
    G.player = p;
    aimAt(p.x, C(1)); // 向上射
    basicAttack(p);
    const q = G.projectiles[0];
    expect(q.kind).toBe('arrow');
    expect(Math.hypot(q.vx, q.vy)).toBeCloseTo(560);
    expect(q.pierce).toBe(2);
    expect(q.vy).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 伤害结算                                                              */
/* ------------------------------------------------------------------ */

describe('damageEnemy', () => {
  it('克制 ×1.35、同元素 ×0.8、物理不吃同元素抗性，克制飘字带 ✦', () => {
    const slime = mkEnemy('slime', C(8), C(6)); // 弱火、物理
    const wisp = mkEnemy('wisp', C(8), C(8)); // 火元素
    const goblin = mkEnemy('goblin', C(8), C(10)); // 弱冰、物理
    expect(damageEnemy(slime, 100, { el: 'fire' })).toBeCloseTo(135);
    expect(events('floater').some(f => f.text.endsWith('✦'))).toBe(true);
    expect(damageEnemy(wisp, 100, { el: 'fire' })).toBeCloseTo(80);
    expect(damageEnemy(goblin, 100, { el: 'fire' })).toBeCloseTo(100);
    expect(damageEnemy(goblin, 100, { el: 'physical' })).toBeCloseTo(100);
  });

  it('护甲与穿透：v = max(1, d×w − armor×(1−pen)×0.5)；elemPen 对元素伤害生效', () => {
    const e = mkEnemy('goblin', C(8), C(6), { armor: 40 });
    expect(damageEnemy(e, 100, { el: 'physical' })).toBeCloseTo(80);
    player().stat.pen = 0.5;
    expect(damageEnemy(e, 100, { el: 'physical' })).toBeCloseTo(90);
    expect(damageEnemy(e, 5, { el: 'physical' })).toBe(1);
    player().stat.pen = 0;
    player().stat.elemPen = 0.2;
    expect(damageEnemy(e, 100, { el: 'fire' })).toBeCloseTo(100);
    expect(damageEnemy(e, 100, { el: 'physical' })).toBeCloseTo(80);
  });

  it('敌人护盾先吸收并显示“护盾”飘字，未破盾时不吃异常', () => {
    const e = mkEnemy('golem', C(8), C(6), { shield: 50 });
    expect(damageEnemy(e, 30, { el: 'fire' })).toBe(0);
    expect(e.shield).toBeCloseTo(20);
    expect(e.hp).toBe(10000);
    expect(e.status.burn).toBeUndefined();
    expect(events('floater').some(f => f.text === '护盾')).toBe(true);
    expect(damageEnemy(e, 30, { el: 'fire' })).toBeCloseTo(10);
    expect(e.shield).toBe(0);
    expect(e.status.burn).toBeDefined();
  });

  it('状态叠层上限：灼烧 3 层、中毒 5 层，dps 施加时快照', () => {
    const p = player();
    const e = mkEnemy('golem', C(8), C(6));
    for (let i = 0; i < 6; i++) damageEnemy(e, 10, { el: 'fire' });
    for (let i = 0; i < 8; i++) damageEnemy(e, 10, { el: 'poison' });
    expect(e.status.burn?.stacks).toBe(3);
    expect(e.status.poison?.stacks).toBe(5);
    const burnDps = e.status.burn?.dps ?? 0;
    expect(burnDps).toBeCloseTo(p.stat.atk * 0.12);
    // 之后攻击力暴涨，已挂上的 DoT 不跟着变
    p.stat.atk *= 10;
    const hp0 = e.hp;
    const dot = tickStatus(e, 0.5);
    expect(e.status.burn?.dps).toBeCloseTo(burnDps);
    expect(dot).toBeCloseTo(burnDps * 3 * 0.5 + (p.stat.atk / 10) * 0.08 * 5 * 0.5);
    expect(hp0 - e.hp).toBeCloseTo(dot);
    // applyStatus 本身也遵守上限，且不会把已有层数降下来
    applyStatus(e, 'burn', 1, 1);
    expect(e.status.burn?.stacks).toBe(3);
  });

  it('DoT 致死会结算击杀', () => {
    const e = mkEnemy('slime', C(8), C(6), { hp: 1 });
    damageEnemy(e, 1, { el: 'fire', silent: true });
    e.hp = 0.5;
    tickStatus(e, 0.5);
    expect(e.dead).toBe(true);
    // 经验改由 dropLoot 掉落的经验球拾取获得（修复经验翻倍），DoT 致死同样走掉落
    expect(dropLoot).toHaveBeenCalledWith(e);
    expect(gainExp).not.toHaveBeenCalled();
  });

  it('击退只乘一次 st.knock（legacy 被平方），首领 ×0.2、精英 ×0.5', () => {
    const p = player();
    p.stat.knock = 2;
    const e = mkEnemy('slime', p.x + 40, p.y);
    damageEnemy(e, 10, { knock: 100, srcX: p.x, srcY: p.y });
    expect(Math.hypot(e.kx, e.ky)).toBeCloseTo(200);
    expect(e.kx).toBeGreaterThan(0);
    const boss = mkEnemy('boss', p.x + 80, p.y);
    damageEnemy(boss, 10, { knock: 100, srcX: p.x, srcY: p.y });
    expect(Math.hypot(boss.kx, boss.ky)).toBeCloseTo(40);
    const elite = mkEnemy('golem', p.x, p.y + 80);
    damageEnemy(elite, 10, { knock: 100, srcX: p.x, srcY: p.y });
    expect(Math.hypot(elite.kx, elite.ky)).toBeCloseTo(100);
  });

  it('tickKnockback：初速度/6 的总位移，指数衰减，撞墙不穿', () => {
    const e = mkEnemy('slime', C(5), C(6));
    knockback(e, e.x - 10, e.y, 600);
    const x0 = e.x;
    steps(240, () => tickKnockback(e, DT));
    expect(e.x - x0).toBeCloseTo(100, 0);
    expect(Math.hypot(e.kx, e.ky)).toBeLessThan(3);

    G.map = mapFrom(WALLED);
    const w = mkEnemy('slime', C(8), C(6));
    knockback(w, w.x - 10, w.y, 900);
    steps(240, () => tickKnockback(w, DT));
    expect(w.x).toBeLessThan(10 * TILE);
    expect(isFree(G.map, w.x, w.y, w.r)).toBe(true);
  });

  it('首领控制抗性：时长 ×0.35、控制中不续时、结束后 3s 免控；精英 ×0.6', () => {
    const boss = mkEnemy('boss', C(8), C(6));
    applyStatus(boss, 'stun', 1);
    expect(boss.status.stun?.t).toBeCloseTo(0.35);
    applyStatus(boss, 'stun', 2); // 控制中：不续时
    applyStatus(boss, 'freeze', 2);
    expect(boss.status.stun?.t).toBeCloseTo(0.35);
    expect(boss.status.freeze).toBeUndefined();
    tickStatus(boss, 0.4);
    expect(isStunned(boss)).toBe(false);
    expect(ccImmuneT(boss)).toBeCloseTo(3);
    applyStatus(boss, 'freeze', 1);
    expect(isStunned(boss)).toBe(false);
    tickStatus(boss, 3.1);
    applyStatus(boss, 'freeze', 1);
    expect(boss.status.freeze?.t).toBeCloseTo(0.35);

    const elite = mkEnemy('golem', C(8), C(9));
    applyStatus(elite, 'stun', 1);
    expect(elite.status.stun?.t).toBeCloseTo(0.6);
    const normal = mkEnemy('slime', C(8), C(11));
    applyStatus(normal, 'stun', 1);
    expect(normal.status.stun?.t).toBeCloseTo(1);
    expect(speedMul(normal)).toBe(0);
  });

  it('冰：迟缓 + 几率冻结', () => {
    const e = mkEnemy('goblin', C(8), C(6));
    damageEnemy(e, 10, { el: 'ice' });
    expect(e.status.slow).toBeDefined();
    expect(e.status.freeze).toBeUndefined();
    expect(speedMul(e)).toBeCloseTo(0.55);
    rngSpy.mockReturnValue(0.05);
    damageEnemy(e, 10, { el: 'ice' });
    expect(isStunned(e)).toBe(true);
  });

  it('killEnemy：经验 + 掉落 + 死亡事件；召唤物不掉落；首领横幅；不移除数组元素', () => {
    const p = player();
    const e = mkEnemy('slime', C(8), C(6), { hp: 5 });
    damageEnemy(e, 50);
    expect(e.dead).toBe(true);
    expect(e.anim).toBe('dead');
    // 普通怪：经验只通过经验球掉落获得，不在击杀时直接发放（避免与拾取重复）
    expect(gainExp).not.toHaveBeenCalled();
    expect(dropLoot).toHaveBeenCalledWith(e);
    expect(p.kills).toBe(1);
    expect(G.enemies).toContain(e);
    expect(events('death')[0].big).toBe(false);

    vi.clearAllMocks();
    const minion = mkEnemy('slime', C(8), C(8), { summonedBy: 1 });
    killEnemy(minion);
    expect(dropLoot).not.toHaveBeenCalled();
    // 召唤物不掉落，经验直接发放
    expect(gainExp).toHaveBeenCalledWith(p, minion.exp);

    const boss = mkEnemy('boss', C(12), C(6));
    killEnemy(boss);
    killEnemy(boss); // 幂等
    expect(p.bossKills).toBe(1);
    expect(events('banner').some(b => b.text.includes(ENEMIES.boss.n))).toBe(true);
    expect(events('death').some(d => d.big)).toBe(true);
  });

  it('职业被动：火法对灼烧目标 +15%，刺客背袭 +40%，铁血残血增伤', () => {
    const pyro = mkPlayer('pyro');
    G.player = pyro;
    const e = mkEnemy('goblin', C(8), C(6));
    damageEnemy(e, 100, { el: 'fire' }); // 挂上灼烧
    expect(damageEnemy(e, 100, { el: 'physical' })).toBeCloseTo(115);

    const asn = mkPlayer('assassin');
    G.player = asn;
    const facingRight = mkEnemy('goblin', C(10), C(6), { facing: 1 });
    expect(damageEnemy(facingRight, 100, { el: 'physical', srcX: C(9), srcY: C(6) })).toBeCloseTo(140);
    expect(damageEnemy(facingRight, 100, { el: 'physical', srcX: C(11), srcY: C(6) })).toBeCloseTo(100);

    const arm = mkPlayer('armored');
    G.player = arm;
    arm.hp = arm.stat.maxHp * 0.2; // 已损失 80% → +40%
    const g = mkEnemy('goblin', C(8), C(10));
    expect(damageEnemy(g, 100, { el: 'physical' })).toBeCloseTo(140);
  });
});

/* ------------------------------------------------------------------ */
/* 职业隐藏被动                                                          */
/* ------------------------------------------------------------------ */

describe('职业隐藏被动', () => {
  it('雷电魔法师·静电：第 5 次直接命中弹射电弧（60% 攻击）', () => {
    const p = mkPlayer('storm');
    G.player = p;
    const a = mkEnemy('golem', C(8), C(6));
    const b = mkEnemy('goblin', C(8) + 60, C(6)); // 不弱雷，便于核对数值
    for (let i = 0; i < 4; i++) damageEnemy(a, 10, { el: 'physical' });
    expect(b.hp).toBe(10000);
    damageEnemy(a, 10, { el: 'physical' });
    expect(10000 - b.hp).toBeCloseTo(p.stat.atk * 0.6 * (1 + p.stat.shock));
    expect(events('chain').length).toBe(1);
    // 次级伤害（proc）不计数
    for (let i = 0; i < 6; i++) damageEnemy(a, 10, { el: 'physical', proc: true });
    expect(events('chain').length).toBe(1);
  });

  it('风暴守卫·电磁壁垒：护盾吸收时对周围敌人雷电反击（吸收量 50%）', () => {
    const p = mkPlayer('stormguard');
    G.player = p;
    p.buffs.shield = 100;
    p.buffs.shieldT = 5;
    const near = mkEnemy('goblin', p.x + 60, p.y); // 不弱雷
    const far = mkEnemy('goblin', p.x + 300, p.y);
    damagePlayer(p, 40);
    expect(10000 - near.hp).toBeCloseTo(20);
    expect(far.hp).toBe(10000);
  });

  it('骑士·骑士道：身边每个敌人护甲 +8%（最多 3 层）；战士·不屈：低血减伤 25%', () => {
    const k = mkPlayer('knight', { armor: 100 });
    G.player = k;
    for (let i = 0; i < 4; i++) mkEnemy('slime', k.x + 40, k.y + i * 10);
    expect(damagePlayer(k, 200)).toBeCloseTo(200 - 100 * 1.24 * 0.55);

    G.enemies.length = 0;
    const w = mkPlayer('warrior');
    G.player = w;
    w.hp = w.stat.maxHp * 0.2;
    expect(damagePlayer(w, 40)).toBeCloseTo(30);
  });

  it('游侠·鹰眼：200 距离外额外暴击判定；冰法·寒心：对迟缓目标 +15%；元素法师交替加成', () => {
    const r = mkPlayer('ranger');
    G.player = r;
    const far = mkEnemy('goblin', r.x + 260, r.y);
    rngSpy.mockReturnValue(0.1); // < 0.12
    expect(damageEnemy(far, 50, { el: 'physical' })).toBeCloseTo(100);
    expect(events('floater').some(f => f.crit)).toBe(true);
    rngSpy.mockReturnValue(0.99);

    const c = mkPlayer('cryo');
    G.player = c;
    const t = mkEnemy('golem', C(8), C(8));
    damageEnemy(t, 10, { el: 'ice' }); // 挂上迟缓
    expect(damageEnemy(t, 100, { el: 'physical' })).toBeCloseTo(115);

    const em = mkPlayer('elemage');
    G.player = em;
    const u = mkEnemy('golem', C(8), C(10));
    damageEnemy(u, 10, { el: 'fire', basic: true }); // 灼烧
    expect(damageEnemy(u, 100, { el: 'ice', basic: true })).toBeCloseTo(120);
  });

  it('风暴刺客·雷影：潜行时的直接命中额外连锁 2 个敌人（50%）', () => {
    const p = mkPlayer('stormblade');
    G.player = p;
    p.buffs.stealth = 5;
    const a = mkEnemy('golem', C(8), C(6));
    const b = mkEnemy('golem', C(8) + 50, C(6));
    const c = mkEnemy('golem', C(8) + 100, C(6));
    const d = mkEnemy('golem', C(8) + 150, C(6));
    damageEnemy(a, 100, { el: 'physical' });
    expect(p.buffs.stealth).toBe(0);
    expect(b.hp).toBeLessThan(10000);
    expect(c.hp).toBeLessThan(10000);
    expect(d.hp).toBe(10000);
  });
});

/* ------------------------------------------------------------------ */
/* 伤害区域                                                              */
/* ------------------------------------------------------------------ */

describe('hazards', () => {
  it('首领式延迟冰原：延迟期只预警不结算，生效后周期结算并减速玩家', () => {
    const p = player();
    const boss = mkEnemy('boss', C(15), C(6));
    spawnHazard({
      kind: 'iceField', team: 'enemy', x: p.x, y: p.y, r: 60, dmg: 20, el: 'ice', style: 'frost',
      ownerId: boss.id, delay: 0.7, life: 6, tick: 0.5, slow: 0.45, status: 'slow',
    });
    steps(30, () => updateHazards(DT)); // 0.5s < 0.7s
    expect(p.hp).toBe(p.stat.maxHp);
    expect(events('ring').length).toBeGreaterThan(0);
    steps(20, () => updateHazards(DT));
    expect(p.hp).toBeLessThan(p.stat.maxHp);
    expect(speedMul(p)).toBeLessThan(1);
    expect(boss.hp).toBe(10000); // 敌方区域不伤敌人
  });

  it('镜像对手施放奥义（狂怒旋风）：跟随对手的光环打玩家', () => {
    const p = player();
    const rival = mkEnemy('goblin', p.x + 60, p.y, { rival: { cid: 'warrior', route: 'magic', cdQ: 0, cdE: 0, cdR: 0 }, atk: 30 });
    castByKind(rival, ULTS.whirl, 'whirl');
    const h = G.hazards.find(z => z.style === 'whirl');
    expect(h?.team).toBe('enemy');
    expect(h?.followId).toBe(rival.id);
    updateHazards(DT);
    expect(p.hp).toBeLessThan(p.stat.maxHp);
    rival.x += 40;
    steps(2, () => updateHazards(DT));
    expect(h?.x).toBeCloseTo(rival.x);
  });

  it('玩家受击进入 hurt 动画（不打断攻击动作）', () => {
    const p = player();
    damagePlayer(p, 10);
    expect(p.anim).toBe('hurt');
    p.invuln = 0;
    p.anim = 'attack';
    damagePlayer(p, 10);
    expect(p.anim).toBe('attack');
  });
});

/* ------------------------------------------------------------------ */
/* 玩家受伤 / 死亡                                                       */
/* ------------------------------------------------------------------ */

describe('damagePlayer', () => {
  it('护盾上限 maxHp×0.8（铁壁连放），护盾先吸收，过期护盾不吸收', () => {
    const p = player();
    for (let i = 0; i < 3; i++) castByKind(p, SKILLS.warrior[2], null);
    expect(p.buffs.shield).toBeCloseTo(p.stat.maxHp * 0.8);
    expect(p.buffs.shieldT).toBeCloseTo(6);
    p.buffs.roar = 0;
    expect(damagePlayer(p, 100)).toBe(0);
    expect(p.hp).toBe(p.stat.maxHp);
    expect(p.buffs.shield).toBeCloseTo(p.stat.maxHp * 0.8 - 100);
    p.invuln = 0;
    p.buffs.shieldT = 0;
    expect(damagePlayer(p, 50)).toBeCloseTo(50);
    expect(p.hp).toBeCloseTo(p.stat.maxHp - 50);
  });

  it('无敌帧免疫；受击后 0.42s 无敌、hurtT 归零、震屏与音效', () => {
    const p = player();
    p.hurtT = 9;
    expect(damagePlayer(p, 30)).toBeCloseTo(30);
    expect(p.invuln).toBeCloseTo(0.42);
    expect(p.hurtT).toBe(0);
    expect(events('shake').length).toBeGreaterThan(0);
    expect(events('sfx').some(s => s.name === 'hurt')).toBe(true);
    expect(damagePlayer(p, 30)).toBe(0);
  });

  it('玩家会中异常：火→灼烧 1 层、冰→迟缓、雷→感电、毒→中毒，时长为 50%', () => {
    const p = player();
    const hitWith = (el: 'fire' | 'ice' | 'lightning' | 'poison'): void => {
      p.invuln = 0;
      damagePlayer(p, 20, { el });
    };
    hitWith('fire');
    expect(p.status.burn?.stacks).toBe(1);
    expect(p.status.burn?.t).toBeCloseTo(1.25);
    hitWith('ice');
    expect(p.status.slow?.t).toBeCloseTo(1.25);
    expect(speedMul(p)).toBeLessThan(1);
    hitWith('lightning');
    expect(p.status.shock?.t).toBeCloseTo(1);
    hitWith('poison');
    expect(p.status.poison?.t).toBeCloseTo(1.75);
    const hp0 = p.hp;
    tickStatus(p, 0.5);
    expect(p.hp).toBeLessThan(hp0);
  });

  it('致死 → 死亡页并当场扣 10% 金币；revive 回满、2s 无敌、回主城', () => {
    const p = player();
    p.buffs.overload = 3;
    p.cd.q = 4;
    damagePlayer(p, 99999);
    expect(G.mode).toBe('dead');
    expect(p.deaths).toBe(1);
    expect(p.gold).toBe(900); // 死亡瞬间结算 10% 金币并存档（刷新页面无法绕过）
    expect(events('ui').some(u => u.what === 'dead')).toBe(true);
    revive();
    expect(G.mode).toBe('play');
    expect(p.gold).toBe(900); // 复活不重复扣
    expect(p.hp).toBe(p.stat.maxHp);
    expect(p.invuln).toBe(2);
    expect(p.cd.q).toBe(0);
    expect(p.buffs.overload).toBe(0);
    expect(p.dead).toBe(false);
    expect(enterCity).toHaveBeenCalledWith('spawn');
  });

  it('竞技场落败不进死亡页：回满并交给 leaveArena(false)', () => {
    G.scene = 'arena';
    const p = player();
    // 竞技场里总有一个活着的镜像对手（对手已死 = 胜利结算中，见 review_combat 的回归测试）
    mkEnemy('goblin', C(20), C(6), { rival: { cid: 'pyro', route: 'magic', cdQ: 0, cdE: 0, cdR: 0 } });
    damagePlayer(p, 99999);
    expect(G.mode).toBe('play');
    expect(p.hp).toBe(p.stat.maxHp);
    expect(p.deaths).toBe(0); // 竞技场落败不算真实死亡（竞技场规则文案）
    expect(p.gold).toBe(1000); // 也不扣死亡金币
    expect(leaveArena).toHaveBeenCalledWith(false);
  });
});

/* ------------------------------------------------------------------ */
/* 瞄准                                                                 */
/* ------------------------------------------------------------------ */

describe('aimAngle / autoTarget', () => {
  it('鼠标瞄准优先；否则软锁定；墙后与迷雾中不可见的目标不锁定', () => {
    G.map = mapFrom(WALLED);
    const p = mkPlayer('pyro', {}, C(8), C(6));
    G.player = p;
    const behindWall = mkEnemy('slime', C(12), C(6)); // 更近但在墙后
    const visible = mkEnemy('slime', C(8), C(11));
    expect(autoTarget(p.x, p.y, 400, 'player')).toBe(visible);
    expect(aimAngle(p)).toBeCloseTo(Math.PI / 2);
    aimAt(p.x - 100, p.y);
    expect(aimAngle(p)).toBeCloseTo(Math.PI);
    // 迷雾：超出视野半径的目标不锁定
    G.map.fog = true;
    computeFov(G.map, p.x, p.y, 3);
    expect(autoTarget(p.x, p.y, 400, 'player')).toBeNull();
    expect(behindWall.hp).toBe(10000);
  });

  it('敌方 autoTarget 选玩家', () => {
    const p = player();
    expect(autoTarget(C(8), C(6), 400, 'enemy')).toBe(p);
  });
});

/* ------------------------------------------------------------------ */
/* 冲刺与技能                                                            */
/* ------------------------------------------------------------------ */

describe('冲刺与技能', () => {
  it('dash：0.16s 插值位移约 96、无敌 0.2s、残影 ×3、冷却 1.1×(1−cdr×0.4)', () => {
    const p = player();
    G.input.mx = 1;
    const x0 = p.x;
    expect(dash(p)).toBe(true);
    expect(p.invuln).toBeCloseTo(0.2);
    expect(p.cd.dash).toBeCloseTo(1.1);
    expect(p.x).toBe(x0); // 不是瞬移
    expect(p.dashT).toBeGreaterThan(0);
    steps(12, () => tickDash(p, DT));
    expect(p.x - x0).toBeCloseTo(96, 0);
    expect(p.dashT).toBe(0);
    expect(events('afterimage').length).toBe(3);
    expect(dash(p)).toBe(false); // 冷却中
  });

  it('skillCooldown = cd×(1−cdr)；castSkill 扣源能、设冷却；源能不足提示', () => {
    const p = player();
    p.stat.cdr = 0.25;
    expect(skillCooldown(p, 10)).toBeCloseTo(7.5);
    const mp0 = p.mp;
    expect(castSkill(p, 0)).toBe(true);
    expect(p.mp).toBe(mp0 - SKILLS.warrior[0].cost);
    expect(p.cd.q).toBeCloseTo(SKILLS.warrior[0].cd * 0.75);
    expect(p.anim).toBe('cast');
    expect(events('cast').length).toBe(1);
    expect(castSkill(p, 0)).toBe(false);
    p.mp = 0;
    expect(castSkill(p, 1)).toBe(false);
    expect(events('toast').some(t => t.text.includes('源能不足'))).toBe(true);
  });

  it('buff 按技能分支：甲士 E“潜行”给潜行，风暴刺客 R“过载”给过载', () => {
    const arm = mkPlayer('armored');
    G.player = arm;
    castByKind(arm, SKILLS.armored[1], null);
    expect(arm.buffs.stealth).toBeGreaterThanOrEqual(6);
    expect(arm.buffs.shield).toBe(0);
    const sb = mkPlayer('stormblade');
    G.player = sb;
    castByKind(sb, SKILLS.stormblade[2], null);
    expect(sb.buffs.overload).toBe(8);
    expect(sb.buffs.stealth).toBe(0);
  });

  it('beam：raycastDist 撞墙截断，墙后敌人不受伤', () => {
    G.map = mapFrom(WALLED);
    const p = mkPlayer('storm', {}, C(5), C(6));
    G.player = p;
    const before = mkEnemy('golem', C(8), C(6));
    const behind = mkEnemy('golem', C(13), C(6));
    aimAt(C(25), C(6));
    castByKind(p, SKILLS.storm[1], null);
    const bm = events('beam')[0];
    expect(bm.x1).toBeLessThanOrEqual(10 * TILE + 0.01);
    expect(before.hp).toBeLessThan(10000);
    expect(behind.hp).toBe(10000);
  });

  it('chain：每跳选离当前目标最近的（legacy 取数组第一个）', () => {
    const p = mkPlayer('storm', {}, C(5), C(6));
    G.player = p;
    const a = mkEnemy('slime', C(8), C(6));
    const far = mkEnemy('slime', C(13), C(6)); // 数组里排在前面，但更远
    const near = mkEnemy('slime', C(9), C(8));
    aimAt(C(20), C(6));
    castByKind(p, SKILLS.storm[0], null);
    expect(a.hp).toBeLessThan(10000);
    expect(near.hp).toBeLessThan(10000);
    expect(far.hp).toBe(10000);
    expect(events('chain')[0].pts.length).toBe(3);
  });

  it('multi：贴脸时同一齐射对同一目标最多命中 2 支', () => {
    const p = mkPlayer('ranger');
    G.player = p;
    const e = mkEnemy('golem', p.x + 24, p.y);
    aimAt(C(20), p.y);
    castByKind(p, SKILLS.ranger[1], null);
    expect(G.projectiles.length).toBe(7);
    steps(30, () => updateProjectiles(DT));
    const per = p.stat.atk * SKILLS.ranger[1].mult * 0.75;
    expect(10000 - e.hp).toBeCloseTo(per * 2);
  });

  it('trap：0.4s 后武装，踏入即定身并迟缓', () => {
    const p = mkPlayer('ranger');
    G.player = p;
    castByKind(p, SKILLS.ranger[2], null);
    const trap = G.hazards.find(h => h.kind === 'trap');
    expect(trap).toBeDefined();
    const e = mkEnemy('goblin', C(20), C(6));
    steps(30, () => updateHazards(DT));
    expect(e.hp).toBe(10000);
    e.x = trap?.x ?? 0;
    e.y = trap?.y ?? 0;
    updateHazards(DT);
    expect(e.hp).toBeLessThan(10000);
    expect(isStunned(e)).toBe(true);
    expect(e.status.slow?.t).toBeGreaterThan(2);
    expect(G.hazards.some(h => h.kind === 'trap')).toBe(false);
  });

  it('meteor：延迟落地，期间 emit ring 预警，落地后留下火海', () => {
    const p = mkPlayer('pyro');
    G.player = p;
    const e = mkEnemy('golem', C(10), C(6));
    aimAt(e.x, e.y);
    castByKind(p, SKILLS.pyro[1], null);
    steps(30, () => updateHazards(DT));
    expect(e.hp).toBe(10000);
    expect(events('ring').length).toBeGreaterThan(0);
    steps(30, () => updateHazards(DT));
    expect(e.hp).toBeLessThan(10000);
    expect(events('explosion').length).toBe(1);
    expect(G.hazards.some(h => h.kind === 'zone' && h.style === 'firefield')).toBe(true);
  });

  it('15 个奥义各自独立表现：都会生成 style = 奥义 id 的 hazard', () => {
    const ids = Object.keys(ULTS);
    expect(ids.length).toBe(15);
    for (const id of ids) {
      resetCombatState();
      G.hazards.length = 0;
      G.enemies.length = 0;
      const p = mkPlayer('warrior');
      G.player = p;
      mkEnemy('golem', C(9), C(6));
      aimAt(C(9), C(6));
      castByKind(p, ULTS[id], id);
      expect(G.hazards.some(h => h.style === id), id).toBe(true);
    }
  });

  it('execute：连续闪烁到多个目标背后背刺（必暴）', () => {
    const p = mkPlayer('assassin');
    G.player = p;
    const a = mkEnemy('goblin', C(9), C(6));
    const b = mkEnemy('goblin', C(9), C(9));
    castByKind(p, ULTS.execute, 'execute');
    steps(60, () => tickDash(p, DT));
    expect(a.hp).toBeLessThan(10000);
    expect(b.hp).toBeLessThan(10000);
    expect(p.buffs.stealth).toBeGreaterThan(0);
    expect(isFree(G.map ?? mapFrom(OPEN), p.x, p.y, p.r)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 投射物                                                               */
/* ------------------------------------------------------------------ */

describe('投射物', () => {
  it('撞不透明格消失并 emit impact，墙后敌人不受伤', () => {
    G.map = mapFrom(WALLED);
    const p = player();
    const behind = mkEnemy('slime', C(13), C(6));
    spawnProjectile({ kind: 'arrow', team: 'player', x: C(8), y: C(6), vx: 560, vy: 0, dmg: 10, el: 'physical', ownerId: p.id });
    steps(30, () => updateProjectiles(DT));
    expect(G.projectiles.length).toBe(0);
    expect(events('impact').length).toBe(1);
    expect(events('impact')[0].x).toBeLessThan(10 * TILE);
    expect(behind.hp).toBe(10000);
  });

  it('高速不穿怪（扫掠命中），穿透记录 hit[] 不重复伤害', () => {
    const p = player();
    const e = mkEnemy('slime', C(10), C(6));
    const q = spawnProjectile({ kind: 'arrow', team: 'player', x: C(6), y: C(6), vx: 2400, vy: 0, dmg: 10, el: 'physical', ownerId: p.id, pierce: 3 });
    steps(10, () => updateProjectiles(DT));
    expect(e.hp).toBeCloseTo(9990);
    expect(q.hit).toContain(e.id);
  });

  it('溅射：命中点周围其它敌人受 45% 伤害', () => {
    const p = player();
    const a = mkEnemy('golem', C(10), C(6));
    const b = mkEnemy('golem', C(10) + 20, C(6) + 25);
    spawnProjectile({ kind: 'fireball', team: 'player', x: C(7), y: C(6), vx: 420, vy: 0, dmg: 100, el: 'physical', ownerId: p.id, splash: 45 });
    steps(30, () => updateProjectiles(DT));
    expect(10000 - a.hp).toBeCloseTo(100);
    expect(10000 - b.hp).toBeCloseTo(45);
  });

  it('敌方投射物命中玩家（damagePlayer），按阵营不打敌人', () => {
    const p = player();
    const other = mkEnemy('slime', C(8), C(6));
    spawnProjectile({ kind: 'enemyOrb', team: 'enemy', x: C(10), y: C(6), vx: -300, vy: 0, dmg: 30, el: 'fire', ownerId: other.id });
    steps(60, () => updateProjectiles(DT));
    expect(p.hp).toBeLessThan(p.stat.maxHp);
    expect(p.status.burn).toBeDefined();
    expect(other.hp).toBe(10000);
    expect(G.projectiles.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 镜像对手施法                                                          */
/* ------------------------------------------------------------------ */

describe('镜像对手（rival）施法', () => {
  const rivalOf = (cid: string, x: number, y: number): Enemy =>
    mkEnemy('goblin', x, y, { rival: { cid, route: 'magic', cdQ: 0, cdE: 0, cdR: 0 }, atk: 30, elite: true });

  it('rival 的 nova 打玩家，不打其它敌人', () => {
    const p = player();
    const rival = rivalOf('pyro', p.x + 80, p.y);
    const bystander = mkEnemy('slime', p.x + 60, p.y + 30);
    castByKind(rival, SKILLS.pyro[2], null);
    expect(p.hp).toBeLessThan(p.stat.maxHp);
    expect(bystander.hp).toBe(10000);
    expect(rival.anim).toBe('cast');
  });

  it('rival 的火球是敌方投射物，会追向并命中玩家', () => {
    const p = player();
    const rival = rivalOf('pyro', C(12), C(6));
    castByKind(rival, SKILLS.pyro[0], null);
    const q = G.projectiles[0];
    expect(q.team).toBe('enemy');
    expect(q.vx).toBeLessThan(0);
    steps(90, () => updateProjectiles(DT));
    expect(p.hp).toBeLessThan(p.stat.maxHp);
  });

  it('rival 的冲锋是插值位移（updateHazards 推进），路径上命中玩家', () => {
    const p = player();
    const rival = rivalOf('warrior', p.x + 120, p.y);
    const x0 = rival.x;
    castByKind(rival, SKILLS.warrior[1], null);
    expect(rival.x).toBe(x0);
    steps(20, () => updateHazards(DT));
    expect(rival.x).toBeLessThan(x0 - 100);
    expect(p.hp).toBeLessThan(p.stat.maxHp);
  });
});
