// 音频模块测试：
// 1) Node（无 AudioContext）下所有导出函数安全空操作；
// 2) 最小假 Web Audio（参数非有限值 / 指数斜坡到 0 / 重复 start / 先 stop 后 start 都会像真 API 一样抛错）上：
//    每个 SfxName 都能发声、限速、复音上限、事件推导与合并、声像衰减、音乐调度与交叉淡化、音量持久化、自动播放策略。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementId } from '../src/data/types';
import type { FxEvent, SfxName } from '../src/game/types';
import {
  DEFAULT_VOLUME, MUSIC_FADE, MUSIC_TRACKS, SFX_NAMES, audioStatus, getMusic, getVolume, handleAudioEvents, initAudio,
  musicStats, playHit, playSfx, pumpMusic, resetAudio, setMusic, setVolume, sfxStats, spatialize, tapSfx,
} from '../src/audio/sfx';
import { TRACKS, resolveTrack } from '../src/audio/music';
import { SFX_META } from '../src/audio/recipes';

// —— 全部音效名（Record 保证与 SfxName 联合类型一一对应） ——
const ALL: Record<SfxName, true> = {
  swing: true, swingHeavy: true, stab: true, bow: true, cast: true, fire: true, ice: true, zap: true, poison: true,
  arcane: true, tech: true, hit: true, crit: true, hurt: true, kill: true, bossRoar: true, explosion: true, dash: true,
  pickupCoin: true, pickupExp: true, pickupItem: true, potion: true, levelup: true, chest: true, portal: true, door: true,
  ui: true, uiDeny: true, buy: true, forge: true, shield: true, stealth: true, summon: true, death: true, victory: true,
  step: true,
};
const ELEMENTS: ElementId[] = ['physical', 'fire', 'ice', 'lightning', 'poison', 'arcane', 'tech'];

// ———————————————————————————— 假 Web Audio ————————————————————————————

function finite(x: number, what: string): void {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${what}: 非有限值 ${String(x)}`);
}

class FakeParam {
  private v: number;
  readonly log: Array<[string, number, number]> = [];
  constructor(v: number) {
    this.v = v;
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    finite(x, 'value');
    this.v = x;
  }
  setValueAtTime(x: number, t: number): this {
    finite(x, 'setValueAtTime');
    finite(t, 'setValueAtTime.t');
    if (t < 0) throw new RangeError('时间为负');
    this.log.push(['set', x, t]);
    this.v = x;
    return this;
  }
  linearRampToValueAtTime(x: number, t: number): this {
    finite(x, 'linearRamp');
    finite(t, 'linearRamp.t');
    this.log.push(['lin', x, t]);
    return this;
  }
  exponentialRampToValueAtTime(x: number, t: number): this {
    finite(x, 'expRamp');
    finite(t, 'expRamp.t');
    if (x === 0) throw new RangeError('exponentialRamp 端点不能为 0');
    this.log.push(['exp', x, t]);
    return this;
  }
  setTargetAtTime(x: number, t: number, c: number): this {
    finite(x, 'setTarget');
    finite(t, 'setTarget.t');
    finite(c, 'setTarget.c');
    this.log.push(['target', x, t]);
    return this;
  }
  cancelScheduledValues(t: number): this {
    finite(t, 'cancel.t');
    return this;
  }
}

class FakeNode {
  readonly ctx: FakeCtx;
  readonly outs: unknown[] = [];
  disconnected = false;
  constructor(ctx: FakeCtx) {
    this.ctx = ctx;
    ctx.created.push(this);
  }
  connect<T>(d: T): T {
    if (d === undefined || d === null) throw new TypeError('connect 目标为空');
    this.outs.push(d);
    return d;
  }
  disconnect(): void {
    this.outs.length = 0;
    this.disconnected = true;
  }
}
class FakeSource extends FakeNode {
  startAt = -1;
  stopAt = -1;
  onended: (() => void) | null = null;
  start(t = 0, offset = 0): void {
    if (this.startAt >= 0) throw new Error('InvalidStateError: start 调用两次');
    finite(t, 'start');
    finite(offset, 'start.offset');
    if (t < 0 || offset < 0) throw new RangeError('start 参数为负');
    this.startAt = t;
    this.ctx.started.push(this);
  }
  stop(t = 0): void {
    if (this.startAt < 0) throw new Error('InvalidStateError: stop 早于 start');
    finite(t, 'stop');
    if (t < 0) throw new RangeError('stop 为负');
    this.stopAt = t;
  }
}
class FakeOsc extends FakeSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
}
class FakeBufferSource extends FakeSource {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
}
class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}
class FakeBiquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  readonly gain = new FakeParam(0);
}
class FakePanner extends FakeNode {
  readonly pan = new FakeParam(0);
}
class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam(0);
}
class FakeComp extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
}

class FakeCtx {
  static all: FakeCtx[] = [];
  currentTime = 0;
  sampleRate = 48000;
  state: 'running' | 'suspended' | 'closed' = 'running';
  readonly created: FakeNode[] = [];
  readonly started: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly panners: FakePanner[] = [];
  readonly destination: FakeNode;
  constructor() {
    this.destination = new FakeNode(this);
    FakeCtx.all.push(this);
  }
  createOscillator = vi.fn(() => new FakeOsc(this));
  createBufferSource = vi.fn(() => new FakeBufferSource(this));
  createGain = vi.fn(() => {
    const g = new FakeGain(this);
    this.gains.push(g);
    return g;
  });
  createBiquadFilter = vi.fn(() => new FakeBiquad(this));
  createStereoPanner = vi.fn(() => {
    const p = new FakePanner(this);
    this.panners.push(p);
    return p;
  });
  createDelay = vi.fn(() => new FakeDelay(this));
  createDynamicsCompressor = vi.fn(() => new FakeComp(this));
  createBuffer = vi.fn((ch: number, len: number, sr: number) => {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i: number) => data[i] };
  });
  resume = vi.fn(() => {
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  });
  suspend = vi.fn(() => {
    if (this.state !== 'closed') this.state = 'suspended';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
}

const lastCtx = (): FakeCtx => {
  const c = FakeCtx.all[FakeCtx.all.length - 1];
  if (!c) throw new Error('没有创建 AudioContext');
  return c;
};
function setup(): FakeCtx {
  vi.stubGlobal('AudioContext', FakeCtx);
  initAudio();
  return lastCtx();
}
/** 记录真正发声的音效 */
function record(): Array<{ name: SfxName; vol: number; pan: number; pitch: number; el?: ElementId }> {
  const got: Array<{ name: SfxName; vol: number; pan: number; pitch: number; el?: ElementId }> = [];
  tapSfx((name, info) => got.push({ name, ...info }));
  return got;
}

const SAMPLE_EVENTS: FxEvent[] = [
  { t: 'impact', x: 100, y: 0, el: 'fire', size: 1 },
  { t: 'explosion', x: -300, y: 40, r: 90, el: 'ice' },
  { t: 'death', x: 50, y: 50, color: '#fff', big: true, kind: 'boss_ogre' },
  { t: 'pickup', x: 0, y: 0, kind: 'gold', color: '#ff0' },
  { t: 'levelup', x: 0, y: 0 },
  { t: 'chestOpen', id: 7 },
  { t: 'sfx', name: 'swing', x: 10, y: 0 },
  { t: 'spawn', x: 400, y: 0, boss: true },
  { t: 'floater', x: 0, y: 0, text: '128', color: '#fff', size: 14, crit: true },
  { t: 'ui', what: 'dead' },
];

beforeEach(() => {
  resetAudio();
  FakeCtx.all.length = 0;
});
afterEach(() => {
  resetAudio();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ———————————————————————————— 无 AudioContext ————————————————————————————

describe('Node 环境（无 AudioContext）', () => {
  it('所有导出函数安全空操作', () => {
    expect(audioStatus()).toBe('unsupported');
    expect(() => initAudio()).not.toThrow();
    for (const n of SFX_NAMES) expect(() => playSfx(n, { vol: 0.5, pan: -1, pitch: 1.3 })).not.toThrow();
    for (const el of ELEMENTS) expect(() => playHit(el, { crit: true })).not.toThrow();
    expect(() => handleAudioEvents(SAMPLE_EVENTS, 0, 0)).not.toThrow();
    expect(() => handleAudioEvents([], Number.NaN, Number.NaN)).not.toThrow();
    for (const t of [...MUSIC_TRACKS, 'dungeon:magma', 'dungeon:unknown', 'garbage', '']) {
      expect(() => setMusic(t)).not.toThrow();
    }
    expect(() => pumpMusic()).not.toThrow();
    expect(getVolume()).toEqual(DEFAULT_VOLUME);
    expect(() => setVolume(0.5, 0.2, 0.9)).not.toThrow();
    expect(getVolume()).toEqual({ master: 0.5, music: 0.2, sfx: 0.9 });
    expect(sfxStats().played).toBe(0);
    expect(musicStats().players).toBe(0);
  });

  it('音量越界被夹到 [0,1]，非法值保留原值', () => {
    setVolume(0.4, 0.3, 0.2);
    setVolume(7, -3, Number.NaN);
    expect(getVolume()).toEqual({ master: 1, music: 0, sfx: 0.2 });
  });

  it('默认音乐音量较低（0.35）', () => {
    expect(DEFAULT_VOLUME.music).toBe(0.35);
    expect(getVolume().music).toBe(0.35);
  });

  it('SFX_NAMES 覆盖全部 SfxName，且每个都有限速配置', () => {
    expect([...SFX_NAMES].sort()).toEqual(Object.keys(ALL).sort());
    for (const n of SFX_NAMES) {
      expect(SFX_META[n].max).toBeGreaterThan(0);
      expect(SFX_META[n].jit).toBeLessThanOrEqual(0.05);
    }
    expect(SFX_META.hit.max).toBe(14);
  });
});

describe('spatialize（声像与距离衰减）', () => {
  it('水平差 ±400 → 声像 ±1，超出夹住', () => {
    expect(spatialize(400, 0, 0, 0).pan).toBe(1);
    expect(spatialize(-200, 0, 0, 0).pan).toBe(-0.5);
    expect(spatialize(800, 0, 0, 0).pan).toBe(1);
    expect(spatialize(0, 300, 0, 0).pan).toBe(0);
  });
  it('线性衰减，≥900 静音，NaN 安全', () => {
    expect(spatialize(0, 0, 0, 0).gain).toBe(1);
    expect(spatialize(0, 450, 0, 0).gain).toBeCloseTo(0.5);
    expect(spatialize(1000, 0, 0, 0)).toEqual({ gain: 0, pan: 0 });
    expect(spatialize(0, 900, 0, 0).gain).toBe(0);
    expect(spatialize(Number.NaN, 0, 0, 0)).toEqual({ gain: 0, pan: 0 });
  });
});

describe('resolveTrack', () => {
  it('规整曲目名', () => {
    expect(resolveTrack('dungeon:magma')).toBe('dungeon:magma');
    expect(resolveTrack('magma')).toBe('dungeon:magma');
    expect(resolveTrack('secret')).toBe('dungeon:secret');
    expect(resolveTrack('dungeon:volcano')).toBe('dungeon:ruins');
    expect(resolveTrack('dungeon:arena')).toBe('arena');
    expect(resolveTrack('dungeon')).toBe('dungeon:ruins');
    expect(resolveTrack('boss')).toBe('boss');
    expect(resolveTrack('')).toBe('none');
    expect(resolveTrack('nope')).toBe('none');
  });
  it('需求里的全部曲目都有定义', () => {
    for (const t of ['title', 'city', 'dungeon:ruins', 'dungeon:magma', 'dungeon:frost', 'dungeon:crypt', 'dungeon:secret', 'boss', 'arena']) {
      expect(TRACKS[t], t).toBeDefined();
      expect(MUSIC_TRACKS).toContain(t);
    }
    expect(MUSIC_TRACKS).toContain('none');
  });
});

// ———————————————————————————— 假 AudioContext ————————————————————————————

describe('音效（假 AudioContext）', () => {
  it('initAudio 建立 master/music/sfx 三路 + 压缩器，重复调用幂等', () => {
    const c = setup();
    expect(audioStatus()).toBe('running');
    expect(c.createDynamicsCompressor).toHaveBeenCalledTimes(1);
    expect(c.createGain.mock.calls.length).toBeGreaterThanOrEqual(3);
    initAudio();
    initAudio();
    expect(FakeCtx.all).toHaveLength(1);
  });

  it('每个 SfxName 都能发声且不抛错（含极端 vol/pan/pitch）', () => {
    const c = setup();
    // 每次间隔超过最长的同名间隔，排除限速干扰
    const step = Math.max(...SFX_NAMES.map(n => SFX_META[n].gap), 1) + 0.1;
    for (const n of SFX_NAMES) {
      const before = c.started.length;
      expect(() => playSfx(n), n).not.toThrow();
      expect(c.started.length, `${n} 应启动声源`).toBeGreaterThan(before);
      c.currentTime += step;
      expect(() => playSfx(n, { vol: 2, pan: -1, pitch: 0.5 }), n).not.toThrow();
      c.currentTime += step;
      expect(() => playSfx(n, { vol: 0.3, pan: 1, pitch: 2.5 }), n).not.toThrow();
      c.currentTime += step;
    }
    expect(sfxStats().played).toBe(SFX_NAMES.length * 3);
    for (const s of c.started) expect(s.stopAt).toBeGreaterThan(s.startAt);
  });

  it('每种元素的受击/暴击都有点缀音色', () => {
    const c = setup();
    const got = record();
    for (const el of ELEMENTS) {
      const before = c.started.length;
      playHit(el);
      const plain = c.started.length - before;
      c.currentTime += 1.2;
      playHit(el, { crit: true });
      c.currentTime += 1.2;
      // physical 只有基础受击；其他元素多出点缀声源
      if (el !== 'physical') expect(plain, el).toBeGreaterThan(3);
    }
    expect(got.filter(g => g.name === 'hit')).toHaveLength(ELEMENTS.length);
    expect(got.filter(g => g.name === 'crit')).toHaveLength(ELEMENTS.length);
  });

  it('vol=0 不发声；声像只在需要时创建', () => {
    const c = setup();
    playSfx('hit', { vol: 0 });
    expect(sfxStats().played).toBe(0);
    playSfx('ui');
    expect(c.panners).toHaveLength(0);
    c.currentTime += 1;
    playSfx('ui', { pan: -0.6 });
    expect(c.panners).toHaveLength(1);
    expect(c.panners[0].pan.value).toBeCloseTo(-0.6);
  });

  it('音高随机化 ±5%', () => {
    const c = setup();
    const got = record();
    for (let i = 0; i < 30; i++) {
      playSfx('hit');
      c.currentTime += 0.2;
    }
    const ps = got.map(g => g.pitch);
    expect(ps).toHaveLength(30);
    for (const p of ps) {
      expect(p).toBeGreaterThanOrEqual(0.95);
      expect(p).toBeLessThanOrEqual(1.05);
    }
    expect(new Set(ps).size).toBeGreaterThan(1);
  });

  it('同名速率限制：hit 每秒最多 14 次，同一瞬间只播一次，窗口过后恢复', () => {
    const c = setup();
    const got = record();
    const hits = (): number => got.filter(g => g.name === 'hit').length;
    for (let i = 0; i < 40; i++) {
      playSfx('hit');
      c.currentTime += 0.02;
    }
    expect(hits()).toBe(SFX_META.hit.max);
    expect(sfxStats().limited).toBe(40 - SFX_META.hit.max);
    // 别的音效不受影响
    playSfx('swing');
    expect(got.some(g => g.name === 'swing')).toBe(true);
    // 同一瞬间三连只播一次
    c.currentTime += 2;
    const h0 = hits();
    playSfx('hit');
    playSfx('hit');
    playSfx('hit');
    expect(hits() - h0).toBe(1);
    // 窗口过后恢复
    c.currentTime += 1.1;
    playSfx('hit');
    expect(hits() - h0).toBe(2);
  });

  it('超过 1 秒的同名间隔同样生效：死亡音 3 秒内不叠播（显式 sfx 与 ui:dead 先后到达）', () => {
    const c = setup();
    const got = record();
    handleAudioEvents([{ t: 'sfx', name: 'death' }], 0, 0);
    c.currentTime += 1.2;
    handleAudioEvents([{ t: 'ui', what: 'dead' }], 0, 0);
    c.currentTime += 1.2;
    playSfx('death');
    expect(got.filter(g => g.name === 'death')).toHaveLength(1);
    c.currentTime += 1;
    playSfx('death');
    expect(got.filter(g => g.name === 'death')).toHaveLength(2);
  });

  it('任何 1 秒窗口内都不超过上限（长时间连发）', () => {
    const c = setup();
    const times: number[] = [];
    tapSfx(n => {
      if (n === 'pickupCoin') times.push(c.currentTime);
    });
    for (let i = 0; i < 300; i++) {
      playSfx('pickupCoin');
      c.currentTime += 0.011;
    }
    for (let i = 0; i < times.length; i++) {
      const inWin = times.filter(t => t >= times[i] && t < times[i] + 1).length;
      expect(inWin).toBeLessThanOrEqual(SFX_META.pickupCoin.max);
    }
    expect(times.length).toBeGreaterThan(SFX_META.pickupCoin.max * 2);
  });

  it('复音上限：普通音被裁剪，优先音（UI/升级）照常播放', () => {
    const c = setup();
    const got = record();
    const normal = SFX_NAMES.filter(n => !SFX_META[n].prio);
    for (let round = 0; round < 12; round++) {
      for (const n of normal) playSfx(n);
      c.currentTime += 0.045;
    }
    const st = sfxStats();
    expect(st.culled).toBeGreaterThan(0);
    expect(st.voices).toBeLessThanOrEqual(40);
    const before = got.length;
    playSfx('levelup');
    playSfx('ui');
    expect(got.slice(before).map(g => g.name)).toEqual(['levelup', 'ui']);
  });

  it('连续拾取经验音高递升，停顿后复位', () => {
    const c = setup();
    const ps: number[] = [];
    tapSfx((n, i) => {
      if (n === 'pickupExp') ps.push(i.pitch);
    });
    for (let k = 0; k < 6; k++) {
      playSfx('pickupExp');
      c.currentTime += 0.1;
    }
    expect(ps).toHaveLength(6);
    for (let k = 1; k < 6; k++) expect(ps[k]).toBeGreaterThan(ps[k - 1]);
    expect(ps[5] / ps[0]).toBeGreaterThan(1.85); // 约一个八度
    c.currentTime += 1;
    playSfx('pickupExp');
    expect(ps[6]).toBeLessThan(ps[0] * 1.05);
  });

  it('声源播完后断开全部节点（无泄漏）', () => {
    const c = setup();
    const n0 = c.created.length;
    const s0 = c.started.length;
    playSfx('explosion', { pan: 0.5 });
    const nodes = c.created.slice(n0);
    const srcs = c.started.slice(s0);
    expect(nodes.length).toBeGreaterThan(srcs.length);
    expect(nodes.some(n => !n.disconnected)).toBe(true);
    for (const s of srcs) s.onended?.();
    expect(nodes.every(n => n.disconnected)).toBe(true);
  });
});

describe('handleAudioEvents（事件推导 / 合并 / 声像）', () => {
  it('推导：impact→hit(元素)、explosion、death→kill(+bossRoar)、pickup、levelup、chestOpen、boss 出场；不清空数组', () => {
    setup();
    const got = record();
    const evs: FxEvent[] = [
      { t: 'impact', x: 100, y: 0, el: 'fire', size: 1 },
      { t: 'impact', x: 120, y: 0, el: 'fire', size: 1 },
      { t: 'impact', x: 5000, y: 0, el: 'ice', size: 1 }, // 太远：静音
      { t: 'sfx', name: 'swing' },
      { t: 'explosion', x: -400, y: 0, r: 80, el: 'fire' },
      { t: 'death', x: 0, y: 30, color: '#fff', big: true },
      { t: 'pickup', x: 0, y: 0, kind: 'gold', color: '#ff0' },
      { t: 'pickup', x: 0, y: 0, kind: 'exp', color: '#0f0' },
      { t: 'pickup', x: 0, y: 0, kind: 'item', color: '#fff' },
      { t: 'levelup', x: 0, y: 0 },
      { t: 'chestOpen', id: 3 },
      { t: 'floater', x: 0, y: 0, text: 'hello', color: '#fff', size: 11 },
      { t: 'burst', x: 0, y: 0, color: '#fff', n: 4, spd: 2 },
    ];
    const copy = [...evs];
    handleAudioEvents(evs, 0, 0);
    expect(evs).toEqual(copy);
    const names = got.map(g => g.name);
    expect(names).toEqual(
      expect.arrayContaining(['hit', 'swing', 'explosion', 'kill', 'bossRoar', 'pickupCoin', 'pickupExp', 'pickupItem', 'levelup', 'chest']),
    );
    expect(names.filter(n => n === 'hit')).toHaveLength(1); // 两次命中合并
    const hit = got.find(g => g.name === 'hit')!;
    expect(hit.el).toBe('fire'); // 远处的冰霜命中被静音，没有混进来
    expect(hit.pan).toBeCloseTo(0.25); // 取最近（最响）的那一下定声像
    expect(got.find(g => g.name === 'explosion')!.pan).toBe(-1);
    expect(got.find(g => g.name === 'swing')!.pan).toBe(0); // 无坐标：居中满音量
    expect(names).not.toContain('crit'); // 非数字飘字不触发暴击音
  });

  it('距离 >900 静音，之内线性衰减', () => {
    setup();
    const got = record();
    handleAudioEvents([{ t: 'sfx', name: 'hit', x: 2000, y: 0 }], 0, 0);
    expect(got).toHaveLength(0);
    handleAudioEvents([{ t: 'sfx', name: 'kill', x: 0, y: 450 }], 0, 0);
    expect(got).toHaveLength(1);
    expect(got[0].vol).toBeCloseTo(0.5 * SFX_META.kill.gain, 5);
  });

  it('暴击飘字 → 暴击音，并吞并同批普通受击（保留元素）', () => {
    setup();
    const got = record();
    handleAudioEvents(
      [
        { t: 'impact', x: 0, y: 0, el: 'ice', size: 1.5 },
        { t: 'floater', x: 0, y: 0, text: '256!', color: '#fff', size: 16, crit: true },
      ],
      0,
      0,
    );
    expect(got.map(g => g.name)).toEqual(['crit']);
    expect(got[0].el).toBe('ice');
  });

  it('显式 sfx 与推导音同名时只播一次', () => {
    setup();
    const got = record();
    handleAudioEvents([{ t: 'levelup', x: 0, y: 0 }, { t: 'sfx', name: 'levelup' }, { t: 'death', x: 0, y: 0, color: '#f00', kind: 'player' }, { t: 'ui', what: 'dead' }], 0, 0);
    expect(got.map(g => g.name).sort()).toEqual(['death', 'levelup']);
  });

  it('同批多次命中略增音量（有上限）', () => {
    setup();
    const got = record();
    const many: FxEvent[] = Array.from({ length: 12 }, () => ({ t: 'impact', x: 0, y: 0, el: 'physical', size: 1 }) as FxEvent);
    handleAudioEvents(many, 0, 0);
    expect(got).toHaveLength(1);
    expect(got[0].vol).toBeCloseTo(1.28 * SFX_META.hit.gain, 5);
  });

  it('畸形输入安全：未知音效名、冻结数组、NaN 监听坐标', () => {
    setup();
    const got = record();
    const bad = [{ t: 'sfx', name: 'nope' }] as unknown as FxEvent[];
    expect(() => handleAudioEvents(bad, 0, 0)).not.toThrow();
    expect(got).toHaveLength(0);
    expect(() => handleAudioEvents(Object.freeze([...SAMPLE_EVENTS]), 0, 0)).not.toThrow();
    expect(() => handleAudioEvents(SAMPLE_EVENTS, Number.NaN, Number.NaN)).not.toThrow();
  });
});

describe('自动播放策略 / 页面可见性', () => {
  it('没有用户手势时不创建上下文，首次交互再创建；reset 移除监听', () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    const handlers = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (t: string, fn: () => void) => handlers.set(t, fn),
      removeEventListener: (t: string) => handlers.delete(t),
    });
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    setMusic('city');
    initAudio();
    expect(FakeCtx.all).toHaveLength(0);
    expect(audioStatus()).toBe('idle');
    expect(handlers.has('pointerdown')).toBe(true);
    expect(handlers.has('keydown')).toBe(true);
    handlers.get('pointerdown')!();
    expect(FakeCtx.all).toHaveLength(1);
    expect(audioStatus()).toBe('running');
    expect(musicStats().track).toBe('city'); // 之前请求的曲目自动开始
    // iOS 中断后再次手势恢复
    const c = lastCtx();
    c.state = 'suspended';
    handlers.get('touchend')!();
    expect(c.resume).toHaveBeenCalled();
    expect(c.state).toBe('running');
    resetAudio();
    expect(handlers.size).toBe(0);
    expect(c.close).toHaveBeenCalled();
  });

  it('忘了 initAudio 的兜底：点击回调里（用户激活中）的 playSfx 直接创建上下文并发声', () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true, isActive: true } });
    const got = record();
    playSfx('ui');
    expect(FakeCtx.all).toHaveLength(1);
    expect(got.map(g => g.name)).toEqual(['ui']);
  });

  it('不在用户激活中调用 setMusic/playSfx：只挂监听，首次交互后才创建并开始播放', () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false, isActive: false } });
    const handlers = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: (t: string, fn: () => void) => handlers.set(t, fn),
      removeEventListener: (t: string) => handlers.delete(t),
    });
    setMusic('title');
    playSfx('ui');
    expect(FakeCtx.all).toHaveLength(0);
    expect(handlers.has('keydown')).toBe(true);
    handlers.get('keydown')!();
    expect(FakeCtx.all).toHaveLength(1);
    expect(musicStats()).toMatchObject({ track: 'title', players: 1 });
  });

  it('长时间挂起时丢弃音效（恢复时不会一次性爆发）；手势恢复的宽限期内允许', () => {
    const c = setup();
    const got = record();
    c.state = 'suspended';
    playSfx('hit');
    handleAudioEvents([{ t: 'sfx', name: 'kill' }], 0, 0);
    expect(got).toHaveLength(0);
    expect(sfxStats().dropped).toBeGreaterThan(0);
    // 手势里请求恢复（假上下文的 resume 不立即生效）
    c.resume.mockImplementation(() => Promise.resolve());
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now);
    initAudio();
    playSfx('ui');
    expect(got.map(g => g.name)).toEqual(['ui']);
    vi.spyOn(performance, 'now').mockReturnValue(now + 5000);
    c.currentTime += 1;
    playSfx('ui');
    expect(got).toHaveLength(1);
  });

  it('页面隐藏时挂起，可见后恢复', () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    const docHandlers = new Map<string, () => void>();
    const doc = {
      hidden: false,
      addEventListener: (t: string, fn: () => void) => docHandlers.set(t, fn),
      removeEventListener: (t: string) => docHandlers.delete(t),
    };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    initAudio();
    const c = lastCtx();
    doc.hidden = true;
    docHandlers.get('visibilitychange')!();
    expect(c.suspend).toHaveBeenCalled();
    expect(c.state).toBe('suspended');
    doc.hidden = false;
    docHandlers.get('visibilitychange')!();
    expect(c.state).toBe('running');
  });
});

describe('程序化音乐', () => {
  it('look-ahead 调度、同曲不重启、1.5s 交叉淡化、none 淡出后停表', () => {
    vi.useFakeTimers();
    const c = setup();
    setMusic('boss');
    expect(getMusic()).toBe('boss');
    const n0 = musicStats().notes;
    expect(n0).toBeGreaterThan(0); // 立即排程了 look-ahead 内的音符
    expect(musicStats().timer).toBe(true);
    c.currentTime += 1;
    vi.advanceTimersByTime(120);
    expect(musicStats().notes).toBeGreaterThan(n0);

    setMusic('boss');
    expect(musicStats().players).toBe(1);

    setMusic('city');
    expect(musicStats()).toMatchObject({ track: 'city', players: 2 }); // 交叉淡化中两首并存
    c.currentTime += MUSIC_FADE + 0.5;
    vi.advanceTimersByTime(120);
    expect(musicStats().players).toBe(1);

    setMusic('none');
    expect(getMusic()).toBe('none');
    c.currentTime += MUSIC_FADE + 0.5;
    vi.advanceTimersByTime(120);
    expect(musicStats()).toMatchObject({ players: 0, timer: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('淡入淡出使用 1.5 秒斜坡', () => {
    const c = setup();
    const g0 = c.gains.length;
    setMusic('arena');
    const fadeGain = c.gains[g0]; // MusicPlayer 创建的第一个增益 = 交叉淡化增益
    const ramp = fadeGain.gain.log.find(e => e[0] === 'lin');
    expect(ramp?.[2]).toBeCloseTo(c.currentTime + MUSIC_FADE, 5);
    c.currentTime += 3;
    setMusic('dungeon:crypt');
    const down = fadeGain.gain.log.filter(e => e[0] === 'lin').pop();
    expect(down?.[1]).toBe(0);
    expect(down?.[2]).toBeCloseTo(3 + MUSIC_FADE, 5);
  });

  it('每首曲目都能连续排程 32 小节以上（覆盖全部和弦与加花）不抛错', () => {
    const c = setup();
    for (const t of Object.keys(TRACKS)) {
      // 先淡出到静音并回收上一首，只统计本曲目的音符
      setMusic('none');
      c.currentTime += MUSIC_FADE + 0.5;
      pumpMusic();
      expect(musicStats().players).toBe(0);
      setMusic(t);
      const start = musicStats().notes;
      const bars = 34;
      const secs = (bars * 4 * 60) / TRACKS[t].bpm;
      for (let k = 0; k < secs / 0.25; k++) {
        c.currentTime += 0.25;
        expect(() => pumpMusic(), t).not.toThrow();
      }
      expect(musicStats().notes - start, t).toBeGreaterThan(bars * 2);
    }
  });

  it('快速连切：最多保留 2 首淡出中的曲目，更早的加速淡完并回收', () => {
    const c = setup();
    for (const t of ['title', 'city', 'dungeon:ruins', 'dungeon:magma', 'boss', 'arena']) {
      setMusic(t);
      c.currentTime += 0.05;
    }
    c.currentTime += 0.5;
    pumpMusic();
    expect(musicStats().players).toBeLessThanOrEqual(3);
    expect(musicStats().track).toBe('arena');
  });

  it('initAudio 之前请求的曲目在创建上下文后自动开始', () => {
    vi.stubGlobal('AudioContext', FakeCtx);
    setMusic('dungeon:frost');
    expect(musicStats().players).toBe(0);
    initAudio();
    expect(musicStats()).toMatchObject({ track: 'dungeon:frost', players: 1 });
  });

  it('落后太多（页面挂起）时跳过错过的步，不一次性补播', () => {
    const c = setup();
    setMusic('dungeon:magma');
    const n0 = musicStats().notes;
    c.currentTime += 600; // 10 分钟没调度
    pumpMusic();
    const burst = musicStats().notes - n0;
    // 0.5s look-ahead 内 118BPM 最多约 4 个 16 分音符步，每步最多几个音
    expect(burst).toBeLessThan(40);
  });
});

describe('音量持久化（localStorage）', () => {
  function fakeStorage(): { store: Map<string, string>; api: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> } {
    const store = new Map<string, string>();
    return {
      store,
      api: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
    };
  }

  it('保存并在重载后读回；损坏/部分非法数据回落默认', () => {
    const { store, api } = fakeStorage();
    vi.stubGlobal('localStorage', api);
    setVolume(0.3, 0.1, 0.6);
    const key = [...store.keys()].find(k => k.includes('audio'));
    expect(key).toBeDefined();
    resetAudio(); // 清掉内存缓存
    expect(getVolume()).toEqual({ master: 0.3, music: 0.1, sfx: 0.6 });

    store.set(key!, '{bad json');
    resetAudio();
    expect(getVolume()).toEqual(DEFAULT_VOLUME);

    store.set(key!, JSON.stringify({ master: 0.5, music: 'x', sfx: 9 }));
    resetAudio();
    expect(getVolume()).toEqual({ master: 0.5, music: DEFAULT_VOLUME.music, sfx: 1 });
  });

  it('localStorage 抛异常时安全降级', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(getVolume()).toEqual(DEFAULT_VOLUME);
    expect(() => setVolume(0.2, 0.2, 0.2)).not.toThrow();
    expect(getVolume()).toEqual({ master: 0.2, music: 0.2, sfx: 0.2 });
  });

  it('新建上下文时套用已保存音量；运行中平滑调整', () => {
    const { api } = fakeStorage();
    vi.stubGlobal('localStorage', api);
    setVolume(0.25, 0.15, 0.55);
    const c = setup();
    const vals = c.gains.map(g => g.gain.value);
    expect(vals).toEqual(expect.arrayContaining([0.25, 0.15, 0.55]));
    setVolume(0.9, 0.4, 0.7);
    const targets = c.gains.flatMap(g => g.gain.log.filter(e => e[0] === 'target').map(e => e[1]));
    expect(targets).toEqual(expect.arrayContaining([0.9, 0.4, 0.7]));
  });
});
