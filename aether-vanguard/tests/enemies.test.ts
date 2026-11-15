import { describe, it, expect, vi, beforeEach } from 'vitest';

// —— 跨模块依赖打桩（combat / projectiles / hazards / skills 由其它代理实现）——
vi.mock('../src/core/rng', async importOriginal => {
  const m = await importOriginal<typeof import('../src/core/rng')>();
  return { ...m, rng: new m.Rng(20261115) };
});
vi.mock('../src/game/combat', () => {
  type A = { status: Record<string, { t: number; stacks: number; dps: number } | undefined>; dead: boolean };
  return {
    rollDmg: vi.fn(() => ({ dmg: 0, crit: false })),
    damageEnemy: vi.fn(() => 0),
    damagePlayer: vi.fn((_p: unknown, dmg: number) => dmg),
    applyStatus: vi.fn((a: A, s: string, dur: number) => {
      a.status[s] = { t: dur, stacks: 1, dps: 0 };
    }),
    tickStatus: vi.fn((a: A, dt: number) => {
      for (const k of Object.keys(a.status)) {
        const st = a.status[k];
        if (!st) continue;
        st.t -= dt;
        if (st.t <= 0) delete a.status[k];
      }
      return 0;
    }),
    speedMul: vi.fn(() => 1),
    isStunned: vi.fn((a: A) => (a.status.stun?.t ?? 0) > 0),
    knockback: vi.fn(),
    tickKnockback: vi.fn(),
    killEnemy: vi.fn((e: A) => {
      e.dead = true;
    }),
    playerDie: vi.fn(),
    revive: vi.fn(),
  };
});
vi.mock('../src/game/projectiles', () => ({
  spawnProjectile: vi.fn((init: Record<string, unknown>) => ({ id: 0, life: 2, pierce: 0, homing: 0, targetId: 0, hit: [], splash: 0, r: 4, color: '#fff', ...init })),
  updateProjectiles: vi.fn(),
}));
vi.mock('../src/game/hazards', () => ({
  spawnHazard: vi.fn((init: Record<string, unknown>) => ({ id: 0, delay: 0, life: 1, maxLife: 1, tick: 0, tickT: 0, ...init })),
  updateHazards: vi.fn(),
}));
vi.mock('../src/game/skills', () => ({
  aimAngle: vi.fn(() => 0),
  autoTarget: vi.fn(() => null),
  basicAttack: vi.fn(),
  dash: vi.fn(() => false),
  tickDash: vi.fn(),
  castSkill: vi.fn(() => false),
  castUlt: vi.fn(() => false),
  castByKind: vi.fn(),
  skillCooldown: vi.fn((_p: unknown, cd: number) => cd),
}));

import { TILE } from '../src/config';
import { T } from '../src/data/tiles';
import { ENEMIES } from '../src/data/enemies';
import { SKILLS } from '../src/data/skills';
import { GridMap } from '../src/world/grid';
import { isFree } from '../src/world/collision';
import { lineOfSight, computeFov } from '../src/world/los';
import { G, clearWorld } from '../src/game/state';
import type { Enemy, Player } from '../src/game/types';
import { absorbShield, enemyDebug, spawnEnemy, spawnRival, updateEnemies } from '../src/game/enemies';
import { initSpawner, updateSpawner } from '../src/game/spawner';
import { bossSkillIds } from '../src/game/bosses';
import { damagePlayer, speedMul } from '../src/game/combat';
import { spawnProjectile } from '../src/game/projectiles';
import { spawnHazard } from '../src/game/hazards';
import { castByKind } from '../src/game/skills';

/* ------------------------------------------------------------------ */
/* 工具                                                                  */
/* ------------------------------------------------------------------ */
const DT = 1 / 60;
const C = (t: number): number => t * TILE + TILE / 2;

/** 字符画建图：# 墙  . 地面  ~ 水 */
function mapFrom(rows: string[]): GridMap {
  const m = new GridMap(rows[0].length, rows.length, 'dungeon', T.WALL);
  rows.forEach((r, y) => [...r].forEach((c, x) => m.set(x, y, c === '#' ? T.WALL : c === '~' ? T.WATER : T.FLOOR)));
  return m;
}

function openRoom(w: number, h: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) rows.push(y === 0 || y === h - 1 ? '#'.repeat(w) : '#' + '.'.repeat(w - 2) + '#');
  return rows;
}

function makePlayer(x: number, y: number): Player {
  const p = {
    id: 1_000_000, team: 'player', x, y, r: 11, hp: 99999, maxHp: 99999, facing: 1, aim: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
    name: 'T', cid: 'warrior', route: 'magic', mp: 100, lv: 10, exp: 0, expNext: 100,
    buffs: { shield: 0, shieldT: 0, roar: 0, stealth: 0, field: 0, overload: 0 },
    invuln: 0, hurtT: 0, actT: 0,
    stat: { atk: 40, armor: 10, maxHp: 500, maxMp: 100 },
  };
  return p as unknown as Player;
}

function setup(rows: string[], px: number, py: number): { map: GridMap; p: Player } {
  clearWorld();
  G.events.length = 0;
  G.mode = 'play';
  G.scene = 'dungeon';
  G.floor = 1;
  const map = mapFrom(rows);
  map.fog = false;
  G.map = map;
  const p = makePlayer(px, py);
  G.player = p;
  vi.clearAllMocks();
  return { map, p };
}

function run(sec: number, each?: (i: number) => void): void {
  const n = Math.round(sec / DT);
  for (let i = 0; i < n; i++) {
    updateEnemies(DT);
    each?.(i);
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 网格 BFS：两点所在格是否连通（只走可走格） */
function connected(map: GridMap, ax: number, ay: number, bx: number, by: number): boolean {
  const sx = Math.floor(ax / TILE), sy = Math.floor(ay / TILE), tx = Math.floor(bx / TILE), ty = Math.floor(by / TILE);
  const seen = new Set<number>([sy * map.w + sx]);
  const q: Array<[number, number]> = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === tx && y === ty) return true;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + ox, ny = y + oy;
      if (!map.walkable(nx, ny)) continue;
      const k = ny * map.w + nx;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return false;
}

beforeEach(() => {
  vi.mocked(speedMul).mockImplementation(() => 1);
});

/* ------------------------------------------------------------------ */
/* 数据表                                                                */
/* ------------------------------------------------------------------ */
describe('enemy data', () => {
  it('keeps the 12 legacy ids/values and adds sprites for every kind', () => {
    for (const id of ['slime', 'goblin', 'bat', 'eye', 'golem', 'wisp', 'frost', 'spark', 'brute', 'venom', 'shade', 'boss']) {
      expect(ENEMIES[id]).toBeDefined();
    }
    expect(ENEMIES.slime.hp).toBe(60);
    expect(ENEMIES.boss.atk).toBe(52);
    expect(ENEMIES.boss.bossKit).toBe('tyrant');
    for (const [id, d] of Object.entries(ENEMIES)) expect(d.sprite, id).toBeTruthy();
    expect(ENEMIES.orc_warrior.ai).toBe('shield');
    expect(ENEMIES.orc_shaman.summons).toEqual(['tiny_zombie', 'skeleton']);
    expect(ENEMIES.necromancer.elite).toBe(true);
    for (const b of ['warden', 'lich', 'shadow_lord']) expect(ENEMIES[b].boss).toBe(true);
    for (const kit of ['tyrant', 'warden', 'lich', 'shadow']) expect(bossSkillIds(kit).length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ */
/* 生成                                                                  */
/* ------------------------------------------------------------------ */
describe('spawnEnemy', () => {
  it('scales by level, converts speed to units/s, sets bars and fade-in', () => {
    const { p } = setup(openRoom(12, 8), C(2), C(2));
    const e = spawnEnemy('slime', C(8), C(4), { lv: 10 });
    expect(e.hp).toBeCloseTo(60 * (1 + 10 * 0.14));
    expect(e.atk).toBeCloseTo(14 * (1 + 10 * 0.1));
    expect(e.armor).toBeCloseTo(3 + 10 * 0.4);
    expect(e.exp).toBe(Math.round(12 * (1 + 10 * 0.12)));
    expect(e.gold).toBe(Math.round(5 * (1 + 10 * 0.1)));
    expect(e.spd).toBeCloseTo(0.8 * 60);
    expect(e.bars).toBe(1);
    expect(e.spawnT).toBeCloseTo(0.5);
    expect(G.enemies).toContain(e);
    expect(G.events.some(ev => ev.t === 'spawn')).toBe(true);
    // 默认等级 = 玩家等级；15 级起多一条血；精英 +1 条且 ×1.6 血；首领 3 条
    expect(spawnEnemy('slime', C(8), C(4)).lv).toBe(p.lv);
    expect(spawnEnemy('slime', C(8), C(4), { lv: 15 }).bars).toBe(2);
    const el = spawnEnemy('slime', C(8), C(4), { lv: 10, elite: true });
    expect(el.bars).toBe(2);
    expect(el.hp).toBeCloseTo(60 * 2.4 * 1.6);
    expect(el.aggro).toBe(true);
    const b = spawnEnemy('boss', C(6), C(4), { lv: 10, mul: 1.3 });
    expect(b.bars).toBe(3);
    expect(b.hp).toBeCloseTo(2600 * 2.4 * 1.3);
    expect(b.aggro).toBe(true);
    expect(G.boss).toBe(b);
  });

  it('moves a spawn point that is inside a wall to the nearest free spot', () => {
    const { map } = setup(openRoom(10, 8), C(2), C(2));
    const e = spawnEnemy('goblin', 0 + 5, C(3));
    expect(isFree(map, e.x, e.y, e.r)).toBe(true);
  });

  it('spawnRival uses the legacy formulas and the class skin', () => {
    const { p } = setup(openRoom(20, 14), C(10), C(7));
    const r = spawnRival('pyro', 'tech', 2, C(10), C(3));
    expect(r.maxHp).toBeCloseTo((500 * 0.9 + 180) * (1 + 2 * 0.12));
    expect(r.atk).toBeCloseTo(40 * 0.9 + 8);
    expect(r.armor).toBeCloseTo(10 * 0.7);
    expect(r.spd).toBeCloseTo(1.9 * 60);
    expect(r.def.sprite).toBe('skin_pyro');
    expect(r.rival).toMatchObject({ cid: 'pyro', route: 'tech' });
    expect(r.exp).toBe(0);
    void p;
  });
});

/* ------------------------------------------------------------------ */
/* 导航                                                                  */
/* ------------------------------------------------------------------ */
describe('navigation', () => {
  it('walks around a U-shaped wall along the flow field to reach the player', () => {
    const rows = [
      '############',
      '#..........#',
      '#..#....#..#',
      '#..#....#..#',
      '#..#....#..#',
      '#..######..#',
      '#..........#',
      '#..........#',
      '############',
    ];
    const { map, p } = setup(rows, C(5), C(3));
    const e = spawnEnemy('goblin', C(5), C(7), { aggro: true });
    expect(lineOfSight(map, e.x, e.y, p.x, p.y)).toBe(false);
    let reached = -1;
    run(15, i => {
      expect(isFree(map, e.x, e.y, e.r)).toBe(true);
      if (reached < 0 && dist(e, p) < e.r + p.r + 16) reached = i;
    });
    expect(reached).toBeGreaterThan(0);
    expect(dist(e, p)).toBeLessThan(e.r + p.r + 20);
    expect(vi.mocked(damagePlayer)).toHaveBeenCalled();
  });

  it('big units route through a 2-wide gap instead of getting stuck in a 1-wide one', () => {
    const rows = [
      '##############',
      '#............#',
      '#............#',
      '#............#',
      '###.######..##',
      '#............#',
      '#............#',
      '#............#',
      '##############',
    ];
    const { map, p } = setup(rows, C(3), C(2));
    const e = spawnEnemy('zombie', C(3), C(6), { aggro: true });
    e.r = 20; // 大体型（过不了 1 格缝）
    let maxX = 0;
    let reached = false;
    run(30, () => {
      expect(isFree(map, e.x, e.y, e.r)).toBe(true);
      maxX = Math.max(maxX, e.x);
      if (dist(e, p) < e.r + p.r + 16) reached = true;
    });
    expect(reached).toBe(true);
    expect(maxX).toBeGreaterThan(C(9));
  });

  it('flying units cross water, ground units cannot', () => {
    const rows = [
      '##########',
      '#........#',
      '#........#',
      '#~~~~~~~~#',
      '#~~~~~~~~#',
      '#........#',
      '#........#',
      '##########',
    ];
    const { map, p } = setup(rows, C(4), C(1));
    const wisp = spawnEnemy('wisp', C(4), C(6), { aggro: true });
    const gob = spawnEnemy('goblin', C(6), C(6), { aggro: true });
    let wispReached = false;
    run(10, () => {
      if (dist(wisp, p) < wisp.r + p.r + 16) wispReached = true;
      expect(isFree(map, gob.x, gob.y, gob.r)).toBe(true);
    });
    expect(wispReached).toBe(true);
    expect(gob.y).toBeGreaterThan(5 * TILE);
  });

  it('crowd separation never pushes enemies into walls', () => {
    const { map } = setup(openRoom(8, 5), C(6), C(3));
    G.player = null;
    const list: Enemy[] = [];
    for (let i = 0; i < 14; i++) list.push(spawnEnemy('slime', C(1) + 2, C(1) + 2, { lv: 1 }));
    const overlap = (): number => {
      let s = 0;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) s += Math.max(0, list[i].r + list[j].r - dist(list[i], list[j]));
      return s;
    };
    const before = overlap();
    run(3, () => {
      for (const e of list) expect(isFree(map, e.x, e.y, e.r)).toBe(true);
    });
    expect(overlap()).toBeLessThan(before * 0.25);
  });
});

/* ------------------------------------------------------------------ */
/* 仇恨与开火规则                                                         */
/* ------------------------------------------------------------------ */
describe('aggro and line of sight', () => {
  it('aggroes within 360 with sight, drops aggro after 4s beyond 900', () => {
    const { p } = setup(openRoom(44, 8), C(2), C(4));
    const near = spawnEnemy('goblin', C(2) + 300, C(4));
    const far = spawnEnemy('goblin', C(2) + 600, C(4));
    run(0.7);
    expect(near.aggro).toBe(true);
    // 呼叫同伴的距离是 220，far 离 near 300 不会被叫醒
    expect(far.aggro).toBe(false);
    p.x = C(42);
    near.x = C(2);
    run(3);
    expect(near.aggro).toBe(true);
    run(1.5);
    expect(near.aggro).toBe(false);
    expect(near.ai).toBe('idle');
  });

  it('shooters never fire through walls', () => {
    const rows = [
      '##########',
      '#........#',
      '#...#....#',
      '#...#....#',
      '#...#....#',
      '#........#',
      '##########',
    ];
    const { p } = setup(rows, C(6), C(3));
    vi.mocked(speedMul).mockImplementation(() => 0); // 定住，确保一直没有视线
    const s = spawnEnemy('frost', C(2), C(3), { aggro: true });
    run(5);
    expect(vi.mocked(spawnProjectile)).not.toHaveBeenCalled();
    p.x = C(2);
    p.y = C(5);
    run(3);
    expect(vi.mocked(spawnProjectile)).toHaveBeenCalled();
    const call = vi.mocked(spawnProjectile).mock.calls[0][0];
    expect(call.team).toBe('enemy');
    expect(call.el).toBe('ice');
    expect(Math.hypot(call.vx, call.vy)).toBeCloseTo(228);
    expect(call.dmg).toBeCloseTo(s.atk * 0.85);
  });

  it('a stealthed player is only noticed up close', () => {
    const { p } = setup(openRoom(24, 8), C(2), C(4));
    p.buffs.stealth = 10;
    const e = spawnEnemy('goblin', C(2) + 200, C(4));
    run(1.5);
    expect(e.aggro).toBe(false);
    p.x = e.x - 50;
    run(0.5);
    expect(e.aggro).toBe(true);
  });

  it('stun interrupts a melee windup (no hit lands)', () => {
    const { p } = setup(openRoom(16, 8), C(4), C(4));
    const e = spawnEnemy('goblin', C(4) + 30, C(4), { aggro: true });
    e.cdAtk = 0;
    let started = false;
    for (let i = 0; i < 120 && !started; i++) {
      updateEnemies(DT);
      started = enemyDebug(e).act?.k === 'melee';
    }
    expect(started).toBe(true);
    e.status.stun = { t: 1, stacks: 1, dps: 0 };
    run(0.5);
    expect(enemyDebug(e).act).toBeNull();
    expect(vi.mocked(damagePlayer)).not.toHaveBeenCalled();
    void p;
  });

  it('flankers circle to the side/back before striking', () => {
    const { p } = setup(openRoom(30, 20), C(15), C(10));
    p.aim = 0; // 玩家面朝右
    const e = spawnEnemy('masked_orc', C(15) + 200, C(10), { aggro: true }); // 从正面出现
    let hitAng: number | null = null;
    run(8, () => {
      if (hitAng === null && vi.mocked(damagePlayer).mock.calls.length) hitAng = Math.atan2(e.y - p.y, e.x - p.x);
    });
    expect(hitAng).not.toBeNull();
    expect(Math.abs(hitAng!)).toBeGreaterThan(Math.PI / 2);
  });

  it('chargers telegraph (windup + lane warning) before the charge hits', () => {
    const { p } = setup(openRoom(20, 10), C(3), C(5));
    const e = spawnEnemy('golem', C(3) + 170, C(5), { aggro: true });
    e.cdSkill = 0;
    const seq: string[] = [];
    let firstHit = -1;
    run(3, i => {
      if (seq[seq.length - 1] !== e.ai) seq.push(e.ai);
      if (firstHit < 0 && vi.mocked(damagePlayer).mock.calls.length) firstHit = i;
    });
    const wi = seq.indexOf('windup'), ci = seq.indexOf('charge');
    expect(wi).toBeGreaterThanOrEqual(0);
    expect(ci).toBeGreaterThan(wi);
    // 冲锋路线预警：带时长的 lane telegraph，持续整个前摇（0.45s）
    expect(G.events.some(ev => ev.t === 'telegraph' && ev.shape === 'lane' && Math.abs(ev.dur - 0.45) < 1e-6)).toBe(true);
    expect(firstHit).toBeGreaterThan(Math.round((0.5 + 0.45) / DT) - 2);
    void p;
  });
});

/* ------------------------------------------------------------------ */
/* 召唤 / 护盾                                                            */
/* ------------------------------------------------------------------ */
describe('summoner', () => {
  it('summons only onto free tiles connected to the summoner (never across walls)', () => {
    const rows = [
      '###########',
      '#.........#',
      '#.#######.#',
      '#.#.....#.#',
      '#.#.....#.#',
      '#.#######.#',
      '#.........#',
      '###########',
    ];
    const { map } = setup(rows, C(5), C(6));
    const sh = spawnEnemy('orc_shaman', C(1), C(3), { aggro: true });
    sh.cdSkill = 0;
    for (let k = 0; k < 3; k++) {
      run(2.5);
      sh.cdSkill = 0;
    }
    const minions = G.enemies.filter(m => m.summonedBy === sh.id);
    expect(minions.length).toBeGreaterThan(0);
    expect(minions.length).toBeLessThanOrEqual(6);
    for (const m of minions) {
      expect(isFree(map, m.x, m.y, m.r)).toBe(true);
      expect(connected(map, sh.x, sh.y, m.x, m.y)).toBe(true);
      // 内室（被墙完全围住）里绝不能出现召唤物
      const tx = Math.floor(m.x / TILE), ty = Math.floor(m.y / TILE);
      expect(tx >= 3 && tx <= 7 && ty >= 3 && ty <= 4).toBe(false);
      expect(['tiny_zombie', 'skeleton']).toContain(m.kind);
      expect(m.exp).toBe(0);
      expect(m.gold).toBe(0);
      expect(m.aggro).toBe(true);
    }
  });
});

describe('shield AI', () => {
  it('damage goes to the shield first; hp only drops after the shield breaks', () => {
    const { p } = setup(openRoom(14, 8), C(7), C(3));
    const e = spawnEnemy('orc_warrior', C(3), C(3), { aggro: true });
    e.cdSkill = 0;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      updateEnemies(DT);
      up = e.shield > 0;
    }
    expect(up).toBe(true);
    expect(e.shield).toBeCloseTo(0.35 * e.maxHp);
    expect(e.ai === 'shield' || e.ai === 'windup' || e.ai === 'attack').toBe(true);
    // ① combat 没接入护盾、直接扣了血 → 下一步从护盾补回
    const hp0 = e.hp, sh0 = e.shield;
    e.hp -= 30;
    updateEnemies(DT);
    expect(e.hp).toBeCloseTo(hp0);
    expect(e.shield).toBeCloseTo(sh0 - 30);
    // ② combat 调 absorbShield：先扣盾，溢出部分才扣血
    const left = absorbShield(e, e.shield + 50);
    expect(left).toBeCloseTo(50);
    expect(e.shield).toBe(0);
    e.hp -= left;
    const hp1 = e.hp;
    updateEnemies(DT);
    expect(e.hp).toBeCloseTo(hp1);
    expect(enemyDebug(e).act?.k).toBe('stagger');
    void p;
  });

  it('moves at half speed while the shield is up', () => {
    setup(openRoom(30, 8), C(27), C(3));
    const e = spawnEnemy('orc_warrior', C(2), C(3), { aggro: true });
    run(0.6);
    e.cdSkill = 99;
    const x0 = e.x;
    run(1);
    const v1 = (e.x - x0) / 1;
    e.shield = 100;
    enemyDebug(e); // 扩展状态存在
    const ext = enemyDebug(e) as { shieldT: number; lastShield: number };
    ext.shieldT = 5;
    ext.lastShield = 100;
    const x1 = e.x;
    run(1);
    const v2 = (e.x - x1) / 1;
    expect(v1).toBeGreaterThan(40);
    expect(v2).toBeLessThan(v1 * 0.6);
    expect(v2).toBeGreaterThan(v1 * 0.4);
  });
});

/* ------------------------------------------------------------------ */
/* 首领                                                                  */
/* ------------------------------------------------------------------ */
describe('bosses', () => {
  for (const kind of ['boss', 'warden', 'lich', 'shadow_lord']) {
    it(`${kind}: enters phase 2 below 50% hp and uses 3+ telegraphed skills`, () => {
      const { map, p } = setup(openRoom(34, 22), C(8), C(11));
      const b = spawnEnemy(kind, C(20), C(11), { lv: 10 });
      expect(b.aggro).toBe(true);
      // 玩家每秒换一个位置（距首领 200 左右）以覆盖不同距离条件的技能
      let k = 0;
      run(8, i => {
        if (i % 60 === 0) {
          const a = (k++ * 2.1) % (Math.PI * 2);
          const tx = b.x + Math.cos(a) * 200, ty = b.y + Math.sin(a) * 200;
          if (isFree(map, tx, ty, p.r)) {
            p.x = tx;
            p.y = ty;
          }
          p.aim = a;
        }
      });
      expect(b.phase).toBe(1);
      b.hp = b.maxHp * 0.45;
      updateEnemies(DT);
      expect(b.phase).toBe(2);
      expect(G.events.some(ev => ev.t === 'banner')).toBe(true);
      run(24, i => {
        if (i % 60 === 0) {
          const a = (k++ * 2.1) % (Math.PI * 2);
          const tx = b.x + Math.cos(a) * (i % 120 === 0 ? 110 : 230), ty = b.y + Math.sin(a) * (i % 120 === 0 ? 110 : 230);
          if (isFree(map, tx, ty, p.r)) {
            p.x = tx;
            p.y = ty;
          }
          p.aim = a;
        }
        expect(isFree(map, b.x, b.y, b.r)).toBe(true);
      });
      const used = Object.keys(enemyDebug(b).boss?.used ?? {});
      expect(used.length).toBeGreaterThanOrEqual(3);
      // 每种技能都有预警（ring/line 事件）
      expect(G.events.some(ev => ev.t === 'ring')).toBe(true);
      // 召唤物都在合法位置
      for (const m of G.enemies.filter(o => o.summonedBy === b.id)) expect(isFree(map, m.x, m.y, m.r)).toBe(true);
    });
  }

  it('tyrant phase 2 summons wisps and rains meteors (hazards)', () => {
    const { p } = setup(openRoom(34, 22), C(8), C(11));
    const b = spawnEnemy('boss', C(20), C(11), { lv: 10 });
    run(1);
    b.hp = b.maxHp * 0.4;
    run(30, i => {
      if (i % 90 === 0) {
        p.x = b.x + (i % 180 === 0 ? 200 : -200);
        p.y = C(11);
      }
    });
    expect(G.enemies.some(o => o.summonedBy === b.id && o.kind === 'wisp')).toBe(true);
    expect(vi.mocked(spawnHazard).mock.calls.some(c => c[0].kind === 'meteor' && c[0].team === 'enemy')).toBe(true);
  });

  it('keeps a dead boss for world to detect, removes it once G.boss is cleared', () => {
    setup(openRoom(20, 12), C(3), C(6));
    const b = spawnEnemy('warden', C(14), C(6));
    expect(G.boss).toBe(b);
    b.dead = true;
    updateEnemies(DT);
    expect(G.enemies).toContain(b);
    G.boss = null;
    updateEnemies(DT);
    expect(G.enemies).not.toContain(b);
  });
});

/* ------------------------------------------------------------------ */
/* 镜像对手                                                              */
/* ------------------------------------------------------------------ */
describe('rival', () => {
  it('casts its class Q/E/R through castByKind and shoots', () => {
    const { p } = setup(openRoom(26, 18), C(13), C(9));
    const r = spawnRival('pyro', 'magic', 0, C(13) + 190, C(9));
    run(12);
    const calls = vi.mocked(castByKind).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [caster, sk, ult] of calls) {
      expect(caster).toBe(r);
      if (ult === null) expect(SKILLS.pyro).toContain(sk);
    }
    expect(vi.mocked(spawnProjectile)).toHaveBeenCalled();
    // 始终保持一定距离（不会贴脸）
    expect(dist(r, p)).toBeGreaterThan(60);
  });
});

/* ------------------------------------------------------------------ */
/* 刷怪器                                                                */
/* ------------------------------------------------------------------ */
describe('spawner', () => {
  it('spawns only out of view, 420–900 away and reachable; respects the cap', () => {
    const rows = openRoom(64, 30);
    // 一道墙挡出一片“射程内但看不见”的区域
    const grid = rows.map(r => [...r]);
    for (let y = 1; y < 22; y++) grid[y][24] = '#';
    const { map, p } = setup(grid.map(r => r.join('')), C(8), C(15));
    map.fog = true;
    computeFov(map, p.x, p.y, 22);
    G.spawnPoints = [];
    for (let y = 2; y < 28; y += 2) for (let x = 2; x < 62; x += 2) G.spawnPoints.push({ x: C(x), y: C(y) });
    initSpawner(['slime', 'goblin', 'bat', 'golem'], 12, 1.2, 6);
    for (let i = 0; i < 400; i++) updateSpawner(0.1);
    expect(G.enemies.length).toBeGreaterThan(0);
    expect(G.enemies.length).toBeLessThanOrEqual(G.spawner!.cap);
    for (const e of G.enemies) {
      expect(map.isVisibleWorld(e.x, e.y)).toBe(false);
      const d = dist(e, p);
      expect(d).toBeGreaterThan(420 - 45);
      expect(d).toBeLessThan(900 + 45);
      expect(G.flow!.reachable(e.x, e.y)).toBe(true);
      expect(isFree(map, e.x, e.y, e.r)).toBe(true);
    }
    expect(G.spawner!.total).toBe(G.enemies.length);
  });

  it('does not spawn in the city or the arena', () => {
    const { p } = setup(openRoom(64, 30), C(8), C(15));
    G.spawnPoints = [{ x: C(30), y: C(15) }, { x: C(40), y: C(15) }];
    initSpawner(['slime'], 10, 1, 3);
    G.scene = 'city';
    for (let i = 0; i < 100; i++) updateSpawner(0.1);
    G.scene = 'arena';
    for (let i = 0; i < 100; i++) updateSpawner(0.1);
    expect(G.enemies.length).toBe(0);
    void p;
  });
});
