// UI 分区审查修复的回归测试（node 环境，无 DOM：只测纯函数与“无 DOM 时的状态维护”）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/sfx', () => ({
  initAudio: vi.fn(),
  playSfx: vi.fn(),
  setMusic: vi.fn(),
  setVolume: vi.fn(),
  getVolume: () => ({ master: 0.8, music: 0.6, sfx: 0.8 }),
  handleAudioEvents: vi.fn(),
}));
vi.mock('../src/game/save', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/game/save')>()),
  saveGame: vi.fn(),
  listSlots: () => [null, null, null, null],
  hasLegacy: () => false,
}));

import { MAX_PLUS, plusMul } from '../src/game/items';
import { saveGame } from '../src/game/save';
import { G } from '../src/game/state';
import type { Item, Player, PlayerStats } from '../src/game/types';
import { deathInfoHtml } from '../src/ui/dead';
import { playerDie } from '../src/game/combat';
import { isBackdropClick } from '../src/ui/dom';
import { closePanel, openPanel, toTitle } from '../src/ui/index';
import { charPanel } from '../src/ui/panels/char';
import { helpPanel } from '../src/ui/panels/help';
import { potionShopPanel, smithPanel } from '../src/ui/panels/shop';
import { ui } from '../src/ui/shared';
import { affixLine, compareItems, itemTipHtml, sumAffixes } from '../src/ui/text';

function fakePlayer(over: Partial<Player> = {}): Player {
  const stat: PlayerStats = {
    atk: 20, armor: 10, maxHp: 200, maxMp: 100, spd: 1.5, crit: 0.05, cdr: 0, range: 56, atkCd: 0.5, weapon: 'sword',
    element: 'physical', mpRegen: 8, hpRegen: 2, skillDmg: 1.15, elemDur: 1, elemPen: 0, pen: 0, pierce: 0, chain: 2,
    shield: 1, knock: 1, lifesteal: 0, mpOnHit: 0, burn: 0, freeze: 0, shock: 0, poison: 0, slow: 0, stealth: 0, eff: {},
  };
  return {
    id: 1, team: 'player', x: 100, y: 100, r: 11, hp: 150, maxHp: 200, facing: 1, aim: 0, vx: 0, vy: 0, kx: 0, ky: 0,
    status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
    name: '测试', cid: 'warrior', route: 'magic', mp: 50, lv: 5, exp: 10, expNext: 100, sp: 3, tp: 2,
    stats: { str: 1, agi: 1, int: 1, vit: 1 }, tree: {}, routeTree: { magic: 0, tech: 0 }, ultList: [], ult: null,
    gold: 500, kills: 3, bossKills: 0, deaths: 1, playTime: 3600, bestFloor: 2, fragments: [0], fusedFrom: null,
    equip: { weapon: null, armor: null, trinket: null }, bag: [], stash: [], potions: { hp: 2, mp: 1 },
    mats: { gem: 99, part: 99, essence: 99 }, cd: { q: 0, e: 0, r: 0, ult: 0, dash: 0, atk: 0 },
    buffs: { shield: 0, shieldT: 0, roar: 0, stealth: 0, field: 0, overload: 0 }, invuln: 0, hurtT: 10, actT: 10,
    arenaWins: 0, streak: 0, bestStreak: 0, stat, dashT: 0, dashVx: 0, dashVy: 0,
    ...over,
  };
}

function fakeItem(over: Partial<Item> = {}): Item {
  return {
    uid: 'u1', slot: 'weapon', rarity: 2, affixes: [{ k: 'atk', n: '攻击', v: 10 }], lv: 5, name: '测试剑', value: 100,
    plus: 0, sprite: 'weapon_knight_sword', weaponType: 'sword', ...over,
  };
}

const el = {} as HTMLElement;

beforeEach(() => {
  closePanel();
  G.mode = 'title';
  G.player = null;
  G.panel = null;
  G.shops = {};
  G.npcs = [];
  vi.mocked(saveGame).mockClear();
});

/* ------------------------------------------------------------------ */
describe('面板交易补存档（买卖/强化/仓库/加点/融合只改内存，面板打开时自动存档停走）', () => {
  it('游戏中关闭面板时存档一次；标题界面关面板、没开面板时不存档', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    openPanel('shop_smith');
    expect(saveGame).not.toHaveBeenCalled();
    closePanel();
    expect(saveGame).toHaveBeenCalledTimes(1);
    closePanel(); // 没有打开的面板：不重复写盘
    expect(saveGame).toHaveBeenCalledTimes(1);

    G.mode = 'title';
    G.player = null;
    openPanel('help');
    closePanel();
    expect(saveGame).toHaveBeenCalledTimes(1);
  });

  it('删除存档后 toTitle(false) 不会因为关面板把存档写回去；toTitle(true) 只存一次', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    openPanel('help');
    toTitle(false);
    expect(saveGame).not.toHaveBeenCalled();
    expect(G.mode).toBe('title');
    expect(G.player).toBeNull();
    expect(G.panel).toBeNull();

    G.mode = 'play';
    G.player = fakePlayer();
    openPanel('help');
    toTitle(true);
    expect(saveGame).toHaveBeenCalledTimes(1);
  });

  it('返回标题清空商店货架（换角色后不能看到上一个角色职业的武器与等级）', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    G.shops = { smith: [fakeItem({ uid: 's1', cost: 200 })], potion: [] };
    toTitle(true);
    expect(G.shops).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
describe('点遮罩关闭：按下与松开都在遮罩上才关', () => {
  it('isBackdropClick', () => {
    const overlay = {} as EventTarget, btn = {} as EventTarget;
    expect(isBackdropClick(overlay, overlay, overlay, overlay)).toBe(true);
    // 在面板按钮上按下、拖到遮罩上松开：click 派发给共同祖先（遮罩），不应关闭
    expect(isBackdropClick(btn, overlay, overlay, overlay)).toBe(false);
    // 在遮罩按下、拖进面板松开
    expect(isBackdropClick(overlay, btn, overlay, overlay)).toBe(false);
    expect(isBackdropClick(null, null, overlay, overlay)).toBe(false);
    expect(isBackdropClick(overlay, overlay, btn, overlay)).toBe(false);
    expect(isBackdropClick(overlay, overlay, overlay, null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
describe('物品词条显示与对比含强化加成（与 recalc / powerOf 一致）', () => {
  it('提示框与角色面板显示强化后的实际数值', () => {
    const it5 = fakeItem({ plus: 5, affixes: [{ k: 'atk', n: '攻击', v: 10 }, { k: 'crit', n: '暴击', v: 0.05 }] });
    const atk = Math.round(10 * plusMul(5));
    expect(affixLine(it5.affixes[0], 5)).toBe(`+${atk} 攻击`);
    expect(affixLine(it5.affixes[0])).toBe('+10 攻击'); // 不传强化等级时保持原值
    expect(affixLine(it5.affixes[1], 5)).toBe(`+${Math.round(0.05 * plusMul(5) * 1000) / 10}% 暴击`);
    expect(itemTipHtml(it5, null)).toContain(`+${atk} 攻击`);
    const p = fakePlayer({ equip: { weapon: it5, armor: null, trinket: null } });
    expect(charPanel.body({ p })).toContain(`+${atk} 攻击`);
  });

  it('对比当前装备时按实际数值算差值（高强化的旧装备不会被误判为更差）', () => {
    const cur = fakeItem({ uid: 'cur', plus: 10, affixes: [{ k: 'atk', n: '攻击', v: 20 }] }); // 实际 20×1.8 = 36
    const loot = fakeItem({ uid: 'new', plus: 0, affixes: [{ k: 'atk', n: '攻击', v: 30 }] });
    expect(sumAffixes(cur).atk).toBeCloseTo(20 * plusMul(10), 5);
    const d = compareItems(loot, cur).find(x => x.k === 'atk')?.d ?? 0;
    expect(d).toBeCloseTo(30 - 20 * plusMul(10), 5);
    expect(d).toBeLessThan(0);
    const p = fakePlayer({ equip: { weapon: cur, armor: null, trinket: null }, bag: [loot] });
    const html = itemTipHtml(loot, p, { compare: true });
    expect(html).toContain('-6 攻击');
    expect(html).not.toContain('+10 攻击');
  });
});

/* ------------------------------------------------------------------ */
describe('铁匠铺强化页：已达上限', () => {
  it('满级装备显示“已达强化上限”，强化按钮禁用，不显示 +10 → +11', () => {
    const maxed = fakeItem({ uid: 'mx', plus: MAX_PLUS });
    const p = fakePlayer({ gold: 99999, equip: { weapon: maxed, armor: null, trinket: null } });
    G.mode = 'play';
    G.player = p;
    smithPanel.onOpen?.({ p });
    smithPanel.action?.('tab', 'forge', { p }, el);
    smithPanel.action?.('sel', 'mx', { p }, el);
    const html = smithPanel.body({ p });
    expect(html).toContain('已达强化上限');
    expect(html).not.toContain(`+${MAX_PLUS + 1}`);
    expect(html).toMatch(/data-act="forge" data-v="mx" disabled/);
    // 未满级仍可强化
    const low = fakeItem({ uid: 'lo', plus: 1 });
    p.equip.weapon = low;
    smithPanel.action?.('sel', 'lo', { p }, el);
    const html2 = smithPanel.body({ p });
    expect(html2).toContain('+2');
    expect(html2).toMatch(/data-act="forge" data-v="lo"(?! disabled)/);
  });
});

/* ------------------------------------------------------------------ */
describe('药剂铺标题：迷宫补给房的流浪药剂商不再显示成主城的“苏芽”', () => {
  it('取最近的药剂商 NPC 名字，没有时兜底', () => {
    G.player = fakePlayer({ x: 100, y: 100 });
    G.npcs = [
      { id: 1, role: 'potion', name: '药剂商 · 苏芽', x: 3000, y: 3000, r: 10, sprite: 'elf_f', facing: 1 },
      { id: 2, role: 'potion', name: '流浪药剂商 · 苔', x: 130, y: 100, r: 10, sprite: 'elf_m', facing: 1 },
      { id: 3, role: 'smith', name: '铁匠', x: 100, y: 100, r: 10, sprite: 'dwarf_m', facing: 1 },
    ];
    expect(potionShopPanel.title({ p: G.player })).toBe('流浪药剂商 · 苔');
    G.npcs = [];
    expect(potionShopPanel.title({ p: G.player })).toBe('药剂铺');
  });
});

/* ------------------------------------------------------------------ */
describe('死亡页显示的金币损失 = combat.playerDie 死亡瞬间实际扣除的数额', () => {
  it('gold=15 死亡时扣 2（floor(15×0.9)=13），死亡页显示 2、存档里的金币已是 13（刷新无法绕过）', () => {
    const lost = (g: number): number => g - Math.floor(g * 0.9);
    for (const g of [15, 1, 999, 1000]) {
      const p = fakePlayer({ gold: g });
      G.player = p;
      G.mode = 'play';
      G.scene = 'dungeon';
      p.dead = false;
      playerDie();
      expect(p.gold).toBe(g - lost(g));
      expect(deathInfoHtml(p, '遗迹')).toContain(`<b class="down">${lost(g)}</b>`);
      G.mode = 'play';
    }
  });
});

/* ------------------------------------------------------------------ */
describe('帮助面板：全屏', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('浏览器没有 Fullscreen API（iPhone Safari）时提示不支持，而不是抛 “is not a function”', () => {
    vi.stubGlobal('document', { fullscreenElement: null, documentElement: {} });
    const toast = vi.spyOn(ui, 'toast');
    expect(() => helpPanel.action?.('fullscreen', '', { p: null }, el)).not.toThrow();
    expect(toast).toHaveBeenCalledWith('当前浏览器不支持全屏', expect.any(String));
  });

  it('支持时调用 requestFullscreen 并在完成后重绘（返回值不是 Promise 也可以）', async () => {
    const req = vi.fn(() => undefined);
    vi.stubGlobal('document', { fullscreenElement: null, documentElement: { requestFullscreen: req } });
    const rerender = vi.spyOn(ui, 'rerender');
    helpPanel.action?.('fullscreen', '', { p: null }, el);
    expect(req).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(rerender).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
describe('角色面板属性说明与 recalc 一致', () => {
  it('力量只加攻击（生命来自体质）', () => {
    const html = charPanel.body({ p: fakePlayer() });
    expect(html).toContain('<b>力量</b><span class="dim grow">攻击</span>');
    expect(html).toContain('<b>体质</b><span class="dim grow">生命 / 护甲</span>');
  });
});

/* ------------------------------------------------------------------ */
describe('大地图标签避让（QA：传送阵名字挤成一串、NPC 与传送阵标签重叠）', () => {
  it('同一行上相邻的标签会被上下错开，互不重叠；NPC 只显示「·」后的名字', async () => {
    const { layoutLabels } = await import('../src/ui/panels/map');
    const labels = ['遗迹迷宫', '熔核裂隙', '霜寂深渊', '幽影墓穴'].map((t, i) => ({ x: 40 + i * 5, y: 30, text: t, color: '#fff' }));
    labels.push({ x: 50, y: 30, text: '秘境向导 · 灰鸦', color: '#fff', cls: 'npc' } as never);
    const out = layoutLabels(labels, 2);
    const boxes = out.map(o => {
      const w = [...o.text].length * 12 + 4;
      return { x0: o.x - w / 2, x1: o.x + w / 2, y0: o.y - 14, y1: o.y };
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
    }
    expect(out.find(o => o.l.cls === 'npc')?.text).toBe('灰鸦');
  });
});
