// 怪物导航与移动（修正 legacy L1379–1440 的卡墙/寻路缺陷）：
// - 共享流场：地面单位用 G.flow；大体型（半径 > BIG_R，过不了 1 格窄缝）与飞行单位（可越过水/熔岩/深坑）
//   各用一张派生图上的流场（同一个 world/flowfield.FlowField，按需构建、目标格不变时不重建）；
// - 转向：有视线且流场代价≈直线距离（中间没有水坑/柱子需要绕）时直线逼近，否则沿流场下降；
// - 统一位移结算：所有位移走 world/collision.moveCircle；卡住检测（0.5s 位移不足期望 30%）后侧移自救；
// - 互推分离：按体型质量分配推量，同样走 moveCircle，绝不把怪推进墙；
// - 安全落点：召唤/瞬移/刷怪散布先 nearestFree，再校验“与锚点直线可走”，失败则从锚点带碰撞位移。

import { TILE } from '../config';
import { T } from '../data/tiles';
import { isFree, moveCircle, nearestFree } from '../world/collision';
import { FlowField } from '../world/flowfield';
import { GridMap } from '../world/grid';
import { speedMul } from './combat';
import { G } from './state';
import type { Enemy, Player } from './types';
import { ext, type EnemyExt, type Tgt } from './enemyState';

/** 半径大于此值的单位视为“大体型”：1 格（32）窄缝不可通行 */
export const BIG_R = 13;

export interface Vec { x: number; y: number }

/* ------------------------------------------------------------------ */
/* 导航层缓存（按地图失效）                                               */
/* ------------------------------------------------------------------ */
let curMap: GridMap | null = null;
/** 本模块为 curMap 创建的 G.flow（换图时若 G.flow 仍是它就丢弃） */
let ownFlow: FlowField | null = null;
/** 飞行派生图（undefined = 尚未计算；null = 本图没有水/熔岩/深坑，直接用原图） */
let airNav: GridMap | null | undefined;
let airFlow: FlowField | null = null;
/** 大体型派生图与流场；bigTx/bigTy 为上次重定位时玩家所在格 */
let bigNav: GridMap | null = null;
let bigFlow: FlowField | null = null;
let bigTx = -1, bigTy = -1;
/** 地形签名（玩家换格时重算；地形在运行中被改动——开门、破坏——则派生图失效重建） */
let sig = 0;
let sigTx = -1, sigTy = -1;

function resetDerived(): void {
  airNav = undefined;
  airFlow = null;
  bigNav = null;
  bigFlow = null;
  bigTx = bigTy = -1;
}

function ensureMap(map: GridMap): void {
  if (map === curMap) return;
  curMap = map;
  if (G.flow && G.flow === ownFlow) G.flow = null;
  ownFlow = null;
  resetDerived();
  sig = tileSig(map);
  sigTx = sigTy = -1;
}

function tileSig(map: GridMap): number {
  let h = 0x811c9dc5;
  const t = map.tiles;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t[i], 0x01000193);
  return h >>> 0;
}

/**
 * 每步开头调用：维护共享流场 G.flow（为空则新建）并以玩家位置更新（目标格没变时 FlowField 内部跳过重建）。
 */
export function prepareNav(px: number, py: number): FlowField | null {
  const map = G.map;
  if (!map) return null;
  ensureMap(map);
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx !== sigTx || ty !== sigTy) {
    sigTx = tx;
    sigTy = ty;
    const s = tileSig(map);
    if (s !== sig) {
      sig = s;
      resetDerived();
    }
  }
  if (!G.flow) {
    G.flow = new FlowField(map);
    ownFlow = G.flow;
  }
  G.flow.update(px, py);
  return G.flow;
}

/** 飞行派生图：水/熔岩/深坑改为地面（墙、虚空、建筑脚印仍阻挡） */
function getAirNav(map: GridMap): GridMap | null {
  ensureMap(map);
  if (airNav !== undefined) return airNav;
  let any = false;
  const nav = new GridMap(map.w, map.h, map.kind, T.WALL);
  nav.tiles.set(map.tiles);
  for (let i = 0; i < nav.tiles.length; i++) {
    const t = nav.tiles[i];
    if (t === T.WATER || t === T.LAVA || t === T.PIT) {
      nav.tiles[i] = T.FLOOR;
      any = true;
    }
  }
  airNav = any ? nav : null;
  return airNav;
}

/**
 * 大体型派生图：一格可走 ⇔ 它属于某个 2×2 全可走的方块。
 * 墙体按格对齐时，半径 16–32 的圆只能在 2×2 空地中通过，因此 1 格宽的缝/门洞会被封死，避免巨兽卡在门口。
 */
function buildBigNav(map: GridMap): GridMap {
  const nav = new GridMap(map.w, map.h, map.kind, T.WALL);
  const blockOk = (bx: number, by: number): boolean =>
    map.walkable(bx, by) && map.walkable(bx + 1, by) && map.walkable(bx, by + 1) && map.walkable(bx + 1, by + 1);
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (!map.walkable(x, y)) continue;
      if (blockOk(x, y) || blockOk(x - 1, y) || blockOk(x, y - 1) || blockOk(x - 1, y - 1)) nav.set(x, y, T.FLOOR);
    }
  }
  return nav;
}

/** 大体型流场：玩家所在格对大体型不可达时，改以“地面距离最近的可达格”为目标 */
function getBigFlow(map: GridMap, p: Player): FlowField {
  ensureMap(map);
  if (!bigNav) bigNav = buildBigNav(map);
  if (!bigFlow) bigFlow = new FlowField(bigNav);
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  if (tx !== bigTx || ty !== bigTy) {
    bigTx = tx;
    bigTy = ty;
    let gx = p.x, gy = p.y;
    if (bigNav.solid(tx, ty) && G.flow) {
      const dist = G.flow.dist;
      let best = 0x3fffffff, bi = -1;
      for (let i = 0; i < dist.length; i++) {
        if (dist[i] < best && bigNav.tiles[i] === T.FLOOR) {
          best = dist[i];
          bi = i;
        }
      }
      if (bi >= 0) {
        gx = (bi % map.w) * TILE + TILE / 2;
        gy = Math.floor(bi / map.w) * TILE + TILE / 2;
      }
    }
    bigFlow.update(gx, gy);
  }
  return bigFlow;
}

/** 怪物的碰撞地图（飞行单位可悬停在水/熔岩/深坑上方） */
export function collMap(e: Enemy): GridMap {
  const map = G.map!;
  if (e.def.flying) return getAirNav(map) ?? map;
  return map;
}

/** 按体型的“可通行”地图（大体型 1 格窄缝被封死）：用于冲锋路线等直线可走性判断 */
export function passMap(e: Enemy): GridMap {
  const map = G.map!;
  if (e.def.flying) return getAirNav(map) ?? map;
  if (e.r > BIG_R) {
    ensureMap(map);
    if (!bigNav) bigNav = buildBigNav(map);
    return bigNav;
  }
  return map;
}

/** 怪物所用的流场（以玩家为源） */
export function flowFor(e: Enemy): FlowField | null {
  const map = G.map, p = G.player;
  if (!map || !p) return null;
  ensureMap(map);
  if (e.def.flying) {
    const nav = getAirNav(map);
    if (!nav) return G.flow;
    if (!airFlow) airFlow = new FlowField(nav);
    airFlow.update(p.x, p.y);
    return airFlow;
  }
  if (e.r > BIG_R) return getBigFlow(map, p);
  return G.flow;
}

/* ------------------------------------------------------------------ */
/* 转向                                                                  */
/* ------------------------------------------------------------------ */
/**
 * 朝玩家的移动方向（单位向量写入 out）。
 * 有视线且“流场代价 ≈ 八方向直线代价”（路径基本是直的）→ 直线逼近（平滑、贴脸精确）；
 * 否则沿流场下降（绕墙角、U 形墙、L 形走廊）；流场不可达但有视线 → 直线；都不行返回 false。
 */
export function steerToPlayer(e: Enemy, p: Player, los: boolean, out: Vec): boolean {
  const dx = p.x - e.x, dy = p.y - e.y;
  const d = Math.hypot(dx, dy);
  if (d < 0.5) return false;
  const ff = flowFor(e);
  if (los && ff) {
    const cost = ff.costAt(e.x, e.y);
    const ax = Math.abs(Math.floor(e.x / TILE) - ff.targetX), ay = Math.abs(Math.floor(e.y / TILE) - ff.targetY);
    const oct = 10 * Math.max(ax, ay) + 4 * Math.min(ax, ay);
    if (cost <= oct * 1.15 + 20) {
      out.x = dx / d;
      out.y = dy / d;
      return true;
    }
  }
  if (ff && ff.dirAt(e.x, e.y, out)) return true;
  if (los) {
    out.x = dx / d;
    out.y = dy / d;
    return true;
  }
  return false;
}

/** 写入本步期望移动（方向自动归一化） */
export function setMove(x: EnemyExt, dx: number, dy: number, spd: number): void {
  const l = Math.hypot(dx, dy);
  if (l < 1e-6 || spd <= 0) {
    x.mspd = 0;
    return;
  }
  x.mx = dx / l;
  x.my = dy / l;
  x.mspd = spd;
}

const V: Vec = { x: 0, y: 0 };

/** 走向目标：知道玩家位置时用导航；玩家潜行时直线走向最后见到的位置 */
export function moveToTarget(e: Enemy, x: EnemyExt, p: Player, t: Tgt, scale: number): void {
  if (t.known) {
    if (steerToPlayer(e, p, t.los, V)) setMove(x, V.x, V.y, e.spd * scale);
    return;
  }
  const dx = t.x - e.x, dy = t.y - e.y;
  if (dx * dx + dy * dy > 144) setMove(x, dx, dy, e.spd * scale * 0.8);
}

/** 贴近玩家（贴身后停步，legacy r+p.r+4） */
export function approach(e: Enemy, x: EnemyExt, p: Player, t: Tgt, scale: number): void {
  if (t.known && t.d <= e.r + p.r + 4) return;
  moveToTarget(e, x, p, t, scale);
}

/**
 * 远程风筝：理想距离 ideal±band。太远/没视线 → 逼近；太近 → 后退（带切向，避免被逼进死角）；
 * 区间内 → 按 orbitDir 绕圈并向理想距离收敛。返回本步模式。
 */
export function kite(e: Enemy, x: EnemyExt, p: Player, t: Tgt, ideal: number, band: number, scale: number): 'approach' | 'retreat' | 'strafe' {
  if (!t.known || !t.los || t.d > ideal + band) {
    moveToTarget(e, x, p, t, scale);
    return 'approach';
  }
  const cur = Math.atan2(e.y - p.y, e.x - p.x);
  const ox = Math.cos(cur), oy = Math.sin(cur);
  const tx = -oy * e.orbitDir, ty = ox * e.orbitDir;
  if (t.d < ideal - band) {
    setMove(x, ox + tx * 0.35, oy + ty * 0.35, e.spd * scale * 0.8);
    return 'retreat';
  }
  const radial = (t.d - ideal) / Math.max(1, band);
  setMove(x, tx - ox * radial * 0.6, ty - oy * radial * 0.6, e.spd * scale * 0.55);
  return 'strafe';
}

/* ------------------------------------------------------------------ */
/* 统一位移结算                                                          */
/* ------------------------------------------------------------------ */
/**
 * 结算本步期望移动（x.mspd>0 时）：速度 × combat.speedMul（迟缓/冻结），带碰撞；
 * 每 0.5s 采样一次，期望位移明显没走出去 → 判定卡住，接下来 0.45s 侧向偏转 ~75° 绕开障碍并翻转 orbitDir。
 */
export function applyMove(e: Enemy, x: EnemyExt, dt: number): void {
  if (!G.map || dt <= 0) return;
  if (x.mspd > 0) {
    const sp = x.mspd * speedMul(e);
    let dx = x.mx, dy = x.my;
    if (x.unstuckT > 0) {
      x.unstuckT -= dt;
      const c = Math.cos(1.3 * e.orbitDir), s = Math.sin(1.3 * e.orbitDir);
      const rx = dx * c - dy * s, ry = dx * s + dy * c;
      dx = rx;
      dy = ry;
    }
    const x0 = e.x, y0 = e.y;
    moveCircle(collMap(e), e, dx * sp * dt, dy * sp * dt);
    e.vx = (e.x - x0) / dt;
    e.vy = (e.y - y0) / dt;
    x.want += sp * dt;
  } else if (!(x.act && x.act.ph === 'go' && x.act.k === 'charge')) {
    // 冲锋（enemyActs.chargeTick）自己带碰撞位移并写入 vx/vy：这里不清零，否则渲染层按速度判定成静止，冲锋时播待机动画
    e.vx = 0;
    e.vy = 0;
  }
  x.probeT += dt;
  if (x.probeT >= 0.5) {
    const moved = Math.hypot(e.x - x.px, e.y - x.py);
    if (x.want > 16 && moved < x.want * 0.3) {
      x.unstuckT = 0.45;
      e.orbitDir = e.orbitDir === 1 ? -1 : 1;
    }
    x.probeT = 0;
    x.want = 0;
    x.px = e.x;
    x.py = e.y;
  }
}

/* ------------------------------------------------------------------ */
/* 互推分离（legacy L1432 直接改 x/y 会把怪挤进墙）                        */
/* ------------------------------------------------------------------ */
function mass(e: Enemy): number {
  const x = ext(e);
  let m = e.r * e.r * (e.boss ? 8 : e.elite ? 2 : 1);
  if (x.act && x.act.ph === 'go' && (x.act.k === 'charge' || x.act.k === 'strike')) m *= 4;
  return m;
}

/**
 * 圆形互推：重叠量按质量反比分给两方，每步修正 min(1, 12·dt) 的比例（60Hz 时约 20%，帧率无关地收敛）。
 * 与玩家重叠时只推怪物。所有推动都走 moveCircle。
 */
export function separate(list: readonly Enemy[], p: Player | null, dt: number): void {
  if (!G.map) return;
  const k = Math.min(1, dt * 12);
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (a.dead) continue;
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const min = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      let nx: number, ny: number, d: number;
      if (d2 < 1e-6) {
        // 完全重合：按 id 给一个确定的分离方向
        const ang = ((a.id * 2654435761 + b.id * 40503) >>> 0) / 4294967296 * Math.PI * 2;
        nx = Math.cos(ang);
        ny = Math.sin(ang);
        d = 0;
      } else {
        d = Math.sqrt(d2);
        nx = dx / d;
        ny = dy / d;
      }
      const push = (min - d) * k;
      const ma = mass(a), mb = mass(b), sum = ma + mb;
      const pa = push * (mb / sum), pb = push * (ma / sum);
      moveCircle(collMap(a), a, -nx * pa, -ny * pa);
      moveCircle(collMap(b), b, nx * pb, ny * pb);
    }
  }
  if (p && !p.dead) {
    for (const e of list) {
      if (e.dead) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const min = e.r + p.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-3 ? dx / d : (e.id % 2 ? 1 : -1), ny = d > 1e-3 ? dy / d : 0;
      const push = (min - d) * Math.min(1, dt * 20);
      moveCircle(collMap(e), e, nx * push, ny * push);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 安全落点                                                              */
/* ------------------------------------------------------------------ */
/** 线段上每 8 单位采样一次，是否全程不经过实心格（墙/水/坑都算）——判断两点“走得通” */
export function walkLine(map: GridMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(d / 8));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (map.solidAtWorld(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}

/**
 * 以锚点 (cx,cy) 为中心，在角度 ang、距离 dist 处找一个能容纳半径 r、且与锚点直线连通的位置：
 * ① 目标点 nearestFree + 连通校验；② 从锚点带碰撞位移（moveCircle 不穿墙，结果必然连通）；
 * ③ 锚点附近 nearestFree + 连通校验。都失败返回 null（召唤/瞬移就放弃，绝不落进墙里或墙另一侧）。
 */
export function spotNear(cx: number, cy: number, ang: number, dist: number, r: number): Vec | null {
  const map = G.map;
  if (!map) return null;
  const tx = cx + Math.cos(ang) * dist, ty = cy + Math.sin(ang) * dist;
  const a = nearestFree(map, tx, ty, r, 3);
  if (isFree(map, a.x, a.y, r) && Math.hypot(a.x - cx, a.y - cy) <= dist + 40 && walkLine(map, cx, cy, a.x, a.y)) {
    return { x: a.x, y: a.y };
  }
  if (isFree(map, cx, cy, r)) {
    const b = { x: cx, y: cy, r };
    moveCircle(map, b, Math.cos(ang) * dist, Math.sin(ang) * dist);
    if (isFree(map, b.x, b.y, r)) return { x: b.x, y: b.y };
  }
  const c = nearestFree(map, cx, cy, r, 2);
  if (isFree(map, c.x, c.y, r) && walkLine(map, cx, cy, c.x, c.y)) return { x: c.x, y: c.y };
  return null;
}
