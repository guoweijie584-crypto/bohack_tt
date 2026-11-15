// 首领 AI（EnemyDef.bossKit）：tyrant 源核暴君 / warden 遗迹执守者 / lich 霜冠巫妖 / shadow 幽影君主。
// 改版意见“Boss 技能丰富”：每个首领 ≥3 种技能 + 二阶段（血量 < 50%：横幅 + 震屏 + 怒吼前摇 + 技能强化/冷却 ×0.75）。
// 所有技能都有前摇预警（脚下环 / 冲锋路线 / 落点圈 / 冲击波范围）；召唤与瞬移落点走 nearestFree + 连通校验。
// 选招：技能各自冷却 + 公共间隔 cdSkill，按权重随机且不连续重复同一招；没招可放时近战/走位。

import { rng } from '../core/rng';
import { nearestFree } from '../world/collision';
import { lineOfSight } from '../world/los';
import { damagePlayer } from './combat';
import { spawnHazard } from './hazards';
import { G, emit, toast } from './state';
import type { Enemy, Player } from './types';
import {
  countSummons, fanVolley, fireOrb, laneClear, meleeStrike, meleeTick, ringVolley, startCharge, startMelee, chargeTick,
  summonAt, summonSpots, type ChargeOpts,
} from './enemyActs';
import { raiseShield } from './enemyAi';
import { approach, kite, moveToTarget, spotNear, type Vec } from './enemyNav';
import {
  MELEE_REACH, SUMMON_COLOR, bossMem, elemColor, ext, faceTo, newAct, setAnim, sfx, telegraph, warnArea,
  type Act, type BossMem, type EnemyExt, type Tgt,
} from './enemyState';

interface Ctx {
  e: Enemy;
  x: EnemyExt;
  m: BossMem;
  p: Player;
  t: Tgt;
  /** 二阶段 */
  p2: boolean;
}

interface BossSkill {
  id: string;
  /** 中文名（调试/提示） */
  name: string;
  /** 冷却秒（二阶段 ×0.75） */
  cd: number;
  /** 选择权重 */
  w: number;
  ok(c: Ctx): boolean;
  /** 开始：返回带前摇的动作；返回 null 表示本次放弃（如没有合法落点） */
  start(c: Ctx): Act | null;
  /** 推进：返回 true 表示动作结束 */
  tick(c: Ctx, a: Act, dt: number): boolean;
}

interface Kit {
  skills: BossSkill[];
  /** 没有动作时的走位（默认贴近近战） */
  move?(c: Ctx): void;
  /** 进入二阶段时的额外效果 */
  onPhase2?(e: Enemy, x: EnemyExt, m: BossMem): void;
}

const FIRE = '#ff8a4a';
const ICE = '#8fd8f0';
const STONE = '#d8c49a';
const SHADOW = '#b48cff';

/* ------------------------------------------------------------------ */
/* 通用技能件                                                            */
/* ------------------------------------------------------------------ */
/** 结束前摇进入收招的小工具 */
function toRec(a: Act, t: number): void {
  a.ph = 'rec';
  a.t = t;
}
function recDone(a: Act, dt: number): boolean {
  a.t -= dt;
  return a.t <= 0;
}

/**
 * 冲锋技能（暴君/执守者）：前摇 + 路线预警 + 带碰撞冲刺，撞墙会自我眩晕。
 * base.cd 是本技能自己的冷却（进 m.cds）；chargeTick 结束时写入 e.cdSkill 的是首领的公共出招间隔。
 */
function chargeSkill(id: string, base: ChargeOpts, wind: number): BossSkill {
  const opts = (c: Ctx): ChargeOpts => ({ ...base, speed: base.speed * (c.p2 ? 1.15 : 1), cd: c.p2 ? 1.4 : 2.1 });
  return {
    id, name: '冲锋', cd: base.cd, w: 1,
    ok: c => c.t.known && c.t.los && c.t.d > 90 && c.t.d < 380 && laneClear(c.e, c.p),
    start: c => {
      startCharge(c.e, c.x, c.p, c.p2 ? wind * 0.8 : wind, opts(c));
      const a = c.x.act;
      if (a) a.k = id;
      return a;
    },
    tick: (c, a, dt) => chargeTick(c.e, c.x, c.p, a, dt, opts(c)),
  };
}

/** 召唤技能（落点预警 → 召唤） */
function summonSkill(id: string, name: string, kind: string, cd: number, capP1: number, capP2: number, perP1: number, perP2: number, onlyP2 = false): BossSkill {
  return {
    id, name, cd, w: 0.9,
    ok: c => (!onlyP2 || c.p2) && countSummons(c.e.id, kind) < (c.p2 ? capP2 : capP1),
    start: c => {
      const cap = c.p2 ? capP2 : capP1;
      const n = Math.min(c.p2 ? perP2 : perP1, cap - countSummons(c.e.id, kind));
      const spots = n > 0 ? summonSpots(c.e, n, c.e.r + 36, 14) : [];
      if (!spots.length) return null;
      const a = newAct(id, 0.8, { spots, s: kind });
      for (const s of spots) warnArea(s.x, s.y, 16, 0.8, SUMMON_COLOR);
      telegraph(c.e, 0.8, SUMMON_COLOR, 26);
      emit({ t: 'cast', actorId: c.e.id, el: c.e.def.el });
      sfx('summon', c.e.x, c.e.y);
      setAnim(c.e, 'cast');
      return a;
    },
    tick: (c, a, dt) => {
      if (a.ph === 'wind') {
        a.t -= dt;
        c.e.ai = 'summon';
        setAnim(c.e, 'cast');
        if (a.t <= 0) {
          for (const s of a.spots) {
            const m = summonAt(c.e, a.s, s);
            if (m && a.s === 'shadow_clone') {
              // 分身：血量随本体缩放、伤害减半，单条血
              m.maxHp = m.hp = Math.max(60, c.e.maxHp * 0.05);
              m.atk = c.e.atk * 0.45;
              m.bars = 1;
              ext(m).lastHp = m.hp;
            }
          }
          toRec(a, 0.3);
        }
        return false;
      }
      return recDone(a, dt);
    },
  };
}

/** 落点合法化：坐标在墙里就就近挪到可走处（陨石/冰域/落石不该生成在墙里） */
function groundSpot(x: number, y: number, r = 8): Vec | null {
  const map = G.map;
  if (!map) return null;
  if (!map.solidAtWorld(x, y)) return { x, y };
  const f = nearestFree(map, x, y, r, 3);
  return map.solidAtWorld(f.x, f.y) ? null : f;
}

/* ------------------------------------------------------------------ */
/* tyrant 源核暴君：环形火弹 / 陨石雨 / 冲锋；二阶段加速 + 召唤熔核游魂      */
/* ------------------------------------------------------------------ */
const TYRANT: Kit = {
  skills: [
    {
      id: 'firering', name: '环形火弹', cd: 4, w: 1.2,
      ok: c => c.t.known,
      start: c => {
        const a = newAct('firering', c.p2 ? 0.5 : 0.65);
        telegraph(c.e, a.dur, FIRE, 70);
        emit({ t: 'cast', actorId: c.e.id, el: 'fire' });
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e } = c;
        const n = c.p2 ? 18 : 12, spd = c.p2 ? 222 : 186;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            a.a = rng.range(0, Math.PI * 2);
            ringVolley(e, n, spd, e.atk * 0.62, a.a, { el: 'fire', r: 6 });
            emit({ t: 'ring', x: e.x, y: e.y, r0: 8, r1: 80, color: FIRE, dur: 0.4 });
            sfx('fire', e.x, e.y);
            if (c.p2) {
              a.ph = 'go';
              a.t = 0.35;
            } else toRec(a, 0.4);
          }
          return false;
        }
        if (a.ph === 'go') {
          a.t -= dt;
          if (a.t <= 0) {
            ringVolley(e, n, spd, e.atk * 0.62, a.a + Math.PI / n, { el: 'fire', r: 6 });
            sfx('fire', e.x, e.y);
            toRec(a, 0.4);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    {
      id: 'meteor', name: '陨石雨', cd: 9, w: 1,
      ok: c => c.t.known && c.t.d < 620,
      start: c => {
        const a = newAct('meteor', 0.7);
        telegraph(c.e, 0.7, FIRE, 44);
        emit({ t: 'cast', actorId: c.e.id, el: 'fire' });
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e, p } = c;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            const n = c.p2 ? 8 : 5;
            for (let i = 0; i < n; i++) {
              const ang = rng.range(0, Math.PI * 2), d = i === 0 ? 0 : rng.range(50, 160);
              const s = groundSpot(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d);
              if (!s) continue;
              // 陨石：hazard 自带 delay 期间的落点预警，落地造成一次火焰伤害并灼烧
              spawnHazard({
                kind: 'meteor', team: 'enemy', x: s.x, y: s.y, r: 54, dmg: e.atk * 1.0, el: 'fire', style: 'meteor',
                ownerId: e.id, delay: 1.0 + i * 0.18, life: 0.5, maxLife: 0.5, status: 'burn',
              });
            }
            sfx('fire', e.x, e.y);
            toRec(a, 0.5);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    chargeSkill('charge', { speed: 540, dur: 0.5, mult: 1.4, knock: 320, cd: 7, stun: 0.9 }, 0.65),
    summonSkill('callWisps', '召唤熔核游魂', 'wisp', 12, 0, 4, 0, 2, true),
  ],
  onPhase2: (e, x, m) => {
    void x;
    m.spdMul = 1.2;
    m.cds.callWisps = 0;
    toast(`${e.def.n} 撕裂空间，召来援军`, '#e06858');
  },
};

/* ------------------------------------------------------------------ */
/* warden 遗迹执守者：震地冲击波环 / 投石 / 冲锋；二阶段岩甲 + 双重震地       */
/* ------------------------------------------------------------------ */
function spawnWave(e: Enemy, m: BossMem): void {
  const maxR = 280, spd = 300;
  m.waves.push({ x: e.x, y: e.y, r: e.r, maxR, spd, dmg: e.atk * 0.9, el: e.def.el, hit: false });
  emit({ t: 'ring', x: e.x, y: e.y, r0: e.r, r1: maxR, color: STONE, dur: (maxR - e.r) / spd });
  emit({ t: 'shake', amt: 7 });
  emit({ t: 'burst', x: e.x, y: e.y, color: STONE, n: 26, spd: 160 });
  sfx('explosion', e.x, e.y);
}

/** 推进冲击波：波前扫过玩家（|距离−半径| 很小）且中间无墙 → 伤害一次 */
function tickWaves(m: BossMem, p: Player | null, dt: number): void {
  if (!m.waves.length) return;
  for (const w of m.waves) {
    w.r += w.spd * dt;
    if (w.hit || !p || p.dead) continue;
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (Math.abs(d - w.r) < 14 + p.r * 0.5 && (!G.map || lineOfSight(G.map, w.x, w.y, p.x, p.y))) {
      w.hit = true;
      damagePlayer(p, w.dmg, { el: w.el, srcX: w.x, srcY: w.y, knock: 180 });
    }
  }
  m.waves = m.waves.filter(w => w.r < w.maxR);
}

const WARDEN: Kit = {
  skills: [
    {
      id: 'quake', name: '震地冲击波', cd: 6, w: 1.2,
      ok: c => c.t.known && c.t.d < 340,
      start: c => {
        const a = newAct('quake', 0.8);
        warnArea(c.e.x, c.e.y, c.e.r + 44, 0.8, STONE);
        telegraph(c.e, 0.8, STONE, 30);
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e, m } = c;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            spawnWave(e, m);
            if (c.p2) {
              a.ph = 'go';
              a.t = 0.45;
            } else toRec(a, 0.4);
          }
          return false;
        }
        if (a.ph === 'go') {
          a.t -= dt;
          if (a.t <= 0) {
            spawnWave(e, m);
            toRec(a, 0.4);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    {
      id: 'boulder', name: '投石', cd: 5, w: 1,
      ok: c => c.t.known && c.t.los && c.t.d > 80 && c.t.d < 540,
      start: c => {
        const { e, p } = c;
        const a = newAct('boulder', 0.7, { x: p.x, y: p.y });
        warnArea(p.x, p.y, 50, 1.6, STONE);
        telegraph(e, 0.7, STONE, 18);
        faceTo(e, p.x, p.y);
        setAnim(e, 'attack');
        return a;
      },
      tick: (c, a, dt) => {
        const { e, p } = c;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            const pts: Vec[] = [{ x: a.x, y: a.y }];
            if (c.p2) {
              // 二阶段多投两块：一块按玩家移动方向预判，一块随机散落
              pts.push({ x: p.x + p.vx * 0.9, y: p.y + p.vy * 0.9 });
              const ang = rng.range(0, Math.PI * 2);
              pts.push({ x: p.x + Math.cos(ang) * 90, y: p.y + Math.sin(ang) * 90 });
            }
            for (const q of pts) {
              const s = groundSpot(q.x, q.y);
              if (!s) continue;
              if (q !== pts[0]) warnArea(s.x, s.y, 50, 0.9, STONE);
              spawnHazard({
                kind: 'meteor', team: 'enemy', x: s.x, y: s.y, r: 50, dmg: e.atk * 1.1, el: 'physical', style: 'rock',
                ownerId: e.id, delay: 0.9, life: 0.4, maxLife: 0.4, stun: 0.4,
              });
            }
            sfx('swingHeavy', e.x, e.y);
            toRec(a, 0.4);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    chargeSkill('charge', { speed: 500, dur: 0.55, mult: 1.5, knock: 360, cd: 8, stun: 1.0 }, 0.7),
  ],
  onPhase2: (e, x) => {
    raiseShield(e, x, e.maxHp * 0.12, 8);
    toast(`${e.def.n} 披上了岩甲！`, STONE);
  },
};

/* ------------------------------------------------------------------ */
/* lich 霜冠巫妖：冰刺螺旋 / 冰封地面 / 唤起骸骨 / 近身霜爆；保持距离         */
/* ------------------------------------------------------------------ */
const LICH: Kit = {
  skills: [
    {
      id: 'spiral', name: '冰刺螺旋', cd: 8, w: 1.2,
      ok: c => c.t.known && c.t.d < 520,
      start: c => {
        const a = newAct('spiral', 0.5, { a: rng.range(0, Math.PI * 2), dx: rng.chance(0.5) ? 1 : -1 });
        telegraph(c.e, 0.5, ICE, 34);
        emit({ t: 'cast', actorId: c.e.id, el: 'ice' });
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e } = c;
        e.ai = 'windup';
        setAnim(e, 'cast');
        if (a.ph === 'wind') {
          a.t -= dt;
          if (a.t <= 0) {
            a.ph = 'go';
            a.t = c.p2 ? 2.6 : 2.2;
            a.t2 = 0;
          }
          return false;
        }
        if (a.ph === 'go') {
          a.t2 -= dt;
          const arms = c.p2 ? 3 : 2;
          while (a.t2 <= 0) {
            a.t2 += 0.1;
            for (let k = 0; k < arms; k++) {
              fireOrb(e, a.a + (k * Math.PI * 2) / arms, 195, e.atk * 0.32, { kind: 'iceShard', el: 'ice', r: 4, life: 3 });
            }
            a.a += (c.p2 ? 0.27 : 0.33) * a.dx;
            a.n++;
            // 每 4 波响一次（放在发射处：之前在循环外按 a.n 判断，同一波期间每步都满足 → 连发 6 次音效）
            if (a.n % 4 === 1) sfx('ice', e.x, e.y, 0.35);
          }
          a.t -= dt;
          if (a.t <= 0) toRec(a, 0.5);
          return false;
        }
        return recDone(a, dt);
      },
    },
    {
      id: 'frostfield', name: '冰封地面', cd: 7, w: 1,
      ok: c => c.t.known && c.t.d < 520,
      start: c => {
        const { e, p } = c;
        const r = c.p2 ? 96 : 76;
        const a = newAct('frostfield', 0.6, { x: p.x, y: p.y });
        warnArea(p.x, p.y, r, 1.3, ICE);
        emit({ t: 'cast', actorId: e.id, el: 'ice' });
        setAnim(e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e } = c;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            const r = c.p2 ? 96 : 76;
            const pts: Vec[] = [{ x: a.x, y: a.y }];
            if (c.p2) {
              // 二阶段：沿“首领→落点”的垂直方向再铺两块，封走位
              const ang = Math.atan2(a.y - e.y, a.x - e.x) + Math.PI / 2;
              pts.push({ x: a.x + Math.cos(ang) * 120, y: a.y + Math.sin(ang) * 120 });
              pts.push({ x: a.x - Math.cos(ang) * 120, y: a.y - Math.sin(ang) * 120 });
            }
            for (const q of pts) {
              const s = groundSpot(q.x, q.y);
              if (!s) continue;
              if (q !== pts[0]) warnArea(s.x, s.y, r, 0.7, ICE);
              spawnHazard({
                kind: 'iceField', team: 'enemy', x: s.x, y: s.y, r, dmg: e.atk * 0.22, el: 'ice', style: 'frost',
                ownerId: e.id, delay: 0.7, life: 6, maxLife: 6, tick: 0.5, tickT: 0, slow: 0.45, status: 'slow',
              });
            }
            sfx('ice', e.x, e.y);
            toRec(a, 0.4);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    summonSkill('raise', '唤起骸骨', 'skeleton', 11, 4, 6, 2, 3),
    {
      id: 'nova', name: '霜爆', cd: 5, w: 2,
      ok: c => c.t.known && c.t.d < 140,
      start: c => {
        const a = newAct('nova', 0.55);
        warnArea(c.e.x, c.e.y, 135, 0.55, ICE);
        telegraph(c.e, 0.55, ICE, 20);
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e, p } = c;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            emit({ t: 'explosion', x: e.x, y: e.y, r: 135, el: 'ice', team: 'enemy' });
            emit({ t: 'ring', x: e.x, y: e.y, r0: 10, r1: 135, color: ICE, dur: 0.35 });
            sfx('ice', e.x, e.y);
            if (Math.hypot(p.x - e.x, p.y - e.y) < 135 + p.r && (!G.map || lineOfSight(G.map, e.x, e.y, p.x, p.y))) {
              damagePlayer(p, e.atk * 0.8, { el: 'ice', status: 'freeze', srcX: e.x, srcY: e.y, knock: 240, sourceId: e.id });
            }
            toRec(a, 0.4);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
  ],
  move: c => {
    kite(c.e, c.x, c.p, c.t, 220, 50, 0.9 * c.m.spdMul);
  },
  onPhase2: (e) => {
    emit({ t: 'ring', x: e.x, y: e.y, r0: 10, r1: 160, color: ICE, dur: 0.5 });
  },
};

/* ------------------------------------------------------------------ */
/* shadow 幽影君主：瞬移背后斩 / 扇形暗影弹 / 分身；二阶段更频繁更多         */
/* ------------------------------------------------------------------ */
/** 玩家背后（瞄准方向反面）的合法落点：nearestFree + 与玩家直线连通，不行就换侧 */
function behindSpot(e: Enemy, p: Player): Vec | null {
  const back = p.aim + Math.PI;
  const dist = p.r + e.r + 20;
  for (const off of [0, 0.7, -0.7, 1.4, -1.4, Math.PI]) {
    const s = spotNear(p.x, p.y, back + off, dist, e.r);
    if (s && Math.hypot(s.x - p.x, s.y - p.y) >= p.r + e.r - 1) return s;
  }
  return null;
}

const SHADOW_KIT: Kit = {
  skills: [
    {
      id: 'blink', name: '影袭', cd: 6, w: 1.2,
      ok: c => c.t.known && c.t.d > 50 && c.t.d < 620,
      start: c => {
        const a = newAct('blink', 0.35);
        telegraph(c.e, 0.35, SHADOW, 12);
        emit({ t: 'burst', x: c.e.x, y: c.e.y, color: SHADOW, n: 16, spd: 80 });
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e, p } = c;
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            const s = behindSpot(e, p);
            if (!s) return true;
            emit({ t: 'afterimage', actorId: e.id });
            emit({ t: 'burst', x: e.x, y: e.y, color: SHADOW, n: 20, spd: 120 });
            e.x = s.x;
            e.y = s.y;
            emit({ t: 'burst', x: e.x, y: e.y, color: SHADOW, n: 20, spd: 120 });
            sfx('arcane', e.x, e.y);
            faceTo(e, p.x, p.y);
            a.ph = 'go';
            a.t = 0.3;
            telegraph(e, 0.3);
          }
          return false;
        }
        if (a.ph === 'go') {
          a.t -= dt;
          faceTo(e, p.x, p.y);
          e.ai = 'windup';
          setAnim(e, 'attack');
          if (a.t <= 0) {
            meleeStrike(e, p, 1.3, 14, 200);
            if (c.p2) ringVolley(e, 8, 200, e.atk * 0.4, rng.range(0, Math.PI * 2), { el: 'arcane' });
            toRec(a, 0.35);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    {
      id: 'fan', name: '暗影扇射', cd: 4.5, w: 1,
      ok: c => c.t.known && c.t.los && c.t.d < 540,
      start: c => {
        const a = newAct('fan', 0.5);
        telegraph(c.e, 0.5, SHADOW, 22);
        faceTo(c.e, c.p.x, c.p.y);
        setAnim(c.e, 'cast');
        return a;
      },
      tick: (c, a, dt) => {
        const { e, p } = c;
        const fire = (): void => {
          fanVolley(e, Math.atan2(p.y - e.y, p.x - e.x), c.p2 ? 11 : 7, c.p2 ? 1.75 : 1.2, 240, e.atk * 0.5, { el: 'arcane', color: elemColor('arcane') });
          sfx('arcane', e.x, e.y, 0.7);
        };
        if (a.ph === 'wind') {
          a.t -= dt;
          e.ai = 'windup';
          if (a.t <= 0) {
            fire();
            if (c.p2) {
              a.ph = 'go';
              a.t = 0.4;
            } else toRec(a, 0.35);
          }
          return false;
        }
        if (a.ph === 'go') {
          a.t -= dt;
          if (a.t <= 0) {
            fire();
            toRec(a, 0.35);
          }
          return false;
        }
        return recDone(a, dt);
      },
    },
    summonSkill('clones', '幽影分身', 'shadow_clone', 14, 2, 3, 2, 3),
  ],
  onPhase2: (e, x, m) => {
    void x;
    m.cds.clones = 0;
    m.cds.blink = 0;
    emit({ t: 'burst', x: e.x, y: e.y, color: SHADOW, n: 40, spd: 200 });
  },
};

const KITS: Record<string, Kit> = { tyrant: TYRANT, warden: WARDEN, lich: LICH, shadow: SHADOW_KIT };

function kitOf(e: Enemy): Kit {
  return KITS[e.def.bossKit ?? ''] ?? TYRANT;
}

/* ------------------------------------------------------------------ */
/* 对外                                                                  */
/* ------------------------------------------------------------------ */
/**
 * 每步（眩晕也照常）推进：技能冷却、冲击波、二阶段判定。
 * 二阶段：血量 < 50% → phase=2、横幅 + 震屏 + 怒吼前摇（打断当前动作）、按技能组强化。
 */
export function tickBoss(e: Enemy, p: Player | null, dt: number): void {
  const x = ext(e);
  const m = bossMem(x);
  for (const k in m.cds) m.cds[k] -= dt;
  tickWaves(m, p, dt);
  if (e.phase < 2 && e.hp < e.maxHp * 0.5 && !e.dead) {
    e.phase = 2;
    emit({ t: 'banner', text: `${e.def.n} · 狂暴`, sub: '首领进入二阶段', color: '#ff7a5a' });
    emit({ t: 'shake', amt: 10 });
    emit({ t: 'ring', x: e.x, y: e.y, r0: e.r, r1: e.r + 120, color: '#ff7a5a', dur: 0.6 });
    sfx('bossRoar', e.x, e.y, 1);
    if (e.def.ai === 'boss') {
      x.act = newAct('roar', 0.9);
      setAnim(e, 'cast');
      e.cdSkill = Math.min(e.cdSkill, 1.0);
      kitOf(e).onPhase2?.(e, x, m);
    }
  }
}

export function aiBoss(e: Enemy, x: EnemyExt, p: Player, t: Tgt, dt: number): void {
  const m = bossMem(x);
  const kit = kitOf(e);
  const c: Ctx = { e, x, m, p, t, p2: e.phase >= 2 };
  const a = x.act;
  if (a) {
    if (a.k === 'roar') {
      a.t -= dt;
      e.ai = 'windup';
      setAnim(e, 'cast');
      if (a.t <= 0) x.act = null;
      return;
    }
    if (a.k === 'melee') {
      if (meleeTick(e, x, p, a, dt, 1, 1.5, 8, 180)) x.act = null;
      return;
    }
    if (a.k === 'stagger') {
      a.t -= dt;
      setAnim(e, 'hurt');
      if (a.t <= 0) x.act = null;
      return;
    }
    const sk = kit.skills.find(s => s.id === a.k);
    if (!sk || sk.tick(c, a, dt)) x.act = null;
    return;
  }
  e.ai = 'chase';
  if (!t.known) {
    moveToTarget(e, x, p, t, 0.85 * m.spdMul);
    return;
  }
  if (e.cdSkill <= 0 && startSkill(c, kit)) return;
  if (t.los && e.cdAtk <= 0 && t.d < e.r + p.r + MELEE_REACH + 6) {
    startMelee(e, x, p, 0.4);
    return;
  }
  if (kit.move) kit.move(c);
  else approach(e, x, p, t, 0.85 * m.spdMul);
}

/** 按权重随机选一个可用技能（不连续重复同一招），开始其前摇 */
function startSkill(c: Ctx, kit: Kit): boolean {
  const { e, m } = c;
  let cands = kit.skills.filter(s => (m.cds[s.id] ?? 0) <= 0 && s.ok(c));
  if (cands.length > 1) {
    const nonRepeat = cands.filter(s => s.id !== m.last);
    if (nonRepeat.length) cands = nonRepeat;
  }
  if (!cands.length) return false;
  let total = 0;
  for (const s of cands) total += s.w;
  let r = rng.next() * total;
  let sk = cands[cands.length - 1];
  for (const s of cands) {
    r -= s.w;
    if (r <= 0) {
      sk = s;
      break;
    }
  }
  const act = sk.start(c);
  if (!act) {
    m.cds[sk.id] = 1.5;
    return false;
  }
  c.x.act = act;
  m.last = sk.id;
  m.used[sk.id] = (m.used[sk.id] ?? 0) + 1;
  m.cds[sk.id] = sk.cd * (c.p2 ? 0.75 : 1);
  e.cdSkill = c.p2 ? 1.4 : 2.1;
  e.ai = 'windup';
  return true;
}

/** 技能组里的技能 id（测试/图鉴用） */
export function bossSkillIds(kit: string): string[] {
  return (KITS[kit] ?? TYRANT).skills.map(s => s.id);
}
