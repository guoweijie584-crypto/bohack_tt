// 反馈类 UI：提示条（toast）、屏幕中央横幅、确认弹窗、悬停提示框、非阻塞通知卡。
// 所有动态文本 esc()；颜色经 cssColor() 过滤后才写进 style。

import { esc } from '../core/util';
import { closestAct, el, q, replayClass } from './dom';
import { cssColor, type ConfirmOpts, ensureAudio, sfx } from './shared';

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */
const TOAST_MAX = 6;
const TOAST_LIFE = 3400;

/** 单条 toast 的 HTML（纯函数，测试用） */
export function toastHtml(text: string, color?: string, count = 1): string {
  const c = cssColor(color, '#e8a765');
  return `<i class="t-bar" style="background:${c}"></i><span class="t-txt">${esc(text)}</span>`
    + (count > 1 ? `<b class="t-n">×${count}</b>` : '');
}

let toastBox: HTMLElement | null = null;
let lastToast: { node: HTMLElement; text: string; color: string; n: number; at: number; timers: number[] } | null = null;

function scheduleToast(node: HTMLElement): number[] {
  return [
    window.setTimeout(() => node.classList.add('out'), TOAST_LIFE - 400),
    window.setTimeout(() => node.remove(), TOAST_LIFE),
  ];
}

export function pushToast(text: string, color?: string): void {
  if (!toastBox) return;
  const c = cssColor(color, '#e8a765');
  const now = performance.now();
  // 连续相同提示合并为 ×N（例如反复踩到背包满时的拾取提示）
  if (lastToast && lastToast.text === text && lastToast.color === c && now - lastToast.at < 1500 && lastToast.node.isConnected) {
    lastToast.n++;
    lastToast.at = now;
    lastToast.node.innerHTML = toastHtml(text, c, lastToast.n);
    lastToast.node.classList.remove('out');
    lastToast.timers.forEach(t => window.clearTimeout(t));
    lastToast.timers = scheduleToast(lastToast.node);
    return;
  }
  const node = el('div', 'toast pxb', toastHtml(text, c));
  toastBox.appendChild(node);
  while (toastBox.children.length > TOAST_MAX) toastBox.firstElementChild?.remove();
  lastToast = { node, text, color: c, n: 1, at: now, timers: scheduleToast(node) };
}

/* ------------------------------------------------------------------ */
/* 横幅                                                                 */
/* ------------------------------------------------------------------ */
let bannerEl: HTMLElement | null = null;
let bannerTimer = 0;
export function bannerHtml(text: string, sub?: string, color?: string): string {
  const c = cssColor(color, '#ffe9c9');
  return `<div class="bn-t" style="color:${c}">${esc(text)}</div>` + (sub ? `<div class="bn-s">${esc(sub)}</div>` : '');
}
export function showBanner(text: string, sub?: string, color?: string): void {
  if (!bannerEl) return;
  bannerEl.innerHTML = bannerHtml(text, sub, color);
  bannerEl.hidden = false;
  replayClass(bannerEl, 'on');
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => { if (bannerEl) { bannerEl.classList.remove('on'); bannerEl.hidden = true; } }, 2900);
}

/* ------------------------------------------------------------------ */
/* 确认弹窗                                                             */
/* ------------------------------------------------------------------ */
let modalEl: HTMLElement | null = null;
let pending: ConfirmOpts | null = null;

export function confirmOpen(): boolean { return pending !== null; }

export function openConfirm(o: ConfirmOpts): void {
  // 没有挂载 DOM 时不能让玩家确认：按取消处理（绝不默认执行删除等危险操作）
  if (!modalEl) { o.onCancel?.(); return; }
  pending = o;
  q(modalEl, '.m-title').textContent = o.title;
  q(modalEl, '.m-body').innerHTML = o.html;
  const ok = q<HTMLButtonElement>(modalEl, '[data-m="ok"]');
  ok.textContent = o.okText ?? '确认';
  ok.classList.toggle('danger', !!o.danger);
  ok.classList.toggle('primary', !o.danger);
  q(modalEl, '[data-m="cancel"]').textContent = o.cancelText ?? '取消';
  modalEl.hidden = false;
  ok.focus({ preventScroll: true });
}

/** 关闭弹窗；ok=true 执行确认回调 */
export function closeConfirm(ok: boolean): void {
  const o = pending;
  pending = null;
  if (modalEl) modalEl.hidden = true;
  if (!o) return;
  if (ok) o.onOk();
  else o.onCancel?.();
}

/* ------------------------------------------------------------------ */
/* 悬停提示框：data-tip="kind:id"，内容由 provider 按需生成（不把 HTML 塞进属性） */
/* ------------------------------------------------------------------ */
type TipProvider = (id: string) => string | null;
const providers = new Map<string, TipProvider>();
let tipEl: HTMLElement | null = null;
let tipFor: HTMLElement | null = null;

export function registerTip(kind: string, fn: TipProvider): void { providers.set(kind, fn); }

export function hideTip(): void {
  tipFor = null;
  if (tipEl) tipEl.hidden = true;
}

function tipContent(spec: string): string | null {
  const i = spec.indexOf(':');
  const kind = i < 0 ? spec : spec.slice(0, i), id = i < 0 ? '' : spec.slice(i + 1);
  if (kind === 'text') return esc(id);
  const fn = providers.get(kind);
  if (!fn) return null;
  try {
    return fn(id);
  } catch {
    return null;
  }
}

function showTipFor(t: HTMLElement): void {
  if (!tipEl) return;
  const html = tipContent(t.dataset.tip ?? '');
  if (!html) { hideTip(); return; }
  tipFor = t;
  tipEl.innerHTML = html;
  tipEl.hidden = false;
  const r = t.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = Math.round(r.left + r.width / 2 - tw / 2);
  let y = Math.round(r.top - th - 8);
  if (y < 6) y = Math.round(r.bottom + 8);
  if (y + th > vh - 6) y = Math.max(6, vh - th - 6);
  x = Math.max(6, Math.min(vw - tw - 6, x));
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
}

/** 当前悬停对象内容变化时刷新（例如面板重绘后） */
export function refreshTip(): void {
  if (tipFor && tipFor.isConnected) showTipFor(tipFor);
  else hideTip();
}

/* ------------------------------------------------------------------ */
/* 非阻塞通知卡（融合就绪等）                                              */
/* ------------------------------------------------------------------ */
let noticeEl: HTMLElement | null = null;
let noticeAct: (() => void) | null = null;
let noticeTimer = 0;
export function showNotice(html: string, viewText: string, onView: () => void, ms = 15000): void {
  if (!noticeEl) return;
  noticeAct = onView;
  q(noticeEl, '.n-body').innerHTML = html;
  q(noticeEl, '[data-n="view"]').textContent = viewText;
  noticeEl.hidden = false;
  replayClass(noticeEl, 'on');
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { if (noticeEl) noticeEl.hidden = true; }, ms);
}
export function hideNotice(): void {
  if (noticeEl) noticeEl.hidden = true;
}

/* ------------------------------------------------------------------ */
/* 挂载                                                                 */
/* ------------------------------------------------------------------ */
export function mountFeedback(root: HTMLElement): void {
  toastBox = el('div', 'toasts');
  bannerEl = el('div', 'banner');
  bannerEl.hidden = true;
  modalEl = el('div', 'modal',
    '<div class="m-box pxb"><div class="m-title"></div><div class="m-body"></div>'
    + '<div class="m-btns"><button class="btn" data-m="cancel">取消</button><button class="btn primary" data-m="ok">确认</button></div></div>');
  modalEl.hidden = true;
  tipEl = el('div', 'tip pxb');
  tipEl.hidden = true;
  noticeEl = el('div', 'notice pxb',
    '<div class="n-body"></div><div class="n-btns"><button class="btn" data-n="close">关闭</button><button class="btn primary" data-n="view">查看</button></div>');
  noticeEl.hidden = true;
  root.append(toastBox, bannerEl, noticeEl, modalEl, tipEl);

  modalEl.addEventListener('click', e => {
    ensureAudio();
    const b = closestAct(e.target, modalEl!, 'data-m');
    if (b) { sfx('ui'); closeConfirm(b.dataset.m === 'ok'); return; }
    if (e.target === modalEl) closeConfirm(false);
  });
  noticeEl.addEventListener('click', e => {
    const b = closestAct(e.target, noticeEl!, 'data-n');
    if (!b) return;
    sfx('ui');
    hideNotice();
    if (b.dataset.n === 'view') noticeAct?.();
  });
  root.addEventListener('mouseover', e => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tip]') : null;
    if (!t) { if (tipFor) hideTip(); return; }
    if (t !== tipFor) showTipFor(t);
  });
  root.addEventListener('mouseout', e => {
    if (!tipFor) return;
    const to = e.relatedTarget;
    if (to instanceof Node && tipFor.contains(to)) return;
    hideTip();
  });
}
