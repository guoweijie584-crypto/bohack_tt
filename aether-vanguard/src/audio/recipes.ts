// 程序化音效配方：每个 SfxName 一个合成函数（振荡器 + 噪声 + 包络 + 滤波 + 扫频），复古像素质感、短促有力。
// Record<SfxName, …> 保证新增音效名时编译期就会报“缺配方”。
// 频率都写“基准值”，播放时整体乘音高倍率（含 ±5% 随机化）；时间单位为秒。

import { Rng } from '../core/rng';
import type { ElementId } from '../data/types';
import type { SfxName } from '../game/types';
import type { Voice } from './synth';

export type Recipe = (v: Voice) => void;

export interface SfxMeta {
  /** 同名音效每秒最多播放次数（1 秒滑动窗口） */
  max: number;
  /** 同名最小间隔（秒）：同一瞬间的重复只保留一次，避免相位叠加爆音 */
  gap: number;
  /** 音高随机化幅度（±比例）；旋律性提示音调小，避免与音乐跑调 */
  jit: number;
  /** 基础增益（响度平衡，离线渲染测量后校准） */
  gain: number;
  /** 优先音：不受复音上限裁剪 */
  prio?: boolean;
}

/** 音效细节随机（噼啪/气泡时序），与战斗随机流分开 */
const rr = new Rng();

// —— 和弦/音阶常用频率（Hz） ——
const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.5, G6 = 1567.98;

/** 铁砧/金属：非谐分音（1 : 2.52 : 4.29 : 5.96），像真实金属块而不是乐音 */
const ANVIL: ReadonlyArray<readonly [number, number, number]> = [
  [523, 0.1, 0.7],
  [1318, 0.07, 0.5],
  [2242, 0.05, 0.35],
  [3117, 0.035, 0.25],
];

export const RECIPES: Record<SfxName, Recipe> = {
  // ———————————————— 武器 ————————————————
  /** 轻武器挥砍：白噪声带通由低到高扫频（“咻”） */
  swing: v => {
    v.noise({ ft: 'bandpass', ff: 650, ff1: 2900, q: 2.4, a: 0.025, d: 0.1, v: 0.55 });
    v.tone({ w: 'triangle', f: 480, f1: 210, a: 0.004, d: 0.07, v: 0.06 });
  },
  /** 重武器：更低更长的风声 + 布朗噪声 + 低频体感 */
  swingHeavy: v => {
    v.noise({ ft: 'bandpass', ff: 260, ff1: 1250, fsw: 0.16, q: 1.3, a: 0.04, d: 0.18, v: 0.6 });
    v.noise({ k: 'brown', ft: 'lowpass', ff: 420, a: 0.03, d: 0.2, v: 0.45 });
    v.tone({ w: 'triangle', f: 140, f1: 52, a: 0.012, d: 0.2, v: 0.32 });
  },
  /** 匕首突刺：极短的高频气流 + 金属尖音 */
  stab: v => {
    v.noise({ ft: 'bandpass', ff: 2400, ff1: 5600, q: 3.2, a: 0.004, d: 0.055, v: 0.5 });
    v.tone({ w: 'square', f: 1250, f1: 1900, a: 0.002, d: 0.03, v: 0.045, ft: 'lowpass', ff: 5000 });
  },
  /** 弓：锯齿波 + 迅速闭合的低通 = 拨弦；再叠一声箭矢离弦的气流 */
  bow: v => {
    v.tone({ w: 'sawtooth', f: 330, f1: 310, a: 0.002, d: 0.2, v: 0.2, ft: 'lowpass', ff: 3600, ff1: 300, q: 2 });
    v.tone({ w: 'triangle', f: 660, f1: 620, a: 0.002, d: 0.09, v: 0.07 });
    v.noise({ ft: 'bandpass', ff: 4400, ff1: 1500, q: 1.6, t: 0.012, a: 0.005, d: 0.07, v: 0.26 });
  },

  // ———————————————— 施法 / 元素 ————————————————
  /** 通用施法：上行双音 + 颤音 + 高频闪烁 */
  cast: v => {
    v.tone({ w: 'square', f: 330, f1: 990, sw: 0.15, a: 0.01, d: 0.2, v: 0.07, ft: 'lowpass', ff: 2600 });
    v.tone({ w: 'triangle', f: 495, f1: 1485, sw: 0.15, t: 0.03, a: 0.01, d: 0.22, v: 0.09, vib: [9, 30] });
    v.noise({ ft: 'bandpass', ff: 2500, ff1: 7000, q: 5, a: 0.04, d: 0.18, v: 0.12 });
  },
  /** 火焰：低沉呼啸（布朗噪声低通张开）+ 随机噼啪 */
  fire: v => {
    v.noise({ k: 'brown', ft: 'lowpass', ff: 300, ff1: 2600, fsw: 0.12, a: 0.03, h: 0.05, d: 0.28, v: 0.7 });
    v.noise({ ft: 'bandpass', ff: 900, ff1: 400, q: 0.9, a: 0.02, d: 0.3, v: 0.25 });
    v.tone({ w: 'sawtooth', f: 110, f1: 55, a: 0.02, d: 0.3, v: 0.1, ft: 'lowpass', ff: 600 });
    for (let i = 0; i < 4; i++) {
      v.noise({ k: 'crunch', ft: 'highpass', ff: 2200, t: 0.04 + rr.range(0, 0.26), a: 0.002, d: 0.025, v: 0.22, rate: rr.range(0.6, 1.4) });
    }
  },
  /** 冰霜：清脆的晶体高音（五度叠加）+ 碎裂声 */
  ice: v => {
    v.tone({ w: 'sine', f: 2093, f1: 2000, a: 0.003, d: 0.32, v: 0.11 });
    v.tone({ w: 'sine', f: 3136, f1: 3050, t: 0.025, a: 0.003, d: 0.26, v: 0.07 });
    v.tone({ w: 'triangle', f: 1046, f1: 830, a: 0.003, d: 0.12, v: 0.1 });
    v.tone({ w: 'square', f: 2600, f1: 1300, a: 0.001, d: 0.03, v: 0.04 });
    v.noise({ ft: 'highpass', ff: 5200, a: 0.003, d: 0.12, v: 0.22 });
  },
  /** 雷电：急速下扫方波 + 电流嗡鸣（震音锯齿）+ 碎噪 */
  zap: v => {
    v.tone({ w: 'square', f: 1900, f1: 110, sw: 0.16, a: 0.002, d: 0.18, v: 0.13, ft: 'lowpass', ff: 6000 });
    v.tone({ w: 'sawtooth', f: 62, a: 0.005, d: 0.2, v: 0.12, trem: [38, 0.5] });
    v.noise({ k: 'crunch', ft: 'highpass', ff: 1800, a: 0.002, d: 0.11, v: 0.32, rate: 1.3 });
  },
  /** 剧毒：咕噜气泡（上扫三角波）+ 酸性嘶声 */
  poison: v => {
    for (let i = 0; i < 3; i++) {
      const f = rr.range(240, 340);
      v.tone({ w: 'triangle', f, f1: f * 2.4, t: i * 0.065 + rr.range(0, 0.02), a: 0.004, d: 0.05, v: 0.12 });
    }
    v.noise({ ft: 'bandpass', ff: 1300, ff1: 700, q: 3, a: 0.03, d: 0.26, v: 0.14 });
  },
  /** 奥术：带颤音的五度和声 + 上行气旋 + 高 Q 闪烁 */
  arcane: v => {
    v.tone({ w: 'sine', f: 880, f1: 830, a: 0.02, d: 0.4, v: 0.08, vib: [7, 18] });
    v.tone({ w: 'sine', f: 1318, f1: 1245, t: 0.02, a: 0.02, d: 0.36, v: 0.06, vib: [7.5, 18] });
    v.tone({ w: 'triangle', f: 1760, t: 0.04, a: 0.01, d: 0.25, v: 0.04 });
    v.tone({ w: 'square', f: 220, f1: 660, sw: 0.18, a: 0.01, d: 0.16, v: 0.035, ft: 'lowpass', ff: 1800 });
    v.noise({ ft: 'bandpass', ff: 1800, ff1: 6200, q: 8, a: 0.05, d: 0.25, v: 0.1 });
  },
  /** 机械：激光“咻” + 伺服嗡鸣 + 机括咔哒 */
  tech: v => {
    v.tone({ w: 'square', f: 1700, f1: 260, sw: 0.12, a: 0.002, d: 0.13, v: 0.11, ft: 'lowpass', ff: 4500 });
    v.tone({ w: 'sawtooth', f: 380, f1: 820, lin: true, a: 0.005, d: 0.1, v: 0.06, ft: 'lowpass', ff: 2200 });
    v.noise({ ft: 'highpass', ff: 4200, a: 0.001, d: 0.02, v: 0.32 });
  },

  // ———————————————— 受击 / 击杀 ————————————————
  /** 受击：闷击噪声 + 低频冲击 + 一下咔哒（元素版本另叠 elementAccent） */
  hit: v => {
    v.noise({ ft: 'lowpass', ff: 2000, ff1: 380, a: 0.001, d: 0.075, v: 0.55 });
    v.tone({ w: 'triangle', f: 170, f1: 58, a: 0.002, d: 0.085, v: 0.42 });
    v.tone({ w: 'square', f: 1300, a: 0.001, d: 0.012, v: 0.07 });
  },
  /** 暴击：比受击更亮（带通脆响 + 高频“叮”）也更重（更低更长的冲击） */
  crit: v => {
    v.noise({ ft: 'lowpass', ff: 3200, ff1: 420, a: 0.001, d: 0.11, v: 0.62 });
    v.noise({ ft: 'bandpass', ff: 2600, q: 1.2, a: 0.001, d: 0.05, v: 0.45 });
    v.tone({ w: 'sine', f: 120, f1: 38, a: 0.002, d: 0.2, v: 0.6 });
    v.tone({ w: 'square', f: 1500, f1: 760, a: 0.001, d: 0.06, v: 0.1, ft: 'lowpass', ff: 5000 });
    v.tone({ w: 'sine', f: 2637, t: 0.015, a: 0.002, d: 0.14, v: 0.07 });
  },
  /** 玩家受伤：下滑方波“哎” + 闷击 */
  hurt: v => {
    v.tone({ w: 'square', f: 440, f1: 170, a: 0.003, d: 0.16, v: 0.13, ft: 'lowpass', ff: 2200 });
    v.tone({ w: 'triangle', f: 230, f1: 110, a: 0.003, d: 0.17, v: 0.2 });
    v.noise({ ft: 'lowpass', ff: 1600, a: 0.001, d: 0.08, v: 0.38 });
  },
  /** 击杀：下扫“啾” + 噗的一声烟 */
  kill: v => {
    v.tone({ w: 'square', f: 720, f1: 110, sw: 0.2, a: 0.002, d: 0.22, v: 0.1, ft: 'lowpass', ff: 2600 });
    v.noise({ ft: 'bandpass', ff: 1600, ff1: 380, q: 1.1, a: 0.002, d: 0.2, v: 0.42 });
    v.tone({ w: 'triangle', f: 190, f1: 60, a: 0.002, d: 0.15, v: 0.25 });
  },
  /** 首领咆哮：双锯齿下滑（颤音 + 震音）+ 布朗噪声隆隆 + 喉音 */
  bossRoar: v => {
    v.tone({ w: 'sawtooth', f: 118, f1: 52, a: 0.09, h: 0.25, d: 0.9, v: 0.22, ft: 'lowpass', ff: 900, ff1: 300, vib: [6, 40], trem: [11, 0.3] });
    v.tone({ w: 'sawtooth', f: 87, f1: 41, a: 0.1, h: 0.25, d: 0.9, v: 0.18, det: 15, ft: 'lowpass', ff: 700 });
    v.noise({ k: 'brown', ft: 'lowpass', ff: 650, ff1: 200, a: 0.06, h: 0.2, d: 0.85, v: 0.55 });
    v.noise({ ft: 'bandpass', ff: 820, ff1: 420, q: 1.2, a: 0.08, h: 0.15, d: 0.7, v: 0.22 });
  },
  /** 爆炸：低频冲击（正弦下坠）+ 布朗噪声长衰减 + 8-bit 碎裂 */
  explosion: v => {
    v.tone({ w: 'sine', f: 125, f1: 30, a: 0.003, d: 0.5, v: 0.75 });
    v.noise({ k: 'brown', ft: 'lowpass', ff: 3200, ff1: 160, a: 0.003, d: 0.75, v: 0.9 });
    v.noise({ k: 'crunch', ft: 'bandpass', ff: 1100, q: 0.7, a: 0.002, d: 0.22, v: 0.35, rate: 0.7 });
  },

  // ———————————————— 移动 ————————————————
  /** 冲刺：快速上扫风声 + 复古“嗖” */
  dash: v => {
    v.noise({ ft: 'bandpass', ff: 1100, ff1: 4200, fsw: 0.1, q: 1.8, a: 0.03, d: 0.1, v: 0.5 });
    v.tone({ w: 'square', f: 240, f1: 760, sw: 0.08, a: 0.003, d: 0.08, v: 0.05, ft: 'lowpass', ff: 3000 });
  },
  /** 脚步：很轻的低通噪声 + 低频“咚” */
  step: v => {
    v.noise({ ft: 'lowpass', ff: 850, a: 0.002, d: 0.045, v: 0.18 });
    v.tone({ w: 'sine', f: 115, f1: 70, a: 0.002, d: 0.04, v: 0.1 });
  },

  // ———————————————— 拾取 ————————————————
  /** 金币：经典“叮叮”两音（B5 → E6） */
  pickupCoin: v => {
    v.tone({ w: 'square', f: 988, a: 0.002, h: 0.04, d: 0.03, v: 0.07, ft: 'lowpass', ff: 6000 });
    v.tone({ w: 'square', f: 1319, t: 0.07, a: 0.002, h: 0.05, d: 0.16, v: 0.07, ft: 'lowpass', ff: 6000 });
    v.tone({ w: 'triangle', f: 1319, t: 0.07, a: 0.002, d: 0.18, v: 0.05 });
  },
  /** 经验：柔和上扫“啵”（连续拾取时音高递升，见 sfx.ts） */
  pickupExp: v => {
    v.tone({ w: 'sine', f: 660, f1: 1320, sw: 0.07, a: 0.003, d: 0.09, v: 0.12 });
    v.tone({ w: 'triangle', f: 1320, t: 0.04, a: 0.003, d: 0.08, v: 0.05 });
  },
  /** 装备：咔哒 + 上行两音 + 亮点 */
  pickupItem: v => {
    v.noise({ ft: 'highpass', ff: 3000, a: 0.001, d: 0.025, v: 0.22 });
    v.tone({ w: 'square', f: 392, f1: 784, sw: 0.05, a: 0.002, d: 0.06, v: 0.08, ft: 'lowpass', ff: 3200 });
    v.tone({ w: 'triangle', f: C6, t: 0.06, a: 0.003, h: 0.03, d: 0.14, v: 0.11 });
    v.tone({ w: 'square', f: G6, t: 0.09, a: 0.002, d: 0.1, v: 0.035, ft: 'lowpass', ff: 5000 });
  },
  /** 药水：咕嘟咕嘟（三个上扫气泡）+ 液体晃动 + 回复闪光 */
  potion: v => {
    for (let i = 0; i < 3; i++) {
      const f = 170 + i * 40 + rr.range(-10, 10);
      v.tone({ w: 'sine', f, f1: f * 2.3, t: i * 0.1, a: 0.006, d: 0.07, v: 0.2 });
    }
    v.noise({ ft: 'lowpass', ff: 700, a: 0.04, h: 0.1, d: 0.2, v: 0.12 });
    v.tone({ w: 'sine', f: C6, f1: G6, t: 0.3, a: 0.01, d: 0.18, v: 0.06 });
  },

  // ———————————————— 成长 / 场景 ————————————————
  /** 升级：C 大调上行琶音 + 持续和弦闪光 */
  levelup: v => {
    [C5, E5, G5, C6, E6].forEach((f, i) => {
      v.tone({ w: 'square', f, t: i * 0.07, a: 0.003, h: 0.03, d: 0.12, v: 0.06, ft: 'lowpass', ff: 4500 });
    });
    [C6, E6, G6].forEach((f, i) => {
      v.tone({ w: 'triangle', f, t: 0.36 + i * 0.012, a: 0.01, h: 0.15, d: 0.5, v: 0.07, vib: [6, 8] });
    });
    v.noise({ ft: 'highpass', ff: 6500, t: 0.34, a: 0.05, d: 0.45, v: 0.08 });
  },
  /** 宝箱：木头吱呀 + 箱盖落定 + 闪光琶音 */
  chest: v => {
    v.noise({ ft: 'bandpass', ff: 640, ff1: 320, q: 5, a: 0.02, d: 0.24, v: 0.18 });
    v.tone({ w: 'sawtooth', f: 150, f1: 95, a: 0.003, d: 0.12, v: 0.1, ft: 'lowpass', ff: 700 });
    [G5, 988, 1175, G6].forEach((f, i) => {
      v.tone({ w: 'triangle', f, t: 0.16 + i * 0.055, a: 0.003, d: 0.22, v: 0.09 });
    });
    v.noise({ ft: 'highpass', ff: 6000, t: 0.16, a: 0.03, d: 0.3, v: 0.07 });
  },
  /** 传送阵：共鸣扫频——锯齿波过高 Q 带通，中心频率上扫再回落 */
  portal: v => {
    v.tone({ w: 'sawtooth', f: 110, a: 0.08, h: 0.3, d: 0.6, v: 0.32, ft: 'bandpass', ff: 220, ff1: 2600, fsw: 0.55, q: 14 });
    v.tone({ w: 'sawtooth', f: 165, det: 7, a: 0.1, h: 0.25, d: 0.6, v: 0.18, ft: 'bandpass', ff: 2600, ff1: 300, fsw: 0.9, q: 10 });
    v.tone({ w: 'sine', f: 440, f1: 880, a: 0.15, h: 0.2, d: 0.55, v: 0.06, vib: [5, 20] });
    v.noise({ ft: 'bandpass', ff: 300, ff1: 3200, q: 6, a: 0.2, h: 0.2, d: 0.5, v: 0.14 });
  },
  /** 门：门轴吱呀（震音锯齿过带通）+ 关门闷响 */
  door: v => {
    v.tone({ w: 'sawtooth', f: 230, f1: 165, lin: true, a: 0.03, h: 0.12, d: 0.12, v: 0.06, ft: 'bandpass', ff: 900, q: 3, trem: [18, 0.45] });
    v.tone({ w: 'sine', f: 95, f1: 50, t: 0.24, a: 0.002, d: 0.12, v: 0.38 });
    v.noise({ ft: 'lowpass', ff: 650, t: 0.24, a: 0.002, d: 0.1, v: 0.32 });
  },

  // ———————————————— 界面 ————————————————
  /** 界面点击：短促方波“嘀” */
  ui: v => {
    v.tone({ w: 'square', f: 1180, a: 0.001, d: 0.035, v: 0.06, ft: 'lowpass', ff: 4200 });
    v.tone({ w: 'triangle', f: 2360, a: 0.001, d: 0.022, v: 0.035 });
  },
  /** 拒绝/失败：低沉双音“嗯嗯” */
  uiDeny: v => {
    v.tone({ w: 'square', f: 185, a: 0.002, h: 0.05, d: 0.04, v: 0.09, ft: 'lowpass', ff: 1500 });
    v.tone({ w: 'square', f: 139, t: 0.11, a: 0.002, h: 0.07, d: 0.07, v: 0.09, ft: 'lowpass', ff: 1500 });
  },
  /** 购买：收银“叮——铛” */
  buy: v => {
    v.noise({ ft: 'highpass', ff: 5000, a: 0.001, d: 0.05, v: 0.18 });
    v.tone({ w: 'triangle', f: G5, a: 0.002, d: 0.09, v: 0.1 });
    v.tone({ w: 'square', f: G6, t: 0.05, a: 0.002, h: 0.02, d: 0.06, v: 0.06, ft: 'lowpass', ff: 6000 });
    v.tone({ w: 'square', f: 2093, t: 0.11, a: 0.002, h: 0.04, d: 0.2, v: 0.06, ft: 'lowpass', ff: 6000 });
  },
  /** 锻造：铁砧敲击（非谐分音 + 撞击咔哒 + 闷响），随后一下较轻的回弹 */
  forge: v => {
    const strike = (t: number, k: number): void => {
      v.noise({ ft: 'highpass', ff: 2800, t, a: 0.001, d: 0.03, v: 0.45 * k });
      v.tone({ w: 'sine', f: 150, f1: 80, t, a: 0.001, d: 0.08, v: 0.3 * k });
      for (const [f, g, d] of ANVIL) v.tone({ w: 'sine', f, t, a: 0.001, d: k < 1 ? d * 0.6 : d, v: g * k });
      v.tone({ w: 'square', f: C6, t, a: 0.001, d: 0.05, v: 0.04 * k, ft: 'bandpass', ff: 2000, q: 4 });
    };
    strike(0, 1);
    strike(0.16, 0.45);
  },

  // ———————————————— 增益 / 状态 ————————————————
  /** 护盾：上扫“嗡”+ 高频光泽 */
  shield: v => {
    v.tone({ w: 'triangle', f: 330, f1: 660, sw: 0.18, a: 0.01, h: 0.08, d: 0.25, v: 0.12, vib: [12, 14] });
    v.tone({ w: 'sine', f: 990, t: 0.05, a: 0.03, h: 0.1, d: 0.3, v: 0.07 });
    v.tone({ w: 'square', f: 165, f1: 330, a: 0.01, d: 0.22, v: 0.04, ft: 'lowpass', ff: 1200 });
    v.noise({ ft: 'bandpass', ff: 2600, q: 5, a: 0.04, d: 0.25, v: 0.1 });
  },
  /** 潜行：渐强后下滑的风声（像隐入阴影） */
  stealth: v => {
    v.noise({ ft: 'bandpass', ff: 3200, ff1: 500, q: 2, a: 0.14, d: 0.32, v: 0.26 });
    v.tone({ w: 'sine', f: 880, f1: 220, a: 0.08, d: 0.38, v: 0.06, vib: [8, 25] });
  },
  /** 召唤：低沉上行和声 + 涌起的噪声 + 落定“啵” */
  summon: v => {
    v.tone({ w: 'sawtooth', f: 110, f1: 220, sw: 0.45, a: 0.12, h: 0.15, d: 0.25, v: 0.12, ft: 'lowpass', ff: 500, ff1: 1800 });
    v.tone({ w: 'square', f: 165, f1: 330, sw: 0.45, a: 0.12, h: 0.15, d: 0.25, v: 0.05, ft: 'lowpass', ff: 1200 });
    v.noise({ ft: 'bandpass', ff: 400, ff1: 2200, q: 2, a: 0.2, h: 0.1, d: 0.2, v: 0.2 });
    v.tone({ w: 'sine', f: 660, f1: 990, t: 0.42, a: 0.003, d: 0.12, v: 0.1 });
  },

  // ———————————————— 结局 ————————————————
  /** 玩家死亡：下行四音（G4 E4 C4 G3），最后一音拖长下坠 */
  death: v => {
    [392, 330, 262].forEach((f, i) => {
      v.tone({ w: 'square', f, t: i * 0.16, a: 0.004, h: 0.08, d: 0.07, v: 0.07, ft: 'lowpass', ff: 2400 });
    });
    v.tone({ w: 'square', f: 196, f1: 150, sw: 0.7, t: 0.48, a: 0.004, h: 0.25, d: 0.55, v: 0.07, ft: 'lowpass', ff: 2400, vib: [5, 20] });
    v.tone({ w: 'triangle', f: 98, f1: 49, t: 0.48, a: 0.02, h: 0.2, d: 0.7, v: 0.22 });
    v.noise({ ft: 'lowpass', ff: 420, t: 0.48, a: 0.1, d: 0.7, v: 0.1 });
  },
  /** 胜利：短号角 G4-C5-E5 → C 大三和弦长音 + 低音 */
  victory: v => {
    [392, C5, E5].forEach((f, i) => {
      v.tone({ w: 'square', f, t: i * 0.09, a: 0.003, h: 0.04, d: 0.05, v: 0.06, ft: 'lowpass', ff: 3800 });
    });
    [C5, E5, G5, C6].forEach((f, i) => {
      const t = 0.3 + i * 0.015;
      v.tone({ w: 'square', f, t, a: 0.006, h: 0.45, d: 0.6, v: 0.045, ft: 'lowpass', ff: 3200, vib: [5.5, 7] });
      v.tone({ w: 'triangle', f, t, a: 0.006, h: 0.45, d: 0.7, v: 0.05 });
    });
    v.tone({ w: 'triangle', f: 130.81, t: 0.3, a: 0.01, h: 0.4, d: 0.6, v: 0.2 });
    v.noise({ ft: 'highpass', ff: 6000, t: 0.3, a: 0.04, d: 0.6, v: 0.07 });
  },
};

/** 元素点缀：叠在受击/暴击/爆炸上，让不同元素的命中听起来不一样。k 为时长倍率，t 为起始偏移 */
export function elementAccent(v: Voice, el: ElementId, k = 1, t = 0): void {
  switch (el) {
    case 'fire': // 噼啪 + 低沉呼
      v.noise({ k: 'crunch', ft: 'highpass', ff: 2400, t, a: 0.002, d: 0.06 * k, v: 0.25, rate: 0.9 });
      v.tone({ w: 'sawtooth', f: 220, f1: 85, t, a: 0.003, d: 0.08 * k, v: 0.07, ft: 'lowpass', ff: 1400 });
      break;
    case 'ice': // 玻璃般的“叮” + 碎冰
      v.tone({ w: 'sine', f: 2650, f1: 2250, t, a: 0.002, d: 0.1 * k, v: 0.08 });
      v.noise({ ft: 'highpass', ff: 6000, t, a: 0.001, d: 0.045 * k, v: 0.2 });
      break;
    case 'lightning': // 电弧
      v.tone({ w: 'square', f: 2400, f1: 300, t, a: 0.001, d: 0.06 * k, v: 0.07, ft: 'lowpass', ff: 6000 });
      v.noise({ k: 'crunch', ft: 'bandpass', ff: 3500, q: 1.2, t, a: 0.001, d: 0.05 * k, v: 0.26, rate: 1.5 });
      break;
    case 'poison': // 黏糊的“啵”
      v.tone({ w: 'triangle', f: 250, f1: 560, t: t + 0.01, a: 0.004, d: 0.07 * k, v: 0.12 });
      v.noise({ ft: 'lowpass', ff: 900, t, a: 0.003, d: 0.07 * k, v: 0.18 });
      break;
    case 'arcane': // 颤动的魔法余音
      v.tone({ w: 'sine', f: 1400, t, a: 0.004, d: 0.13 * k, v: 0.06, vib: [14, 30] });
      v.tone({ w: 'sine', f: 2100, t: t + 0.012, a: 0.004, d: 0.1 * k, v: 0.04 });
      break;
    case 'tech': // 金属“铛”
      v.tone({ w: 'square', f: 3200, t, a: 0.001, d: 0.016, v: 0.05 });
      v.noise({ ft: 'bandpass', ff: 4200, q: 12, t, a: 0.001, d: 0.07 * k, v: 0.3 });
      break;
    case 'physical':
      break;
  }
}

/** M(每秒上限, 最小间隔, 增益, 音高随机幅度, 优先) */
const M = (max: number, gap: number, gain = 1, jit = 0.05, prio = false): SfxMeta => ({ max, gap, gain, jit, prio });

/**
 * 限速与响度表。gain 由无头 Chrome 离线渲染（OfflineAudioContext）测量 RMS 后校准，目标响度（有效段 RMS）：
 * 战斗核心（受击/暴击/击杀/爆炸）≈0.075–0.11，暴击明显重于受击；元素施法 ≈0.05；拾取/界面 ≈0.03–0.045；脚步 ≈0.02。
 */
export const SFX_META: Record<SfxName, SfxMeta> = {
  swing: M(12, 0.04, 1.8),
  swingHeavy: M(8, 0.06, 0.9),
  stab: M(14, 0.03, 1.8),
  bow: M(10, 0.05, 1.2),
  cast: M(8, 0.06, 1.8),
  fire: M(8, 0.05, 0.7),
  ice: M(8, 0.05, 1.2),
  zap: M(8, 0.05, 0.9),
  poison: M(8, 0.05, 2.4),
  arcane: M(8, 0.05, 1.9),
  tech: M(10, 0.05, 1.1),
  hit: M(14, 0.03, 0.9),
  crit: M(8, 0.05, 0.75),
  hurt: M(6, 0.12, 1.3),
  kill: M(10, 0.04, 1.15),
  bossRoar: M(2, 0.8, 1.1, 0.05, true),
  explosion: M(8, 0.05, 0.75),
  dash: M(6, 0.08, 1.4),
  pickupCoin: M(12, 0.04, 0.9),
  pickupExp: M(16, 0.03, 1.1, 0.015),
  pickupItem: M(8, 0.06, 1.15),
  potion: M(4, 0.2, 1.3),
  levelup: M(3, 0.5, 1.5, 0, true),
  chest: M(4, 0.15, 1.8, 0.03, true),
  portal: M(3, 0.3, 1.6, 0.03, true),
  door: M(4, 0.15, 1),
  ui: M(20, 0.025, 1.3, 0.01, true),
  uiDeny: M(6, 0.1, 0.8, 0.01, true),
  buy: M(6, 0.08, 1.3, 0.01, true),
  forge: M(6, 0.1, 0.9),
  shield: M(4, 0.15, 1),
  stealth: M(4, 0.15, 1.6),
  summon: M(4, 0.15, 1),
  // 结局类提示音：显式 sfx 与 ui:'dead' 等推导事件可能隔几帧先后到达，长间隔防止叠播
  death: M(1, 3, 1.1, 0, true),
  victory: M(1, 2, 0.8, 0, true),
  step: M(8, 0.08, 0.6),
};
