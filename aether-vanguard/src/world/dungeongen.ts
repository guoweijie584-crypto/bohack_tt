// 迷宫副本生成（移植自 legacy genDungeon L750–798，按改版意见重做）：
//   - 网格分区 + 抖动放房间（分布均匀、不重叠），最小生成树 + 少量回环连通，L 形 3 格宽走廊（大体型怪能通过）；
//   - 房间类型 start/normal/elite/supply/event/exit/boss；出口房 = 从起点 BFS 最远的房间（修 legacy 起点出口可能挨着）；
//   - 第 1–2 层出口房放 'next' 传送阵；首领层把最大的房间作首领房，起点取离它最远的房间；
//   - 补给房：补给泉 + 流浪药剂商；事件房：源能祭坛；精英房由 world.ts 多刷精英；
//   - 主题装饰：遗迹（碎石/裂砖）、熔核（岩浆池 + 熔岩缝）、霜寂（冰晶）、墓穴（墓碑/蛛网）、秘境（符文）；
//   - 所有阻挡装饰都经过连通保护（不封死任何角落），且与墙/彼此至少留 2 格（Boss 直径 52 < 64）。
// 纯函数：只用 new Rng(seed)，同种子同图。

import { TILE } from '../config';
import { Rng } from '../core/rng';
import type { DungeonDef } from '../data/dungeons';
import { T } from '../data/tiles';
import type { Npc, Portal } from '../game/types';
import { OCC_BLOCK, Placer, bfsDistance, type DecorKind } from './decor';
import { GridMap } from './grid';
import type { GenResult, Room, RoomKind } from './mapgen';

const C = (t: number): number => t * TILE + TILE / 2;

/** 地刺簇形状（相对左上角的格偏移） */
const SPIKE_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0, 0], [1, 0]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [2, 0]],
];

/** 主线副本 72×52，秘境 54×38 */
export function dungeonSize(secret: boolean): { w: number; h: number; cols: number; rows: number } {
  return secret ? { w: 54, h: 38, cols: 3, rows: 2 } : { w: 72, h: 52, cols: 4, rows: 3 };
}

export function buildDungeon(def: DungeonDef, floor: number, seed: number): GenResult {
  const rng = new Rng(seed);
  const secret = def.theme === 'secret';
  const bossFloor = !secret && floor >= def.floors;
  const bigRoom = bossFloor || secret;
  const { w: W, h: H, cols, rows } = dungeonSize(secret);
  const map = new GridMap(W, H, 'dungeon', T.WALL);
  const idx = (x: number, y: number): number => y * W + x;

  /* ---------------- 1. 房间：网格分区 + 抖动 ---------------- */
  const cellW = Math.floor((W - 4) / cols), cellH = Math.floor((H - 4) / rows);
  const ox = Math.floor((W - cols * cellW) / 2), oy = Math.floor((H - rows * cellH) / 2);
  const nCells = cols * rows;
  // 首领房放在四角之一，起点自然落到对角一侧（离首领尽量远）
  const corners = [0, cols - 1, (rows - 1) * cols, rows * cols - 1];
  const bigCell = bigRoom ? rng.pick(corners) : -1;
  const skip = new Set<number>();
  const skipN = secret ? rng.int(0, 1) : rng.int(1, 3);
  for (let guard = 0; skip.size < skipN && guard < 64; guard++) {
    const i = rng.int(0, nCells - 1);
    if (i !== bigCell) skip.add(i);
  }
  const rooms: Room[] = [];
  const roomCell: Array<{ c: number; r: number }> = [];
  const chamfered: boolean[] = [];
  let bigIdx = -1;
  for (let i = 0; i < nCells; i++) {
    if (skip.has(i)) continue;
    const c = i % cols, r = Math.floor(i / cols);
    const cx0 = ox + c * cellW, cy0 = oy + r * cellH;
    let rw: number, rh: number, rx: number, ry: number;
    if (i === bigCell) {
      rw = cellW - 3;
      rh = cellH - 4;
      rx = cx0 + 1 + rng.int(0, Math.max(0, cellW - 2 - rw));
      ry = cy0 + 2 + rng.int(0, Math.max(0, cellH - 3 - rh));
      bigIdx = rooms.length;
    } else {
      // 普通房间面积上限 13×10=130 < 首领房 14×12，保证“最大的房间 = 首领房”
      rw = rng.int(8, Math.min(13, cellW - 4));
      rh = rng.int(7, Math.min(10, cellH - 4));
      rx = cx0 + 2 + rng.int(0, cellW - 4 - rw);
      ry = cy0 + 2 + rng.int(0, cellH - 4 - rh);
    }
    const room: Room = { x: rx, y: ry, w: rw, h: rh, cx: rx + Math.floor(rw / 2), cy: ry + Math.floor(rh / 2), kind: 'normal' };
    map.fillRect(rx, ry, rw, rh, T.FLOOR);
    // 40% 的普通房间切掉四角，轮廓更多样
    const cut = i !== bigCell && rng.chance(0.4);
    if (cut) {
      map.set(rx, ry, T.WALL); map.set(rx + rw - 1, ry, T.WALL);
      map.set(rx, ry + rh - 1, T.WALL); map.set(rx + rw - 1, ry + rh - 1, T.WALL);
    }
    rooms.push(room);
    roomCell.push({ c, r });
    chamfered.push(cut);
  }

  /* ---------------- 2. 连通：Prim 最小生成树 + 回环 ---------------- */
  const md = (a: Room, b: Room): number => Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
  const edges: Array<[number, number]> = [];
  const inTree = new Set<number>([0]);
  while (inTree.size < rooms.length) {
    let best = Infinity, bi = -1, bj = -1;
    for (const i of inTree) {
      for (let j = 0; j < rooms.length; j++) {
        if (inTree.has(j)) continue;
        const d = md(rooms[i], rooms[j]);
        if (d < best) { best = d; bi = i; bj = j; }
      }
    }
    edges.push([bi, bj]);
    inTree.add(bj);
  }
  const hasEdge = (a: number, b: number): boolean => edges.some(([i, j]) => (i === a && j === b) || (i === b && j === a));
  const loops: Array<[number, number]> = [];
  for (let a = 0; a < rooms.length; a++) for (let b = a + 1; b < rooms.length; b++) {
    const ca = roomCell[a], cb = roomCell[b];
    if (Math.abs(ca.c - cb.c) + Math.abs(ca.r - cb.r) === 1 && !hasEdge(a, b)) loops.push([a, b]);
  }
  rng.shuffle(loops);
  edges.push(...loops.slice(0, secret ? 1 : rng.int(1, 3)));

  /* ---------------- 3. 走廊：3 格宽 L 形 ---------------- */
  const corr = new Uint8Array(W * H);
  const brush = (x: number, y: number): void => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 1 || ty < 1 || tx > W - 2 || ty > H - 2) continue;
      map.set(tx, ty, T.FLOOR);
      corr[idx(tx, ty)] = 1;
    }
  };
  for (const [ai, bi] of edges) {
    const a = rooms[ai], b = rooms[bi];
    let x = a.cx, y = a.cy;
    const horiz = (): void => { while (x !== b.cx) { brush(x, y); x += Math.sign(b.cx - x); } };
    const vert = (): void => { while (y !== b.cy) { brush(x, y); y += Math.sign(b.cy - y); } };
    if (rng.chance(0.5)) { horiz(); vert(); } else { vert(); horiz(); }
    brush(x, y);
  }
  // 房间归属表（-1 = 不在任何房间矩形内）
  const roomOf = new Int16Array(W * H).fill(-1);
  rooms.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roomOf[idx(x, y)] = i;
  });

  /* ---------------- 4. 房间类型 ---------------- */
  const centerDist = (from: Room): number[] => {
    const d = bfsDistance(map, from.cx, from.cy);
    return rooms.map(r => d[idx(r.cx, r.cy)]);
  };
  const argmax = (arr: number[], exclude: number): number => {
    let best = -1, bi = exclude === 0 ? 1 : 0;
    arr.forEach((v, i) => { if (i !== exclude && v > best) { best = v; bi = i; } });
    return bi;
  };
  let startIdx: number, exitIdx: number;
  if (bigRoom && bigIdx >= 0) {
    exitIdx = bigIdx;
    startIdx = argmax(centerDist(rooms[bigIdx]), bigIdx);
  } else {
    const r0 = rng.int(0, rooms.length - 1);
    startIdx = argmax(centerDist(rooms[r0]), -1);
    exitIdx = argmax(centerDist(rooms[startIdx]), startIdx);
  }
  rooms[startIdx].kind = 'start';
  rooms[exitIdx].kind = bigRoom ? 'boss' : 'exit';
  const rest = rooms.map((_, i) => i).filter(i => i !== startIdx && i !== exitIdx);
  rng.shuffle(rest);
  const want: RoomKind[] = secret ? ['elite'] : ['supply', 'event', 'elite', ...(floor >= 2 ? ['elite' as const] : [])];
  for (const k of want) {
    const i = rest.pop();
    if (i === undefined) break;
    rooms[i].kind = k;
  }

  /* ---------------- 5. 保留格 ---------------- */
  const P = new Placer(map);
  // 房间外的走廊 + 房间内靠近走廊口 2 格内（门口不放阻挡物）
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = idx(x, y);
    if (!corr[i] || roomOf[i] >= 0) continue;
    P.reserve(x, y);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = idx(x + dx, y + dy);
      if (map.inBounds(x + dx, y + dy) && roomOf[j] >= 0) P.reserve(x + dx, y + dy);
    }
  }
  const start = rooms[startIdx], exit = rooms[exitIdx];
  P.reserve(start.cx - 1, start.cy - 1, 3, 3);
  const backX = start.cx - 2 >= start.x + 1 ? start.cx - 2 : start.cx + 2;
  const back = { tx: backX, ty: start.cy + (start.cy + 2 < start.y + start.h - 1 ? 2 : -2) };
  P.reserve(back.tx - 1, back.ty - 1, 3, 3);
  if (bigRoom) P.reserve(exit.cx - 2, exit.cy - 2, 5, 5);
  else P.reserve(exit.cx - 1, exit.cy - 1, 3, 3);
  P.setAnchor(start.cx, start.cy);

  /* ---------------- 6. 固定设施：补给泉 + 药剂商、祭坛 ---------------- */
  const npcs: Npc[] = [];
  for (const r of rooms) {
    if (r.kind === 'supply') {
      P.place('fountain', r.cx - 1, r.cy - 1, { required: true });
      const nx = P.isOpen(r.cx + 2, r.cy) ? r.cx + 2 : r.cx - 3;
      P.reserve(nx, r.cy);
      npcs.push({
        id: P.newId(), role: 'potion', name: '流浪药剂商 · 苔',
        line: '在迷宫里做生意？价格当然跟主城一样。旁边那眼泉水，喝一口能缓过来。',
        x: C(nx), y: C(r.cy), r: 10, sprite: 'elf_f', facing: nx > r.cx ? -1 : 1,
      });
    } else if (r.kind === 'event') {
      P.place('altar', r.cx - 1, r.cy, { required: true });
      P.reserve(r.cx - 1, r.cy + 1, 2, 1);
    }
  }

  /* ---------------- 7. 宝箱位置（不阻挡；靠墙放）---------------- */
  const chests: Array<{ x: number; y: number; tier: number }> = [];
  const chestSpot = (r: Room): { tx: number; ty: number } | null => {
    for (let t = 0; t < 14; t++) {
      const top = t < 8;
      const tx = rng.int(r.x + 1, r.x + r.w - 2);
      const ty = top ? r.y : r.y + r.h - 1;
      if (!P.isOpen(tx, ty)) continue;
      if (map.get(tx, top ? ty - 1 : ty + 1) !== T.WALL) continue;
      return { tx, ty };
    }
    return null;
  };
  const addChest = (r: Room, tier: number): void => {
    const s = chestSpot(r);
    if (!s) return;
    P.reserve(s.tx, s.ty);
    chests.push({ x: C(s.tx), y: C(s.ty), tier });
  };
  for (const r of rooms) {
    if (r.kind === 'elite') addChest(r, 1);
    else if (r.kind === 'normal' && rng.chance(secret ? 0.2 : 0.35)) addChest(r, 0);
    else if (r.kind === 'exit' && rng.chance(0.25)) addChest(r, 0);
  }
  if (!chests.length && !secret) {
    const r = rooms.find(o => o.kind === 'normal') ?? rooms.find(o => o.kind !== 'start');
    if (r) addChest(r, 0);
  }

  /* ---------------- 8. 主题与装饰 ---------------- */
  const theme = def.theme;
  const vents = { n: 0 };
  const crystals = { n: 0 };
  const interiorTile = (r: Room, margin: number): { tx: number; ty: number } => ({
    tx: rng.int(r.x + margin, r.x + r.w - 1 - margin),
    ty: rng.int(r.y + margin, r.y + r.h - 1 - margin),
  });
  const decal = (kind: DecorKind, r: Room, n: number, margin = 1, v?: number): void => {
    for (let k = 0, t = 0; k < n && t < n * 6; t++) {
      const s = interiorTile(r, margin);
      if (P.place(kind, s.tx, s.ty, { v: v ?? rng.int(0, 3) })) k++;
    }
  };

  // 遗迹：房间里散落裂砖
  if (theme === 'ruins' || theme === 'crypt') {
    const p = theme === 'ruins' ? 0.09 : 0.05;
    for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (map.get(x, y) === T.FLOOR && !P.isReserved(x, y) && rng.chance(p)) map.set(x, y, T.RUIN);
    }
  }

  rooms.forEach((r, ri) => {
    const k = r.kind;
    const combat = k === 'normal' || k === 'elite' || k === 'exit' || k === 'boss';
    const big = r.w >= 10 && r.h >= 8;
    // —— 大件阻挡物（先放）——
    if (combat && big && (k === 'boss' || rng.chance(0.5))) {
      for (const [tx, ty] of [[r.x + 2, r.y + 2], [r.x + r.w - 3, r.y + 2], [r.x + 2, r.y + r.h - 3], [r.x + r.w - 3, r.y + r.h - 3]]) {
        P.place('column', tx, ty, { clear: 1, spacing: 2, v: rng.int(0, 2) });
      }
    }
    if (theme === 'magma' && (k === 'normal' || k === 'elite') && big && rng.chance(0.55)) {
      const pw = rng.int(2, 3), ph = 2;
      for (let t = 0; t < 8; t++) {
        const px = rng.int(r.x + 2, r.x + r.w - 2 - pw), py = rng.int(r.y + 2, r.y + r.h - 2 - ph);
        if (!P.placeTerrain(px, py, pw, ph, T.LAVA, 1, 2)) continue;
        // 岩浆池边冒火的熔岩缝
        const ring: Array<[number, number]> = [];
        for (let x = px - 1; x <= px + pw; x++) { ring.push([x, py - 1]); ring.push([x, py + ph]); }
        rng.shuffle(ring);
        let placed = 0;
        for (const [vx, vy] of ring) {
          if (placed >= 2 || vents.n >= 10) break;
          if (P.place('lava_vent', vx, vy, { v: rng.int(0, 3) })) { placed++; vents.n++; }
        }
        break;
      }
    }
    if (theme === 'crypt' && (k === 'normal' || k === 'elite') && r.w >= 9 && r.h >= 7 && rng.chance(0.6)) {
      const gy = rng.chance(0.5) ? r.y + 2 : r.y + r.h - 3;
      for (let gx = r.x + 2; gx <= r.x + r.w - 3; gx += 3) P.place('grave', gx, gy, { clear: 1, spacing: 2, v: rng.int(0, 2) });
    }
    if (theme === 'frost' && combat && crystals.n < 16) {
      const want2 = rng.int(1, 3);
      for (let t = 0, got = 0; t < 12 && got < want2; t++) {
        // 靠墙的格子（非角落）
        const side = rng.int(0, 3);
        const tx = side < 2 ? rng.int(r.x + 1, r.x + r.w - 2) : side === 2 ? r.x : r.x + r.w - 1;
        const ty = side >= 2 ? rng.int(r.y + 1, r.y + r.h - 2) : side === 0 ? r.y : r.y + r.h - 1;
        const wx = side === 2 ? tx - 1 : side === 3 ? tx + 1 : tx;
        const wy = side === 0 ? ty - 1 : side === 1 ? ty + 1 : ty;
        if (map.get(wx, wy) !== T.WALL) continue;
        if (P.place('crystal', tx, ty, { spacing: 2, v: rng.int(0, 2) })) { got++; crystals.n++; }
      }
    }
    // —— 角落：蛛网 / 可破坏的木箱木桶 ——
    const corners: Array<[number, number]> = [[r.x, r.y], [r.x + r.w - 1, r.y], [r.x, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1]];
    const webP = theme === 'crypt' ? 0.5 : theme === 'frost' ? 0.12 : 0.2;
    for (const [tx, ty] of corners) {
      if (chamfered[ri] || map.get(tx, ty) !== T.FLOOR) continue;
      const roll = rng.next();
      if (roll < webP) P.place('cobweb', tx, ty, { v: rng.int(0, 1) });
      else if (k !== 'start' && k !== 'boss' && roll < webP + 0.32) {
        const crate = rng.chance(0.5);
        P.place(crate ? 'crate' : 'barrel', tx, ty, { breakable: true, hp: crate ? 1 : 2, v: rng.int(0, 1) });
      }
    }
    // —— 地面装饰 ——
    decal(theme === 'crypt' ? 'bones' : 'skull', r, rng.int(0, theme === 'crypt' ? 3 : 1));
    decal(theme === 'crypt' ? 'skull' : 'bones', r, rng.int(0, 1));
    if (theme === 'ruins') decal('rubble', r, rng.int(1, 3));
    if (theme === 'magma' && vents.n < 10 && rng.chance(0.4)) { decal('lava_vent', r, 1); vents.n++; }
    if (theme === 'secret') decal('rune', r, 1, 2);
    // —— 地刺陷阱（成簇，同相位）——
    if (k === 'normal' && rng.chance(0.3)) {
      const phase = rng.int(0, 9);
      const shape = rng.pick(SPIKE_SHAPES);
      for (let t = 0; t < 6; t++) {
        const s = interiorTile(r, 2);
        if (!shape.every(([dx, dy]) => P.isOpen(s.tx + dx, s.ty + dy))) continue;
        for (const [dx, dy] of shape) P.place('spikes', s.tx + dx, s.ty + dy, { v: phase });
        break;
      }
    }
  });

  // —— 墙上火把：南邻是地面的墙格，彼此至少隔 4 格 ——
  const torches: Array<[number, number]> = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    if (map.get(x, y) !== T.WALL || map.solid(x, y + 1) || map.get(x, y + 1) === T.BLOCK) continue;
    if (P.occ[idx(x, y + 1)] & OCC_BLOCK) continue;
    if (torches.some(([tx, ty]) => Math.abs(tx - x) < 4 && Math.abs(ty - y) < 4)) continue;
    if (!rng.chance(0.55)) continue;
    if (P.place('torch', x, y)) torches.push([x, y]);
  }

  /* ---------------- 9. 传送阵 ---------------- */
  const portals: Portal[] = [];
  portals.push({
    id: P.newId(), kind: 'city', x: C(back.tx), y: C(back.ty), r: 28, label: '返回曙光主城', open: true, target: 'city',
  });
  if (!bigRoom) {
    portals.push({
      id: P.newId(), kind: 'next', x: C(exit.cx), y: C(exit.cy), r: 30,
      label: `前往第 ${floor + 1} 层`, open: true, target: String(floor + 1),
    });
  }

  /* ---------------- 10. 刷怪候选点 ---------------- */
  // 非起点（也不含补给房这种安全屋）的房间格中心；要求 3×3 全可走，体型 r≤48 的怪都能站下
  const spawnPoints: Array<{ x: number; y: number }> = [];
  for (const r of rooms) {
    if (r.kind === 'start' || r.kind === 'supply') continue;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) if (map.solid(x + dx, y + dy)) ok = false;
      if (ok) spawnPoints.push({ x: C(x), y: C(y) });
    }
  }

  /* ---------------- 11. 地砖变体 ---------------- */
  const vr = new Rng((seed ^ 0x2545f491) >>> 0);
  for (let i = 0; i < map.variant.length; i++) map.variant[i] = vr.int(0, 255);

  return {
    map,
    spawn: { x: C(start.cx), y: C(start.cy) },
    npcs,
    portals,
    decor: P.decor,
    rooms,
    spawnPoints,
    bossSpot: bigRoom ? { x: C(exit.cx), y: C(exit.cy) } : undefined,
    chests,
    name: secret ? def.name : `${def.name} · 第 ${floor} 层`,
    exit: { x: C(exit.cx), y: C(exit.cy) },
    failures: P.failures,
  };
}
