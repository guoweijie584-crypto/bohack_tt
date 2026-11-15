// progression 区审查回归测试：存档与面板操作的衔接、换角色时的商店货架、药剂购买数量校验。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_DT } from '../src/config';
import { buyItem, buyPotion, equipItem, fromStash, rollShop, sellItem, toStash, unequip, upgradeItem } from '../src/game/items';
import { buyTreeNode, expForLevel, makePlayer, recalc } from '../src/game/player';
import { loadSlot, slotKey, writeSlot } from '../src/game/save';
import { continueGame, newGame, step } from '../src/game/sim';
import { G } from '../src/game/state';
import type { Item, Player } from '../src/game/types';

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

let ls: MemStorage;
beforeEach(() => {
  ls = new MemStorage();
  vi.stubGlobal('localStorage', ls);
  G.events.length = 0;
  G.mode = 'play';
  G.panel = null;
  G.player = null;
  G.shops = {};
  G.slot = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  G.panel = null;
});

/** 读出槽位里落盘的原始 p（不经过 hydrate） */
function stored(slot: number): Record<string, unknown> {
  const raw = ls.getItem(slotKey(slot));
  expect(raw, `slot ${slot} saved`).toBeTruthy();
  return (JSON.parse(raw ?? '{}') as { p: Record<string, unknown> }).p;
}

function levelTo(p: Player, lv: number): void {
  p.lv = lv;
  p.expNext = expForLevel(lv);
  recalc(p, true);
}

describe('review: panel actions are persisted', () => {
  it('step() saves once when the simulation resumes after a panel was open (UI panels never save)', () => {
    newGame('warrior', 'magic', '存档', 1);
    const p = G.player as Player;
    expect(stored(1).gold).toBe(p.gold);
    // 面板打开 = 暂停：在面板里花技能点、改金币（UI 动作函数本身不存档）
    G.panel = 'skill';
    step(SIM_DT);
    p.tp = 3;
    expect(buyTreeNode(p, 'A')).toBe(true);
    p.gold = 4321;
    step(SIM_DT);
    expect(stored(1).gold).not.toBe(4321); // 暂停中不推进、不存档
    // 关面板：恢复模拟的第一步立即落盘
    G.panel = null;
    step(SIM_DT);
    const saved = stored(1);
    expect(saved.gold).toBe(4321);
    expect(saved.tp).toBe(2);
    expect((saved.tree as Record<string, { A: number }>).warrior.A).toBe(1);
    // 只存一次：之后正常游玩不会每步都写（自动存档计时清零，排除 20 秒定时存档）
    G.saveT = 0;
    ls.setItem(slotKey(1), 'sentinel');
    step(SIM_DT);
    expect(ls.getItem(slotKey(1))).toBe('sentinel');
  });

  it('shop / smith / stash transactions are written to the current slot immediately', () => {
    const p = makePlayer('ranger', 'magic', '商人');
    levelTo(p, 5);
    G.player = p;
    G.slot = 2;
    p.gold = 100000;
    p.mats = { gem: 9, part: 9, essence: 9 };
    const shelf = rollShop('smith', p.lv);
    const bow = shelf[0];
    expect(bow.weaponType).toBe('bow');
    expect(buyItem(p, 'smith', bow.uid)).toBe(true);
    let q = loadSlot(2);
    expect(q?.bag.map(i => i.uid)).toEqual([bow.uid]);
    expect(q?.gold).toBe(p.gold);

    expect(equipItem(p, bow.uid)).toBe(true);
    expect(loadSlot(2)?.equip.weapon?.uid).toBe(bow.uid);

    expect(upgradeItem(p, bow.uid)).toBe(true);
    q = loadSlot(2);
    expect(q?.equip.weapon?.plus).toBe(1);
    expect(q?.mats.part).toBe(8);

    expect(unequip(p, 'weapon')).toBe(true);
    expect(loadSlot(2)?.equip.weapon).toBeNull();

    expect(toStash(p, bow.uid)).toBe(true);
    expect(loadSlot(2)?.stash.map(i => i.uid)).toEqual([bow.uid]);
    expect(fromStash(p, bow.uid)).toBe(true);
    expect(loadSlot(2)?.bag.map(i => i.uid)).toEqual([bow.uid]);

    const gold = p.gold;
    expect(sellItem(p, bow.uid)).toBe(true);
    q = loadSlot(2);
    expect(q?.bag).toEqual([]);
    expect(q?.gold).toBeGreaterThan(gold);

    expect(buyPotion(p, 'hp', 3)).toBe(true);
    expect(loadSlot(2)?.potions.hp).toBe(p.potions.hp);
  });

  it('does not write a character that is not the current G.player (e.g. during newGame setup)', () => {
    const other = makePlayer('pyro', 'magic', '路人');
    G.player = makePlayer('warrior', 'magic', '当前');
    G.slot = 3;
    const staff: Item = {
      uid: 'review-staff', slot: 'weapon', rarity: 0, affixes: [{ k: 'atk', n: '攻击', v: 3 }], lv: 1, name: '测试法杖',
      value: 30, plus: 0, sprite: 'weapon_green_magic_staff', weaponType: 'staff',
    };
    other.bag.push(staff);
    expect(equipItem(other, staff.uid)).toBe(true);
    expect(ls.getItem(slotKey(3))).toBeNull();
  });
});

describe('review: shop shelves belong to one character', () => {
  it('newGame and continueGame drop the previous character shelves', () => {
    G.player = makePlayer('ranger', 'magic', '甲');
    levelTo(G.player, 30);
    rollShop('smith', 30);
    rollShop('potion', 30);
    expect(Object.keys(G.shops).sort()).toEqual(['potion', 'smith']);
    newGame('pyro', 'magic', '乙', 0);
    expect(G.shops).toEqual({});

    const saved = makePlayer('cryo', 'magic', '丙');
    expect(writeSlot(1, saved)).toBe(true);
    rollShop('smith', G.player?.lv ?? 1);
    expect(G.shops.smith?.length).toBeGreaterThan(0);
    expect(continueGame(1)).toBe(true);
    expect(G.player?.name).toBe('丙');
    expect(G.shops).toEqual({});
  });
});

describe('review: potion purchase count validation', () => {
  it('a NaN count buys one potion instead of turning gold / potions into NaN', () => {
    const p = makePlayer('warrior', 'magic', '药');
    p.gold = 500;
    const hp0 = p.potions.hp;
    expect(buyPotion(p, 'hp', Number.NaN)).toBe(true);
    expect(Number.isFinite(p.gold)).toBe(true);
    expect(p.potions.hp).toBe(hp0 + 1);
    expect(p.gold).toBe(500 - 42);
    // 其余数量照旧夹到 1..上限
    p.gold = 1e6;
    expect(buyPotion(p, 'mp', Number.POSITIVE_INFINITY)).toBe(true);
    expect(p.potions.mp).toBe(99);
    expect(buyPotion(p, 'hp', -5)).toBe(true);
    expect(p.potions.hp).toBe(hp0 + 2);
    expect(Number.isFinite(p.gold)).toBe(true);
  });
});
