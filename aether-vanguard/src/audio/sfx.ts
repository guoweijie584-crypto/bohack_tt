// 原生 Web Audio 合成音效 + 程序化氛围音乐（改版意见：音效系统用 Web Audio API 原生实现，不引入外部库）。
// 【契约】签名不可改；实现由 audio 代理完成。
//
// 信号链：
//   每个音效 → 增益(音量×距离衰减) → 声像 ─→ sfx 总线 ───┐
//   每首曲目 → 交叉淡化增益 → 干声 + 回声 ─→ music 总线 ─┴→ 动态压缩器(防爆音) → master → 扬声器
// 约定：
//   - initAudio() 任何时候调用都安全：尚无用户手势时只挂监听，首次交互（pointer/key/touch）再惰性创建 AudioContext；
//   - 没有 AudioContext 的环境（Node/测试/老浏览器）所有函数安全空操作；
//   - 页面隐藏时挂起上下文（省电），可见后恢复；挂起期间的音效直接丢弃，不排队（否则恢复时会一次性爆发）；
//   - 同名音效限速（滑动窗口 + 最小间隔）+ 全局复音上限；同一帧同名事件合并成一次（音量略增）。

import { SAVE_PREFIX } from '../config';
import { Rng } from '../core/rng';
import { clamp } from '../core/util';
import type { ElementId } from '../data/types';
import type { DropKind, FxEvent, SfxName } from '../game/types';
import { MusicPlayer, TRACKS, resolveTrack } from './music';
import { RECIPES, SFX_META, elementAccent } from './recipes';
import { Voice, createNoiseBank, type NoiseBank } from './synth';

export interface Volume { master: number; music: number; sfx: number }

/** 默认音量：音乐较低，不盖过音效 */
export const DEFAULT_VOLUME: Readonly<Volume> = Object.freeze({ master: 0.8, music: 0.35, sfx: 0.8 });
/** 声像：与听者的水平差 ±PAN_RANGE 世界单位对应 ±1 */
export const PAN_RANGE = 400;
/** 距离超过它（世界单位）完全静音；之内线性衰减 */
export const HEAR_RANGE = 900;
/** 曲目交叉淡入淡出（秒） */
export const MUSIC_FADE = 1.5;
/** 全部音效名（UI 试听 / 测试） */
export const SFX_NAMES: readonly SfxName[] = Object.freeze(Object.keys(RECIPES) as SfxName[]);
/** 全部曲目名（含 'none'） */
export const MUSIC_TRACKS: readonly string[] = Object.freeze(['none', ...Object.keys(TRACKS)]);

export type AudioStatus = 'unsupported' | 'idle' | 'suspended' | 'running' | 'closed';
/** 调试监听：每次真正发声时回调 */
export type SfxTap = (name: SfxName, info: { vol: number; pan: number; pitch: number; el?: ElementId }) => void;

const VOL_KEY = `${SAVE_PREFIX}_audio`;
/** 全局复音上限（优先音不受限） */
const MAX_VOICES = 40;
/** 音乐 look-ahead：每次调度提前排程的时长 / 调度间隔 */
const LOOKAHEAD = 0.5;
const TICK_MS = 60;
/** 请求恢复后的宽限期（秒）：期间允许排程，避免首个点击音被吞 */
const RESUME_GRACE = 0.6;
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown'] as const;
/** 连续拾取经验时的音高递升（五声音阶半音数） */
const EXP_STEPS = [0, 2, 4, 7, 9, 12];

interface Graph {
  ctx: AudioContext;
  comp: DynamicsCompressorNode;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  bank: NoiseBank;
}
interface PlayReq { vol: number; pan: number; pitch: number; el?: ElementId; delay?: number }

let graph: Graph | null = null;
let vol: Volume | null = null;
/** 请求的曲目 / 实际在播的曲目 */
let wantTrack = 'none';
let curTrack = 'none';
let current: MusicPlayer | null = null;
let players: MusicPlayer[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;
let autoSuspended = false;
let resumeAskedAt = -Infinity;
let expChain = 0;
let expLastT = -Infinity;
let voiceEnds: number[] = [];
/** 同名限速状态：1 秒窗口内的播放时刻 + 上次播放时刻 */
const recent = new Map<SfxName, { times: number[]; last: number }>();
const stats = { played: 0, limited: 0, culled: 0, dropped: 0 };
let tap: SfxTap | null = null;
/** 音高随机化（表现层随机，不占用战斗随机流） */
const jit = new Rng();

// ———————————————————————————— 基础设施 ————————————————————————————

const fin = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const wallNow = (): number =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()) / 1000;
const isHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isSfxName = (n: unknown): n is SfxName => typeof n === 'string' && own(RECIPES, n);

/** 吞掉 Promise 拒绝（resume/suspend/close 在无手势或已关闭时会 reject） */
function quiet(r: unknown): void {
  if (r && typeof (r as PromiseLike<unknown>).then === 'function') (r as PromiseLike<unknown>).then(undefined, () => undefined);
}
function disconnect(n: AudioNode): void {
  try {
    n.disconnect();
  } catch {
    /* 已断开 */
  }
}

type AudioCtor = new (opts?: AudioContextOptions) => AudioContext;
function audioCtor(): AudioCtor | null {
  const g = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  if (typeof g.AudioContext === 'function') return g.AudioContext as AudioCtor;
  if (typeof g.webkitAudioContext === 'function') return g.webkitAudioContext as AudioCtor;
  return null;
}

function userActivation(): { hasBeenActive?: unknown; isActive?: unknown } | undefined {
  const nav = (globalThis as unknown as { navigator?: { userActivation?: { hasBeenActive?: unknown; isActive?: unknown } } }).navigator;
  return nav?.userActivation;
}
/** 是否已有过用户手势（不支持 userActivation 的浏览器视为有，交给 resume 兜底） */
function gestureSeen(): boolean {
  const ua = userActivation();
  return ua && typeof ua.hasBeenActive === 'boolean' ? ua.hasBeenActive : true;
}
/** 此刻是否处于用户激活窗口内（点击/按键回调中） */
function gestureActive(): boolean {
  return userActivation()?.isActive === true;
}

function storage(): Storage | null {
  try {
    const s = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}
function loadVolumes(): Volume {
  const v: Volume = { ...DEFAULT_VOLUME };
  try {
    const raw = storage()?.getItem(VOL_KEY);
    if (raw) {
      const o: unknown = JSON.parse(raw);
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        for (const k of ['master', 'music', 'sfx'] as const) {
          const x = r[k];
          if (typeof x === 'number' && Number.isFinite(x)) v[k] = clamp(x, 0, 1);
        }
      }
    }
  } catch {
    /* 存档损坏或存储不可用：用默认值 */
  }
  return v;
}
function saveVolumes(v: Volume): void {
  try {
    storage()?.setItem(VOL_KEY, JSON.stringify(v));
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
}
function volumes(): Volume {
  if (!vol) vol = loadVolumes();
  return vol;
}

function createGraph(): Graph | null {
  const Ctor = audioCtor();
  if (!Ctor) return null;
  let ctx: AudioContext | null = null;
  try {
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      ctx = new Ctor();
    }
    const v = volumes();
    // 压缩器兼限幅：多个音效同帧叠加时压住峰值，不削波
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    const master = ctx.createGain();
    master.gain.value = v.master;
    const music = ctx.createGain();
    music.gain.value = v.music;
    const sfx = ctx.createGain();
    sfx.gain.value = v.sfx;
    music.connect(comp);
    sfx.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);
    return { ctx, comp, master, music, sfx, bank: createNoiseBank(ctx) };
  } catch {
    if (ctx) {
      try {
        quiet(ctx.close());
      } catch {
        /* 忽略 */
      }
    }
    return null;
  }
}

/** 惰性创建音频图；新建后接上之前请求的曲目 */
function ensureGraph(): Graph | null {
  if (graph) return graph;
  graph = createGraph();
  if (graph) {
    resume(graph);
    applyMusic(graph);
  }
  return graph;
}

function resume(g: Graph): void {
  const st = g.ctx.state as string;
  if (st === 'running' || st === 'closed' || isHidden()) return;
  resumeAskedAt = wallNow();
  try {
    quiet(g.ctx.resume());
  } catch {
    /* 没有手势时会被拒绝：等下一次交互 */
  }
}

/** 可以排程音效吗：运行中，或刚在手势里请求了恢复（宽限期内） */
function canPlay(g: Graph): boolean {
  const st = g.ctx.state as string;
  if (st === 'running') return true;
  if (st === 'closed') return false;
  return wallNow() - resumeAskedAt < RESUME_GRACE;
}

function onGesture(): void {
  const g = ensureGraph();
  if (g) resume(g);
}
function onVisibility(): void {
  const g = graph;
  if (!g || typeof document === 'undefined') return;
  if (document.hidden) {
    if (g.ctx.state === 'running') {
      autoSuspended = true;
      try {
        quiet(g.ctx.suspend());
      } catch {
        /* 忽略 */
      }
    }
  } else if (autoSuspended) {
    autoSuspended = false;
    resume(g);
  }
}
function listen(): void {
  if (listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  // 常驻：iOS 来电等中断后需要再次手势恢复
  for (const ev of GESTURES) window.addEventListener(ev, onGesture, { capture: true, passive: true });
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  listening = true;
}
function unlisten(): void {
  if (!listening) return;
  listening = false;
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    for (const ev of GESTURES) window.removeEventListener(ev, onGesture, { capture: true });
  }
  if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
    document.removeEventListener('visibilitychange', onVisibility);
  }
}

// ———————————————————————————— 音效 ————————————————————————————

/** 同名限速：1 秒滑动窗口内最多 max 次，且与上一次至少相隔 gap 秒（gap 可以超过 1 秒，单独记上次时间） */
function rateOk(name: SfxName, max: number, gap: number, now: number): boolean {
  let st = recent.get(name);
  if (!st) {
    st = { times: [], last: -Infinity };
    recent.set(name, st);
  }
  if (now < st.last) {
    // 时钟回退（换了新上下文）
    st.times.length = 0;
    st.last = -Infinity;
  }
  if (now - st.last < gap) return false;
  const q = st.times;
  while (q.length && now - q[0] >= 1) q.shift();
  if (q.length >= max) return false;
  q.push(now);
  st.last = now;
  return true;
}

/** 连续拾取经验：0.45 秒内接连拾取，音高沿五声音阶递升（最多一个八度） */
function expChainMul(now: number): number {
  expChain = now - expLastT < 0.45 ? Math.min(expChain + 1, EXP_STEPS.length - 1) : 0;
  expLastT = now;
  return 2 ** (EXP_STEPS[expChain] / 12);
}

/** 真正发声；返回是否播放 */
function play(name: SfxName, r: PlayReq): boolean {
  const g = graph;
  if (!g) return false;
  if (!canPlay(g)) {
    stats.dropped++;
    return false;
  }
  if (!isSfxName(name)) return false; // 运行时防御：错误的名字
  const recipe = RECIPES[name];
  const meta = SFX_META[name];
  const gain = Math.min(3, clamp(fin(r.vol, 1), 0, 4) * meta.gain);
  if (gain < 0.002) return false;

  const ac = g.ctx;
  const now = ac.currentTime;
  // 先看复音上限（被裁掉的不占限速名额），再看同名限速
  voiceEnds = voiceEnds.filter(e => e > now);
  if (voiceEnds.length >= MAX_VOICES && !meta.prio) {
    stats.culled++;
    return false;
  }
  if (!rateOk(name, meta.max, meta.gap, now)) {
    stats.limited++;
    return false;
  }

  let pitch = clamp(fin(r.pitch, 1), 0.25, 4) * (1 + jit.range(-meta.jit, meta.jit));
  if (name === 'pickupExp') pitch *= expChainMul(now);
  const pan = clamp(fin(r.pan, 0), -1, 1);
  const t0 = now + 0.004 + clamp(fin(r.delay, 0), 0, 2);

  // 每个音效一条：增益 → (声像) → sfx 总线；全部声源播完后断开
  const out = ac.createGain();
  out.gain.value = gain;
  let pn: StereoPannerNode | null = null;
  if (Math.abs(pan) > 0.01 && typeof ac.createStereoPanner === 'function') {
    pn = ac.createStereoPanner();
    pn.pan.value = pan;
    out.connect(pn);
    pn.connect(g.sfx);
  } else {
    out.connect(g.sfx);
  }
  const release = (): void => {
    disconnect(out);
    if (pn) disconnect(pn);
  };
  const v = new Voice(ac, out, t0, pitch, g.bank, release);
  try {
    recipe(v);
    if (r.el && r.el !== 'physical') elementAccent(v, r.el, name === 'explosion' ? 2.4 : name === 'crit' ? 1.4 : 1);
  } catch {
    release();
    return false;
  }
  if (v.sources === 0) {
    release();
    return false;
  }
  voiceEnds.push(v.end);
  stats.played++;
  tap?.(name, { vol: gain, pan, pitch, el: r.el });
  return true;
}

/** 首次用户交互后调用（浏览器自动播放策略） */
export function initAudio(): void {
  if (!audioCtor()) return; // Node / 测试 / 不支持：空操作
  listen();
  if (!graph && !gestureSeen()) return; // 尚无用户手势：等首次交互再建，避免自动播放策略警告
  const g = ensureGraph();
  if (g) resume(g);
}

/** 兜底：还没 initAudio 时也挂上手势监听；若正处于用户激活窗口（点击回调里）则直接创建上下文 */
function autoInit(): void {
  if (graph || !audioCtor()) return;
  listen();
  if (gestureActive()) ensureGraph();
}

export function playSfx(name: SfxName, opts?: { vol?: number; pan?: number; pitch?: number }): void {
  if (!graph) autoInit();
  play(name, { vol: opts?.vol ?? 1, pan: opts?.pan ?? 0, pitch: opts?.pitch ?? 1 });
}

/** 带元素音色的受击（crit 为 true 时用暴击音）；渲染层/UI 需要时可直接调用 */
export function playHit(el: ElementId, opts?: { vol?: number; pan?: number; pitch?: number; crit?: boolean }): void {
  if (!graph) autoInit();
  play(opts?.crit ? 'crit' : 'hit', { vol: opts?.vol ?? 1, pan: opts?.pan ?? 0, pitch: opts?.pitch ?? 1, el });
}

/** 距离衰减与声像：水平差 ±400 → 声像 ±1；距离 ≥900 静音，之内线性衰减 */
export function spatialize(x: number, y: number, lx: number, ly: number): { gain: number; pan: number } {
  const dx = x - lx;
  const d = Math.hypot(dx, y - ly);
  if (!(d < HEAR_RANGE)) return { gain: 0, pan: 0 }; // 含 NaN
  return { gain: 1 - d / HEAR_RANGE, pan: clamp(dx / PAN_RANGE, -1, 1) };
}

type AddFn = (name: SfxName, base: number, x?: number, y?: number, pitch?: number, el?: ElementId, delay?: number) => void;

/** impact.size：≤4 视为倍率（1 = 普通），更大视为像素半径（约 14 = 普通） */
function impactScale(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return clamp(size > 4 ? size / 14 : size, 0.4, 2.5);
}

function pickupSfx(kind: DropKind, x: number, y: number, add: AddFn): void {
  switch (kind) {
    case 'gold': add('pickupCoin', 0.9, x, y); break;
    case 'exp': add('pickupExp', 0.75, x, y); break;
    case 'hp': add('potion', 0.55, x, y, 1.18); break;
    case 'mp': add('pickupExp', 0.8, x, y, 0.75); break;
    case 'item': add('pickupItem', 1, x, y); break;
    case 'mat': add('pickupItem', 0.8, x, y, 1.25); break;
    case 'chest': add('chest', 1, x, y); break;
  }
}

/** 事件 → 音效：显式 sfx 事件 + 由其他表现事件推导 */
function deriveSfx(e: FxEvent, add: AddFn): void {
  switch (e.t) {
    case 'sfx':
      if (isSfxName(e.name)) add(e.name, clamp(fin(e.vol, 1), 0, 2), e.x, e.y);
      break;
    case 'impact': {
      // 越大越响、越低沉；元素决定点缀音色
      const s = impactScale(e.size);
      add('hit', 0.7 + 0.3 * s, e.x, e.y, clamp(1.12 - 0.12 * s, 0.82, 1.12), e.el);
      break;
    }
    case 'explosion': {
      const r = fin(e.r, 60);
      add('explosion', clamp(0.55 + r / 220, 0.55, 1.25), e.x, e.y, clamp(1.18 - r / 400, 0.72, 1.15), e.el);
      break;
    }
    case 'death':
      if (e.kind === 'player') {
        add('death', 1, e.x, e.y);
      } else {
        add('kill', e.big ? 1.15 : 0.85, e.x, e.y);
        if (e.big) add('bossRoar', 0.75, e.x, e.y, 0.8, undefined, 0.06); // 大型怪/首领：咆哮余韵
      }
      break;
    case 'levelup':
      add('levelup', 1, e.x, e.y);
      break;
    case 'chestOpen':
      add('chest', 1);
      break;
    case 'pickup':
      pickupSfx(e.kind, e.x, e.y, add);
      break;
    case 'spawn':
      if (e.boss) add('bossRoar', 1, e.x, e.y);
      break;
    case 'floater':
      // 暴击飘字（数字）→ 暴击音；与显式 crit 事件合并，不会重复
      if (e.crit && /\d/.test(e.text)) add('crit', 0.9, e.x, e.y);
      break;
    case 'ui':
      if (e.what === 'dead') add('death', 1);
      break;
    default:
      break;
  }
}

/** 每帧调用：消费 sfx 事件（以及 hit/death/explosion 等可推导音效的事件）；listenerX/Y 为玩家世界坐标，用于声像与距离衰减；不要清空数组 */
export function handleAudioEvents(events: readonly FxEvent[], listenerX: number, listenerY: number): void {
  const g = graph;
  if (!g || !events || events.length === 0 || !canPlay(g)) return;
  const hasListener = Number.isFinite(listenerX) && Number.isFinite(listenerY);
  // 同一批事件里同名音效合并为一次：取最响（最近）的那个定声像/音高，次数多则略增音量
  const reqs = new Map<SfxName, { vol: number; pan: number; pitch: number; el?: ElementId; delay: number; n: number }>();
  const add: AddFn = (name, base, x, y, pitch = 1, el, delay = 0) => {
    let gain = 1;
    let pan = 0;
    if (hasListener && typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      const s = spatialize(x, y, listenerX, listenerY);
      if (s.gain <= 0) return; // 太远：静音
      gain = s.gain;
      pan = s.pan;
    }
    const v = base * gain;
    const r = reqs.get(name);
    if (!r) {
      reqs.set(name, { vol: v, pan, pitch, el, delay, n: 1 });
      return;
    }
    r.n++;
    if (v > r.vol) {
      r.vol = v;
      r.pan = pan;
      r.pitch = pitch;
      r.delay = delay;
      if (el) r.el = el;
    } else if (!r.el && el) {
      r.el = el;
    }
  };
  for (const e of events) {
    try {
      deriveSfx(e, add);
    } catch {
      /* 畸形事件：跳过 */
    }
  }
  // 暴击音已包含受击音：同批的普通受击并入暴击（保留元素点缀）
  const crit = reqs.get('crit');
  const hit = reqs.get('hit');
  if (crit && hit) {
    crit.el ??= hit.el;
    reqs.delete('hit');
  }
  for (const [name, r] of reqs) {
    play(name, { vol: r.vol * (1 + 0.07 * Math.min(r.n - 1, 4)), pan: r.pan, pitch: r.pitch, el: r.el, delay: r.delay });
  }
}

// ———————————————————————————— 音乐 ————————————————————————————

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** look-ahead 调度：把每首在播曲目排程到 now + LOOKAHEAD；回收淡出完毕的曲目 */
function pump(): void {
  const g = graph;
  if (!g) {
    stopTimer();
    return;
  }
  const now = g.ctx.currentTime;
  for (const p of players) {
    try {
      p.schedule(now, now + LOOKAHEAD);
    } catch {
      /* 单首出错不影响其他 */
    }
  }
  if (players.some(p => p.finished(now))) {
    players = players.filter(p => {
      if (!p.finished(now)) return true;
      p.dispose();
      return false;
    });
  }
  if (players.length === 0) stopTimer();
}

function applyMusic(g: Graph): void {
  if (wantTrack === curTrack) return;
  const now = g.ctx.currentTime;
  if (current) {
    current.fadeOut(now, MUSIC_FADE);
    current = null;
  }
  curTrack = wantTrack;
  if (own(TRACKS, wantTrack)) {
    try {
      current = new MusicPlayer(g.ctx, g.music, g.bank, wantTrack, TRACKS[wantTrack], now, MUSIC_FADE);
      players.push(current);
    } catch {
      current = null;
    }
  }
  // 快速连切时限制并存的淡出曲目（最多 2 首），更早的加速淡完，避免排程量叠加
  const fading = players.filter(p => p.stopping);
  for (let i = 0; i < fading.length - 2; i++) fading[i].fadeOut(now, 0.12, true);
  pump();
  if (players.length && timer === null) timer = setInterval(pump, TICK_MS);
}

/** 切换背景氛围音乐：'title' | 'city' | 'dungeon:<theme>' | 'boss' | 'arena' | 'none' */
export function setMusic(track: string): void {
  wantTrack = resolveTrack(track);
  if (!graph) autoInit();
  if (graph) applyMusic(graph); // 还没有上下文：记住，创建后自动开始
}

/** 当前请求的曲目（规整后的名字） */
export function getMusic(): string {
  return wantTrack;
}

/** 手动推进一次音乐调度（测试/调试；正常由内部定时器驱动） */
export function pumpMusic(): void {
  pump();
}

// ———————————————————————————— 音量 ————————————————————————————

export function setVolume(master: number, music: number, sfx: number): void {
  const cur = volumes();
  const pick = (x: number, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? clamp(x, 0, 1) : d);
  const next: Volume = { master: pick(master, cur.master), music: pick(music, cur.music), sfx: pick(sfx, cur.sfx) };
  vol = next;
  saveVolumes(next);
  const g = graph;
  if (g) {
    const t = g.ctx.currentTime;
    // 平滑过渡，拖动滑条时不出“拉链”噪声
    for (const [p, v] of [[g.master.gain, next.master], [g.music.gain, next.music], [g.sfx.gain, next.sfx]] as const) {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(v, t, 0.03);
    }
  }
}

export function getVolume(): { master: number; music: number; sfx: number } {
  return { ...volumes() };
}

// ———————————————————————————— 调试 / 生命周期 ————————————————————————————

export function audioStatus(): AudioStatus {
  if (!audioCtor()) return 'unsupported';
  if (!graph) return 'idle';
  const st = graph.ctx.state as string;
  return st === 'running' ? 'running' : st === 'closed' ? 'closed' : 'suspended';
}

export function sfxStats(): { played: number; limited: number; culled: number; dropped: number; voices: number } {
  const now = graph ? graph.ctx.currentTime : 0;
  return { ...stats, voices: voiceEnds.filter(e => e > now).length };
}

export function musicStats(): { track: string; players: number; notes: number; timer: boolean } {
  return { track: curTrack, players: players.length, notes: players.reduce((s, p) => s + p.notes, 0), timer: timer !== null };
}

/** 设置调试监听（null 取消） */
export function tapSfx(fn: SfxTap | null): void {
  tap = fn;
}

/** 关闭上下文并清空全部状态（测试 / 热更新） */
export function resetAudio(): void {
  stopTimer();
  for (const p of players) p.dispose();
  players = [];
  current = null;
  curTrack = 'none';
  wantTrack = 'none';
  if (graph) {
    const c = graph.ctx;
    graph = null;
    try {
      quiet(c.close());
    } catch {
      /* 忽略 */
    }
  }
  unlisten();
  recent.clear();
  voiceEnds = [];
  stats.played = stats.limited = stats.culled = stats.dropped = 0;
  vol = null;
  autoSuspended = false;
  resumeAskedAt = -Infinity;
  expChain = 0;
  expLastT = -Infinity;
  tap = null;
}

// Vite 热更新：旧模块的上下文与定时器一并释放
if (import.meta.hot) import.meta.hot.dispose(() => resetAudio());
