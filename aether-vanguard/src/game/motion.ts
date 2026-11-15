// 位移脚本（combat 代理内部模块）：冲刺 / 冲锋 / 闪烁连斩的插值位移，附带沿途扫掠命中与残影。
// 修正 legacy“同一帧瞬移”（L1144 冲刺、L1289 charge、L1417 rival 冲刺）：每步按速度推进，全部走 moveCircle。
// 推进方：玩家的脚本由 skills.tickDash（sim 每步调用）推进；其他实体（镜像对手）由 hazards.updateHazards 推进。

import { G, emit } from './state';
import type { Actor, Team } from './types';
import { moveCircle } from '../world/collision';
import { distToSeg } from '../core/util';
import { hostilesOf, isEnemyActor, isPlayerActor } from './combatUtil';

export interface MotionSeg {
  /** 固定方向（单位向量）+ 时长 */
  dir?: { x: number; y: number };
  dur?: number;
  /** 或：段开始时才求目标点（目标会移动）；返回 null 跳过该段 */
  to?: () => { x: number; y: number } | null;
  /** 速度（世界单位/秒） */
  speed: number;
  /** 到达段终点（或被墙挡住提前结束）时回调 */
  onArrive?: () => void;
}

export interface MotionSpec {
  segs: MotionSeg[];
  /** 沿途扫掠命中：同一目标整段脚本只触发一次 */
  sweep?: { r: number; team: Team; fn: (t: Actor) => void };
  /** 残影事件数（开始时 1 个，其余均匀分布在全程） */
  afterimages?: number;
  /** 自然结束时回调（被取消时不调用） */
  onEnd?: () => void;
}

interface Running {
  a: Actor;
  spec: MotionSpec;
  /** 当前段下标 */
  i: number;
  cur: { vx: number; vy: number; t: number } | null;
  hit: Set<number>;
  aiLeft: number;
  aiEvery: number;
  aiT: number;
  /** 开始时的地图：切场景后自动取消 */
  map: unknown;
}

/** 目标点段的预估时长（只用于残影间隔与 dashT 估计） */
const HOP_GUESS = 0.08;
const motions = new Map<number, Running>();

function segGuess(s: MotionSeg): number {
  return s.dir ? (s.dur ?? 0) : HOP_GUESS;
}

/** 开始一段位移脚本（同一实体已有脚本时先取消旧的） */
export function startMotion(a: Actor, spec: MotionSpec): void {
  cancelMotion(a.id);
  const total = spec.segs.reduce((s, g) => s + segGuess(g), 0);
  const n = Math.max(0, Math.floor(spec.afterimages ?? 0));
  const m: Running = {
    a, spec, i: 0, cur: null, hit: new Set(),
    aiLeft: n, aiEvery: n > 1 ? total / n : total, aiT: 0, map: G.map,
  };
  motions.set(a.id, m);
  if (m.aiLeft > 0) {
    emit({ t: 'afterimage', actorId: a.id });
    m.aiLeft--;
    m.aiT = m.aiEvery;
  }
  if (isPlayerActor(a)) a.dashT = Math.max(total, 0.01);
}

export function inMotion(id: number): boolean {
  return motions.has(id);
}

/** 取消（不触发 onEnd） */
export function cancelMotion(id: number): void {
  const m = motions.get(id);
  if (m) finish(m, false);
}

export function resetMotions(): void {
  for (const m of [...motions.values()]) finish(m, false);
  motions.clear();
}

function finish(m: Running, natural: boolean): void {
  if (motions.get(m.a.id) === m) motions.delete(m.a.id);
  const a = m.a;
  a.vx = 0;
  a.vy = 0;
  if (isPlayerActor(a)) {
    a.dashT = 0;
    a.dashVx = 0;
    a.dashVy = 0;
  }
  if (natural) m.spec.onEnd?.();
}

function remaining(m: Running): number {
  let t = m.cur ? m.cur.t : 0;
  for (let k = m.cur ? m.i + 1 : m.i; k < m.spec.segs.length; k++) t += segGuess(m.spec.segs[k]);
  return t;
}

function sweep(m: Running, x0: number, y0: number): void {
  const sw = m.spec.sweep;
  if (!sw) return;
  const a = m.a;
  for (const t of hostilesOf(sw.team)) {
    if (m.hit.has(t.id)) continue;
    if (distToSeg(t.x, t.y, x0, y0, a.x, a.y) > sw.r + t.r) continue;
    m.hit.add(t.id);
    sw.fn(t);
    if (motions.get(a.id) !== m) return; // 回调里被取消（例如施法者死亡）
  }
}

/** 推进实体 a 的位移脚本，返回推进后是否仍在位移中 */
export function advanceMotion(a: Actor, dt: number): boolean {
  const m = motions.get(a.id);
  if (!m) return false;
  if (m.a !== a || a.dead || m.map !== G.map) {
    finish(m, false);
    return false;
  }
  let remain = dt;
  let guard = 0;
  while (remain > 1e-9 && guard++ < 24) {
    if (!m.cur) {
      if (m.i >= m.spec.segs.length) break;
      const seg = m.spec.segs[m.i];
      let vx = 0, vy = 0, t = 0;
      if (seg.to) {
        const p = seg.to();
        if (!p) { m.i++; continue; }
        const dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy);
        if (d >= 1 && seg.speed > 0) {
          vx = (dx / d) * seg.speed;
          vy = (dy / d) * seg.speed;
          t = d / seg.speed;
        }
      } else if (seg.dir) {
        vx = seg.dir.x * seg.speed;
        vy = seg.dir.y * seg.speed;
        t = seg.dur ?? 0;
      }
      if (t <= 0) {
        m.i++;
        seg.onArrive?.();
        if (motions.get(a.id) !== m) return false;
        continue;
      }
      m.cur = { vx, vy, t };
    }
    const c = m.cur;
    const step = Math.min(remain, c.t);
    const x0 = a.x, y0 = a.y;
    const wx = c.vx * step, wy = c.vy * step;
    if (G.map) moveCircle(G.map, a, wx, wy);
    else { a.x += wx; a.y += wy; }
    sweep(m, x0, y0);
    if (motions.get(a.id) !== m) return false;
    c.t -= step;
    remain -= step;
    const want = Math.hypot(wx, wy), moved = Math.hypot(a.x - x0, a.y - y0);
    // 顶墙（实际位移不足期望的 25%）：提前结束本段，避免对着墙空转
    const blocked = want > 1 && moved < want * 0.25;
    if (c.t <= 1e-6 || blocked) {
      const seg = m.spec.segs[m.i];
      m.cur = null;
      m.i++;
      seg.onArrive?.();
      if (motions.get(a.id) !== m) return false;
    }
  }
  // 残影
  m.aiT -= dt;
  if (m.aiLeft > 0 && m.aiT <= 0) {
    emit({ t: 'afterimage', actorId: a.id });
    m.aiLeft--;
    m.aiT += m.aiEvery;
  }
  if (!m.cur && m.i >= m.spec.segs.length) {
    finish(m, true);
    return false;
  }
  a.vx = m.cur ? m.cur.vx : 0;
  a.vy = m.cur ? m.cur.vy : 0;
  if (isPlayerActor(a)) {
    a.dashT = Math.max(0.001, remaining(m));
    a.dashVx = a.vx;
    a.dashVy = a.vy;
  }
  return true;
}

/** 推进除玩家以外所有实体的位移脚本（镜像对手的冲锋），由 updateHazards 每步调用 */
export function advanceOtherMotions(dt: number): void {
  for (const m of [...motions.values()]) {
    const a = m.a;
    if (isPlayerActor(a)) {
      if (G.player !== a) finish(m, false); // 旧角色残留
      continue;
    }
    if (!isEnemyActor(a) || !G.enemies.includes(a)) { finish(m, false); continue; }
    advanceMotion(a, dt);
  }
}
