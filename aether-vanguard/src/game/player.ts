// 角色成长：建角、属性计算、经验升级、融合、技能树、路线、奥义、加点、回复。
// 移植自 legacy L577–631（makePlayer/collectEff/recalc）、L932–1003（gainExp/fuse/tree），按改版意见修正。
// 【契约】签名不可改；实现由 progression 代理完成。
//
// 与 legacy 的差异（均为修 bug 或按《游戏3.txt》定案）：
// - recalc 用 clsOf(p.cid)（legacy L604 传了玩家对象，全员拿到战士数值、法师只能挥剑）；
// - 基础生命 ×0.8，新增生命回复 hpRegen（maxHp×0.4%/秒，脱战 4 秒后 ×5）；
// - 装备词条累加后再夹 crit≤0.75、cdr≤0.6；强化 plus 让该件词条 ×(1+0.08×plus)；
// - tech 路线的 cdMul 只折算进 cdr 一次（施法时不要再乘）；
// - 升级经验 90×1.15^(lv−1)；当前职业 Lv10 即可融合、只能一次、+2 技能点；不能切换职业；
// - 路线树按路线分开计数；奥义解锁后不自动替换已装备的奥义（同时只生效一个）；
// - ultList 由树状态派生：切换路线后，另一条路线的路线奥义暂不可用（点数保留，切回即恢复）；
// - 融合后原职业已点的技能树继续生效（继承），新加点只能点在融合职业的树上。

import { MAX_LEVEL } from '../config';
import { clamp } from '../core/util';
import { clsOf, fusionOf, isClassId, FUSIONS } from '../data/classes';
import { PASSIVES } from '../data/passives';
import { SKILLS, ULTS } from '../data/skills';
import { ROUTES, TREES } from '../data/trees';
import type { ClassDef, EffKey, EffMap, FusionDef, RouteId, SkillDef } from '../data/types';
import { plusMul, reforgeWeapon, SLOT_IDS } from './itemgen';
import { emit, nextId, toast } from './state';
import type { Player, PlayerStats } from './types';

/* ---------- 可调参数 ---------- */

/** 基础生命倍率（改版意见：人物血量降低）：作用于 (职业生命 + 等级成长 + 体质) 这部分基础值 */
export const HP_BASE_MUL = 0.8;
/** 基础生命回复：每秒回复最大生命的 0.4% */
export const HP_REGEN_PCT = 0.004;
/** 脱战判定：距上次受伤超过该秒数 */
export const OUT_OF_COMBAT_T = 4;
/** 脱战时生命回复倍率 */
export const OUT_OF_COMBAT_REGEN = 5;
/** 暴击率 / 冷却缩减上限（装备词条累加后再夹） */
export const CRIT_CAP = 0.75;
export const CDR_CAP = 0.6;
/** 装备移速词条的总倍率上限（防止多件高品质移速词条叠出数倍移速） */
export const EQUIP_SPD_CAP = 1.5;
/** 融合所需等级 / 融合赠送技能点（改版意见 #15：不再 +6） */
export const FUSE_LEVEL = 10;
export const FUSE_TP = 2;
/** 每级属性点 / 技能点 */
export const SP_PER_LEVEL = 3;
export const TP_PER_LEVEL = 2;
/** stat.spd 保持 legacy 倍率（≈1.2–1.7，面板显示用）；实际移速 世界单位/秒 = stat.spd × 92（legacy L2992，sim 已按此换算） */
export const PLAYER_SPEED_SCALE = 92;
/** 角色名最长字符数 */
export const NAME_MAX = 12;
const START_GOLD = 160;
const BRANCHES = ['A', 'B'] as const;
const STAT_KEYS = ['str', 'agi', 'int', 'vit'] as const;

/* ---------- 建角 ---------- */

/** 角色名清洗：去控制字符、首尾空白，限长 */
export function cleanName(name: string): string {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(s).slice(0, NAME_MAX).join('');
}

/** 占位属性（recalc 之前用；随后立刻被覆盖） */
function blankStats(cid: string): PlayerStats {
  const c = clsOf(cid);
  return {
    atk: c.atk, armor: c.armor, maxHp: 1, maxMp: c.mp, spd: c.spd, crit: c.crit, cdr: 0, range: c.range, atkCd: c.atkCd,
    weapon: c.weapon, element: c.element, mpRegen: 0, hpRegen: 0, skillDmg: 1, elemDur: 1, elemPen: 0, pen: 0,
    pierce: 0, chain: 2, shield: 1, knock: 1, lifesteal: 0, mpOnHit: 0, burn: 0, freeze: 0, shock: 0, poison: 0,
    slow: 0, stealth: 0, eff: {},
  };
}

/** 新建角色（满血满蓝、送一把职业对应的粗制武器由 sim.newGame 负责） */
export function makePlayer(cid: string, route: RouteId, name: string): Player {
  const id = isClassId(cid) ? cid : 'warrior';
  const rt: RouteId = route === 'tech' ? 'tech' : 'magic';
  const p: Player = {
    // Actor
    id: nextId(), team: 'player', x: 0, y: 0, r: 11, hp: 1, maxHp: 1, facing: 1, aim: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
    // 成长
    name: cleanName(name) || clsOf(id).name, cid: id, route: rt, mp: 0, lv: 1, exp: 0, expNext: expForLevel(1),
    sp: 0, tp: 0, stats: { str: 0, agi: 0, int: 0, vit: 0 },
    tree: { [id]: { A: 0, B: 0 } }, routeTree: { magic: 0, tech: 0 }, ultList: [], ult: null,
    gold: START_GOLD, kills: 0, bossKills: 0, deaths: 0, playTime: 0, bestFloor: 0, fragments: [], fusedFrom: null,
    equip: { weapon: null, armor: null, trinket: null }, bag: [], stash: [], potions: { hp: 5, mp: 3 },
    mats: { gem: 0, part: 0, essence: 0 },
    // 运行态
    cd: { q: 0, e: 0, r: 0, ult: 0, dash: 0, atk: 0 },
    buffs: { shield: 0, shieldT: 0, roar: 0, stealth: 0, field: 0, overload: 0 },
    invuln: 0, hurtT: 999, actT: 999, arenaWins: 0, streak: 0, bestStreak: 0,
    stat: blankStats(id), dashT: 0, dashVx: 0, dashVy: 0,
  };
  recalc(p, true);
  return p;
}

/** 当前职业定义（legacy L604 用 clsOf(p) 是 bug，必须用 p.cid） */
export function classOf(p: Player): ClassDef { return clsOf(p.cid); }

/** 当前职业 Q/E/R 技能 */
export function skillsOf(p: Player): SkillDef[] { return SKILLS[p.cid] ?? SKILLS.warrior; }

/* ---------- 技能树 / 路线 ---------- */

/** 生效技能树所属的职业：融合后 = [原职业, 融合职业]（原职业已点节点继续生效） */
export function treeClasses(p: Player): string[] {
  return p.fusedFrom && p.fusedFrom !== p.cid ? [p.fusedFrom, p.cid] : [p.cid];
}

/** 某职业某分支已点数（夹到 0..节点数） */
export function treeLevel(p: Player, cid: string, br: 'A' | 'B'): number {
  const t = TREES[cid], rec = p.tree[cid];
  if (!t || !rec) return 0;
  return clamp(Math.floor(rec[br] || 0), 0, t[br].nodes.length);
}

/** 某路线已点数（各路线独立计数） */
export function routeLevel(p: Player, route: RouteId = p.route): number {
  const rt = ROUTES[route];
  if (!rt) return 0;
  return clamp(Math.floor(p.routeTree[route] || 0), 0, rt.nodes.length);
}

/** 汇总技能树 A/B + 当前路线已点节点的 eff */
export function collectEff(p: Player): EffMap {
  const e: EffMap = {};
  const add = (eff: EffMap): void => {
    for (const k of Object.keys(eff) as EffKey[]) {
      const v = eff[k];
      if (typeof v === 'number') e[k] = (e[k] ?? 0) + v;
    }
  };
  for (const cid of treeClasses(p)) {
    const t = TREES[cid];
    if (!t) continue;
    for (const br of BRANCHES) {
      const n = treeLevel(p, cid, br);
      for (let i = 0; i < n; i++) add(t[br].nodes[i].eff);
    }
  }
  const rt = ROUTES[p.route];
  if (rt) {
    const n = routeLevel(p);
    for (let i = 0; i < n; i++) add(rt.nodes[i].eff);
  }
  return e;
}

/** 当前可用的奥义（由树状态派生）：生效技能树的第 4 节点 + 当前路线的第 5 节点 */
export function unlockedUlts(p: Player): string[] {
  const out: string[] = [];
  const push = (u: string | null): void => { if (u && ULTS[u] && !out.includes(u)) out.push(u); };
  for (const cid of treeClasses(p)) {
    const t = TREES[cid];
    if (!t) continue;
    for (const br of BRANCHES) {
      const n = treeLevel(p, cid, br);
      for (let i = 0; i < n; i++) push(t[br].nodes[i].ult);
    }
  }
  const rt = ROUTES[p.route];
  if (rt) {
    const n = routeLevel(p);
    for (let i = 0; i < n; i++) push(rt.nodes[i].ult);
  }
  return out;
}

/**
 * 同步 ultList / ult：保留原顺序、追加新解锁、剔除当前不可用的；
 * 已装备的奥义仍可用就保持不变（不自动替换），没有或失效时取第一个可用的。
 */
export function syncUlts(p: Player): void {
  const avail = unlockedUlts(p);
  const list = (Array.isArray(p.ultList) ? p.ultList : []).filter(u => avail.includes(u));
  for (const u of avail) if (!list.includes(u)) list.push(u);
  p.ultList = list;
  if (!p.ult || !list.includes(p.ult)) p.ult = list[0] ?? null;
}

/* ---------- 属性计算 ---------- */

/** 重算派生属性 p.stat；refill=true 时回满血蓝 */
export function recalc(p: Player, refill = false): void {
  syncUlts(p);
  const c = clsOf(p.cid);
  const e = collectEff(p);
  const g = (k: EffKey): number => e[k] ?? 0;
  const s = p.stats, lv = Math.max(0, p.lv - 1), rt = ROUTES[p.route] ?? ROUTES.magic;

  let atk = (c.atk + lv * 1.9 + s.str * 2.4 + s.int * 1.3) * (1 + g('atk'));
  let armor = (c.armor + lv * 0.9 + s.vit * 1.3) * (1 + g('armor'));
  let maxHp = (c.hp + lv * 14 + s.vit * 14) * HP_BASE_MUL * (1 + g('hp'));
  const maxMp = c.mp + lv * 5 + s.int * 6;
  // 移速倍率（legacy 公式）；世界单位/秒 = spd × PLAYER_SPEED_SCALE（战士约 124）
  let spd = c.spd * 0.9 * (1 + s.agi * 0.004) * (1 + g('spd')) * rt.spdMul;
  let crit = c.crit + s.agi * 0.003 + g('crit');
  // tech 路线 cdMul 0.85 只在这里折算成 cdr+0.15 一次；施法时 cd×(1-cdr)，不要再乘 cdMul
  let cdr = s.int * 0.003 + g('cdr') + (1 - rt.cdMul);
  const range = c.range * (1 + g('range'));

  // 装备词条（含强化倍率）累加后再统一夹上限
  let spdMul = 1;
  for (const slot of SLOT_IDS) {
    const it = p.equip[slot];
    if (!it) continue;
    const m = plusMul(it.plus);
    for (const a of it.affixes) {
      const v = a.v * m;
      switch (a.k) {
        case 'atk': atk += v; break;
        case 'armor': armor += v; break;
        case 'hp': maxHp += v; break;
        case 'crit': crit += v; break;
        case 'cdr': cdr += v; break;
        case 'spd': spdMul *= 1 + v; break;
      }
    }
  }
  spd *= Math.min(spdMul, EQUIP_SPD_CAP);
  crit = clamp(crit, 0, CRIT_CAP);
  cdr = clamp(cdr, 0, CDR_CAP);

  const mh = Math.max(1, Math.round(maxHp));
  const mm = Math.max(0, Math.round(maxMp));
  const eff: Record<string, number> = {};
  for (const k of Object.keys(e) as EffKey[]) {
    const v = e[k];
    if (typeof v === 'number') eff[k] = v;
  }
  p.stat = {
    atk, armor, maxHp: mh, maxMp: mm, spd, crit, cdr, range, atkCd: c.atkCd, weapon: c.weapon, element: c.element,
    mpRegen: rt.mpRegen + g('mpRegen'), hpRegen: mh * HP_REGEN_PCT, skillDmg: rt.skillDmg + g('skillDmg'),
    elemDur: 1 + g('elemDur'), elemPen: g('elemPen'), pen: g('pen'), pierce: rt.pierce + g('pierce'),
    chain: 2 + g('chain'), shield: 1 + g('shield'), knock: 1 + g('knock'), lifesteal: g('lifesteal'),
    mpOnHit: g('mpOnHit'), burn: g('burn'), freeze: g('freeze'), shock: g('shock'), poison: g('poison'),
    slow: g('slow'), stealth: g('stealth'), eff,
  };
  p.maxHp = mh;
  if (refill) {
    p.hp = mh;
    p.mp = mm;
  } else {
    p.hp = Number.isFinite(p.hp) ? clamp(p.hp, 0, mh) : mh;
    p.mp = Number.isFinite(p.mp) ? clamp(p.mp, 0, mm) : mm;
  }
}

/** 实际移速（世界单位/秒）= stat.spd × 92（未含迟缓/冰冻等状态，状态倍率见 combat.speedMul） */
export function moveSpeed(p: Player): number { return p.stat.spd * PLAYER_SPEED_SCALE; }

/* ---------- 经验与升级 ---------- */

/** 第 lv 级升到 lv+1 所需经验（改版意见：升级所需经验增加；legacy 65×1.13^(lv−1)） */
export function expForLevel(lv: number): number {
  return Math.round(90 * Math.pow(1.15, Math.max(1, Math.floor(lv)) - 1));
}

/** 获得经验并处理升级（emit levelup/toast/sfx） */
export function gainExp(p: Player, n: number): void {
  if (!Number.isFinite(n) || n <= 0) return;
  if (p.lv >= MAX_LEVEL) { p.exp = 0; return; }
  const before = p.lv;
  p.exp += n;
  while (p.lv < MAX_LEVEL && p.exp >= p.expNext) {
    p.exp -= p.expNext;
    p.lv++;
    p.expNext = expForLevel(p.lv);
    p.sp += SP_PER_LEVEL;
    p.tp += TP_PER_LEVEL;
  }
  if (p.lv >= MAX_LEVEL) p.exp = 0;
  const gained = p.lv - before;
  if (gained <= 0) return;
  recalc(p, true); // 每次升级回满血蓝
  emit({ t: 'levelup', x: p.x, y: p.y });
  emit({ t: 'sfx', name: 'levelup', x: p.x, y: p.y });
  emit({ t: 'ui', what: 'hud' });
  toast(`等级提升 Lv.${p.lv} · 属性点 +${gained * SP_PER_LEVEL} · 技能点 +${gained * TP_PER_LEVEL}`, '#a3c979');
  if (before < FUSE_LEVEL && p.lv >= FUSE_LEVEL && !p.fusedFrom && fuseOptions(p).length > 0) {
    emit({ t: 'ui', what: 'fuseReady' });
    toast('等级达到 10 · 可前往转职殿找转职师·无面融合', '#f0bd7c');
  }
}

/* ---------- 融合转职 ---------- */

export interface FuseOption {
  fusion: FusionDef;
  ready: boolean;
  /** 逐项条件（✓/✗ + 进度文字），改版意见 #17 */
  reasons: Array<{ text: string; ok: boolean }>;
}

/**
 * 列出当前角色可见的融合选项（只列包含当前职业的融合）。
 * 规则（游戏3 #9 #15）：当前职业 Lv10 即可融合，只能融合一次。已融合的角色列出原职业的融合，全部不可用。
 * reasons[].text 不含 ✓/✗ 符号，由 UI 按 ok 渲染。
 */
export function fuseOptions(p: Player): FuseOption[] {
  const base = p.fusedFrom ?? p.cid;
  const baseName = clsOf(base).name;
  const cur = clsOf(p.cid);
  return FUSIONS.filter(f => f.from.includes(base)).map(f => {
    const reasons: FuseOption['reasons'] = [];
    if (p.fusedFrom) {
      reasons.push(f.id === p.cid
        ? { text: `已融合为「${f.name}」`, ok: true }
        : { text: `已融合为「${cur.name}」，无法再选择其他融合`, ok: false });
      reasons.push({ text: '每个角色只能融合一次', ok: false });
    } else {
      reasons.push({
        text: `${baseName}达到 Lv.${FUSE_LEVEL}（当前 ${Math.min(p.lv, FUSE_LEVEL)}/${FUSE_LEVEL}）`,
        ok: p.lv >= FUSE_LEVEL,
      });
      reasons.push({ text: '尚未融合（每个角色只能融合一次）', ok: true });
    }
    return { fusion: f, ready: reasons.every(r => r.ok), reasons };
  });
}

/** 是否有可执行的融合（HUD 角标/提示用） */
export function canFuseAny(p: Player): boolean { return fuseOptions(p).some(o => o.ready); }

/** 执行融合（只能一次；成功返回 true） */
export function doFuse(p: Player, fusionId: string): boolean {
  const opt = fuseOptions(p).find(o => o.fusion.id === fusionId);
  if (!opt || !opt.ready) {
    const why = opt ? opt.reasons.find(r => !r.ok)?.text : fusionOf(fusionId) ? `${clsOf(p.cid).name}不能融合为该职业` : '未知的融合职业';
    toast(`无法融合：${why ?? '条件未满足'}`, '#df8f7a');
    emit({ t: 'sfx', name: 'uiDeny' });
    return false;
  }
  const f = opt.fusion;
  const from = p.cid;
  p.fusedFrom = from;
  p.cid = f.id;
  p.tp += FUSE_TP;
  if (!p.tree[f.id]) p.tree[f.id] = { A: 0, B: 0 };
  // 武器类型随职业变化（如 游侠→骑士：弓→剑）：已装备武器原地重铸为新类型，保留 uid/品质/词条/强化
  const w = p.equip.weapon;
  let reforged = '';
  if (w && w.weaponType !== f.weapon) {
    reforgeWeapon(w, f.weapon);
    reforged = ` · 武器已重铸为 ${w.name}`; // 物品名自带「品质」括号，不再外套一层
  }
  recalc(p, true);
  emit({ t: 'banner', text: `融合转职 · ${f.name}`, sub: `${clsOf(from).name} → ${f.name} · 技能点 +${FUSE_TP}`, color: f.color });
  emit({ t: 'sfx', name: 'levelup', x: p.x, y: p.y });
  emit({ t: 'burst', x: p.x, y: p.y, color: f.color, n: 44, spd: 170 });
  emit({ t: 'ring', x: p.x, y: p.y, r0: 10, r1: 140, color: f.color, dur: 0.8 });
  emit({ t: 'flash', amt: 0.4, color: f.color });
  emit({ t: 'shake', amt: 9 });
  emit({ t: 'ui', what: 'skillbar' });
  emit({ t: 'ui', what: 'hud' });
  toast(`融合转职成功 → ${f.name} · 技能点 +${FUSE_TP}${reforged}`, '#f0bd7c');
  return true;
}

/* ---------- 加点 ---------- */

function deny(text: string): false {
  toast(text, '#df8f7a');
  emit({ t: 'sfx', name: 'uiDeny' });
  return false;
}

/** 解锁奥义后的提示：没有奥义时自动装备，否则只提示可在技能面板切换 */
function ultUnlockedToast(p: Player, ultId: string): void {
  const u = ULTS[ultId];
  if (!u) return;
  if (p.ult === ultId) toast(`解锁奥义「${u.n}」· 鼠标右键释放`, '#f0bd7c');
  else toast(`解锁奥义「${u.n}」· 可在技能面板切换（同时只生效一个）`, '#f0bd7c');
}

/** 技能树加点（branch A/B，消耗 1 tp） */
export function buyTreeNode(p: Player, branch: 'A' | 'B'): boolean {
  const t = TREES[p.cid];
  if (!t || (branch !== 'A' && branch !== 'B')) return false;
  const nodes = t[branch].nodes;
  const cur = treeLevel(p, p.cid, branch);
  if (cur >= nodes.length) return deny('该分支已全部点亮');
  if (p.tp <= 0) return deny('技能点不足');
  const rec = (p.tree[p.cid] ??= { A: 0, B: 0 });
  p.tp--;
  rec[branch] = cur + 1;
  const node = nodes[cur];
  recalc(p);
  if (node.ult) ultUnlockedToast(p, node.ult);
  else toast(`技能树 · ${node.n} 已点亮`, '#a3c979');
  emit({ t: 'sfx', name: 'ui' });
  emit({ t: 'ui', what: 'skillbar' });
  return true;
}

/** 当前路线加点（各路线独立计数） */
export function buyRouteNode(p: Player): boolean {
  const rt = ROUTES[p.route];
  if (!rt) return false;
  const cur = routeLevel(p);
  if (cur >= rt.nodes.length) return deny('该路线已全部点亮');
  if (p.tp <= 0) return deny('技能点不足');
  p.tp--;
  p.routeTree[p.route] = cur + 1;
  const node = rt.nodes[cur];
  recalc(p);
  if (node.ult) ultUnlockedToast(p, node.ult);
  else toast(`${rt.name}路线 · ${node.n} 已点亮`, '#a3c979');
  emit({ t: 'sfx', name: 'ui' });
  emit({ t: 'ui', what: 'skillbar' });
  return true;
}

/** 切换路线（只在议会 NPC 处调用）：只改路线，两条路线的点数各自保留 */
export function setRoute(p: Player, route: RouteId): void {
  if ((route !== 'magic' && route !== 'tech') || p.route === route) return;
  const prevUlt = p.ult;
  p.route = route;
  recalc(p);
  const rt = ROUTES[route];
  toast(`源能路线切换为「${rt.name}」· 已点 ${routeLevel(p)}/${rt.nodes.length}（两条路线点数各自保留）`, rt.color);
  if (prevUlt && p.ult !== prevUlt) {
    toast(`路线奥义「${ULTS[prevUlt]?.n ?? prevUlt}」仅在原路线生效，当前奥义：${p.ult ? ULTS[p.ult]?.n ?? p.ult : '无'}`, '#c4a78c');
  }
  emit({ t: 'sfx', name: 'arcane' });
  emit({ t: 'ui', what: 'skillbar' });
  emit({ t: 'ui', what: 'hud' });
}

/** 设定唯一生效奥义（改版意见 #6） */
export function setUlt(p: Player, ultId: string): void {
  if (!ULTS[ultId] || !p.ultList.includes(ultId)) { deny('该奥义尚未解锁'); return; }
  if (p.ult === ultId) return;
  p.ult = ultId; // 奥义冷却 cd.ult 共用，切换不会刷新冷却
  toast(`奥义已切换为「${ULTS[ultId].n}」`, '#f0bd7c');
  emit({ t: 'sfx', name: 'ui' });
  emit({ t: 'ui', what: 'skillbar' });
}

/** 属性加点 */
export function addStat(p: Player, key: 'str' | 'agi' | 'int' | 'vit'): boolean {
  if (!STAT_KEYS.includes(key) || p.sp <= 0) return false;
  p.stats[key]++;
  p.sp--;
  recalc(p);
  emit({ t: 'ui', what: 'hud' });
  return true;
}

/** 职业隐藏被动（改版意见：加入职业隐藏被动/固有特性）；融合职业用自身 id */
export function passiveOf(cid: string): { name: string; desc: string } {
  const d = PASSIVES[cid];
  return d ? { name: d.name, desc: d.desc } : { name: '无', desc: '该职业没有隐藏被动。' };
}

/* ---------- 每步更新 ---------- */

/**
 * 每步更新：冷却、HP/MP 回复、buff 计时、无敌时间、游戏时长。
 * 不处理 flash/anim/animT/status/击退/冲刺（分别由 combat / sim 负责）。
 * 护盾：buffs.shield 是吸收量，buffs.shieldT 是剩余秒，计时归零时护盾清零（设置护盾必须同时给 shieldT）。
 */
export function tickPlayer(p: Player, dt: number): void {
  if (!(dt > 0)) return;
  p.playTime += dt;
  p.hurtT += dt;
  p.actT += dt;
  p.invuln = Math.max(0, p.invuln - dt);
  const cd = p.cd;
  cd.q = Math.max(0, cd.q - dt);
  cd.e = Math.max(0, cd.e - dt);
  cd.r = Math.max(0, cd.r - dt);
  cd.ult = Math.max(0, cd.ult - dt);
  cd.dash = Math.max(0, cd.dash - dt);
  cd.atk = Math.max(0, cd.atk - dt);
  const b = p.buffs;
  b.shieldT = Math.max(0, b.shieldT - dt);
  if (b.shieldT <= 0) b.shield = 0;
  b.roar = Math.max(0, b.roar - dt);
  b.stealth = Math.max(0, b.stealth - dt);
  b.field = Math.max(0, b.field - dt);
  b.overload = Math.max(0, b.overload - dt);
  if (p.dead || p.hp <= 0) return;
  const st = p.stat;
  if (p.mp < st.maxMp) p.mp = Math.min(st.maxMp, p.mp + st.mpRegen * dt);
  if (p.hp < st.maxHp) {
    const mul = p.hurtT > OUT_OF_COMBAT_T ? OUT_OF_COMBAT_REGEN : 1;
    p.hp = Math.min(st.maxHp, p.hp + st.hpRegen * mul * dt);
  }
}
