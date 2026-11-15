// DOM UI 层入口（标题/角色槽、HUD、面板、商店、铁匠、仓库、死亡页、提示条）。
// 【契约】签名不可改；实现由 ui 代理完成。GameScene 只通过这些函数驱动 UI。
//
// 约定：
// - 打开面板 = 设置 G.panel（单机暂停），关闭置 null；Esc 关闭，点遮罩关闭；
// - 未调用 initUI（例如测试环境没有 DOM）时，所有函数只维护状态、不碰 DOM；
// - initUI 不注册键盘：由 GameScene 调用 keyboard.initKeyboard(onHotkey)，避免重复监听。

import './style.css';

import { esc } from '../core/util';
import { assetUrl } from '../core/assetUrl';
import { saveGame } from '../game/save';
import { clearWorld, G } from '../game/state';
import type { FxEvent, PanelName } from '../game/types';
import { deadShown, doRevive, hideDead, mountDead, showDead } from './dead';
import { closestAct, el, hasDom, isBackdropClick, q } from './dom';
import {
  closeConfirm, confirmOpen, hideNotice, hideTip, mountFeedback, openConfirm, pushToast, refreshTip, showBanner, showNotice,
} from './feedback';
import { flashLevelUp, invalidateHud, mountHud, setHudVisible, updateHud } from './hud';
import { ico } from './icons';
import type { Hotkey } from './keyboard';
import { resetBossMemory } from './minimap';
import { registerItemTips } from './panels/common';
import { isPanelName, MAIN_TABS, NO_PLAYER_PANELS, PANELS } from './panels/index';
import type { PanelCtx } from './panels/types';
import { C_BAD, C_GOOD, ensureAudio, errMsg, safe, setHost, sfx } from './shared';
import { hideTitle, mountTitle, showTitle as showTitleScreen, tickTitle, titleBack, titleVisible } from './title';
import { isCoarsePointer, mountTouch, updateTouch } from './touch';

/** 像素字体（相对 document 的 URL，兼容 vite base:'./'） */
const FONT_URL = 'assets/fonts/fusion-pixel-12px-proportional-zh_hans.woff2';

let mounted = false;
let overlay: HTMLElement | null = null;
let panelBox: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
/** 当前 DOM 中显示的面板（与 G.panel 不一致时在 updateUI 里同步） */
let shownPanel: PanelName | null = null;
let panelArg: string | undefined;
let uiTime = 0;
/** 遮罩上最近一次按下/松开的目标（判断“点遮罩关闭”） */
let backdropDown: EventTarget | null = null;
let backdropUp: EventTarget | null = null;

const ctx = (): PanelCtx => ({ p: G.player, arg: panelArg });

/* ------------------------------------------------------------------ */
/* 面板宿主                                                             */
/* ------------------------------------------------------------------ */
function tabsHtml(cur: PanelName): string {
  return MAIN_TABS.filter(t => G.player || NO_PLAYER_PANELS.has(t.name))
    .map(t => `<button class="ptab${t.name === cur ? ' on' : ''}" data-act="ptab" data-v="${t.name}">${ico(t.icon, 1)}${esc(t.label)}<span class="kc-s">${t.key}</span></button>`)
    .join('');
}

function renderPanel(keepScroll = true): void {
  if (!overlay || !bodyEl || !titleEl || !tabsEl || !panelBox || !G.panel || !isPanelName(G.panel)) return;
  const name = G.panel;
  const def = PANELS[name];
  const c = ctx();
  const scroll = keepScroll ? bodyEl.scrollTop : 0;
  let html: string;
  try {
    html = def.body(c);
  } catch (e) {
    html = `<div class="soft down">面板渲染出错：${esc(errMsg(e))}</div>`;
    if (typeof console !== 'undefined') console.error(e);
  }
  titleEl.textContent = safe(() => def.title(c), name);
  tabsEl.innerHTML = def.tabs ? tabsHtml(name) : '';
  tabsEl.hidden = !def.tabs;
  panelBox.classList.toggle('wide', !!def.wide);
  panelBox.dataset.panel = name;
  bodyEl.innerHTML = html;
  bodyEl.scrollTop = scroll;
  try {
    def.mounted?.(bodyEl, c);
  } catch (e) {
    if (typeof console !== 'undefined') console.error(e);
  }
  refreshTip();
}

function uiToast(text: string, color?: string): void {
  pushToast(text, color);
}

/** 当前状态下能否打开该面板（无角色只允许日志/帮助；死亡页期间同理） */
function canOpen(name: PanelName): boolean {
  if (PANELS[name].needsPlayer && !G.player) return false;
  return !(G.mode === 'dead' && !NO_PLAYER_PANELS.has(name));
}

export function openPanel(name: PanelName, arg?: string): void {
  if (!isPanelName(name)) return;
  const def = PANELS[name];
  if (!canOpen(name)) {
    if (def.needsPlayer && !G.player) uiToast('请先选择或创建角色', C_BAD);
    return;
  }
  const switching = shownPanel !== name || panelArg !== arg || G.panel !== name;
  G.panel = name;
  panelArg = arg;
  shownPanel = name;
  // 打开面板即暂停：清掉按住的攻击与未消费的动作，避免关面板后误触发
  G.input.attack = false;
  G.input.pressed.clear();
  if (switching) {
    try {
      def.onOpen?.(ctx());
    } catch (e) {
      if (typeof console !== 'undefined') console.error(e);
    }
  }
  hideTip();
  if (overlay) {
    overlay.hidden = false;
    renderPanel(!switching);
  }
}

/**
 * 把当前角色写盘（标题界面/无角色时不写）。
 * 面板里的买卖、强化、仓库、加点、融合、换路线都只改内存（items/player 的动作函数不存档），
 * 而面板打开时模拟暂停、20 秒自动存档也停走：关面板与页面隐藏/关闭时补存，避免刷新页面后回档。
 */
function persist(): void {
  if (!G.player || (G.mode !== 'play' && G.mode !== 'dead')) return;
  safe(() => saveGame(), undefined);
}

export function closePanel(): void {
  const wasOpen = G.panel !== null || shownPanel !== null;
  G.panel = null;
  panelArg = undefined;
  shownPanel = null;
  if (confirmOpen()) closeConfirm(false);
  hideTip();
  if (overlay) overlay.hidden = true;
  if (bodyEl) bodyEl.innerHTML = '';
  if (wasOpen) persist();
}

export function togglePanel(name: PanelName): void {
  if (G.panel === name) closePanel();
  else openPanel(name);
}

function onOverlayClick(e: MouseEvent): void {
  if (!overlay) return;
  ensureAudio();
  if (e.target === overlay) {
    // 点遮罩关闭：按下与松开都要在遮罩上（在面板里按下、拖到遮罩上松开时 click 会派发给共同祖先=遮罩）
    if (isBackdropClick(backdropDown, backdropUp, e.target, overlay)) closePanel();
    return;
  }
  const t = closestAct(e.target, overlay);
  if (!t) return;
  if (t instanceof HTMLButtonElement && t.disabled) return;
  const act = t.dataset.act ?? '';
  const v = t.dataset.v ?? '';
  if (act === 'close') { sfx('ui'); closePanel(); return; }
  if (act === 'ptab') {
    sfx('ui');
    if (isPanelName(v)) openPanel(v);
    return;
  }
  const name = G.panel;
  if (!name || !isPanelName(name)) return;
  const def = PANELS[name];
  try {
    def.action?.(act, v, ctx(), t);
  } catch (err) {
    uiToast('操作出错：' + errMsg(err), C_BAD);
    if (typeof console !== 'undefined') console.error(err);
  }
  if (G.panel === name && shownPanel === name) renderPanel();
  invalidateHud(true);
}

function onOverlayInput(e: Event): void {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !G.panel || !isPanelName(G.panel)) return;
  try {
    PANELS[G.panel].input?.(t, ctx());
  } catch (err) {
    if (typeof console !== 'undefined') console.error(err);
  }
}

/** 返回标题（帮助面板“保存并返回”“删除存档”用） */
export function toTitle(save: boolean): void {
  if (save) safe(() => saveGame(), undefined);
  // 先离开游戏态再关面板：closePanel 会补存档，“删除存档并返回标题”时不能把刚删掉的存档写回去
  G.mode = 'title';
  G.player = null;
  closePanel();
  hideDead();
  hideNotice();
  G.paused = false;
  // 商店货架按当前角色的等级/武器类型生成，换角色后不能沿用上一个角色的货架
  G.shops = {};
  clearWorld();
  G.map = null;
  G.input.attack = false;
  G.input.pressed.clear();
  G.input.mx = 0;
  G.input.my = 0;
  resetBossMemory();
  setHudVisible(false);
  showTitle();
}

/* ------------------------------------------------------------------ */
/* 契约函数                                                             */
/* ------------------------------------------------------------------ */

/** 构建 DOM 根节点、注入样式与字体，显示标题界面 */
export function initUI(): void {
  if (mounted || !hasDom()) return;
  mounted = true;
  injectFont();
  const host = document.getElementById('ui-root') ?? document.body;
  const root = el('div');
  root.id = 'av-ui';
  host.appendChild(root);

  mountTitle(root);
  mountHud(root);
  overlay = el('div', 'overlay',
    `<div class="panel pxb"><div class="p-head"><b class="p-title"></b><span class="p-tip dim">Esc / 点击空白处关闭</span>`
    + `<button class="p-x" data-act="close" data-tip="text:关闭（Esc）">${ico('close', 1)}</button></div>`
    + '<div class="p-tabs"></div><div class="p-body"></div></div>');
  overlay.hidden = true;
  root.appendChild(overlay);
  panelBox = q(overlay, '.panel');
  titleEl = q(overlay, '.p-title');
  tabsEl = q(overlay, '.p-tabs');
  bodyEl = q(overlay, '.p-body');
  overlay.addEventListener('pointerdown', e => { backdropDown = e.target; });
  overlay.addEventListener('pointerup', e => { backdropUp = e.target; });
  overlay.addEventListener('click', onOverlayClick);
  overlay.addEventListener('input', onOverlayInput);
  // 关闭/刷新页面、切到后台（手机切应用后可能被系统直接杀掉）时补存档
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });
  mountDead(root);
  mountTouch(root);
  mountFeedback(root);
  registerItemTips();
  root.addEventListener('contextmenu', e => {
    if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
  });

  setHost({
    openPanel,
    closePanel,
    rerender: () => renderPanel(),
    toast: uiToast,
    confirm: openConfirm,
    toTitle,
    refreshHud: () => invalidateHud(true),
  });

  // 触屏默认开启自动攻击（ARCHITECTURE 定案）
  if (isCoarsePointer()) G.autoAttack = true;
  if (G.mode === 'title') showTitle();
}

function injectFont(): void {
  if (document.getElementById('av-font')) return;
  const st = document.createElement('style');
  st.id = 'av-font';
  st.textContent = `@font-face{font-family:'FusionPixel';src:url('${assetUrl(FONT_URL)}') format('woff2');font-display:swap;}`;
  document.head.appendChild(st);
  try {
    void document.fonts?.load('12px FusionPixel');
  } catch {
    /* 老浏览器没有 FontFaceSet */
  }
}

export function showTitle(): void {
  if (!mounted) return;
  setHudVisible(false);
  hideDead();
  showTitleScreen();
}

/** 键盘热键（来自 ui/keyboard.ts） */
export function onHotkey(k: Hotkey): void {
  if (k === 'escape') {
    if (confirmOpen()) { closeConfirm(false); return; }
    if (G.panel) { closePanel(); return; }
    if (titleBack()) return;
    if (G.mode === 'play' && G.player) openPanel('help');
    return;
  }
  if (k === 'confirm') {
    if (confirmOpen()) { closeConfirm(true); return; }
    if (G.mode === 'dead') doRevive();
    return;
  }
  if (k === 'autoAttack') {
    if (!G.player || G.mode === 'title') return;
    G.autoAttack = !G.autoAttack;
    uiToast(`自动攻击已${G.autoAttack ? '开启' : '关闭'}`, C_GOOD);
    invalidateHud();
    if (G.panel === 'help') renderPanel();
    return;
  }
  // 面板热键：char/bag/skill/map/lore/help/fuse
  if (confirmOpen() || G.mode === 'dead') return;
  if (!G.player && !NO_PLAYER_PANELS.has(k)) return;
  togglePanel(k);
}

/** 每帧调用：刷新 HUD（内部自行节流），dt 为秒 */
export function updateUI(dt: number): void {
  const d = Number.isFinite(dt) ? Math.max(0, Math.min(0.25, dt)) : 0;
  uiTime += d;
  if (!mounted) return;
  const playing = (G.mode === 'play' || G.mode === 'dead') && !!G.player;
  setHudVisible(playing);
  if (G.mode === 'title') {
    if (!titleVisible()) showTitle();
  } else if (titleVisible()) {
    hideTitle();
  }
  if (playing) updateHud(d, uiTime);
  if (G.mode === 'dead' && !deadShown()) showDead();
  else if (G.mode !== 'dead' && deadShown()) hideDead();
  // 其他代码直接改了 G.panel 时同步面板显示
  if (G.panel !== shownPanel) {
    const want = G.panel;
    if (want && isPanelName(want) && canOpen(want)) openPanel(want, panelArg);
    else closePanel();
  }
  if (G.panel && bodyEl && isPanelName(G.panel)) {
    try {
      PANELS[G.panel].tick?.(d, bodyEl, ctx());
    } catch (e) {
      if (typeof console !== 'undefined') console.error(e);
    }
  }
  tickTitle(d);
  updateTouch();
}

/** 每帧调用：处理与 UI 相关的事件（toast/banner/ui/openPanel/levelup 等）；不要清空数组 */
export function handleUiEvents(events: readonly FxEvent[]): void {
  for (const e of events) {
    switch (e.t) {
      case 'toast': uiToast(e.text, e.color); break;
      case 'banner': showBanner(e.text, e.sub, e.color); break;
      case 'openPanel': openPanel(e.panel, e.arg); break;
      case 'levelup':
        flashLevelUp();
        invalidateHud();
        if (G.panel) renderPanel();
        break;
      case 'ui':
        switch (e.what) {
          case 'hud': case 'minimap': invalidateHud(); break;
          case 'skillbar': invalidateHud(true); break;
          case 'dead':
            if (G.panel) closePanel();
            showDead();
            break;
          case 'fuseReady':
            // player.gainExp 已发 toast，这里只弹非阻塞通知卡（改版意见 #9：加上弹窗）
            showNotice(`${ico('merge', 2)}<div><b class="gold">融合转职已就绪</b><div>当前职业已达到 Lv.10，可前往主城转职殿融合（只能一次）。按 P 查看条件。</div></div>`,
              '查看', () => openPanel('fuse'));
            break;
          case 'map':
            resetBossMemory();
            invalidateHud();
            if (G.panel === 'map') renderPanel();
            break;
          case 'panel':
            if (G.panel) renderPanel();
            break;
        }
        break;
      default:
        break;
    }
  }
}
