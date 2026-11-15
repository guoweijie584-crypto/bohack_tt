// combat 区审查回归测试：跨模块衔接（不打桩，真实的 enemies / world / sim / drops 一起跑）
import { describe, it, expect, beforeEach } from 'vitest';
import { G, createInput } from '../src/game/state';
import type { Enemy, Player } from '../src/game/types';
import { GridMap } from '../src/world/grid';
import { isFree } from '../src/world/collision';
import { T } from '../src/data/tiles';
import { TILE } from '../src/config';
import { SKILLS, ULTS } from '../src/data/skills';
import { makePlayer } from '../src/game/player';
import { newGame, step } from '../src/game/sim';
import { enterArena } from '../src/game/world';
import { spawnEnemy, spawnRival, updateEnemies } from '../src/game/enemies';
import { updateHazards } from '../src/game/hazards';
import { applyStatus, damageEnemy, damagePlayer, killEnemy, knockback, tickKnockback } from '../src/game/combat';
import { attackReach, autoTarget, basicAttack, castByKind, resetCombatState } from '../src/game/skills';

const DT = 1 / 60;
const C = (t: number): number => t * TILE + TILE / 2;

/** w×h 的空房间（四周墙），可选一块矩形熔岩池 */
function openMap(w: number, h: number, lava?: { x0: number; y0: number; x1: number; y1: number }): GridMap {
  const m = new GridMap(w, h, 'dungeon', T.WALL);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) m.set(x, y, T.FLOOR);
  if (lava) for (let y = lava.y0; y <= lava.y1; y++) for (let x = lava.x0; x <= lava.x1; x++) m.set(x, y, T.LAVA);
  m.fog = false;
  return m;
}

function setupField(map: GridMap, cid = 'warrior', px = C(5), py = C(6)): Player {
  resetCombatState();
  G.mode = 'play';
  G.scene = 'dungeon';
  G.panel = null;
  G.paused = false;
  G.autoAttack = false;
  G.time = 0;
  G.enemies.length = 0;
  G.projectiles.length = 0;
  G.hazards.length = 0;
  G.drops.length = 0;
  G.portals.length = 0;
  G.npcs.length = 0;
  G.decor.length = 0;
  G.boss = null;
  G.spawner = null;
  G.events.length = 0;
  G.input = createInput();
  G.map = map;
  G.flow = null;
  const p = makePlayer(cid, 'magic', '测试');
  p.x = px;
  p.y = py;
  G.player = p;
  return p;
}

const toasts = (): string[] => G.events.filter((e): e is Extract<typeof e, { t: 'toast' }> => e.t === 'toast').map(e => e.text);

beforeEach(() => {
  G.events.length = 0;
});

/* ------------------------------------------------------------------ */
/* 镜像对手的护盾 / 增益（skills ↔ enemies ↔ 渲染层契约）                  */
/* ------------------------------------------------------------------ */

describe('镜像对手施法的护盾与增益', () => {
  /** 玩家远在 1500 外：对手只会走位，不会再放技能/普攻，便于单独观察护盾计时 */
  function farRival(cid: string): { p: Player; r: Enemy } {
    const p = setupField(openMap(60, 14), 'warrior', C(55), C(6));
    const r = spawnRival(cid, 'magic', 0, C(5), C(6));
    r.spawnT = 0;
    return { p, r };
  }

  it('铁壁护盾按时长保留（修：没有 shieldT 时 enemies.tickShieldTimer 下一步就清零）', () => {
    const { r } = farRival('warrior');
    castByKind(r, SKILLS.warrior[2], null);
    const sh = r.shield;
    expect(sh).toBeCloseTo(r.maxHp * 0.2);
    for (let i = 0; i < 60; i++) updateEnemies(DT); // 1 秒
    expect(r.shield).toBeCloseTo(sh);
    for (let i = 0; i < 60 * 5.2; i++) updateEnemies(DT); // 累计 6.2 秒：自然到期
    expect(r.shield).toBe(0);
  });

  it('寒冰护盾 8 秒、不屈壁垒按奥义时长；护盾先吸收伤害', () => {
    const { r } = farRival('cryo');
    castByKind(r, SKILLS.cryo[2], null);
    for (let i = 0; i < 60 * 7; i++) updateEnemies(DT);
    expect(r.shield).toBeGreaterThan(0);
    const hp0 = r.hp;
    expect(damageEnemy(r, 10, { el: 'physical' })).toBe(0);
    expect(r.hp).toBe(hp0);

    const b = farRival('warrior').r;
    castByKind(b, ULTS.bulwark, 'bulwark');
    for (let i = 0; i < 60 * 3; i++) updateEnemies(DT);
    expect(b.shield).toBeCloseTo(b.maxHp * 0.3);
  });

  it('对手潜行写到 Enemy.buffs（渲染层据此半透明），计时归零；死亡时清空', () => {
    const { r } = farRival('assassin');
    castByKind(r, SKILLS.assassin[1], null);
    expect(r.buffs?.stealth).toBeGreaterThan(0);
    for (let i = 0; i < 60 * 6.2; i++) updateHazards(DT);
    expect(r.buffs?.stealth).toBe(0);
    castByKind(r, SKILLS.storm[2], null); // 过载
    expect(r.buffs?.overload).toBeGreaterThan(0);
    killEnemy(r);
    expect(r.buffs?.overload).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 竞技场结算（combat.playerDie ↔ world.updateArena）                      */
/* ------------------------------------------------------------------ */

describe('竞技场结算', () => {
  it('已击败镜像、等待胜利结算时被残留中毒磨死：仍按胜利结算（连胜 +1，不清零）', () => {
    newGame('warrior', 'magic', '测试', 0);
    const p = G.player as Player;
    p.streak = 3;
    enterArena();
    const r = G.enemies.find(e => e.rival) as Enemy;
    expect(r).toBeDefined();
    killEnemy(r);
    step(DT); // world 记下胜利，开始 1.2s 停顿
    expect(G.scene).toBe('arena');
    const deaths = p.deaths;
    p.hp = 5;
    applyStatus(p, 'poison', 3, 60, 5); // 足以致死的 DoT（无视无敌帧）
    const seen: string[] = [];
    for (let i = 0; i < 60 * 3 && G.scene === 'arena'; i++) {
      step(DT);
      seen.push(...toasts());
      G.events.length = 0;
    }
    expect(G.scene).toBe('city');
    expect(G.mode).toBe('play');
    expect(p.streak).toBe(4);
    expect(p.arenaWins).toBe(1);
    expect(p.deaths).toBe(deaths);
    expect(seen.some(t => t.includes('落败'))).toBe(false);
    expect(p.hp).toBeGreaterThan(0);
  });

  it('镜像还活着时被打倒：照常判负、回城、连胜清零（不进死亡页）', () => {
    newGame('pyro', 'magic', '测试', 0);
    const p = G.player as Player;
    p.streak = 2;
    enterArena();
    expect(G.enemies.some(e => e.rival && !e.dead)).toBe(true);
    damagePlayer(p, 99999);
    expect(G.scene).toBe('city');
    expect(G.mode).toBe('play');
    expect(p.streak).toBe(0);
    expect(p.deaths).toBe(0); // 竞技场落败不算真实死亡
    expect(p.hp).toBe(p.stat.maxHp);
  });
});

/* ------------------------------------------------------------------ */
/* 击退与飞行单位（combat.tickKnockback ↔ enemyNav.collMap）              */
/* ------------------------------------------------------------------ */

describe('击退使用怪物自己的碰撞图', () => {
  it('飞行怪悬停在熔岩上方被击退：位移 ≈ 初速度/6（修：按原图把熔岩当墙，击退第一小步就被清零）', () => {
    setupField(openMap(30, 14, { x0: 10, y0: 3, x1: 20, y1: 10 }), 'warrior', C(4), C(6));
    const bat = spawnEnemy('bat', C(15), C(6), { lv: 1 });
    bat.x = C(15); // 出生点被 nearestFree 挪到岸上，这里直接放回熔岩中央（飞行怪本来就能飞过去）
    bat.y = C(6);
    bat.spawnT = 0;
    const x0 = bat.x;
    knockback(bat, bat.x - 10, bat.y, 140);
    for (let i = 0; i < 120; i++) tickKnockback(bat, DT);
    expect(bat.x - x0).toBeGreaterThan(140 / 6 - 1.5);
    expect(bat.x - x0).toBeLessThan(140 / 6 + 1.5);
    expect(Math.abs(bat.y - C(6))).toBeLessThan(0.5);
  });

  it('地面怪被击退到熔岩边：仍停在岸上（不会被推进熔岩）', () => {
    setupField(openMap(30, 14, { x0: 10, y0: 3, x1: 20, y1: 10 }), 'warrior', C(4), C(6));
    const g = spawnEnemy('goblin', C(8), C(6), { lv: 1 });
    g.spawnT = 0;
    knockback(g, g.x - 10, g.y, 900);
    for (let i = 0; i < 120; i++) tickKnockback(g, DT);
    expect(g.x).toBeLessThan(10 * TILE);
    expect(isFree(G.map as GridMap, g.x, g.y, g.r)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 自动攻击触发距离（sim ↔ skills.attackReach ↔ 近战判定）                */
/* ------------------------------------------------------------------ */

describe('自动攻击：近战只在打得到时出手', () => {
  for (const cid of ['warrior', 'assassin', 'knight', 'armored', 'ninja', 'stormblade', 'stormguard']) {
    it(cid, () => {
      const p = setupField(openMap(40, 14), cid, C(5), C(6));
      const reach = attackReach(p);
      const e = spawnEnemy('golem', C(20), C(6), { lv: 1 });
      e.x = p.x + reach + e.r - 0.5; // 刚好进入自动攻击的触发距离
      e.y = p.y;
      e.spawnT = 0;
      e.hp = e.maxHp = 1e6;
      // sim.step 的自动攻击判定：autoTarget(p, attackReach) 有目标就 basicAttack（无鼠标瞄准时软锁定）
      expect(autoTarget(p.x, p.y, reach, 'player')).toBe(e);
      basicAttack(p);
      expect(p.cd.atk).toBeGreaterThan(0);
      expect(e.hp).toBeLessThan(1e6); // 出手即命中（修：+20 余量时这一刀在打不到的距离空挥）
    });
  }
});
