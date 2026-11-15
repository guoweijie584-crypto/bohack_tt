// 程序化氛围音乐（不用音频文件）：和弦 pad + 琶音 + 低音 + 简单打击 + 稀疏铃音点缀 + 回声。
// 以 16 分音符为步进；由 sfx.ts 的 look-ahead 调度器（定时器 + AudioContext 时钟）提前排程，
// 节奏只看音频时钟，不受主线程卡顿影响。每首曲目有自己的调式、速度、配器与鼓型。

import { hashStr } from '../core/rng';
import { MIN_GAIN, Voice, type NoiseBank, type Wave } from './synth';

export type Quality =
  | 'maj' | 'min' | 'sus2' | 'sus4' | 'dim' | 'maj7' | 'min7' | 'dom7' | 'add9' | 'madd9' | 'min6' | 'five';

const QUAL: Record<Quality, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  min6: [0, 3, 7, 9],
  five: [0, 7, 12],
};

/** 和弦：r = 相对主音的半音数，q = 和弦性质 */
export interface ChordDef { r: number; q: Quality }

export interface PadDef {
  w: Wave;
  /** 第二层振荡器波形（默认同 w），两层反向失谐形成合唱感 */
  w2?: Wave;
  /** 相对主音的八度；和弦音折叠进 [主音+12·oct, +12) 的窗口，换和弦时声部平滑 */
  oct: number;
  v: number;
  /** 失谐（音分） */
  det: number;
  /** 低通截止 */
  ff: number;
  /** 起音 / 释音（秒） */
  a: number;
  r: number;
  /** 回声发送量 */
  send: number;
  /** 主音持续低鸣的音量（神秘/阴暗曲目） */
  drone?: number;
}
export interface ArpDef {
  w: Wave;
  /** 16（或 32）字符：'.' 休止，'0'-'9' 和弦音序号（超过和弦音数则升八度） */
  pat: string;
  oct: number;
  v: number;
  ff: number;
  /** 拨弦衰减（秒） */
  d: number;
  send: number;
}
export interface BassDef {
  w: Wave;
  /** 'r' 根音 / 'R' 重音根音 / 'f' 五度 / 'o' 高八度 / '-' 延音 / '.' 休止 */
  pat: string;
  oct: number;
  v: number;
  ff: number;
}
/** k 底鼓 s 军鼓 h 闭镲 o 开镲 t 通鼓 r 边击 sh 沙锤 b 大鼓(太鼓/定音) c 吊镲 */
export type DrumKey = 'k' | 's' | 'h' | 'o' | 't' | 'r' | 'sh' | 'b' | 'c';
/** 鼓型：'X' 重音 / 'x' 普通 / 'g' 轻（ghost）/ '.' 休止 */
export type DrumPats = Partial<Record<DrumKey, string>>;
export interface DrumDef {
  v: number;
  pats: DrumPats;
  /** 加花：bar % every === at 的小节用 pats 覆盖对应声部 */
  fills?: ReadonlyArray<{ every: number; at: number; pats: DrumPats }>;
}
export interface BellDef {
  /** 每个 8 分音符触发概率（按小节位置确定性哈希，每 8 小节重复 = 可辨识的动机） */
  p: number;
  oct: number;
  v: number;
  w: Wave;
  /** 覆盖曲目音阶（例如主城用五声音阶） */
  scale?: readonly number[];
}
export interface EchoDef {
  /** 延迟时长（拍） */
  beats: number;
  fb: number;
  wet: number;
  /** 反馈回路低通（回声逐次变暗） */
  ff: number;
}
export interface TrackDef {
  bpm: number;
  /** 主音 MIDI 音高 */
  tonic: number;
  /** 调式音阶（半音偏移） */
  scale: readonly number[];
  chords: readonly ChordDef[];
  /** 每个和弦持续的小节数 */
  bars: number;
  /** 曲目电平（交叉淡化的目标增益） */
  level: number;
  pad?: PadDef;
  arp?: ArpDef;
  bass?: BassDef;
  drums?: DrumDef;
  bells?: BellDef;
  echo: EchoDef;
}

export const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12);
const mod = (a: number, n: number): number => ((a % n) + n) % n;
/** 把和弦根音的音级规整到 [-5, 6]，低音/琶音不会忽高忽低 */
const centered = (r: number): number => {
  const pc = mod(r, 12);
  return pc > 6 ? pc - 12 : pc;
};
/** 确定性哈希 → [0,1)（同一小节位置每次循环结果相同） */
function h01(seed: number, a: number, b: number): number {
  let x = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca77)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const STEPS_PER_BAR = 16;
const PHRASE_BARS = 8;
const VEL: Readonly<Record<string, number>> = { X: 1, x: 0.72, g: 0.38 };
const DRUM_KEYS: readonly DrumKey[] = ['k', 's', 'h', 'o', 't', 'r', 'sh', 'b', 'c'];

/** 鼓组合成（固定音高，不受随机化影响） */
const DRUM: Record<DrumKey, (v: Voice, g: number) => void> = {
  k: (v, g) => {
    v.tone({ w: 'sine', f: 150, f1: 44, sw: 0.12, a: 0.002, d: 0.32, v: 0.85 * g });
    v.noise({ ft: 'highpass', ff: 2500, a: 0.001, d: 0.012, v: 0.12 * g });
  },
  s: (v, g) => {
    v.noise({ ft: 'bandpass', ff: 1900, q: 0.8, a: 0.001, d: 0.15, v: 0.42 * g });
    v.tone({ w: 'triangle', f: 190, f1: 150, a: 0.001, d: 0.08, v: 0.28 * g });
  },
  h: (v, g) => v.noise({ ft: 'highpass', ff: 7600, a: 0.001, d: 0.035, v: 0.16 * g }),
  o: (v, g) => v.noise({ ft: 'highpass', ff: 7000, a: 0.002, d: 0.22, v: 0.12 * g }),
  t: (v, g) => v.tone({ w: 'sine', f: 125, f1: 78, a: 0.002, d: 0.26, v: 0.55 * g }),
  r: (v, g) => {
    v.tone({ w: 'square', f: 880, a: 0.001, d: 0.018, v: 0.06 * g, ft: 'bandpass', ff: 1800, q: 3 });
    v.noise({ ft: 'bandpass', ff: 2600, q: 4, a: 0.001, d: 0.03, v: 0.2 * g });
  },
  sh: (v, g) => v.noise({ ft: 'bandpass', ff: 6200, q: 1.4, a: 0.012, d: 0.05, v: 0.1 * g }),
  b: (v, g) => {
    v.tone({ w: 'sine', f: 78, f1: 38, sw: 0.4, a: 0.003, d: 0.9, v: 0.8 * g });
    v.noise({ k: 'brown', ft: 'lowpass', ff: 260, a: 0.002, d: 0.5, v: 0.45 * g });
  },
  c: (v, g) => v.noise({ ft: 'highpass', ff: 5200, a: 0.002, d: 0.9, v: 0.12 * g }),
};

type BusKey = 'pad' | 'arp' | 'bass' | 'drum' | 'bell';

/** 一首正在播放（或淡出中）的曲目 */
export class MusicPlayer {
  readonly name: string;
  readonly def: TrackDef;
  /** 交叉淡化增益 */
  readonly out: GainNode;
  /** 已排程音符数（调试/测试） */
  notes = 0;
  private readonly ac: BaseAudioContext;
  private readonly bank: NoiseBank;
  private readonly nodes: AudioNode[] = [];
  private readonly bus: Record<BusKey, GainNode>;
  private readonly stepDur: number;
  private readonly seed: number;
  private step = 0;
  private next: number;
  private stopAt = Infinity;

  constructor(ac: BaseAudioContext, dest: AudioNode, bank: NoiseBank, name: string, def: TrackDef, now: number, fade: number) {
    this.ac = ac;
    this.bank = bank;
    this.name = name;
    this.def = def;
    this.stepDur = 60 / def.bpm / 4;
    this.seed = hashStr(name);
    this.next = now + 0.08;

    this.out = ac.createGain();
    this.out.gain.setValueAtTime(MIN_GAIN, now);
    this.out.gain.linearRampToValueAtTime(def.level, now + Math.max(0.05, fade));
    this.out.connect(dest);

    // 回声：send → delay ⇄ (低通 → 反馈) ，低通后 → wet → out
    const e = def.echo;
    const send = ac.createGain();
    const delay = ac.createDelay(2);
    delay.delayTime.value = Math.min(1.9, (e.beats * 60) / def.bpm);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = e.ff;
    const fb = ac.createGain();
    fb.gain.value = Math.min(0.85, e.fb);
    const wet = ac.createGain();
    wet.gain.value = e.wet;
    send.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wet);
    wet.connect(this.out);
    this.nodes.push(send, delay, lp, fb, wet);

    // 乐器总线：干声直出 + 按比例送回声
    const mk = (amt: number): GainNode => {
      const b = ac.createGain();
      b.connect(this.out);
      this.nodes.push(b);
      if (amt > 0) {
        const s = ac.createGain();
        s.gain.value = amt;
        b.connect(s);
        s.connect(send);
        this.nodes.push(s);
      }
      return b;
    };
    this.bus = {
      pad: mk(def.pad?.send ?? 0),
      arp: mk(def.arp?.send ?? 0),
      bass: mk(0),
      drum: mk(0.06),
      bell: mk(0.6),
    };
  }

  /** 是否已开始淡出 */
  get stopping(): boolean {
    return this.stopAt !== Infinity;
  }

  /** 淡出并在淡出结束时停止排程；force 用于把已在淡出的曲目加速淡完（快速连切时） */
  fadeOut(now: number, fade: number, force = false): void {
    if (this.stopping && !force) return;
    const end = now + Math.max(0.05, fade);
    if (end >= this.stopAt) return;
    const g = this.out.gain;
    const cur = Math.max(MIN_GAIN, Number.isFinite(g.value) ? g.value : this.def.level);
    g.cancelScheduledValues(now);
    g.setValueAtTime(cur, now);
    g.linearRampToValueAtTime(0, end);
    this.stopAt = end;
  }

  /** 淡出完成（留 0.3s 余量）后可回收 */
  finished(now: number): boolean {
    return now >= this.stopAt + 0.3;
  }

  /** 排程 [当前进度, until) 内的所有步；落后太多（页面挂起/卡顿）则跳过错过的步，不补播 */
  schedule(now: number, until: number): void {
    if (this.next < now - 0.1) {
      const k = Math.ceil((now - this.next) / this.stepDur);
      this.step += k;
      this.next += k * this.stepDur;
    }
    const end = Math.min(until, this.stopAt);
    while (this.next < end) {
      this.playStep(this.step, this.next);
      this.step++;
      this.next += this.stepDur;
    }
  }

  dispose(): void {
    for (const n of [this.out, ...this.nodes]) {
      try {
        n.disconnect();
      } catch {
        /* 已断开 */
      }
    }
  }

  private voice(bus: BusKey, t: number): Voice {
    this.notes++;
    return new Voice(this.ac, this.bus[bus], t, 1, this.bank);
  }

  private playStep(i: number, t: number): void {
    const d = this.def;
    const bar = Math.floor(i / STEPS_PER_BAR);
    const s = i % STEPS_PER_BAR;
    const ch = d.chords[Math.floor(bar / d.bars) % d.chords.length];
    const ivs = QUAL[ch.q];
    const rootPc = centered(ch.r);
    const at = (pat: string, off = 0): string => pat[(bar * STEPS_PER_BAR + s + off) % pat.length] ?? '.';

    // 和弦 pad：每个和弦开头触发一次，持续到下个和弦（释音与下个和弦的起音交叠）
    if (d.pad && s === 0 && bar % d.bars === 0) this.pad(t, ch, d.pad, d.bars * STEPS_PER_BAR * this.stepDur);

    // 琶音
    if (d.arp) {
      const c = at(d.arp.pat);
      if (c >= '0' && c <= '9') {
        const k = c.charCodeAt(0) - 48;
        const m = d.tonic + 12 * d.arp.oct + rootPc + ivs[k % ivs.length] + 12 * Math.floor(k / ivs.length);
        const vel = 0.8 + 0.2 * h01(this.seed, i, 3);
        this.voice('arp', t).tone({ w: d.arp.w, f: mtof(m), a: 0.004, d: d.arp.d, v: d.arp.v * vel, ft: 'lowpass', ff: d.arp.ff, ff1: d.arp.ff * 0.35, q: 2 });
      }
    }

    // 低音（'-' 延音）
    if (d.bass) {
      const c = at(d.bass.pat);
      if (c === 'r' || c === 'R' || c === 'f' || c === 'o') {
        let ties = 0;
        while (ties < 31 && at(d.bass.pat, ties + 1) === '-') ties++;
        const len = (1 + ties) * this.stepDur;
        const m = d.tonic + 12 * d.bass.oct + rootPc + (c === 'f' ? 7 : c === 'o' ? 12 : 0);
        const vel = c === 'R' ? 1 : 0.85;
        this.voice('bass', t).tone({
          w: d.bass.w, f: mtof(m), a: 0.006, h: Math.max(0, len * 0.7 - 0.006), d: Math.max(0.08, len * 0.45),
          v: d.bass.v * vel, ft: 'lowpass', ff: d.bass.ff, q: 1.5,
        });
      }
    }

    // 鼓
    if (d.drums) {
      let pats = d.drums.pats;
      if (d.drums.fills) for (const f of d.drums.fills) if (bar % f.every === f.at) pats = { ...pats, ...f.pats };
      for (const key of DRUM_KEYS) {
        const pat = pats[key];
        if (!pat) continue;
        const vel = VEL[at(pat)] ?? 0;
        if (vel > 0) DRUM[key](this.voice('drum', t), vel * d.drums.v);
      }
    }

    // 铃音点缀（8 分音符位置，确定性哈希 → 每 8 小节重复的动机）
    if (d.bells && s % 2 === 0) {
      const b = d.bells;
      const ph = bar % PHRASE_BARS;
      if (h01(this.seed, ph, s) < b.p) {
        const sc = b.scale ?? d.scale;
        const k = Math.floor(h01(this.seed ^ 0x5bd1, ph, s) * sc.length) % sc.length;
        const f = mtof(d.tonic + 12 * b.oct + sc[k]);
        const v = this.voice('bell', t);
        v.tone({ w: b.w, f, a: 0.003, d: 1.1, v: b.v });
        v.tone({ w: 'sine', f: f * 2.76, a: 0.002, d: 0.35, v: b.v * 0.25 });
      }
    }
  }

  private pad(t: number, ch: ChordDef, p: PadDef, dur: number): void {
    const base = this.def.tonic + 12 * p.oct;
    const hold = Math.max(0, dur - p.a);
    const v = this.voice('pad', t);
    const seen = new Set<number>();
    for (const iv of QUAL[ch.q]) {
      const m = base + mod(ch.r + iv, 12);
      if (seen.has(m)) continue;
      seen.add(m);
      const f = mtof(m);
      v.tone({ w: p.w, f, det: -p.det, a: p.a, h: hold, d: p.r, v: p.v, ft: 'lowpass', ff: p.ff, q: 0.7 });
      v.tone({ w: p.w2 ?? p.w, f, det: p.det, a: p.a, h: hold, d: p.r, v: p.v * 0.8, ft: 'lowpass', ff: p.ff, q: 0.7 });
    }
    if (p.drone) v.tone({ w: 'sine', f: mtof(this.def.tonic + 12 * (p.oct - 1)), a: p.a, h: hold, d: p.r, v: p.drone });
  }
}

// —— 调式 ——
const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const HARM_MINOR = [0, 2, 3, 5, 7, 8, 11];
const PENTA = [0, 2, 4, 7, 9];

const C = (r: number, q: Quality): ChordDef => ({ r, q });

/** 曲目表：调式、速度、配器各不相同 */
export const TRACKS: Readonly<Record<string, TrackDef>> = {
  /** 标题：史诗——D 小调，慢速，宽厚锯齿 pad + 太鼓/定音鼓 */
  title: {
    bpm: 78, tonic: 62, scale: AEOLIAN, bars: 1, level: 0.7,
    chords: [C(0, 'min'), C(8, 'maj'), C(3, 'maj'), C(10, 'maj'), C(0, 'min'), C(8, 'maj'), C(5, 'min'), C(7, 'maj')],
    pad: { w: 'sawtooth', w2: 'triangle', oct: -1, v: 0.045, det: 9, ff: 1700, a: 0.5, r: 1.0, send: 0.35 },
    arp: { w: 'triangle', pat: '0.1.2.1.3.1.2.1.', oct: 0, v: 0.05, ff: 2400, d: 0.35, send: 0.4 },
    bass: { w: 'sawtooth', pat: 'R-------r---f---', oct: -2, v: 0.11, ff: 420 },
    drums: {
      v: 0.9,
      pats: { b: 'X...............', t: '......x.....x.x.' },
      fills: [{ every: 4, at: 3, pats: { t: '......x.x.x.xXxX' } }],
    },
    bells: { p: 0.14, oct: 1, v: 0.035, w: 'triangle' },
    echo: { beats: 0.75, fb: 0.38, wet: 0.32, ff: 2600 },
  },
  /** 主城：温暖平静——F 大调，柔和三角波 pad、拨弦琶音、五声音阶铃音 */
  city: {
    bpm: 96, tonic: 65, scale: IONIAN, bars: 1, level: 0.8,
    chords: [C(0, 'maj'), C(7, 'maj'), C(9, 'min'), C(5, 'maj'), C(0, 'maj'), C(4, 'min'), C(5, 'maj'), C(7, 'sus4')],
    pad: { w: 'triangle', oct: -1, v: 0.05, det: 6, ff: 1500, a: 0.25, r: 0.6, send: 0.25 },
    arp: { w: 'square', pat: '0.2.1.2.3.2.1.2.', oct: 0, v: 0.028, ff: 2300, d: 0.22, send: 0.3 },
    bass: { w: 'triangle', pat: 'r-----f-r-----f-', oct: -2, v: 0.12, ff: 900 },
    drums: { v: 0.55, pats: { k: 'x.......x.......', h: '..g...g...g...g.', sh: 'g.g.g.g.g.g.g.g.' } },
    bells: { p: 0.1, oct: 1, v: 0.03, w: 'sine', scale: PENTA },
    echo: { beats: 0.5, fb: 0.25, wet: 0.2, ff: 3000 },
  },
  /** 遗迹：神秘——A 多利亚，慢速，低鸣 + 稀疏琶音 + 长回声 */
  'dungeon:ruins': {
    bpm: 76, tonic: 57, scale: DORIAN, bars: 2, level: 0.78,
    chords: [C(0, 'min'), C(5, 'maj'), C(0, 'min'), C(10, 'maj')],
    pad: { w: 'sawtooth', oct: 0, v: 0.035, det: 11, ff: 950, a: 1.0, r: 1.4, send: 0.4, drone: 0.05 },
    arp: { w: 'triangle', pat: '0...2...1.3...2.', oct: 1, v: 0.05, ff: 2000, d: 0.45, send: 0.55 },
    bass: { w: 'triangle', pat: 'R---------------', oct: -1, v: 0.12, ff: 500 },
    drums: { v: 0.5, pats: { k: 'x...............', r: '........g.....g.', sh: '..g...g...g...g.' } },
    bells: { p: 0.07, oct: 2, v: 0.028, w: 'sine' },
    echo: { beats: 0.75, fb: 0.42, wet: 0.38, ff: 2200 },
  },
  /** 熔岩：紧张——E 弗里几亚（♭II 的压迫感），16 分音符方波固定音型 + 推进的鼓 */
  'dungeon:magma': {
    bpm: 118, tonic: 52, scale: PHRYGIAN, bars: 1, level: 0.7,
    chords: [C(0, 'min'), C(1, 'maj'), C(0, 'min'), C(10, 'maj'), C(0, 'min'), C(1, 'maj'), C(3, 'maj'), C(1, 'maj')],
    pad: { w: 'sawtooth', oct: 0, v: 0.03, det: 13, ff: 1200, a: 0.12, r: 0.4, send: 0.15 },
    arp: { w: 'square', pat: '0102010201020102', oct: 1, v: 0.022, ff: 1900, d: 0.12, send: 0.2 },
    bass: { w: 'square', pat: 'r.rr.r.rr.r.r.rr', oct: -1, v: 0.075, ff: 520 },
    drums: {
      v: 0.8,
      pats: { k: 'x..x..x...x..x..', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
      fills: [{ every: 4, at: 3, pats: { t: '..........x.x.xx', s: '....x.......xxxx' } }],
    },
    echo: { beats: 0.5, fb: 0.22, wet: 0.14, ff: 1800 },
  },
  /** 冰原：空灵寒冷——B 自然小调的加九/大七和弦，正弦 pad、铃音琶音、大回声，几乎无鼓 */
  'dungeon:frost': {
    bpm: 66, tonic: 59, scale: AEOLIAN, bars: 2, level: 0.66,
    chords: [C(0, 'madd9'), C(8, 'maj7'), C(3, 'maj7'), C(10, 'add9')],
    pad: { w: 'sine', w2: 'triangle', oct: 0, v: 0.05, det: 5, ff: 2600, a: 1.6, r: 2.0, send: 0.5 },
    arp: { w: 'sine', pat: '0..2..4..3..1..2', oct: 1, v: 0.04, ff: 5000, d: 0.7, send: 0.65 },
    bass: { w: 'sine', pat: 'R---------------', oct: -1, v: 0.11, ff: 600 },
    drums: { v: 0.35, pats: { h: '......g.......g.' } },
    bells: { p: 0.12, oct: 2, v: 0.03, w: 'sine' },
    echo: { beats: 0.75, fb: 0.5, wet: 0.45, ff: 3800 },
  },
  /** 墓穴：阴暗——C 弗里几亚，极慢，低沉锯齿 + 主音低鸣 + 心跳鼓 */
  'dungeon:crypt': {
    bpm: 60, tonic: 60, scale: PHRYGIAN, bars: 2, level: 0.9,
    chords: [C(0, 'min'), C(1, 'maj'), C(5, 'min'), C(7, 'min')],
    pad: { w: 'sawtooth', oct: -1, v: 0.035, det: 15, ff: 700, a: 1.4, r: 1.8, send: 0.45, drone: 0.06 },
    arp: { w: 'triangle', pat: '0.....1.....2...', oct: 0, v: 0.045, ff: 1400, d: 0.6, send: 0.55 },
    bass: { w: 'sawtooth', pat: 'R---------------', oct: -2, v: 0.08, ff: 260 },
    drums: { v: 0.7, pats: { k: 'x.g.............', r: '............g...' } },
    bells: { p: 0.05, oct: 0, v: 0.03, w: 'triangle' },
    echo: { beats: 1, fb: 0.45, wet: 0.36, ff: 1600 },
  },
  /** 秘境：奇幻——D 利底亚（升四级的漂浮感），连续 16 分音符闪烁琶音 */
  'dungeon:secret': {
    bpm: 88, tonic: 62, scale: LYDIAN, bars: 1, level: 0.85,
    chords: [C(0, 'maj'), C(2, 'maj'), C(0, 'maj7'), C(2, 'maj'), C(4, 'min'), C(2, 'maj'), C(11, 'min'), C(2, 'sus2')],
    pad: { w: 'triangle', oct: -1, v: 0.045, det: 7, ff: 2000, a: 0.45, r: 0.8, send: 0.35 },
    arp: { w: 'square', pat: '0123432101234321', oct: 0, v: 0.018, ff: 3200, d: 0.16, send: 0.45 },
    bass: { w: 'triangle', pat: 'R-------f-------', oct: -2, v: 0.11, ff: 700 },
    drums: { v: 0.5, pats: { k: 'x.......x.......', h: '..x...x...x...x.', sh: 'gggggggggggggggg' } },
    bells: { p: 0.1, oct: 1, v: 0.028, w: 'sine' },
    echo: { beats: 0.75, fb: 0.36, wet: 0.3, ff: 3400 },
  },
  /** 首领战：急促鼓点——A 和声小调，144BPM，奔马低音 + 16 分镲 + 每 4 小节通鼓加花 */
  boss: {
    bpm: 144, tonic: 57, scale: HARM_MINOR, bars: 1, level: 0.62,
    chords: [C(0, 'min'), C(8, 'maj'), C(10, 'maj'), C(7, 'maj'), C(0, 'min'), C(8, 'maj'), C(5, 'min'), C(7, 'dom7')],
    pad: { w: 'sawtooth', oct: 0, v: 0.028, det: 10, ff: 1500, a: 0.04, r: 0.25, send: 0.12 },
    arp: { w: 'sawtooth', pat: '0102030201020302', oct: 0, v: 0.02, ff: 2000, d: 0.1, send: 0.12 },
    bass: { w: 'sawtooth', pat: 'r.rrr.rrr.rrr.rr', oct: -1, v: 0.07, ff: 480 },
    drums: {
      v: 0.85,
      pats: { k: 'x..xx..xx..x.x..', s: '....x.......x...', h: 'xgxgxgxgxgxgxgxg' },
      fills: [
        { every: 4, at: 0, pats: { c: 'X...............' } },
        { every: 4, at: 3, pats: { t: '........x.xxXxXX', s: '....x...x.x.xxxx' } },
      ],
    },
    echo: { beats: 0.5, fb: 0.15, wet: 0.1, ff: 2000 },
  },
  /** 竞技场：激昂——E 小调英雄进行（VI-VII-i），四四拍底鼓 + 反拍开镲 */
  arena: {
    bpm: 128, tonic: 64, scale: AEOLIAN, bars: 1, level: 0.76,
    chords: [C(8, 'maj'), C(10, 'maj'), C(0, 'min'), C(0, 'min'), C(8, 'maj'), C(10, 'maj'), C(3, 'maj'), C(7, 'maj')],
    pad: { w: 'sawtooth', oct: -1, v: 0.03, det: 9, ff: 2000, a: 0.06, r: 0.3, send: 0.15 },
    arp: { w: 'square', pat: '0.120.120.120.12', oct: 0, v: 0.022, ff: 2600, d: 0.13, send: 0.2 },
    bass: { w: 'square', pat: 'r.o.r.o.r.o.r.o.', oct: -2, v: 0.065, ff: 650 },
    drums: {
      v: 0.8,
      pats: { k: 'x...x...x...x...', s: '....x.......x...', o: '..x...x...x...x.' },
      fills: [
        { every: 4, at: 0, pats: { c: 'X...............' } },
        { every: 8, at: 7, pats: { s: '....x...x.xxXXXX' } },
      ],
    },
    echo: { beats: 0.5, fb: 0.2, wet: 0.14, ff: 2600 },
  },
};

/** 曲目名规整：'dungeon:<主题>'、裸主题名（'magma'）、别名；未知副本主题回落到遗迹，其他未知 → 'none' */
export function resolveTrack(track: string): string {
  const t = String(track ?? '').trim();
  if (t === '' || t === 'none') return 'none';
  if (Object.prototype.hasOwnProperty.call(TRACKS, t)) return t;
  if (t.startsWith('dungeon:')) {
    const th = t.slice('dungeon:'.length);
    if (th === 'arena' || th === 'city' || th === 'boss' || th === 'title') return th;
    return 'dungeon:ruins';
  }
  if (t === 'dungeon') return 'dungeon:ruins';
  if (Object.prototype.hasOwnProperty.call(TRACKS, 'dungeon:' + t)) return 'dungeon:' + t;
  return 'none';
}
