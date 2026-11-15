// world 分区审查的回归测试：全部用真实模块（enemies / spawner / combat / items / player 不打桩），
// 覆盖 world/drops 与其它模块的衔接（tests/world.test.ts 把这些都打桩了，衔接问题测不出来）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/rng', async importOriginal => {
  const m = await importOriginal<typeof import('../src/core/rng')>();
  return { ...m, rng: new m.Rng(20261115) };
});

import { TILE } from '../src/config';
import { DUNGEONS, DUNGEON_ORDER, secretLevel } from '../src/data/dungeons';
import { T } from '../src/data/tiles';
import { GridMap } from '../src/world/grid';
import { isFree } from '../src/world/collision';
import { G } from '../src/game/state';
import { recalc } from '../src/game/player';
import { newGame, step } from '../src/game/sim';
import { applyStatus, damagePlayer, killEnemy, tickStatus } from '../src/game/combat';
import { spawnEnemy } from '../src/game/enemies';
import { CHARGER } from '../src/game/enemyAi';
import { clickPickup, spawnDrop } from '../src/game/drops';
import { enterArena, enterCity, enterDungeon, enterSecret, getTrial, peekTrial, spikesUp, updateWorld } from '../src/game/world';
import type { Decor } from '../src/game/types';

const DT = 1 / 60;
const C = (t: number): number => t * TILE + TILE / 2;

function start(cid = 'warrior'): void {
  newGame(cid, 'magic', 'T', 0);
  G.seed = 777; // 地图与刷怪确定
  G.events.length = 0;
}

/** 秘境下一次试炼换成指定类型（主城每次进入都会重抽） */
function rollTrial(id: string): void {
  for (let i = 0; i < 80 && peekTrial().id !== id; i++) enterCity();
  expect(peekTrial().id).toBe(id);
}

beforeEach(() => {
  G.events.length = 0;
});

describe('review · world × enemies/combat/drops 衔接', () => {
  it('预刷在房间里的怪（含精英房精英、首领）出生不仇恨；首领守在首领房，不会开局就离房追人', () => {
    start();
    for (const [id, f] of [['ruins', 1], ['ruins', 2], ['magma', 2], ['frost', 3], ['crypt', 2], ['ruins', 3]] as const) {
      enterDungeon(id, f);
      expect(G.enemies.length, `${id} F${f}`).toBeGreaterThan(5);
      // 修复前：spawnEnemy 默认“精英/首领出生即仇恨”，每层平均近 2 只 900 内的精英开局就冲向出生点
      expect(G.enemies.filter(e => e.aggro).map(e => e.kind), `${id} F${f}`).toEqual([]);
      expect(G.enemies.some(e => e.elite), `${id} F${f} 有精英房`).toBe(true);
    }
    // 最后一层是首领层：玩家站在出生点 6 秒，首领只在首领房里闲逛
    const b = G.boss!;
    expect(b.boss).toBe(true);
    const x0 = b.x, y0 = b.y;
    const p = G.player!;
    for (let i = 0; i < 6 * 60; i++) {
      p.invuln = 99;
      step(DT);
      G.events.length = 0;
    }
    expect(G.mode).toBe('play');
    expect(b.dead).toBe(false);
    expect(Math.hypot(b.x - x0, b.y - y0)).toBeLessThan(100); // 修复前：仇恨 4 秒追出约 190
  });

  it('秘境守关者血厚但不会一下冲撞秒杀推荐等级的法师；精英守卫守在远处房间', () => {
    start('pyro');
    const p = G.player!;
    p.lv = secretLevel(p.bestFloor || 1);
    recalc(p, true);

    rollTrial('guardian');
    enterSecret();
    expect(getTrial()?.id).toBe('guardian');
    const g = G.boss!;
    expect(g.kind).toBe(DUNGEONS.secret.boss);
    expect(g.aggro).toBe(false);
    expect(g.hp).toBe(g.maxHp);
    // 血量：仍是同级同层精英的 2 倍以上（“守关者”）
    const ref = spawnEnemy(g.kind, g.x, g.y, { lv: g.lv, mul: 1.12, elite: true, aggro: false });
    expect(g.maxHp).toBeGreaterThan(ref.maxHp * 2);
    ref.dead = true;
    // 攻击：冲撞（CHARGER.mult）打满血的推荐等级法师不致死（修复前 atk ×2.6 → 一下 260+ 伤害，法师 168 血）
    p.invuln = 0;
    p.hp = p.stat.maxHp;
    damagePlayer(p, g.atk * CHARGER.mult, { el: g.def.el, srcX: g.x, srcY: g.y });
    expect(G.mode).toBe('play');
    expect(p.hp).toBeGreaterThan(0);

    rollTrial('elite');
    enterSecret();
    expect(getTrial()?.id).toBe('elite');
    expect(G.enemies.filter(e => e.elite).length).toBeGreaterThanOrEqual(getTrial()!.goal);
    expect(G.enemies.filter(e => e.aggro)).toEqual([]);
  });

  it('竞技场：镜像倒下后的胜利停顿里被残留 DoT 带走，仍按胜利结算', () => {
    start();
    const p = G.player!;
    const gold0 = p.gold;
    enterArena();
    const rival = G.enemies.find(e => e.rival)!;
    expect(rival).toBeTruthy();
    rival.spawnT = 0;
    killEnemy(rival);
    updateWorld(0.1); // 进入 1.2s 胜利停顿
    expect(G.scene).toBe('arena');
    // 停顿中被中毒带走（combat.playerDie：回满后交给 world；即使走到 leaveArena(false) 也按胜利结算）
    p.invuln = 0;
    p.hp = 1;
    applyStatus(p, 'poison', 2, 50, 5);
    tickStatus(p, 0.1);
    if (G.scene === 'arena') updateWorld(2); // 停顿结束 → leaveArena(true)
    expect(G.scene).toBe('city');
    expect(G.mode).toBe('play');
    expect(p.streak).toBe(1); // 修复前：判负、连胜清零、没有奖励
    expect(p.arenaWins).toBe(1);
    expect(p.gold).toBeGreaterThan(gold0);
    expect(p.hp).toBe(p.stat.maxHp);
  });

  it('切场景清掉玩家身上的异常：残血中毒走传送阵回城，不会死在主城里', () => {
    start();
    enterDungeon('ruins', 1);
    const p = G.player!;
    p.invuln = 0;
    applyStatus(p, 'poison', 3, 40, 5);
    applyStatus(p, 'poison', 3, 40, 5);
    applyStatus(p, 'slow', 3);
    p.hp = 20;
    expect(Object.keys(p.status).length).toBeGreaterThan(0);
    enterCity('portal');
    expect(p.status).toEqual({});
    for (let i = 0; i < 3 * 60; i++) step(DT);
    expect(G.mode).toBe('play');
    expect(p.dead).toBe(false);
    expect(p.hp).toBeGreaterThanOrEqual(20);
  });

  it('地刺每次扎掉约 6% 最大生命，不被护甲吃成 1 点', () => {
    start('ranger');
    let s: Decor | undefined;
    for (const id of DUNGEON_ORDER) {
      for (let f = 1; f <= 3 && !s; f++) {
        enterDungeon(id, f);
        s = G.decor.find(d => d.kind === 'spikes');
      }
      if (s) break;
    }
    expect(s).toBeDefined();
    const p = G.player!;
    G.enemies.length = 0;
    p.x = s!.x;
    p.y = s!.y - 16;
    p.invuln = 0;
    p.buffs.shield = 0;
    p.buffs.stealth = 0;
    p.hp = p.stat.maxHp;
    expect(p.stat.armor).toBeGreaterThan(3); // 有护甲才测得出来
    G.time = 0;
    while (!spikesUp(s!, G.time)) G.time += 0.05;
    updateWorld(DT);
    const lost = p.stat.maxHp - p.hp;
    expect(lost).toBeGreaterThanOrEqual(Math.round(p.stat.maxHp * 0.06) - 0.5); // 修复前：Lv1 游侠每次 1 点
    expect(lost).toBeLessThan(p.stat.maxHp * 0.1);
  });

  it('宝箱落点在墙里（贴南墙倒下的精英、试炼奖励）时挪到空地，能看见也能点开', () => {
    start();
    const m = new GridMap(12, 10, 'dungeon', T.WALL);
    m.fillRect(1, 1, 10, 6, T.FLOOR); // 第 7 行起是墙
    m.fog = false;
    G.map = m;
    G.scene = 'dungeon';
    G.drops.length = 0;
    const p = G.player!;
    p.x = C(5);
    p.y = C(4);
    // 精英 r=11 贴南墙站在 y = 7*32-11，掉落中宝箱在 e.y+14 —— 落进墙格
    const ey = 7 * TILE - 11;
    const c = spawnDrop({ kind: 'chest', x: C(6), y: ey + 14, tier: 1 });
    expect(m.solidAtWorld(C(6), ey + 14)).toBe(true);
    expect(isFree(m, c.x, c.y, 6)).toBe(true);
    expect(c.y).toBeLessThan(7 * TILE);
    expect(clickPickup(c.x, c.y - c.z)).toBe(true); // 修复前：箱子在不透明墙格里，视线检查失败
    expect(c.opened).toBe(true);
    // 本来就在空地的宝箱不挪
    const ok = spawnDrop({ kind: 'chest', x: C(3), y: C(3), tier: 0 });
    expect([ok.x, ok.y]).toEqual([C(3), C(3)]);
  });
});
