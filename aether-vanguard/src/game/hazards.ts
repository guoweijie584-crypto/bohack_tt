// 伤害区域：陨石（延迟落地）、光环（跟随、周期结算）、陷阱（触发）、持续区域（火海/冰面/毒雾）。
// 移植自 legacy L1478–1521 中带 dmg 的 effects，拆成独立判定实体。
// 【契约】签名不可改；实现由 combat 代理完成。
//
// 约定（渲染层直接读 G.hazards 绘制）：
// - meteor：delay>0 期间为预警（每 0.3s emit ring），落地瞬间结算并 triggered=true，随后 life 为余辉；
// - aura：跟随 followId（玩家或镜像对手），每 tick 秒结算一次（第一次立即）；
// - trap：delay 为武装时间（0.4s），武装后有敌对目标踏入即对 r+20 内全体结算（伤害 + 定身 + 3s 迟缓），然后消失；
// - zone / iceField：原地持续区域，每 tick 结算；
// - dmg=0 且无 slow 的 hazard 是纯视觉（不屈壁垒穹顶、冲锋尘土、闪烁残影、千钧一射冲击）；
// - style 是视觉 key（奥义 id 或技能 style），雷电类会额外 emit beam（天降雷柱）/chain 事件。
// 另外：updateHazards 每步顺带推进非玩家实体的位移脚本（镜像对手冲锋）与镜像对手 buff 计时。

import type { ElementId } from '../data/types';
import type { Actor, Hazard } from './types';
import { G, emit, nextId } from './state';
import { rng } from '../core/rng';
import { ELEM } from '../data/elements';
import { addDotStack, applySlow, applyStatus, damageEnemy, damagePlayer, knockback, tickRivalBuffs, type HitOpts } from './combat';
import { advanceOtherMotions } from './motion';
import { actorById, clearLine, hostilesOf, isEnemyActor, isPlayerActor } from './combatUtil';

export type HazardInit = Partial<Hazard> & Pick<Hazard, 'kind' | 'team' | 'x' | 'y' | 'r' | 'dmg' | 'el' | 'style' | 'ownerId'>;

/** hazard 附加参数（共享类型 Hazard 没有这些字段，用 WeakMap 挂载，随 hazard 回收） */
export interface HazardMeta {
  /** 施法时的暴击（飘字显示用；伤害已含暴击） */
  crit?: boolean;
  /** >0：命中时向外击退；<0：向中心拉拽（源能风暴） */
  knock?: number;
  /** 每次结算施加的中毒层数（>1 时额外叠层） */
  stacks?: number;
  /** 每次结算的额外冻结几率（冰属性时） */
  freezeChance?: number;
  /** thunderStorm：每跳落雷数 */
  strikes?: number;
  /** 元素交替（元素法师双元领域：每跳在 el 与 altEl 之间切换） */
  altEl?: ElementId;
  /** 陨石落地后生成的持续区域 */
  after?: HazardInit;
  afterMeta?: HazardMeta;
  /** 落地时 emit 天降光柱（雷/轨道炮） */
  sky?: boolean;
  /** 小型冲击（箭雨单支箭）：不发预警圈、不震屏 */
  light?: boolean;
}
const metaOf = new WeakMap<Hazard, HazardMeta>();

export function setHazardMeta(h: Hazard, m: HazardMeta): void {
  metaOf.set(h, { ...metaOf.get(h), ...m });
}
export function hazardMeta(h: Hazard): HazardMeta | undefined {
  return metaOf.get(h);
}

const MAX_HAZARDS = 240;
const TRAP_COLOR = '#a3c979';

export function spawnHazard(init: HazardInit): Hazard {
  const life = init.life ?? 1;
  const h: Hazard = {
    id: init.id ?? nextId(),
    kind: init.kind,
    team: init.team,
    x: init.x,
    y: init.y,
    r: init.r,
    delay: Math.max(0, init.delay ?? 0),
    life,
    maxLife: init.maxLife ?? life,
    tick: init.tick ?? 0.4,
    tickT: init.tickT ?? 0,
    dmg: init.dmg,
    el: init.el,
    status: init.status,
    stun: init.stun,
    slow: init.slow,
    followId: init.followId,
    style: init.style,
    ownerId: init.ownerId,
    triggered: init.triggered ?? false,
  };
  G.hazards.push(h);
  if (G.hazards.length > MAX_HAZARDS) G.hazards.splice(0, G.hazards.length - MAX_HAZARDS);
  return h;
}

export function updateHazards(dt: number): void {
  advanceOtherMotions(dt);
  tickRivalBuffs(dt);
  const list = G.hazards;
  const n = list.length;
  for (let i = 0; i < n; i++) {
    const h = list[i];
    if (!h) break; // 结算中切场景（clearWorld）
    if (h.life <= 0) continue;
    const m = metaOf.get(h);
    switch (h.kind) {
      case 'meteor': updateMeteor(h, m, dt); break;
      case 'trap': updateTrap(h, m, dt); break;
      case 'aura':
        if (!waitDelay(h, dt)) updateAura(h, m, dt);
        break;
      case 'zone':
      case 'iceField':
        if (!waitDelay(h, dt)) {
          h.life -= dt;
          tickArea(h, m, dt);
        }
        break;
    }
  }
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (h && h.life > 0) list[w++] = h;
  }
  list.length = w;
}

/* ------------------------------------------------------------------ */

/** 光环/持续区域的延迟生效（首领冰原等的预警期）：期间不结算、不扣寿命，每 0.3s 发一次预警圈；返回是否仍在等待 */
function waitDelay(h: Hazard, dt: number): boolean {
  if (h.delay <= 0) return false;
  h.delay -= dt;
  h.tickT -= dt;
  if (h.tickT <= 0) {
    h.tickT = 0.3;
    emit({ t: 'ring', x: h.x, y: h.y, r0: h.r * 0.35, r1: h.r, color: ELEM[h.el].c, dur: 0.3 });
  }
  if (h.delay > 0) return true;
  h.delay = 0;
  h.tickT = 0; // 生效瞬间立即结算第一跳
  return false;
}

function updateMeteor(h: Hazard, m: HazardMeta | undefined, dt: number): void {
  if (h.delay > 0) {
    h.delay -= dt;
    h.tickT -= dt;
    if (!m?.light && h.tickT <= 0) {
      h.tickT = 0.3;
      emit({ t: 'ring', x: h.x, y: h.y, r0: h.r * 0.35, r1: h.r, color: ELEM[h.el].c, dur: 0.3 });
    }
    if (h.delay > 0) return;
  }
  if (!h.triggered) {
    h.triggered = true;
    meteorImpact(h, m);
  }
  h.life -= dt;
}

function meteorImpact(h: Hazard, m: HazardMeta | undefined): void {
  const col = ELEM[h.el].c;
  if (m?.sky) emit({ t: 'beam', x0: h.x, y0: h.y - 320, x1: h.x, y1: h.y, w: m.light ? 10 : 24, el: h.el, color: col });
  resolveArea(h, m, h.r);
  if (m?.light) {
    emit({ t: 'impact', x: h.x, y: h.y, el: h.el, size: 6 });
  } else {
    emit({ t: 'explosion', x: h.x, y: h.y, r: h.r, el: h.el, team: h.team });
    emit({ t: 'ring', x: h.x, y: h.y, r0: 10, r1: h.r, color: col, dur: 0.4 });
    emit({ t: 'shake', amt: h.r > 100 ? 10 : 7 });
    emit({ t: 'sfx', name: h.el === 'lightning' ? 'zap' : h.el === 'tech' ? 'tech' : 'explosion', x: h.x, y: h.y });
  }
  if (m?.after) {
    const z = spawnHazard(m.after);
    if (m.afterMeta) setHazardMeta(z, m.afterMeta);
  }
}

function updateTrap(h: Hazard, m: HazardMeta | undefined, dt: number): void {
  h.life -= dt;
  if (h.delay > 0) {
    h.delay -= dt;
    return;
  }
  const targets = hostilesOf(h.team);
  if (!targets.some(t => Math.hypot(t.x - h.x, t.y - h.y) < h.r + t.r)) return;
  h.triggered = true;
  const R = h.r + 20;
  for (const t of targets) {
    if (Math.hypot(t.x - h.x, t.y - h.y) > R + t.r || !clearLine(h.x, h.y, t.x, t.y)) continue;
    hit(h, m, t, h.dmg, { slow: undefined, stun: h.stun ?? 1.4 });
    // 荆棘缠绕：定身之后还有 3 秒迟缓（legacy 描述写“减速”实际没有减速）
    if (!t.dead && !(isEnemyActor(t) && t.shield > 0)) applySlow(t, 3, h.slow ?? 0.5);
  }
  emit({ t: 'ring', x: h.x, y: h.y, r0: 8, r1: R, color: TRAP_COLOR, dur: 0.35 });
  emit({ t: 'burst', x: h.x, y: h.y, color: TRAP_COLOR, n: 26, spd: 150 });
  emit({ t: 'sfx', name: 'hit', x: h.x, y: h.y });
  h.life = 0;
}

function updateAura(h: Hazard, m: HazardMeta | undefined, dt: number): void {
  if (h.followId !== undefined) {
    const f = actorById(h.followId);
    if (!f || f.dead) {
      h.life = 0;
      return;
    }
    h.x = f.x;
    h.y = f.y;
  }
  h.life -= dt;
  tickArea(h, m, dt);
}

/** 周期结算（第一次立即） */
function tickArea(h: Hazard, m: HazardMeta | undefined, dt: number): void {
  h.tickT -= dt;
  if (h.tickT > 0) return;
  h.tickT = Math.max(0, h.tickT + (h.tick > 0 ? h.tick : 0.4));
  if (h.dmg <= 0 && !h.slow) return; // 纯视觉
  if (m?.altEl) {
    const cur = h.el;
    h.el = m.altEl;
    m.altEl = cur;
  }
  if (h.style === 'thunderStorm') thunderStrikes(h, m);
  else resolveArea(h, m, h.r);
}

/** 半径 r 内（视线可达）的敌对目标全部结算 */
function resolveArea(h: Hazard, m: HazardMeta | undefined, r: number): number {
  let n = 0;
  for (const t of hostilesOf(h.team)) {
    if (Math.hypot(t.x - h.x, t.y - h.y) > r + t.r) continue;
    if (!clearLine(h.x, h.y, t.x, t.y)) continue;
    hit(h, m, t, h.dmg);
    n++;
  }
  return n;
}

/** 雷霆风暴：每跳在范围内随机落雷（优先劈中敌人） */
function thunderStrikes(h: Hazard, m: HazardMeta | undefined): void {
  const n = Math.max(1, m?.strikes ?? 2);
  const cands = hostilesOf(h.team).filter(t => Math.hypot(t.x - h.x, t.y - h.y) <= h.r + t.r);
  const col = ELEM[h.el].c;
  for (let k = 0; k < n; k++) {
    let x: number, y: number;
    if (cands.length) {
      const t = cands.splice(Math.floor(rng.next() * cands.length), 1)[0];
      x = t.x;
      y = t.y;
      hit(h, m, t, h.dmg);
    } else {
      const a = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.next()) * h.r;
      x = h.x + Math.cos(a) * rr;
      y = h.y + Math.sin(a) * rr;
    }
    emit({ t: 'beam', x0: x, y0: y - 300, x1: x, y1: y, w: 10, el: h.el, color: col });
    emit({ t: 'impact', x, y, el: h.el, size: 10 });
  }
  emit({ t: 'sfx', name: 'zap', x: h.x, y: h.y });
}

/** 单个目标结算：伤害 + 额外叠层/冻结/拉拽 */
function hit(h: Hazard, m: HazardMeta | undefined, t: Actor, dmg: number, extra?: HitOpts): void {
  const pull = m?.knock !== undefined && m.knock < 0;
  const opts: HitOpts = {
    el: h.el, status: h.status, stun: h.stun, slow: h.slow, crit: m?.crit,
    knock: !pull && m?.knock ? m.knock : undefined,
    srcX: h.x, srcY: h.y, isSkill: true, proc: true, sourceId: h.ownerId,
    ...extra,
  };
  if (isEnemyActor(t)) {
    if (dmg > 0) damageEnemy(t, dmg, opts);
    else if (opts.slow) applySlow(t, 1.2, opts.slow);
    if (t.dead || t.shield > 0) return;
    if (m?.stacks && m.stacks > 1 && (h.status === 'poison' || h.el === 'poison')) {
      for (let k = 1; k < m.stacks; k++) addDotStack(t, 'poison');
    }
  } else if (isPlayerActor(t)) {
    if (dmg > 0) damagePlayer(t, dmg, opts);
    else if (opts.slow) applySlow(t, 0.6, opts.slow);
    if (t.dead) return;
  } else {
    return;
  }
  if (m?.freezeChance && h.el === 'ice' && rng.next() < m.freezeChance) applyStatus(t, 'freeze', 0.7);
  if (pull && m?.knock) {
    // 拉拽力度不超过距离（避免把目标甩过中心）
    const d = Math.hypot(t.x - h.x, t.y - h.y);
    knockback(t, h.x, h.y, -Math.min(-m.knock, d * 6));
  }
}
