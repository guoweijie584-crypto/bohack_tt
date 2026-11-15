// UI 内部共享：面板宿主接口（避免 panels ↔ index 循环引用）、安全调用、音效包装、颜色常量。

import type { PanelName, SfxName } from '../game/types';
import { G } from '../game/state';
import { initAudio, playSfx } from '../audio/sfx';

/** 确认弹窗参数 */
export interface ConfirmOpts {
  title: string;
  /** 正文 HTML（调用方负责转义动态文本） */
  html: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  onOk: () => void;
  onCancel?: () => void;
}

/** 由 index.ts 注入的宿主能力（面板、标题、HUD 通过它互相调用） */
export interface UiHost {
  openPanel(name: PanelName, arg?: string): void;
  closePanel(): void;
  /** 重新渲染当前面板（保留滚动位置） */
  rerender(): void;
  toast(text: string, color?: string): void;
  confirm(opts: ConfirmOpts): void;
  /** 返回标题（save=true 先存档） */
  toTitle(save: boolean): void;
  /** 立即刷新 HUD（文本 + 技能栏） */
  refreshHud(): void;
}

const noop = (): void => {};
/** 默认空实现：未初始化时（测试环境）调用不报错 */
export const ui: UiHost = {
  openPanel: noop,
  closePanel: noop,
  rerender: noop,
  toast: noop,
  confirm: noop,
  toTitle: noop,
  refreshHud: noop,
};
export function setHost(impl: UiHost): void { Object.assign(ui, impl); }

export const C_GOOD = '#a3c979';
export const C_BAD = '#df8f7a';
export const C_GOLD = '#f2cd8c';
export const C_INFO = '#e8a765';
export const C_TECH = '#7fd6c4';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 只读查询的安全调用：其他模块未实现/出错时返回兜底值，不让整个面板崩掉 */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[ui] 查询失败：', errMsg(e));
    return fallback;
  }
}

/** 用户操作时初始化/恢复音频（浏览器自动播放策略；initAudio 幂等） */
export function ensureAudio(): void {
  try {
    initAudio();
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[ui] 音频初始化失败：', errMsg(e));
  }
}

/** 播放 UI 音效（失败静默） */
export function sfx(name: SfxName, vol?: number): void {
  try {
    playSfx(name, vol === undefined ? undefined : { vol });
  } catch {
    /* 音频模块未就绪时忽略 */
  }
}

/**
 * 执行一个会改变游戏状态的动作：
 * - 返回 false 视为失败（提示 failMsg + 拒绝音效）；
 * - 抛错时提示错误信息；
 * - 成功时可选提示 okMsg 并播放 okSfx。
 */
export function run(fn: () => boolean | void, okMsg?: string, failMsg?: string, okSfx: SfxName = 'ui'): boolean {
  try {
    const r = fn();
    if (r === false) {
      if (failMsg) ui.toast(failMsg, C_BAD);
      sfx('uiDeny');
      return false;
    }
    if (okMsg) ui.toast(okMsg, C_GOOD);
    sfx(okSfx);
    return true;
  } catch (e) {
    ui.toast('操作失败：' + errMsg(e), C_BAD);
    sfx('uiDeny');
    if (typeof console !== 'undefined') console.error(e);
    return false;
  }
}

/**
 * 调用会自行提示的模拟层动作（items/player/world 的动作函数成功/失败都会 toast + 音效），
 * UI 不再重复提示；只兜住异常。返回是否成功。
 */
export function quiet(fn: () => boolean | void): boolean {
  try {
    return fn() !== false;
  } catch (e) {
    ui.toast('操作失败：' + errMsg(e), C_BAD);
    sfx('uiDeny');
    if (typeof console !== 'undefined') console.error(e);
    return false;
  }
}

/** 执行 fn 期间产生的 toast 事件全部丢弃、重复音效只留一个（批量操作改为一条汇总提示） */
export function muteToasts<T>(fn: () => T): T {
  const n0 = G.events.length;
  try {
    return fn();
  } finally {
    const added = G.events.splice(n0);
    const seenSfx = new Set<string>();
    for (const e of added) {
      if (e.t === 'toast') continue;
      if (e.t === 'sfx') {
        if (seenSfx.has(e.name)) continue;
        seenSfx.add(e.name);
      }
      G.events.push(e);
    }
  }
}

/** 只允许安全的 CSS 颜色写进 style 属性（事件里的颜色来自其他模块，防 CSS 注入） */
export function cssColor(c: unknown, fallback = '#e8a765'): string {
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)$/.test(s)) return s;
  if (/^[a-z]{3,20}$/.test(s)) return s;
  return fallback;
}
