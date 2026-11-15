// 游戏内 HUD（G.mode==='play' / 'dead' 时显示）：
// 左上红蓝双半环血球（canvas 逐像素）+ 数值/经验/金币/药水/材料/buff；底部技能栏（冷却遮罩 CSS 变量每帧更新）；
// 右上小地图 + 区域名 + 首领提示；顶部首领多层血条；底部交互提示；左下操作提示；面板快捷按钮。
// 文本类内容 ~10Hz 节流，只在值变化时写 DOM。

import { MAX_LEVEL } from '../config';
import { clamp, esc, fmt } from '../core/util';
import { clsOf } from '../data/classes';
import { ELEM, STATUS } from '../data/elements';
import { SKILLS, ULTS } from '../data/skills';
import { ROUTES } from '../data/trees';
import type { SkillDef } from '../data/types';
import { MAT_NAMES } from '../game/items';
import { fuseOptions, skillsOf } from '../game/player';
import { skillCooldown } from '../game/skills';
import { getTrial, type TrialView } from '../game/world';
import { G } from '../game/state';
import type { Enemy, MaterialId, PanelName, Player, StatusId } from '../game/types';
import { iconHtml, skinUrl } from './bridge';
import { el, q, replayClass, setHtml, setText, setVar, show, toggleClass } from './dom';
import { registerTip } from './feedback';
import { classIconCanvas, ico, type IconName, routeIcon, skillIcon, statusIcon, weaponIcon } from './icons';
import { BOSS_UNKNOWN_TEXT, type BossHint, bossDiscovered, MiniMap } from './minimap';
import { C_GOOD, cssColor, ensureAudio, safe, sfx, ui } from './shared';
import { fmtClock, kc, WEAPON_NAME, zoneName } from './text';

/* ------------------------------------------------------------------ */
/* 血球：56×56 逐像素（CSS 2 倍），左半红（生命，自下而上）右半蓝（源能，自上而下）  */
/* ------------------------------------------------------------------ */
const OS = 56, OC = 28;
type RGBA = readonly [number, number, number, number];
const hex = (h: string, a = 255): RGBA => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};
const OC_ = {
  out: hex('#140d09'), frHi: hex('#9a8a7c'), frMid: hex('#6f6259'), frLo: hex('#44392f'), frFlash: hex('#e0d0bc'),
  bg: hex('#1e1510'), center: hex('#2a1b12'),
  hp: hex('#df5f57'), hpL: hex('#f49a8c'), hpD: hex('#a33c35'), hpBlink: hex('#ff8a7a'), hpTrack: hex('#3a1c1a'), hpTick: hex('#52281f'),
  mp: hex('#5fa9d8'), mpL: hex('#a6dcf5'), mpD: hex('#2f6f9a'), mpTrack: hex('#16303f'), mpTick: hex('#21445a'),
  sh: hex('#7fd6c4'), shL: hex('#c4f2e8'),
  none: [0, 0, 0, 0] as RGBA,
};
// 几何预计算：每像素所属区域
const Z = { None: 0, Out: 1, Frame: 2, Shield: 3, Ring: 4, Gap: 5, Inner: 6, Center: 7, Bg: 8 } as const;
interface OrbGeo { zone: Uint8Array; tt: Float32Array; left: Uint8Array; r: Float32Array; bevel: Int8Array }
let geo: OrbGeo | null = null;
function orbGeo(): OrbGeo {
  if (geo) return geo;
  const n = OS * OS;
  const g: OrbGeo = { zone: new Uint8Array(n), tt: new Float32Array(n), left: new Uint8Array(n), r: new Float32Array(n), bevel: new Int8Array(n) };
  for (let y = 0; y < OS; y++) for (let x = 0; x < OS; x++) {
    const i = y * OS + x;
    const dx = x + 0.5 - OC, dy = y + 0.5 - OC;
    const r = Math.hypot(dx, dy);
    const se = Math.pow(dx ** 4 + dy ** 4, 0.25); // 圆角方框（超椭圆）
    g.r[i] = r;
    g.bevel[i] = dx + dy < -8 ? 1 : dx + dy > 8 ? -1 : 0;
    let z: number;
    if (se > 27.4) z = Z.None;
    else if (se > 26.1) z = Z.Out;
    else if (se > 24.3) z = Z.Frame;
    else if (r >= 23 && r < 24.6) z = Z.Shield;
    else if (r >= 15.6 && r < 23) z = Math.abs(dx) < 1 ? Z.Gap : Z.Ring;
    else if (r >= 14.2 && r < 15.6) z = Z.Inner;
    else if (r < 14.2) z = Z.Center;
    else z = Z.Bg;
    g.zone[i] = z;
    if (z === Z.Ring) {
      const th = Math.atan2(dy, dx);
      if (dx < 0) {
        g.left[i] = 1;
        const t2 = th < 0 ? th + Math.PI * 2 : th; // [π/2, 3π/2]
        g.tt[i] = (t2 - Math.PI / 2) / Math.PI; // 0=底 → 1=顶
      } else {
        g.tt[i] = (th + Math.PI / 2) / Math.PI; // 0=顶 → 1=底
      }
    }
  }
  geo = g;
  return g;
}

/** 立绘遮罩成 28×28 圆形（像素级，无抗锯齿） */
function maskPortrait(src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 28; cv.height = 28;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.imageSmoothingEnabled = false;
  const dx = Math.floor((28 - sw) / 2);
  const dy = sh >= 24 ? 3 : Math.floor((28 - sh) / 2);
  ctx.drawImage(src, dx, dy);
  const img = ctx.getImageData(0, 0, 28, 28);
  const d = img.data;
  for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
    const i = (y * 28 + x) * 4;
    const inside = Math.hypot(x + 0.5 - 14, y + 0.5 - 14) < 14.2;
    if (!inside) { d[i + 3] = 0; continue; }
    if (d[i + 3] < 128) { d[i] = OC_.center[0]; d[i + 1] = OC_.center[1]; d[i + 2] = OC_.center[2]; d[i + 3] = 255; }
    else d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

class Orb {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly img: ImageData | null;
  private sig = '';
  private pKey = '';
  private pCanvas: HTMLCanvasElement | null = null;
  private pVer = 0;
  constructor(cv: HTMLCanvasElement) {
    cv.width = OS; cv.height = OS;
    this.ctx = cv.getContext('2d');
    this.img = this.ctx ? this.ctx.createImageData(OS, OS) : null;
  }
  /** 立绘：skinUrl 就绪用立绘，否则用职业徽记兜底；图片异步加载完成后重画 */
  private portrait(cid: string): HTMLCanvasElement | null {
    const url = skinUrl(cid);
    const key = `${cid}|${url.length}`;
    if (key === this.pKey) return this.pCanvas;
    this.pKey = key;
    const fb = classIconCanvas(cid);
    this.pCanvas = fb ? maskPortrait(fb, 16, 16) : null;
    this.pVer++;
    if (url) {
      const im = new Image();
      im.onload = (): void => {
        if (this.pKey !== key) return;
        this.pCanvas = maskPortrait(im, im.naturalWidth, im.naturalHeight);
        this.pVer++;
      };
      im.src = url;
    }
    return this.pCanvas;
  }
  draw(p: Player, t: number): void {
    if (!this.ctx || !this.img) return;
    const portrait = this.portrait(p.cid);
    const hpF = clamp(p.hp / Math.max(1, p.stat.maxHp), 0, 1);
    const mpF = clamp(p.mp / Math.max(1, p.stat.maxMp), 0, 1);
    const low = hpF > 0 && hpF < 0.3 && Math.floor(t * 4) % 2 === 0;
    const shieldOn = p.buffs.shield > 0 && !(p.buffs.shieldT > 0 && p.buffs.shieldT < 2 && Math.floor(t * 6) % 2 === 1);
    const inv = p.invuln > 0 && Math.floor(t * 10) % 2 === 0;
    const sig = `${Math.round(hpF * 300)}|${Math.round(mpF * 300)}|${low}|${shieldOn}|${inv}|${this.pVer}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const g = orbGeo();
    const d = this.img.data;
    for (let i = 0; i < OS * OS; i++) {
      let c: RGBA;
      switch (g.zone[i]) {
        case Z.None: c = OC_.none; break;
        case Z.Out: case Z.Gap: case Z.Inner: c = OC_.out; break;
        case Z.Frame: c = inv ? OC_.frFlash : g.bevel[i] > 0 ? OC_.frHi : g.bevel[i] < 0 ? OC_.frLo : OC_.frMid; break;
        case Z.Shield: c = shieldOn ? (g.bevel[i] > 0 ? OC_.shL : OC_.sh) : OC_.bg; break;
        case Z.Ring: {
          const left = g.left[i] === 1, tt = g.tt[i], r = g.r[i];
          const f = left ? hpF : mpF;
          const fr = (tt * 10) % 1;
          const tick = tt > 0.05 && tt < 0.95 && (fr < 0.07 || fr > 0.93);
          if (f > 0 && tt <= f) {
            if (left) c = tick ? OC_.hpD : r > 21.4 ? OC_.hpL : r < 17.2 ? OC_.hpD : low ? OC_.hpBlink : OC_.hp;
            else c = tick ? OC_.mpD : r > 21.4 ? OC_.mpL : r < 17.2 ? OC_.mpD : OC_.mp;
          } else {
            c = left ? (tick ? OC_.hpTick : OC_.hpTrack) : (tick ? OC_.mpTick : OC_.mpTrack);
          }
          break;
        }
        case Z.Center: c = OC_.center; break;
        default: c = OC_.bg;
      }
      const j = i * 4;
      d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = c[3];
    }
    this.ctx.putImageData(this.img, 0, 0);
    if (portrait) this.ctx.drawImage(portrait, OC - 14, OC - 14);
  }
}

/* ------------------------------------------------------------------ */
/* 技能栏                                                               */
/* ------------------------------------------------------------------ */
type SlotKey = 'atk' | 'q' | 'e' | 'r' | 'ult' | 'dash';
const SLOT_KEYS: readonly SlotKey[] = ['atk', 'q', 'e', 'r', 'ult', 'dash'];
const SLOT_LABEL: Record<SlotKey, string> = { atk: '左键', q: 'Q', e: 'E', r: 'R', ult: '右键', dash: '空格' };
interface SlotState { key: SlotKey; root: HTMLElement; cd: HTMLElement; txt: HTMLElement; max: number; prev: number; cost: number }

function playerSkills(p: Player): SkillDef[] {
  return safe(() => skillsOf(p), SKILLS[p.cid] ?? SKILLS.warrior);
}
function cdText(p: Player, base: number): string {
  return `${safe(() => skillCooldown(p, base), base).toFixed(1)}s`;
}

/** 技能格提示框 */
function skillTip(id: string): string | null {
  const p = G.player;
  if (!p) return null;
  const key = id as SlotKey;
  if (key === 'atk') {
    const w = p.equip.weapon;
    return `<div class="tt-n">普通攻击 <span class="dim">左键</span></div>`
      + `<div class="tt-s dim">${w ? esc(w.name) : esc(WEAPON_NAME[p.stat.weapon])} · ${esc(ELEM[p.stat.element]?.n ?? '')}</div>`
      + '<div>按住鼠标左键朝光标方向连续攻击</div>'
      + `<div class="dim">攻击间隔 ${p.stat.atkCd.toFixed(2)}s · 射程 ${Math.round(p.stat.range)}</div>`
      + `<div class="dim">点击此格或按 T 切换自动攻击（当前：${G.autoAttack ? '开' : '关'}）</div>`;
  }
  if (key === 'dash') {
    return '<div class="tt-n">冲刺 <span class="dim">空格</span></div><div>沿当前移动方向快速位移，冲刺途中短暂无敌</div>';
  }
  if (key === 'ult') {
    const u = p.ult ? ULTS[p.ult] : null;
    if (!u) return '<div class="tt-n">奥义（未解锁）</div><div class="dim">点亮技能树分支或路线的终极节点解锁；在技能面板选择，同时只能装备一个</div>';
    return `<div class="tt-n">${esc(u.n)} <span class="dim">右键</span></div>`
      + `<div class="tt-s dim">奥义 · ${esc(ELEM[u.el]?.n ?? '')}</div>`
      + `<div class="dim">伤害 ×${u.mult} · 冷却 ${cdText(p, u.cd)} · 源能 ${u.cost}</div>`;
  }
  const idx = key === 'q' ? 0 : key === 'e' ? 1 : 2;
  const sk = playerSkills(p)[idx];
  if (!sk) return null;
  return `<div class="tt-n">${esc(sk.n)} <span class="dim">${esc(sk.key)}</span></div>`
    + `<div class="tt-s dim">${esc(ELEM[sk.el]?.n ?? '')}</div><div>${esc(sk.d)}</div>`
    + `<div class="dim">伤害 ×${sk.mult} · 冷却 ${cdText(p, sk.cd)} · 源能 ${sk.cost}</div>`;
}

/* ------------------------------------------------------------------ */
/* HUD                                                                  */
/* ------------------------------------------------------------------ */
const QUICK: ReadonlyArray<{ panel: PanelName; icon: IconName; label: string; key: string }> = [
  { panel: 'char', icon: 'person', label: '角色', key: 'C' },
  { panel: 'bag', icon: 'bag', label: '背包', key: 'B' },
  { panel: 'skill', icon: 'tree', label: '技能', key: 'K' },
  { panel: 'fuse', icon: 'merge', label: '转职', key: 'P' },
  { panel: 'map', icon: 'map', label: '地图', key: 'M' },
  { panel: 'lore', icon: 'scroll', label: '日志', key: 'J' },
  { panel: 'help', icon: 'question', label: '帮助', key: 'H' },
];
const BAR_COLORS = ['#df5f57', '#e8a765', '#d8c25e', '#a3c979', '#5fa9d8', '#c29ae8'];

interface HudEls {
  root: HTMLElement;
  orbWrap: HTMLElement; orbLv: HTMLElement;
  name: HTMLElement; cls: HTMLElement; sub: HTMLElement;
  hpv: HTMLElement; mpv: HTMLElement;
  expFill: HTMLElement; expv: HTMLElement;
  gold: HTMLElement; potHp: HTMLElement; potMp: HTMLElement; mats: HTMLElement;
  buffs: HTMLElement;
  zone: HTMLElement; bossNote: HTMLElement;
  bossbar: HTMLElement; bbName: HTMLElement; bbLv: HTMLElement; bbPhase: HTMLElement; bbX: HTMLElement;
  bbUnder: HTMLElement; bbFill: HTMLElement; bbHp: HTMLElement; bbShield: HTMLElement; bbShieldFill: HTMLElement;
  hint: HTMLElement; controls: HTMLElement; skillbar: HTMLElement; quick: HTMLElement; trial: HTMLElement;
}

let els: HudEls | null = null;
let orb: Orb | null = null;
let mini: MiniMap | null = null;
let slots: SlotState[] = [];
let skillSig = '';
let iconRetryT = 0;
let slowT = 0;
let badgeT = 0;
let lastHint: BossHint | null = null;
const shieldMax = new Map<number, number>();

export function mountHud(root: HTMLElement): void {
  const h = el('div', 'hud');
  h.hidden = true;
  h.innerHTML = `
  <div class="hud-tl pxb glass">
    <div class="orb"><canvas class="orb-cv"></canvas><div class="orb-lv">Lv.1</div></div>
    <div class="hud-meta">
      <div class="hero"><b class="hn"></b> <span class="hc"></span></div>
      <div class="hero-sub dim"></div>
      <div class="nums"><span class="hp">生命</span> <b class="hpv"></b></div>
      <div class="nums"><span class="mp">源能</span> <b class="mpv"></b></div>
      <div class="expbar"><i class="exp-fill"></i><span class="expv"></span></div>
      <div class="res">
        <span class="r-item" data-tip="text:金币">${ico('coin', 1)}<b class="gold"></b></span>
        <span class="r-item" data-tip="text:生命药水（按 1 使用）">${ico('potion', 1, '#df5f57')}<b class="pot-hp"></b></span>
        <span class="r-item" data-tip="text:源能药水（按 2 使用）">${ico('potion', 1, '#5fa9d8')}<b class="pot-mp"></b></span>
      </div>
      <div class="res mats"></div>
      <div class="buffs"></div>
    </div>
  </div>
  <div class="hud-tr">
    <div class="mini pxb glass">
      <canvas class="mini-cv"></canvas>
      <div class="zone"></div>
      <div class="boss-note" hidden></div>
    </div>
    <div class="quick"></div>
  </div>
  <div class="bossbar" hidden>
    <div class="bb-head">${ico('skull', 1)}<b class="bb-name"></b><span class="bb-lv dim"></span><span class="bb-phase" hidden>二阶段</span><b class="bb-x"></b></div>
    <div class="bb-bar"><i class="bb-under"></i><i class="bb-fill"></i><span class="bb-hp"></span></div>
    <div class="bb-shield" hidden><i class="bb-shield-fill"></i></div>
  </div>
  <div class="trial pxb glass" hidden></div>
  <div class="hint" hidden></div>
  <div class="skillbar"></div>
  <div class="hud-bl pxb glass"></div>`;
  root.appendChild(h);
  els = {
    root: h,
    orbWrap: q(h, '.orb'), orbLv: q(h, '.orb-lv'),
    name: q(h, '.hn'), cls: q(h, '.hc'), sub: q(h, '.hero-sub'),
    hpv: q(h, '.hpv'), mpv: q(h, '.mpv'),
    expFill: q(h, '.exp-fill'), expv: q(h, '.expv'),
    gold: q(h, '.gold'), potHp: q(h, '.pot-hp'), potMp: q(h, '.pot-mp'), mats: q(h, '.mats'),
    buffs: q(h, '.buffs'),
    zone: q(h, '.zone'), bossNote: q(h, '.boss-note'),
    bossbar: q(h, '.bossbar'), bbName: q(h, '.bb-name'), bbLv: q(h, '.bb-lv'), bbPhase: q(h, '.bb-phase'), bbX: q(h, '.bb-x'),
    bbUnder: q(h, '.bb-under'), bbFill: q(h, '.bb-fill'), bbHp: q(h, '.bb-hp'), bbShield: q(h, '.bb-shield'), bbShieldFill: q(h, '.bb-shield-fill'),
    hint: q(h, '.hint'), controls: q(h, '.hud-bl'), skillbar: q(h, '.skillbar'), quick: q(h, '.quick'), trial: q(h, '.trial'),
  };
  orb = new Orb(q<HTMLCanvasElement>(h, '.orb-cv'));
  mini = new MiniMap(q<HTMLCanvasElement>(h, '.mini-cv'));
  els.mats.innerHTML = (['gem', 'part', 'essence'] as MaterialId[]).map(m =>
    `<span class="r-item" data-tip="text:${esc(MAT_NAMES[m])}">${ico(m === 'part' ? 'gear' : m, 1, m === 'gem' ? '#b98ae8' : m === 'part' ? '#9a958e' : '#7fd6c4')}<b data-mat="${m}">0</b></span>`).join('');
  els.quick.innerHTML = QUICK.map(b =>
    `<button class="qb" data-panel="${b.panel}" data-tip="text:${esc(`${b.label}（${b.key}）`)}">${ico(b.icon, 1)}<i class="badge" hidden></i></button>`).join('');

  els.quick.addEventListener('click', e => {
    ensureAudio();
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-panel]') : null;
    if (!t) return;
    const name = t.dataset.panel as PanelName;
    sfx('ui');
    if (G.panel === name) ui.closePanel();
    else ui.openPanel(name);
  });
  els.skillbar.addEventListener('pointerdown', e => {
    ensureAudio();
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-sk]') : null;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    if (G.mode !== 'play' || G.panel) return;
    const k = t.dataset.sk as SlotKey;
    if (k === 'atk') {
      G.autoAttack = !G.autoAttack;
      ui.toast(`自动攻击已${G.autoAttack ? '开启' : '关闭'}`, C_GOOD);
      return;
    }
    G.input.pressed.add(k);
  });
  els.skillbar.addEventListener('contextmenu', e => e.preventDefault());
  registerTip('skill', skillTip);
  renderControls(true);
}

/** 强制下次刷新（事件 'hud' / 'skillbar'） */
export function invalidateHud(skillbar = false): void {
  slowT = 0;
  if (skillbar) skillSig = '';
}

export function flashLevelUp(): void {
  if (els) replayClass(els.orbWrap, 'flash');
}

export function setHudVisible(on: boolean): void {
  if (els) show(els.root, on);
}

/** 技能栏结构（职业/奥义/路线/武器变化时重建） */
function buildSkillbar(p: Player): void {
  if (!els) return;
  const sks = playerSkills(p);
  const u = p.ult ? ULTS[p.ult] : null;
  const w = p.equip.weapon;
  let missing = false;
  const iconFor = (k: SlotKey): string => {
    if (k === 'atk') {
      if (w?.sprite) {
        const h = iconHtml(w.sprite, 2, 'sk-item');
        if (h.includes('px-missing')) missing = true;
        else return h;
      }
      return weaponIcon(p.stat.weapon, p.stat.element, 2);
    }
    if (k === 'dash') return ico('dash', 2, '#7fd6c4');
    if (k === 'ult') return u ? skillIcon(u.kind, u.el, 2, true) : ico('lock', 2);
    const sk = sks[k === 'q' ? 0 : k === 'e' ? 1 : 2];
    return sk ? skillIcon(sk.kind, sk.el, 2) : ico('lock', 2);
  };
  const costOf = (k: SlotKey): number => {
    if (k === 'ult') return u ? u.cost : 0;
    if (k === 'q' || k === 'e' || k === 'r') return sks[k === 'q' ? 0 : k === 'e' ? 1 : 2]?.cost ?? 0;
    return 0;
  };
  els.skillbar.innerHTML = SLOT_KEYS.map(k => {
    const cost = costOf(k);
    const locked = k === 'ult' && !u;
    return `<div class="sk${k === 'atk' ? ' sk-atk' : ''}${locked ? ' locked' : ''}" data-sk="${k}" data-tip="skill:${k}">`
      + `<span class="sk-ico">${iconFor(k)}</span><span class="sk-key">${esc(SLOT_LABEL[k])}</span>`
      + (cost ? `<span class="sk-cost">${cost}</span>` : '')
      + (k === 'atk' ? '<span class="sk-auto">AUTO</span>' : '')
      + '<span class="sk-cd"></span><span class="sk-t"></span></div>';
  }).join('');
  const prev = new Map(slots.map(s => [s.key, s]));
  slots = SLOT_KEYS.map(k => {
    const root = q(els!.skillbar, `[data-sk="${k}"]`);
    const old = prev.get(k);
    return { key: k, root, cd: q(root, '.sk-cd'), txt: q(root, '.sk-t'), max: old?.max ?? 0, prev: old?.prev ?? 0, cost: costOf(k) };
  });
  iconRetryT = missing ? 1 : 0;
}

function frameSkillbar(p: Player): void {
  for (const s of slots) {
    const cd = Math.max(0, p.cd[s.key] ?? 0);
    if (cd > s.prev + 0.05 || cd > s.max) s.max = cd; // 新一轮冷却开始：记录本轮总时长
    const frac = cd > 0.02 && s.max > 0 ? clamp(cd / s.max, 0, 1) : 0;
    setVar(s.cd, '--cd', frac.toFixed(3));
    setText(s.txt, cd > 0.05 ? (cd >= 10 ? String(Math.ceil(cd)) : cd.toFixed(1)) : '');
    if (s.key !== 'atk' && s.prev > 0.05 && cd <= 0.05) replayClass(s.root, 'ready');
    s.prev = cd;
    toggleClass(s.root, 'nomp', s.cost > 0 && p.mp < s.cost);
    if (s.key === 'atk') toggleClass(s.root, 'auto', G.autoAttack);
  }
}

/* ---------- 文本类（10Hz） ---------- */
function buffTag(text: string, color: string, icon = ''): string {
  return `<span class="buff" style="border-color:${cssColor(color)};color:${cssColor(color)}">${icon}${esc(text)}</span>`;
}

function buffsHtml(p: Player): string {
  const out: string[] = [];
  const b = p.buffs;
  if (b.shield > 0) out.push(buffTag(`护盾 ${Math.round(b.shield)}${b.shieldT > 0 ? ' ' + Math.ceil(b.shieldT) + 's' : ''}`, '#7fd6c4', ico('shield', 1, '#7fd6c4')));
  if (b.roar > 0) out.push(buffTag(`减伤 ${Math.ceil(b.roar)}s`, '#e8a765'));
  if (b.stealth > 0) out.push(buffTag(`潜行 ${Math.ceil(b.stealth)}s`, '#c9a2f0'));
  if (b.field > 0) out.push(buffTag(`力场 ${Math.ceil(b.field)}s`, '#7fd6c4'));
  if (b.overload > 0) out.push(buffTag(`过载 ${Math.ceil(b.overload)}s`, '#f6d76e', ico('bolt', 1)));
  if (p.invuln > 0.05) out.push(buffTag('无敌', '#fff3dd'));
  for (const [k, s] of Object.entries(p.status)) {
    if (!s || s.t <= 0) continue;
    const def = k === 'stun' ? { n: '眩晕', c: '#f6d76e' } : STATUS[k as StatusId];
    if (!def) continue;
    out.push(buffTag(`${def.n}${s.stacks > 1 ? '×' + s.stacks : ''} ${Math.ceil(s.t)}s`, def.c, statusIcon(k, 1)));
  }
  const rt = ROUTES[p.route];
  if (rt) out.push(buffTag(`${rt.name}路线`, rt.color, routeIcon(p.route, 1)));
  return out.join('');
}

let ctrlSig = '';
function renderControls(force = false): void {
  if (!els) return;
  const sig = `${G.autoAttack}`;
  if (!force && sig === ctrlSig) return;
  ctrlSig = sig;
  setHtml(els.controls,
    `<div>${kc('WASD')}移动 ${kc('左键')}攻击 ${kc('右键')}奥义</div>`
    + `<div>${kc('Q')}${kc('E')}${kc('R')}技能 ${kc('空格')}冲刺 ${kc('1')}${kc('2')}药水</div>`
    + `<div>${kc('F')}交互 ${kc('T')}自动攻击<b class="${G.autoAttack ? 'up' : 'down'}">${G.autoAttack ? '开' : '关'}</b> ${kc('Esc')}暂停</div>`);
}

function updateBossBar(hint: BossHint, frameOnly: boolean): void {
  if (!els) return;
  const b: Enemy | null = G.boss;
  const vis = !!b && !b.dead && bossDiscovered(hint, b);
  show(els.bossbar, vis);
  if (!vis || !b) return;
  const bars = Math.max(1, Math.floor(b.bars || 1));
  const per = b.maxHp / bars;
  const hp = clamp(b.hp, 0, b.maxHp);
  const layer = Math.max(1, Math.min(bars, Math.ceil(hp / per - 1e-9)));
  const within = clamp((hp - (layer - 1) * per) / per, 0, 1);
  setVar(els.bbFill, 'width', `${(within * 100).toFixed(1)}%`);
  if (frameOnly) return;
  const n = BAR_COLORS.length;
  els.bbFill.style.background = BAR_COLORS[(layer - 1) % n];
  els.bbUnder.style.background = layer > 1 ? BAR_COLORS[(layer - 2) % n] : '#2a1610';
  setText(els.bbName, b.def?.n ?? '首领');
  setText(els.bbLv, `Lv.${b.lv}`);
  show(els.bbPhase, b.phase >= 2);
  toggleClass(els.bossbar, 'p2', b.phase >= 2);
  setText(els.bbX, bars > 1 ? `×${layer}` : '');
  setText(els.bbHp, `${Math.ceil(hp)} / ${Math.ceil(b.maxHp)}`);
  if (b.shield > 0) {
    const m = Math.max(b.shield, shieldMax.get(b.id) ?? 0);
    shieldMax.set(b.id, m);
    show(els.bbShield, true);
    els.bbShieldFill.style.width = `${clamp(b.shield / m, 0, 1) * 100}%`;
  } else {
    shieldMax.delete(b.id);
    show(els.bbShield, false);
  }
}

/** 秘境试炼条：名称、进度、倒计时、结果 */
export function trialHtml(t: TrialView): string {
  const st = t.state === 'won' ? '<b class="up">完成</b>' : t.state === 'lost' ? '<b class="down">失败</b>'
    : `<b class="${t.timeLeft <= 15 ? 'down' : 'gold'}">${esc(fmtClock(t.timeLeft))}</b>`;
  const frac = t.goal > 0 ? clamp(t.progress / t.goal, 0, 1) : 0;
  return `<div class="tr-h">${ico('portal', 1, '#f0d070')}<b>${esc(t.name)}</b><span class="dim">${t.progress}/${t.goal}</span>${st}</div>`
    + `<div class="bar"><i style="width:${(frac * 100).toFixed(0)}%;background:#f0d070"></i></div>`
    + `<div class="dim tr-d">${esc(t.desc)}</div>`;
}

function updateTrial(t: TrialView | null): void {
  if (!els) return;
  show(els.trial, !!t);
  if (t) setHtml(els.trial, trialHtml(t));
}

function updateBadges(p: Player): void {
  if (!els) return;
  const fuseReady = !p.fusedFrom && safe(() => fuseOptions(p).some(o => o.ready), false);
  const flags: Partial<Record<PanelName, boolean>> = { char: p.sp > 0, skill: p.tp > 0, fuse: fuseReady };
  for (const b of Array.from(els.quick.querySelectorAll<HTMLElement>('.qb'))) {
    const name = b.dataset.panel as PanelName;
    const dot = b.querySelector<HTMLElement>('.badge');
    if (dot) show(dot, !!flags[name]);
    toggleClass(b, 'on', G.panel === name);
  }
}

function slowUpdate(p: Player, t: number): void {
  if (!els) return;
  const c = clsOf(p.cid);
  setText(els.name, p.name || c.name);
  setHtml(els.cls, `<span style="color:${cssColor(c.color)}">${esc(c.name)}</span>`);
  setText(els.sub, `Lv.${p.lv}/${MAX_LEVEL} · ${c.en}`);
  setText(els.orbLv, `Lv.${p.lv}`);
  setText(els.hpv, `${Math.ceil(Math.max(0, p.hp))}/${Math.round(p.stat.maxHp)}`);
  setText(els.mpv, `${Math.floor(Math.max(0, p.mp))}/${Math.round(p.stat.maxMp)}`);
  const maxed = p.lv >= MAX_LEVEL;
  const ef = maxed ? 1 : clamp(p.exp / Math.max(1, p.expNext), 0, 1);
  els.expFill.style.width = `${(ef * 100).toFixed(1)}%`;
  setText(els.expv, maxed ? 'EXP MAX' : `EXP ${Math.floor(p.exp)}/${p.expNext}`);
  setText(els.gold, fmt(p.gold));
  setText(els.potHp, String(p.potions.hp));
  setText(els.potMp, String(p.potions.mp));
  for (const m of ['gem', 'part', 'essence'] as MaterialId[]) {
    const n = els.mats.querySelector<HTMLElement>(`[data-mat="${m}"]`);
    if (n) setText(n, String(p.mats[m] ?? 0));
  }
  setHtml(els.buffs, buffsHtml(p));
  setText(els.zone, zoneName());

  const hint = mini ? mini.draw(t) : null;
  lastHint = hint;
  if (hint && hint.state === 'unknown') {
    show(els.bossNote, true);
    setHtml(els.bossNote, `${ico('skull', 1)}${esc(BOSS_UNKNOWN_TEXT)}`);
    toggleClass(els.bossNote, 'warn', true);
  } else if (hint && hint.state === 'known') {
    show(els.bossNote, true);
    setHtml(els.bossNote, `${ico('skull', 1)}${esc(hint.text)}`);
    toggleClass(els.bossNote, 'warn', false);
  } else {
    show(els.bossNote, false);
  }
  updateBossBar(hint ?? { state: 'none', visible: false, angle: 0, distTiles: 0, dir: '', text: '' }, false);

  updateTrial(safe(() => getTrial(), null));

  const hintText = G.hint?.text ?? '';
  show(els.hint, !!hintText && !G.panel);
  if (hintText) setText(els.hint, hintText);
  renderControls();
}

/** 每帧：血球与冷却遮罩每帧；文本 10Hz；徽标 2Hz */
export function updateHud(dt: number, t: number): void {
  const p = G.player;
  if (!els || !p) return;
  const sig = `${p.cid}|${p.ult ?? ''}|${p.route}|${p.equip.weapon?.uid ?? ''}|${p.stat.weapon}`;
  if (sig !== skillSig) { skillSig = sig; buildSkillbar(p); }
  else if (iconRetryT > 0) {
    iconRetryT -= dt;
    if (iconRetryT <= 0) buildSkillbar(p);
  }
  orb?.draw(p, t);
  frameSkillbar(p);
  if (lastHint) updateBossBar(lastHint, true);
  slowT -= dt;
  if (slowT <= 0) {
    slowT = 0.1;
    slowUpdate(p, t);
  }
  badgeT -= dt;
  if (badgeT <= 0) {
    badgeT = 0.5;
    updateBadges(p);
  }
}
