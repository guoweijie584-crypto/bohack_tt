// 键盘输入（DOM 级，避免在面板输入框里打字时误触发游戏操作）。
// 移动键实时状态写入 G.input；动作键在按下瞬间写入 G.input.pressed；面板热键交给 onHotkey 回调。

import { G } from '../game/state';

const held = new Set<string>();
type Hotkey = 'char' | 'bag' | 'skill' | 'map' | 'lore' | 'help' | 'fuse' | 'escape' | 'autoAttack' | 'confirm';
let hotkeyHandler: ((k: Hotkey) => void) | null = null;

const ACTIONS: Record<string, 'q' | 'e' | 'r' | 'dash' | 'interact' | 'potionHp' | 'potionMp'> = {
  q: 'q', e: 'e', r: 'r', ' ': 'dash', f: 'interact', '1': 'potionHp', '2': 'potionMp',
};
const HOTKEYS: Record<string, Hotkey> = {
  tab: 'char', c: 'char', b: 'bag', i: 'bag', k: 'skill', m: 'map', j: 'lore', h: 'help', p: 'fuse',
  escape: 'escape', t: 'autoAttack', enter: 'confirm',
};

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export function initKeyboard(onHotkey: (k: Hotkey) => void): void {
  hotkeyHandler = onHotkey;
  window.addEventListener('keydown', e => {
    if (isTyping(e)) {
      if (e.key === 'Escape') hotkeyHandler?.('escape');
      return;
    }
    const k = e.key.toLowerCase();
    // 带 Ctrl/Cmd/Alt 的组合键（复制、刷新、切标签…）交给浏览器，不触发游戏热键/技能，只放行 Esc
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (k === 'escape') hotkeyHandler?.('escape');
      return;
    }
    if (k === 'tab' || k === ' ') e.preventDefault();
    if (e.repeat) return;
    held.add(k);
    const hk = HOTKEYS[k];
    if (hk) { hotkeyHandler?.(hk); return; }
    const act = ACTIONS[k];
    if (act && G.mode === 'play' && !G.panel) G.input.pressed.add(act);
    syncMove();
  });
  window.addEventListener('keyup', e => {
    // macOS 按住 Cmd 时其它键收不到 keyup：Cmd 松开时清空，避免角色一直朝某方向走
    if (e.key === 'Meta') held.clear();
    else held.delete(e.key.toLowerCase());
    syncMove();
  });
  window.addEventListener('blur', () => {
    held.clear();
    G.input.attack = false;
    syncMove();
  });
}

function syncMove(): void {
  let x = 0, y = 0;
  if (held.has('a') || held.has('arrowleft')) x--;
  if (held.has('d') || held.has('arrowright')) x++;
  if (held.has('w') || held.has('arrowup')) y--;
  if (held.has('s') || held.has('arrowdown')) y++;
  const l = Math.hypot(x, y);
  G.input.mx = l ? x / l : 0;
  G.input.my = l ? y / l : 0;
}

/** 虚拟摇杆写入移动方向（触屏） */
export function setStick(x: number, y: number): void {
  const l = Math.hypot(x, y);
  G.input.mx = l > 1 ? x / l : x;
  G.input.my = l > 1 ? y / l : y;
}

export type { Hotkey };
