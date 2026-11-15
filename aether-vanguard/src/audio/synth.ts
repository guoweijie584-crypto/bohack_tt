// 底层合成原语（原生 Web Audio，不引第三方库）。
// Voice 表示「一次发声」：由若干振荡器 / 噪声声源组成，每个声源自带 包络 + 滤波 + 扫频（+ 可选颤音/震音），
// 统一接到 out（音效：每个音效一条 增益→声像 链；音乐：乐器总线）。声源播完后自动断开整条节点链，避免泄漏。
// 只依赖 BaseAudioContext 的标准接口，测试里可以换成假上下文，离线渲染（OfflineAudioContext）也能直接用。

import { Rng } from '../core/rng';
import { clamp } from '../core/util';

export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type NoiseKind = 'white' | 'brown' | 'crunch';
export type NoiseBank = Readonly<Record<NoiseKind, AudioBuffer>>;

/** 指数包络能到达的最小增益（-80dB）；exponentialRamp 不能以 0 为端点 */
export const MIN_GAIN = 0.0001;

/** 包络：时间均为相对 Voice 起点的秒数 */
export interface EnvSpec {
  /** 起始偏移 */
  t?: number;
  /** 起音（线性上升；最短 2ms 防止爆音） */
  a?: number;
  /** 峰值保持 */
  h?: number;
  /** 衰减（指数下降到静音） */
  d: number;
  /** 峰值增益 */
  v: number;
}

/** 单个双二阶滤波器（可扫频）；频率随 Voice 音高倍率缩放，保证变调后音色一致 */
export interface FilterSpec {
  ft?: BiquadFilterType;
  /** 截止/中心频率（Hz） */
  ff?: number;
  /** 扫频终点（指数） */
  ff1?: number;
  /** 滤波扫频时长（秒），默认整个发声 */
  fsw?: number;
  q?: number;
}

export interface ToneSpec extends EnvSpec, FilterSpec {
  w: Wave;
  /** 起始频率（Hz，未乘音高倍率） */
  f: number;
  /** 扫频终点 */
  f1?: number;
  /** 扫频时长（秒），默认整个发声 */
  sw?: number;
  /** 线性扫频（默认指数，听感更自然） */
  lin?: boolean;
  /** 失谐（音分） */
  det?: number;
  /** 颤音：[速率 Hz, 深度 音分] */
  vib?: readonly [number, number];
  /** 震音：[速率 Hz, 深度 0..0.5] */
  trem?: readonly [number, number];
  /** 不受音高倍率影响（打击乐） */
  fixed?: boolean;
}

export interface NoiseSpec extends EnvSpec, FilterSpec {
  /** 噪声种类：white 白噪 / brown 低沉 / crunch 8-bit 采样保持噪声（复古质感） */
  k?: NoiseKind;
  ft: BiquadFilterType;
  ff: number;
  /** 播放速率（crunch 噪声的“音高”） */
  rate?: number;
}

/** 噪声缓冲：每种 1 秒，循环播放并随机起点，听不出重复 */
export function createNoiseBank(ac: BaseAudioContext): NoiseBank {
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(sr));
  const r = new Rng(0x5eed);
  const make = (fill: (d: Float32Array) => void): AudioBuffer => {
    const b = ac.createBuffer(1, len, sr);
    fill(b.getChannelData(0));
    return b;
  };
  return {
    white: make(d => {
      for (let i = 0; i < d.length; i++) d[i] = r.next() * 2 - 1;
    }),
    // 布朗噪声：带泄漏的积分，能量集中在低频（爆炸、低吼、闷响）
    brown: make(d => {
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        last = (last + 0.02 * (r.next() * 2 - 1)) / 1.02;
        d[i] = clamp(last * 3.5, -1, 1);
      }
    }),
    // 8-bit 噪声：每 6 个采样保持一次并量化到 15 级，类似 FC 噪声通道的颗粒感
    crunch: make(d => {
      let v = 0;
      for (let i = 0; i < d.length; i++) {
        if (i % 6 === 0) v = Math.round((r.next() * 2 - 1) * 7) / 7;
        d[i] = v;
      }
    }),
  };
}

/**
 * ADSR 简化包络：线性起音 → 保持 → 指数衰减 → 归零。
 * 先把增益归零：GainNode 默认增益为 1，而浏览器按“亚采样精度”启动声源——起点落在两个采样帧之间时，
 * 声源的第一个采样会早于 t 处的第一个自动化事件，以满增益漏出一个单采样尖峰（咔哒声）。实测于 Chrome 离线渲染。
 */
export function envelope(g: AudioParam, t: number, a: number, h: number, d: number, peak: number): void {
  const pk = Math.max(MIN_GAIN * 2, peak);
  g.value = 0;
  g.setValueAtTime(MIN_GAIN, t);
  g.linearRampToValueAtTime(pk, t + a);
  if (h > 0) g.setValueAtTime(pk, t + a + h);
  g.exponentialRampToValueAtTime(MIN_GAIN, t + a + h + d);
  g.setValueAtTime(0, t + a + h + d + 0.002);
}

function ramp(p: AudioParam, v: number, at: number, exp: boolean): void {
  if (exp) p.exponentialRampToValueAtTime(Math.max(MIN_GAIN, v), at);
  else p.linearRampToValueAtTime(v, at);
}

/** 声源细节随机（噪声起点），与战斗随机流分开 */
const srcRng = new Rng();

export class Voice {
  readonly ac: BaseAudioContext;
  readonly out: AudioNode;
  /** 绝对起始时间（AudioContext 时钟） */
  readonly t0: number;
  /** 音高倍率（频率与滤波频率都乘它） */
  readonly p: number;
  readonly bank: NoiseBank;
  /** 已排程的最晚结束时间（绝对秒），用于复音计数 */
  end: number;
  /** 已登记的声源数（调试/测试） */
  sources = 0;
  private live = 0;
  private readonly done: (() => void) | null;

  constructor(ac: BaseAudioContext, out: AudioNode, t0: number, p: number, bank: NoiseBank, done?: () => void) {
    this.ac = ac;
    this.out = out;
    this.t0 = t0;
    this.p = p;
    this.bank = bank;
    this.end = t0;
    this.done = done ?? null;
  }

  /** 振荡器音 */
  tone(s: ToneSpec): void {
    const { ac } = this;
    const p = s.fixed ? 1 : this.p;
    const t = this.t0 + Math.max(0, s.t ?? 0);
    const a = Math.max(0.002, s.a ?? 0.003);
    const h = Math.max(0, s.h ?? 0);
    const d = Math.max(0.01, s.d);
    const len = a + h + d;
    const stopAt = t + len + 0.03;

    const o = ac.createOscillator();
    o.type = s.w;
    o.frequency.setValueAtTime(this.hz(s.f * p), t);
    if (s.f1 !== undefined) ramp(o.frequency, this.hz(s.f1 * p), t + Math.max(0.005, s.sw ?? len), !s.lin);
    if (s.det) o.detune.setValueAtTime(s.det, t);

    const nodes: AudioNode[] = [o];
    let head: AudioNode = o;
    const bq = this.filter(s, p, t, len);
    if (bq) {
      head.connect(bq);
      head = bq;
      nodes.push(bq);
    }
    if (s.vib) {
      const [lfo, lg] = this.lfo(s.vib[0], s.vib[1], t, stopAt);
      lg.connect(o.detune);
      nodes.push(lfo, lg);
    }
    if (s.trem) {
      // 震音：tg 的增益在 [1-2·depth, 1] 间摆动
      const depth = clamp(s.trem[1], 0, 0.5);
      const tg = ac.createGain();
      tg.gain.setValueAtTime(1 - depth, t);
      const [lfo, lg] = this.lfo(s.trem[0], depth, t, stopAt);
      lg.connect(tg.gain);
      head.connect(tg);
      head = tg;
      nodes.push(tg, lfo, lg);
    }
    const g = ac.createGain();
    envelope(g.gain, t, a, h, d, s.v);
    head.connect(g);
    g.connect(this.out);
    nodes.push(g);

    o.start(t);
    o.stop(stopAt);
    this.track(o, nodes, stopAt);
  }

  /** 噪声音（必带一个滤波器决定音色） */
  noise(s: NoiseSpec): void {
    const { ac } = this;
    const t = this.t0 + Math.max(0, s.t ?? 0);
    const a = Math.max(0.002, s.a ?? 0.002);
    const h = Math.max(0, s.h ?? 0);
    const d = Math.max(0.01, s.d);
    const len = a + h + d;
    const stopAt = t + len + 0.03;

    const src = ac.createBufferSource();
    src.buffer = this.bank[s.k ?? 'white'];
    src.loop = true;
    if (s.rate !== undefined) src.playbackRate.setValueAtTime(clamp(s.rate * this.p, 0.05, 8), t);

    const nodes: AudioNode[] = [src];
    let head: AudioNode = src;
    const bq = this.filter(s, this.p, t, len);
    if (bq) {
      head.connect(bq);
      head = bq;
      nodes.push(bq);
    }
    const g = ac.createGain();
    envelope(g.gain, t, a, h, d, s.v);
    head.connect(g);
    g.connect(this.out);
    nodes.push(g);

    // 随机起点：同一噪声缓冲每次听起来都不一样
    src.start(t, srcRng.next() * 0.9);
    src.stop(stopAt);
    this.track(src, nodes, stopAt);
  }

  private hz(f: number): number {
    return clamp(f, 10, this.ac.sampleRate * 0.49);
  }

  private filter(s: FilterSpec, p: number, t: number, len: number): BiquadFilterNode | null {
    if (!s.ft || !s.ff) return null;
    const bq = this.ac.createBiquadFilter();
    bq.type = s.ft;
    bq.frequency.setValueAtTime(this.hz(s.ff * p), t);
    if (s.ff1 !== undefined) ramp(bq.frequency, this.hz(s.ff1 * p), t + Math.max(0.005, s.fsw ?? len), true);
    if (s.q !== undefined) bq.Q.setValueAtTime(s.q, t);
    return bq;
  }

  private lfo(rate: number, depth: number, t: number, stopAt: number): [OscillatorNode, GainNode] {
    const l = this.ac.createOscillator();
    l.type = 'sine';
    l.frequency.setValueAtTime(Math.max(0.01, rate), t);
    const g = this.ac.createGain();
    g.gain.setValueAtTime(depth, t);
    l.connect(g);
    l.start(t);
    l.stop(stopAt);
    return [l, g];
  }

  /** 登记声源：播完断开它的整条节点链；全部声源播完后回调 done（断开每音效的增益/声像） */
  private track(src: AudioScheduledSourceNode, nodes: AudioNode[], stopAt: number): void {
    this.live++;
    this.sources++;
    if (stopAt > this.end) this.end = stopAt;
    src.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* 已断开 */
        }
      }
      this.live--;
      if (this.live === 0 && this.done) this.done();
    };
  }
}
