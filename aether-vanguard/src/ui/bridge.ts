// 渲染层 ↔ DOM UI 的美术桥接：
// - 职业/NPC 立绘：Phaser 在 Boot 完成后把换色皮肤画布导出为 dataURL 填进来；
// - 物品/技能图标：返回可直接用于 <span style="..."> 的 CSS（像素放大）。
// UI 代码只依赖这里的函数，不直接碰 Phaser。

import { assetCssUrl } from '../core/assetUrl';

const skinUrls = new Map<string, string>();
const iconUrls = new Map<string, string>();
let sheetUrl = assetCssUrl('assets/0x72/0x72_DungeonTilesetII_v1.7.png');
const sheetFrames = new Map<string, { x: number; y: number; w: number; h: number }>();

/** 渲染层调用：登记 0x72 图集帧坐标 */
export function registerSheet(url: string, frames: Iterable<[string, { x: number; y: number; w: number; h: number }]>): void {
  sheetUrl = url;
  for (const [k, v] of frames) sheetFrames.set(k, v);
}
/** 渲染层调用：登记一张独立图标（程序化生成的 dataURL） */
export function registerIcon(key: string, dataUrl: string): void { iconUrls.set(key, dataUrl); }
/** 渲染层调用：登记角色立绘（idle 第 0 帧，dataURL） */
export function registerSkin(id: string, dataUrl: string): void { skinUrls.set(id, dataUrl); }

/** 角色立绘 URL（职业 id、NPC 皮肤 id）；未登记时返回空串 */
export function skinUrl(id: string): string { return skinUrls.get(id) ?? ''; }

/**
 * 图标 HTML：返回一个按 scale 倍像素放大的 <span>。
 * key 可以是 0x72 帧名（weapon_knight_sword、flask_big_red…）或 registerIcon 登记的 key（armor_2、mat_gem…）。
 */
export function iconHtml(key: string, scale = 2, extraClass = ''): string {
  const url = iconUrls.get(key);
  if (url) {
    return `<span class="px-icon ${extraClass}" style="width:${16 * scale}px;height:${16 * scale}px;background-image:url(${url});background-size:100% 100%"></span>`;
  }
  const f = sheetFrames.get(key);
  if (!f) return `<span class="px-icon px-missing ${extraClass}" style="width:${16 * scale}px;height:${16 * scale}px"></span>`;
  // 帧原尺寸按比例放大，居中放进 16×16 的格子
  const box = Math.max(16, f.w, f.h);
  const s = (16 * scale) / box;
  return `<span class="px-icon ${extraClass}" style="width:${16 * scale}px;height:${16 * scale}px;display:inline-flex;align-items:center;justify-content:center">`
    + `<span style="width:${f.w * s}px;height:${f.h * s}px;background:url(${sheetUrl}) -${f.x * s}px -${f.y * s}px / ${512 * s}px ${512 * s}px no-repeat;image-rendering:pixelated"></span></span>`;
}
