// 轻量 DOM 工具：只在浏览器里调用；模块顶层不访问 document，保证 node 测试环境可以 import。

/** 当前环境是否有 DOM（vitest node 环境没有） */
export const hasDom = (): boolean => typeof document !== 'undefined' && typeof window !== 'undefined';

/** 创建元素 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html) n.innerHTML = html;
  return n;
}

/** 在 root 内查找（找不到时抛错，便于尽早发现模板与代码不一致） */
export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  const n = root.querySelector<T>(sel);
  if (!n) throw new Error(`UI 元素缺失：${sel}`);
  return n;
}

// 记录上次写入的文本/HTML，避免每帧重复写 DOM（触发样式重算）
const lastText = new WeakMap<Node, string>();
const lastHtml = new WeakMap<Element, string>();

export function setText(n: HTMLElement, text: string): void {
  if (lastText.get(n) === text) return;
  lastText.set(n, text);
  n.textContent = text;
}

/** 写入 HTML（调用方负责对动态文本 esc()） */
export function setHtml(n: HTMLElement, html: string): void {
  if (lastHtml.get(n) === html) return;
  lastHtml.set(n, html);
  n.innerHTML = html;
}

/** 强制下次 setHtml 重新写入（外部直接改了 innerHTML 时） */
export function forgetHtml(n: HTMLElement): void { lastHtml.delete(n); }

export function show(n: HTMLElement, on: boolean): void {
  if (n.hidden === !on) return;
  n.hidden = !on;
}

export function toggleClass(n: HTMLElement, cls: string, on: boolean): void {
  if (n.classList.contains(cls) !== on) n.classList.toggle(cls, on);
}

const lastVar = new WeakMap<HTMLElement, Map<string, string>>();
/** 设置 CSS 变量（值不变时不写） */
export function setVar(n: HTMLElement, name: string, value: string): void {
  let m = lastVar.get(n);
  if (!m) { m = new Map(); lastVar.set(n, m); }
  if (m.get(name) === value) return;
  m.set(name, value);
  n.style.setProperty(name, value);
}

/** 从事件目标向上找带 data-act 的元素（限定在 root 内） */
export function closestAct(target: EventTarget | null, root: HTMLElement, attr = 'data-act'): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const n = target.closest<HTMLElement>(`[${attr}]`);
  return n && root.contains(n) ? n : null;
}

/**
 * “点遮罩关闭”判定：按下、松开、click 目标都必须是遮罩本身。
 * 在面板里按下按钮后拖到遮罩上松开（想取消这次点击）时，浏览器会把 click 派发给两者的共同祖先 = 遮罩，不能因此关面板。
 */
export function isBackdropClick(down: EventTarget | null, up: EventTarget | null, click: EventTarget | null, backdrop: EventTarget | null): boolean {
  return !!backdrop && click === backdrop && down === backdrop && up === backdrop;
}

/** 重新触发一次性 CSS 动画（先移除 class，强制回流后再加回） */
export function replayClass(n: HTMLElement, cls: string): void {
  n.classList.remove(cls);
  void n.offsetWidth;
  n.classList.add(cls);
}
