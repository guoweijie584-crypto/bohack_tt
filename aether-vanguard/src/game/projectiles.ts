// 投射物：生成、追踪、撞墙、命中（按阵营）、穿透、溅射。移植自 legacy L1443–1477。
// 【契约】签名不可改；实现由 combat 代理完成。
//
// 与 legacy 的差异：
// - 速度单位 世界单位/秒（legacy v×dt×60）；
// - 撞墙用网格射线（只有不透明格挡弹道：水/岩浆/深坑可以隔着射），撞墙点溅射照样爆炸；
// - 扫掠命中（按本步线段判定，高速不穿怪），同一步多个目标按路径先后结算穿透；
// - 追踪只锁定视线可达、且在前方 ±1.2rad 内的目标（legacy 会掉头追背后的怪、隔墙拐弯撞墙）；
// - 同一齐射（连珠箭）对同一目标最多命中 2 次（legacy 贴脸 7 支全中）；
// - 敌方投射物在玩家冲刺无敌中穿身而过（闪避手感），否则命中即消失。

import type { Actor, Projectile, Team } from './types';
import { G, emit, nextId } from './state';
import { ELEM } from '../data/elements';
import { raycastTo } from '../world/los';
import { clamp, distToSeg, wrapAngle } from '../core/util';
import { damageEnemy, damagePlayer, type HitOpts } from './combat';
import { actorById, angDiff, clearLine, hittable, hostilesOf, isEnemyActor, isPlayerActor } from './combatUtil';

export type ProjectileInit = Partial<Projectile> & Pick<Projectile, 'kind' | 'team' | 'x' | 'y' | 'vx' | 'vy' | 'dmg' | 'el' | 'ownerId'>;

/** 投射物附加信息（共享类型 Projectile 没有这些字段，用 WeakMap 挂载，随投射物回收） */
export interface ProjMeta {
  /** 普攻（mpOnHit / 元素法师交替加成） */
  basic?: boolean;
  atkId?: number;
  isSkill?: boolean;
  /** 齐射编号（同一齐射对同一目标的命中上限） */
  volley?: number;
  /** 命中附带额外减速 */
  slow?: number;
}
const metaOf = new WeakMap<Projectile, ProjMeta>();

export function tagProjectile(q: Projectile, m: ProjMeta): void {
  metaOf.set(q, { ...metaOf.get(q), ...m });
}
export function projectileMeta(q: Projectile): ProjMeta | undefined {
  return metaOf.get(q);
}

/** 同一齐射对同一目标的最大命中次数 */
export const VOLLEY_CAP = 2;
const volleyHits = new Map<number, Map<number, number>>();
let volleySeq = 0;

/** 新建一个齐射编号 */
export function newVolley(): number {
  volleySeq++;
  volleyHits.set(volleySeq, new Map());
  if (volleyHits.size > 64) {
    const oldest = volleyHits.keys().next().value;
    if (oldest !== undefined) volleyHits.delete(oldest);
  }
  return volleySeq;
}

export function resetProjectiles(): void {
  volleyHits.clear();
}

const MAX_PROJ = 340;
const HOMING_RANGE = 340;
/** 追踪只考虑当前航向 ±HOMING_CONE 内的目标 */
const HOMING_CONE = 1.2;
const SPLASH_MUL = 0.45;

function defaultR(kind: Projectile['kind']): number {
  switch (kind) {
    case 'arrow': case 'enemyArrow': return 3;
    case 'shuriken': case 'dagger': case 'bolt': case 'iceShard': return 4;
    case 'fireball': return 6;
    default: return 5;
  }
}

export function spawnProjectile(init: ProjectileInit): Projectile {
  const q: Projectile = {
    id: init.id ?? nextId(),
    kind: init.kind,
    team: init.team,
    x: init.x,
    y: init.y,
    vx: init.vx,
    vy: init.vy,
    r: init.r ?? defaultR(init.kind),
    dmg: init.dmg,
    el: init.el,
    life: init.life ?? 1.7,
    pierce: Math.max(0, Math.floor(init.pierce ?? 0)),
    homing: init.homing ?? 0,
    targetId: init.targetId ?? -1,
    hit: init.hit ? [...init.hit] : [],
    splash: init.splash ?? 0,
    status: init.status,
    stun: init.stun,
    knock: init.knock,
    crit: init.crit,
    color: init.color ?? ELEM[init.el].c,
    ownerId: init.ownerId,
  };
  G.projectiles.push(q);
  if (G.projectiles.length > MAX_PROJ) G.projectiles.splice(0, G.projectiles.length - MAX_PROJ);
  return q;
}

export function updateProjectiles(dt: number): void {
  const list = G.projectiles;
  // 两个阵营的候选目标每次更新只取一次（命中时再用 hittable 复查存活）
  const foes: Record<Team, Actor[]> = { player: hostilesOf('player'), enemy: hostilesOf('enemy') };
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    if (!q || q.life <= 0) continue;
    q.life -= dt;
    if (q.homing > 0) steer(q, dt);
    const x0 = q.x, y0 = q.y;
    let x1 = x0 + q.vx * dt, y1 = y0 + q.vy * dt;
    // 墙：网格射线，截到撞墙点（略微退回，保证落点不在墙格内）
    const tw = G.map ? raycastTo(G.map, x0, y0, x1, y1) : 1;
    if (tw < 1) {
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const t = Math.max(0, tw - 1.5 / len);
      x1 = x0 + (x1 - x0) * t;
      y1 = y0 + (y1 - y0) * t;
    }
    if (sweepHits(q, foes[q.team], x0, y0, x1, y1)) continue;
    q.x = x1;
    q.y = y1;
    if (tw < 1) wallHit(q);
  }
  // 原地压缩（保持数组引用，渲染层可能持有）
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    if (q && q.life > 0) list[w++] = q;
  }
  list.length = w;
}

/** 本步线段上的命中；返回投射物是否已被消耗 */
function sweepHits(q: Projectile, foes: readonly Actor[], x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
  const cands: Array<{ t: Actor; s: number }> = [];
  for (const t of foes) {
    if (!hittable(t) || q.hit.includes(t.id)) continue;
    if (distToSeg(t.x, t.y, x0, y0, x1, y1) > t.r + q.r) continue;
    // 冲刺无敌：敌方弹幕穿身而过
    if (isPlayerActor(t) && t.dashT > 0 && t.invuln > 0) continue;
    cands.push({ t, s: l2 > 0 ? ((t.x - x0) * dx + (t.y - y0) * dy) / l2 : 0 });
  }
  if (!cands.length) return false;
  cands.sort((a, b) => a.s - b.s);
  const m = metaOf.get(q);
  const sp = Math.hypot(q.vx, q.vy) || 1;
  for (const { t, s } of cands) {
    const k = clamp(s, 0, 1);
    const hx = x0 + dx * k, hy = y0 + dy * k;
    q.hit.push(t.id);
    if (m?.volley !== undefined) {
      const vh = volleyHits.get(m.volley);
      if (vh) {
        const c = vh.get(t.id) ?? 0;
        if (c >= VOLLEY_CAP) continue; // 本齐射已命中该目标 2 次：穿过不结算
        vh.set(t.id, c + 1);
      }
    }
    const opts: HitOpts = {
      el: q.el, crit: q.crit, status: q.status, stun: q.stun, knock: q.knock,
      // 来源点取弹道来向（背刺判定、击退方向）
      srcX: hx - (q.vx / sp) * 6, srcY: hy - (q.vy / sp) * 6,
      isSkill: m?.isSkill, basic: m?.basic, atkId: m?.atkId, slow: m?.slow, sourceId: q.ownerId,
    };
    if (isEnemyActor(t)) damageEnemy(t, q.dmg, opts);
    else if (isPlayerActor(t)) damagePlayer(t, q.dmg, opts);
    if (q.splash > 0) splash(q, hx, hy, t.id);
    if (q.pierce > 0) {
      q.pierce--;
      continue;
    }
    q.life = 0;
    q.x = hx;
    q.y = hy;
    return true;
  }
  return false;
}

/** 溅射：命中点周围其它目标受到 45% 伤害（次级伤害，不触发命中特效） */
function splash(q: Projectile, x: number, y: number, excludeId: number): void {
  emit({ t: 'ring', x, y, r0: 4, r1: q.splash, color: q.color, dur: 0.25 });
  const m = metaOf.get(q);
  for (const o of hostilesOf(q.team)) {
    if (o.id === excludeId) continue;
    if (Math.hypot(o.x - x, o.y - y) > q.splash + o.r) continue;
    if (!clearLine(x, y, o.x, o.y)) continue;
    const opts: HitOpts = { el: q.el, status: q.status, srcX: x, srcY: y, isSkill: m?.isSkill, proc: true, sourceId: q.ownerId };
    if (isEnemyActor(o)) damageEnemy(o, q.dmg * SPLASH_MUL, opts);
    else if (isPlayerActor(o)) damagePlayer(o, q.dmg * SPLASH_MUL, opts);
  }
}

function wallHit(q: Projectile): void {
  q.life = 0;
  emit({ t: 'impact', x: q.x, y: q.y, el: q.el, size: 4 });
  if (q.splash > 0) splash(q, q.x, q.y, -1);
}

/** 追踪：保持锁定或在前方锥内找最近目标，按 homing（弧度/秒）转向 */
function steer(q: Projectile, dt: number): void {
  const heading = Math.atan2(q.vy, q.vx);
  const inCone = (t: Actor): boolean => angDiff(Math.atan2(t.y - q.y, t.x - q.x), heading) <= HOMING_CONE;
  let tgt: Actor | null = null;
  if (q.team === 'player') {
    if (q.targetId >= 0) {
      const t = actorById(q.targetId);
      if (t && isEnemyActor(t) && !t.dead && t.spawnT <= 0 && !q.hit.includes(t.id)
        && Math.hypot(t.x - q.x, t.y - q.y) < HOMING_RANGE + 60 && inCone(t)) tgt = t;
    }
    if (!tgt) {
      let bd = HOMING_RANGE;
      for (const e of G.enemies) {
        if (e.dead || e.spawnT > 0 || q.hit.includes(e.id)) continue;
        const d = Math.hypot(e.x - q.x, e.y - q.y);
        if (d < bd && inCone(e)) {
          bd = d;
          tgt = e;
        }
      }
    }
  } else {
    const p = G.player;
    if (p && !p.dead && Math.hypot(p.x - q.x, p.y - q.y) < HOMING_RANGE && inCone(p)) tgt = p;
  }
  if (tgt && !clearLine(q.x, q.y, tgt.x, tgt.y)) tgt = null;
  q.targetId = tgt ? tgt.id : -1;
  if (!tgt) return;
  const want = Math.atan2(tgt.y - q.y, tgt.x - q.x);
  const turn = clamp(wrapAngle(want - heading), -q.homing * dt, q.homing * dt);
  const sp = Math.hypot(q.vx, q.vy), na = heading + turn;
  q.vx = Math.cos(na) * sp;
  q.vy = Math.sin(na) * sp;
}
