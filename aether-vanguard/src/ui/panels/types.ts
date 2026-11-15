// 面板定义接口：每个面板 = 纯函数 body()（返回 HTML，动态文本必须 esc）+ 动作处理。
// 面板宿主（ui/index.ts）负责：G.panel 维护、遮罩/标题栏/页签、事件委托、动作后重绘。

import type { Player } from '../../game/types';

export interface PanelCtx {
  p: Player | null;
  /** openPanel 的附加参数（NPC id、传送阵目标等） */
  arg?: string;
}

export interface PanelDef {
  /** 标题（纯文本，宿主负责转义） */
  title(ctx: PanelCtx): string;
  /** 宽版面板 */
  wide?: boolean;
  /** 显示主面板页签（角色/背包/技能/转职/地图/日志/帮助） */
  tabs?: boolean;
  /** 需要已有角色 */
  needsPlayer?: boolean;
  /** 打开时调用（重置选中项等临时状态） */
  onOpen?(ctx: PanelCtx): void;
  /** 面板正文 HTML */
  body(ctx: PanelCtx): string;
  /** data-act 点击；宿主在调用后重绘面板并刷新 HUD */
  action?(act: string, v: string, ctx: PanelCtx, target: HTMLElement): void;
  /** 渲染进 DOM 之后（画 canvas 等） */
  mounted?(body: HTMLElement, ctx: PanelCtx): void;
  /** 面板打开期间每帧调用（大地图动画） */
  tick?(dt: number, body: HTMLElement, ctx: PanelCtx): void;
  /** input/change 事件（滑块等，不重绘） */
  input?(target: HTMLInputElement, ctx: PanelCtx): void;
}
