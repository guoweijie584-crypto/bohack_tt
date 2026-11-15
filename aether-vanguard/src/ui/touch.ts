// 触屏操作（pointer:coarse 时启用）：左下虚拟摇杆（keyboard.setStick）+ 右下攻击/技能按钮（写 G.input）。
// 触屏默认开启自动攻击（ARCHITECTURE 定案）。

import { G } from '../game/state';
import { el, q, show } from './dom';
import { ico } from './icons';
import { setStick } from './keyboard';
import { ensureAudio } from './shared';

const R = 44; // 摇杆半径（CSS px）
let root: HTMLElement | null = null;

export function isCoarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

type Btn = 'attack' | 'q' | 'e' | 'r' | 'ult' | 'dash' | 'interact' | 'potionHp' | 'potionMp';

export function mountTouch(parent: HTMLElement): void {
  if (!isCoarsePointer()) return;
  root = el('div', 'touch',
    '<div class="stick"><div class="stick-knob"></div></div>'
    // Q/E/R/奥义用底部技能栏点按施放（带冷却显示），这里只放攻击、冲刺、交互与药水
    + '<div class="tbtns">'
    + '<button class="tb" data-tb="interact">F</button>'
    + `<button class="tb" data-tb="dash">${ico('dash', 2)}</button>`
    + `<button class="tb" data-tb="potionHp">${ico('potion', 2, '#df5f57')}</button>`
    + `<button class="tb" data-tb="potionMp">${ico('potion', 2, '#5fa9d8')}</button>`
    + `<button class="tb tb-atk" data-tb="attack">${ico('sword', 2)}</button>`
    + '</div>');
  root.hidden = true;
  parent.appendChild(root);

  const stick = q(root, '.stick'), knob = q(root, '.stick-knob');
  let pid = -1, cx = 0, cy = 0;
  const move = (x: number, y: number): void => {
    let dx = x - cx, dy = y - cy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
    knob.style.transform = `translate(${Math.round(dx)}px,${Math.round(dy)}px)`;
    const dead = l < 8;
    setStick(dead ? 0 : dx / R, dead ? 0 : dy / R);
  };
  const end = (): void => {
    pid = -1;
    knob.style.transform = '';
    setStick(0, 0);
  };
  stick.addEventListener('pointerdown', e => {
    ensureAudio();
    e.preventDefault();
    pid = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    const r = stick.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    move(e.clientX, e.clientY);
  });
  stick.addEventListener('pointermove', e => { if (e.pointerId === pid) move(e.clientX, e.clientY); });
  stick.addEventListener('pointerup', e => { if (e.pointerId === pid) end(); });
  stick.addEventListener('pointercancel', e => { if (e.pointerId === pid) end(); });

  const btns = q(root, '.tbtns');
  let atkPid = -1;
  btns.addEventListener('pointerdown', e => {
    ensureAudio();
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tb]') : null;
    if (!t) return;
    e.preventDefault();
    if (G.mode !== 'play' || G.panel) return;
    const k = t.dataset.tb as Btn;
    t.classList.add('down');
    if (k === 'attack') {
      // 捕获指针：手指滑出按钮后抬起也能收到 pointerup，避免攻击键卡住
      atkPid = e.pointerId;
      t.setPointerCapture(e.pointerId);
      G.input.attack = true;
    } else {
      G.input.pressed.add(k);
    }
  });
  const release = (e: PointerEvent): void => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tb]') : null;
    if (t) t.classList.remove('down');
    if (e.pointerId === atkPid) {
      atkPid = -1;
      G.input.attack = false;
      btns.querySelector('.tb-atk')?.classList.remove('down');
    }
  };
  btns.addEventListener('pointerup', release);
  btns.addEventListener('pointercancel', release);
  root.addEventListener('contextmenu', e => e.preventDefault());
}

/** 只在游戏进行且没开面板时显示 */
export function updateTouch(): void {
  if (!root) return;
  const on = G.mode === 'play' && !G.panel && !!G.player;
  if (!on && !root.hidden) { setStick(0, 0); G.input.attack = false; }
  show(root, on);
}
