// enemies 分区审查的回归测试：全部用真实模块（combat / skills / projectiles / hazards / world / drops 不打桩），
// 专门覆盖模块之间的衔接（tests/enemies.test.ts 把 combat 等全部打桩，衔接问题测不出来）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/rng', async importOriginal => {
  const m = await importOriginal<typeof import('../src/core/rng')>();
  return { ...m, rng: new m.Rng(424242) };
});

import { TILE } from '../src/config';
import { T } from '../src/data/tiles';
import { SKILLS } from '../src/data/skills';
import { GridMap } from '../src/world/grid';
import { G, clearWorld } from '../src/game/state';
import type { Enemy, FxEvent } from '../src/game/types';
import { makePlayer } from '../src/game/player';
import { killEnemy } from '../src/game/combat';
import { castByKind, resetCombatState } from '../src/game/skills';
import { enemyDebug, spawnEnemy, spawnRival, updateEnemies } from '../src/game/enemies';
import { initSpawner, updateSpawner } from '../src/game/spawner';
import { bossMem, newAct, type EnemyExt } from '../src/game/enemyState';
import { newGame, step } from '../src/game/sim';
import { enterDungeon } from '../src/game/world';

const DT = 1 / 60;
const C = (t: number): number => t * TILE + TILE / 2;

function openRoom(w: number, h: number): GridMap {
  const m = new GridMap(w, h, 'dungeon', T.WALL);
  m.fillRect(1, 1, w - 2, h - 2, T.FLOOR);
  m.fog = false;
  return m;
}

/** 无头竞技场/房间：真实玩家 + 开阔房间 */
function setupRoom(w = 30, h = 20): void {
  resetCombatState();
  clearWorld();
  G.events.length = 0;
  G.mode = 'play';
  G.scene = 'dungeon';
  G.panel = null;
  G.paused = false;
  G.map = openRoom(w, h);
  const p = makePlayer('warrior', 'magic', 'T');
  p.x = C(4);
  p.y = C(Math.floor(h / 2));
  G.player = p;
}

function run(sec: number, each?: () => void): void {
  for (let i = 0, n = Math.round(sec / DT); i < n; i++) {
    updateEnemies(DT);
    each?.();
  }
}

/** ext() 返回同一个对象（只读类型仅为对外约束），测试里需要直接改动作 */
const extOf = (e: Enemy): EnemyExt => enemyDebug(e) as EnemyExt;

beforeEach(() => {
  G.events.length = 0;
});

describe('review · enemies × combat/skills/world 衔接', () => {
  it('镜像对手的护盾技能（castByKind 直接写 e.shield）持续约 6 秒，而不是下一步就被当成到期清零', () => {
    setupRoom();
    const r = spawnRival('warrior', 'magic', 0, C(20), C(10));
    r.spawnT = 0;
    // 让它在原地不放别的技能（只验证护盾计时）
    r.rival!.cdQ = r.rival!.cdE = r.rival!.cdR = 999;
    const x = extOf(r);
    x.t1 = x.t2 = x.t3 = x.subT = 999;
    const ironwall = SKILLS.warrior[2];
    expect(ironwall.kind).toBe('buff');
    castByKind(r, ironwall, null);
    const sh0 = r.shield;
    expect(sh0).toBeGreaterThan(0);
    run(1);
    expect(r.shield).toBeCloseTo(sh0); // 修复前：第一步就变成 0
    run(4.5);
    expect(r.shield).toBeGreaterThan(0);
    run(1);
    expect(r.shield).toBe(0); // 约 6 秒后自然到期
    expect(extOf(r).act?.k).not.toBe('stagger'); // 自然到期不算破盾
  });

  it('镜像的外部护盾被打破时同样“破盾踉跄”', () => {
    setupRoom();
    const r = spawnRival('cryo', 'magic', 0, C(20), C(10));
    r.spawnT = 0;
    r.rival!.cdQ = r.rival!.cdE = r.rival!.cdR = 999;
    const x = extOf(r);
    x.t1 = x.t2 = x.t3 = x.subT = 999;
    castByKind(r, SKILLS.cryo[2], null); // 寒冰护盾
    expect(r.shield).toBeGreaterThan(0);
    run(0.5);
    // 玩家打破护盾（combat.damageEnemy 先扣盾：这里直接模拟扣到 0）
    r.shield = 0;
    run(DT);
    expect(extOf(r).act?.k).toBe('stagger');
  });

  it('击败首领后（world 置 spawner.cap=0）刷怪器不再补怪，回城传送阵开启', () => {
    newGame('warrior', 'magic', 'T', 0);
    G.seed = 12345;
    enterDungeon('ruins', 3);
    const b = G.boss!;
    expect(b).toBeTruthy();
    expect(G.spawner).toBeTruthy();
    // 只留首领：存活数为 0，刷怪器若不停一定会补怪
    G.enemies.length = 0;
    G.enemies.push(b);
    G.player!.invuln = 999;
    b.spawnT = 0;
    killEnemy(b);
    for (let i = 0; i < 60; i++) step(DT);
    expect(G.portals.some(pt => pt.kind === 'city' && pt.label === '回城传送阵')).toBe(true);
    expect(G.boss).toBeNull();
    const total0 = G.spawner!.total;
    for (let i = 0; i < 60 * 40; i++) {
      G.player!.invuln = 999;
      step(DT);
      G.events.length = 0;
    }
    expect(G.mode).toBe('play');
    expect(G.spawner!.cap).toBe(0); // 修复前：下一步就被改回 26+
    expect(G.spawner!.total).toBe(total0);
    expect(G.enemies.filter(e => !e.dead).length).toBe(0);
  });

  it('外部改写 cap 后以新值为基准（仍随停留时间缓慢增长），不会被旧基准覆盖', () => {
    setupRoom(64, 30);
    G.spawnPoints = [];
    initSpawner(['slime'], 20, 1, 3);
    updateSpawner(DT);
    expect(G.spawner!.cap).toBe(20);
    G.spawner!.cap = 8;
    updateSpawner(DT);
    expect(G.spawner!.cap).toBe(8);
    for (let i = 0; i < 600; i++) updateSpawner(1);
    expect(G.spawner!.cap).toBe(12); // 8 × 1.5（10 分钟封顶 +50%）
  });

  it('巫妖冰刺螺旋：每 4 波才响一次音效（不再同一波每步都发）', () => {
    setupRoom(34, 22);
    const p = G.player!;
    p.x = C(8);
    p.y = C(11);
    p.invuln = 999;
    const b = spawnEnemy('lich', C(20), C(11), { lv: 10 });
    b.spawnT = 0;
    b.cdSkill = 999; // 只放注入的这一招
    const x = extOf(b);
    x.act = newAct('spiral', 0.5, { a: 0, dx: 1 });
    let sfxN = 0;
    let volleys = 0;
    run(0.5 + 2.2 + 0.6, () => {
      p.invuln = 999;
      for (const ev of G.events as FxEvent[]) if (ev.t === 'sfx' && ev.name === 'ice') sfxN++;
      G.events.length = 0;
      volleys = Math.max(volleys, x.act?.n ?? volleys);
    });
    expect(volleys).toBeGreaterThanOrEqual(20);
    // 22 波 → 第 1/5/9/13/17/21 波各一次 = 6 次；修复前约 6×6=36 次
    expect(sfxN).toBeGreaterThanOrEqual(4);
    expect(sfxN).toBeLessThanOrEqual(7);
  });

  it('首领冲锋的路线预警（lane telegraph）持续整个前摇，而不是渲染层固定的 0.45s', () => {
    setupRoom(34, 22);
    const p = G.player!;
    p.x = C(8);
    p.y = C(11);
    p.invuln = 999;
    const b = spawnEnemy('warden', C(16), C(11), { lv: 5 });
    b.spawnT = 0;
    b.cdSkill = 0;
    const m = bossMem(extOf(b));
    m.cds.quake = m.cds.boulder = 999; // 只留冲锋可用
    let lane: Extract<FxEvent, { t: 'telegraph' }> | undefined;
    run(0.5, () => {
      p.invuln = 999;
      for (const ev of G.events) if (!lane && ev.t === 'telegraph' && ev.shape === 'lane') lane = ev;
      G.events.length = 0;
    });
    expect(lane).toBeDefined();
    expect(lane!.dur).toBeCloseTo(0.7); // 执守者一阶段冲锋前摇 0.7s
    expect(Math.hypot(lane!.x1! - lane!.x, lane!.y1! - lane!.y)).toBeGreaterThan(100);
    expect(extOf(b).act?.k).toBe('charge');
  });

  it('冲锋位移阶段保留速度（渲染层据此播放奔跑而不是待机）', () => {
    setupRoom(24, 12);
    const p = G.player!;
    p.x = C(3);
    p.y = C(6);
    p.invuln = 999;
    const g = spawnEnemy('golem', C(3) + 170, C(6), { aggro: true });
    g.spawnT = 0;
    g.cdSkill = 0;
    g.cdAtk = 99;
    let maxSpd = 0;
    let sawGo = false;
    run(2, () => {
      p.invuln = 999;
      const a = extOf(g).act;
      if (a && a.k === 'charge' && a.ph === 'go') {
        sawGo = true;
        maxSpd = Math.max(maxSpd, Math.hypot(g.vx, g.vy));
      }
    });
    expect(sawGo).toBe(true);
    expect(maxSpd).toBeGreaterThan(200); // 冲锋 520 u/s；修复前恒为 0
  });
});
