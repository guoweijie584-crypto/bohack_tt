// 刷怪器：改版意见“怪数量增加，无限刷新”。在玩家视野外、可达的位置补怪，维持存活上限；定期刷精英。
// 【契约】签名不可改；实现由 enemies 代理完成。
//
// 规则：
// - 只在副本（G.scene==='dungeon'）里工作，主城与竞技场不刷；
// - 每 1.2–2.5s 检查一次：存活数（首领不计，召唤物按半只计）< cap 时，从 G.spawnPoints 里选一个
//   距玩家 420–900、不在当前视野内（map.isVisibleWorld 为 false）、流场可达的点，按池权重刷 1–3 只；
// - 精英概率 6% + 层数×2%；约 30% 的怪群出生即“猎杀”玩家（仇恨），其余在原地闲逛等玩家探索；
// - cap 随本层停留时间缓慢增长（每分钟 +10%，最多 +50%）；
// - 刷怪器刷出、远离玩家（>1300）、未仇恨、非精英且 15s 以上不在视野内的怪会被静默回收，
//   让怪群“跟着”玩家的推进方向刷新，而不是堆在身后。

import { rng } from '../core/rng';
import { ENEMIES, SUMMON_ONLY_KINDS } from '../data/enemies';
import { isFree } from '../world/collision';
import { spawnEnemy } from './enemies';
import { prepareNav, spotNear, walkLine } from './enemyNav';
import { G, type SpawnerState } from './state';
import type { Enemy, Player } from './types';

/** 刷怪点与玩家的距离区间 */
export const SPAWN_MIN_DIST = 420;
export const SPAWN_MAX_DIST = 900;
/** 回收：距离与不可见时长 */
const CULL_DIST = 1300;
const CULL_T = 15;

interface SpawnerMeta {
  baseCap: number;
  elapsed: number;
  /** 上一次写回 s.cap 的值：与 s.cap 不同 = 被外部改写（world：首领被击败 / 试炼结束时置 0 停止补怪） */
  cap: number;
}
const meta = new WeakMap<SpawnerState, SpawnerMeta>();
/** 刷怪器刷出的怪 → 连续不可见秒数 */
const spawned = new WeakMap<Enemy, number>();

export function initSpawner(pool: string[], cap: number, mul: number, lv: number): void {
  const s: SpawnerState = { cap: Math.max(0, Math.round(cap)), t: rng.range(1.0, 2.0), total: 0, pool: pool.slice(), mul, lv };
  G.spawner = s;
  meta.set(s, { baseCap: s.cap, elapsed: 0, cap: s.cap });
}

export function updateSpawner(dt: number): void {
  const s = G.spawner, map = G.map, p = G.player;
  if (!s || !map || !p || p.dead || p.hp <= 0) return;
  if (G.scene !== 'dungeon') return;
  let m = meta.get(s);
  if (!m) {
    m = { baseCap: s.cap, elapsed: 0, cap: s.cap };
    meta.set(s, m);
  }
  // 外部改写了上限（world 在首领死亡/试炼结束时置 0）：以外部值为新基准，而不是下一步按旧基准覆盖回去
  // （修复：之前击败首领后 cap=0 被立刻改回，回城传送阵开了怪还在无限补）
  if (s.cap !== m.cap) {
    m.baseCap = Math.max(0, s.cap);
    m.elapsed = 0;
  }
  m.elapsed += dt;
  s.cap = Math.round(m.baseCap * (1 + Math.min(0.5, m.elapsed / 600)));
  m.cap = s.cap;
  cullFar(p, dt);
  s.t -= dt;
  if (s.t > 0) return;
  s.t = rng.range(1.2, 2.5);
  if (!s.pool.length) return;
  const alive = population();
  if (alive >= s.cap) return;
  prepareNav(p.x, p.y);
  const pt = pickSpawnPoint(p);
  if (!pt) return;
  const n = Math.min(rng.int(1, 3), Math.ceil(s.cap - alive));
  const eliteChance = 0.06 + Math.max(0, G.floor) * 0.02;
  const hunt = rng.chance(0.3);
  let made = 0;
  for (let i = 0; i < n; i++) {
    const kind = pickKind(s.pool);
    const def = kind ? ENEMIES[kind] : undefined;
    if (!kind || !def) continue;
    const elite = !!def.elite || rng.chance(eliteChance);
    const pos = scatter(pt.x, pt.y, def.r, i);
    const lv = Math.max(1, s.lv + rng.int(-1, 1) + (elite && !def.elite ? 1 : 0));
    const e = spawnEnemy(kind, pos.x, pos.y, { lv, mul: s.mul, elite, aggro: hunt || elite });
    spawned.set(e, 0);
    made++;
  }
  s.total += made;
}

/** 计入上限的存活数：首领不计；召唤物按半只计（召唤者多时少补一些，避免怪海失控） */
function population(): number {
  let n = 0;
  for (const e of G.enemies) {
    if (e.dead || e.boss) continue;
    n += e.summonedBy === undefined ? 1 : 0.5;
  }
  return n;
}

/** 候选点：距玩家 420–900、不在视野内、不在墙里、流场可达 */
function pickSpawnPoint(p: Player): { x: number; y: number } | null {
  const map = G.map!;
  const flow = G.flow;
  const cands: Array<{ x: number; y: number }> = [];
  for (const sp of G.spawnPoints) {
    const d = Math.hypot(sp.x - p.x, sp.y - p.y);
    if (d < SPAWN_MIN_DIST || d > SPAWN_MAX_DIST) continue;
    if (map.solidAtWorld(sp.x, sp.y)) continue;
    if (map.isVisibleWorld(sp.x, sp.y)) continue;
    if (flow && !flow.reachable(sp.x, sp.y)) continue;
    cands.push(sp);
  }
  return cands.length ? rng.pick(cands) : null;
}

/**
 * 按池权重抽一个 kind：池里重复出现即加权；精英种 ×0.35、召唤者 ×0.6；首领与召唤专属种不刷。
 */
function pickKind(pool: readonly string[]): string | null {
  let total = 0;
  const w = pool.map(k => {
    const d = ENEMIES[k];
    const v = !d || d.boss || SUMMON_ONLY_KINDS.has(k) ? 0 : d.elite ? 0.35 : d.ai === 'summoner' ? 0.6 : 1;
    total += v;
    return v;
  });
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= w[i];
    if (r <= 0 && w[i] > 0) return pool[i];
  }
  for (let i = pool.length - 1; i >= 0; i--) if (w[i] > 0) return pool[i];
  return null;
}

/** 同一群的散布位置：与刷怪点直线连通、能容纳半径、且同样不在视野内；否则就用刷怪点本身 */
function scatter(x: number, y: number, r: number, i: number): { x: number; y: number } {
  const map = G.map!;
  if (i === 0) return { x, y };
  const s = spotNear(x, y, rng.range(0, Math.PI * 2), rng.range(18, 40), r);
  if (s && isFree(map, s.x, s.y, r) && !map.isVisibleWorld(s.x, s.y) && walkLine(map, x, y, s.x, s.y)) return s;
  return { x, y };
}

/** 回收远离玩家且长期不在视野内的“闲置”刷怪（不掉落、无表现，直接移出数组） */
function cullFar(p: Player, dt: number): void {
  const map = G.map!;
  const list = G.enemies;
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const unseen = spawned.get(e);
    if (unseen !== undefined && !e.dead && !e.aggro && !e.elite && !e.boss) {
      const far = Math.hypot(e.x - p.x, e.y - p.y) > CULL_DIST && !map.isVisibleWorld(e.x, e.y);
      const t = far ? unseen + dt : 0;
      spawned.set(e, t);
      if (t > CULL_T) continue;
    }
    list[w++] = e;
  }
  list.length = w;
}
