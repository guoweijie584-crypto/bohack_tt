// UI 层测试（node 环境：项目未安装 jsdom，按约定只测纯函数与“无 DOM 时的状态维护”）。
// - esc 转义生效（存档槽、物品提示、角色面板、对话、死亡页、toast/横幅）；
// - 面板开关维护 G.panel（openPanel/closePanel/togglePanel/onHotkey/handleUiEvents）；
// - 小地图首领提示纯函数（已知/未知分支、边缘箭头位置、首领“已发现”记忆）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/sfx', () => ({
  initAudio: vi.fn(),
  playSfx: vi.fn(),
  setMusic: vi.fn(),
  setVolume: vi.fn(),
  getVolume: () => ({ master: 0.8, music: 0.6, sfx: 0.8 }),
  handleAudioEvents: vi.fn(),
}));
vi.mock('../src/game/player', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/game/player')>()),
  passiveOf: (cid: string) => ({ name: `被动-${cid}`, desc: '描述' }),
  skillsOf: () => [],
  fuseOptions: () => [],
}));
vi.mock('../src/game/items', async importOriginal => {
  const orig = await importOriginal<typeof import('../src/game/items')>();
  return {
    ...orig,
    affixText: (a: { n: string; v: number }) => `${a.n} +${a.v}`,
    itemPower: (it: { lv: number }) => it.lv * 10,
    bagHasRoom: (p: { bag: unknown[] }) => p.bag.length < 24,
    addToBag: (p: { bag: unknown[] }, it: unknown) => { p.bag.push(it); return true; },
    rollItem: (lv: number, o: { rarity?: number } = {}) => ({
      uid: 'roll1', slot: 'armor', rarity: o.rarity ?? 0, affixes: [], lv, name: '祭坛之铠', value: 50, plus: 0, sprite: 'armor_plate_2',
    }),
    findItem: () => null,
  };
});
vi.mock('../src/game/world', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/game/world')>()),
  resolveAltar: vi.fn(() => true),
}));
vi.mock('../src/game/save', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/game/save')>()),
  saveGame: vi.fn(),
  listSlots: () => [null, null, null, null],
  hasLegacy: () => false,
}));

import { esc } from '../src/core/util';
import { G } from '../src/game/state';
import type { FxEvent, Item, Player, PlayerStats } from '../src/game/types';
import { GridMap } from '../src/world/grid';
import { T } from '../src/data/tiles';
import { TILE } from '../src/config';
import { closePanel, handleUiEvents, onHotkey, openPanel, togglePanel, updateUI } from '../src/ui/index';
import { BOSS_UNKNOWN_TEXT, bossDiscovered, bossHint, dir8, edgePoint, resetBossMemory } from '../src/ui/minimap';
import { slotCardHtml, sanitizeName } from '../src/ui/title';
import { itemTipHtml, compareItems, fmtAffixVal, fmtTime } from '../src/ui/text';
import { bannerHtml, toastHtml } from '../src/ui/feedback';
import { cssColor } from '../src/ui/shared';
import { charPanel } from '../src/ui/panels/char';
import { altarHtml, dialogPanel } from '../src/ui/panels/dialog';
import { deathInfoHtml } from '../src/ui/dead';
import { PANELS } from '../src/ui/panels/index';
import { trialHtml } from '../src/ui/hud';
import { muteToasts, quiet } from '../src/ui/shared';
import { resolveAltar } from '../src/game/world';
import { LORE } from '../src/data/lore';

const XSS = '<img src=x onerror=alert(1)>';

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
    mats: { gem: 1, part: 2, essence: 3 }, cd: { q: 0, e: 0, r: 0, ult: 0, dash: 0, atk: 0 },
    buffs: { shield: 0, shieldT: 0, roar: 0, stealth: 0, field: 0, overload: 0 }, invuln: 0, hurtT: 10, actT: 10,
    arenaWins: 0, streak: 0, bestStreak: 0, stat, dashT: 0, dashVx: 0, dashVy: 0,
    ...over,
  };
}

function fakeItem(over: Partial<Item> = {}): Item {
  return {
    uid: 'u1', slot: 'weapon', rarity: 2, affixes: [{ k: 'atk', n: '攻击', v: 12 }], lv: 5, name: '测试剑', value: 100,
    plus: 0, sprite: 'weapon_knight_sword', weaponType: 'sword', ...over,
  };
}

beforeEach(() => {
  closePanel();
  G.mode = 'title';
  G.player = null;
  G.panel = null;
  G.npcs = [];
  G.boss = null;
  G.autoAttack = false;
  G.input.attack = false;
  G.input.pressed.clear();
  G.seed = 1;
  G.dungeonId = 'ruins';
  G.floor = 1;
  G.scene = 'city';
});

/* ------------------------------------------------------------------ */
describe('esc 转义（修 legacy XSS）', () => {
  it('core/util esc 转义 HTML 特殊字符', () => {
    expect(esc('<a href="x">\'&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
  });

  it('存档槽卡片转义角色名', () => {
    const html = slotCardHtml(0, { slot: 0, name: XSS, cid: 'warrior', lv: 3, bestFloor: 2, playTime: 90, updatedAt: Date.now() });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(slotCardHtml(1, null)).toContain('新建角色');
  });

  it('物品提示框转义名字与词条，并显示与当前装备的差值', () => {
    const p = fakePlayer({ equip: { weapon: fakeItem({ uid: 'old', name: '旧剑', affixes: [{ k: 'atk', n: '攻击', v: 5 }] }), armor: null, trinket: null } });
    const it = fakeItem({ name: '<script>alert(1)</script>', affixes: [{ k: 'atk', n: '<b>攻击</b>', v: 12 }, { k: 'crit', n: '暴击', v: 0.02 }] });
    const html = itemTipHtml(it, p, { compare: true, price: 120 });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;攻击&lt;/b&gt;');
    expect(html).toContain('+7 攻击');
    expect(html).toContain('+2.0% 暴击');
    expect(html).toContain('120 金币');
  });

  it('角色面板转义玩家名', () => {
    const p = fakePlayer({ name: XSS });
    const html = charPanel.body({ p });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain(XSS);
    expect(html).toContain('被动-warrior');
  });

  it('对话面板转义 NPC 名字与台词', () => {
    G.player = fakePlayer();
    G.npcs = [{ id: 7, role: 'villager', name: '<b>村民</b>', line: XSS, x: 0, y: 0, r: 10, sprite: 'elf_m', facing: 1 }];
    const html = dialogPanel.body({ p: G.player, arg: '7' });
    expect(html).toContain('&lt;b&gt;村民&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain(XSS);
    expect(dialogPanel.title({ p: G.player, arg: '7' })).toBe('<b>村民</b>'); // 标题以 textContent 写入，不经 innerHTML
  });

  it('死亡页、toast、横幅转义文本并过滤颜色', () => {
    expect(deathInfoHtml(fakePlayer({ name: XSS }), '<i>地牢</i>')).not.toContain('<img');
    const t = toastHtml(XSS, 'red;background:url(javascript:alert(1))');
    expect(t).toContain('&lt;img');
    expect(t).not.toContain('javascript');
    expect(bannerHtml('<u>首领</u>', XSS)).not.toContain('<u>');
    expect(cssColor('#ff00aa')).toBe('#ff00aa');
    expect(cssColor('rgba(1,2,3,.5)')).toBe('rgba(1,2,3,.5)');
    expect(cssColor('red;x:y', '#123456')).toBe('#123456');
    expect(cssColor(undefined, '#123456')).toBe('#123456');
  });

  it('角色名清洗：去控制字符、首尾空白，最多 12 字', () => {
    expect(sanitizeName('  阿\u0000禾\u200b  ')).toBe('阿禾');
    expect(Array.from(sanitizeName('一二三四五六七八九十十一十二')).length).toBe(12);
  });
});

/* ------------------------------------------------------------------ */
describe('面板开关维护 G.panel', () => {
  it('open / close / toggle', () => {
    openPanel('help');
    expect(G.panel).toBe('help');
    closePanel();
    expect(G.panel).toBeNull();
    togglePanel('lore');
    expect(G.panel).toBe('lore');
    togglePanel('lore');
    expect(G.panel).toBeNull();
  });

  it('无角色时只允许日志/帮助', () => {
    openPanel('char');
    expect(G.panel).toBeNull();
    onHotkey('bag');
    expect(G.panel).toBeNull();
    onHotkey('lore');
    expect(G.panel).toBe('lore');
  });

  it('有角色时可切换面板，并清掉按住的攻击与未消费动作', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    G.input.attack = true;
    G.input.pressed.add('q');
    openPanel('bag');
    expect(G.panel).toBe('bag');
    expect(G.input.attack).toBe(false);
    expect(G.input.pressed.size).toBe(0);
    openPanel('skill');
    expect(G.panel).toBe('skill');
    onHotkey('char');
    expect(G.panel).toBe('char');
    onHotkey('char');
    expect(G.panel).toBeNull();
  });

  it('Esc：有面板关面板，否则打开帮助（暂停）', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    openPanel('map');
    onHotkey('escape');
    expect(G.panel).toBeNull();
    onHotkey('escape');
    expect(G.panel).toBe('help');
    onHotkey('escape');
    expect(G.panel).toBeNull();
  });

  it('死亡时不能打开游戏面板', () => {
    G.mode = 'dead';
    G.player = fakePlayer();
    onHotkey('bag');
    expect(G.panel).toBeNull();
  });

  it('T 切换自动攻击（无角色时忽略）', () => {
    onHotkey('autoAttack');
    expect(G.autoAttack).toBe(false);
    G.mode = 'play';
    G.player = fakePlayer();
    onHotkey('autoAttack');
    expect(G.autoAttack).toBe(true);
    onHotkey('autoAttack');
    expect(G.autoAttack).toBe(false);
  });

  it('handleUiEvents 处理 openPanel 事件（NPC 交互）', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    const evs: FxEvent[] = [{ t: 'toast', text: 'x' }, { t: 'openPanel', panel: 'shop_smith', arg: '3' }];
    handleUiEvents(evs);
    expect(G.panel).toBe('shop_smith');
    expect(evs.length).toBe(2); // 不清空数组
    handleUiEvents([{ t: 'ui', what: 'dead' }]);
    expect(G.panel).toBeNull();
  });

  it('所有 PanelName 都有面板定义', () => {
    const names = ['char', 'bag', 'skill', 'fuse', 'map', 'lore', 'help', 'shop_potion', 'shop_smith', 'stash', 'portal', 'route', 'arena', 'secret', 'dialog'] as const;
    for (const n of names) expect(typeof PANELS[n].body).toBe('function');
  });
});

/* ------------------------------------------------------------------ */
describe('小地图首领提示（迷雾门控，改版意见 #19）', () => {
  const mk = (): GridMap => {
    const m = new GridMap(20, 20, 'dungeon', T.FLOOR);
    m.fog = true;
    return m;
  };
  const C = (t: number): number => t * TILE + TILE / 2;

  it('首领在未探索区域：只给方向与提示文字', () => {
    const m = mk();
    const boss = { x: C(15), y: C(15), dead: false };
    const h = bossHint(m, boss, C(2), C(2));
    expect(h.state).toBe('unknown');
    expect(h.text).toBe(BOSS_UNKNOWN_TEXT);
    expect(h.angle).toBeCloseTo(Math.PI / 4, 5);
    expect(h.dir).toBe('东南');
    expect(h.visible).toBe(false);
  });

  it('首领所在格已探索：已知，可画脉冲', () => {
    const m = mk();
    m.explored[m.idx(15, 15)] = 1;
    const h = bossHint(m, { x: C(15), y: C(15), dead: false }, C(15), C(2));
    expect(h.state).toBe('known');
    expect(h.visible).toBe(false);
    expect(h.text).toContain('南');
    expect(h.distTiles).toBe(13);
    m.visible[m.idx(15, 15)] = 1;
    expect(bossHint(m, { x: C(15), y: C(15), dead: false }, C(15), C(2)).visible).toBe(true);
  });

  it('无首领/首领死亡/无迷雾地图', () => {
    const m = mk();
    expect(bossHint(m, null, 0, 0).state).toBe('none');
    expect(bossHint(m, { x: 0, y: 0, dead: true }, 0, 0).state).toBe('none');
    m.fog = false;
    expect(bossHint(m, { x: C(15), y: C(15), dead: false }, C(1), C(1)).state).toBe('known');
  });

  it('八方位', () => {
    expect(dir8(0)).toBe('东');
    expect(dir8(Math.PI / 2)).toBe('南');
    expect(dir8(-Math.PI / 2)).toBe('北');
    expect(dir8(Math.PI)).toBe('西');
    expect(dir8(-Math.PI * 3 / 4)).toBe('西北');
  });

  it('边缘箭头落在内缩边框上', () => {
    expect(edgePoint(44, 32, 0, 88, 64, 3)).toEqual({ x: 84, y: 32 });
    expect(edgePoint(44, 32, Math.PI / 2, 88, 64, 3)).toEqual({ x: 44, y: 60 });
    expect(edgePoint(44, 32, Math.PI, 88, 64, 3)).toEqual({ x: 3, y: 32 });
    const p = edgePoint(10, 10, -Math.PI / 4, 88, 64, 3);
    expect(p.y).toBe(3);
    expect(p.x).toBe(17);
    // 起点在框外也会被夹回
    const q = edgePoint(-50, 200, 0, 88, 64, 3);
    expect(q).toEqual({ x: 84, y: 60 });
  });

  it('首领血条：见过一次后记住；换图重置', () => {
    resetBossMemory();
    const m = mk();
    const boss = { id: 42, x: C(15), y: C(15), dead: false, aggro: false };
    expect(bossDiscovered(bossHint(m, boss, C(1), C(1)), boss)).toBe(false);
    m.visible[m.idx(15, 15)] = 1;
    m.explored[m.idx(15, 15)] = 1;
    expect(bossDiscovered(bossHint(m, boss, C(1), C(1)), boss)).toBe(true);
    m.visible[m.idx(15, 15)] = 0;
    expect(bossDiscovered(bossHint(m, boss, C(1), C(1)), boss)).toBe(true);
    resetBossMemory();
    expect(bossDiscovered(bossHint(m, boss, C(1), C(1)), boss)).toBe(false);
    // 进入战斗且距离不远也显示
    const near = { ...boss, aggro: true };
    expect(bossDiscovered(bossHint(m, near, C(10), C(10)), near)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('事件祭坛与秘境试炼', () => {
  it('祭坛二选一显示 LORE 文本，选择后交给 world.resolveAltar 结算并关闭面板', () => {
    G.mode = 'play';
    G.player = fakePlayer();
    openPanel('dialog', 'event');
    expect(G.panel).toBe('dialog');
    const html = dialogPanel.body({ p: G.player, arg: 'event' });
    for (const c of LORE.altar.choices) expect(html).toContain(c.n);
    expect(html).toContain('data-act="altar" data-v="0"');
    expect(dialogPanel.title({ p: G.player, arg: 'event' })).toBe(LORE.altar.title);
    // 宿主未挂载时 ui.closePanel 是空实现：这里只验证结算函数被正确调用
    dialogPanel.action?.('altar', '1', { p: G.player, arg: 'event' }, {} as HTMLElement);
    expect(vi.mocked(resolveAltar)).toHaveBeenCalledWith(1);
    dialogPanel.action?.('altar', '0', { p: G.player, arg: 'event' }, {} as HTMLElement);
    expect(vi.mocked(resolveAltar)).toHaveBeenLastCalledWith(0);
    expect(altarHtml()).not.toContain('<script');
  });

  it('秘境试炼条转义并显示进度/倒计时/结果', () => {
    const html = trialHtml({ id: 'hunt', name: '<i>限时</i>', desc: XSS, goal: 30, progress: 12, timeLeft: 75, state: 'run' });
    expect(html).toContain('&lt;i&gt;限时&lt;/i&gt;');
    expect(html).not.toContain(XSS);
    expect(html).toContain('12/30');
    expect(html).toContain('1:15');
    expect(trialHtml({ id: 'elite', name: 'x', desc: '', goal: 3, progress: 3, timeLeft: 0, state: 'won' })).toContain('完成');
  });
});

/* ------------------------------------------------------------------ */
describe('动作包装', () => {
  it('quiet：返回值与异常兜底', () => {
    expect(quiet(() => true)).toBe(true);
    expect(quiet(() => undefined)).toBe(true);
    expect(quiet(() => false)).toBe(false);
    expect(quiet(() => { throw new Error('boom'); })).toBe(false);
  });

  it('muteToasts：批量操作只丢弃 toast、合并重复音效，保留其它事件', () => {
    G.events.length = 0;
    G.events.push({ t: 'shake', amt: 1 });
    const r = muteToasts(() => {
      G.events.push({ t: 'toast', text: 'a' }, { t: 'sfx', name: 'pickupCoin' }, { t: 'toast', text: 'b' }, { t: 'sfx', name: 'pickupCoin' }, { t: 'ui', what: 'hud' });
      return 7;
    });
    expect(r).toBe(7);
    expect(G.events.map(e => e.t)).toEqual(['shake', 'sfx', 'ui']);
    G.events.length = 0;
  });
});

/* ------------------------------------------------------------------ */
describe('格式化', () => {
  it('词条差值与数值格式', () => {
    const a = fakeItem({ affixes: [{ k: 'atk', n: '攻击', v: 10 }, { k: 'spd', n: '移速', v: 0.05 }] });
    const b = fakeItem({ uid: 'b', affixes: [{ k: 'atk', n: '攻击', v: 4 }, { k: 'hp', n: '生命', v: 20 }] });
    const d = compareItems(a, b);
    expect(d.find(x => x.k === 'atk')?.d).toBe(6);
    expect(d.find(x => x.k === 'hp')?.d).toBe(-20);
    expect(d.find(x => x.k === 'spd')?.d).toBeCloseTo(0.05, 5);
    expect(fmtAffixVal('crit', 0.034)).toBe('+3.4%');
    expect(fmtAffixVal('armor', -2.4)).toBe('-2');
    expect(fmtTime(3725)).toBe('1 时 02 分');
    expect(fmtTime(75)).toBe('1 分 15 秒');
  });
});
