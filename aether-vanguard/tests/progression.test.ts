// progression 模块测试：成长（player.ts）、装备/背包/商店/铁匠（items.ts）、存读档与旧档导入（save.ts）、技能树数据。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAG_SLOTS, MAX_LEVEL, STASH_SLOTS } from '../src/config';
import { ALL_CLASSES, FUSIONS } from '../src/data/classes';
import { AFFIX, HEAVY_LOOKS, RARITY, WEAPON_LOOKS } from '../src/data/items';
import { ULTS } from '../src/data/skills';
import { EFF_PCT, ROUTES, TREES } from '../src/data/trees';
import type { AffixKey, EffKey, SlotId } from '../src/data/types';
import {
  addToBag, affixText, bagHasRoom, buyItem, buyPotion, equipItem, findItem, fromStash, itemAffixLines, itemPower,
  potionPrice, rollDropItem, rollItem, rollShop, sellItem, starterWeapon, toStash, unequip, upgradeCost, upgradeItem,
  usePotion, weaponTypeOf,
} from '../src/game/items';
import { powerCap } from '../src/game/itemgen';
import {
  addStat, buyRouteNode, buyTreeNode, collectEff, doFuse, expForLevel, fuseOptions, gainExp, makePlayer, moveSpeed,
  passiveOf, recalc, setRoute, setUlt, skillsOf, tickPlayer,
} from '../src/game/player';
import {
  deleteSlot, firstEmptySlot, hasLegacy, importLegacy, listSlots, loadSlot, saveGame, slotKey, writeSlot,
} from '../src/game/save';
import { G } from '../src/game/state';
import type { FxEvent, Item, Player } from '../src/game/types';

/* ---------- 工具 ---------- */

/** 内存版 localStorage（Node 下没有） */
class MemStorage {
  private m = new Map<string, string>();
  get length(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
}

let seq = 0;
function mkItem(slot: SlotId, affixes: Array<[AffixKey, number]>, extra: Partial<Item> = {}): Item {
  return {
    uid: `t-${++seq}`, slot, rarity: 0, lv: 1, name: `测试${seq}`, value: 100, plus: 0, sprite: 'x',
    affixes: affixes.map(([k, v]) => ({ k, n: k, v })),
    ...(slot === 'weapon' ? { weaponType: 'sword' as const } : {}),
    ...extra,
  };
}
const events = (t: FxEvent['t']): FxEvent[] => G.events.filter(e => e.t === t);
const hasUi = (what: string): boolean => G.events.some(e => e.t === 'ui' && e.what === what);
const hasSfx = (name: string): boolean => G.events.some(e => e.t === 'sfx' && e.name === name);
function setLevel(p: Player, lv: number): void {
  p.lv = lv;
  p.expNext = expForLevel(lv);
  recalc(p, true);
}

beforeEach(() => {
  G.events.length = 0;
  G.mode = 'play';
  G.player = null;
  G.shops = {};
  G.slot = 0;
});

/* ---------- recalc ---------- */

describe('recalc', () => {
  it('uses the player own class (legacy L604 clsOf(p) bug): mages get staff, ranger gets bow', () => {
    for (const c of ALL_CLASSES) {
      const p = makePlayer(c.id, 'magic', 't');
      expect(p.stat.weapon).toBe(c.weapon);
      expect(p.stat.range).toBe(c.range);
      expect(p.stat.element).toBe(c.element);
      expect(p.stat.atkCd).toBe(c.atkCd);
    }
    expect(makePlayer('pyro', 'magic', 'a').stat.weapon).toBe('staff');
    expect(makePlayer('cryo', 'magic', 'a').stat.weapon).toBe('staff');
    expect(makePlayer('ranger', 'magic', 'a').stat.weapon).toBe('bow');
    expect(makePlayer('pyro', 'magic', 'a').stat.atk).toBe(24);
  });

  it('fills every Player field, base HP ×0.8, hp regen 0.4%/s, full on creation', () => {
    const p = makePlayer('warrior', 'magic', '  阿岚  ');
    expect(p.name).toBe('阿岚');
    expect(p.r).toBe(11);
    expect(p.stat.maxHp).toBe(160);
    expect(p.maxHp).toBe(160);
    expect(p.hp).toBe(160);
    expect(p.mp).toBe(p.stat.maxMp);
    expect(p.stat.hpRegen).toBeCloseTo(0.64, 6);
    expect(p.routeTree).toEqual({ magic: 0, tech: 0 });
    expect(p.mats).toEqual({ gem: 0, part: 0, essence: 0 });
    expect(p.stash).toEqual([]);
    expect(p.fusedFrom).toBeNull();
    expect(p.buffs.shieldT).toBe(0);
    expect(p.expNext).toBe(90);
    expect(makePlayer('nope', 'magic', '').cid).toBe('warrior');
    expect(makePlayer('pyro', 'magic', '').name).toBe('火焰魔法师');
  });

  it('clamps crit ≤ 0.75 and cdr ≤ 0.6 after equipment affixes', () => {
    const p = makePlayer('assassin', 'tech', 't');
    p.equip.trinket = mkItem('trinket', [['crit', 0.9], ['cdr', 0.9]]);
    recalc(p);
    expect(p.stat.crit).toBe(0.75);
    expect(p.stat.cdr).toBe(0.6);
  });

  it('keeps stat.spd as the legacy multiplier (sim ×92), moveSpeed in world units/s, caps equipment speed', () => {
    const p = makePlayer('warrior', 'magic', 't');
    expect(p.stat.spd).toBeCloseTo(1.5 * 0.9, 6);
    expect(moveSpeed(p)).toBeCloseTo(1.5 * 0.9 * 92, 6); // ≈124 世界单位/秒
    expect(makePlayer('warrior', 'tech', 't').stat.spd).toBeCloseTo(1.5 * 0.9 * 1.06, 6);
    p.equip.weapon = mkItem('weapon', [['spd', 1]]);
    p.equip.armor = mkItem('armor', [['spd', 1]]);
    recalc(p);
    expect(p.stat.spd).toBeCloseTo(1.5 * 0.9 * 1.5, 6); // 装备移速总倍率上限 ×1.5
  });

  it('counts the tech route cdMul into cdr exactly once', () => {
    expect(makePlayer('warrior', 'tech', 't').stat.cdr).toBeCloseTo(0.15, 6);
    expect(makePlayer('warrior', 'magic', 't').stat.cdr).toBe(0);
  });

  it('applies plus ×(1+0.08·plus) to that item affixes', () => {
    const p = makePlayer('warrior', 'magic', 't');
    const base = p.stat.atk;
    p.equip.weapon = mkItem('weapon', [['atk', 10]]);
    recalc(p);
    expect(p.stat.atk).toBeCloseTo(base + 10, 6);
    p.equip.weapon.plus = 5;
    recalc(p);
    expect(p.stat.atk).toBeCloseTo(base + 14, 6);
  });

  it('keeps current hp when not refilling and clamps to max', () => {
    const p = makePlayer('warrior', 'magic', 't');
    p.hp = 10;
    recalc(p);
    expect(p.hp).toBe(10);
    p.hp = 99999;
    recalc(p);
    expect(p.hp).toBe(p.stat.maxHp);
  });

  it('skillsOf returns the class Q/E/R', () => {
    expect(skillsOf(makePlayer('storm', 'magic', 't')).map(s => s.kind)).toEqual(['chain', 'beam', 'buff']);
  });
});

/* ---------- 经验 ---------- */

describe('experience', () => {
  it('expForLevel = round(90×1.15^(lv−1))', () => {
    expect(expForLevel(1)).toBe(90);
    expect(expForLevel(10)).toBe(Math.round(90 * 1.15 ** 9));
    for (let lv = 1; lv < MAX_LEVEL; lv++) expect(expForLevel(lv + 1)).toBeGreaterThan(expForLevel(lv));
  });

  it('levels up with +3 sp / +2 tp, refills and emits levelup/toast/sfx', () => {
    const p = makePlayer('warrior', 'magic', 't');
    p.hp = 5;
    gainExp(p, 90);
    expect(p.lv).toBe(2);
    expect(p.exp).toBe(0);
    expect(p.sp).toBe(3);
    expect(p.tp).toBe(2);
    expect(p.hp).toBe(p.stat.maxHp);
    expect(events('levelup')).toHaveLength(1);
    expect(events('toast').length).toBeGreaterThan(0);
    expect(hasSfx('levelup')).toBe(true);
  });

  it('handles multiple levels at once and caps at 50', () => {
    const p = makePlayer('warrior', 'magic', 't');
    gainExp(p, expForLevel(1) + expForLevel(2) + 5);
    expect(p.lv).toBe(3);
    expect(p.exp).toBe(5);
    gainExp(p, 1e12);
    expect(p.lv).toBe(MAX_LEVEL);
    expect(p.exp).toBe(0);
    expect(p.tp).toBe((MAX_LEVEL - 1) * 2);
    gainExp(p, 1000);
    expect(p.lv).toBe(MAX_LEVEL);
    expect(p.exp).toBe(0);
  });

  it('emits fuseReady exactly once when first reaching Lv10', () => {
    const p = makePlayer('warrior', 'magic', 't');
    setLevel(p, 9);
    gainExp(p, p.expNext);
    expect(p.lv).toBe(10);
    expect(hasUi('fuseReady')).toBe(true);
    expect(G.events.some(e => e.t === 'toast' && e.text.includes('转职师·无面'))).toBe(true);
    G.events.length = 0;
    gainExp(p, p.expNext);
    expect(p.lv).toBe(11);
    expect(hasUi('fuseReady')).toBe(false);
  });
});

/* ---------- 融合 ---------- */

describe('fusion', () => {
  it('lists only fusions that contain the current class', () => {
    const p = makePlayer('warrior', 'magic', 't');
    expect(fuseOptions(p).map(o => o.fusion.id).sort()).toEqual(['armored', 'knight', 'stormguard']);
    expect(fuseOptions(makePlayer('pyro', 'magic', 't')).map(o => o.fusion.id)).toEqual(['elemage']);
  });

  it('cannot fuse at Lv9; reasons show ✗ with progress text', () => {
    const p = makePlayer('warrior', 'magic', 't');
    setLevel(p, 9);
    const opts = fuseOptions(p);
    expect(opts.every(o => !o.ready)).toBe(true);
    const lvReason = opts[0].reasons[0];
    expect(lvReason.ok).toBe(false);
    expect(lvReason.text).toContain('9/10');
    expect(doFuse(p, 'knight')).toBe(false);
    expect(p.cid).toBe('warrior');
    expect(p.fusedFrom).toBeNull();
  });

  it('can fuse at Lv10 (single class), only once, +2 tp', () => {
    const p = makePlayer('warrior', 'magic', 't');
    setLevel(p, 10);
    expect(fuseOptions(p).every(o => o.ready)).toBe(true);
    const tp = p.tp;
    expect(doFuse(p, 'knight')).toBe(true);
    expect(p.cid).toBe('knight');
    expect(p.fusedFrom).toBe('warrior');
    expect(p.tp).toBe(tp + 2);
    expect(p.stat.maxHp).toBe(Math.round((215 + 9 * 14) * 0.8));
    expect(events('banner')).toHaveLength(1);
    expect(hasUi('skillbar')).toBe(true);
    // 只能一次
    expect(doFuse(p, 'armored')).toBe(false);
    expect(doFuse(p, 'knight')).toBe(false);
    expect(p.cid).toBe('knight');
    expect(p.tp).toBe(tp + 2);
    const after = fuseOptions(p);
    expect(after.length).toBe(3);
    expect(after.every(o => !o.ready)).toBe(true);
  });

  it('rejects a fusion that does not include the current class', () => {
    const p = makePlayer('warrior', 'magic', 't');
    setLevel(p, 10);
    expect(doFuse(p, 'elemage')).toBe(false);
    expect(doFuse(p, 'nope')).toBe(false);
    expect(p.cid).toBe('warrior');
  });

  it('reforges the equipped weapon when the weapon type changes (ranger bow → knight sword)', () => {
    const p = makePlayer('ranger', 'magic', 't');
    setLevel(p, 10);
    const bow = mkItem('weapon', [['atk', 20], ['crit', 0.05]], { weaponType: 'bow', plus: 3, rarity: 2 });
    p.equip.weapon = bow;
    recalc(p);
    expect(doFuse(p, 'knight')).toBe(true);
    expect(p.equip.weapon).toBe(bow);
    expect(bow.weaponType).toBe('sword');
    expect(bow.plus).toBe(3);
    expect(bow.affixes.map(a => a.v)).toEqual([20, 0.05]);
    expect(bow.uid).toMatch(/^t-/);
    const swordSprites = [...WEAPON_LOOKS.sword, ...HEAVY_LOOKS.flat()].map(l => l.sprite);
    expect(swordSprites).toContain(bow.sprite);
  });

  it('keeps the origin class tree effects after fusion', () => {
    const p = makePlayer('warrior', 'magic', 't');
    setLevel(p, 10);
    p.tp = 5;
    expect(buyTreeNode(p, 'A')).toBe(true);
    expect(collectEff(p).atk).toBeCloseTo(0.18, 6);
    doFuse(p, 'knight');
    expect(collectEff(p).atk).toBeCloseTo(0.18, 6);
    expect(p.tree.knight).toEqual({ A: 0, B: 0 });
  });
});

/* ---------- 技能树 / 路线 / 奥义 ---------- */

describe('skill trees and ultimates', () => {
  it('4th node unlocks an ult; sets it only when none is equipped', () => {
    const p = makePlayer('warrior', 'magic', 't');
    p.tp = 20;
    for (let i = 0; i < 4; i++) expect(buyTreeNode(p, 'A')).toBe(true);
    expect(buyTreeNode(p, 'A')).toBe(false);
    expect(p.ultList).toEqual(['whirl']);
    expect(p.ult).toBe('whirl');
    for (let i = 0; i < 4; i++) buyTreeNode(p, 'B');
    expect(p.ultList).toEqual(['whirl', 'bulwark']);
    expect(p.ult).toBe('whirl'); // 不自动替换
    setUlt(p, 'bulwark');
    expect(p.ult).toBe('bulwark');
    setUlt(p, 'inferno'); // 未解锁
    expect(p.ult).toBe('bulwark');
    expect(p.tp).toBe(12);
  });

  it('needs tp', () => {
    const p = makePlayer('warrior', 'magic', 't');
    expect(buyTreeNode(p, 'A')).toBe(false);
    expect(buyRouteNode(p)).toBe(false);
    expect(p.tree.warrior).toEqual({ A: 0, B: 0 });
  });

  it('counts route trees separately (legacy shared counter bug)', () => {
    const p = makePlayer('warrior', 'magic', 't');
    p.tp = 20;
    buyRouteNode(p);
    buyRouteNode(p);
    expect(p.routeTree).toEqual({ magic: 2, tech: 0 });
    expect(collectEff(p).skillDmg).toBeCloseTo(0.15, 6);
    setRoute(p, 'tech');
    expect(p.route).toBe('tech');
    expect(p.routeTree).toEqual({ magic: 2, tech: 0 });
    expect(collectEff(p).skillDmg).toBeUndefined();
    buyRouteNode(p);
    expect(p.routeTree).toEqual({ magic: 2, tech: 1 });
    expect(collectEff(p).cdr).toBeCloseTo(0.1, 6);
    expect(p.stat.cdr).toBeCloseTo(0.25, 6); // 0.15 路线基础 + 0.1 节点
    setRoute(p, 'magic');
    expect(collectEff(p).skillDmg).toBeCloseTo(0.15, 6);
  });

  it('route ult is only usable on its own route; points are kept', () => {
    const p = makePlayer('pyro', 'magic', 't');
    p.tp = 20;
    for (let i = 0; i < 5; i++) buyRouteNode(p);
    expect(p.ultList).toEqual(['storm']);
    expect(p.ult).toBe('storm');
    setRoute(p, 'tech');
    expect(p.ultList).toEqual([]);
    expect(p.ult).toBeNull();
    setRoute(p, 'magic');
    expect(p.ultList).toEqual(['storm']);
    expect(p.ult).toBe('storm');
  });

  it('addStat spends sp and recalcs', () => {
    const p = makePlayer('warrior', 'magic', 't');
    expect(addStat(p, 'str')).toBe(false);
    p.sp = 2;
    const atk = p.stat.atk;
    expect(addStat(p, 'str')).toBe(true);
    expect(p.stats.str).toBe(1);
    expect(p.sp).toBe(1);
    expect(p.stat.atk).toBeCloseTo(atk + 2.4, 6);
  });

  it('passiveOf reads data/passives (fusions use their own id)', () => {
    expect(passiveOf('warrior').name).toBe('不屈');
    expect(passiveOf('knight').name).toBe('骑士道');
    expect(passiveOf('???').desc.length).toBeGreaterThan(0);
  });
});

/* ---------- tickPlayer ---------- */

describe('tickPlayer', () => {
  it('ticks cooldowns, buffs, timers and regen (×5 out of combat)', () => {
    const p = makePlayer('warrior', 'magic', 't');
    p.cd.q = 1;
    p.cd.atk = 0.1;
    p.buffs.shield = 50;
    p.buffs.shieldT = 0.5;
    p.buffs.stealth = 2;
    p.invuln = 0.2;
    p.mp = 0;
    p.hp = 100;
    p.hurtT = 0;
    tickPlayer(p, 1);
    expect(p.cd.q).toBe(0);
    expect(p.cd.atk).toBe(0);
    expect(p.buffs.shield).toBe(0);
    expect(p.buffs.shieldT).toBe(0);
    expect(p.buffs.stealth).toBe(1);
    expect(p.invuln).toBe(0);
    expect(p.playTime).toBe(1);
    expect(p.mp).toBeCloseTo(p.stat.mpRegen, 6);
    expect(p.hp).toBeCloseTo(100 + p.stat.hpRegen, 6); // 刚受伤：×1
    p.hurtT = 5;
    const hp = p.hp;
    tickPlayer(p, 1);
    expect(p.hp).toBeCloseTo(hp + p.stat.hpRegen * 5, 6); // 脱战：×5
    p.hp = p.stat.maxHp - 0.01;
    tickPlayer(p, 10);
    expect(p.hp).toBe(p.stat.maxHp);
  });

  it('does not regen when dead', () => {
    const p = makePlayer('warrior', 'magic', 't');
    p.hp = 0;
    p.dead = true;
    tickPlayer(p, 5);
    expect(p.hp).toBe(0);
  });
});

/* ---------- 装备生成 ---------- */

describe('rollItem', () => {
  it('always has ≥2 distinct affixes (2+rarity), primary affix by slot, valid sprite and unique uid', () => {
    const uids = new Set<string>();
    for (let i = 0; i < 800; i++) {
      const it = rollItem(1 + (i % 50));
      expect(it.affixes.length).toBe(Math.min(6, 2 + it.rarity));
      expect(it.affixes.length).toBeGreaterThanOrEqual(2);
      expect(new Set(it.affixes.map(a => a.k)).size).toBe(it.affixes.length);
      for (const a of it.affixes) expect(a.v).toBeGreaterThan(0);
      expect(uids.has(it.uid)).toBe(false);
      uids.add(it.uid);
      expect(it.plus).toBe(0);
      expect(it.value).toBe(Math.round(24 + it.rarity * 38 + it.lv * 8));
      if (it.slot === 'weapon') {
        expect(it.affixes[0].k).toBe('atk');
        expect(it.weaponType).toBeDefined();
        expect(it.sprite).toMatch(/^weapon_/);
      } else if (it.slot === 'armor') {
        expect(it.affixes[0].k).toBe('armor');
        expect(it.weaponType).toBeUndefined();
        expect(it.sprite).toBe(it.sprite.replace(/_\d$/, '') + `_${it.rarity}`);
        expect(it.sprite).toMatch(/^armor_(plate|robe|leather)_[0-4]$/);
      } else {
        expect(it.sprite).toMatch(/^trinket_(ring|amulet|chip)_[0-4]$/);
      }
      expect(it.name.startsWith(`「${RARITY[it.rarity].n}」`)).toBe(true);
    }
  });

  it('respects slot / weaponType / rarity options and picks sprites by rarity tier', () => {
    for (let i = 0; i < 60; i++) {
      const staff = rollItem(5, { slot: 'weapon', weaponType: 'staff', rarity: 4 });
      expect(staff.weaponType).toBe('staff');
      expect(staff.rarity).toBe(4);
      expect(staff.sprite).toBe('weapon_red_magic_staff');
      const s0 = rollItem(5, { slot: 'weapon', weaponType: 'sword', rarity: 0 });
      expect(['weapon_rusty_sword', ...HEAVY_LOOKS[0].map(l => l.sprite)]).toContain(s0.sprite);
      const s4 = rollItem(5, { slot: 'weapon', weaponType: 'sword', rarity: 4 });
      expect(['weapon_lavish_sword', ...HEAVY_LOOKS[4].map(l => l.sprite)]).toContain(s4.sprite);
      const d = rollItem(5, { slot: 'weapon', weaponType: 'dagger', rarity: 3 });
      expect(['weapon_katana', 'weapon_throwing_axe']).toContain(d.sprite);
      expect(['weapon_bow', 'weapon_bow_2']).toContain(rollItem(5, { slot: 'weapon', weaponType: 'bow' }).sprite);
      expect(rollItem(5, { slot: 'armor' }).slot).toBe('armor');
    }
    // weaponType 只在部位为武器时生效
    for (let i = 0; i < 60; i++) {
      const it = rollItem(5, { weaponType: 'bow' });
      if (it.slot === 'weapon') expect(it.weaponType).toBe('bow');
      else expect(it.weaponType).toBeUndefined();
    }
  });

  it('quality floor: every higher rarity beats the best of the rarity below at the same level', () => {
    for (const lv of [1, 7, 20, 35, 50]) {
      const range = (r: number): [number, number] => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 250; i++) {
          const p = itemPower(rollItem(lv, { rarity: r }));
          lo = Math.min(lo, p);
          hi = Math.max(hi, p);
        }
        return [lo, hi];
      };
      const ranges = [0, 1, 2, 3, 4].map(range);
      for (let r = 1; r <= 4; r++) {
        expect(ranges[r][0]).toBeGreaterThan(ranges[r - 1][1]); // 精良下限 > 粗制上限，以此类推
        expect(ranges[r][0]).toBeGreaterThan(powerCap(r - 1, lv)); // 也高于低一档的理论上限
      }
    }
  });

  it('affix values follow lerp(min,max,0.35..1)×(1+lv×0.075)×rarity for common items', () => {
    for (let i = 0; i < 300; i++) {
      const lv = 1 + (i % 50);
      const it = rollItem(lv, { rarity: 0 });
      for (const a of it.affixes) {
        const d = AFFIX.find(x => x.k === a.k);
        if (!d) throw new Error('unknown affix');
        const m = 1 + lv * 0.075;
        const tol = a.k === 'crit' || a.k === 'cdr' || a.k === 'spd' ? 0.0005 : 0.5;
        expect(a.v).toBeGreaterThanOrEqual((d.min + (d.max - d.min) * 0.35) * m - tol);
        expect(a.v).toBeLessThanOrEqual(d.max * m + tol);
      }
    }
  });

  it('formats affix text', () => {
    expect(affixText({ k: 'crit', n: '暴击', v: 0.054 })).toBe('+5.4% 暴击');
    expect(affixText({ k: 'atk', n: '攻击', v: 12 })).toBe('+12 攻击');
    expect(itemAffixLines(mkItem('weapon', [['atk', 10]], { plus: 5 }))).toEqual(['+14 atk']);
  });

  it('weaponTypeOf matches the class table', () => {
    for (const id of ['warrior', 'knight', 'armored', 'stormguard']) expect(weaponTypeOf(id)).toBe('sword');
    for (const id of ['pyro', 'cryo', 'storm', 'elemage']) expect(weaponTypeOf(id)).toBe('staff');
    expect(weaponTypeOf('ranger')).toBe('bow');
    for (const id of ['assassin', 'ninja', 'stormblade']) expect(weaponTypeOf(id)).toBe('dagger');
  });

  it('starterWeapon and rollDropItem helpers', () => {
    const w = starterWeapon('cryo');
    expect(w.slot).toBe('weapon');
    expect(w.weaponType).toBe('staff');
    expect(w.rarity).toBe(0);
    let own = 0, weapons = 0;
    for (let i = 0; i < 600; i++) {
      const it = rollDropItem(10, 'ranger');
      if (it.slot !== 'weapon') continue;
      weapons++;
      if (it.weaponType === 'bow') own++;
    }
    expect(weapons).toBeGreaterThan(100);
    expect(own / weapons).toBeGreaterThan(0.5); // 60% + 40%×1/4 ≈ 70%
  });
});

/* ---------- 背包 / 装备 / 商店 / 铁匠 / 仓库 ---------- */

describe('inventory', () => {
  it('rejects pickups when the bag is full', () => {
    const p = makePlayer('warrior', 'magic', 't');
    for (let i = 0; i < BAG_SLOTS; i++) expect(addToBag(p, mkItem('armor', [['armor', 1]]))).toBe(true);
    expect(bagHasRoom(p)).toBe(false);
    expect(addToBag(p, mkItem('armor', [['armor', 1]]))).toBe(false);
    expect(p.bag.length).toBe(BAG_SLOTS);
    expect(hasSfx('uiDeny')).toBe(true);
    // 满包不能卸装备
    p.equip.armor = mkItem('armor', [['armor', 3]]);
    expect(unequip(p, 'armor')).toBe(false);
    expect(p.equip.armor).not.toBeNull();
  });

  it('weapons are class-restricted; swapping keeps the bag slot', () => {
    const p = makePlayer('pyro', 'magic', 't');
    const sword = mkItem('weapon', [['atk', 5]], { weaponType: 'sword' });
    const staff1 = mkItem('weapon', [['atk', 5]], { weaponType: 'staff' });
    const staff2 = mkItem('weapon', [['atk', 9]], { weaponType: 'staff' });
    p.bag.push(sword, staff1, staff2);
    expect(equipItem(p, sword.uid)).toBe(false);
    expect(G.events.some(e => e.t === 'toast' && e.text.includes('职业不符'))).toBe(true);
    expect(equipItem(p, staff1.uid)).toBe(true);
    expect(p.equip.weapon).toBe(staff1);
    expect(p.bag).toEqual([sword, staff2]);
    const atk = p.stat.atk;
    expect(equipItem(p, staff2.uid)).toBe(true);
    expect(p.bag).toEqual([sword, staff1]);
    expect(p.stat.atk).toBeCloseTo(atk + 4, 6);
    expect(unequip(p, 'weapon')).toBe(true);
    expect(p.equip.weapon).toBeNull();
    expect(p.bag.length).toBe(3);
  });

  it('sells for 60% of value', () => {
    const p = makePlayer('warrior', 'magic', 't');
    const it = mkItem('trinket', [['hp', 10]], { value: 101 });
    p.bag.push(it);
    const g = p.gold;
    expect(sellItem(p, it.uid)).toBe(true);
    expect(p.gold).toBe(g + 61);
    expect(p.bag.length).toBe(0);
    expect(sellItem(p, it.uid)).toBe(false);
  });

  it('smith / potion shops and buying', () => {
    const p = makePlayer('ranger', 'magic', 't');
    setLevel(p, 12);
    G.player = p;
    const smith = rollShop('smith', p.lv);
    expect(G.shops.smith).toBe(smith);
    expect(smith).toHaveLength(6);
    expect(smith.filter(i => i.slot === 'weapon')).toHaveLength(3);
    expect(smith.filter(i => i.slot === 'armor')).toHaveLength(3);
    expect(smith[0].weaponType).toBe('bow');
    expect(smith[1].weaponType).toBe('bow');
    for (const it of smith) {
      expect(it.rarity).toBeLessThanOrEqual(3);
      expect(Math.abs(it.lv - 12)).toBeLessThanOrEqual(1);
      expect(it.cost).toBe(Math.round(it.value * 1.7 + 30));
    }
    const potionShop = rollShop('potion', p.lv);
    expect(potionShop).toHaveLength(3);
    expect(potionShop.every(i => i.slot === 'trinket')).toBe(true);

    const target = smith[0];
    p.gold = 0;
    expect(buyItem(p, 'smith', target.uid)).toBe(false);
    p.gold = (target.cost ?? 0) + 5;
    expect(buyItem(p, 'smith', target.uid)).toBe(true);
    expect(p.gold).toBe(5);
    expect(p.bag).toContain(target);
    expect(target.cost).toBeUndefined();
    expect(G.shops.smith).toHaveLength(5);
    expect(buyItem(p, 'smith', target.uid)).toBe(false);
    // 满包不能买
    while (p.bag.length < BAG_SLOTS) p.bag.push(mkItem('armor', [['armor', 1]]));
    p.gold = 1e6;
    expect(buyItem(p, 'smith', smith[1].uid)).toBe(false);
  });

  it('potions: price by level, full cannot drink, +40% hp / +50% mp', () => {
    const p = makePlayer('warrior', 'magic', 't');
    setLevel(p, 10);
    G.player = p;
    expect(potionPrice('hp')).toBe(60);
    expect(potionPrice('mp')).toBe(55);
    p.gold = 200;
    expect(buyPotion(p, 'hp', 2)).toBe(true);
    expect(p.gold).toBe(80);
    expect(p.potions.hp).toBe(7);
    expect(buyPotion(p, 'mp', 5)).toBe(false);
    expect(usePotion(p, 'hp')).toBe(false); // 满血
    p.hp = 10;
    expect(usePotion(p, 'hp')).toBe(true);
    expect(p.hp).toBeCloseTo(10 + p.stat.maxHp * 0.4, 6);
    expect(p.potions.hp).toBe(6);
    expect(hasSfx('potion')).toBe(true);
    expect(events('floater').length).toBeGreaterThan(0);
    p.mp = 0;
    expect(usePotion(p, 'mp')).toBe(true);
    expect(p.mp).toBeCloseTo(p.stat.maxMp * 0.5, 6);
    p.potions.mp = 0;
    p.mp = 0;
    expect(usePotion(p, 'mp')).toBe(false);
  });

  it('smith upgrade: cost formula, materials, +10 cap', () => {
    const staff = mkItem('weapon', [['atk', 10]], { weaponType: 'staff', rarity: 2 });
    expect(upgradeCost(staff)).toEqual({ gold: 120, mats: { part: 1, essence: 1 } });
    staff.plus = 3;
    expect(upgradeCost(staff)).toEqual({ gold: 480, mats: { part: 4, gem: 1, essence: 2 } });
    const armor = mkItem('armor', [['armor', 5]], { rarity: 0 });
    expect(upgradeCost(armor)).toEqual({ gold: 60, mats: { part: 1 } });

    const p = makePlayer('pyro', 'magic', 't');
    staff.plus = 0;
    p.equip.weapon = staff;
    recalc(p);
    p.gold = 1000;
    expect(upgradeItem(p, staff.uid)).toBe(false); // 缺零件
    p.mats = { gem: 0, part: 5, essence: 5 };
    const atk = p.stat.atk;
    expect(upgradeItem(p, staff.uid)).toBe(true);
    expect(staff.plus).toBe(1);
    expect(p.gold).toBe(880);
    expect(p.mats).toEqual({ gem: 0, part: 4, essence: 4 });
    expect(p.stat.atk).toBeCloseTo(atk + 10 * 0.08, 6);
    expect(hasSfx('forge')).toBe(true);
    staff.plus = 10;
    expect(upgradeItem(p, staff.uid)).toBe(false);
  });

  it('stash moves items both ways and respects capacity; findItem by uid', () => {
    const p = makePlayer('warrior', 'magic', 't');
    const a = mkItem('armor', [['armor', 2]]);
    const w = mkItem('weapon', [['atk', 2]]);
    p.bag.push(a);
    p.equip.weapon = w;
    expect(toStash(p, a.uid)).toBe(true);
    expect(p.stash).toEqual([a]);
    expect(findItem(p, a.uid)).toEqual({ item: a, where: 'stash' });
    expect(findItem(p, w.uid)).toEqual({ item: w, where: 'equip' });
    expect(findItem(p, 'missing')).toBeNull();
    expect(fromStash(p, a.uid)).toBe(true);
    expect(findItem(p, a.uid)?.where).toBe('bag');
    while (p.stash.length < STASH_SLOTS) p.stash.push(mkItem('armor', [['armor', 1]]));
    expect(toStash(p, a.uid)).toBe(false);
  });
});

/* ---------- 存读档 ---------- */

describe('save slots', () => {
  let ls: MemStorage;
  beforeEach(() => {
    ls = new MemStorage();
    vi.stubGlobal('localStorage', ls);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function richPlayer(): Player {
    const p = makePlayer('ranger', 'tech', '游侠小林');
    setLevel(p, 12);
    p.tp = 30;
    p.sp = 4;
    p.stats = { str: 1, agi: 10, int: 2, vit: 3 };
    doFuse(p, 'ninja');
    buyTreeNode(p, 'A');
    buyRouteNode(p);
    buyRouteNode(p);
    p.gold = 777;
    p.kills = 42;
    p.deaths = 2;
    p.playTime = 1234.5;
    p.bestFloor = 3;
    p.fragments = [0, 2];
    p.mats = { gem: 3, part: 9, essence: 1 };
    p.potions = { hp: 4, mp: 1 };
    p.equip.weapon = rollItem(12, { slot: 'weapon', weaponType: 'dagger', rarity: 3 });
    p.equip.armor = rollItem(12, { slot: 'armor', rarity: 1 });
    p.equip.armor.plus = 4;
    p.bag.push(rollItem(12, { slot: 'trinket', rarity: 2 }));
    p.stash.push(rollItem(10, { slot: 'weapon', weaponType: 'bow' }));
    p.streak = 2;
    p.bestStreak = 5;
    p.arenaWins = 7;
    recalc(p);
    // 运行态（不应落盘）
    p.x = 500; p.y = 600; p.cd.q = 3; p.buffs.shield = 30; p.buffs.shieldT = 4; p.hp = 1;
    p.status = { burn: { t: 2, stacks: 1, dps: 3 } };
    return p;
  }

  it('round-trips persistent fields and rebuilds runtime state', () => {
    const p = richPlayer();
    G.player = p;
    G.slot = 2;
    saveGame();
    const raw = ls.getItem(slotKey(2));
    expect(raw).toBeTruthy();
    const json = JSON.parse(raw ?? '{}') as { v: number; p: Record<string, unknown> };
    expect(json.v).toBe(3);
    for (const k of ['stat', 'x', 'y', 'cd', 'buffs', 'status', 'anim', 'vx', 'hp', 'dashT', 'invuln']) {
      expect(json.p).not.toHaveProperty(k);
    }
    const info = listSlots();
    expect(info).toHaveLength(4);
    expect(info[2]).toMatchObject({ slot: 2, name: '游侠小林', cid: 'ninja', lv: 12, bestFloor: 3, playTime: 1234.5 });
    expect(info[0]).toBeNull();
    expect(firstEmptySlot()).toBe(0);

    const q = loadSlot(2);
    expect(q).not.toBeNull();
    if (!q) return;
    for (const k of ['name', 'cid', 'route', 'lv', 'exp', 'sp', 'tp', 'stats', 'tree', 'routeTree', 'ultList', 'ult', 'gold',
      'kills', 'deaths', 'playTime', 'bestFloor', 'fragments', 'fusedFrom', 'equip', 'bag', 'stash', 'potions', 'mats',
      'arenaWins', 'streak', 'bestStreak'] as const) {
      expect(q[k], k).toEqual(p[k]);
    }
    expect(q.stat).toEqual(p.stat);
    expect(q.hp).toBe(q.stat.maxHp); // 读档回满
    expect(q.x).toBe(0);
    expect(q.cd.q).toBe(0);
    expect(q.buffs.shield).toBe(0);
    expect(q.status).toEqual({});
    expect(q.expNext).toBe(expForLevel(12));
  });

  it('does not save on the title screen, saves when dead, and can delete', () => {
    const p = makePlayer('warrior', 'magic', 't');
    G.player = p;
    G.mode = 'title';
    saveGame();
    expect(listSlots().every(s => s === null)).toBe(true);
    G.mode = 'dead';
    p.deaths = 3;
    saveGame();
    expect(loadSlot(0)?.deaths).toBe(3);
    deleteSlot(0);
    expect(loadSlot(0)).toBeNull();
    expect(listSlots()[0]).toBeNull();
  });

  it('fills defaults for partial / old-format saves and rejects garbage', () => {
    ls.setItem(slotKey(1), JSON.stringify({ v: 3, p: { cid: 'cryo', lv: 4, equip: { weapon: { slot: 'weapon', rarity: 1, affixes: [{ k: 'atk', v: 7 }, { k: 'bogus', v: 1 }] } } } }));
    const q = loadSlot(1);
    expect(q).not.toBeNull();
    if (!q) return;
    expect(q.cid).toBe('cryo');
    expect(q.lv).toBe(4);
    expect(q.routeTree).toEqual({ magic: 0, tech: 0 });
    expect(q.mats).toEqual({ gem: 0, part: 0, essence: 0 });
    expect(q.potions).toEqual({ hp: 5, mp: 3 });
    expect(q.stat.weapon).toBe('staff');
    // 无类型、无名字的武器 → 默认 sword，与冰法不符 → 不装备，放回背包
    expect(q.equip.weapon).toBeNull();
    const w = q.bag[0];
    expect(w.weaponType).toBe('sword');
    expect(w.affixes).toEqual([{ k: 'atk', n: '攻击', v: 7 }]); // 未知词条被剔除
    expect(typeof w.uid).toBe('string');
    expect(w.sprite).toMatch(/^weapon_/);
    expect(w.name.length).toBeGreaterThan(0);
    ls.setItem(slotKey(3), '{not json');
    expect(loadSlot(3)).toBeNull();
    expect(listSlots()[3]).toBeNull();
    expect(loadSlot(9)).toBeNull();
  });

  it('degrades safely without localStorage or when it throws', () => {
    vi.stubGlobal('localStorage', undefined);
    G.player = makePlayer('warrior', 'magic', 't');
    expect(() => saveGame()).not.toThrow();
    expect(listSlots()).toEqual([null, null, null, null]);
    expect(loadSlot(0)).toBeNull();
    expect(hasLegacy()).toBe(false);
    expect(importLegacy()).toBeNull();
    const throwing = {
      getItem(): string { throw new Error('SecurityError'); },
      setItem(): void { throw new Error('QuotaExceeded'); },
      removeItem(): void { throw new Error('SecurityError'); },
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => saveGame()).not.toThrow();
    expect(writeSlot(0, G.player)).toBe(false);
    expect(() => deleteSlot(0)).not.toThrow();
    expect(listSlots()).toEqual([null, null, null, null]);
  });
});

/* ---------- legacy 导入 ---------- */

describe('legacy import', () => {
  let ls: MemStorage;
  beforeEach(() => {
    ls = new MemStorage();
    vi.stubGlobal('localStorage', ls);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('imports a v1 save: V1MAP ids, items get uid/sprite/weaponType, points recomputed', () => {
    expect(hasLegacy()).toBe(false);
    ls.setItem('aether_vanguard_save_v1', JSON.stringify({
      v: 1,
      p: {
        cid: 'astromancer', route: 'tech', lv: 12, exp: 40, sp: 99, stats: { str: 2, agi: 0, int: 6, vit: 1 },
        gold: 500, kills: 88, bossKills: 1, playTime: 3600, deaths: 4, best: 3, streak: 1, arenaWins: 5,
        equip: {
          weapon: { id: 3, slot: 'weapon', rarity: 2, affixes: [{ k: 'atk', n: '攻击', v: 20 }], lv: 10, name: '「稀有」相位法杖', value: 200 },
          armor: { id: 4, slot: 'armor', rarity: 1, affixes: [{ k: 'hp', n: '生命', v: 40 }], lv: 9, name: '「精良」相位斗篷', value: 120 },
          trinket: null,
        },
        bag: [
          { id: 3, slot: 'weapon', rarity: 0, affixes: [{ k: 'atk', n: '攻击', v: 4 }], lv: 2, name: '「粗制」脉冲枪', value: 30 },
          { id: 7, slot: 'trinket', rarity: 1, affixes: [{ k: 'crit', n: '暴击', v: 0.03 }], lv: 5, name: '「精良」超载芯片', value: 90 },
        ],
        potions: { hp: 2, mp: 9 },
      },
    }));
    expect(hasLegacy()).toBe(true);
    const p = importLegacy();
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.cid).toBe('pyro');
    expect(p.route).toBe('tech');
    expect(p.fusedFrom).toBeNull();
    expect(p.lv).toBe(12);
    expect(p.tp).toBe(22);
    expect(p.sp).toBe(33 - 9);
    expect(p.gold).toBe(500);
    expect(p.bestStreak).toBe(3);
    expect(p.potions).toEqual({ hp: 2, mp: 9 });
    const w = p.equip.weapon;
    expect(w?.weaponType).toBe('staff');
    expect(w?.name).toBe('「稀有」相位法杖'); // 名字与类型相符则保留
    expect(w?.sprite).toBe('weapon_green_magic_staff');
    expect(p.equip.armor?.sprite).toBe('armor_robe_1');
    const gun = p.bag.find(i => i.slot === 'weapon');
    expect(gun?.weaponType).toBe('staff'); // 旧武器统一转成职业可用类型
    expect(gun?.name).not.toContain('脉冲枪');
    expect(p.bag.find(i => i.slot === 'trinket')?.sprite).toBe('trinket_chip_1');
    const uids = [w?.uid, p.equip.armor?.uid, ...p.bag.map(i => i.uid)];
    expect(new Set(uids).size).toBe(4); // 旧数字 id 撞号 → 新 uid 唯一
    expect(uids.every(u => typeof u === 'string' && u.length > 8)).toBe(true);
    expect(p.stat.weapon).toBe('staff');
    expect(p.hp).toBe(p.stat.maxHp);
  });

  it('prefers v2; keeps fused cid, infers fusedFrom, maps the shared routeTree number', () => {
    ls.setItem('aether_vanguard_save_v1', JSON.stringify({ v: 1, p: { cid: 'vanguard', lv: 3 } }));
    ls.setItem('aether_vanguard_save_v2', JSON.stringify({
      v: 2, floor: 7,
      p: {
        cid: 'knight', route: 'tech', routeTree: 3, lv: 15, tp: 40, sp: 0, stats: { str: 10, agi: 10, int: 10, vit: 12 },
        tree: { knight: { A: 2, B: 1 }, ranger: { A: 4, B: 0 }, warrior: { A: 1, B: 0 }, pyro: { A: 4, B: 4 } },
        classLv: { warrior: 10, ranger: 12, pyro: 1, cryo: 1, storm: 1, assassin: 1 },
        fusions: ['knight', 'armored'], ultList: ['piercer', 'whirl', 'inferno'], ult: 'piercer',
        bag: Array.from({ length: 28 }, (_, i) => ({ id: i, slot: 'armor', rarity: 0, affixes: [{ k: 'armor', v: 2 }], lv: 1, name: '「粗制」游猎皮甲', value: 30 })),
        equip: { weapon: { id: 99, slot: 'weapon', rarity: 3, affixes: [{ k: 'atk', v: 30 }], lv: 14, name: '「史诗」猎风长弓', value: 400 } },
      },
    }));
    const p = importLegacy();
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.cid).toBe('knight');
    expect(p.fusedFrom).toBe('ranger'); // 技能树点数更多的来源职业
    expect(Object.keys(p.tree).sort()).toEqual(['knight', 'ranger']);
    expect(p.routeTree).toEqual({ magic: 0, tech: 3 });
    expect(p.ultList).toEqual(['piercer']);
    expect(p.ult).toBe('piercer');
    expect(p.tp).toBe(14 * 2 + 2 - (2 + 1 + 4 + 0) - 3);
    expect(p.sp).toBe(0); // 42 点已分配 = 14×3
    expect(p.equip.weapon?.weaponType).toBe('sword');
    expect(p.equip.weapon?.name).not.toContain('长弓');
    expect(p.bag.length).toBe(BAG_SLOTS);
    expect(p.stash.length).toBe(4); // 超出格子上限的移进仓库
    expect(p.bag.every(i => i.sprite === 'armor_leather_0')).toBe(true);
    expect(p.stat.weapon).toBe('sword');
  });

  it('round-trips an imported character through a save slot', () => {
    ls.setItem('aether_vanguard_save_v2', JSON.stringify({ v: 2, p: { cid: 'cryo', lv: 8, route: 'magic', routeTree: 2 } }));
    const p = importLegacy();
    expect(p).not.toBeNull();
    if (!p) return;
    const s = firstEmptySlot();
    expect(s).toBe(0);
    expect(writeSlot(s, p)).toBe(true);
    const q = loadSlot(s);
    expect(q?.cid).toBe('cryo');
    expect(q?.routeTree).toEqual({ magic: 2, tech: 0 });
    expect(q?.name).toBe(p.name);
  });
});

/* ---------- 数据：节点描述与效果一致 ---------- */

describe('tree data', () => {
  it('every node description states its real eff values and unlocked ult', () => {
    const all = [
      ...Object.values(TREES).flatMap(t => [...t.A.nodes, ...t.B.nodes]),
      ...Object.values(ROUTES).flatMap(r => r.nodes),
    ];
    expect(all.length).toBe(96 + 10);
    for (const node of all) {
      for (const k of Object.keys(node.eff) as EffKey[]) {
        const v = node.eff[k] ?? 0;
        const want = EFF_PCT.has(k) ? `${Math.round(v * 100)}%` : `${v}`;
        expect(node.d, `${node.n}.${k}`).toContain(want);
      }
      if (node.ult) expect(node.d, node.n).toContain(`「${ULTS[node.ult].n}」`);
    }
  });

  it('fusion classes exist for every from pair', () => {
    for (const f of FUSIONS) for (const id of f.from) expect(ALL_CLASSES.some(c => c.id === id)).toBe(true);
  });
});
